//! A machine's key: an ed25519 keypair, the only credential a node ever
//! presents.
//!
//! The box keys everything it knows about a machine on the public half, so
//! the private half IS the machine's identity: a copy of the seed on another
//! computer would let it impersonate this one. Here the key is bytes in and
//! bytes out (`from_seed`, `seed`); where the seed is kept is each host's —
//! the agent's `identity.key` (sealed with DPAPI on Windows, mode 0600
//! elsewhere: agent/src/identity.rs), the iOS app's Keychain.
//!
//! The controller has one too, made the same way in its own data directory:
//! it is what the machines pin (link/). Both ends show a key as its
//! FINGERPRINT — SHA-256 of the public key, lowercase hex in groups of four
//! (`fingerprint`) — and a machine's node id is the first sixteen hex
//! characters of the same digest. The key signs nothing but the link's
//! certificate and TLS handshake (link/cert.rs, link/crypto.rs) — and, for
//! the controller's, the one statement that hands its trust to a new key
//! (`sign_rotation`, under a context of its own; controller/rotation.rs).

use anyhow::{bail, Context, Result};
use ed25519_dalek::{SigningKey, VerifyingKey};
use sha2::{Digest, Sha256};

#[derive(Clone)]
pub struct Identity {
    key: SigningKey,
}

impl Identity {
    /// A new key, from the OS's randomness.
    pub fn generate() -> Self {
        Self {
            key: SigningKey::generate(&mut rand_core::OsRng),
        }
    }

    /// A key from its 32-byte seed.
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn public_key(&self) -> VerifyingKey {
        self.key.verifying_key()
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.public_key().as_bytes())
    }

    /// What the box calls this machine: sixteen hex characters of SHA-256(pubkey).
    pub fn node_id(&self) -> String {
        node_id_of(self.public_key().as_bytes())
    }

    /// The key as people compare it (module doc).
    pub fn fingerprint(&self) -> String {
        fingerprint(self.public_key().as_bytes())
    }

    /// The key itself, for the link's certificate and handshake (link/).
    pub(crate) fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    /// The seed: the whole secret, for the host to keep.
    pub fn seed(&self) -> zeroize::Zeroizing<[u8; 32]> {
        zeroize::Zeroizing::new(self.key.to_bytes())
    }

    /// The controller's rotation statement (controller/rotation.rs): this key
    /// vouching for `new`, over `rotation_message`.
    pub fn sign_rotation(&self, new: &[u8; 32]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.key
            .sign(&rotation_message(self.public_key().as_bytes(), new))
            .to_bytes()
    }
}

/// What a rotation statement signs: a context of its own, so no signature
/// the key makes for anything else can pass for one, then the old key and
/// the new.
pub fn rotation_message(old: &[u8; 32], new: &[u8; 32]) -> Vec<u8> {
    let mut m = b"daedalus-agent controller key rotation v1\0".to_vec();
    m.extend_from_slice(old);
    m.extend_from_slice(new);
    m
}

/// Whether `signature` is `old`'s statement that `new` succeeds it.
pub fn verify_rotation(old: &[u8; 32], new: &[u8; 32], signature: &[u8]) -> bool {
    let (Ok(key), Ok(sig)) = (
        VerifyingKey::from_bytes(old),
        ed25519_dalek::Signature::from_slice(signature),
    ) else {
        return false;
    };
    old != new && key.verify_strict(&rotation_message(old, new), &sig).is_ok()
}

/// SHA-256 of a public key.
pub fn digest(public_key: &[u8; 32]) -> [u8; 32] {
    Sha256::digest(public_key).into()
}

/// The node id of a public key: sixteen hex characters of its digest.
pub fn node_id_of(public_key: &[u8; 32]) -> String {
    hex::encode(digest(public_key))[..16].to_string()
}

