//! The C ABI the app calls (include/daedalus_ios.h, module
//! `DaedalusCoreFFI`). One instance per process, behind a lock.
//!
//! Every function that answers returns a heap string of JSON, UTF-8 and
//! NUL-terminated, which the caller frees with `daedalus_free`: either the
//! answer (`{"ok":…}`, or the status document) or `{"error":"…"}`. No
//! function panics across the boundary (`catch_unwind`; a panic inside is
//! an error answer), and every pointer in is checked: null, or text that is
//! not UTF-8, is an error answer too. An error never quotes a key.
//!
//! The functions may be called from any thread. `daedalus_start` and
//! `daedalus_stop` wait for threads to end (a stop for up to a few
//! seconds: the link's goodbye, a dial under way), so the app calls them
//! off its main thread.

use std::ffi::{c_char, CStr, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};

use daedalus_core::identity::Identity;
use daedalus_core::util::LockExt;

use crate::config::{identity_of, Config};
use crate::{Node, Status};

/// The one instance.
static NODE: Mutex<Option<Node>> = Mutex::new(None);

/// The most a telemetry sample may be, in bytes: far more than a device's
/// document, far less than a line of the link.
const MAX_TELEMETRY: usize = 256 * 1024;

fn answer(v: &Value) -> *mut c_char {
    // serde_json escapes control characters, so the text has no NUL.
    CString::new(v.to_string())
        .unwrap_or_else(|_| CString::from(c"{\"error\":\"the answer could not be written\"}"))
        .into_raw()
}

fn ok<T: Serialize>(v: &T) -> Value {
    json!({ "ok": v })
}

fn error(why: impl Into<String>) -> Value {
    json!({ "error": why.into() })
}

/// Run `f`, a panic turned into an error answer.
fn guarded(f: impl FnOnce() -> Value) -> *mut c_char {
    let v = catch_unwind(AssertUnwindSafe(f))
        .unwrap_or_else(|_| error("the library failed unexpectedly (a panic)"));
    answer(&v)
}

/// The text behind `p`, or why there is none.
///
/// # Safety
/// `p` is null or points to a NUL-terminated string that stays valid for
/// the call.
unsafe fn text<'a>(p: *const c_char, what: &str) -> Result<&'a str, String> {
    if p.is_null() {
        return Err(format!("{what} is null"));
    }
    // SAFETY: not null, and NUL-terminated by this function's contract.
    unsafe { CStr::from_ptr(p) }
        .to_str()
        .map_err(|_| format!("{what} is not UTF-8"))
}

fn describe(id: &Identity) -> Value {
    ok(&json!({
        "seed": hex::encode(*id.seed()),
        "public_key": id.public_key_hex(),
        "node_id": id.node_id(),
        "fingerprint": id.fingerprint(),
    }))
}

/// A new identity key. The app keeps `seed` in the Keychain and passes it
/// back in every config: it IS the device's identity.
#[no_mangle]
pub extern "C" fn daedalus_identity_new() -> *mut c_char {
    guarded(|| describe(&Identity::generate()))
}

/// The identity of a seed (64 hex characters): the same answer as
/// `daedalus_identity_new`, for a key the app already holds.
///
/// # Safety
/// `seed_hex` is null or a NUL-terminated string valid for the call.
#[no_mangle]
pub unsafe extern "C" fn daedalus_identity_describe(seed_hex: *const c_char) -> *mut c_char {
    // SAFETY: this function's contract is `text`'s.
    let seed = unsafe { text(seed_hex, "the seed") }.map(str::to_owned);
    guarded(|| match seed.and_then(|s| identity_of(s.trim())) {
        Ok(id) => describe(&id),
        Err(e) => error(e),
    })
}

/// Start with `config_json` (config.rs): the tunnel, the loopback proxy
/// and, when the config names a node, the link. Starting while running
/// replaces the old instance (stopped first). Answers the proxy's port and
/// this start's credential.
///
/// # Safety
/// `config_json` is null or a NUL-terminated string valid for the call.
#[no_mangle]
pub unsafe extern "C" fn daedalus_start(config_json: *const c_char) -> *mut c_char {
    // SAFETY: this function's contract is `text`'s.
    let config = unsafe { text(config_json, "the config") }
        .and_then(Config::from_json)
        .and_then(|c| c.checked());
    guarded(|| {
        let config = match config {
            Ok(c) => c,
            Err(e) => return error(e),
        };
        let mut slot = NODE.lock_ok();
        // The old one goes first: its sockets and threads, whole.
        drop(slot.take());
        match Node::start(config) {
            Ok(node) => {
                let proxy = node.proxy();
                *slot = Some(node);
                ok(&json!({ "proxy": proxy }))
            }
            Err(e) => error(e),
        }
    })
}

