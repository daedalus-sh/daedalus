//! The door the app's `URLSession` uses: an HTTP CONNECT proxy on
//! `127.0.0.1`, on a port the system picks, in front of the tunnel.
//!
//! **Why it has a credential.** Loopback on iOS is not the app's own: any
//! other app on the device can connect to a port this one listens on. So
//! every start makes a credential — two 32-hex strings from the system's
//! random source — that only the app is told (`daedalus_start` hands it
//! back), and a CONNECT without it gets nothing through:
//! `407` with `Proxy-Authenticate: Basic realm="daedalus"` when the header
//! is missing (a client that only sends credentials once challenged retries
//! on the same connection, once), `403` when it is wrong. It is compared in
//! constant time. The TLS the app speaks inside the CONNECT, pinned, is
//! still what proves the box; the credential keeps strangers out of the
//! tunnel.
//!
//! **Where a CONNECT goes.** To the tunnel's one target at the one
//! configured port, whatever host the request names — the host is never
//! resolved or compared (the `Dialer`'s rule, agent/core/src/net.rs). The
//! port is: a CONNECT to any other port is `403`. A dial that fails is
//! `502` with the tunnel's reason on one line.
//!
//! **A request** is read under one deadline that does not move
//! (`HEAD_DEADLINE`, a watchdog — a trickling client is cut) and a cap
//! (`HEAD_CAP`); anything but `CONNECT` is `405`. Bytes that follow the
//! head on the wire go to the box first.
//!
//! **A connection** is two threads, one each way, copying until the end of
//! their side: an end (FIN) from the app closes the box's side for writing
//! and the answers keep coming, and the other way round; an error either
//! way ends both. At most `MAX_CONNECTIONS` at once; one more is `503`.
//! `stop` shuts every socket and joins every thread; a tunnel that stops
//! ends its connections by itself (their reads fail).
//!
//! **A listener the system took away** (iOS reclaims the sockets of a
//! suspended app) fails its accepts: after a second of that the proxy
//! gives up and `running()` says so — the app starts again and gets a new
//! port and credential.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use daedalus_core::ipc::deadline::{Deadline, Watchdog};
use daedalus_core::tunnel::{Stream, Tunnel};
use daedalus_core::util::LockExt;

/// The longest request head taken, its end included.
pub const HEAD_CAP: usize = 8 * 1024;
/// A request head not whole by then ends the connection.
pub const HEAD_DEADLINE: Duration = Duration::from_secs(10);
/// A dial through the tunnel, its WireGuard handshake included.
pub const DIAL_DEADLINE: Duration = Duration::from_secs(15);
/// Connections served at once.
pub const MAX_CONNECTIONS: usize = 32;
/// Request heads read on one connection: the first, and one more after a
/// challenge.
const HEADS: usize = 2;
/// Accepts failing in a row before the listener is given up on, and the
/// pause between them (the module doc: about a second).
const ACCEPT_FAILURES: u32 = 20;
const ACCEPT_PAUSE: Duration = Duration::from_millis(50);

/// The far side of a connection: the tunnel's `Stream`, or whatever a test
/// puts there.
pub trait Remote: Read + Write + Send {
    /// Another handle on the same connection.
    fn another(&self) -> io::Result<Box<dyn Remote>>;
    fn shutdown(&self, how: Shutdown);
}

/// How the proxy reaches the box: the tunnel, or a test's stand-in.
pub trait Dial: Send + Sync + 'static {
    fn dial(&self, port: u16, within: Duration) -> Result<Box<dyn Remote>, String>;
}

impl Remote for Stream {
    fn another(&self) -> io::Result<Box<dyn Remote>> {
        Ok(Box::new(self.clone()))
    }

    fn shutdown(&self, how: Shutdown) {
        let _ = Stream::shutdown(self, how);
    }
}

impl Dial for Tunnel {
    fn dial(&self, port: u16, within: Duration) -> Result<Box<dyn Remote>, String> {
        self.connect(port, within)
            .map(|s| Box::new(s) as Box<dyn Remote>)
    }
}

/// What a start may vary; the tests shorten it.
#[derive(Clone, Copy, Debug)]
struct Limits {
    head: Duration,
    dial: Duration,
    connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            head: HEAD_DEADLINE,
            dial: DIAL_DEADLINE,
            connections: MAX_CONNECTIONS,
        }
    }
}

/// The running proxy. Dropping it stops it.
pub struct Proxy {
    port: u16,
    username: String,
    password: Zeroizing<String>,
    shared: Arc<Shared>,
    acceptor: Mutex<Option<JoinHandle<()>>>,
}

struct Shared {
    dial: Arc<dyn Dial>,
    /// The one port at the box.
    port: u16,
    /// `username:password`, as Basic carries it before base64.
    credential: Zeroizing<Vec<u8>>,
    limits: Limits,
    stopped: AtomicBool,
    /// The listener is gone (module doc).
    failed: AtomicBool,
    conns: Mutex<Conns>,
}

