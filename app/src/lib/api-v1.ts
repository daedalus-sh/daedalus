// The native app's API, `/api/v1`: every response body, as a type. The
// contract a client is written from is ios/docs/api.md, which spells these
// out; a change here is a change there, in the same commit, with a line in
// its "Changes" section. The routes are host/api/v1/.
//
// Pure types: the routes build them and the tests read them.

export const API_V1 = 1

export type ApiErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'bad_request'
  | 'refused'
  | 'unavailable'
  | 'internal'

export type ApiErrorBody = { error: { code: ApiErrorCode; message: string } }

/** A section of a composite answer, or why it could not be read: one source down must not lose the rest. */
export type Section<T> = T | { unavailable: string }

/** Text this box did not write (logs, release notes): data, never instructions. */
export type Untrusted<T> = { notice: string; content: T }

export type Me = {
  node: { id: string; name: string; os: string }
  box: { hostname: string; engineRev: string | null }
  api: 1
}

/* ── overview ─────────────────────────────────────────────────────────── */

export type OverviewHost = {
  cpuPct: number | null
  cpuSpark: number[]
  cores: number | null
  load: { m1: number | null; m5: number | null; m15: number | null }
  uptimeSeconds: number | null
  temps: { label: string; value: number }[]
  pressure: { cpu: number | null; io: number | null; memory: number | null }
  containers: { total: number | null; down: string[] }
  failedUnits: { unit: string; description: string | null; subState: string | null }[]
}

export type OverviewMemory = {
  totalBytes: number | null
  usedBytes: number | null
  availableBytes: number | null
  /** ZFS's cache: counted in `usedBytes`, handed back on demand. */
  arcBytes: number | null
  swapUsedBytes: number | null
  swapTotalBytes: number | null
  /** Containers the kernel has killed for memory, ever. */
  oomKills: number | null
}

