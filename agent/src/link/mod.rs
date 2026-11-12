//! The link, as the agent holds it: the protocol, its transport, trust and
//! limits are the shared crate's (core/src/link/mod.rs has the description);
//! here are the keys the service follows (`LinkKeys`) and the files they are
//! read from (`KeyFiles`). The machine's side of the conversation is
//! node/link.rs, the controller's controller/link/.

pub use daedalus_core::link::*;

pub mod wire;

/// config.toml's two link keys as the service holds them (shared/link.rs
/// `LinkHub::keys`): read at start, read again when the machine is paired
/// while running (pair.rs `reload`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LinkKeys {
    pub pin: Option<String>,
    pub address: Option<String>,
}

impl LinkKeys {
    /// Whether a pin is set at all (a pin that does not parse is still one:
    /// the link says what is wrong with it).
    pub fn paired(&self) -> bool {
        self.pin.as_deref().is_some_and(|p| !p.trim().is_empty())
    }
}

/// Where the link's keys are read from: config.toml, and — on a system that
/// logs in rather than pairs — the tunnel config a log-in writes beside the
/// pin. A Mac joins the box by logging in from its menu bar alone
/// (enroll.rs): a pin WITHOUT a tunnel config — a log-out cut short — is
/// a Mac logged out, and the link dials nobody.
/// Other systems pair, and a pin is all they need.
///
/// The files are named, never assumed: a test (on any system) reads its
/// own scratch files under either rule, and never the machine's own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyFiles {
    pub config: std::path::PathBuf,
    /// The tunnel config whose absence is a logged-out machine, where this
    /// system logs in (macOS); None where a pin alone is paired.
    pub login: Option<std::path::PathBuf>,
}

impl KeyFiles {
    /// The service's own: config.toml and tunnel.toml in their directories,
    /// under this system's rule.
    pub fn here() -> Self {
        Self::on_this_os(
            crate::core::paths::config_path(),
            crate::core::paths::tunnel_path(),
        )
    }

    /// `config` and `tunnel` under this system's rule: a Mac logs in.
    pub fn on_this_os(config: std::path::PathBuf, tunnel: std::path::PathBuf) -> Self {
        Self {
            config,
            login: cfg!(target_os = "macos").then_some(tunnel),
        }
    }

    /// Whether the machine is logged out: it logs in, and has no tunnel.
    pub fn logged_out(&self) -> bool {
        self.login.as_deref().is_some_and(|t| !t.exists())
    }

    /// config.toml's keys as the link follows them: `cfg`'s, or none while
    /// logged out.
    pub fn keys(&self, cfg: &crate::core::config::Config) -> LinkKeys {
        if self.logged_out() {
            return LinkKeys::default();
        }
        LinkKeys {
            pin: cfg.controller_pin.clone(),
            address: cfg.controller_address.clone(),
        }
    }

    /// `keys`, reading config.toml (an absent file names none).
    pub fn load(&self) -> anyhow::Result<LinkKeys> {
        Ok(self.keys(&crate::core::config::load_at(&self.config)?))
    }
}