#[derive(Default)]
struct Conns {
    next: u64,
    open: HashMap<u64, Conn>,
    /// Every connection's first thread (it joins its second); the ended
    /// ones are reaped at the next accept.
    threads: Vec<JoinHandle<()>>,
}

/// A connection's sockets, kept to shut them from outside its threads.
struct Conn {
    client: TcpStream,
    /// The box's side, once dialled.
    remote: Option<Box<dyn Remote>>,
}

/// 32 hex characters from the system's random source.
fn hex32() -> String {
    let mut bytes = [0u8; 16];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Proxy {
    /// Listen on `127.0.0.1`, a port of the system's choosing, with a new
    /// credential; every CONNECT is dialled through `dial` to `port`.
    pub fn start(dial: Arc<dyn Dial>, port: u16) -> io::Result<Self> {
        Self::start_with(dial, port, Limits::default())
    }

    fn start_with(dial: Arc<dyn Dial>, port: u16, limits: Limits) -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let at = listener.local_addr()?.port();
        let username = hex32();
        let password = Zeroizing::new(hex32());
        let shared = Arc::new(Shared {
            dial,
            port,
            credential: Zeroizing::new(format!("{username}:{}", *password).into_bytes()),
            limits,
            stopped: AtomicBool::new(false),
            failed: AtomicBool::new(false),
            conns: Mutex::new(Conns::default()),
        });
        let acceptor = {
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("proxy".into())
                .spawn(move || accept(&listener, &shared))?
        };
        tracing::info!(port = at, "proxy: listening on the loopback");
        Ok(Self {
            port: at,
            username,
            password,
            shared,
            acceptor: Mutex::new(Some(acceptor)),
        })
    }

    /// The loopback port it listens on.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn username(&self) -> &str {
        &self.username
    }

    pub fn password(&self) -> &str {
        &self.password
    }

    /// Listening still: not stopped, and the listener not given up on.
    pub fn running(&self) -> bool {
        !self.shared.stopped.load(Ordering::SeqCst) && !self.shared.failed.load(Ordering::SeqCst)
    }

    /// Connections through to the box right now.
    pub fn connections(&self) -> usize {
        let conns = self.shared.conns.lock_ok();
        conns.open.values().filter(|c| c.remote.is_some()).count()
    }

    /// Stop listening, shut every connection and wait for every thread.
    /// Idempotent. A dial under way holds it up for as long as the dial
    /// takes: stop the tunnel first (`Node::stop` does), and it fails at once.
    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        for c in self.shared.conns.lock_ok().open.values() {
            c.shut();
        }
        if let Some(acceptor) = self.acceptor.lock_ok().take() {
            // The acceptor sleeps in `accept`: a connection wakes it.
            let woke = TcpStream::connect_timeout(
                &SocketAddr::from(([127, 0, 0, 1], self.port)),
                Duration::from_secs(1),
            )
            .is_ok();
            // A listener that cannot be woken is failing its accepts, and
            // the acceptor ends by itself within about a second; one that
            // somehow does neither is left behind rather than waited for.
            let patience = Deadline::after(Duration::from_secs(3));
            while !woke && !acceptor.is_finished() && !patience.passed() {
                std::thread::sleep(Duration::from_millis(20));
            }
            if woke || acceptor.is_finished() {
                let _ = acceptor.join();
            }
        }
        // Nothing registers once `stopped` is up (`serve`), so this is all.
        let threads = std::mem::take(&mut self.shared.conns.lock_ok().threads);
        for t in threads {
            let _ = t.join();
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Conn {
    fn shut(&self) {
        let _ = self.client.shutdown(Shutdown::Both);
        if let Some(r) = &self.remote {
            r.shutdown(Shutdown::Both);
        }
    }
}

/// The acceptor's thread: one connection after another, until stopped or
/// the listener is gone.
fn accept(listener: &TcpListener, shared: &Arc<Shared>) {
    let mut failures = 0;
    loop {
        let accepted = listener.accept();
        if shared.stopped.load(Ordering::SeqCst) {
            return;
        }
        match accepted {
            Ok((client, _)) => {
                failures = 0;
                serve(shared, client);
            }
            Err(e) => {
                failures += 1;
                if failures >= ACCEPT_FAILURES {
                    tracing::warn!(error = %e, "proxy: the listener is gone");
                    shared.failed.store(true, Ordering::SeqCst);
                    return;
                }
                std::thread::sleep(ACCEPT_PAUSE);
            }
        }
    }
}

/// Give an accepted connection its thread, or `503` when there are
/// `MAX_CONNECTIONS` already.
fn serve(shared: &Arc<Shared>, mut client: TcpStream) {
    quiet(&client);
    let _ = client.set_nodelay(true);
    let _ = client.set_write_timeout(Some(shared.limits.head));
    let mut conns = shared.conns.lock_ok();
    if shared.stopped.load(Ordering::SeqCst) {
        return;
    }
    let (ended, running): (Vec<_>, Vec<_>) = std::mem::take(&mut conns.threads)
        .into_iter()
        .partition(JoinHandle::is_finished);
    conns.threads = running;
    for t in ended {
        let _ = t.join();
    }
    if conns.open.len() >= shared.limits.connections {
        drop(conns);
        refuse(
            &mut client,
            "503 Service Unavailable",
            "too many connections",
        );
        return;
    }
    let Ok(kept) = client.try_clone() else {
        return;
    };
    let id = conns.next;
    conns.next += 1;
    let thread = {
        let shared = Arc::clone(shared);
        std::thread::Builder::new()
            .name("proxy-up".into())
            .spawn(move || {
                if let Some((remote, early)) = open(&shared, id, &mut client) {
                    pump(&shared, id, client, remote, &early);
                }
                shared.conns.lock_ok().open.remove(&id);
            })
    };
    // Without a thread for it the connection is dropped: closed.
    if let Ok(thread) = thread {
        conns.open.insert(
            id,
            Conn {
                client: kept,
                remote: None,
            },
        );
        conns.threads.push(thread);
    }
}

/// A request head, as much of it as the proxy looks at.
#[derive(Debug, PartialEq, Eq)]
struct Head {
    method: String,
    target: String,
    /// The first `Proxy-Authorization`, if any.
    authorization: Option<String>,
    /// The request says a body follows (`Content-Length` not 0, or a
    /// `Transfer-Encoding`): the connection cannot be read on past it.
    body: bool,
}

/// What to do with a request.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    Dial,
    /// No credential: `407`.
    Challenge,
    Refuse(&'static str, String),
}

/// Why no head came.
enum NoHead {
    /// The client went away, or the deadline passed.
    Gone,
    TooLong,
    Malformed,
}

fn parse(head: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let mut request = lines.next()?.split(' ');
    let (method, target, version) = (request.next()?, request.next()?, request.next()?);
    if request.next().is_some()
        || method.is_empty()
        || target.is_empty()
        || !version.starts_with("HTTP/1.")
    {
        return None;
    }
    let mut authorization = None;
    let mut body = false;
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':')?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("proxy-authorization") {
            authorization.get_or_insert_with(|| value.to_string());
        } else if name.eq_ignore_ascii_case("transfer-encoding")
            || (name.eq_ignore_ascii_case("content-length") && value != "0")
        {
            body = true;
        }
    }
    Some(Head {
        method: method.to_string(),
        target: target.to_string(),
        authorization,
        body,
    })
}

