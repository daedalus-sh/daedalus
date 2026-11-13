# The native app's contract with the box

Everything the iPhone and iPad app exchanges with the control plane: the pair
link, the redeem, and `/api/v1`. The server side is `app/src/host/pair.ts`,
`app/src/host/node-tokens.ts` and `app/src/host/api/v1/`; the response types
below are `app/src/lib/api-v1.ts`, spelled out. A change to either is a
change here in the same commit, with a line under [Changes](#changes).

The link to the controller (the node's ed25519 key, its hello, its telemetry)
is the agent's protocol and is not described here: `agent/README.md`.

## Contents

- [Transport](#transport)
- [Pairing](#pairing): [the link](#the-pair-link), [the redeem](#post-apinodepair)
- [`/api/v1`](#apiv1): [auth](#auth), [errors](#errors), [conventions](#conventions)
- Endpoints: [me](#get-apiv1me) · [overview](#get-apiv1overview) ·
  [alerts](#get-apiv1alerts) · [errors](#get-apiv1errors) · [logs](#get-apiv1logs) ·
  [updates](#updates) · [apply](#apply) · [machines](#machines) ·
  [claude](#claude) · [apps](#get-apiv1apps)
- [Changes](#changes)

## Transport

The app reaches the box through its own WireGuard tunnel, which it runs
in-process from the config in the pair link. The tunnel carries exactly two
destinations, both at the box's LAN address (`wireguard.allowed_ips[0]`
without its `/32`):

| Port | What |
|---|---|
| 443/tcp | traefik: `POST /api/node/pair` and `/api/v1/*`, HTTPS |
| the port in `controller.address` | the controller's link (the agent's protocol) |

Nothing else at that address answers (the tunnel's firewall drops it), and
no DNS is reachable. So every HTTPS request is made **to the LAN address,
port 443, with the hostname of `app` as both TLS SNI and `Host`**; the
certificate is a public one for that hostname and is verified normally.

All bodies are JSON, UTF-8. Send `Content-Type: application/json` with a
body. Every response carries `Cache-Control: no-store`.

## Pairing

An admin presses **Add a phone or tablet** on Settings › Machines. The box
makes a WireGuard client confined to the two ports above and a single-use
ticket, and shows them once as a QR code. The ticket lives 5 minutes and is
spent by its first redeem, right or wrong.

1. Scan the QR code and decode [the link](#the-pair-link).
2. Generate the node's ed25519 key (kept in the Keychain; a device that is
   pairing again reuses its key).
3. Bring the tunnel up from `wireguard`.
4. [Redeem](#post-apinodepair) the ticket through the tunnel.
5. Keep the `token`, the `controller` pin and address, `app` and the tunnel
   config. Link to the controller, pinning its key.

### The pair link

```
daedalus://pair?p=<base64url(UTF-8 JSON), unpadded>
```

```ts
type PairPayload = {
  v: 1
  /** The control plane's origin, "https://<hostname>": SNI and Host of every call. */
  app: string
  /** The box's hostname, to show. */
  box: string
  /** The single-use ticket: 43 characters of [A-Za-z0-9_-]. */
  code: string
  wireguard: {
    /** The device's WireGuard private key, base64. Exists here and in wg-easy only. */
    private_key: string
    /** The device inside the tunnel, "a.b.c.d". */
    address: string
    server_public_key: string
    /** Absent when the server sets none. */
    preshared_key?: string
    /** "host:port", UDP. */
    endpoint: string
    /** Exactly one entry: "<the box's LAN address>/32". */
    allowed_ips: string[]
  }
}
```

A payload whose `v` is not `1` is from a newer box: refuse it and say the app
needs an update. Use MTU 1280 and a persistent keepalive of 25 s.

```json
{
  "v": 1,
  "app": "https://daedalus-app.example.org",
  "box": "s2-server",
  "code": "q0b3yJ0Qm1cXwq2m3Cw0n8l1v2o9d5t7u4s6r8a0bCd",
  "wireguard": {
    "private_key": "oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=",
    "address": "10.8.0.9",
    "server_public_key": "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=",
    "preshared_key": "FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=",
    "endpoint": "s2.example.org:51820",
    "allowed_ips": ["192.168.0.2/32"]
  }
}
```

### `POST /api/node/pair`

No `Authorization` header: the ticket is the authorization. The body is at
most 4096 bytes and holds exactly these seven fields; anything else is
refused.

```ts
type PairRequest = {
  /** `code` from the link. */
  code: string
  /** The node's ed25519 public key: 64 lowercase hex characters. */
  public_key: string
  /** The device's name ("Santi’s iPhone"): 1 to 253 characters, no control characters. */
  hostname: string
  /** `watchos` only on a watch's list (`AccessoryView.osReleases`). */
  os: 'ios' | 'ipados' | 'watchos'
  /** `[a-z0-9_]{1,16}`: "arm64". */
  arch: string
  /** The app's version: `[0-9A-Za-z][0-9A-Za-z.+-]{0,31}`. */
  version: string
  /** The device identifier ("iPhone17,1"): 1 to 64 characters, no control characters. */
  model: string
}

type PairResponse = {
  /** The node id the box approved: the first 16 hex characters of SHA-256(public key bytes). Not this device's: stop. */
  node: string
  controller: {
    /** The controller key's fingerprint to pin: SHA-256 of the key, hex in groups of four joined by ":". */
    pin: string
    /** "<LAN address>:<port>", through the tunnel. */
    address: string
  }
  box: { hostname: string }
  /** The node's API token, "dnode_" + 43 characters. Exists only in this answer. */
  token: string
}

type PairError = { error: string }
```

| Status | When |
|---|---|
| 200 | Paired. |
| 400 | The body is malformed, the code is unknown, used or expired, or a field is not as above. |
| 409 | `public_key` belongs to a machine that is not a phone or tablet. |
| 413 | The body is over 4096 bytes. |
| 502 | The controller did not take the approval, or the pairing could not be recorded. |
| 503 | The box cannot make tunnels. |
| 500 | Anything else. |

Every failure after a well-formed `code` was presented has spent the ticket
and deleted its tunnel: the only way forward is a new QR code. The `error`
sentence says so ("…; add the device again") and is fit to show.

**Pairing again.** A device that pairs again with the same key keeps its node
id: its old tunnel is deleted, its old token stops working, and it is approved
again if it had been revoked. So "pair again" is the recovery for a lost
token, a deleted tunnel or a revoke.

**Leaving.** Revoke and Forget on Settings › Machines, and the node's own
`leave` over the link, delete the token and the tunnel. After that
`/api/v1` answers 401 and the tunnel carries nothing.

## `/api/v1`

### Auth

```
Authorization: Bearer dnode_…
```

on every request. A missing, unknown or malformed token, and the token of a
node that is no longer approved, all answer the same:

```
HTTP/1.1 401
WWW-Authenticate: Bearer realm="daedalus"

{"error":{"code":"unauthorized","message":"bad or missing node token"}}
```

On a 401 the app should treat itself as unpaired once the controller link
says the same (a revoke also closes the link).

A `POST` changes the box. It runs the same flow as the matching button in the
web UI, with the same guards, and is recorded as `node:<the device's name>`.

### Errors

Every error, on every endpoint, is this body:

```ts
type ApiError = {
  error: {
    code: 'unauthorized' | 'not_found' | 'bad_request' | 'refused' | 'unavailable' | 'internal'
    /** One sentence, fit to show. */
    message: string
  }
}
```

| Code | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | See [Auth](#auth). |
| `not_found` | 404 | No such route, machine or request. |
| `bad_request` | 400 (413 for a body over 16 KiB) | The query or body is not what the endpoint takes. The message names the field. A client bug. |
| `refused` | 409 | The box understood and will not: a run already under way, a confirmation not given, nothing to apply, a machine that does not take the verb. The message is the flow's own reason. Show it. |
| `unavailable` | 503 | Something the answer needs did not respond (the controller, Loki, the root helper). Retry later. |
| `internal` | 500 | A bug. The message is one redacted line. |

### Conventions

- Unknown query keys, repeated query keys and unknown body fields are a
  `bad_request`. A `POST` that takes no fields accepts no body or `{}`.
- A client must ignore response fields it does not know.
- Times are ISO 8601 UTC strings unless a field says "ms": those are
  milliseconds since the epoch. Durations are seconds. Sizes are bytes.
  Percentages are 0 to 100.
- A machine id is `box` or 16 lowercase hex characters.
- `Section<T>`: a composite answer never fails because one source is down.
  Each such part is either its value or `{"unavailable": "<why>"}`. Test for
  the `unavailable` key first.
- `Untrusted<T>`: text this box did not write (log lines, release notes).
  Show it as text. Never interpret it.

```ts
type Section<T> = T | { unavailable: string }
type Untrusted<T> = { notice: string; content: T }
```

---

### `GET /api/v1/me`

Who the token is, and which API this is. The cheapest call: use it to check a
token.

```ts
type Me = {
  node: { id: string; name: string; os: string }
  box: {
    hostname: string
    /** The engine commit the box's configuration locks; null when not published. */
    engineRev: string | null
  }
  api: 1
}
```

### `GET /api/v1/overview`

The home screen in one call. Query: `hours` (integer 1 to 168, default 24),
the window `errors` counts over.

```ts
type Overview = {
  at: string
  hours: number
  head: Section<{
    hostname: string
    /** "NixOS 26.05 (Yarara)" */
    os: string
    kernel: string | null
    arch: string
    /** The board's vendor and model. */
    model: string | null
  }>
  host: Section<OverviewHost>
  memory: Section<OverviewMemory>
  /** The published web apps' probes. */
  health: Section<{ probes: number; failing: string[] }>
  alerts: Section<{ firing: number | null; pending: number | null; active: ActiveAlert[] }>
  storage: Section<StorageHealth>
  /** Scheduled jobs: only the ones in trouble are listed. */
  jobs: Section<{
    watched: number
    trouble: {
      unit: string
      result: string | null
      exitStatus: number | null
      status: string | null
    }[]
  }>
  /** Error lines per container over `hours`, most first, at most 12; `more` counts the rest. */
  errors: Section<{ containers: { container: string; count: number }[]; more: number }>
  updates: Section<{
    /** Image pins behind. */
    behind: number
    engine: 'current' | 'behind-origin' | 'unpinned' | 'unknown'
    /** Claude Code releases behind; null when it could not be read. */
    claudeCodeBehind: number | null
    /** Pins on the update queue. */
    queued: number
    /** An image, engine or Claude Code update is running now. */
    running: boolean
  }>
  apply: Section<{
    /** How many things the next Apply would change. 0: nothing to apply. */
    pending: number
    changed: { name: string; fields: string[] }[]
    state: 'idle' | 'running' | 'done' | 'failed'
    phase: string
    /** The last Apply needs a reboot the box has not had. */
    rebootPending: boolean
  }>
}

type OverviewHost = {
  cpuPct: number | null
  /** Processor busy, six hours at two-minute steps, oldest first. */
  cpuSpark: number[]
  cores: number | null
  load: { m1: number | null; m5: number | null; m15: number | null }
  uptimeSeconds: number | null
  /** The six hottest sensors, °C. */
  temps: { label: string; value: number }[]
  /** Share of the last five minutes something waited on each, 0 to 100. */
  pressure: { cpu: number | null; io: number | null; memory: number | null }
  containers: { total: number | null; down: string[] }
  failedUnits: { unit: string; description: string | null; subState: string | null }[]
}

type OverviewMemory = {
  totalBytes: number | null
  usedBytes: number | null
  availableBytes: number | null
  /** ZFS's cache: counted in usedBytes, handed back on demand. */
  arcBytes: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  /** Containers the kernel has killed for memory, ever. */
  oomKills: number | null
}

type StorageHealth = {
  pools: {
    name: string
    /** "ONLINE", "DEGRADED", … */
    health: string
    capacityPct: number
    freeBytes: number
    scrub: {
      state: string | null
      /** Seconds since the epoch. */
      startedAt: number | null
      endedAt: number | null
      examined: number | null
      errors: number | null
    } | null
  }[]
  snapshots: { count: number; bytes: number }
  disks: {
    device: string
    model: string | null
    /** SMART's own verdict; null when the drive could not be asked. */
    passed: boolean | null
    temperature: number | null
  }[]
  smartdActive: boolean | null
}

type ActiveAlert = { name: string; folder: string; severity: string; summary: string }
```

```json
{
  "at": "2026-11-12T19:04:11.512Z",
  "hours": 24,
  "head": { "hostname": "s2-server", "os": "NixOS 26.05 (Yarara)", "kernel": "6.18.60", "arch": "x86_64", "model": "MSI PRO Z790-P" },
  "host": {
    "cpuPct": 6.4, "cpuSpark": [5.1, 7.9, 6.2], "cores": 20,
    "load": { "m1": 1.2, "m5": 1.4, "m15": 1.3 }, "uptimeSeconds": 412334,
    "temps": [{ "label": "coretemp temp1", "value": 47 }],
    "pressure": { "cpu": 0.1, "io": 0, "memory": 0 },
    "containers": { "total": 96, "down": [] },
    "failedUnits": []
  },
  "memory": { "totalBytes": 67282206720, "usedBytes": 41200000000, "availableBytes": 26082206720, "arcBytes": 17179869184, "swapUsedBytes": 0, "swapTotalBytes": 33641103360, "oomKills": 0 },
  "health": { "probes": 61, "failing": [] },
  "alerts": { "unavailable": "Grafana did not answer" },
  "storage": {
    "pools": [{ "name": "rpool", "health": "ONLINE", "capacityPct": 41, "freeBytes": 1100000000000, "scrub": { "state": "finished", "startedAt": 1794000000, "endedAt": 1794003600, "examined": 800000000000, "errors": 0 } }],
    "snapshots": { "count": 812, "bytes": 52000000000 },
    "disks": [{ "device": "nvme0n1", "model": "Samsung SSD 990 PRO 2TB", "passed": true, "temperature": 41 }],
    "smartdActive": true
  },
  "jobs": { "watched": 34, "trouble": [] },
  "errors": { "containers": [{ "container": "sonarr", "count": 14 }], "more": 0 },
  "updates": { "behind": 3, "engine": "current", "claudeCodeBehind": 0, "queued": 0, "running": false },
  "apply": { "pending": 0, "changed": [], "state": "idle", "phase": "", "rebootPending": false }
}
```

### `GET /api/v1/alerts`

What is firing now, and what fired in the window. Query: `hours` (1 to 168,
default 24).

```ts
type Alerts = {
  hours: number
  firing: number | null
  pending: number | null
  active: ActiveAlert[]
  /** Rules that sent a notification in the window, by rule uid. */
  firedRecently: { rule: string; notifications: number }[]
}
```

### `GET /api/v1/errors`

Error lines by container, without known noise or the nightly reset. Query:
`hours` (1 to 168, default 24). Slow (several log queries): not for a home
screen. `503 unavailable` when Loki does not answer.

```ts
type Errors = Untrusted<{
  hours: number
  /** The nightly reset's window, taken out of the counts. */
  excludedDailyReset: { at: string | null; lines: number }
  /** Most first, at most 12. */
  containers: { container: string; count: number }[]
  moreContainers: number
  /** The five noisiest, each with up to three line shapes (secrets redacted, numbers folded). */
  top: { container: string; count: number; lines: string[] }[]
}>
```

### `GET /api/v1/logs`

One container's lines, newest first.

| Query | |
|---|---|
| `container` | Required. `[A-Za-z0-9][A-Za-z0-9_.-]{0,127}` |
| `text` | Optional, at most 200 characters: only lines holding it. |
| `hours` | 1 to 168, default 24. |
| `limit` | 1 to 200, default 50. |

```ts
/** Each line is redacted and cut at 500 characters. */
type Logs = Untrusted<{ at: string; line: string }[]>
```

`409 refused` for a container that carries private messages (its name starts
`matrix` or `proton`).

---

## Updates

### `GET /api/v1/updates`

Everything behind, the queue, and how the running or last update stands.

```ts
type Updates = {
  /** When the registry probe last ran. */
  checkedAt: string | null
  /** The probe has never answered: `images` says nothing. */
  probeMissing: boolean
  /** `images.length`. */
  behind: number
  images: PendingImage[]
  engine: {
    verdict: 'current' | 'behind-origin' | 'unpinned' | 'unknown'
    /** The locked commit, 12 characters. */
    pinned: string | null
    /** Commits origin has that the box's clone has not. */
    behindOrigin: number | null
    /** A developer override is on: the engine update is refused. */
    override: boolean
  }
  claudeCode: { installed: string | null; latest: string | null; behind: number } | null
  queue: QueueItem[]
  status: UpdatesStatus
}

type PendingImage = {
  /** The pin's name: a container, or the id of a pinned base image. */
  container: string
  /** The version running. */
  running: string | null
  tag: string | null
  /** The tag an update moves to by default. */
  target: string | null
  verdict: 'tag-moved' | 'newer-tag' | 'current' | 'unknown'
  /** Up to five newer tags, newest first: what `toTag` may be. */
  newer: string[]
  /** False: moved by hand, not from here. */
  updatable: boolean
  /** Non-null: what else this update takes down. It needs a confirmation (below). */
  ceremony: string | null
  /** Non-null: the same, but only for a move to a new major version. */
  majorCeremony: string | null
  /** Pins that move with this one in the same update. */
  movesWith: string[]
  hasChangelog: boolean
}

type QueueItem = {
  container: string
  /** Null: re-pull the tag it is on. */
  toTag: string | null
  tag: string
  lockstep: string[]
  ceremony: string | null
  /** The confirmation given when it was queued. */
  typed: string
}

type UpdatesStatus = {
  images: ImageUpdateStatus
  engine: PinUpdateStatus
  claudeCode: PinUpdateStatus
}

type RunStatus = {
  /** The run's id, as the POST that started it answered; null when idle. */
  id: string | null
  state: 'idle' | 'running' | 'done' | 'failed'
  /** Where the run is, in the host's words ("building", "verifying", "reboot-required"). */
  phase: string
  /** Why it failed; "" otherwise. */
  error: string
  startedAt: string | null
  finishedAt: string | null
  /** The commit it made in the configuration, short. */
  commit: string | null
}

type ImageUpdateStatus = RunStatus & {
  /** The pins the request named. */
  targets: string[]
  /** Every pin the run moves, lockstep members included. */
  moves: {
    container: string
    repo: string
    fromTag: string
    fromDigest: string
    toTag: string
    toDigest: string
    changed: boolean
  }[]
}

/** `from` and `to` are revs (engine) or versions (Claude Code); "" until the host resolved them. */
type PinUpdateStatus = RunStatus & { from: string; to: string }
```

**The confirmation ("ceremony").** Some pins take other things down with
them (`ceremony`: "restarts the shared database every app uses"). Moving one
requires the pin's own name, sent back exactly:

- queueing it: `add.confirm` = the pin's `container`;
- running it directly: `confirm` holds the pin's `container`.

It is required when `ceremony` is non-null, and when `majorCeremony` is
non-null and `toTag`'s leading number differs from `tag`'s. Show the user the
`ceremony` text and have them type the name. Without it the **run** answers
`409 refused` with `Updating <container> <ceremony>. Pass confirm:
"<container>" to proceed.` (queueing does not check: the queue stores what was
typed, and the run decides).

### `GET /api/v1/updates/status`

`UpdatesStatus` alone: what to poll while a run is `running` (every 2 to 5 s).

### `GET /api/v1/updates/changelog`

Query: `container` (a pin's name). What changed between the running version
and the newest.

```ts
type Changelog = Untrusted<
  | { container: string; repo: null; note: string }
  | {
      container: string
      /** "owner/repo" */
      repo: string | null
      installed: string | null
      latest: string | null
      /** Newest first, at most 8. */
      releases: {
        version: string
        date: string
        url: string
        sections: { name: string; items: string[] }[]
        truncated: boolean
      }[]
      /** For a pin built from a commit rather than a release. */
      commits: { sha: string; date: string; subject: string; url: string }[]
      /** Why the list is short (GitHub's rate limit, mostly). */
      note: string | null
    }
>
```

### `POST /api/v1/updates/queue`

Change the queue the web UI and the app share. Exactly one of the three
fields.

```ts
type QueueRequest =
  | { add: { container: string; toTag?: string; confirm?: string } }
  | { remove: string }
  | { clear: true }

type QueueAnswer = { queue: QueueItem[] }
```

`add` without `toTag` re-pulls the tag the pin is on. `409 refused` when the
pin is unknown, is moved by hand, or already moves with a queued one.

### `POST /api/v1/updates/run`

Start one update: the queue, or the targets named.

```ts
type RunRequest = {
  /** Absent: run the queue (then `confirm` must be absent too). 1 to 64. */
  targets?: { container: string; toTag?: string }[]
  /** The names typed, for targets that need one. */
  confirm?: string[]
}

type UpdateStarted = { id: string; targets: { container: string; toTag: string | null }[] }
```

Several targets are one commit, one build, one switch, and one failure
reverts all of them. Answers as soon as the host started; follow
`status.images`. The queue empties once the host took it. `409 refused`: an
update is already running, a confirmation is missing, the queue is empty, a
target is not pinned.

### `POST /api/v1/updates/engine`

Move the engine's pin to its newest commit and rebuild. No body.
`{ "id": string }`; follow `status.engine`. `409 refused` while an override is
on or a run is under way.

### `POST /api/v1/updates/claude-code`

Pin the newest Claude Code release. No body. `{ "id": string }`; follow
`status.claudeCode`, then `status.engine` (the rebuild that installs it).

---

## Apply

An Apply commits what was edited in the web UI (apps, site settings,
machines) and rebuilds the box.

### `GET /api/v1/apply`

```ts
type PendingApply = {
  /** What the next Apply would change; empty: nothing to apply. `name` is an app, "site" or "nodes". */
  changed: { name: string; fields: string[] }[]
  status: RunStatus & {
    /** Present and true: the last Apply ended `reboot-required` and the box has not rebooted since. */
    rebootPending?: boolean
  }
}
```

### `POST /api/v1/apply`

No body. `{ "id": string, "changed": { name: string; fields: string[] }[] }`;
poll `GET /api/v1/apply` until `status.state` leaves `running`. `409 refused`
when there is nothing to apply or one is running.

### `POST /api/v1/apply/discard`

No body. Drops the pending edits, back to what the last Apply built.

```ts
type ApplyDiscarded = {
  discarded: string[]
  /** What is not an edit and stays: an app created since, the machines. */
  kept: string[]
}
```

---

## Machines

### `GET /api/v1/machines`

The box first, then every machine the box has decided about (approved or
revoked), in the order they joined. A phone's watch is listed as a machine of
its own, directly after its phone (`kind: 'accessory'`, below).

```ts
type Machines = { machines: MachineItem[] }

type MachineItem = {
  /** "box", a node id (16 hex), or an accessory's: its phone's node id, then ".watch". */
  id: string
  /** 'accessory': a watch, listed as its own machine and reported through its phone. */
  kind: 'box' | 'node' | 'accessory'
  name: string
  /** "linux" | "macos" | "windows" | "ios" | "ipados", and "watchos" for an accessory */
  os: string
  arch: string
  /** The agent's version: the controller's on the box, the native app's on a phone. */
  agentVersion: string | null
  state: 'approved' | 'revoked'
  /** Its link is up now; null when the controller could not be asked. Always true for the box. */
  connected: boolean | null
  /** Seconds since the box last heard from it; 0 for the box. */
  lastSeenAgo: number
  lastSeenAt: string
  /** A phone or tablet. For it, not connected is the normal state: show "last seen", never a fault. */
  light: boolean
  /** The machine this token belongs to. */
  self: boolean
  /** The device identifier of a phone, the board of the box; null otherwise. */
  model: string | null
  /** The agent release waiting there, when one is. */
  updateAvailable: string | null
  restartPending: boolean
  /** Claude Code there; null without a report, and always for a phone. */
  claude: ClaudeSummary | null
  /** A phone's last reported battery; null otherwise. */
  battery: { percent: number | null; charging: boolean | null } | null
  /** A phone's paired watch, as the phone last reported it; empty for every other machine and for a phone without one. */
  accessories: AccessoryItem[]
  /** The machine that reports this one; null for the box and for every node. */
  via: { id: string; name: string } | null
}

/** A phone's watch as a line of the phone's own item. The same watch is also the next item of the list. */
type AccessoryItem = {
  kind: 'watch'
  /** What its owner called it ("Santiago’s Apple Watch"); null when the phone did not say. */
  name: string | null
  battery: { percent: number | null; charging: boolean | null } | null
}

type ClaudeSummary = {
  /** off | not-installed | starting | running | waiting | stopped | no-session | unknown */
  state: string
  detail: string | null
  cliVersion: string | null
  serverVersion: string | null
  /** Sessions alive now. */
  sessions: number
  startedAt: string | null
  signedIn: boolean
}
```

**An accessory's item.** A watch has no key, no link and no agent: the box
knows it only through its phone, and lists it as a machine so the app can
give it a row and a page. Its item, directly after its phone's:

| field | value |
|---|---|
| `id` | `<phone id>.watch`. One watch per phone. |
| `kind` | `'accessory'` |
| `name` | Its display name: the one set on Settings › Machines, else the name the watch reports, else `"Apple Watch"`. |
| `os` | `"watchos"` |
| `arch` | `""` |
| `agentVersion` | `null` |
| `state` | Its phone's. It is listed only while its phone is approved and reports a watch, so `'approved'`. |
| `connected` | `null`: the box holds no link to it. |
| `lastSeenAgo`, `lastSeenAt` | From the watch's own reading time (`AccessoryView.at`), not its phone's. |
| `light` | `true`: show "as of", never a fault. |
| `self` | `false` |
| `model` | The watch's device identifier (`"Watch7,5"`), or `null`. |
| `updateAvailable`, `restartPending`, `claude` | `null`, `false`, `null` |
| `battery` | The watch's. |
| `accessories` | `[]` |
| `via` | `{ id, name }` of its phone. |

The phone's own `accessories` (and its detail's `device.accessories`) still
carry the watch, as before.

### `GET /api/v1/machines/:id`

`:id` is `box`, a node id, or an accessory's id (`<phone id>.watch`).
`404 not_found` for an unknown one, and for a phone that has no watch.

```ts
type MachineDetail =
  | {
      machine: MachineItem
      kind: 'box'
      host: Section<OverviewHost>
      memory: Section<OverviewMemory>
      storage: Section<StorageHealth>
    }
  | {
      machine: MachineItem
      kind: 'node'
      /** Null while the controller holds no telemetry for it (not connected since it restarted). */
      system: MachineSystem | null
      /** Processor busy, six hours at two-minute steps; empty for a phone. */
      cpuSpark: number[]
      /** A phone or tablet only; null otherwise, and until it first reported. */
      device: DeviceView | null
      /** A phone or tablet only: what Apple has published past its OS. Null until its OS version is known. */
      osReleases: AppleOsReleases | null
      /** Why there is no `system`, in a line; null when there is one. */
      note: string | null
    }
  | {
      machine: MachineItem
      kind: 'accessory'
      /** The watch's facts and its watchOS releases (the existing AccessoryView). */
      accessory: AccessoryView
      via: { id: string; name: string }
    }

/** What a machine's agent last reported, condensed. */
type MachineSystem = {
  sampledAt: string
  /** "macOS", "Windows 11 Pro", "iOS" */
  osName: string
  /** "26.1 (25B78)" */
  osVersion: string
  kernel: string | null
  cpu: string
  cpuPct: number | null
  uptimeSeconds: number | null
  bootedAt: string | null
  model: string | null
  /** "laptop" | "desktop" | "tower" | "mini" | "all-in-one" | "server" | "tablet" */
  form: string | null
  memory: { totalBytes: number | null; usedBytes: number | null; availableBytes: number | null }
  disks: {
    mount: string
    name: string | null
    totalBytes: number | null
    usedBytes: number | null
    freeBytes: number | null
  }[]
  battery: {
    percent: number | null
    charging: boolean | null
    healthPct: number | null
    cycles: number | null
    condition: string | null
  } | null
  temperatures: { label: string; celsius: number }[]
  /** Updates the OS has pending; null when its updater was not read. */
  osUpdatesPending: number | null
  osRebootPending: boolean | null
}

/** What a phone or tablet last said about itself, kept by the box while it is away. */
type DeviceView = {
  model: string | null
  osVersion: string | null
  appVersion: string | null
  battery: { percent: number | null; charging: boolean | null } | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  memoryBytes: number | null
  /** Its paired watch, as its last sample listed it; empty when it has none. */
  accessories: AccessoryView[]
  /** When the box read it. */
  at: string
}

/** A watch: what its phone last said about it, and what Apple has published past its watchOS. `name` is the reported one, not the display name. */
type AccessoryView = AccessoryItem & {
  /** The device identifier: "Watch7,5". */
  model: string | null
  /** "26.1" */
  osVersion: string | null
  /** "23S37" */
  osBuild: string | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  /** When the watch read these facts. They reach the box only through its phone, so this can be old. */
  at: string
  /** The same shape as the phone's, with `os: 'watchos'`. Null when the watch has not said which watchOS it runs. */
  osReleases: AppleOsReleases | null
}

type AppleOsReleases = {
  /** `watchos` only on a watch's list (`AccessoryView.osReleases`). */
  os: 'ios' | 'ipados' | 'watchos'
  current: { version: string; build: string | null }
  /** The newest version Apple has published; null when Apple's table did not answer. */
  latest: string | null
  /** How many published releases are newer than `current`. */
  behind: number
  /** Newer than `current`, newest first, at most 8. */
  releases: {
    version: string
    build: string | null
    /** "YYYY-MM-DD" */
    date: string | null
    /** Apple's developer release notes. */
    notesUrl: string | null
    /** Apple's security-content page. */
    securityUrl: string | null
    cves: number | null
    /** "23 security fixes", or Apple's own line. */
    summary: string | null
  }[]
  checkedAt: string
  source: string
  /** Why the list is empty, when Apple did not answer. */
  error: string | null
}
```

`device` is what the web UI shows for this phone, and it lags: the box reads
it from the node's telemetry once a minute while the app is connected. The
app knows its own device better than this answer does.

A watch is listed as a machine and is technically none: no key, no link, no
token, nothing the box can send it. The iPhone app receives its facts from
the watchOS app and reports them in its own telemetry sample (`accessories`,
in `ios/core/include/daedalus_ios.h`); the box keeps them with the phone's
and answers them here and under the watch's own id. Every sample replaces the
list whole: a sample without the watch is a phone without one, and its
`<phone id>.watch` is then a `404`. A phone revoked or forgotten takes its
watch with it. `at` is the watch's own reading time, so show the watch "as
of" it.

### `POST /api/v1/machines/:id/command`

One instruction to one machine's agent.

```ts
type CommandRequest = { command: 'check_update' | 'claude_update' | 'claude_restart' }

type CommandSent = {
  /** The machine is connected and acknowledged it. */
  delivered: boolean
  /** Kept for its next connection. */
  queued: boolean
}
```

`check_update`: its updater looks for an agent release now. `claude_update`:
it updates Claude Code, interrupting nothing. `claude_restart`: it restarts
Remote Control, which ends every session there (they resume by themselves).
`409 refused` for `box` (its updates are under [Updates](#updates)), for a
phone or tablet, and for an accessory (`<phone id>.watch`). `404 not_found`
for an unknown machine.

---

## Claude

### `GET /api/v1/claude`

Every machine that runs Claude Code: the box, then each approved, connected
machine that is not a phone.

```ts
type Claude = { machines: ClaudeMachine[] }

type ClaudeMachine = {
  /** "box", or a node id. */
  id: string
  name: string
  /** Remote Control there. */
  server: {
    /** off | not-installed | starting | running | waiting | stopped | no-session | not-run | no-report | unreachable | unknown */
    state: string
    detail: string | null
    /** Remote Control's own version. */
    version: string | null
    cliVersion: string | null
    /** Starts after the first, since its supervisor came up. */
    restarts: number | null
    startedAt: string | null
    signedIn: boolean
  }
  /** Claude Code against its newest release; null when GitHub was not read. */
  update: { installed: string | null; latest: string | null; behind: number } | null
  /** The sessions connected to Remote Control. */
  sessions: {
    /** The transcript's uuid: what `resume` takes. */
    id: string | null
    /** "session_…", the id claude.ai shows. */
    remoteId: string | null
    name: string | null
    cwd: string | null
    kind: string | null
    /** "idle" | "busy" */
    status: string | null
    /** ms */
    startedAt: number | null
    /** ms */
    lastActivityAt: number | null
    alive: boolean
  }[]
  /** Background agents. */
  agents: {
    /** 8 hex characters: what `stop` and `remove` take. */
    id: string
    state: string | null
    name: string | null
    cwd: string | null
    /** ms */
    startedAt: number | null
  }[]
  /** The ten most recent transcripts, newest first: what could be resumed. */
  transcripts: {
    id: string
    title: string | null
    project: string
    cwd: string
    /** ms */
    modifiedAt: number
  }[]
  /** The verbs' last requests, newest first. */
  actions: {
    request: string
    action: 'resume' | 'stop' | 'remove'
    /** The selector it was given. */
    session: string
    state: 'running' | 'done' | 'refused' | 'failed'
    detail: string
    startedAt: string
    finishedAt: string | null
  }[]
  /** Why agents, transcripts and actions are empty (no roster yet), or null. */
  note: string | null
}
```

No prompt text and no cost figures are served.

### `POST /api/v1/claude/restart`

Restart Remote Control. `machine` is a node id, or `null` or `"box"` for the
box.

```ts
type RestartRequest = { machine: string | null }
type ClaudeRestarted = { queued: boolean; delivered: boolean }
```

The box answers `queued` (its session takes it with its next report); a
machine answers `delivered` when connected, else `queued`. Every session
there ends and resumes by itself. `409 refused` when the machine runs no
Remote Control, is not approved, or is a phone.

### `POST /api/v1/claude/session`

One verb on one session.

```ts
type SessionRequest = {
  /** A node id, or null or "box" for the box. */
  machine: string | null
  action: 'resume' | 'stop' | 'remove'
  /** `resume`: a transcript's or session's `id` (a uuid). `stop`, `remove`: an agent's `id` (8 hex). */
  session: string
}

type ClaudeSessionSent = { request: string }
```

Answers at once with the request's id; the outcome arrives in the machine's
roster.

### `GET /api/v1/claude/action`

How a session verb went. Query: `request` (the id above), `machine` (a node
id or `box`; default `box`).

```ts
type ClaudeAction = {
  /** Null while the machine's roster does not list the request yet. */
  outcome: { state: 'running' | 'done' | 'refused' | 'failed'; detail: string } | null
}
```

Poll every second or two until `outcome` is non-null and its `state` is not
`running`; give up after about 30 s.

---

### `GET /api/v1/apps`

The apps this box hosts. Read only in v1.

```ts
type Apps = { apps: AppItem[] }

type AppItem = {
  name: string
  /** off: not running. lab: LAN only. live: public. */
  stage: 'off' | 'lab' | 'live'
  hostname: string
  description: string | null
  state: 'running' | 'attention' | 'stopped' | 'unknown'
  containerUp: boolean | null
  /** Its health probe through the proxy. */
  healthy: boolean | null
  /** Created and not on the box yet. */
  isNew: boolean
  /** Fields changed since the last Apply. */
  drift: string[]
  lastDeploy: {
    at: string
    result: 'ok' | 'failed'
    /** The image digest deployed. */
    digest: string
  } | null
}
```

## Changes

Append only. A breaking change is a new `/api/v2`, never an edit to v1.

- **v1** (2026-11-12): pairing (`daedalus://pair` v1, `POST /api/node/pair`),
  node tokens, and the endpoints above.
- **2026-11-12**, v1 addition: accessories. `MachineItem.accessories`
  (`AccessoryItem[]`: a phone's paired watch, empty for every other machine),
  `DeviceView.accessories` (`AccessoryView[]`: its facts and its watchOS
  `osReleases`), and `AppleOsReleases.os` gains `'watchos'` on a watch's list.
  Nothing existing changed or moved.
- **2026-11-12**, v1 addition: an accessory is listed as its own machine.
  `GET /machines` lists a phone's watch directly after its phone, as a
  `MachineItem` with `id: "<phone id>.watch"`, `kind: 'accessory'` (a new
  value of `kind`), `os: "watchos"` and the new field `via` (`{ id, name }`
  of its phone; `null` on every other item). `GET /machines/<phone id>.watch`
  answers a third `MachineDetail` variant, `kind: 'accessory'` with
  `accessory: AccessoryView` and `via`; `404` when the phone has no watch.
  `POST /machines/<phone id>.watch/command` is `409 refused`. A phone's
  `accessories` and `device.accessories` are unchanged.
