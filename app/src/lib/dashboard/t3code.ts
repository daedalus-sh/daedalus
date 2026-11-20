// T3 Code — the coding-agent server a host stack runs beside the control
// plane — as its status helper reports it, for System's T3 Code tab.
//
// The host writes one JSON document (schema v1) on a two-minute timer, from
// the server's own API and CLI, into a directory mounted here read-only. No
// credential for the server ever sits in this container, and the page never
// fetches the server: its address is behind the sign-in gate.
//
// A server that is down is a document saying so (`reachable: false`, with
// only the installed version beside it). A document older than STALE_MS is
// a timer that stopped: the file outlives it, and its last word must not
// pass for a current one.

import type { Ctx } from '../../core/ctx'
import type { SnapshotResult } from '../../host/contract/snapshot'
import type { VersionUpdateStatus } from '../../host/version-update'
import {
  arrayOf,
  bool,
  DecodeError,
  type Decoder,
  nullable,
  num,
  obj,
  optional,
  str,
} from '../contract/decode'
import { type VersionGap, versionGap } from './github'

export type T3ThreadState = 'running' | 'waiting' | 'idle'

export type T3Thread = {
  title: string
  project: string | null
  /** The server's own word for the last run: completed, failed, … */
  status: string
  state: T3ThreadState
  /** The runtime mode the thread was started in. */
  mode: string | null
  model: string | null
  updatedAt: string | null
  startedAt: string | null
  error: string | null
}

export type T3Project = {
  title: string
  workspaceRoot: string
  repository: string | null
  threads: number
}

export type T3Device = {
  label: string | null
  /** `bot` is a session the box minted for itself, not a person's device. */
  deviceType: string | null
  os: string | null
  browser: string | null
  method: string
  subject: string
  connected: boolean
  issuedAt: string | null
  lastConnectedAt: string | null
  expiresAt: string | null
  /** May operate a terminal: a shell on the server. */
  fullAccess: boolean
}

export type T3Counts = {
  projects: number
  threads: number
  archived: number
  running: number
  waiting: number
  failed: number
}

/** The six lines of the host's pin (fleet.versionPins.t3code), as the version-update agent takes them. */
export type T3PinValues = {
  version: string
  rev: string
  srchash: string
  pnpmhash: string
  chromeversion: string
  chromehash: string
}

/** What the host's hourly resolver found: the pin is the newest release, or a newer one with its values. */
export type T3Update =
  | { current: true; version: string; checkedAt: string | null }
  | {
      current: false
      version: string
      checkedAt: string | null
      /** Why it cannot be built yet, in the host's words. Null: ready. */
      blocked: string | null
      values: T3PinValues
    }

export type T3Status = {
  generatedAt: string
  /** The server answered its own descriptor. False: everything below is empty. */
  reachable: boolean
  /** The helper's read-only session could list projects and threads. */
  reader: boolean
  installedVersion: string
  server: {
    version: string
    environmentId: string | null
    label: string | null
    startedAt: string | null
  } | null
  counts: T3Counts
  projects: T3Project[]
  active: T3Thread[]
  recent: T3Thread[]
  devices: T3Device[]
  pendingPairings: number
  /** Null: the resolver has not run, or what it wrote is not a shape this page forwards. */
  update: T3Update | null
}

export type T3Reading = {
  /** The last document the helper wrote. Null when there is none to read. */
  status: T3Status | null
  /** Older than STALE_MS: the status timer stopped. */
  stale: boolean
  /** Why the document could not be read: malformed, or another schema version. */
  error: string | null
}

export type T3CodeData = {
  /** The server's own page. A link only: it is behind the sign-in gate. */
  url: string
  /** The build the host installed, as nix names it. */
  installed: string | null
  reading: T3Reading
  gap: VersionGap
  /** The host's version-update run, as the Update button's progress starts from. */
  versionStatus: VersionUpdateStatus
  /** What a restart ends, by this reading; the confirm asks again as it arms. */
  restartConfirm: string
}

