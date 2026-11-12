//! The machine's key on disk: the ed25519 keypair of the shared crate
//! (core/src/identity.rs: what it is, the fingerprint, the node id), made
//! on first start and kept in the data directory.
//!
//! On Windows the seed is wrapped with DPAPI under the machine's scope
//! before it touches disk, so a copy is useless on any other computer — but
//! any process on THIS machine can unwrap it, so keeping local users out
//! rests on the file's ACL (see `os::create_private`, util.rs
//! `write_atomic`). Elsewhere the seed is a plain file, mode 0600, which is
//! the ordinary SSH-key posture (os/unix.rs). How the seed is sealed and
//! written is `os::{seal, unseal}` and `util::write_atomic`.

use std::path::Path;

use anyhow::{bail, Context, Result};

pub use daedalus_core::identity::*;

use crate::core::paths::data_dir;
use crate::os::{seal, unseal};

pub const FILE: &str = "identity.key";

/// Load the key from the data directory, or make one and keep it there.
pub fn load_or_create() -> Result<Identity> {
    load_or_create_at(&data_dir().join(FILE))
}

/// The same, at `path`.
pub fn load_or_create_at(path: &Path) -> Result<Identity> {
    if path.exists() {
        // A key someone else could have planted is not this machine's.
        crate::private::check_owner(path)?;
        // And one others could read is not a secret (T4): refused.
        crate::os::ensure_private(path)?;
        let sealed = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
        let seed = unseal(&sealed).context("the identity file could not be opened")?;
        let arr: [u8; 32] = seed.as_slice().try_into().context("identity seed length")?;
        return Ok(Identity::from_seed(arr));
    }
    let id = Identity::generate();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("creating the data directory")?;
    }
    crate::util::write_atomic(path, &seal(&*id.seed())?, crate::util::Access::Private)
        .with_context(|| format!("writing {}", path.display()))?;
    tracing::info!(path = %path.display(), "made this machine's identity key");
    Ok(id)
}

/// Load the key at `path`, which must exist and be trusted.
pub fn load_at(path: &Path) -> Result<Identity> {
    if !path.exists() {
        bail!("{} does not exist", path.display());
    }
    load_or_create_at(path)
}