/// Read one head into `buf` — which may hold the start of it already, and
/// keeps whatever follows it — by `within`, whatever the client does.
fn read_head(client: &mut TcpStream, buf: &mut Vec<u8>, within: Duration) -> Result<Head, NoHead> {
    let deadline = Deadline::after(within);
    // The deadline, on a socket whose read has no timeout that would do: a
    // watchdog shuts it. Without a second handle for the watchdog, the
    // read's own timeout is the next best thing.
    let _watchdog = match client.try_clone() {
        Ok(theirs) => Some(Watchdog::arm(deadline, move || {
            let _ = theirs.shutdown(Shutdown::Both);
        })),
        Err(_) => {
            let _ = client.set_read_timeout(Some(within));
            None
        }
    };
    let mut chunk = [0u8; 1024];
    loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let head: Vec<u8> = buf.drain(..end + 4).collect();
            return parse(&head).ok_or(NoHead::Malformed);
        }
        if buf.len() >= HEAD_CAP {
            return Err(NoHead::TooLong);
        }
        let room = (HEAD_CAP - buf.len()).min(chunk.len());
        match client.read(&mut chunk[..room]) {
            Ok(0) => return Err(NoHead::Gone),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return Err(NoHead::Gone),
        }
        if deadline.passed() {
            return Err(NoHead::Gone);
        }
    }
}

impl Shared {
    /// `Proxy-Authorization`'s value against the credential, in constant
    /// time.
    fn authorized(&self, value: &str) -> bool {
        use base64::Engine as _;
        let Some((scheme, token)) = value.split_once(' ') else {
            return false;
        };
        if !scheme.eq_ignore_ascii_case("basic") {
            return false;
        }
        let Ok(given) = base64::engine::general_purpose::STANDARD.decode(token.trim()) else {
            return false;
        };
        let given = Zeroizing::new(given);
        given.as_slice().ct_eq(self.credential.as_slice()).into()
    }

