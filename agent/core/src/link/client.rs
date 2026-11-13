//! A node's side of the link, as far as every node shares it: opening a
//! connection (`open`: the dial, both keys proved, `hello` and its answer),
//! how an attempt ends (`Ended`), a rotation's check (`take_rotate`) — and
//! the whole conversation of a LIGHT node (`Light`).
//!
//! An agent's conversation is its own (agent/src/node/link.rs): it follows
//! a policy, takes commands and pushes five documents. A light node — the
//! iOS app, `wire::NodeKind::Light` — does none of that:
//!
//! - it is told where the controller is and which key to trust (the app's
//!   pairing), and looks for neither;
//! - PENDING, it sends heartbeats and waits; APPROVED, it pushes `status`
//!   once per connection — what its hello said of it, in the status
//!   document's names (`os_version` above all, which the app reads there)
//!   and nothing a device does not have — and `telemetry` whenever the host
//!   hands it a new one (`Light::report`) and again every `PUSH_EVERY`;
//!   REVOKED, it leaves and tries again at the slowest step;
//! - it may `leave` (`Light::leave`): the device unpairs and asks to be
//!   forgotten, as a Mac that logs out does;
//! - it answers one request, `rotate` — the trusted key handing over to a
//!   new one, re-pinned in memory and shown in `LightStatus::pin` for the
//!   host to keep — and refuses every other as `unsupported`; a `policy`
//!   event is ignored.
//!
//! It is on the link only while its app runs, so the controller treats its
//! absence as ordinary (agent/src/controller/link/).

use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use super::tls::{self, Recv, Tls};
use super::wire::{
    self, name, Accepted, ControllerId, Hello, Incoming, NodeState, RotateParams, StateEvent,
    Welcome,
};
use super::{LinkState, BACKOFF_MAX, BACKOFF_MIN, DEAD_AFTER, HANDSHAKE_TIMEOUT, HEARTBEAT};
use crate::identity::{digest, format_fingerprint, Identity};
use crate::ipc::rpc::{ApiError, ErrorCode, Request, Response};
use crate::ipc::MAX_LINE;
use crate::net::Dialer;
use crate::util::{LockExt, Shutdown};

/// The id of `leave`, the one request a light node sends after `hello` (1).
const LEAVE_ID: u64 = 2;

/// The slowest a push waits when nothing changed.
pub const PUSH_EVERY: Duration = Duration::from_secs(60);

/// How one attempt ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// Asked to stop.
    Stopped,
    /// The connection was up and approved or pending, then ended.
    Dropped(String),
    /// The controller could not be reached or refused this machine.
    Failed(String),
    /// The controller presented another key than the trusted one.
    /// `presented_unproven` is what its certificate carried, before any
    /// signature proved the peer holds it: shown, never trusted.
    KeyChanged {
        presented_unproven: [u8; 32],
        pinned: [u8; 32],
    },
    /// The box turned this machine away.
    Revoked,
    /// The controller speaks another protocol.
    Version(String),
    /// The controller handed its trust to a new key, and this machine
    /// re-pinned from `from` to `new` (the keys's digests): connect again
    /// under it.
    Rotated { from: [u8; 32], new: [u8; 32] },
}

/// A connection the controller answered `hello` on.
pub struct Opened {
    pub tls: Tls,
    pub welcome: Welcome,
    /// The key the handshake proved: the pinned one.
    pub controller_key: [u8; 32],
}

