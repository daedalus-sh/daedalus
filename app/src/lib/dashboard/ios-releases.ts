import { swrCache } from '../cache'
import {
  buildFor,
  compareVersions,
  fetchText,
  getPinned,
  type MacNoteSection,
  notesSlugs,
  PMV_URL,
  type PmvBuild,
  parsePmv,
  parseReleaseNotes,
  parseSecurityPage,
  splitRunning,
  stripTags,
  TABLE_URL,
  tableDate,
} from './macos-releases'

// What Apple has shipped since the iOS, iPadOS or watchOS a device is
// running, from the same three Apple pages macos-releases.ts reads:
//
// - support.apple.com/100100: a row is titled "iOS 26.1 and iPadOS 26.1",
//   or names one of the two alone when the other did not get the release
//   ("iPadOS 17.7.9", "iOS 26.5.1"), so each system has its own list.
// - gdmf.apple.com/v2/pmv: the `iOS` set is every device that is not a Mac
//   or a Vision Pro. Watches, Apple TVs and HomePods share it and reuse the
//   same version numbers, so a build counts only when it lists an iPhone or
//   an iPad. It holds the current release of each supported line, no
//   history: an older release has no build here.
// - developer.apple.com's release notes, one set for both systems
//   (ios-ipados-release-notes). Not every minor has a page; a version
//   without one gets its major's.
//
// A watch (a phone's accessory, lib/agent/light.ts) is read the same way:
// its rows of the table are titled "watchOS 27.2.1" alone, its builds are
// the feed's `iOS` set too (the ones listing a `Watch…` model), and its
// notes are their own set (watchos-release-notes).

export type AppleOsRelease = {
  /** As Apple prints it: "26.1", "26.0.1". */
  version: string
  build: string | null
  /** ISO date (YYYY-MM-DD) from the security table; null when unknown. */
  date: string | null
  /** Apple's developer release notes for this version's minor; null when none was found. */
  notesUrl: string | null
  /** Apple's security-content page for the release; null when the table links none. */
  securityUrl: string | null
  /** Distinct CVE ids on the security page; null when not read. */
  cves: number | null
  /** One line for a list row: "23 security fixes", or Apple's own line ("This update has no published CVE entries."), or null. */
  summary: string | null
  notes: MacNoteSection[]
}

/** The systems this reader knows: a phone's, a tablet's, a watch's. */
export type AppleOs = 'ios' | 'ipados' | 'watchos'

/** As Apple writes each. */
export const APPLE_OS_NAME: Record<AppleOs, string> = {
  ios: 'iOS',
  ipados: 'iPadOS',
  watchos: 'watchOS',
}

export type AppleOsReleases = {
  os: AppleOs
  /** The running version and build, as the device reported them. */
  current: { version: string; build: string | null }
  /** The newest version Apple has published for this OS, whatever is running; null when the table did not answer. */
  latest: string | null
  /** How many published releases are newer than `current` (all of them, not just the listed ones). */
  behind: number
  /** The releases newer than `current`, newest first, at most 8, across majors. */
  releases: AppleOsRelease[]
  checkedAt: string
  source: string
  error: string | null
}

export type IosTableRow = {
  version: string
  date: string | null
  url: string | null
  /** Text Apple put in the name cell beside the title, when any. */
  note: string | null
}

const TTL_MS = 6 * 3600_000
const LISTED = 8
// One set of notes for iOS and iPadOS, another for watchOS.
const NOTES: Record<AppleOs, { product: string; path: string }> = {
  ios: { product: 'ios-ipados', path: 'ios-ipados-release-notes' },
  ipados: { product: 'ios-ipados', path: 'ios-ipados-release-notes' },
  watchos: { product: 'watchos', path: 'watchos-release-notes' },
}

const TABLE = swrCache({ ttlMs: TTL_MS })
const PMV = swrCache({ ttlMs: TTL_MS })
const NOTES_CACHE = swrCache({ ttlMs: TTL_MS })
const SECURITY = swrCache({ ttlMs: TTL_MS })

const TITLE: Record<AppleOs, RegExp> = {
  ios: /\biOS (\d+(?:\.\d+)*)/,
  ipados: /\biPadOS (\d+(?:\.\d+)*)/,
  watchos: /\bwatchOS (\d+(?:\.\d+)*)/,
}

/**
 * One system's rows of Apple's table, in the table's order (newest first),
 * one per version. The title is the link when the release has security
 * content and a bare paragraph when it has none, with Apple's sentence
 * about that in a note beside it. "Background Security Improvements for
 * iOS, iPadOS, and macOS" names the systems without a version and is not a
 * release.
 */
export function parseIosTable(html: string, os: AppleOs): IosTableRow[] {
  const out: IosTableRow[] = []
  const rows = html.replace(/\n/g, ' ').match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []
  for (const row of rows) {
    const cells = row.match(/<td[\s>][\s\S]*?<\/td>/g) ?? []
    const head = cells[0]
    const dateCell = cells[2]
    if (head === undefined || dateCell === undefined) continue
    const link = head.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    const named = link ?? head.match(/<p[^>]*>([\s\S]*?)<\/p>/)
    const title = stripTags(named?.[named.length - 1] ?? head)
    if (!/^(?:iOS|iPadOS|watchOS) \d/.test(title)) continue
    const version = title.match(TITLE[os])?.[1]
    if (version === undefined || out.some((r) => r.version === version)) continue
    const rest = stripTags(head.replace(named?.[0] ?? '', ''))
    out.push({
      version,
      date: tableDate(stripTags(dateCell)),
      url: link?.[1] ?? null,
      note: rest === '' ? null : rest,
    })
  }
  return out
}