/// Hand the link a telemetry sample (the `Telemetry` document as JSON, a
/// device's part of it): sent now if the link is up and approved, else as
/// soon as it is, and again every minute until the next sample.
///
/// # Safety
/// `telemetry_json` is null or a NUL-terminated string valid for the call.
#[no_mangle]
pub unsafe extern "C" fn daedalus_report(telemetry_json: *const c_char) -> *mut c_char {
    // SAFETY: this function's contract is `text`'s.
    let sample = unsafe { text(telemetry_json, "the telemetry") }.and_then(|t| {
        if t.len() > MAX_TELEMETRY {
            return Err(format!(
                "the telemetry is {} bytes; at most {MAX_TELEMETRY}",
                t.len()
            ));
        }
        serde_json::from_str::<Value>(t).map_err(|e| format!("the telemetry is not JSON: {e}"))
    });
    guarded(|| {
        let sample = match sample {
            Ok(s) => s,
            Err(e) => return error(e),
        };
        match NODE.lock_ok().as_ref() {
            None => error("not started"),
            Some(node) => match node.report(&sample) {
                Ok(()) => ok(&true),
                Err(e) => error(e),
            },
        }
    })
}

/// Unpair: tell the controller this device leaves and asks to be forgotten
/// (the app at the box hears it and deletes the device and its tunnel
/// client), waiting up to five seconds for the link to be up and the
/// controller to say it heard — then stop everything, heard or not.
/// `{"ok":{"sent":bool}}`: `sent` is whether the controller heard; when it
/// did not (no link in time, a start without a node, nobody listening at
/// the box) the device is still listed there until an admin removes it.
/// An error only when nothing was started. No lock is held while it waits,
/// so a status still answers.
#[no_mangle]
pub extern "C" fn daedalus_leave() -> *mut c_char {
    guarded(|| {
        // The link, out of the lock: a leave waits on the network.
        let light = match NODE.lock_ok().as_ref() {
            None => return error("not started"),
            Some(node) => node.link_handle(),
        };
        let sent = light.is_some_and(|l| l.leave(std::time::Duration::from_secs(5)).is_ok());
        drop(NODE.lock_ok().take());
        ok(&json!({ "sent": sent }))
    })
}

/// How everything stands (lib.rs `Status`): never an error answer.
#[no_mangle]
pub extern "C" fn daedalus_status() -> *mut c_char {
    guarded(|| {
        let status = NODE
            .lock_ok()
            .as_ref()
            .map_or_else(Status::stopped, Node::status);
        serde_json::to_value(status).unwrap_or_else(|e| error(e.to_string()))
    })
}

/// Stop everything and wait for its threads. Idempotent; nothing to free.
#[no_mangle]
pub extern "C" fn daedalus_stop() {
    let _ = catch_unwind(|| drop(NODE.lock_ok().take()));
}

