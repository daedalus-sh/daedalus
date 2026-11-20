// What the T3 Code boards read off one payload. Pure, and beside the view:
// lib/dashboard/t3code is server-only, so the page takes its types alone.

import type { T3CodeData, T3Device, T3Status } from '../../lib/dashboard/t3code'
import type { Tone } from '../../lib/tone'

/** Why there is nothing current to draw, or null when the reading is live. */
export type Gap = 'unreadable' | 'none' | 'stale' | 'down'

export type T3Facts = {
  data: T3CodeData
  /** The reading, when it is current and the server answered. */
  live: T3Status | null
  gap: Gap | null
  /** The version the server reported, the last time it answered. */
  running: string | null
}

export function t3Facts(data: T3CodeData): T3Facts {
  const { status, stale, error } = data.reading
  const gap: Gap | null =
    status === null
      ? error === null
        ? 'none'
        : 'unreadable'
      : stale
        ? 'stale'
        : status.reachable
          ? null
          : 'down'
  return {
    data,
    live: gap === null ? status : null,
    gap,
    running: status?.server?.version ?? null,
  }
}

/** The few words a stat carries where its number would be. */
export const GAP_SUB: Record<Gap, string> = {
  unreadable: 'status file unreadable',
  none: 'no reading yet',
  stale: 'reading is stale',
  down: 'server not answering',
}

export type Verdict = { label: string; tone: Tone; note: string }

/**
 * Restart pending outranks the release gap, as on the Claude tab: a rebuild
 * leaves the running server alone, so the newer build is installed and idle
 * until someone restarts onto it, and nothing else says so.
 */
export function t3Verdict(f: T3Facts): Verdict {
  const { installed, gap } = f.data
  if (f.running !== null && installed !== null && f.running !== installed) {
    return {
      label: 'restart pending',
      tone: 'warn',
      note: `${installed} is installed and the running server is ${f.running}. A rebuild never restarts it, because every thread and terminal would end with it; restarting the server applies the new build.`,
    }
  }
  if (gap.installed === null) return { label: 'unknown', tone: 'muted', note: '' }
  if (gap.latest === null) {
    return { label: 'unknown', tone: 'muted', note: gap.note ?? 'GitHub did not answer.' }
  }
  const behind = gap.behind.length
  return behind === 0
    ? { label: 'current', tone: 'ok', note: '' }
    : {
        label: behind === 1 ? '1 release behind' : `${String(behind)} releases behind`,
        tone: 'warn',
        note: '',
      }
}

/** A session the box minted for itself (the status helper, the thread CLI). */
export const isBot = (d: T3Device): boolean => d.deviceType === 'bot'
