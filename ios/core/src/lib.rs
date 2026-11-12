//! The daedalus iOS app as a LIGHT NODE of a box, in the app's process.
//!
//! The device is a node like any machine that runs the agent — its own
//! ed25519 key, the same pinned TLS link to the controller — reached the
//! way a logged-in Mac reaches it: through its own userspace WireGuard
//! tunnel, an ordinary wg-easy client whose AllowedIPs is the box's LAN
//! address alone. No Network Extension, no VPN profile, no route. What
//! makes it light (agent/core/src/link/wire.rs `NodeKind`): it reports its
//! telemetry and nothing else, takes no policy and no command, and is on
//! the link only while the app is in the foreground.
//!
//! ```text
//! the app ─ daedalus_report ─▶ link (TLS, pinned) ──────────┐
//! URLSession ─ CONNECT ─▶ 127.0.0.1:<port>  proxy.rs        │ tunnel.connect(<port>)
//!                                                       Stream ─ smoltcp TCP ─ boringtun ─ UDP ─▶ wg-easy
//!                                    10.8.0.x ⇄ the box's LAN address: :7788 the link, :<proxy_port> the app's API
//! ```
//!
//! **Two paths, one tunnel.** The link carries the device's presence and
//! telemetry to the controller. The app's DATA — reading the box, acting on
//! it — is HTTPS to the control plane's API at the box's LAN address, which
//! `URLSession` reaches through the loopback CONNECT proxy (proxy.rs): the
//! proxy dials the tunnel's one target at the one configured port, whatever
//! host a CONNECT names, and the TLS inside proves who answers.
//!
//! **One copy of the protocol.** The key, the tunnel, the link's TLS, wire
//! and a light node's conversation are the shared crate's (agent/core),
//! which the agent builds from too; this crate is the config (config.rs),
//! the proxy, and the C ABI the app calls (ffi.rs,
//! include/daedalus_ios.h). So a build needs the repository, not this
//! directory alone.
//!
//! **Before pairing** the config has no `node`: the tunnel and the proxy
//! run alone, which is all a pairing needs. Rust callers — the tests, the
//! examples — use `Node` directly.

pub mod config;
pub mod ffi;
pub mod proxy;

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;

use daedalus_core::link::client::Light;
use daedalus_core::link::wire::ControllerId;
use daedalus_core::link::TunnelStatus;
use daedalus_core::net::Dialer;
use daedalus_core::tunnel::Tunnel;
use daedalus_core::util::Shutdown;

use config::Checked;
use proxy::Proxy;

/// How long a stopping link has to say goodbye (`Node::stop`).
const GOODBYE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Everything one `daedalus_start` runs: the tunnel, the proxy, and — once
/// the device is paired — the link. Dropping it stops all three.
pub struct Node {
    tunnel: Arc<Tunnel>,
    proxy: Proxy,
    link: Option<Link>,
}

struct Link {
    light: Arc<Light>,
    stop: Shutdown,
    thread: Option<std::thread::JoinHandle<()>>,
}

/// The proxy as the app is told it: where, and the credential of this
/// start.
#[derive(Serialize)]
pub struct ProxyInfo {
    pub port: u16,
    pub username: String,
    pub password: String,
}

/// `daedalus_status`.
#[derive(Serialize)]
pub struct Status {
    /// Started, and the proxy still listening (iOS takes a suspended app's
    /// sockets: false then, and the app starts again).
    pub running: bool,
    pub tunnel: Option<TunnelStatus>,
    pub link: LinkView,
    /// Connections through the proxy to the box right now.
    pub connections: usize,
}

