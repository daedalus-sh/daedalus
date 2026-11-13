import type { NodeDetail, Telemetry } from '../../host/controller/generated'

// A light node: a phone or tablet running the native app. It holds a key and
// links to the controller like every machine, but only while its app is open,
// and it runs no Claude, no provider, no session host and no awake hold. So
// "not connected" is its normal state — shown as when it was last seen, never
// as a fault — and the box keeps what it last said about itself
// (`DeviceFacts`, the nodes row's `device`), because the controller forgets
// everything on a restart.
//
// What makes a node light is its OS, as its hello states it. The agent has no
// capability that says so.
//
// An accessory is not a node at all: an Apple Watch has no key and no link.
// Its watchOS app hands its facts to the iPhone app, which reports them
// inside its own telemetry sample (`Telemetry.accessories`), and the box
// keeps them with the phone's.
//
// Pure: the pages and the tests import it.

export const LIGHT_OSES = ['ios', 'ipados'] as const
export type LightOs = (typeof LIGHT_OSES)[number]

export function isLightOs(os: string | null | undefined): os is LightOs {
  return os === 'ios' || os === 'ipados'
}

/** "iPhone" or "iPad", for a label. */
export const lightKind = (os: string): string => (os === 'ipados' ? 'iPad' : 'iPhone')

/** What a phone last said about the watch paired with it. */
export type DeviceAccessory = {
  kind: 'watch'
  /** What its owner called it: "Santiago’s Apple Watch". */
  name: string | null
  /** The device identifier: "Watch7,5". */
  model: string | null
  /** "26.1". */
  osVersion: string | null
  /** "23S37". */
  osBuild: string | null
  battery: { percent: number | null; charging: boolean | null } | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  /** ISO time the watch read these; the phone's reading time when it did not say. */
  at: string
}

/** What a light node last said about itself, and when the box read it. */
export type DeviceFacts = {
  /** The device identifier: "iPhone17,1". */
  model: string | null
  /** As the device reports it: "26.1", or "26.1 (23B85)". */
  osVersion: string | null
  /** The native app's version (the node's `agent_version`). */
  appVersion: string | null
  battery: { percent: number | null; charging: boolean | null } | null
  storage: { totalBytes: number | null; freeBytes: number | null } | null
  memoryBytes: number | null
  /** What is paired with it, as its last sample listed them; empty when nothing is. */
  accessories: DeviceAccessory[]
  /** ISO time of the reading. */
  at: string
}

/** The facts as a row holds them: one written before accessories existed has no such key. */
export type KeptDeviceFacts = Omit<DeviceFacts, 'accessories'> & {
  accessories?: DeviceAccessory[]
}

/** A row's facts as every reader takes them. */
export function keptDeviceFacts(kept: KeptDeviceFacts | null): DeviceFacts | null {
  return kept === null ? null : { ...kept, accessories: kept.accessories ?? [] }
}

const orPrior = <T>(now: T | null | undefined, prior: T | null | undefined): T | null =>
  now ?? prior ?? null

/** A watch's "watchOS 26.1" → "26.1": the version alone, whichever way it was sent. */
const bareVersion = (v: string | null): string | null => {
  const s = v?.replace(/^watchOS\s+/i, '').trim() ?? ''
  return s === '' ? null : s
}

/**
 * The accessories of one sample the pages know how to draw: its watches. A
 * kind this box does not know (the controller reads a newer app's word as
 * `unknown`) is left out rather than drawn as something it is not.
 */
export function accessoriesOf(t: Pick<Telemetry, 'accessories'>, at: string): DeviceAccessory[] {
  return (t.accessories ?? [])
    .filter((a) => a.kind === 'watch')
    .map((a) => ({
      kind: 'watch' as const,
      name: a.name,
      model: a.model,
      osVersion: bareVersion(a.os_version),
      osBuild: a.os_build,
      battery:
        a.battery === null ? null : { percent: a.battery.percent, charging: a.battery.charging },
      storage:
        a.storage_total_bytes === null && a.storage_free_bytes === null
          ? null
          : { totalBytes: a.storage_total_bytes, freeBytes: a.storage_free_bytes },
      at: a.sampled_at !== null && Number.isFinite(Date.parse(a.sampled_at)) ? a.sampled_at : at,
    }))
}

/**
 * The facts in what the controller holds for the node, over what the row
 * already kept: a field the device did not report this time keeps its last
 * value. The accessories are the exception: a sample lists them whole, so
 * one without the watch is a phone that no longer has one. Null when the
 * controller holds nothing new to read.
 */
export function deviceFactsFrom(
  d: Pick<NodeDetail, 'status' | 'telemetry' | 'model' | 'agent_version'>,
  prior: DeviceFacts | null,
  at: string,
): DeviceFacts | null {
  const s = d.status
  const t = d.telemetry
  if (s === null && t === null) return null
  // The volume the device's own storage figure is about: its largest.
  const disk =
    t === null
      ? null
      : ([...t.disks].sort((a, b) => (b.total_bytes ?? 0) - (a.total_bytes ?? 0))[0] ?? null)
  const osVersion = s === null || s.os_version === '' ? null : s.os_version
  return {
    model: orPrior(t?.machine.model ?? d.model, prior?.model),
    osVersion: orPrior(osVersion, prior?.osVersion),
    appVersion: orPrior(d.agent_version ?? s?.version, prior?.appVersion),
    battery:
      t?.battery == null
        ? (prior?.battery ?? null)
        : { percent: t.battery.percent, charging: t.battery.charging },
    storage:
      disk === null
        ? (prior?.storage ?? null)
        : { totalBytes: disk.total_bytes, freeBytes: disk.free_bytes },
    memoryBytes: orPrior(t?.memory.total_bytes ?? s?.memory_bytes, prior?.memoryBytes),
    accessories: t === null ? (prior?.accessories ?? []) : accessoriesOf(t, at),
    at,
  }
}

/** Whether two readings say the same thing, their times aside. */
export function sameDeviceFacts(a: DeviceFacts | null, b: DeviceFacts | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify({ ...a, at: '' }) === JSON.stringify({ ...b, at: '' })
}
