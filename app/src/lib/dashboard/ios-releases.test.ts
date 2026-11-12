import { describe, expect, it } from 'vitest'

import { iosBuildFor, iosNotesSlugs, parseIosTable, releaseSummary } from './ios-releases'
import { parsePmv } from './macos-releases'

// Rows the way support.apple.com/100100 lays them out: three cells; the
// name is a link when the release has security content, a bare paragraph
// with a note under it when it has none.
const cell = (inner: string) =>
  `<td class="gb-table-cell tablecell-align-left" colspan="1" rowspan="1">${inner}</td>`
const p = (inner: string) => `<p class="gb-paragraph">${inner}</p>`
const NONE = `<div class="note gb-note">${p('This update has no published CVE entries.')}</div>`
const row = (name: string, href: string | null, avail: string, date: string, note = '') =>
  `<tr>${cell(
    p(href === null ? name : `<a href="${href}" class="gb-anchor">${name}</a>`) + note,
  )}${cell(p(avail))}${cell(p(date))}</tr>`

const TABLE = `<table>
${[
  row(
    'iOS 27.2.1 and iPadOS 27.2.1',
    'https://support.apple.com/en-us/149715',
    'iPhone 11 and later, iPad Pro 12.9-inch 4th generation and later',
    '09 Nov 2026',
  ),
  row('macOS Golden Gate 27.2.1', 'https://support.apple.com/en-us/149716', 'macOS', '09 Nov 2026'),
  row('iOS 27.1', null, 'iPhone Duo', '23 Oct 2026', NONE),
  row(
    'Background Security Improvements for iOS, iPadOS, and macOS',
    'https://support.apple.com/en-us/149600',
    'iOS 27.0.1, iPadOS 27.0.1',
    '02 Oct 2026',
  ),
  row('iOS 27.0.1 and iPadOS 27.0.1', null, 'iPhone 11 and later', '28 Sep 2026', NONE),
  row(
    'iOS 27 and iPadOS 27',
    'https://support.apple.com/en-us/149100',
    'iPhone 11 and later',
    '14 Sep 2026',
  ),
  row('watchOS 27', 'https://support.apple.com/en-us/149101', 'Apple Watch', '14 Sep 2026'),
  row(
    'iPadOS 17.7.11',
    'https://support.apple.com/en-us/149050',
    'iPad Pro 12.9-inch 2nd generation',
    '14 Sep 2026',
  ),
  row('iPadOS 17.7.8', null, 'iPad Pro 12.9-inch 2nd generation', '20 Aug 2026', NONE),
].join('\n')}
</table>`

describe('the security table', () => {
  it('keeps the rows that name iOS with a version', () => {
    const rows = parseIosTable(TABLE, 'ios')
    expect(rows.map((r) => r.version)).toEqual(['27.2.1', '27.1', '27.0.1', '27'])
    expect(rows[0]).toEqual({
      version: '27.2.1',
      date: '2026-11-09',
      url: 'https://support.apple.com/en-us/149715',
      note: null,
    })
  })

  it('keeps the rows that name iPadOS with a version, the iPad-only ones included', () => {
    expect(parseIosTable(TABLE, 'ipados').map((r) => r.version)).toEqual([
      '27.2.1',
      '27.0.1',
      '27',
      '17.7.11',
      '17.7.8',
    ])
  })

  it('reads an unlinked title and carries Apple’s note beside it', () => {
    expect(parseIosTable(TABLE, 'ios')[1]).toEqual({
      version: '27.1',
      date: '2026-10-23',
      url: null,
      note: 'This update has no published CVE entries.',
    })
    expect(parseIosTable(TABLE, 'ipados')[4]?.note).toBe(
      'This update has no published CVE entries.',
    )
  })

  it('answers nothing for a page without the table', () => {
    expect(parseIosTable('<html><body>Access Denied</body></html>', 'ios')).toEqual([])
  })
})