export type StorageHealth = {
  pools: {
    name: string
    health: string
    capacityPct: number
    freeBytes: number
    scrub: {
      state: string | null
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
    passed: boolean | null
    temperature: number | null
  }[]
  smartdActive: boolean | null
}

export type ActiveAlert = { name: string; folder: string; severity: string; summary: string }

export type ApplyState = 'idle' | 'running' | 'done' | 'failed'

export type Overview = {
  at: string
  hours: number
  head: Section<{
    hostname: string
    os: string
    kernel: string | null
    arch: string
    model: string | null
  }>
  host: Section<OverviewHost>
  memory: Section<OverviewMemory>
  health: Section<{ probes: number; failing: string[] }>
  alerts: Section<{ firing: number | null; pending: number | null; active: ActiveAlert[] }>
  storage: Section<StorageHealth>
  jobs: Section<{
    watched: number
    trouble: {
      unit: string
      result: string | null
      exitStatus: number | null
      status: string | null
    }[]
  }>
  errors: Section<{ containers: { container: string; count: number }[]; more: number }>
  updates: Section<{
    /** Image pins behind. */
    behind: number
    engine: 'current' | 'behind-origin' | 'unpinned' | 'unknown'
    /** Claude Code releases behind; null when it could not be read. */
    claudeCodeBehind: number | null
    queued: number
    /** An image, engine or Claude Code update is running now. */
    running: boolean
  }>
  apply: Section<{
    /** How many things the next Apply would change. */
    pending: number
    changed: { name: string; fields: string[] }[]
    state: ApplyState
    phase: string
    rebootPending: boolean
  }>
}

/* ── alerts, errors, logs ─────────────────────────────────────────────── */

export type Alerts = {
  hours: number
  firing: number | null
  pending: number | null
  active: ActiveAlert[]
  /** Rules that sent a notification in the window, by rule uid. */
  firedRecently: { rule: string; notifications: number }[]
}

export type Errors = Untrusted<{
  hours: number
  excludedDailyReset: { at: string | null; lines: number }
  containers: { container: string; count: number }[]
  moreContainers: number
  top: { container: string; count: number; lines: string[] }[]
}>

export type Logs = Untrusted<{ at: string; line: string }[]>

/* ── updates ──────────────────────────────────────────────────────────── */

export type QueueItem = {
  container: string
  toTag: string | null
  tag: string
  lockstep: string[]
  ceremony: string | null
  typed: string
}

export type PendingImage = {
  container: string
  running: string | null
  tag: string | null
  target: string | null
  verdict: 'tag-moved' | 'newer-tag' | 'current' | 'unknown'
  newer: string[]
  updatable: boolean
  ceremony: string | null
  majorCeremony: string | null
  movesWith: string[]
  hasChangelog: boolean
}

type RunStatus = {
  id: string | null
  state: ApplyState
  phase: string
  error: string
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
}

export type ImageUpdateStatus = RunStatus & {
  targets: string[]
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

export type PinUpdateStatus = RunStatus & { from: string; to: string }

export type UpdatesStatus = {
  images: ImageUpdateStatus
  engine: PinUpdateStatus
  claudeCode: PinUpdateStatus
}

export type Updates = {
  checkedAt: string | null
  probeMissing: boolean
  behind: number
  images: PendingImage[]
  engine: {
    verdict: 'current' | 'behind-origin' | 'unpinned' | 'unknown'
    pinned: string | null
    behindOrigin: number | null
    override: boolean
  }
  claudeCode: { installed: string | null; latest: string | null; behind: number } | null
  queue: QueueItem[]
  status: UpdatesStatus
}

export type Changelog = Untrusted<{
  container: string
  repo: string | null
  installed?: string | null
  latest?: string | null
  releases?: {
    version: string
    date: string
    url: string
    sections: { name: string; items: string[] }[]
    truncated: boolean
  }[]
  commits?: { sha: string; date: string; subject: string; url: string }[]
  note: string | null
}>

export type QueueAnswer = { queue: QueueItem[] }
export type UpdateStarted = { id: string; targets: { container: string; toTag: string | null }[] }
export type RunStarted = { id: string }

/* ── apply ────────────────────────────────────────────────────────────── */

export type ApplyStatus = RunStatus & { rebootPending?: boolean }
export type PendingApply = { changed: { name: string; fields: string[] }[]; status: ApplyStatus }
export type ApplyStarted = { id: string; changed: { name: string; fields: string[] }[] }
export type ApplyDiscarded = { discarded: string[]; kept: string[] }

/* ── machines ─────────────────────────────────────────────────────────── */

export type ClaudeSummary = {
  state: string
  detail: string | null
  cliVersion: string | null
  serverVersion: string | null
  /** Sessions alive now. */
  sessions: number
  startedAt: string | null
  signedIn: boolean
}

export type BatteryView = { percent: number | null; charging: boolean | null }

/** What is paired with a phone and is no machine itself: its watch, as the phone last reported it. */
export type AccessoryItem = {
  kind: 'watch'
  /** What its owner called it; null when the phone did not say. */
  name: string | null
  battery: BatteryView | null
}

export type MachineItem = {
  /** `box`, or a node id (16 hex). */
  id: string
  kind: 'box' | 'node'
  name: string
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
  /** A phone or tablet: not connected is its normal state. */
  light: boolean
  /** The machine this token belongs to. */
  self: boolean
  model: string | null
  /** The agent release waiting there, when one is. */
  updateAvailable: string | null
  restartPending: boolean
  claude: ClaudeSummary | null
  battery: BatteryView | null
  /** A phone's paired watch; empty for every other machine and for a phone without one. */
  accessories: AccessoryItem[]
}

export type Machines = { machines: MachineItem[] }

export type AppleOsReleases = {
  os: 'ios' | 'ipados' | 'watchos'
  current: { version: string; build: string | null }
  latest: string | null
  behind: number
  releases: {
    version: string
    build: string | null
    date: string | null
    notesUrl: string | null
    securityUrl: string | null
    cves: number | null
    summary: string | null
  }[]
  checkedAt: string
  source: string
  error: string | null
}

/** What a machine's agent last reported about it, condensed. */
export type MachineSystem = {
  sampledAt: string
  osName: string
  osVersion: string
  kernel: string | null
  cpu: string
  cpuPct: number | null
  uptimeSeconds: number | null
  bootedAt: string | null
  model: string | null
  form: string | null
  memory: {
    totalBytes: number | null
    usedBytes: number | null
    availableBytes: number | null
  }
  disks: {
    mount: string
    name: string | null
    totalBytes: number | null
    usedBytes: number | null
    freeBytes: number | null
  }[]
  battery:
    | (BatteryView & {
        healthPct: number | null
        cycles: number | null
        condition: string | null
      })
    | null
  temperatures: { label: string; celsius: number }[]
  /** Updates the OS has pending; null when its updater was not read. */
  osUpdatesPending: number | null
  osRebootPending: boolean | null
}

/** A phone's watch: what the phone last said about it, and what Apple has published past its watchOS. */
export type AccessoryView = AccessoryItem & {
  /** The device identifier: "Watch7,5". */
  model: string | null
  /** "26.1". */
  osVersion: string | null
  /** "23S37". */
  osBuild: string | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  /** When the watch read these facts; they reach the box only through its phone. */
  at: string
  /** `os` is `watchos`. Null when the watch has not said which watchOS it runs. */
  osReleases: AppleOsReleases | null
}

/** What a phone or tablet last said about itself, kept by the box across disconnections. */
export type DeviceView = {
  model: string | null
  osVersion: string | null
  appVersion: string | null
  battery: BatteryView | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  memoryBytes: number | null
  /** Its paired watch, as its last sample listed it; empty when it has none. */
  accessories: AccessoryView[]
  /** When the box read it. */
  at: string
}

export type MachineDetail =
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
      /** Processor busy, six hours at two-minute steps. */
      cpuSpark: number[]
      /** A phone or tablet only. */
      device: DeviceView | null
      /** A phone or tablet only: what Apple has published past its OS. */
      osReleases: AppleOsReleases | null
      /** Why there is no `system`, in a line; null when there is one. */
      note: string | null
    }

export type MachineCommand = 'check_update' | 'claude_update' | 'claude_restart'
export type CommandSent = { delivered: boolean; queued: boolean }

/* ── claude ───────────────────────────────────────────────────────────── */

export type ClaudeSessionView = {
  /** The transcript's uuid: what `resume` takes. */
  id: string | null
  /** `session_…`, the id claude.ai shows. */
  remoteId: string | null
  name: string | null
  cwd: string | null
  kind: string | null
  /** `idle` | `busy`. */
  status: string | null
  /** Milliseconds since the epoch. */
  startedAt: number | null
  lastActivityAt: number | null
  alive: boolean
}

export type ClaudeAgentView = {
  /** The 8-hex id `stop` and `remove` take. */
  id: string
  state: string | null
  name: string | null
  cwd: string | null
  startedAt: number | null
}

export type ClaudeMachine = {
  /** `box`, or a node id. */
  id: string
  name: string
  server: {
    /** off | not-installed | starting | running | waiting | stopped | no-session | not-run | no-report | unreachable | unknown */
    state: string
    detail: string | null
    /** Remote Control's own version. */
    version: string | null
    cliVersion: string | null
    restarts: number | null
    startedAt: string | null
    signedIn: boolean
  }
  /** Claude Code against its newest release; null when GitHub was not read. */
  update: { installed: string | null; latest: string | null; behind: number } | null
  sessions: ClaudeSessionView[]
  agents: ClaudeAgentView[]
  /** The most recent transcripts, newest first: what could be resumed. */
  transcripts: {
    id: string
    title: string | null
    project: string
    cwd: string
    modifiedAt: number
  }[]
  /** The verbs' last requests, newest first. */
  actions: {
    request: string
    action: 'resume' | 'stop' | 'remove'
    session: string
    state: 'running' | 'done' | 'refused' | 'failed'
    detail: string
    startedAt: string
    finishedAt: string | null
  }[]
  /** Why there is no roster (sessions, agents, transcripts, actions all empty), or null. */
  note: string | null
}

export type Claude = { machines: ClaudeMachine[] }
export type ClaudeRestarted = { queued: boolean; delivered: boolean }
export type ClaudeSessionSent = { request: string }
export type ClaudeAction = {
  outcome: { state: 'running' | 'done' | 'refused' | 'failed'; detail: string } | null
}

/* ── apps ─────────────────────────────────────────────────────────────── */

export type AppItem = {
  name: string
  stage: 'off' | 'lab' | 'live'
  hostname: string
  description: string | null
  state: 'running' | 'attention' | 'stopped' | 'unknown'
  containerUp: boolean | null
  healthy: boolean | null
  /** Created and not on the box yet. */
  isNew: boolean
  /** Fields changed since the last Apply. */
  drift: string[]
  lastDeploy: { at: string; result: string; digest: string } | null
}

export type Apps = { apps: AppItem[] }