/** Five missed runs of a two-minute timer. */
export const STALE_MS = 10 * 60_000

const NO_COUNTS: T3Counts = {
  projects: 0,
  threads: 0,
  archived: 0,
  running: 0,
  waiting: 0,
  failed: 0,
}

const schemaV1: Decoder<1> = (v, p) => {
  if (v !== 1) throw new DecodeError(p, `expected schema version 1, got ${JSON.stringify(v)}`)
  return 1
}

/** Kept open: a state added later reads as idle, not as a page that stops reading the file. */
const threadState: Decoder<T3ThreadState> = (v, p) => {
  const s = str(v, p)
  return s === 'running' || s === 'waiting' ? s : 'idle'
}

const ostr = optional(nullable(str), null)

const thread: Decoder<T3Thread> = obj({
  title: optional(str, ''),
  project: ostr,
  status: optional(str, ''),
  state: optional(threadState, 'idle'),
  mode: ostr,
  model: ostr,
  updatedAt: ostr,
  startedAt: ostr,
  error: ostr,
})

const project: Decoder<T3Project> = obj({
  title: str,
  workspaceRoot: optional(str, ''),
  repository: ostr,
  threads: optional(num, 0),
})

const device: Decoder<T3Device> = obj({
  label: ostr,
  deviceType: ostr,
  os: ostr,
  browser: ostr,
  method: optional(str, ''),
  subject: optional(str, ''),
  connected: optional(bool, false),
  issuedAt: ostr,
  lastConnectedAt: ostr,
  expiresAt: ostr,
  fullAccess: optional(bool, false),
})

/** The patterns the host declares for each field of the pin, anchored. */
const PIN_PATTERNS: Record<keyof T3PinValues, RegExp> = {
  version: /^\d+\.\d+\.\d+$/,
  rev: /^[0-9a-f]{40}$/,
  srchash: /^[0-9a-z]{52}$/,
  pnpmhash: /^[0-9a-z]{52}$/,
  chromeversion: /^\d+(\.\d+){3}$/,
  chromehash: /^[0-9a-z]{52}$/,
}
const PIN_FIELDS = Object.keys(PIN_PATTERNS) as (keyof T3PinValues)[]

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** Exactly the six fields, each to its pattern; anything else is no values at all. */
function pinValues(v: unknown): T3PinValues | null {
  const o = record(v)
  if (o === null || Object.keys(o).length !== PIN_FIELDS.length) return null
  const out: Partial<T3PinValues> = {}
  for (const k of PIN_FIELDS) {
    const x = o[k]
    if (typeof x !== 'string' || !PIN_PATTERNS[k].test(x)) return null
    out[k] = x
  }
  return out as T3PinValues
}

/**
 * Never throws: the update is the one part of the document the page sends
 * back to the host, so one that does not match is dropped (read as "no
 * check") and the rest of the reading stands.
 */
const update: Decoder<T3Update | null> = (v) => {
  const o = record(v)
  if (o === null) return null
  const { version, current, checkedAt, blocked } = o
  if (typeof version !== 'string' || !PIN_PATTERNS.version.test(version)) return null
  const at = typeof checkedAt === 'string' ? checkedAt : null
  if (current === true) return { current: true, version, checkedAt: at }
  if (current !== false) return null
  if (blocked !== undefined && blocked !== null && typeof blocked !== 'string') return null
  const values = pinValues(o.values)
  // The button names `version`; the values must be that release's.
  if (values === null || values.version !== version) return null
  return {
    current: false,
    version,
    checkedAt: at,
    blocked: typeof blocked === 'string' && blocked !== '' ? blocked : null,
    values,
  }
}