    fn judge(&self, head: &Head) -> Verdict {
        if head.method != "CONNECT" {
            return Verdict::Refuse(
                "405 Method Not Allowed",
                "this proxy answers CONNECT alone".into(),
            );
        }
        match &head.authorization {
            None => return Verdict::Challenge,
            Some(value) if !self.authorized(value) => {
                return Verdict::Refuse("403 Forbidden", "the proxy credential is wrong".into())
            }
            Some(_) => {}
        }
        // The host is whatever the app calls the box, and is not looked at
        // (module doc); the port is the one port.
        let port = head
            .target
            .rsplit_once(':')
            .and_then(|(_, p)| p.parse::<u16>().ok());
        if port != Some(self.port) {
            return Verdict::Refuse(
                "403 Forbidden",
                format!("this proxy reaches port {} alone", self.port),
            );
        }
        Verdict::Dial
    }
}

/// An answer with a one-line body, after which the connection is closed.
fn refuse(client: &mut TcpStream, status: &str, why: &str) {
    let why: String = why
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let _ = client.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{why}\n",
            why.len() + 1
        )
        .as_bytes(),
    );
    finish(client);
}

/// Close after an answer so that it arrives: say goodbye, then read what
/// the client had still sent (for a moment, and not much) — closing over
/// unread bytes resets the connection, and the answer with it.
fn finish(client: &mut TcpStream) {
    let _ = client.shutdown(Shutdown::Write);
    let _ = client.set_read_timeout(Some(Duration::from_millis(200)));
    let mut sink = [0u8; 4096];
    let mut left = 64 * 1024usize;
    while left > 0 {
        match client.read(&mut sink) {
            Ok(n) if n > 0 => left = left.saturating_sub(n),
            _ => break,
        }
    }
}

/// From the accept to the box: the request (and one more, after a
/// challenge), the dial, the `200`. The box's side and the bytes that came
/// behind the head, or None when the connection ends here.
fn open(
    shared: &Arc<Shared>,
    id: u64,
    client: &mut TcpStream,
) -> Option<(Box<dyn Remote>, Vec<u8>)> {
    let mut buf = Vec::new();
    for nth in 1..=HEADS {
        let head = match read_head(client, &mut buf, shared.limits.head) {
            Ok(head) => head,
            Err(NoHead::Gone) => return None,
            Err(NoHead::TooLong) => {
                refuse(
                    client,
                    "431 Request Header Fields Too Large",
                    "the request head is too long",
                );
                return None;
            }
            Err(NoHead::Malformed) => {
                refuse(client, "400 Bad Request", "not an HTTP/1.1 request");
                return None;
            }
        };
        match shared.judge(&head) {
            Verdict::Dial => break,
            Verdict::Refuse(status, why) => {
                refuse(client, status, &why);
                return None;
            }
            Verdict::Challenge => {
                // Once, the connection stays for the retry; a body nobody
                // will read past, or a second request without the
                // credential, closes it.
                let close = nth == HEADS || head.body;
                let sent = client.write_all(
                    format!(
                        "HTTP/1.1 407 Proxy Authentication Required\r\n\
                         Proxy-Authenticate: Basic realm=\"daedalus\"\r\n\
                         Content-Length: 0\r\n{}\r\n",
                        if close { "Connection: close\r\n" } else { "" }
                    )
                    .as_bytes(),
                );
                if close || sent.is_err() {
                    finish(client);
                    return None;
                }
            }
        }
    }
    if shared.stopped.load(Ordering::SeqCst) {
        return None;
    }
    let remote = match shared.dial.dial(shared.port, shared.limits.dial) {
        Ok(remote) => remote,
        Err(why) => {
            tracing::debug!(error = %why, "proxy: the dial failed");
            refuse(client, "502 Bad Gateway", &why);
            return None;
        }
    };
    let Ok(kept) = remote.another() else {
        refuse(client, "502 Bad Gateway", "no handle on the connection");
        return None;
    };
    {
        // Under the lock `stop` shuts everything under: either this is in
        // before its sweep, or it sees `stopped` and goes no further.
        let mut conns = shared.conns.lock_ok();
        if shared.stopped.load(Ordering::SeqCst) {
            return None;
        }
        conns.open.get_mut(&id)?.remote = Some(kept);
    }
    client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .ok()?;
    Some((remote, buf))
}

/// Copy until `from` ends. True for an end (the other side said goodbye),
/// false for an error on either side.
fn copy<R: Read + ?Sized, W: Write + ?Sized>(from: &mut R, to: &mut W) -> bool {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) => return true,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    return false;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
}

/// Shut both sides of a connection, from either of its threads: the other
/// one's read ends.
fn sever(shared: &Shared, id: u64) {
    if let Some(c) = shared.conns.lock_ok().open.get(&id) {
        c.shut();
    }
}

