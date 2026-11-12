//! A box in the same process, for tests: boringtun as the box's responder
//! and smoltcp with an echo server behind it — a second, independent
//! WireGuard end, so the machine's side cannot be wrong the same way at
//! both ends. (The box's kernel WireGuard is the end-to-end's,
//! agent/e2e-tunnel.sh.) Behind the `testing` feature for the crates that
//! build on the tunnel (ios/core's proxy).

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use boringtun::noise::{Tunn, TunnResult};
use boringtun::x25519::{PublicKey, StaticSecret};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::socket::tcp;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};

use super::core::Queue;
use super::{wg_key, Stream, Tunnel, WireguardConfig};

/// The box's LAN address, the client's one AllowedIPs; the machine in
/// wg-easy's network.
pub const BOX: Ipv4Addr = Ipv4Addr::new(192, 168, 0, 2);
pub const MACHINE: &str = "10.8.0.2/32";

/// A box: a UDP socket, boringtun answering the machine's key with a
/// preshared key as wg-easy does, smoltcp at the box's LAN address echoing
/// every connection to its port — and closing its side once the machine's
/// is closed and everything is echoed — dropping `loss` percent of the
/// datagrams each way.
pub struct TestBox {
    pub addr: SocketAddr,
    pub public: [u8; 32],
    pub psk: [u8; 32],
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for TestBox {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn listener(port: u16) -> tcp::Socket<'static> {
    let mut s = tcp::Socket::new(
        tcp::SocketBuffer::new(vec![0; 64 * 1024]),
        tcp::SocketBuffer::new(vec![0; 64 * 1024]),
    );
    s.listen(port).unwrap();
    s
}

/// A box for `machine`'s key, echoing on `port`.
pub fn spawn_box(machine: &StaticSecret, port: u16, loss: u32) -> TestBox {
    let secret = StaticSecret::random_from_rng(rand_core::OsRng);
    let public = *PublicKey::from(&secret).as_bytes();
    let mut psk = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut psk);
    let udp = UdpSocket::bind("127.0.0.1:0").unwrap();
    let addr = udp.local_addr().unwrap();
    let mut tunn = Tunn::new(secret, PublicKey::from(machine), Some(psk), None, 7, None);
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || {
            udp.set_read_timeout(Some(Duration::from_millis(2)))
                .unwrap();
            let epoch = Instant::now();
            let now = || smoltcp::time::Instant::from_micros(epoch.elapsed().as_micros() as i64);
            let mut q = Queue::default();
            let mut iface = Interface::new(Config::new(HardwareAddress::Ip), &mut q, now());
            iface.update_ip_addrs(|a| {
                a.push(IpCidr::new(IpAddress::Ipv4(BOX), 32)).unwrap();
            });
            iface.routes_mut().add_default_ipv4_route(BOX).unwrap();
            let mut sockets = SocketSet::new(Vec::new());
            let mut handles: Vec<(SocketHandle, VecDeque<u8>)> =
                vec![(sockets.add(listener(port)), VecDeque::new())];
            let mut peer: Option<SocketAddr> = None;
            let (mut buf, mut out) = (vec![0u8; 2048], vec![0u8; 2048]);
            let mut chunk = vec![0u8; 16 * 1024];
            let mut seed: u32 = 12345;
            let mut lost = move || {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) % 100 < loss
            };
            while !stop.load(Ordering::SeqCst) {
                if let Ok((n, from)) = udp.recv_from(&mut buf) {
                    if !lost() {
                        peer = Some(from);
                        let mut input = &buf[..n];
                        loop {
                            match tunn.decapsulate(Some(from.ip()), input, &mut out) {
                                TunnResult::WriteToNetwork(d) => {
                                    let _ = udp.send_to(d, from);
                                    input = &[];
                                    continue;
                                }
                                TunnResult::WriteToTunnelV4(p, _) => q.rx.push_back(p.to_vec()),
                                _ => {}
                            }
                            break;
                        }
                    }
                }
                if let (TunnResult::WriteToNetwork(d), Some(p)) =
                    (tunn.update_timers(&mut out), peer)
                {
                    let _ = udp.send_to(d, p);
                }
                iface.poll(now(), &mut q, &mut sockets);
                // The echo reads everything that arrives, whether or not its
                // send buffer has room, as the kernel at the real box does:
                // smoltcp drops the ACK riding a segment outside a closed
                // receive window, so an echo that stopped reading until its
                // sends were acknowledged would wait for ACKs it throws away
                // (the machine's end gives up after TCP_TIMEOUT).
                for (h, pending) in &mut handles {
                    let s = sockets.get_mut::<tcp::Socket>(*h);
                    while s.can_recv() {
                        let n = s.recv_slice(&mut chunk).unwrap();
                        pending.extend(&chunk[..n]);
                    }
                    while !pending.is_empty() && s.can_send() {
                        let n = s.send_slice(pending.as_slices().0).unwrap();
                        pending.drain(..n);
                    }
                    if s.state() == tcp::State::CloseWait && pending.is_empty() {
                        s.close();
                    }
                }
                // Always one socket listening for the next connection.
                if handles
                    .iter()
                    .all(|(h, _)| sockets.get::<tcp::Socket>(*h).state() != tcp::State::Listen)
                {
                    handles.push((sockets.add(listener(port)), VecDeque::new()));
                }
                iface.poll(now(), &mut q, &mut sockets);
                while let Some(packet) = q.tx.pop_front() {
                    if let (TunnResult::WriteToNetwork(d), Some(p)) =
                        (tunn.encapsulate(&packet, &mut out), peer)
                    {
                        if !lost() {
                            let _ = udp.send_to(d, p);
                        }
                    }
                }
            }
        })
    };
    TestBox {
        addr,
        public,
        psk,
        stop,
        thread: Some(thread),
    }
}

/// The client config wg-easy would hand the machine for this box.
pub fn config(machine: &StaticSecret, b: &TestBox) -> WireguardConfig {
    WireguardConfig {
        private_key: wg_key(machine.as_bytes()),
        address: MACHINE.into(),
        server_public_key: wg_key(&b.public),
        preshared_key: Some(wg_key(&b.psk)),
        endpoint: b.addr.to_string(),
        allowed_ips: vec![format!("{BOX}/32")],
    }
}

pub fn tunnel(machine: &StaticSecret, b: &TestBox) -> Arc<Tunnel> {
    Tunnel::start(config(machine, b).checked().unwrap()).unwrap()
}

/// A new machine key.
pub fn machine() -> StaticSecret {
    StaticSecret::random_from_rng(rand_core::OsRng)
}

pub fn noise(n: usize) -> Vec<u8> {
    let mut v = vec![0u8; n];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut v);
    v
}

/// Echo `data` through `s` in odd-sized writes, reading it all back.
pub fn echo(s: &Stream, data: &[u8]) -> Vec<u8> {
    let writer = {
        let (mut w, data) = (s.clone(), data.to_vec());
        std::thread::spawn(move || {
            for c in data.chunks(7919) {
                w.write_all(c).unwrap();
            }
        })
    };
    let mut r = s.clone();
    r.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let mut got = vec![0u8; data.len()];
    r.read_exact(&mut got).unwrap();
    writer.join().unwrap();
    got
}
