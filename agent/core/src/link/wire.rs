//! The link's wire types: every message between a machine and the
//! controller, as serde writes them, with golden tests pinning each one's
//! exact JSON — the same contract discipline as the local API's wire.rs,
//! whose envelope this reuses: a request `{"id","m","p"}`, an answer
//! `{"id","ok"}` or `{"id","err":{"code","msg"}}`, an event `{"e","p"}`,
//! one per line, at most `MAX_LINE` bytes.
//!
//! ```text
//! node → {"id":1,"m":"hello","p":{"proto":1,"node_id":"…","agent_version":"0.14.0",…}}
//! ctl  ← {"id":1,"ok":{"proto":1,"node_id":"…","state":"pending","controller":{…},"policy":null}}
//! ctl  ← {"e":"state","p":{"state":"approved"}}
//! ctl  ← {"e":"policy","p":{"awake_hold":true,"claude_remote_control":true}}
//! node → {"e":"status","p":{…}}   {"e":"telemetry","p":{…}}   {"e":"claude","p":{…}}
//! ctl  ← {"id":7,"m":"command","p":{"command":"claude_restart"}}
//! node → {"id":7,"ok":{"accepted":true}}
//! node → {"e":"claude_roster","p":{…}}
//! ctl  ← {"id":8,"m":"claude_session","p":{"action":"resume","id":"<uuid>","request":"<16 hex>"}}
//! node → {"id":8,"ok":{"accepted":true}}
//! ctl  ← {"id":9,"m":"provider_model","p":{"kind":"lemonade","action":"load","model":"…","pinned":false,"replacing":null,"request":"<16 hex>"}}
//! node → {"id":9,"ok":{"accepted":true}}
//! ctl  ← {"id":11,"m":"provider_install","p":{"request":"<16 hex>","kind":"lemonade","version":"v2026.40.0","url":"https://github.com/lemonade-sdk/…","size":…,"sha256":"<64 hex>"}}
//! ctl  ← {"id":12,"m":"provider_power","p":{"request":"<16 hex>","kind":"lemonade","wanted":"stop"}}
//! ctl  ← {"id":10,"m":"rotate","p":{"new_public_key":"<64 hex>","signature":"<128 hex>"}}
//! node → {"id":10,"ok":{"accepted":true}}      (re-pinned; it reconnects under the new key)
//! node → {"id":2,"m":"leave","p":{}}              (logging out; enroll.rs)
//! ctl  ← {"id":2,"ok":{}}                        (the app hears nodes.left; the node closes)
//! node → {"id":3,"m":"policy_request","p":{"awake_hold":false}}   (settings.rs)
//! ctl  ← {"id":3,"ok":{"accepted":true}}         (the app hears nodes.policy_request)
//! both → {"e":"hb"}
//! ```
//!
//! The protocol version (`PROTO`) rides the first request, `hello`; a
//! controller that speaks another answers `version` with the one it does,
//! and the machine says so on its status page and retries at the slowest
//! step. Fields a side does not know are ignored everywhere on this link:
//! the two ends are released separately (the box's with the lock bump, a
//! machine's when it updates), so an addition must never break the other.

use serde::{Deserialize, Serialize};

/// The link protocol this agent speaks.
pub const PROTO: u32 = 1;