/// The connection, both ways (module doc): the app's bytes to the box on
/// this thread, the box's to the app on a second one, which this one waits
/// for.
fn pump(
    shared: &Arc<Shared>,
    id: u64,
    mut client: TcpStream,
    mut remote: Box<dyn Remote>,
    early: &[u8],
) {
    // No timeout from here: an app that reads slowly is waited for, and
    // `stop` is what ends a connection that hangs.
    let _ = client.set_write_timeout(None);
    let _ = client.set_read_timeout(None);
    let (Ok(mut down_client), Ok(mut down_remote)) = (client.try_clone(), remote.another()) else {
        sever(shared, id);
        return;
    };
    let down = {
        let shared = Arc::clone(shared);
        std::thread::Builder::new()
            .name("proxy-down".into())
            .spawn(move || {
                if copy(&mut *down_remote, &mut down_client) {
                    let _ = down_client.shutdown(Shutdown::Write);
                } else {
                    sever(&shared, id);
                }
            })
    };
    let Ok(down) = down else {
        sever(shared, id);
        return;
    };
    if remote.write_all(early).is_ok() && copy(&mut client, &mut *remote) {
        remote.shutdown(Shutdown::Write);
    } else {
        sever(shared, id);
    }
    let _ = down.join();
}

/// No SIGPIPE from a write to a socket the app closed. Rust's start-up
/// ignores the signal in a Rust program; inside an app this library has no
/// start-up, and Apple's `send` has no `MSG_NOSIGNAL`, so the option is set
/// on every accepted socket (std sets it on the sockets it makes itself).
#[cfg(target_vendor = "apple")]
fn quiet(socket: &TcpStream) {
    use std::os::fd::AsRawFd;
    let one: libc::c_int = 1;
    // SAFETY: a live socket's descriptor, and an int's address and size
    // for an option that takes an int.
    unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            std::ptr::addr_of!(one).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
}

