//! Print a new identity as `daedalus_identity_new` answers it: the seed to
//! put in a probe's config (examples/probe.rs), and the public key, node id
//! and fingerprint the box will know the device by.
//!
//!     cargo run --example identity

use daedalus_core::identity::Identity;

fn main() {
    let id = Identity::generate();
    println!(
        "{}",
        serde_json::json!({
            "seed": hex::encode(*id.seed()),
            "public_key": id.public_key_hex(),
            "node_id": id.node_id(),
            "fingerprint": id.fingerprint(),
        })
    );
}