const FAMILY: Record<AppleOs, RegExp> = {
  ios: /^(?:iPhone|iPod)/,
  ipados: /^iPad/,
  watchos: /^Watch/,
}

/**
 * The build a version means for this device: among the builds that list
 * its model — or, the model unknown or not listed, any device of its
 * family — the lowest-numbered, as `buildFor` picks for a Mac. Null when
 * the version's only builds are for another family: the feed's one set
 * holds phones, tablets, watches, TVs and speakers, and they reuse each
 * other's version numbers.
 */
export function iosBuildFor(
  builds: PmvBuild[] | undefined,
  os: AppleOs,
  model: string | null,
): string | null {
  if (builds === undefined) return null
  const family = FAMILY[os]
  const mine = model === null ? [] : builds.filter((b) => b.devices.includes(model))
  const pool = mine.length > 0 ? mine : builds.filter((b) => b.devices.some((d) => family.test(d)))
  return buildFor(pool, null)
}

/** "26.7.3" → ["ios-ipados-26_7-release-notes", "ios-ipados-26-release-notes"]; a watch's under `watchos-`. */
export function iosNotesSlugs(version: string, os: AppleOs = 'ios'): string[] {
  return notesSlugs(version, NOTES[os].product)
}

async function securityTable(): Promise<string> {
  return TABLE.get('', () => fetchText(TABLE_URL))
}

async function versionFeed(): Promise<Map<string, PmvBuild[]>> {
  return PMV.get('', async () => parsePmv(await getPinned(PMV_URL), 'iOS'))
}

async function releaseNotes(
  version: string,
  os: AppleOs,
): Promise<{ url: string | null; sections: MacNoteSection[] }> {
  const slugs = iosNotesSlugs(version, os)
  const { path } = NOTES[os]
  const notes = await NOTES_CACHE.get(slugs[0] ?? `${os} ${version}`, async () => {
    for (const slug of slugs) {
      try {
        const text = await fetchText(
          `https://developer.apple.com/tutorials/data/documentation/${path}/${slug}.json`,
        )
        return {
          url: `https://developer.apple.com/documentation/${path}/${slug}`,
          sections: parseReleaseNotes(text),
        }
      } catch {
        // the next slug: a major's notes live under its bare number
      }
    }
    return null
  })
  return notes ?? { url: null, sections: [] }
}

async function securityContent(url: string): Promise<{ cves: number | null; note: string | null }> {
  return SECURITY.get(url, async () => parseSecurityPage(await fetchText(url)))
}

/** The list row's one line. */
export function releaseSummary(cves: number | null, note: string | null): string | null {
  if (cves !== null && cves > 0) return `${String(cves)} security ${cves === 1 ? 'fix' : 'fixes'}`
  return note
}

/**
 * `osVersion` is what the device reports: "26.1", or "26.1 (23B85)".
 * `model` is the device identifier ("iPhone17,1", "iPad14,3", "Watch7,5") or null; it
 * picks the build in Apple's version feed the way `buildFor` does with a
 * Mac's board target.
 */
export async function iosReleases(
  os: AppleOs,
  osVersion: string,
  model: string | null,
): Promise<AppleOsReleases> {
  const base: AppleOsReleases = {
    os,
    current: splitRunning(osVersion),
    latest: null,
    behind: 0,
    releases: [],
    checkedAt: new Date().toISOString(),
    source: TABLE_URL,
    error: null,
  }
  let rows: IosTableRow[]
  try {
    rows = parseIosTable(await securityTable(), os)
    if (rows.length === 0) {
      throw new Error(`the security table had no ${APPLE_OS_NAME[os]} rows`)
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e)
    return { ...base, error: `Apple’s release table did not answer: ${why}` }
  }
  rows.sort((a, b) => compareVersions(b.version, a.version))
  const newer = rows.filter((r) => compareVersions(r.version, base.current.version) > 0)
  // The feed is worth having but not worth losing the list over.
  const feed = await versionFeed().catch(() => null)

  const enrich = async (r: IosTableRow): Promise<AppleOsRelease> => {
    const feedVersion = r.version.includes('.') ? r.version : `${r.version}.0`
    const none = { cves: null, note: null }
    const [notes, sec] = await Promise.all([
      releaseNotes(feedVersion, os).catch(() => ({ url: null, sections: [] })),
      r.url === null ? Promise.resolve(none) : securityContent(r.url).catch(() => none),
    ])
    return {
      version: r.version,
      build: iosBuildFor(feed?.get(feedVersion) ?? feed?.get(r.version), os, model),
      date: r.date,
      notesUrl: notes.url,
      securityUrl: r.url,
      cves: sec.cves,
      summary: releaseSummary(sec.cves, sec.note ?? r.note),
      notes: notes.sections,
    }
  }
  return {
    ...base,
    latest: rows[0]?.version ?? null,
    behind: newer.length,
    releases: await Promise.all(newer.slice(0, LISTED).map(enrich)),
  }
}