/// The methods and events, all of them.
pub mod name {
    /// node → controller, the first request.
    pub const HELLO: &str = "hello";
    /// controller → node: a one-shot instruction, acknowledged.
    pub const COMMAND: &str = "command";
    /// both ways, every `HEARTBEAT`.
    pub const HB: &str = "hb";
    /// node → controller: the status document (`shared::StatusDocument`).
    pub const STATUS: &str = "status";
    /// node → controller: the full telemetry document.
    pub const TELEMETRY: &str = "telemetry";
    /// node → controller: the session's full Claude report, or null.
    pub const CLAUDE: &str = "claude";
    /// node → controller: the providers on the machine.
    pub const PROVIDERS: &str = "providers";
    /// node → controller: the session's roster of Claude sessions, or null.
    pub const CLAUDE_ROSTER: &str = "claude_roster";
    /// controller → node: one verb on one Claude session, acknowledged.
    pub const CLAUDE_SESSION: &str = "claude_session";
    /// controller → node: one residency verb on one model, acknowledged;
    /// the outcome rides the next `providers` document (providers/).
    pub const PROVIDER_MODEL: &str = "provider_model";
    /// controller → node: install or update a provider to one release,
    /// acknowledged; it runs for minutes, and its phases and outcome ride
    /// the `providers` documents that follow (providers/install.rs).
    pub const PROVIDER_INSTALL: &str = "provider_install";
    /// controller → node: start or stop a provider, acknowledged; the
    /// outcome rides the next `providers` document.
    pub const PROVIDER_POWER: &str = "provider_power";
    /// controller → node: where the machine stands.
    pub const STATE: &str = "state";
    /// controller → node: its key hands over to a new one — the statement
    /// signed by the key the node trusts (rotation.rs), acknowledged once
    /// the node has re-pinned.
    pub const ROTATE: &str = "rotate";
    /// controller → node: the box's policy for it.
    pub const POLICY: &str = "policy";
    /// node → controller: this machine logs out (enroll.rs) and asks to be
    /// forgotten; acknowledged, then the app hears `nodes.left`.
    pub const LEAVE: &str = "leave";
    /// node → controller: the machine's user asks the box to change one of
    /// its settings (`PolicyRequest`); acknowledged once the app was told
    /// (`nodes.policy_request`). The change is real only when the box's
    /// next `policy` carries it.
    pub const POLICY_REQUEST: &str = "policy_request";
}

/// `policy_request`'s parameters: the settings a machine's own user may ask
/// the box to change, each an absolute value, so a retry or a replay changes
/// nothing twice. Nothing else of the policy is the machine's to ask for:
/// its names, its providers and its address are grants to it, and santree
/// may only be turned OFF here — turning it on grants a shell on the box,
/// which an admin does in the browser (settings.rs). Exact: an unknown key
/// is refused.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub awake_hold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub claude_remote_control: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub santree: Option<bool>,
}

impl PolicyRequest {
    /// At least one setting, and santree only ever off.
    pub fn check(&self) -> Result<(), String> {
        if self.awake_hold.is_none()
            && self.claude_remote_control.is_none()
            && self.santree.is_none()
        {
            return Err("a policy request names at least one setting".into());
        }
        if self.santree == Some(true) {
            return Err("santree is turned on from Daedalus, not from the machine".into());
        }
        Ok(())
    }
}

/// Where a machine stands with the box: what the app decided, or pending
/// while it has decided nothing. `Unknown` is the controller's word, in its
/// own API, for a key it has seen but that is neither connected nor in the
/// app's set (controller/link/); a machine is never told it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeState {
    Pending,
    Approved,
    Revoked,
    Unknown,
}

impl NodeState {
    pub fn as_str(self) -> &'static str {
        match self {
            NodeState::Pending => "pending",
            NodeState::Approved => "approved",
            NodeState::Revoked => "revoked",
            NodeState::Unknown => "unknown",
        }
    }
}

/// What kind of node a machine is. An `agent` is the service this
/// repository releases: it takes the box's policy and its commands. A
/// `light` node — the iOS app — is on the link only while its app is open
/// and reports its telemetry: it runs no Claude, no providers and no
/// session host, so the controller sends it no policy and no command, and
/// its absence never alerts (controller/link/). `unknown`: a newer peer's
/// word.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Agent,
    Light,
    #[serde(other)]
    Unknown,
}

