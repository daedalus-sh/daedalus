//! The tunnel against a box in the same process (testbox.rs).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::x25519::StaticSecret;

use super::testbox::{config, echo, noise, spawn_box, tunnel, BOX};
use super::*;
use crate::net::Dialer;

const ECHO: u16 = 7788;

#[test]
fn four_mib_go_through_the_tunnel_and_back_whole() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, ECHO, 0);
    let t = tunnel(&machine, &b);
    let s = t.connect(ECHO, Duration::from_secs(10)).unwrap();
    assert_eq!(s.peer_addr(), SocketAddr::from((BOX, ECHO)));
    let data = noise(4 << 20);
    assert!(echo(&s, &data) == data, "the bytes came back changed");
    let st = t.status();
    assert!(st.last_handshake_secs.is_some(), "{st:?}");
    assert!(st.tx_bytes >= 4 << 20 && st.rx_bytes >= 4 << 20, "{st:?}");
    assert_eq!(st.resolved.as_deref(), Some(b.addr.to_string().as_str()));
    assert_eq!(st.error, None);

    // A keystroke waits for nobody: the round trip is the loopback's, not
    // the thread's tick.
    let mut w = s.clone();
    let mut r = s.clone();
    let started = Instant::now();
    for _ in 0..20 {
        w.write_all(b"k").unwrap();
        let mut one = [0u8; 1];
        r.read_exact(&mut one).unwrap();
    }
    let each = started.elapsed() / 20;
    assert!(each < Duration::from_millis(20), "{each:?} a round trip");

    // The machine's end: its half-close reaches the box, whose close comes
    // back as the end of the stream.
    s.shutdown(std::net::Shutdown::Write).unwrap();
    let mut rest = Vec::new();
    r.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    r.read_to_end(&mut rest).unwrap();
    assert!(rest.is_empty());
}

#[test]
fn the_tunnel_carries_on_through_loss() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, ECHO, 3);
    let t = tunnel(&machine, &b);
    let s = t.connect(ECHO, Duration::from_secs(20)).unwrap();
    let data = noise(256 << 10);
    assert!(echo(&s, &data) == data, "the bytes came back changed");
}

#[test]
fn the_dialer_reaches_the_box_alone_and_a_silent_box_fails_in_time() {
    let machine = StaticSecret::random_from_rng(rand_core::OsRng);
    let b = spawn_box(&machine, ECHO, 0);
    let t = tunnel(&machine, &b);
    assert_eq!(t.target(), BOX);
    // A port nothing listens on at the box: refused, at once.
    let e = t.connect(9, Duration::from_secs(10)).err().unwrap();
    assert!(e.contains("refused"), "{e}");
    // The dialer goes to the box at the port asked for, whatever the host
    // part names — the controller's address from the log-in, the session
    // host's name from the policy; it resolves nothing and reaches nothing
    // else.
    let d = Dialer::Tunnel(Arc::clone(&t));
    assert!(d.tunnelled());
    for through in ["192.168.0.2:7788", "box.example.org:7788", "192.0.2.1:7788"] {
        let s = d.connect(through, Duration::from_secs(10)).unwrap();
        assert_eq!(s.peer_addr().unwrap(), SocketAddr::from((BOX, ECHO)));
    }
    assert!(d
        .connect("box.example.org", Duration::from_secs(1))
        .is_err());
    // Stopped: every stream fails, and nothing more is dialled.
    let mut s = t.connect(ECHO, Duration::from_secs(10)).unwrap();
    t.stop();
    assert!(s.write_all(b"x").is_err());
    assert!(t.connect(ECHO, Duration::from_secs(1)).is_err());

    // A box that never answers: an error within the deadline that says the
    // handshake never happened.
    let silent = UdpSocket::bind("127.0.0.1:0").unwrap();
    let mut quiet = config(&machine, &b);
    quiet.endpoint = silent.local_addr().unwrap().to_string();
    let t = Tunnel::start(quiet.checked().unwrap()).unwrap();
    let started = Instant::now();
    let e = t.connect(ECHO, Duration::from_secs(2)).err().unwrap();
    assert!(started.elapsed() < Duration::from_secs(4));
    assert!(e.contains("no WireGuard handshake"), "{e}");
}

#[test]
fn the_client_config_is_checked() {
    let key = wg_key(&[9; 32]);
    let good = WireguardConfig {
        private_key: key.clone(),
        address: "10.8.0.2/32".into(),
        server_public_key: key.clone(),
        preshared_key: Some(key.clone()),
        endpoint: "box.example.org:51820".into(),
        allowed_ips: vec!["192.168.0.2/32".into()],
    };
    let s = good.checked().unwrap();
    assert_eq!(s.address, Ipv4Addr::new(10, 8, 0, 2));
    assert_eq!(s.target, BOX);
    assert!(format!("{s:?}").contains("Secret(…)"), "keys never print");
    let bad = |f: &dyn Fn(&mut WireguardConfig)| {
        let mut c = good.clone();
        f(&mut c);
        c.checked().is_err()
    };
    assert!(bad(&|c| c.private_key = "short".into()));
    assert!(bad(&|c| c.server_public_key = "AAAA".into()));
    assert!(bad(&|c| c.preshared_key = Some("x".into())));
    assert!(bad(&|c| c.address = "not-an-address".into()));
    assert!(bad(&|c| c.endpoint = "box.example.org".into()));
    assert!(bad(&|c| c.endpoint = "$(x):1".into()));
    // AllowedIPs: the box alone, one /32 — never a route to the LAN or the
    // internet, and never this machine.
    assert!(bad(&|c| c.allowed_ips = vec!["0.0.0.0/0".into()]));
    assert!(bad(&|c| c.allowed_ips = vec!["192.168.0.0/24".into()]));
    assert!(bad(&|c| c.allowed_ips = vec![]));
    assert!(bad(
        &|c| c.allowed_ips = vec!["192.168.0.2/32".into(), "10.8.0.1/32".into()]
    ));
    assert!(bad(&|c| c.allowed_ips = vec!["10.8.0.2/32".into()]));
    assert!(bad(&|c| c.allowed_ips = vec!["::1/128".into()]));
    let mut no_psk = good.clone();
    no_psk.preshared_key = None;
    assert!(no_psk.checked().is_ok());
}
