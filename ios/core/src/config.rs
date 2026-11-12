//! The config the app passes to `daedalus_start`, as JSON:
//!
//! ```json
//! {
//!   "wireguard": {
//!     "private_key": "<44 characters of base64>",
//!     "address": "10.8.0.7/24",
//!     "server_public_key": "<44 characters of base64>",
//!     "preshared_key": "<44 characters of base64>",
//!     "endpoint": "box.example.org:51820",
//!     "allowed_ips": ["192.168.0.2/32"]
//!   },
//!   "proxy_port": 443,
//!   "node": {
//!     "seed": "<64 hex>",
//!     "controller": {"pin": "<fingerprint>", "address": "192.168.0.2:7788"},
//!     "hello": {
//!       "hostname": "Santiago’s iPhone", "os": "ios", "arch": "arm64",
//!       "agent_version": "1.0.0", "model": "iPhone17,1",
//!       "os_name": "iOS", "os_version": "27.0"
//!     }
//!   }
//! }
//! ```
//!
//! `wireguard` is the wg-easy client config, the shared crate's
//! `WireguardConfig` (`preshared_key` optional), checked as an agent checks
//! its own. `proxy_port` is the one TCP port at the box the proxy dials.
//! `node` is null — or absent — before the device is paired: the tunnel and
//! the proxy run alone. With it the device is a light node: `seed` is its
//! identity key (`daedalus_identity_new`), `controller` where the
//! controller's link answers INSIDE the tunnel — the box's LAN address, the
//! tunnel's AllowedIPs — and the fingerprint of the key it must prove, and
//! `hello` what the device says of itself (`os` is "ios" or "ipados";
//! `os_name` and `os_version` are optional).

use serde::Deserialize;
use zeroize::Zeroizing;

use daedalus_core::identity::{parse_fingerprint, Identity};
use daedalus_core::link::wire::{Capability, Hello, HelloFacts, TelemetryLevel};
use daedalus_core::tunnel::{Settings, WireguardConfig};
use daedalus_core::util::valid_host_port;

/// The app's config, unchecked. Its keys are wiped from memory when it is
/// dropped (`WireguardConfig`, `NodeConfig`), and it is never printed.
#[derive(Deserialize)]
pub struct Config {
    pub wireguard: WireguardConfig,
    /// The one TCP port at the box the proxy dials; not 0.
    pub proxy_port: u16,
    #[serde(default)]
    pub node: Option<NodeConfig>,
}

#[derive(Deserialize)]
pub struct NodeConfig {
    /// The identity key's seed, 64 hex characters.
    pub seed: String,
    pub controller: ControllerConfig,
    pub hello: HelloConfig,
}

impl Drop for NodeConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.seed.zeroize();
    }
}

#[derive(Deserialize)]
pub struct ControllerConfig {
    /// The controller key's fingerprint (SHA-256, hex, grouped or not).
    pub pin: String,
    /// `a.b.c.d:port`: the box's LAN address and the link's port.
    pub address: String,
}

#[derive(Deserialize)]
pub struct HelloConfig {
    /// The device's name.
    pub hostname: String,
    /// "ios" or "ipados".
    pub os: String,
    pub arch: String,
    /// The app's version.
    pub agent_version: String,
    /// The model identifier ("iPhone17,1").
    pub model: String,
    #[serde(default)]
    pub os_name: Option<String>,
    #[serde(default)]
    pub os_version: Option<String>,
}

/// A config that checked.
pub struct Checked {
    pub settings: Settings,
    pub proxy_port: u16,
    pub node: Option<CheckedNode>,
}

/// The node half, checked: who the device is, whom it trusts, what it says.
pub struct CheckedNode {
    pub identity: Identity,
    /// The SHA-256 of the controller's key.
    pub pin: [u8; 32],
    pub address: String,
    pub hello: Hello,
}