/// Free a string one of these functions returned. Null is ignored; any
/// other pointer must be one of theirs, freed once.
///
/// # Safety
/// `s` is null or a pointer returned by a function of this library that
/// has not been freed.
#[no_mangle]
pub unsafe extern "C" fn daedalus_free(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: made by `CString::into_raw` in `answer`, by this
        // function's contract, and not freed before.
        drop(unsafe { CString::from_raw(s) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::tests::{json as config_json, node};

    /// Call, read the answer, free it.
    fn take(p: *mut c_char) -> Value {
        assert!(!p.is_null());
        // SAFETY: a string this library just returned.
        let v = serde_json::from_str(unsafe { CStr::from_ptr(p) }.to_str().unwrap()).unwrap();
        // SAFETY: returned by the library, freed once.
        unsafe { daedalus_free(p) };
        v
    }

    fn c(s: &str) -> CString {
        CString::new(s).unwrap()
    }

    #[test]
    fn an_identity_is_made_and_read_back() {
        let new = take(daedalus_identity_new());
        let id = &new["ok"];
        let seed = id["seed"].as_str().unwrap();
        assert_eq!(seed.len(), 64);
        assert_eq!(id["public_key"].as_str().unwrap().len(), 64);
        assert_eq!(id["node_id"].as_str().unwrap().len(), 16);
        let fp = id["fingerprint"].as_str().unwrap();
        assert!(fp
            .replace(':', "")
            .starts_with(id["node_id"].as_str().unwrap()));
        // SAFETY: valid C strings, or null on purpose.
        unsafe {
            assert_eq!(take(daedalus_identity_describe(c(seed).as_ptr())), new);
            assert_ne!(take(daedalus_identity_new())["ok"]["seed"], id["seed"]);
            for bad in ["", "abc", &"g".repeat(64)] {
                let e = take(daedalus_identity_describe(c(bad).as_ptr()));
                assert!(e["error"].as_str().unwrap().contains("64 hex"), "{e}");
            }
            let e = take(daedalus_identity_describe(std::ptr::null()));
            assert_eq!(e["error"], "the seed is null");
            daedalus_free(std::ptr::null_mut());
        }
    }

    /// The one instance is the process's: everything that starts it is one
    /// test.
    #[test]
    fn start_status_report_and_stop() {
        let stopped = json!({
            "running": false, "tunnel": null, "connections": 0,
            "link": {"state": "off", "connected": false, "controller": null, "pin": null, "error": null},
        });
        assert_eq!(take(daedalus_status()), stopped);
        daedalus_stop();
        // SAFETY: valid C strings, or null on purpose.
        unsafe {
            let (early, not_utf8) = (c("{"), CString::new(vec![0xff, 0xfe]).unwrap());
            for (bad, why) in [
                (std::ptr::null(), "the config is null"),
                (early.as_ptr(), "the config: it ends early"),
                (not_utf8.as_ptr(), "the config is not UTF-8"),
            ] {
                let e = take(daedalus_start(bad));
                assert!(e["error"].as_str().unwrap().starts_with(why), "{e}");
            }
            let e = take(daedalus_report(c("{}").as_ptr()));
            assert_eq!(e["error"], "not started");
            assert_eq!(take(daedalus_leave())["error"], "not started");

            // Before pairing: the tunnel and the proxy alone.
            let started = take(daedalus_start(c(&config_json("null")).as_ptr()));
            let proxy = &started["ok"]["proxy"];
            assert!(proxy["port"].as_u64().unwrap() > 0, "{started}");
            assert_eq!(proxy["username"].as_str().unwrap().len(), 32);
            assert_eq!(proxy["password"].as_str().unwrap().len(), 32);
            let s = take(daedalus_status());
            assert_eq!(s["running"], true);
            assert_eq!(s["tunnel"]["endpoint"], "box.example.org:51820");
            assert_eq!(s["tunnel"]["address"], "10.8.0.2");
            assert_eq!(s["link"], stopped["link"]);
            let e = take(daedalus_report(c("{}").as_ptr()));
            assert!(e["error"].as_str().unwrap().contains("not paired"), "{e}");

            // Paired: a new start replaces the old one — another port,
            // another credential — and the link is on (and reaching nobody:
            // the endpoint is no box).
            let me = Identity::from_seed([7; 32]);
            let ctl = Identity::from_seed([8; 32]).fingerprint();
            let paired = config_json(&node(
                &hex::encode(*me.seed()),
                &ctl,
                "192.168.0.2:7788",
                "ios",
            ));
            let again = take(daedalus_start(c(&paired).as_ptr()));
            assert_ne!(again["ok"]["proxy"]["password"], proxy["password"]);
            let s = take(daedalus_status());
            assert_eq!(s["link"]["state"], "connecting");
            assert_eq!(s["link"]["pin"], ctl.as_str());
            assert_eq!(s["link"]["connected"], false);
            assert_eq!(
                take(daedalus_report(c(r#"{"sampled_at":"t"}"#).as_ptr())),
                json!({"ok": true})
            );
            for (bad, why) in [("[1]", "not a JSON object"), ("nope", "not JSON")] {
                let e = take(daedalus_report(c(bad).as_ptr()));
                assert!(e["error"].as_str().unwrap().contains(why), "{e}");
            }
            let e = take(daedalus_report(
                c(&format!("{{\"x\":\"{}\"}}", "y".repeat(MAX_TELEMETRY))).as_ptr(),
            ));
            assert!(e["error"].as_str().unwrap().contains("at most"), "{e}");
            let e = take(daedalus_report(std::ptr::null()));
            assert_eq!(e["error"], "the telemetry is null");

            // A config that does not check leaves what runs alone.
            let e = take(daedalus_start(
                c(&paired.replace("\"os\":\"ios\"", "\"os\":\"x\"")).as_ptr(),
            ));
            assert!(e["error"].as_str().unwrap().contains("hello.os"), "{e}");
            assert_eq!(take(daedalus_status())["running"], true);
        }
        // Unpairing with no box to hear it: not sent, and everything stops.
        let started = std::time::Instant::now();
        assert_eq!(take(daedalus_leave()), json!({"ok": {"sent": false}}));
        assert!(started.elapsed() < std::time::Duration::from_secs(20));
        assert_eq!(take(daedalus_status()), stopped);
        let started = std::time::Instant::now();
        daedalus_stop();
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
        assert_eq!(take(daedalus_status()), stopped);
        daedalus_stop();
    }
}
