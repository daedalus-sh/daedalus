//! daedalus-core — what a machine needs to be a node of a daedalus box, and
//! nothing that belongs to one operating system's service: its key
//! (identity.rs), the link to the controller (link/: the TLS, the wire, and
//! a node's side of the conversation), the machine's own WireGuard tunnel
//! to the box (tunnel/), how it dials through it (net.rs), and the envelope
//! and framing they speak (ipc/).
//!
//! Two crates build from it: the agent (agent/, every desktop OS and the
//! box's controller), which re-exports each module where its own code has
//! always named it, and the iOS app's library (ios/core), a light node.
//! Where a key or a config is KEPT is theirs, never this crate's: here they
//! are bytes in and bytes out.
//!
//! The tunnel exists where its crypto builds — macOS, Linux, iOS. Windows
//! has none, and builds no C at all (boringtun's AEAD is ring's).

pub mod identity;
pub mod ipc;
pub mod link;
pub mod net;
#[cfg(any(target_os = "macos", target_os = "linux", target_os = "ios"))]
pub mod tunnel;
pub mod util;
pub mod wireguard;
