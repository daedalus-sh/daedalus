/*
 * daedalus_ios.h — the daedalus iOS app as a light node of a box
 * (ios/core, module DaedalusCoreFFI): its identity key, its userspace
 * WireGuard tunnel to the box, its link to the controller, and a loopback
 * HTTP CONNECT proxy for URLSession.
 *
 * Every function that answers returns a heap string of JSON, UTF-8 and
 * NUL-terminated, which the caller frees with daedalus_free: the answer
 * ({"ok":…}, or the status document) or {"error":"<one line>"}. No call
 * crashes the app: a null or non-UTF-8 argument, or a failure inside, is an
 * error answer. One instance per process; any thread may call. Call
 * daedalus_start and daedalus_stop off the main thread: they wait for
 * threads to end (a stop for up to a few seconds).
 *
 * The JSON of each call is in ios/core/src/config.rs (the config),
 * ios/core/src/lib.rs (the status) and ios/core/src/ffi.rs.
 */
#ifndef DAEDALUS_IOS_H
#define DAEDALUS_IOS_H

#ifdef __cplusplus
extern "C" {
#endif

/*
 * A new identity key:
 *   {"ok":{"seed":"<64 hex>","public_key":"<64 hex>","node_id":"<16 hex>",
 *          "fingerprint":"<16 groups of 4 hex joined by ':'>"}}
 * The seed IS the device's identity: keep it in the Keychain and pass it in
 * every config.
 */
char *daedalus_identity_new(void);

/* The same answer for a seed the app already holds (64 hex characters). */
char *daedalus_identity_describe(const char *seed_hex);

/*
 * Start: the tunnel, the loopback proxy and — when the config names a node —
 * the link to the controller. Starting while running replaces the old
 * instance. config_json:
 *   {"wireguard":{"private_key":"…","address":"10.8.0.7/24",
 *                 "server_public_key":"…","preshared_key":"…" (optional),
 *                 "endpoint":"host:port","allowed_ips":["a.b.c.d/32"]},
 *    "proxy_port":443,
 *    "node":null | {"seed":"<64 hex>",
 *                   "controller":{"pin":"<fingerprint>","address":"a.b.c.d:7788"},
 *                   "hello":{"hostname":"…","os":"ios"|"ipados","arch":"arm64",
 *                            "agent_version":"1.0.0","model":"iPhone17,1",
 *                            "os_name":"iOS" (optional),"os_version":"27.0" (optional)}}}
 * Answer: {"ok":{"proxy":{"port":<u16>,"username":"<32 hex>","password":"<32 hex>"}}}
 * The proxy listens on 127.0.0.1:<port>, takes CONNECT alone, and wants
 * Proxy-Authorization: Basic with that credential, which is new at every
 * start (loopback on iOS is shared between apps). Whatever host a CONNECT
 * names it reaches the box at proxy_port.
 */
char *daedalus_start(const char *config_json);

/*
 * Hand the link a telemetry sample, the device's part of the Telemetry
 * document (agent/src/telemetry/model.rs) as JSON; all of it optional:
 *   {"sampled_at":"<RFC 3339 UTC>",
 *    "machine":{"manufacturer":"Apple","model":"iPhone17,1","form":"phone"|"tablet"},
 *    "os":{"build":"24A335","kernel":"…"},
 *    "memory":{"total_bytes":…,"used_bytes":…,"available_bytes":…},
 *    "disks":[{"mount":"/","total_bytes":…,"free_bytes":…,"used_bytes":…}],
 *    "battery":{"percent":0-100,"charging":bool,"low_power":bool}}
 * Sent now if the link is up and approved, else as soon as it is, and again
 * every minute until the next sample. Answer: {"ok":true}
 */
char *daedalus_report(const char *telemetry_json);

/*
 * How everything stands; never an error answer:
 *   {"running":bool,
 *    "tunnel":null | {"endpoint":"host:port","resolved":"ip:port"|null,
 *                     "address":"10.8.0.7","last_handshake_secs":<u64>|null,
 *                     "rx_bytes":<u64>,"tx_bytes":<u64>,"error":"…"|null},
 *    "link":{"state":"off"|"connecting"|"pending"|"approved"|"revoked"
 *                    |"refused"|"key-changed",
 *            "connected":bool,
 *            "controller":null | {"version":"…","hostname":"…"},
 *            "pin":"<fingerprint>"|null,
 *            "error":"…"|null},
 *    "connections":<n>}
 * running turns false when iOS took the proxy's socket (the app was
 * suspended): start again. link.pin is the controller key trusted now: when
 * it differs from the config's, the controller rotated its key — keep the
 * new one and pass it from then on.
 */
char *daedalus_status(void);

/*
 * Unpair this device: tell the controller it leaves and asks to be
 * forgotten (the box deletes the device and its WireGuard client), waiting
 * up to five seconds for the link to be up and the controller to say it
 * heard — then stop everything, heard or not. Call it off the main thread.
 * Answer: {"ok":{"sent":bool}}; sent false means the box still lists the
 * device until an admin removes it. An error only when nothing was started.
 * The app deletes its keys afterwards either way.
 */
char *daedalus_leave(void);

/* Stop everything and wait for its threads. Idempotent. */
void daedalus_stop(void);

/* Free a string one of these functions returned. NULL is ignored. */
void daedalus_free(char *s);

#ifdef __cplusplus
}
#endif

#endif /* DAEDALUS_IOS_H */