/// Connect to `address` through `dialer`, accept the controller only by
/// `pin` (the SHA-256 of its key), say `hello` and read its answer — each
/// step within `HANDSHAKE_TIMEOUT`.
pub fn open(
    dialer: &Dialer,
    client: &tls::Client,
    address: &str,
    pin: [u8; 32],
    hello: &Hello,
) -> Result<Opened, Ended> {
    let sock = dialer
        .connect(address, HANDSHAKE_TIMEOUT)
        .map_err(Ended::Failed)?;
    let mut tls = match client.connect(sock, pin, HANDSHAKE_TIMEOUT) {
        Ok(t) => t,
        Err(tls::ConnectError::KeyMismatch {
            presented_unproven,
            pinned,
        }) => {
            return Err(Ended::KeyChanged {
                presented_unproven,
                pinned,
            })
        }
        Err(tls::ConnectError::Io(e)) => return Err(Ended::Failed(format!("TLS: {e}"))),
    };
    let Some(controller_key) = tls.peer_key() else {
        return Err(Ended::Failed("the controller presented no key".into()));
    };
    if let Err(e) = tls.send(&wire::request(1, name::HELLO, hello)) {
        return Err(Ended::Failed(format!("hello: {e}")));
    }
    let until = Instant::now() + HANDSHAKE_TIMEOUT;
    let welcome: Welcome = loop {
        match tls.recv() {
            Ok(Recv::Line(l)) => match Incoming::parse(&l) {
                Ok(Incoming::Answer {
                    id: Some(1),
                    result: Ok(v),
                }) => match serde_json::from_value(v) {
                    Ok(w) => break w,
                    Err(e) => return Err(Ended::Failed(format!("the controller's answer: {e}"))),
                },
                Ok(Incoming::Answer { result: Err(e), .. }) => {
                    tls.close();
                    return Err(match e.code {
                        ErrorCode::Version => Ended::Version(e.msg),
                        ErrorCode::Revoked => Ended::Revoked,
                        _ => Ended::Failed(format!("refused: {}", e.msg)),
                    });
                }
                _ => continue,
            },
            Ok(Recv::Idle) if Instant::now() < until => continue,
            Ok(Recv::Idle) => return Err(Ended::Failed("no answer to hello".into())),
            Ok(Recv::Closed) => return Err(Ended::Failed("closed before answering hello".into())),
            Err(e) => return Err(Ended::Failed(format!("hello: {e}"))),
        }
    };
    Ok(Opened {
        tls,
        welcome,
        controller_key,
    })
}

/// Check a rotation statement against `pinned`, the key this connection's
/// handshake proved: the new key, when `pinned` signed it.
pub fn take_rotate(pinned: &[u8; 32], p: Value) -> Result<[u8; 32], ApiError> {
    let params: RotateParams = serde_json::from_value(p)
        .map_err(|e| ApiError::new(ErrorCode::BadRequest, format!("rotate: {e}")))?;
    let new = crate::identity::parse_public_key(&params.new_public_key)
        .map_err(|e| ApiError::new(ErrorCode::BadRequest, format!("rotate: {e}")))?;
    let sig = hex::decode(&params.signature)
        .map_err(|_| ApiError::new(ErrorCode::BadRequest, "rotate: the signature is not hex"))?;
    if !crate::identity::verify_rotation(pinned, &new, &sig) {
        return Err(ApiError::new(
            ErrorCode::Forbidden,
            "rotate: the statement is not the trusted controller key's; nothing re-pinned",
        ));
    }
    Ok(new)
}

/// How often a light node's connection does what it does; `Default` is the
/// link's constants, the tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Cadence {
    pub heartbeat: Duration,
    pub dead_after: Duration,
    pub push_every: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl Default for Cadence {
    fn default() -> Self {
        Self {
            heartbeat: HEARTBEAT,
            dead_after: DEAD_AFTER,
            push_every: PUSH_EVERY,
            backoff_min: BACKOFF_MIN,
            backoff_max: BACKOFF_MAX,
        }
    }
}

/// A light node's link as its host shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LightStatus {
    /// `connecting`, `pending`, `approved`, `revoked`, `refused` (the
    /// controller speaks another protocol) or `key-changed` (it proved
    /// another key than the pin).
    pub state: Option<LinkState>,
    /// Whether a connection is open now.
    pub connected: bool,
    /// The controller, from its last welcome.
    pub controller: Option<ControllerId>,
    /// The fingerprint of the controller key trusted now: the one the host
    /// gave, until a signed rotation moves it — the host keeps what it
    /// reads here.
    pub pin: String,
    /// What went wrong last.
    pub error: Option<String>,
}

struct State {
    status: LightStatus,
    pin: [u8; 32],
    /// The document to push, and its generation: bumped by every `report`.
    telemetry: Option<(Arc<str>, u64)>,
    /// A `leave` asked for and not yet sent, with where its answer goes.
    leave: Option<mpsc::SyncSender<Result<(), String>>>,
    /// The controller heard a `leave`: nothing is dialled again.
    left: bool,
}

/// A light node's link (module doc): made once, run on a thread of the
/// host's, fed and read from any other.
pub struct Light {
    client: tls::Client,
    dialer: Dialer,
    address: String,
    hello: Hello,
    cadence: Cadence,
    state: Mutex<State>,
}

