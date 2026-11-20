// What the T3 Code boards read off one payload. Pure, and beside the view:
// lib/dashboard/t3code is server-only, so the page takes its types alone.

import type { T3CodeData, T3Device, T3PinValues, T3Status } from '../../lib/dashboard/t3code'
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
      note: `${installed} is installed and the running server is ${f.running}. A rebuild never restarts it, because every thread and terminal would end with it. Restart, at the top of this page, applies the new build.`,
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

/** A build is installed that the running server is not on: what Restart is for. */
export const restartPending = (f: T3Facts): boolean =>
  f.running !== null && f.data.installed !== null && f.running !== f.data.installed

/** What the Pinned release board says, and whether it offers a button. */
export type Offer =
  /** No document, or one from a server that is down, which carries no check. */
  | { kind: 'unread' }
  | { kind: 'unchecked' }
  | { kind: 'current'; version: string; checkedAt: string | null }
  | { kind: 'blocked'; version: string; checkedAt: string | null; why: string }
  | { kind: 'ready'; version: string; checkedAt: string | null; values: T3PinValues }

export function t3Offer(f: T3Facts): Offer {
  const status = f.data.reading.status
  if (status === null) return { kind: 'unread' }
  const u = status.update
  if (u === null) return { kind: status.reachable ? 'unchecked' : 'unread' }
  const { version, checkedAt } = u
  // The resolver runs hourly, so for up to an hour after an update it still
  // names the release the pin has just moved to.
  if (u.current || version === f.data.installed) return { kind: 'current', version, checkedAt }
  return u.blocked !== null
    ? { kind: 'blocked', version, checkedAt, why: u.blocked }
    : { kind: 'ready', version, checkedAt, values: u.values }
}

/** A session the box minted for itself (the status helper, the thread CLI). */
export const isBot = (d: T3Device): boolean => d.deviceType === 'bot'

/** One line of the Projects board: a project T3 lists, or one kept out of it. */
export type ProjectRow = {
  root: string
  title: string
  repository: string | null
  /** Null: T3 does not list it, so there is nothing to count. */
  threads: number | null
  /** What the next Apply leaves it as. */
  shown: boolean
  /** The switch moved on the draft and the next Apply carries it. */
  pending: boolean
  /** Hidden by the last Apply, yet still in T3: the sync never deletes a thread. */
  kept: boolean
}

const lastStep = (root: string) => root.split('/').filter(Boolean).pop() ?? root

/**
 * The projects T3 lists, then the hidden ones it no longer does, each with
 * its switch. A project is keyed by its workspace root, as site.json names it.
 */
export function projectRows(f: T3Facts): ProjectRow[] {
  const { committed, desired } = f.data.hidden
  const hiddenNow = new Set(committed)
  const hiddenNext = new Set(desired)
  const row = (root: string, rest: Pick<ProjectRow, 'title' | 'repository' | 'threads'>) => ({
    root,
    ...rest,
    shown: !hiddenNext.has(root),
    pending: hiddenNow.has(root) !== hiddenNext.has(root),
    kept: hiddenNow.has(root) && rest.threads !== null,
  })
  const listed = f.live?.projects ?? []
  const seen = new Set(listed.map((p) => p.workspaceRoot))
  return [
    ...listed.map((p) =>
      row(p.workspaceRoot, { title: p.title, repository: p.repository, threads: p.threads }),
    ),
    ...[...new Set([...committed, ...desired])]
      .filter((r) => !seen.has(r))
      .sort()
      .map((r) => row(r, { title: lastStep(r), repository: null, threads: null })),
  ]
}