/// The link as the app shows it.
#[derive(Serialize)]
pub struct LinkView {
    /// `off` (not started, or no `node` in the config), `connecting`,
    /// `pending` (waiting for an admin's approval), `approved`, `revoked`,
    /// `refused` (the controller speaks another protocol), `key-changed`
    /// (it proved another key than the pin).
    pub state: String,
    /// Whether a connection to the controller is open now.
    pub connected: bool,
    pub controller: Option<ControllerView>,
    /// The fingerprint of the controller key trusted now. It is the
    /// config's until the controller rotates its key (a statement the
    /// trusted key signed): the app keeps what it reads here and passes it
    /// as `controller.pin` from then on. Null while off.
    pub pin: Option<String>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct ControllerView {
    pub version: String,
    pub hostname: String,
}

impl From<ControllerId> for ControllerView {
    fn from(c: ControllerId) -> Self {
        Self {
            version: c.version,
            hostname: c.hostname,
        }
    }
}

impl LinkView {
    fn off() -> Self {
        Self {
            state: "off".into(),
            connected: false,
            controller: None,
            pin: None,
            error: None,
        }
    }
}

impl Status {
    /// Nothing started.
    pub fn stopped() -> Self {
        Self {
            running: false,
            tunnel: None,
            link: LinkView::off(),
            connections: 0,
        }
    }
}

impl Node {
    /// Bring it up: the tunnel (nothing is sent until the first dial), the
    /// proxy on a loopback port of the system's choosing, and the link's
    /// thread when the config names a node.
    pub fn start(config: Checked) -> Result<Self, String> {
        let tunnel = Tunnel::start(config.settings)
            .map_err(|e| format!("the tunnel could not start: {e}"))?;
        let proxy = Proxy::start(tunnel.clone(), config.proxy_port)
            .map_err(|e| format!("the proxy could not listen on the loopback: {e}"))?;
        let link = match config.node {
            None => None,
            Some(n) => {
                let light = Light::new(
                    &n.identity,
                    Dialer::Tunnel(Arc::clone(&tunnel)),
                    n.address,
                    n.pin,
                    n.hello,
                )
                .map_err(|e| format!("the link: {e:#}"))?;
                let stop = Shutdown::new();
                let thread = {
                    let (light, stop) = (Arc::clone(&light), stop.clone());
                    std::thread::Builder::new()
                        .name("link".into())
                        .spawn(move || light.run(&stop))
                        .map_err(|e| format!("the link's thread: {e}"))?
                };
                Some(Link {
                    light,
                    stop,
                    thread: Some(thread),
                })
            }
        };
        Ok(Self {
            tunnel,
            proxy,
            link,
        })
    }

    pub fn proxy(&self) -> ProxyInfo {
        ProxyInfo {
            port: self.proxy.port(),
            username: self.proxy.username().to_string(),
            password: self.proxy.password().to_string(),
        }
    }

    /// A telemetry sample for the controller (the shared crate's
    /// `Light::report`): sent now if the link is up and approved, else when
    /// it is, and again every minute until the next.
    pub fn report(&self, telemetry: &Value) -> Result<(), String> {
        match &self.link {
            Some(l) => l.light.report(telemetry),
            None => {
                Err("this start has no node (the device is not paired): nothing reports".into())
            }
        }
    }

    /// The link, for a call that waits on it outside any lock (ffi.rs
    /// `daedalus_leave`).
    pub fn link_handle(&self) -> Option<Arc<Light>> {
        self.link.as_ref().map(|l| Arc::clone(&l.light))
    }

    pub fn status(&self) -> Status {
        let link = match &self.link {
            None => LinkView::off(),
            Some(l) => {
                let s = l.light.status();
                LinkView {
                    state: s.state.map_or_else(|| "off".into(), |s| s.to_string()),
                    connected: s.connected,
                    controller: s.controller.map(Into::into),
                    pin: Some(s.pin),
                    error: s.error,
                }
            }
        };
        Status {
            running: self.proxy.running(),
            tunnel: Some(self.tunnel.status()),
            link,
            connections: self.proxy.connections(),
        }
    }

    /// Stop all of it and wait for every thread. The link goes first and
    /// has `GOODBYE` to close its connection while the tunnel still carries
    /// it, so the controller sees the device leave at once rather than fall
    /// silent; then the tunnel, which fails whatever dial is under way —
    /// the link's or the proxy's — and then the proxy. Idempotent.
    pub fn stop(&mut self) {
        if let Some(l) = &self.link {
            l.stop.stop();
            let until = std::time::Instant::now() + GOODBYE;
            while l.thread.as_ref().is_some_and(|t| !t.is_finished())
                && std::time::Instant::now() < until
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        self.tunnel.stop();
        if let Some(t) = self.link.as_mut().and_then(|l| l.thread.take()) {
            let _ = t.join();
        }
        self.proxy.stop();
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}