#[cfg(not(target_vendor = "apple"))]
fn quiet(_: &TcpStream) {}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use daedalus_core::tunnel::testbox::{self, noise};

    /// The port the box echoes on.
    const ECHO: u16 = 443;

    impl Remote for TcpStream {
        fn another(&self) -> io::Result<Box<dyn Remote>> {
            Ok(Box::new(self.try_clone()?))
        }

        fn shutdown(&self, how: Shutdown) {
            let _ = TcpStream::shutdown(self, how);
        }
    }

    /// A stand-in for the tunnel: every dial goes to a local listener, and
    /// says which port was asked for.
    struct Local {
        at: SocketAddr,
        asked: Mutex<Vec<u16>>,
    }

    impl Dial for Local {
        fn dial(&self, port: u16, within: Duration) -> Result<Box<dyn Remote>, String> {
            self.asked.lock_ok().push(port);
            TcpStream::connect_timeout(&self.at, within)
                .map(|s| Box::new(s) as Box<dyn Remote>)
                .map_err(|e| format!("the box did not answer\n({e})"))
        }
    }

    /// An echo on the loopback that closes its side when the client's is
    /// closed; its address.
    fn echo_server() -> SocketAddr {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let at = l.local_addr().unwrap();
        std::thread::spawn(move || {
            for s in l.incoming() {
                let Ok(mut s) = s else { return };
                std::thread::spawn(move || {
                    let mut w = s.try_clone().unwrap();
                    let _ = io::copy(&mut s, &mut w);
                    let _ = w.shutdown(Shutdown::Write);
                });
            }
        });
        at
    }

    fn local(at: SocketAddr) -> Arc<Local> {
        Arc::new(Local {
            at,
            asked: Mutex::new(Vec::new()),
        })
    }

    fn client(p: &Proxy) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", p.port())).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        s
    }

    fn basic(user: &str, pass: &str) -> String {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        format!("Proxy-Authorization: Basic {token}\r\n")
    }

    fn credential(p: &Proxy) -> String {
        basic(p.username(), p.password())
    }

    /// An answer's head: its status line and the rest of it, lowercased.
    fn answer(s: &mut TcpStream) -> (String, String) {
        let mut head = Vec::new();
        let mut one = [0u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            s.read_exact(&mut one).unwrap();
            head.push(one[0]);
        }
        let text = String::from_utf8(head).unwrap();
        let (status, rest) = text.split_once("\r\n").unwrap();
        (status.to_string(), rest.to_ascii_lowercase())
    }

    /// One request, its answer's status line, and everything after the
    /// answer's head until the proxy closes.
    fn refused(p: &Proxy, request: &str) -> (String, String) {
        let mut s = client(p);
        s.write_all(request.as_bytes()).unwrap();
        let (status, _) = answer(&mut s);
        let mut body = String::new();
        s.read_to_string(&mut body).unwrap();
        (status, body)
    }

    /// CONNECT with the credential; the stream once the proxy said 200.
    fn connected(p: &Proxy, authority: &str) -> TcpStream {
        let mut s = client(p);
        s.write_all(
            format!(
                "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{}\r\n",
                credential(p)
            )
            .as_bytes(),
        )
        .unwrap();
        let (status, _) = answer(&mut s);
        assert_eq!(status, "HTTP/1.1 200 Connection Established");
        s
    }

    /// Send `data` and the end of the stream; everything that comes back
    /// until the other side's end.
    fn round_trip(s: &TcpStream, data: &[u8]) -> Vec<u8> {
        let writer = {
            let (mut w, data) = (s.try_clone().unwrap(), data.to_vec());
            std::thread::spawn(move || {
                for c in data.chunks(7919) {
                    w.write_all(c).unwrap();
                }
                w.shutdown(Shutdown::Write).unwrap();
            })
        };
        let mut got = Vec::new();
        let mut r = s.try_clone().unwrap();
        r.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
        r.read_to_end(&mut got).unwrap();
        writer.join().unwrap();
        got
    }

    fn until(what: &str, f: impl Fn() -> bool) {
        let deadline = Deadline::after(Duration::from_secs(10));
        while !f() {
            assert!(!deadline.passed(), "never: {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_request_head_is_parsed_and_judged() {
        let h = parse(
            b"CONNECT box.example.org:443 HTTP/1.1\r\nHost: box.example.org:443\r\n\
              proxy-authorization:  Basic abc \r\n\r\n",
        )
        .unwrap();
        assert_eq!(h.method, "CONNECT");
        assert_eq!(h.target, "box.example.org:443");
        assert_eq!(h.authorization.as_deref(), Some("Basic abc"));
        assert!(!h.body);
        assert!(
            parse(b"POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\n")
                .unwrap()
                .body
        );
        assert!(
            !parse(b"CONNECT a:1 HTTP/1.0\r\nContent-Length: 0\r\n\r\n")
                .unwrap()
                .body
        );
        for bad in [
            &b"CONNECT a:1\r\n\r\n"[..],
            b"CONNECT a:1 HTTP/2\r\n\r\n",
            b"CONNECT  a:1 HTTP/1.1\r\n\r\n",
            b"CONNECT a:1 HTTP/1.1 x\r\n\r\n",
            b"CONNECT a:1 HTTP/1.1\r\nno colon\r\n\r\n",
            b"\xff\xfe a:1 HTTP/1.1\r\n\r\n",
            b"\r\n\r\n",
        ] {
            assert_eq!(parse(bad), None, "{:?}", String::from_utf8_lossy(bad));
        }
    }

    #[test]
    fn the_proxy_wants_its_credential_and_connect_to_its_one_port() {
        let up = local(echo_server());
        let p = Proxy::start(up.clone(), 443).unwrap();
        assert!(p.running());
        assert_eq!(p.username().len(), 32);
        assert_eq!(p.password().len(), 32);
        assert_ne!(p.username(), p.password());
        let cred = credential(&p);

        // No credential: challenged, and the same connection takes the
        // retry — a client that sends it only once asked.
        let mut s = client(&p);
        s.write_all(b"CONNECT box.example.org:443 HTTP/1.1\r\nHost: box.example.org:443\r\n\r\n")
            .unwrap();
        let (status, headers) = answer(&mut s);
        assert_eq!(status, "HTTP/1.1 407 Proxy Authentication Required");
        assert!(headers.contains("proxy-authenticate: basic realm=\"daedalus\"\r\n"));
        assert!(headers.contains("content-length: 0\r\n"));
        assert!(!headers.contains("connection: close"));
        s.write_all(format!("CONNECT box.example.org:443 HTTP/1.1\r\n{cred}\r\n").as_bytes())
            .unwrap();
        assert_eq!(answer(&mut s).0, "HTTP/1.1 200 Connection Established");
        s.write_all(b"ping").unwrap();
        let mut four = [0u8; 4];
        s.read_exact(&mut four).unwrap();
        assert_eq!(&four, b"ping");
        drop(s);

        // Asked twice without it: the second answer closes.
        let mut s = client(&p);
        let bare = "CONNECT a:443 HTTP/1.1\r\n\r\n";
        s.write_all(bare.as_bytes()).unwrap();
        assert!(answer(&mut s).0.contains(" 407 "));
        s.write_all(bare.as_bytes()).unwrap();
        let (status, headers) = answer(&mut s);
        assert!(status.contains(" 407 "));
        assert!(headers.contains("connection: close"));
        assert_eq!(s.read(&mut four).unwrap(), 0, "closed");

        // A wrong credential, a wrong scheme, the right one for another
        // port, another method: refused, with why, and closed.
        for (request, status, why) in [
            (
                format!(
                    "CONNECT a:443 HTTP/1.1\r\n{}\r\n",
                    basic(p.username(), "wrong")
                ),
                "403 Forbidden",
                "credential is wrong",
            ),
            (
                format!(
                    "CONNECT a:443 HTTP/1.1\r\n{}\r\n",
                    basic(p.password(), p.username())
                ),
                "403 Forbidden",
                "credential is wrong",
            ),
            (
                "CONNECT a:443 HTTP/1.1\r\nProxy-Authorization: Bearer x\r\n\r\n".into(),
                "403 Forbidden",
                "credential is wrong",
            ),
            (
                "CONNECT a:443 HTTP/1.1\r\nProxy-Authorization: Basic !!!\r\n\r\n".into(),
                "403 Forbidden",
                "credential is wrong",
            ),
            (
                format!("CONNECT a:22 HTTP/1.1\r\n{cred}\r\n"),
                "403 Forbidden",
                "port 443 alone",
            ),
            (
                format!("CONNECT a HTTP/1.1\r\n{cred}\r\n"),
                "403 Forbidden",
                "port 443 alone",
            ),
            (
                format!("GET http://a:443/ HTTP/1.1\r\n{cred}\r\n"),
                "405 Method Not Allowed",
                "CONNECT alone",
            ),
            (
                "NONSENSE\r\n\r\n".into(),
                "400 Bad Request",
                "not an HTTP/1.1 request",
            ),
            (
                format!(
                    "CONNECT a:443 HTTP/1.1\r\nX-Pad: {}\r\n{cred}\r\n",
                    "x".repeat(HEAD_CAP)
                ),
                "431 Request Header Fields Too Large",
                "too long",
            ),
        ] {
            let (got, body) = refused(&p, &request);
            assert_eq!(got, format!("HTTP/1.1 {status}"));
            assert!(body.contains(why), "{body}");
            assert_eq!(body.lines().count(), 1, "{body:?}");
        }

        // The host is not looked at: every dial is the tunnel's, to the
        // one port (the only ones made so far are the first test's and
        // these).
        for authority in ["192.0.2.9:443", "[2001:db8::1]:443", "localhost:443"] {
            let s = connected(&p, authority);
            assert_eq!(round_trip(&s, b"hello"), b"hello");
        }
        assert_eq!(*up.asked.lock_ok(), vec![443; 4]);
        until("the connections are over", || p.connections() == 0);
        p.stop();
        assert!(!p.running());
    }

    #[test]
    fn a_megabyte_goes_both_ways_and_each_side_ends_its_own() {
        let p = Proxy::start(local(echo_server()), 8443).unwrap();
        // The bytes right behind the head, in the same write: the box gets
        // them first.
        let mut s = client(&p);
        s.write_all(
            format!("CONNECT box:8443 HTTP/1.1\r\n{}\r\nearly ", credential(&p)).as_bytes(),
        )
        .unwrap();
        assert!(answer(&mut s).0.contains(" 200 "));
        assert_eq!(p.connections(), 1);
        let data = noise(1 << 20);
        let got = round_trip(&s, &data);
        assert_eq!(&got[..6], b"early ");
        assert!(got[6..] == data, "the bytes came back changed");
        // Both sides said goodbye: the connection and its threads are over
        // without the app closing its socket.
        until("the connection is over", || {
            p.shared.conns.lock_ok().open.is_empty()
        });
        until("its thread ended", || {
            p.shared
                .conns
                .lock_ok()
                .threads
                .iter()
                .all(JoinHandle::is_finished)
        });
        drop(s);

        // The app's side closed outright, mid-conversation: over as well.
        let mut s = connected(&p, "box:8443");
        s.write_all(b"half a thought").unwrap();
        drop(s);
        until("the connection is over", || {
            p.shared.conns.lock_ok().open.is_empty()
        });
    }

    #[test]
    fn a_box_that_does_not_answer_is_a_502_and_a_slow_head_is_cut() {
        // Nothing listens where the stand-in dials.
        let nowhere = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let limits = Limits {
            head: Duration::from_millis(300),
            dial: Duration::from_secs(2),
            connections: MAX_CONNECTIONS,
        };
        let p = Proxy::start_with(local(nowhere), 443, limits).unwrap();
        let (status, body) = refused(
            &p,
            &format!("CONNECT box:443 HTTP/1.1\r\n{}\r\n", credential(&p)),
        );
        assert_eq!(status, "HTTP/1.1 502 Bad Gateway");
        assert!(body.starts_with("the box did not answer ("), "{body}");
        assert_eq!(body.lines().count(), 1, "one line: {body:?}");

        // A head that trickles: cut at the deadline, however the bytes
        // keep coming.
        let started = std::time::Instant::now();
        let mut s = client(&p);
        s.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
        let mut one = [0u8; 1];
        let cut = (0..60).any(|_| {
            s.write_all(b"C").is_err()
                || match s.read(&mut one) {
                    Ok(n) => n == 0,
                    Err(e) => !matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ),
                }
        });
        assert!(cut, "a trickling head was never cut");
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(250) && took < Duration::from_secs(3),
            "{took:?}"
        );
        until("the slow connection is forgotten", || {
            p.shared.conns.lock_ok().open.is_empty()
        });
    }

    #[test]
    fn two_connections_at_once_and_no_more_when_that_is_the_limit() {
        let limits = Limits {
            connections: 2,
            ..Limits::default()
        };
        let p = Proxy::start_with(local(echo_server()), 443, limits).unwrap();
        let a = connected(&p, "box:443");
        let b = client(&p); // no request yet: counted all the same
        until("both are being served", || {
            p.shared.conns.lock_ok().open.len() == 2
        });
        assert_eq!(p.connections(), 1);
        let (status, body) = refused(&p, "CONNECT box:443 HTTP/1.1\r\n\r\n");
        assert_eq!(status, "HTTP/1.1 503 Service Unavailable");
        assert!(body.contains("too many connections"));
        // One ends: there is room again.
        drop(b);
        until("one is over", || p.shared.conns.lock_ok().open.len() == 1);
        let c = connected(&p, "box:443");
        assert_eq!(round_trip(&c, b"room"), b"room");
        drop(a);
    }

    #[test]
    fn stopping_ends_every_connection_and_every_thread() {
        let p = Proxy::start(local(echo_server()), 443).unwrap();
        let mut open = connected(&p, "box:443");
        let mut waiting = client(&p); // no request yet
        open.write_all(b"x").unwrap();
        let mut one = [0u8; 1];
        open.read_exact(&mut one).unwrap();
        until("both are being served", || {
            p.shared.conns.lock_ok().open.len() == 2
        });
        p.stop();
        // `stop` came back: every thread is joined. The app's sockets see
        // the end, and nothing listens any more.
        assert!(p.shared.conns.lock_ok().threads.is_empty());
        assert!(p.shared.conns.lock_ok().open.is_empty());
        assert!(matches!(open.read(&mut one), Ok(0) | Err(_)));
        assert!(matches!(waiting.read(&mut one), Ok(0) | Err(_)));
        assert!(TcpStream::connect(("127.0.0.1", p.port())).is_err());
        assert!(!p.running());
        p.stop();
    }

    /// The whole of it: the app's side of a CONNECT, this proxy, the
    /// tunnel, WireGuard over UDP, and a box in this process (the shared
    /// crate's testbox) echoing at its LAN address.
    #[test]
    fn a_connect_reaches_the_box_through_the_tunnel() {
        let device = testbox::machine();
        let b = testbox::spawn_box(&device, ECHO, 0);
        let t = testbox::tunnel(&device, &b);
        let p = Proxy::start(t.clone(), ECHO).unwrap();

        // More than the tunnel's TCP buffer each way, then the app's end:
        // the box echoes all of it and closes its side.
        let s = connected(&p, "daedalus.example.org:443");
        assert_eq!(p.connections(), 1);
        let data = noise(1 << 20);
        assert!(data.len() > daedalus_core::tunnel::TCP_BUFFER);
        assert!(round_trip(&s, &data) == data, "the bytes came back changed");
        let st = t.status();
        assert!(st.last_handshake_secs.is_some(), "{st:?}");
        assert!(st.tx_bytes >= 1 << 20 && st.rx_bytes >= 1 << 20, "{st:?}");
        assert_eq!(st.resolved.as_deref(), Some(b.addr.to_string().as_str()));
        assert_eq!(st.error, None);
        until("the connection is over", || p.connections() == 0);
        drop(s);

        // Several at once, each its own conversation.
        let streams: Vec<TcpStream> = (0..4).map(|_| connected(&p, "box:443")).collect();
        let threads: Vec<_> = streams
            .into_iter()
            .map(|s| {
                std::thread::spawn(move || {
                    let data = noise(300 << 10);
                    assert!(round_trip(&s, &data) == data);
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }

        // The tunnel stops under an open connection: the app sees its end,
        // the next CONNECT is a 502 that says so, and the proxy stops
        // without waiting for anything.
        let mut s = connected(&p, "box:443");
        s.write_all(b"k").unwrap();
        let mut one = [0u8; 1];
        s.read_exact(&mut one).unwrap();
        t.stop();
        assert!(matches!(s.read(&mut one), Ok(0) | Err(_)));
        let (status, body) = refused(
            &p,
            &format!("CONNECT box:443 HTTP/1.1\r\n{}\r\n", credential(&p)),
        );
        assert_eq!(status, "HTTP/1.1 502 Bad Gateway");
        assert!(body.contains("the tunnel stopped"), "{body}");
        let started = std::time::Instant::now();
        p.stop();
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_port_nothing_listens_on_at_the_box_is_a_502() {
        let device = testbox::machine();
        let b = testbox::spawn_box(&device, ECHO, 0);
        let t = testbox::tunnel(&device, &b);
        let p = Proxy::start(t.clone(), 9).unwrap();
        let (status, body) = refused(
            &p,
            &format!("CONNECT box:9 HTTP/1.1\r\n{}\r\n", credential(&p)),
        );
        assert_eq!(status, "HTTP/1.1 502 Bad Gateway");
        assert!(body.contains("refused the connection"), "{body}");
        assert_eq!(p.connections(), 0);
    }
}