impl Config {
    /// The JSON above. An error names what is wrong and never quotes the
    /// text (it holds the keys).
    pub fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| {
            use serde_json::error::Category;
            let what = match e.classify() {
                Category::Data => "a field is missing or of the wrong type",
                Category::Eof => "it ends early",
                Category::Syntax | Category::Io => "it is not JSON",
            };
            format!(
                "the config: {what} (line {}, column {})",
                e.line(),
                e.column()
            )
        })
    }

    /// Every field checked: the tunnel's as the shared crate checks them
    /// (`WireguardConfig::checked`), the port not 0, and the node's — the
    /// seed 32 bytes of hex, the pin a fingerprint, the controller's address
    /// the tunnel's own target, the hello within the link's bounds.
    pub fn checked(&self) -> Result<Checked, String> {
        let settings = self.wireguard.checked()?;
        if self.proxy_port == 0 {
            return Err("proxy_port is 0".into());
        }
        let node = match &self.node {
            None => None,
            Some(n) => Some(n.checked(&settings)?),
        };
        Ok(Checked {
            settings,
            proxy_port: self.proxy_port,
            node,
        })
    }
}

/// An identity from its seed as hex; the error never quotes it.
pub fn identity_of(seed_hex: &str) -> Result<Identity, String> {
    let mut seed = Zeroizing::new([0u8; 32]);
    if seed_hex.len() != 64 || hex::decode_to_slice(seed_hex, &mut *seed).is_err() {
        return Err("the seed is not 64 hex characters".into());
    }
    Ok(Identity::from_seed(*seed))
}