/// A digest as people read it: lowercase hex, four characters to a group,
/// the groups joined by `:` — `3f2a:9c01:…`, sixteen groups.
pub fn format_fingerprint(digest: &[u8; 32]) -> String {
    let hex = hex::encode(digest);
    hex.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).expect("hex is ASCII"))
        .collect::<Vec<_>>()
        .join(":")
}

/// A public key's fingerprint (module doc).
pub fn fingerprint(public_key: &[u8; 32]) -> String {
    format_fingerprint(&digest(public_key))
}

/// A fingerprint as typed or pasted — groups joined by `:`, `-` or spaces,
/// or none; either case — back to the digest.
pub fn parse_fingerprint(text: &str) -> Result<[u8; 32]> {
    let hex: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | ' '))
        .collect::<String>()
        .to_ascii_lowercase();
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("a fingerprint is 64 hex characters (SHA-256 of the key), not {text:?}");
    }
    let mut out = [0u8; 32];
    hex::decode_to_slice(&hex, &mut out).context("fingerprint")?;
    Ok(out)
}

/// A public key given as 64 hex characters.
pub fn parse_public_key(text: &str) -> Result<[u8; 32]> {
    let text = text.trim().to_ascii_lowercase();
    let mut out = [0u8; 32];
    if text.len() != 64 || hex::decode_to_slice(&text, &mut out).is_err() {
        bail!("a public key is 64 hex characters, not {text:?}");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_key_has_an_id_and_a_hex_form() {
        let id = Identity {
            key: SigningKey::generate(&mut rand_core::OsRng),
        };
        assert_eq!(id.node_id().len(), 16);
        assert_eq!(id.public_key_hex().len(), 64);
    }

    #[test]
    fn a_fingerprint_reads_back_and_starts_with_the_node_id() {
        let id = Identity::from_seed([7; 32]);
        let fp = id.fingerprint();
        assert_eq!(fp.len(), 64 + 15);
        assert_eq!(fp.split(':').count(), 16);
        assert_eq!(fp.replace(':', "")[..16], id.node_id());
        let d = digest(id.public_key().as_bytes());
        assert_eq!(parse_fingerprint(&fp).unwrap(), d);
        assert_eq!(
            parse_fingerprint(&fp.to_uppercase().replace(':', " ")).unwrap(),
            d
        );
        assert_eq!(parse_fingerprint(&fp.replace(':', "")).unwrap(), d);
        assert!(parse_fingerprint("abc").is_err());
        assert!(parse_fingerprint(&"g".repeat(64)).is_err());
        assert_eq!(
            parse_public_key(&id.public_key_hex()).unwrap(),
            *id.public_key().as_bytes()
        );
        assert!(parse_public_key("00").is_err());
    }

    #[test]
    fn only_the_old_key_can_vouch_for_the_new_one() {
        let old = Identity::from_seed([1; 32]);
        let new = Identity::from_seed([2; 32]);
        let other = Identity::from_seed([3; 32]);
        let (o, n) = (*old.public_key().as_bytes(), *new.public_key().as_bytes());
        let sig = old.sign_rotation(&n);
        assert!(verify_rotation(&o, &n, &sig));
        // Another key's statement, the new key's own, a statement for
        // another key, a key rotated to itself, a torn signature: no.
        assert!(!verify_rotation(&o, &n, &other.sign_rotation(&n)));
        assert!(!verify_rotation(&o, &n, &new.sign_rotation(&n)));
        assert!(!verify_rotation(&o, other.public_key().as_bytes(), &sig));
        assert!(!verify_rotation(&o, &o, &old.sign_rotation(&o)));
        assert!(!verify_rotation(&o, &n, &sig[..63]));
        // A signature over the bare keys, without the context, is not one.
        use ed25519_dalek::Signer;
        let mut bare = o.to_vec();
        bare.extend_from_slice(&n);
        assert!(!verify_rotation(&o, &n, &old.key.sign(&bare).to_bytes()));
    }
}
