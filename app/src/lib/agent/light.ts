import type { NodeDetail } from '../../host/controller/generated'

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
// Pure: the pages and the tests import it.

export const LIGHT_OSES = ['ios', 'ipados'] as const
export type LightOs = (typeof LIGHT_OSES)[number]

export function isLightOs(os: string | null | undefined): os is LightOs {
  return os === 'ios' || os === 'ipados'
}

/** "iPhone" or "iPad", for a label. */
export const lightKind = (os: string): string => (os === 'ipados' ? 'iPad' : 'iPhone')

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
  /** ISO time of the reading. */
  at: string
}

const orPrior = <T>(now: T | null | undefined, prior: T | null | undefined): T | null =>
  now ?? prior ?? null

/**
 * The facts in what the controller holds for the node, over what the row
 * already kept: a field the device did not report this time keeps its last
 * value. Null when the controller holds nothing new to read.
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
    at,
  }
}

/** Whether two readings say the same thing, their times aside. */
export function sameDeviceFacts(a: DeviceFacts | null, b: DeviceFacts | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify({ ...a, at: '' }) === JSON.stringify({ ...b, at: '' })
}