const document = obj({
  // The version comes first, so another version fails on its version and
  // not on a field it moved.
  schemaVersion: schemaV1,
  generatedAt: str,
  reachable: bool,
  reader: optional(bool, false),
  installedVersion: optional(str, ''),
  server: optional(
    nullable(
      obj({
        version: str,
        environmentId: ostr,
        label: ostr,
        startedAt: ostr,
      }),
    ),
    null,
  ),
  counts: optional(
    obj({
      projects: optional(num, 0),
      threads: optional(num, 0),
      archived: optional(num, 0),
      running: optional(num, 0),
      waiting: optional(num, 0),
      failed: optional(num, 0),
    }),
    NO_COUNTS,
  ),
  projects: optional(arrayOf(project), []),
  active: optional(arrayOf(thread), []),
  recent: optional(arrayOf(thread), []),
  devices: optional(arrayOf(device), []),
  pendingPairings: optional(num, 0),
  update: optional(update, null),
})

export const t3Status: Decoder<T3Status> = document

/** What a snapshot read of the file says, at `now`. */
export function readingOf(r: SnapshotResult<T3Status | null>, now: number): T3Reading {
  const status = r.available ? r.data : null
  if (status === null) return { status: null, stale: false, error: r.error }
  // The document's own clock, not the file's mtime: it is the helper saying
  // "I looked at", which is the claim being tested.
  const at = Date.parse(status.generatedAt)
  return { status, stale: !Number.isFinite(at) || now - at > STALE_MS, error: null }
}

/** The status file, read now. Unbound path: the box mounts none, so there is no reading. */
export async function readT3Code(ctx: Pick<Ctx, 'env' | 'snapshot'>): Promise<T3Reading> {
  const path = ctx.env('T3CODE_STATUS_FILE')
  if (path === undefined) return { status: null, stale: false, error: null }
  const r = await ctx.snapshot({ path, decoder: nullable(t3Status), fallback: null })
  return readingOf(r, Date.now())
}

const count = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`
const be = (n: number) => (n === 1 ? 'is' : 'are')

/**
 * What the Restart confirm says: the threads a restart ends, by this reading.
 * Terminals are not in the status file, so they are named and never counted.
 */
export function restartConfirm(r: T3Reading): string {
  const s = r.status
  if (s === null || r.stale || !s.reachable || !s.reader) {
    return 'How many threads are running is not known right now. Restarting the server ends every one that is, and every open terminal.'
  }
  const { running, waiting } = s.counts
  if (running === 0 && waiting === 0) {
    return 'No thread is running or waiting right now. Restarting the server still ends every open terminal.'
  }
  const threads =
    running > 0 && waiting > 0
      ? `${count(running, 'thread')} ${be(running)} running and ${String(waiting)} ${be(waiting)} waiting on an answer`
      : running > 0
        ? `${count(running, 'thread')} ${be(running)} running`
        : `${count(waiting, 'thread')} ${be(waiting)} waiting on an answer`
  const them = running + waiting === 1 ? 'it' : 'them'
  return `${threads} right now. Restarting the server ends ${them} and every open terminal.`
}

const orNull = (s: string | undefined): string | null => (s === undefined || s === '' ? null : s)

export async function loadT3Code(
  ctx: Pick<Ctx, 'env' | 'snapshot' | 'hosts' | 'controller'>,
): Promise<T3CodeData> {
  const { readVersionUpdateStatus } = await import('../../host/version-update')
  const [reading, versionStatus] = await Promise.all([
    readT3Code(ctx),
    readVersionUpdateStatus(ctx),
  ])
  const installed = orNull(ctx.env('T3CODE_VERSION')) ?? orNull(reading.status?.installedVersion)
  // What the RUNNING server said it is, in preference to what nix installed:
  // the two differ from a rebuild until the server's next restart.
  //
  // The default tag pattern is anchored (vX.Y.Z), which is what keeps the
  // project's nightly tags (vX.Y.Z-nightly.…) out of the release list.
  const gap = await versionGap('pingdotgg/t3code', reading.status?.server?.version ?? installed)
  return {
    url: ctx.hosts.base('t3code'),
    installed,
    reading,
    gap,
    versionStatus,
    restartConfirm: restartConfirm(reading),
  }
}

// ⚠ Views import TYPES only from here — see the foot of dashboard/claude.ts.