/// What an agent offers, from its role and config (api/mod.rs
/// `capabilities`): a method whose capability is absent answers
/// `unsupported`. `unknown`: a newer machine's word, read in its hello.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Capability {
    /// Claude remote control runs in the user's session (`claude.status`,
    /// `claude.restart`).
    #[serde(rename = "claude.remote_control")]
    ClaudeRemoteControl,
    /// The agent updates Claude Code (never on the controller: nix pins it).
    #[serde(rename = "claude.update")]
    ClaudeUpdate,
    /// The roster of Claude sessions and their verbs.
    #[serde(rename = "claude.sessions")]
    ClaudeSessions,
    #[serde(rename = "telemetry.full")]
    TelemetryFull,
    #[serde(rename = "telemetry.minimal")]
    TelemetryMinimal,
    /// A machine reads its providers and drives their residency for the box.
    #[serde(rename = "providers.residency")]
    ProvidersResidency,
    /// A machine installs, updates, starts and stops its providers for the
    /// box (`nodes.provider_install`, `nodes.provider_power`).
    #[serde(rename = "providers.lifecycle")]
    ProvidersLifecycle,
    /// The controller listens for machines (`nodes.*`).
    #[serde(rename = "nodes")]
    Nodes,
    /// The controller reaches the root helper (`root.*`).
    #[serde(rename = "root")]
    Root,
    /// The controller follows a session host (`santree.status`).
    #[serde(rename = "santree")]
    Santree,
    /// The controller holds its link key (`controller.rotate`).
    #[serde(rename = "controller")]
    Controller,
    #[serde(rename = "unknown", other)]
    Unknown,
}

impl std::fmt::Display for Capability {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TelemetryLevel {
    #[default]
    Full,
    Minimal,
    Off,
}

/// The three verbs on one session (sessions/).
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionAction {
    /// `claude --resume <uuid>` in a job of its own.
    Resume,
    /// End a session this agent resumed, or a running background agent.
    Stop,
    /// `claude rm <short id>`: a background agent's record.
    Remove,
}

impl SessionAction {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionAction::Resume => "resume",
            SessionAction::Stop => "stop",
            SessionAction::Remove => "remove",
        }
    }
}

/// Whether the provider should run.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PowerWanted {
    Start,
    Stop,
}

impl std::fmt::Display for PowerWanted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        crate::util::wire_name(self, f)
    }
}

/// What a machine is, in `hello`'s facts.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HelloFacts {
    pub os_name: String,
    pub os_version: String,
    pub cpu: String,
    pub memory_bytes: Option<u64>,
    /// The model, as the device names it ("iPhone17,1"): a light node's,
    /// so a pending phone can be told from another before it may push
    /// telemetry. Absent from an agent's hello, whose telemetry carries it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub model: Option<String>,
}

/// `hello`: who the machine is. Its key is the TLS client certificate's;
/// `node_id` must be that key's, or the controller refuses the connection.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hello {
    pub proto: u32,
    pub node_id: String,
    pub agent_version: String,
    /// "windows", "macos", "linux"; a light node: "ios", "ipados".
    pub os: String,
    pub arch: String,
    pub hostname: String,
    pub mac: Option<String>,
    pub lan_ip: Option<String>,
    pub facts: HelloFacts,
    /// What the agent offers (`api::capabilities` for its role).
    pub capabilities: Vec<Capability>,
    /// How much telemetry it reads.
    pub telemetry: TelemetryLevel,
    /// What kind of node it is; absent means an agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "ts", ts(optional))]
    pub kind: Option<NodeKind>,
}

/// The longest `hello` line the controller reads before a key is admitted.
pub const MAX_HELLO_LINE: usize = 16 * 1024;
/// The longest hostname a `hello` may carry, in bytes.
pub const MAX_HOSTNAME: usize = 253;

/// A token: letters, digits and `.`, `_`, `+`, `-`, at most `max` bytes.
fn token(what: &str, s: &str, max: usize) -> Result<(), String> {
    if s.is_empty()
        || s.len() > max
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
    {
        return Err(format!("{what} is not a short token"));
    }
    Ok(())
}