describe('the version feed', () => {
  // The iOS set as gdmf.apple.com/v2/pmv prints it: watches and Apple TVs
  // beside the phones, under the same version numbers.
  const set = (ProductVersion: string, Build: string, SupportedDevices: string[]) => ({
    ProductVersion,
    Build,
    PostingDate: '2026-11-09',
    ExpirationDate: '2027-02-10',
    SupportedDevices,
  })
  const feed = parsePmv(
    JSON.stringify({
      PublicAssetSets: {
        iOS: [
          set('27.2.1', '24B92034', ['iPhone19,4']),
          set('27.2.1', '24S132', ['Watch7,1', 'Watch7,10']),
          set('27.2.1', '24B9156', ['iPad19,1', 'iPad19,2']),
          set('27.2.1', '24B6156', ['iPad14,3', 'iPhone17,1']),
          set('27.2.1', '24B156', ['iPad14,3', 'iPhone17,1']),
          set('27.2.1', '24B91034', ['iPhone19,4']),
          set('27.2', '24K122', ['AppleTV11,1', 'AppleTV14,1']),
          set('18.7.12', '22H6390', ['iPad7,11', 'iPad7,12']),
          set('18.7.12', '22H390', ['iPad7,11', 'iPad7,12', 'iPhone11,2']),
        ],
        macOS: [set('27.2.1', '26C99', ['J516sAP'])],
      },
    }),
    'iOS',
  )

  it('reads the iOS set, not the Mac one', () => {
    expect([...feed.keys()]).toEqual(['27.2.1', '27.2', '18.7.12'])
    expect(parsePmv('{"PublicAssetSets":{"iOS":[]}}').size).toBe(0)
  })

  it('picks the lowest build that lists the model', () => {
    expect(iosBuildFor(feed.get('27.2.1'), 'ios', 'iPhone17,1')).toBe('24B156')
    expect(iosBuildFor(feed.get('27.2.1'), 'ios', 'iPhone19,4')).toBe('24B91034')
    expect(iosBuildFor(feed.get('27.2.1'), 'ipados', 'iPad19,2')).toBe('24B9156')
  })

  it('falls back to the family’s lowest build, never a watch’s', () => {
    expect(iosBuildFor(feed.get('27.2.1'), 'ios', null)).toBe('24B156')
    expect(iosBuildFor(feed.get('27.2.1'), 'ipados', 'iPad1,1')).toBe('24B156')
    expect(iosBuildFor(feed.get('18.7.12'), 'ios', null)).toBe('22H390')
    expect(iosBuildFor(feed.get('27.2'), 'ios', null)).toBeNull()
    expect(iosBuildFor(feed.get('27.2'), 'ipados', 'iPad14,3')).toBeNull()
    expect(iosBuildFor(undefined, 'ios', 'iPhone17,1')).toBeNull()
  })
})

describe('release notes', () => {
  it('names the page for a point release, then the major’s', () => {
    expect(iosNotesSlugs('26.1')).toEqual([
      'ios-ipados-26_1-release-notes',
      'ios-ipados-26-release-notes',
    ])
    expect(iosNotesSlugs('26.7.3')).toEqual([
      'ios-ipados-26_7-release-notes',
      'ios-ipados-26-release-notes',
    ])
    expect(iosNotesSlugs('27.0')).toEqual([
      'ios-ipados-27_0-release-notes',
      'ios-ipados-27-release-notes',
    ])
  })
})

describe('the summary line', () => {
  it('counts the fixes, else keeps Apple’s line', () => {
    expect(releaseSummary(23, null)).toBe('23 security fixes')
    expect(releaseSummary(1, null)).toBe('1 security fix')
    expect(releaseSummary(0, 'This update has no published CVE entries.')).toBe(
      'This update has no published CVE entries.',
    )
    expect(releaseSummary(null, null)).toBeNull()
  })
})
