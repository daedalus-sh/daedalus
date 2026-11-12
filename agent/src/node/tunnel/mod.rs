//! The machine's own WireGuard tunnel to the box, as the agent keeps it:
//! the tunnel is the shared crate's (core/src/tunnel/mod.rs has the
//! description); here is its file.
//!
//! **The file**: `tunnel.toml` in the data directory, the service's alone
//! (0600, root's on a Mac) — it holds the private key. A Mac's log-in
//! writes it (enroll.rs).

#[cfg(test)]
mod tests;

use std::path::Path;

use anyhow::{Context, Result};
use zeroize::Zeroizing;

pub use daedalus_core::tunnel::*;

/// The file at `path`, checked; None when there is none. One that is
/// there but not the service's alone, or does not check, is an error:
/// the machine then dials nothing rather than around its tunnel (net.rs
/// `Refused`).
pub fn load_at(path: &Path) -> Result<Option<Settings>> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => Zeroizing::new(t),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
    };
    crate::private::check_owner(path)?;
    crate::os::ensure_private(path)?;
    let c: WireguardConfig =
        toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?;
    c.checked()
        .map(Some)
        .map_err(|e| anyhow::anyhow!("{}: {e}", path.display()))
}

/// Write `config` to `path`, the service's alone.
pub fn write_at(config: &WireguardConfig, path: &Path) -> Result<()> {
    let text = Zeroizing::new(format!(
        "# daedalus-agent — this machine's WireGuard client of the box, from its log-in.\n\
         # Written by the service; Log out removes it.\n\n{}",
        toml::to_string_pretty(config)?
    ));
    crate::util::write_atomic(path, text.as_bytes(), crate::util::Access::Private)
        .with_context(|| format!("writing {}", path.display()))
}