/// Text a person reads: no control characters, at most `max` bytes.
fn text(what: &str, s: &str, max: usize) -> Result<(), String> {
    if s.len() > max || s.chars().any(char::is_control) {
        return Err(format!(
            "{what} is longer than {max} bytes or has control characters"
        ));
    }
    Ok(())
}

/// `aa:bb:cc:dd:ee:ff`, either case.
fn mac_ok(s: &str) -> bool {
    let parts: Vec<&str> = s.split(':').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

impl Hello {
    /// The bounds the controller holds an unauthenticated `hello` to — what
    /// it keeps in memory and what the app renders. A hostname may be a
    /// Mac's own name ("Santiago’s MacBook Pro"), so it is text, not an RFC
    /// 1123 label: at most `MAX_HOSTNAME` bytes, trimmed, without control
    /// characters.
    pub fn check(&self) -> Result<(), String> {
        if self.node_id.len() != 16 || !self.node_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("node_id is not sixteen hex characters".into());
        }
        text("hostname", &self.hostname, MAX_HOSTNAME)?;
        if self.hostname.trim().is_empty() || self.hostname.trim() != self.hostname {
            return Err("hostname is empty or padded".into());
        }
        token("agent_version", &self.agent_version, 64)?;
        token("os", &self.os, 64)?;
        token("arch", &self.arch, 64)?;
        if let Some(m) = &self.mac {
            if !mac_ok(m) {
                return Err("mac is not six hex pairs joined by `:`".into());
            }
        }
        if let Some(ip) = &self.lan_ip {
            if ip.parse::<std::net::Ipv4Addr>().is_err() {
                return Err("lan_ip is not an IPv4 address".into());
            }
        }
        if self.capabilities.len() > 32 {
            return Err("more than 32 capabilities".into());
        }
        text("facts.os_name", &self.facts.os_name, 256)?;
        text("facts.os_version", &self.facts.os_version, 256)?;
        text("facts.cpu", &self.facts.cpu, 256)?;
        if let Some(m) = &self.facts.model {
            text("facts.model", m, 256)?;
        }
        Ok(())
    }
}

/// The controller as a machine is told it.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ControllerId {
    pub version: String,
    pub hostname: String,
    pub fingerprint: String,
}

/// `hello`'s answer. `policy` is the app's for an approved machine and null
/// otherwise.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Welcome {
    pub proto: u32,
    pub node_id: String,
    pub state: NodeState,
    pub controller: ControllerId,
    #[serde(default)]
    pub policy: Option<Policy>,
}

/// What the box wants of a machine: the app's decision, sent by the
/// controller with `hello`'s answer and as the `policy` event. The defaults
/// stand until the controller has approved the machine; there is no local
/// copy.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Policy {
    /// Hold the machine awake (the agent's first job; off means the box
    /// decided this machine may sleep).
    pub awake_hold: bool,
    /// Run `claude remote-control` in the user's session.
    pub claude_remote_control: bool,
    /// The directory the server runs in; empty means the session picks the
    /// most recently used trusted project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_workdir: Option<String>,
    /// What the box wants of the providers on this machine: the port to
    /// look for each on, its pinned release, whether it runs and starts on
    /// its own. Absent when it names none.
    #[serde(default, skip_serializing_if = "ProvidersPolicy::is_empty")]
    pub providers: ProvidersPolicy,
    /// santree on this machine may open its projects on the box: the
    /// agent's santree socket pipes it to the session host (santree.rs).
    /// The app's toggle; absent means off.
    #[serde(default, skip_serializing_if = "is_false")]
    pub santree: bool,
    /// Where the session host is and the key it proves: the controller's to
    /// fill, and only while `santree` is on (registry.rs `effective`).
    /// Strings, checked where they are used (`SessionHost::checked`), so a
    /// kept policy with a bad one still parses.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_host: Option<SessionHost>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// The session host as a machine is told it.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionHost {
    /// `host:port`.
    pub address: String,
    /// Its raw ed25519 key, 64 hex characters: what the agent pins.
    pub public_key: String,
}

