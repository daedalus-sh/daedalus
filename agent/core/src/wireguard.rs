//! A WireGuard client config as it travels: plain strings, on every target
//! — the tunnel that checks and runs one (tunnel/) exists only where its
//! crypto builds.

use serde::{Deserialize, Serialize};

/// A wg-easy client config, as wg-quick names its fields: what the app
/// reads back from wg-easy for the machine (`[Interface]` PrivateKey and
/// Address, `[Peer]` PublicKey, PresharedKey, Endpoint and AllowedIPs), and
/// what the machine keeps in `tunnel.toml` (tunnel/). Its keys are wiped
/// from memory when it is dropped, and it is never printed.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireguardConfig {
    pub private_key: String,
    /// This machine inside the tunnel, `a.b.c.d` — wg-easy writes a prefix
    /// (`/24`), which is ignored.
    pub address: String,
    pub server_public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub preshared_key: Option<String>,
    /// `host:port`.
    pub endpoint: String,
    /// Exactly one: the box's LAN address, `/32`.
    pub allowed_ips: Vec<String>,
}

impl Drop for WireguardConfig {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.private_key.zeroize();
        if let Some(k) = self.preshared_key.as_mut() {
            k.zeroize();
        }
    }
}