impl Light {
    /// The link of `id` to the controller at `address` (`host:port`), which
    /// must prove the key `pin` names. `hello` is sent as given, with this
    /// key's node id.
    pub fn new(
        id: &Identity,
        dialer: Dialer,
        address: String,
        pin: [u8; 32],
        mut hello: Hello,
    ) -> anyhow::Result<Arc<Self>> {
        hello.proto = wire::PROTO;
        hello.node_id = id.node_id();
        hello.kind = Some(wire::NodeKind::Light);
        hello.check().map_err(|e| anyhow::anyhow!("hello: {e}"))?;
        Ok(Arc::new(Self {
            client: tls::Client::new(id)?,
            dialer,
            address,
            hello,
            cadence: Cadence::default(),
            state: Mutex::new(State {
                status: LightStatus {
                    state: Some(LinkState::Connecting),
                    pin: format_fingerprint(&pin),
                    ..LightStatus::default()
                },
                pin,
                telemetry: None,
                leave: None,
                left: false,
            }),
        }))
    }

    /// The same, at another cadence (the tests').
    pub fn with_cadence(self: Arc<Self>, cadence: Cadence) -> Arc<Self> {
        let mut me = Arc::try_unwrap(self).ok().expect("a link not shared yet");
        me.cadence = cadence;
        Arc::new(me)
    }

    pub fn status(&self) -> LightStatus {
        self.state.lock_ok().status.clone()
    }

    /// A new telemetry document: pushed now if the link is up and approved,
    /// else as soon as it is, and again every `PUSH_EVERY` until the next.
    /// Refused when it is not a JSON object or would not fit a line.
    pub fn report(&self, telemetry: &Value) -> Result<(), String> {
        if !telemetry.is_object() {
            return Err("the telemetry is not a JSON object".into());
        }
        let line = wire::event(name::TELEMETRY, telemetry);
        if line.len() > MAX_LINE {
            return Err(format!(
                "the telemetry is {} bytes; a line is at most {MAX_LINE}",
                line.len()
            ));
        }
        let mut st = self.state.lock_ok();
        let generation = st.telemetry.as_ref().map_or(0, |(_, g)| g + 1);
        st.telemetry = Some((line.into(), generation));
        Ok(())
    }