impl SessionHost {
    /// The address and the key, checked: `host:port` of at most 255 bytes,
    /// and 32 bytes of hex.
    pub fn checked(&self) -> Result<(&str, [u8; 32]), String> {
        if self.address.len() > 255 || !crate::util::valid_host_port(&self.address) {
            return Err(format!(
                "the session host's address {:?} is not host:port",
                self.address
            ));
        }
        let key = crate::identity::parse_public_key(&self.public_key)
            .map_err(|e| format!("the session host's key: {e}"))?;
        Ok((&self.address, key))
    }
}

/// The providers half of the policy, one optional entry per kind.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProvidersPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lemonade: Option<ProviderPolicy>,
}

impl ProvidersPolicy {
    pub fn is_empty(&self) -> bool {
        self.lemonade.is_none()
    }
}

#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderPolicy {
    /// The port the provider answers on; None means the kind's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The release the box pins. Nothing installs it but `provider_install`,
    /// which the agent refuses for any other release while one is pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pin: Option<ProviderPin>,
    /// Run it, or not: the agent starts it again when it is found stopped —
    /// unless its user stopped it (`manual_off`) — and stops it when this
    /// turns to `stop`. None leaves it as it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wanted: Option<PowerWanted>,
    /// Start it with the user's logon (Windows) or the machine's boot, kept
    /// so by the agent. None leaves the startup as the install made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub always_on: Option<bool>,
    /// Every origin a browser may write to it from, as the box names the
    /// machine (its LAN name, its address, its published hostname). The
    /// agent keeps the server's own setting equal to it, so it REPLACES the
    /// server's same-origin rule: an origin missing here is refused.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_origins: Vec<String>,
}

/// One release of a provider, as the box resolved it for this machine's
/// OS: `provider_install`'s release, asset and digest.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ProviderPin {
    pub version: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            awake_hold: true,
            claude_remote_control: true,
            claude_workdir: None,
            providers: ProvidersPolicy::default(),
            santree: false,
            session_host: None,
        }
    }
}

/// The `state` event.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct StateEvent {
    pub state: NodeState,
}

/// The one-shot instructions the controller sends a machine.
#[cfg_attr(feature = "ts", derive(ts_rs::TS))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    /// The updater looks for a newer release now.
    CheckUpdate,
    /// The session updates Claude Code (interrupts nothing).
    ClaudeUpdate,
    /// The session restarts `claude remote-control` (ends its sessions).
    ClaudeRestart,
}

/// `command`'s parameters.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandParams {
    pub command: Command,
}

/// `claude_session`'s parameters: the verb, its selector (`id`: a session
/// uuid or a background agent's short id) and the request id the
/// controller minted, under which the machine's roster reports the outcome
/// (`actions`). Exact: nothing else rides it, least of all a path or a flag.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClaudeSessionParams {
    pub action: SessionAction,
    pub id: String,
    pub request: String,
}

/// `rotate`'s parameters: the controller's new key, and the key the node
/// trusts vouching for it (identity.rs `sign_rotation`), both hex. Exact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RotateParams {
    pub new_public_key: String,
    pub signature: String,
}

/// `command`'s answer: the machine took the instruction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Accepted {
    pub accepted: bool,
}

pub use crate::ipc::rpc::Incoming;

/// A request as a line (no newline).
pub fn request<P: Serialize>(id: u64, m: &str, p: &P) -> String {
    #[derive(Serialize)]
    struct R<'a, P> {
        id: u64,
        m: &'a str,
        p: &'a P,
    }
    serde_json::to_string(&R { id, m, p }).expect("a request serialises")
}

/// An event as a line (no newline).
pub fn event<P: Serialize>(e: &str, p: &P) -> String {
    #[derive(Serialize)]
    struct E<'a, P> {
        e: &'a str,
        p: &'a P,
    }
    serde_json::to_string(&E { e, p }).expect("an event serialises")
}

/// The heartbeat line.
pub const HB_LINE: &str = r#"{"e":"hb"}"#;
