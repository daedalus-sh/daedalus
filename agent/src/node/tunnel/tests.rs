//! The tunnel's file, and the end-to-end against a real wg-easy. The
//! tunnel's own tests — against a box in the same process — are the shared
//! crate's (core/src/tunnel/tests.rs).

use std::path::Path;
use std::time::Duration;

use super::*;
use daedalus_core::tunnel::testbox::{echo, noise};

#[test]
fn the_client_config_is_kept_private() {
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
    let dir = std::env::temp_dir().join(format!("daedalus-tunnel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tunnel.toml");
    assert_eq!(load_at(&path).unwrap(), None);
    write_at(&good, &path).unwrap();
    assert_eq!(load_at(&path).unwrap(), Some(s));
    use std::os::unix::fs::PermissionsExt;
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    // Readable by others: refused, as the identity key is.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(load_at(&path).is_err());
    // A file that does not parse is an error, never "no tunnel".
    std::fs::write(&path, "address = 1\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert!(load_at(&path).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// The end-to-end's half (agent/e2e-tunnel.sh): this tunnel against a real
/// wg-easy — the kernel's WireGuard — with the client config wg-easy made
/// for it through its API, the per-client firewall on. `E2E_TUNNEL` is that
/// config as `tunnel.toml`; `E2E_EXPECT` is `open` (the link's and the
/// session host's ports echo, any other port of the box is dropped) or
/// `gone` (the client was deleted: no handshake).
#[test]
#[ignore = "agent/e2e-tunnel.sh runs it, against a wg-easy container"]
fn e2e_against_wg_easy() {
    let path = std::env::var("E2E_TUNNEL").expect("E2E_TUNNEL names the client config");
    let settings = load_at(Path::new(&path))
        .unwrap()
        .expect("the client config is there");
    let t = Tunnel::start(settings).unwrap();
    match std::env::var("E2E_EXPECT").as_deref() {
        Ok("open") => {
            for port in [7788, 7789] {
                let s = t.connect(port, Duration::from_secs(15)).unwrap();
                let data = noise(1 << 20);
                assert!(
                    echo(&s, &data) == data,
                    "port {port}: the bytes came back changed"
                );
            }
            let e = t.connect(2222, Duration::from_secs(5)).err().unwrap();
            assert!(
                !e.contains("refused"),
                "the firewall let port 2222 through: {e}"
            );
            println!("E2E_TUNNEL_OPEN_OK {:?}", t.status());
        }
        Ok("gone") => {
            let e = t.connect(7788, Duration::from_secs(8)).err().unwrap();
            assert!(e.contains("no WireGuard handshake"), "{e}");
            println!("E2E_TUNNEL_GONE_OK");
        }
        other => panic!("E2E_EXPECT is open or gone, not {other:?}"),
    }
}