impl NodeConfig {
    fn checked(&self, tunnel: &Settings) -> Result<CheckedNode, String> {
        let identity = identity_of(&self.seed)?;
        let pin =
            parse_fingerprint(&self.controller.pin).map_err(|e| format!("controller.pin: {e}"))?;
        let address = self.controller.address.trim();
        if address.len() > 255 || !valid_host_port(address) {
            return Err(format!("controller.address {address:?} is not host:port"));
        }
        // Through the tunnel every dial goes to its one target whatever the
        // host says (net.rs); an address that names another machine is a
        // pairing gone wrong, said here rather than hidden there.
        let host = address.rsplit_once(':').map_or(address, |(h, _)| h);
        if host.parse::<std::net::Ipv4Addr>() != Ok(tunnel.target) {
            return Err(format!(
                "controller.address {address:?} is not the tunnel's ({})",
                tunnel.target
            ));
        }
        let h = &self.hello;
        if !matches!(h.os.as_str(), "ios" | "ipados") {
            return Err(format!("hello.os {:?} is not ios or ipados", h.os));
        }
        let hello = Hello {
            agent_version: h.agent_version.clone(),
            os: h.os.clone(),
            arch: h.arch.clone(),
            hostname: h.hostname.trim().to_string(),
            facts: HelloFacts {
                os_name: h.os_name.clone().unwrap_or_default(),
                os_version: h.os_version.clone().unwrap_or_default(),
                model: Some(h.model.clone()),
                ..HelloFacts::default()
            },
            // What a light node offers: its telemetry, at the level of a
            // machine that reads no slow facts.
            capabilities: vec![Capability::TelemetryMinimal],
            telemetry: TelemetryLevel::Minimal,
            ..Hello::default()
        };
        // The link's own bounds (`Hello::check`), with this key's node id
        // as the link will set it.
        Hello {
            node_id: identity.node_id(),
            ..hello.clone()
        }
        .check()
        .map_err(|e| format!("hello: {e}"))?;
        Ok(CheckedNode {
            identity,
            pin,
            address: address.to_string(),
            hello,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use daedalus_core::tunnel::wg_key;

    pub(crate) fn json(node: &str) -> String {
        let key = wg_key(&[9; 32]);
        format!(
            r#"{{"wireguard":{{"private_key":"{key}","address":"10.8.0.2/24","server_public_key":"{key}",
                "preshared_key":"{key}","endpoint":"box.example.org:51820",
                "allowed_ips":["192.168.0.2/32"]}},"proxy_port":443,"node":{node}}}"#
        )
    }

    pub(crate) fn node(seed: &str, pin: &str, address: &str, os: &str) -> String {
        format!(
            r#"{{"seed":"{seed}","controller":{{"pin":"{pin}","address":"{address}"}},
                "hello":{{"hostname":"Santiago’s iPhone","os":"{os}","arch":"arm64",
                "agent_version":"1.0.0","model":"iPhone17,1","os_version":"27.0"}}}}"#
        )
    }

    fn checked(json: &str) -> Result<Checked, String> {
        Config::from_json(json)?.checked()
    }

    #[test]
    fn the_tunnel_alone_or_with_a_node() {
        let c = checked(&json("null")).unwrap();
        assert_eq!(c.settings.target, std::net::Ipv4Addr::new(192, 168, 0, 2));
        assert_eq!(c.proxy_port, 443);
        assert!(c.node.is_none());
        // `node` absent is `node` null.
        assert!(checked(&json("null").replace(r#","node":null"#, ""))
            .unwrap()
            .node
            .is_none());

        let me = Identity::from_seed([7; 32]);
        let seed = hex::encode(*me.seed());
        let ctl = Identity::from_seed([8; 32]).fingerprint();
        let good = |os: &str| json(&node(&seed, &ctl, "192.168.0.2:7788", os));
        let n = checked(&good("ios")).unwrap().node.unwrap();
        assert_eq!(n.identity.node_id(), me.node_id());
        assert_eq!(n.pin, parse_fingerprint(&ctl).unwrap());
        assert_eq!(n.address, "192.168.0.2:7788");
        assert_eq!(n.hello.os, "ios");
        assert_eq!(n.hello.hostname, "Santiago’s iPhone");
        assert_eq!(n.hello.agent_version, "1.0.0");
        assert_eq!(n.hello.facts.model.as_deref(), Some("iPhone17,1"));
        assert_eq!(n.hello.facts.os_version, "27.0");
        assert_eq!(n.hello.capabilities, [Capability::TelemetryMinimal]);
        assert!(checked(&good("ipados")).is_ok());
    }

    #[test]
    fn what_does_not_check_is_refused_and_its_error_quotes_no_key() {
        let me = Identity::from_seed([7; 32]);
        let seed = hex::encode(*me.seed());
        let ctl = Identity::from_seed([8; 32]).fingerprint();
        let good = json(&node(&seed, &ctl, "192.168.0.2:7788", "ios"));
        let key = wg_key(&[9; 32]);
        for (broken, why) in [
            (
                good.replace("\"proxy_port\":443", "\"proxy_port\":0"),
                "proxy_port",
            ),
            (good.replace(&seed, "abc"), "seed"),
            (good.replace(&ctl, "nope"), "controller.pin"),
            // Another machine than the tunnel's one target, a name, no port.
            (
                good.replace("192.168.0.2:7788", "192.168.0.9:7788"),
                "not the tunnel's",
            ),
            (
                good.replace("192.168.0.2:7788", "box.example.org:7788"),
                "not the tunnel's",
            ),
            (good.replace("192.168.0.2:7788", "192.168.0.2"), "host:port"),
            (
                good.replace("\"os\":\"ios\"", "\"os\":\"macos\""),
                "hello.os",
            ),
            (good.replace("1.0.0", "1.0 beta"), "hello: agent_version"),
            (good.replace("Santiago’s iPhone", " "), "hello: hostname"),
            // The tunnel's own checks.
            (good.replace("192.168.0.2/32", "0.0.0.0/0"), "AllowedIPs"),
            (
                good.replace("box.example.org:51820", "box.example.org"),
                "endpoint",
            ),
        ] {
            let Err(e) = checked(&broken) else {
                panic!("a config that should not check did: {why}");
            };
            assert!(e.contains(why), "{e} (wanted {why})");
            assert!(!e.contains(&key[..8]) && !e.contains(&seed[..8]), "{e}");
        }
        // A missing field, a wrong type, no JSON at all: errors that never
        // carry the text.
        for broken in [
            good.replace("\"proxy_port\":443,", ""),
            good.replace("443", &format!(r#""{key}""#)),
            good[..good.len() - 9].to_string(),
            format!("{key} is not json"),
        ] {
            let Err(e) = Config::from_json(&broken) else {
                panic!("a broken config was read");
            };
            assert!(e.starts_with("the config: "), "{e}");
            assert!(!e.contains(&key[..8]) && !e.contains(&seed[..8]), "{e}");
        }
    }
}