    /// Unpair: tell the controller this device leaves and asks to be
    /// forgotten (`leave`, wire.rs), and wait up to `within` for it to say
    /// it heard. Heard, the link closes and dials nobody again. An error
    /// when the link is not up and approved in time, or nobody at the box
    /// was listening — the device is then still a node.
    pub fn leave(&self, within: Duration) -> Result<(), String> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.state.lock_ok().leave = Some(tx);
        let answer = rx.recv_timeout(within);
        self.state.lock_ok().leave = None;
        answer.unwrap_or_else(|_| {
            Err("the controller did not hear it in time (the link is not up and approved)".into())
        })
    }

    /// `status`, a light node's: its hello's facts under the status
    /// document's names.
    fn status_line(&self) -> String {
        let h = &self.hello;
        wire::event(
            name::STATUS,
            &serde_json::json!({
                "agent": "daedalus-ios",
                "version": h.agent_version,
                "hostname": h.hostname,
                "os": h.os,
                "os_name": h.facts.os_name,
                "os_version": h.facts.os_version,
                "arch": h.arch,
                "awake_hold": false,
                "policy": {"awake_hold": false, "claude_remote_control": false},
            }),
        )
    }

    fn set(&self, f: impl FnOnce(&mut LightStatus)) {
        f(&mut self.state.lock_ok().status);
    }

    /// The link's thread: one connection after another until `stop`.
    pub fn run(&self, stop: &Shutdown) {
        let mut backoff = self.cadence.backoff_min;
        loop {
            if stop.is_stopped() || self.state.lock_ok().left {
                return;
            }
            let pin = self.state.lock_ok().pin;
            let wait = match self.connect_once(pin, stop) {
                Ended::Stopped => return,
                Ended::Rotated { new, .. } => {
                    let fp = format_fingerprint(&new);
                    tracing::warn!(fingerprint = %fp, "link: re-pinned to the controller's new key (a signed rotation)");
                    let mut st = self.state.lock_ok();
                    st.pin = new;
                    st.status.pin = fp;
                    st.status.connected = false;
                    st.status.error = None;
                    backoff = self.cadence.backoff_min;
                    Duration::ZERO
                }
                Ended::Dropped(why) => {
                    tracing::info!(why, "link: the connection to the controller ended");
                    backoff = self.cadence.backoff_min;
                    self.set(|l| {
                        l.connected = false;
                        l.error = Some(why);
                    });
                    self.cadence.backoff_min
                }
                Ended::Failed(why) => {
                    tracing::info!(address = %self.address, why, "link: controller not reached");
                    self.set(|l| {
                        l.connected = false;
                        l.state = Some(LinkState::Connecting);
                        l.error = Some(why);
                    });
                    let w = backoff;
                    backoff = (backoff * 2).min(self.cadence.backoff_max);
                    w
                }
                Ended::KeyChanged {
                    presented_unproven,
                    pinned,
                } => {
                    let e = format!(
                        "controller key changed: {} presented {} (unproven), but this device trusts {}; \
                         refusing it. If the controller really has a new key, pair again",
                        self.address,
                        format_fingerprint(&digest(&presented_unproven)),
                        format_fingerprint(&pinned),
                    );
                    tracing::error!("{e}");
                    self.set(|l| {
                        l.connected = false;
                        l.state = Some(LinkState::KeyChanged);
                        l.error = Some(e);
                    });
                    self.cadence.backoff_max
                }
                Ended::Revoked => {
                    tracing::warn!("link: the box revoked this device");
                    self.set(|l| {
                        l.connected = false;
                        l.state = Some(LinkState::Revoked);
                        l.error = None;
                    });
                    self.cadence.backoff_max
                }
                Ended::Version(e) => {
                    tracing::warn!(error = %e, "link: the controller speaks another protocol");
                    self.set(|l| {
                        l.connected = false;
                        l.state = Some(LinkState::Refused);
                        l.error = Some(e);
                    });
                    self.cadence.backoff_max
                }
            };
            if stop.wait(wait) {
                return;
            }
        }
    }

    fn connect_once(&self, pin: [u8; 32], stop: &Shutdown) -> Ended {
        let Opened {
            mut tls,
            welcome,
            controller_key,
        } = match open(&self.dialer, &self.client, &self.address, pin, &self.hello) {
            Ok(o) => o,
            Err(e) => return e,
        };
        tracing::info!(
            address = %self.address,
            state = welcome.state.as_str(),
            controller = %welcome.controller.hostname,
            "link: connected to the controller"
        );
        self.set(|l| {
            l.connected = true;
            l.state = Some(welcome.state.into());
            l.controller = Some(welcome.controller.clone());
            l.error = None;
        });
        let ended = self.converse(&mut tls, welcome.state, &controller_key, stop);
        if !matches!(ended, Ended::Stopped | Ended::Revoked) {
            tls.close();
        }
        self.set(|l| l.connected = false);
        ended
    }

    fn converse(
        &self,
        tls: &mut Tls,
        mut state: NodeState,
        controller_key: &[u8; 32],
        stop: &Shutdown,
    ) -> Ended {
        // The generation pushed last, and when.
        let mut pushed: Option<(u64, Instant)> = None;
        let mut status_sent = false;
        // A leave told to the controller, until it answers.
        let mut leaving: Option<mpsc::SyncSender<Result<(), String>>> = None;
        let mut heard = Instant::now();
        let mut said = Instant::now();
        loop {
            if stop.is_stopped() {
                tls.close_gracefully(Duration::from_millis(500));
                return Ended::Stopped;
            }
            if state == NodeState::Approved && !status_sent {
                if let Err(e) = tls.send(&self.status_line()) {
                    return Ended::Dropped(format!("a write failed: {e}"));
                }
                status_sent = true;
                said = Instant::now();
            }
            if state == NodeState::Approved && leaving.is_none() {
                if let Some(tx) = self.state.lock_ok().leave.take() {
                    let line = wire::request(LEAVE_ID, name::LEAVE, &serde_json::json!({}));
                    if let Err(e) = tls.send(&line) {
                        return Ended::Dropped(format!("a write failed: {e}"));
                    }
                    said = Instant::now();
                    leaving = Some(tx);
                }
            }
            if state == NodeState::Approved {
                let doc = self.state.lock_ok().telemetry.clone();
                if let Some((line, generation)) = doc {
                    if pushed.is_none_or(|(g, at)| {
                        g != generation || at.elapsed() >= self.cadence.push_every
                    }) {
                        if let Err(e) = tls.send(&line) {
                            return Ended::Dropped(format!("a write failed: {e}"));
                        }
                        pushed = Some((generation, Instant::now()));
                        said = Instant::now();
                    }
                }
            }
            if said.elapsed() >= self.cadence.heartbeat {
                if let Err(e) = tls.send(wire::HB_LINE) {
                    return Ended::Dropped(format!("a write failed: {e}"));
                }
                said = Instant::now();
            }
            let line = match tls.recv() {
                Ok(Recv::Line(l)) => l,
                Ok(Recv::Idle) => {
                    if heard.elapsed() > self.cadence.dead_after {
                        return Ended::Dropped(format!(
                            "no word from the controller for {} s",
                            self.cadence.dead_after.as_secs()
                        ));
                    }
                    continue;
                }
                Ok(Recv::Closed) => return Ended::Dropped("closed by the controller".into()),
                Err(e) => return Ended::Dropped(format!("the connection failed: {e}")),
            };
            heard = Instant::now();
            match Incoming::parse(&line) {
                Ok(Incoming::Event { e, p }) if e == name::STATE => {
                    let Ok(s) = serde_json::from_value::<StateEvent>(p) else {
                        continue;
                    };
                    tracing::info!(
                        state = s.state.as_str(),
                        "link: the controller says where this device stands"
                    );
                    state = s.state;
                    self.set(|l| l.state = Some(state.into()));
                    match state {
                        NodeState::Approved => {
                            pushed = None;
                            status_sent = false;
                        }
                        NodeState::Revoked => {
                            tls.close();
                            return Ended::Revoked;
                        }
                        _ => {}
                    }
                }
                Ok(Incoming::Request(Request { id, m, p })) => {
                    let mut rotated = None;
                    let answer = match m.as_str() {
                        name::ROTATE => match take_rotate(controller_key, p) {
                            Ok(new) => {
                                rotated = Some((digest(controller_key), digest(&new)));
                                Response::ok(id, &Accepted { accepted: true })
                            }
                            Err(e) => {
                                tracing::warn!(error = %e.msg, "link: refused a controller key rotation");
                                Response::err(Some(id), e)
                            }
                        },
                        _ => Response::err(
                            Some(id),
                            ApiError::new(
                                ErrorCode::Unsupported,
                                "a light node reports its telemetry and takes no commands",
                            ),
                        ),
                    };
                    let line = serde_json::to_string(&answer).unwrap_or_default();
                    if let Err(e) = tls.send(&line) {
                        return Ended::Dropped(format!("a write failed: {e}"));
                    }
                    said = Instant::now();
                    if let Some((from, new)) = rotated {
                        tls.close();
                        return Ended::Rotated { from, new };
                    }
                }
                Ok(Incoming::Answer {
                    id: Some(LEAVE_ID),
                    result,
                }) => {
                    if let Some(tx) = leaving.take() {
                        match result {
                            Ok(_) => {
                                self.state.lock_ok().left = true;
                                let _ = tx.try_send(Ok(()));
                                tls.close();
                                return Ended::Dropped("unpaired: the controller heard it".into());
                            }
                            Err(e) => {
                                let _ = tx.try_send(Err(e.msg));
                            }
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => tracing::debug!(error = %e, "link: a line that is not a message"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::link::tls::server_config;
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn id(n: u8) -> Identity {
        Identity::from_seed([n; 32])
    }

    fn hello() -> Hello {
        Hello {
            agent_version: "1.0.0".into(),
            os: "ios".into(),
            arch: "aarch64".into(),
            hostname: "Santiago’s iPhone".into(),
            capabilities: vec![wire::Capability::TelemetryMinimal],
            telemetry: wire::TelemetryLevel::Minimal,
            ..Hello::default()
        }
    }

    fn fast() -> Cadence {
        Cadence {
            heartbeat: Duration::from_millis(200),
            dead_after: Duration::from_secs(3),
            push_every: Duration::from_millis(600),
            backoff_min: Duration::from_millis(50),
            backoff_max: Duration::from_millis(200),
        }
    }

    /// A controller that admits one connection at `state`, sends `after`
    /// once `hello` is answered, and hands back every line it reads.
    fn controller(
        ctl: &Identity,
        state: NodeState,
        after: Vec<String>,
    ) -> (String, mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let cfg = server_config(ctl).unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            while let Ok((sock, _)) = listener.accept() {
                let Ok(mut t) = Tls::server(sock, cfg.clone(), Duration::from_secs(5)) else {
                    continue;
                };
                let mut welcomed = false;
                loop {
                    match t.recv() {
                        Ok(Recv::Line(l)) => {
                            let text = String::from_utf8(l.clone()).unwrap();
                            if let (false, Ok(Incoming::Request(r))) =
                                (welcomed, Incoming::parse(&l))
                            {
                                let h: Hello = serde_json::from_value(r.p).unwrap();
                                let w = Welcome {
                                    proto: wire::PROTO,
                                    node_id: h.node_id.clone(),
                                    state,
                                    controller: ControllerId {
                                        version: "0.30.0".into(),
                                        hostname: "box".into(),
                                        fingerprint: String::new(),
                                    },
                                    policy: None,
                                };
                                t.send(&serde_json::to_string(&Response::ok(r.id, &w)).unwrap())
                                    .unwrap();
                                for line in &after {
                                    t.send(line).unwrap();
                                }
                                welcomed = true;
                            }
                            if tx.send(text).is_err() {
                                return;
                            }
                        }
                        Ok(Recv::Idle) => {}
                        _ => break,
                    }
                }
            }
        });
        (addr, rx)
    }

    fn next(rx: &mpsc::Receiver<String>, what: &str) -> String {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let line = rx
                .recv_timeout(until.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no {what}"));
            if line.contains(what) {
                return line;
            }
        }
    }

    fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
        let until = Instant::now() + Duration::from_secs(10);
        while !f() {
            assert!(Instant::now() < until, "never: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn start(link: &Arc<Light>) -> (Shutdown, std::thread::JoinHandle<()>) {
        let stop = Shutdown::new();
        let t = {
            let (link, stop) = (Arc::clone(link), stop.clone());
            std::thread::spawn(move || link.run(&stop))
        };
        (stop, t)
    }

    #[test]
    fn an_approved_light_node_says_hello_and_pushes_what_it_is_handed() {
        let (ctl, me) = (id(200), id(1));
        let pin = digest(ctl.public_key().as_bytes());
        // A command, which a light node refuses, rides behind the welcome.
        let command = wire::request(
            7,
            name::COMMAND,
            &serde_json::json!({"command": "check_update"}),
        );
        let (addr, rx) = controller(&ctl, NodeState::Approved, vec![command]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        // Handed before the link is up: pushed once it is.
        // With a watch beside it: the document goes as it was handed, whole.
        let watch = serde_json::json!([{"kind": "watch", "model": "Watch7,5",
            "os_version": "26.1", "battery": {"percent": 64.0, "charging": false}}]);
        link.report(&serde_json::json!({
            "sampled_at": "t0", "battery": {"percent": 80.0}, "accessories": watch
        }))
        .unwrap();
        let (stop, thread) = start(&link);
        let h: Value = serde_json::from_str(&next(&rx, "\"hello\"")).unwrap();
        assert_eq!(h["p"]["node_id"], me.node_id());
        assert_eq!(h["p"]["kind"], "light");
        assert_eq!(h["p"]["os"], "ios");
        assert_eq!(
            h["p"]["capabilities"],
            serde_json::json!(["telemetry.minimal"])
        );
        let status: Value = serde_json::from_str(&next(&rx, "\"e\":\"status\"")).unwrap();
        assert_eq!(status["p"]["os"], "ios");
        assert_eq!(status["p"]["version"], "1.0.0");
        let first: Value = serde_json::from_str(&next(&rx, "\"e\":\"telemetry\"")).unwrap();
        assert_eq!(first["p"]["sampled_at"], "t0");
        assert_eq!(first["p"]["accessories"], watch);
        let refusal = next(&rx, "\"id\":7");
        assert!(refusal.contains("\"unsupported\""), "{refusal}");
        wait_for("approved", || {
            link.status().state == Some(LinkState::Approved)
        });
        let s = link.status();
        assert!(s.connected);
        assert_eq!(s.controller.unwrap().hostname, "box");
        assert_eq!(s.pin, format_fingerprint(&pin));
        // The same document again on the cadence, a new one at once.
        assert!(next(&rx, "\"e\":\"telemetry\"").contains("\"t0\""));
        link.report(&serde_json::json!({"sampled_at": "t1"}))
            .unwrap();
        assert!(next(&rx, "\"e\":\"telemetry\"").contains("\"t1\""));
        assert!(next(&rx, "\"hb\"").contains("hb"));
        // Not an object, or past a line: refused, and nothing is sent.
        assert!(link.report(&serde_json::json!([1])).is_err());
        assert!(link
            .report(&serde_json::json!({"x": "y".repeat(MAX_LINE)}))
            .is_err());
        stop.stop();
        thread.join().unwrap();
        assert!(!link.status().connected);
    }

    #[test]
    fn a_pending_light_node_waits_and_is_upgraded_in_place() {
        let (ctl, me) = (id(200), id(2));
        let pin = digest(ctl.public_key().as_bytes());
        let approve = wire::event(
            name::STATE,
            &StateEvent {
                state: NodeState::Approved,
            },
        );
        // Pending first: nothing but heartbeats.
        let (addr, rx) = controller(&ctl, NodeState::Pending, vec![]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        link.report(&serde_json::json!({"sampled_at": "t0"}))
            .unwrap();
        let (stop, thread) = start(&link);
        next(&rx, "\"hello\"");
        wait_for("pending", || {
            link.status().state == Some(LinkState::Pending)
        });
        next(&rx, "\"hb\"");
        next(&rx, "\"hb\"");
        assert!(rx.try_iter().all(|l| !l.contains("\"e\":\"telemetry\"")));
        stop.stop();
        thread.join().unwrap();

        // Approved on the open connection: the document goes up.
        let (addr, rx) = controller(&ctl, NodeState::Pending, vec![approve]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        link.report(&serde_json::json!({"sampled_at": "t0"}))
            .unwrap();
        let (stop, thread) = start(&link);
        next(&rx, "\"e\":\"telemetry\"");
        assert_eq!(link.status().state, Some(LinkState::Approved));
        stop.stop();
        thread.join().unwrap();
    }

    #[test]
    fn another_key_is_refused_a_revocation_is_said_and_a_rotation_re_pins() {
        let (ctl, other, me) = (id(200), id(201), id(3));
        let pin = digest(ctl.public_key().as_bytes());
        // The controller proves another key than the pin.
        let (addr, _rx) = controller(&other, NodeState::Approved, vec![]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        let (stop, thread) = start(&link);
        wait_for("key-changed", || {
            link.status().state == Some(LinkState::KeyChanged)
        });
        assert!(link
            .status()
            .error
            .unwrap()
            .contains("controller key changed"));
        stop.stop();
        thread.join().unwrap();

        // Revoked on an open connection.
        let revoke = wire::event(
            name::STATE,
            &StateEvent {
                state: NodeState::Revoked,
            },
        );
        let (addr, _rx) = controller(&ctl, NodeState::Approved, vec![revoke]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        let (stop, thread) = start(&link);
        wait_for("revoked", || {
            link.status().state == Some(LinkState::Revoked)
        });
        stop.stop();
        thread.join().unwrap();

        // A rotation the trusted key signed moves the pin; one another key
        // signed does not.
        let new = *other.public_key().as_bytes();
        let rotate = |signer: &Identity, rid: u64| {
            wire::request(
                rid,
                name::ROTATE,
                &RotateParams {
                    new_public_key: hex::encode(new),
                    signature: hex::encode(signer.sign_rotation(&new)),
                },
            )
        };
        let (addr, rx) = controller(&ctl, NodeState::Approved, vec![rotate(&me, 8)]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        let (stop, thread) = start(&link);
        assert!(next(&rx, "\"id\":8").contains("\"forbidden\""));
        assert_eq!(link.status().pin, format_fingerprint(&pin));
        stop.stop();
        thread.join().unwrap();

        let (addr, rx) = controller(&ctl, NodeState::Approved, vec![rotate(&ctl, 9)]);
        let link = Light::new(&me, Dialer::Direct, addr, pin, hello())
            .unwrap()
            .with_cadence(fast());
        let (stop, thread) = start(&link);
        assert!(next(&rx, "\"id\":9").contains("\"accepted\":true"));
        wait_for("re-pinned", || {
            link.status().pin == format_fingerprint(&digest(&new))
        });
        stop.stop();
        thread.join().unwrap();
    }

    #[test]
    fn a_hello_out_of_bounds_makes_no_link() {
        let mut h = hello();
        h.os = "i os".into();
        assert!(Light::new(&id(4), Dialer::Direct, "127.0.0.1:1".into(), [0; 32], h).is_err());
    }
}
