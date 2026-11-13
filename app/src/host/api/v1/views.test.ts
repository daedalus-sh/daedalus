import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../../core/ctx'
import type { DeviceAccessory, DeviceFacts } from '../../../lib/agent/light'
import type { AppleOsReleases } from '../../../lib/dashboard/ios-releases'
import type { NodeAccessory, NodeSystemData } from '../../../lib/dashboard/node-system'
import type { NodeRow } from '../../../lib/repo/nodes'
import { machineDetail, machines } from './views'

// What /api/v1 says of a phone's watch: in the list, a line of the phone's
// item and a machine of its own directly after it; on the phone's page, the
// watch's facts with Apple's watchOS list; and under its own id, the same as
// a machine's page. The loaders are the pages' own and are tested where they
// live; here they answer what a phone with a watch, a phone without one and a
// Mac would. The watch's own loader (lib/dashboard/accessory-system.ts) runs
// for real, over a controller that holds nothing and these rows.

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  system: null as unknown,
  asked: [] as unknown[],
  detail: null as unknown,
  releases: null as unknown,
}))

vi.mock('../../../lib/dashboard/machines', () => ({
  loadMachines: async () => ({
    machines: h.rows.map((node) => ({ node, pending: null, status: null, shape: null })),
  }),
}))
vi.mock('../../../lib/dashboard/node-system', () => ({
  loadNodeSystem: async (_ctx: unknown, id: string, opts: unknown) => {
    h.asked.push([id, opts])
    return h.system
  },
  watchReleases: async (a: { osVersion: string | null }) =>
    a.osVersion === null ? null : h.releases,
}))
vi.mock('../../controller/nodes', () => ({
  readNode: async () => ({ detail: h.detail, error: null, answered: true }),
}))
vi.mock('../../../lib/repo/nodes', () => ({
  getNode: async (id: string) => (h.rows as { id: string }[]).find((n) => n.id === id) ?? null,
}))
vi.mock('../../../lib/dashboard/box-head', () => ({
  loadBoxHead: async () => ({
    hostname: 'box',
    os: 'NixOS',
    kernel: null,
    arch: 'x86_64',
    model: null,
  }),
}))
vi.mock('../../../lib/dashboard/claude', () => ({
  readControllerClaude: async () => ({ report: null, state: 'not-run', detail: '' }),
}))

const ctx = { controller: { call: async () => ({ version: '0.31.0' }) } } as unknown as Ctx

const WATCH: DeviceAccessory = {
  kind: 'watch',
  name: 'Santiago’s Apple Watch',
  model: 'Watch7,5',
  osVersion: '26.1',
  osBuild: '23S37',
  battery: { percent: 64, charging: false },
  storage: { totalBytes: 64_000_000_000, freeBytes: 41_000_000_000 },
  at: '2026-11-12T09:58:30Z',
}

const device = (accessories: DeviceAccessory[]): DeviceFacts => ({
  model: 'iPhone17,1',
  osVersion: '26.1',
  appVersion: '1.0.0',
  battery: { percent: 82, charging: true },
  storage: { totalBytes: 256_000_000_000, freeBytes: 100_000_000_000 },
  memoryBytes: 8_000_000_000,
  accessories,
  at: '2026-11-12T10:00:00Z',
})

const node = (id: string, os: string, d: DeviceFacts | null): NodeRow =>
  ({
    id,
    name: id,
    os,
    arch: 'arm64',
    agentVersion: '1.0.0',
    state: 'approved',
    connected: false,
    lastSeenAgo: 12.4,
    lastSeenAt: '2026-11-12T10:00:00Z',
    light: os === 'ios' || os === 'ipados',
    claude: null,
    policy: {},
    device: d,
  }) as NodeRow

const PHONE = 'aaaaaaaaaaaaaaaa'
const BARE = 'bbbbbbbbbbbbbbbb'
const MAC = 'cccccccccccccccc'

const RELEASES: AppleOsReleases = {
  os: 'watchos',
  current: { version: '26.1', build: '23S37' },
  latest: '27.2.1',
  behind: 1,
  releases: [
    {
      version: '27.2.1',
      build: '24S132',
      date: '2026-11-09',
      notesUrl:
        'https://developer.apple.com/documentation/watchos-release-notes/watchos-27_2-release-notes',
      securityUrl: 'https://support.apple.com/en-us/149722',
      cves: 9,
      summary: '9 security fixes',
      notes: [{ area: 'StoreKit', kind: 'Resolved Issues', items: ['Fixed.'] }],
    },
  ],
  checkedAt: '2026-11-12T10:00:00Z',
  source: 'https://support.apple.com/en-us/100100',
  error: null,
}

const system = (n: NodeRow, accessories: NodeAccessory[]): NodeSystemData => ({
  node: n,
  status: null,
  telemetry: null,
  providers: null,
  releases: null,
  browserLatest: null,
  macos: null,
  ios: null,
  accessories,
  cpuSpark: [],
  error: 'not connected',
})

beforeEach(() => {
  h.rows = []
  h.system = null
  h.asked = []
  h.detail = null
  h.releases = null
  vi.useRealTimers()
})

describe('GET /machines', () => {
  it('lists a phone’s watch on the phone, and nothing on any other machine', async () => {
    h.rows = [
      node(PHONE, 'ios', device([WATCH])),
      node(BARE, 'ios', device([])),
      node(MAC, 'macos', null),
    ]
    const { machines: list } = await machines(ctx, PHONE)
    expect(list.map((m) => [m.id, m.accessories])).toEqual([
      ['box', []],
      [
        PHONE,
        [
          {
            kind: 'watch',
            name: 'Santiago’s Apple Watch',
            battery: { percent: 64, charging: false },
          },
        ],
      ],
      [`${PHONE}.watch`, []],
      [BARE, []],
      [MAC, []],
    ])
  })

  it('lists the watch as a machine of its own, directly after its phone', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-12T10:00:00Z') })
    h.rows = [
      node(MAC, 'macos', null),
      { ...node(PHONE, 'ios', device([WATCH, { ...WATCH, name: 'An older one' }])), name: 'Phone' },
      node(BARE, 'ios', device([])),
    ]
    const { machines: list } = await machines(ctx, PHONE)
    expect(list.map((m) => [m.id, m.kind, m.via])).toEqual([
      ['box', 'box', null],
      [MAC, 'node', null],
      [PHONE, 'node', null],
      [`${PHONE}.watch`, 'accessory', { id: PHONE, name: 'Phone' }],
      [BARE, 'node', null],
    ])
    // One watch per phone: the first its sample listed.
    expect(list[3]).toEqual({
      id: `${PHONE}.watch`,
      kind: 'accessory',
      name: 'Santiago’s Apple Watch',
      os: 'watchos',
      arch: '',
      agentVersion: null,
      state: 'approved',
      connected: null,
      // From the watch's own reading time, not its phone's.
      lastSeenAgo: 90,
      lastSeenAt: '2026-11-12T09:58:30Z',
      light: true,
      self: false,
      model: 'Watch7,5',
      updateAvailable: null,
      restartPending: false,
      claude: null,
      battery: { percent: 64, charging: false },
      accessories: [],
      via: { id: PHONE, name: 'Phone' },
    })
  })

  it('names the watch as Settings › Machines does, and drops it with a revoked phone', async () => {
    const named = { ...node(PHONE, 'ios', device([WATCH])), policy: { watchName: 'Wrist' } }
    const nameless = node(BARE, 'ios', device([{ ...WATCH, name: null }]))
    const revoked = { ...node(MAC, 'ios', device([WATCH])), state: 'revoked' }
    h.rows = [named, nameless, revoked]
    const { machines: list } = await machines(ctx, PHONE)
    expect(list.map((m) => [m.id, m.name])).toEqual([
      ['box', 'box'],
      [PHONE, PHONE],
      [`${PHONE}.watch`, 'Wrist'],
      [BARE, BARE],
      [`${BARE}.watch`, 'Apple Watch'],
      [MAC, MAC],
    ])
    // The phone's own line of it still carries what the watch calls itself.
    expect(list[1]?.accessories[0]?.name).toBe('Santiago’s Apple Watch')
  })
})

describe('GET /machines/<phone id>.watch', () => {
  const { notes: _notes, ...row } = RELEASES.releases[0] as AppleOsReleases['releases'][number]

  it('answers the watch’s facts and its watchOS list, through its phone', async () => {
    h.rows = [{ ...node(PHONE, 'ios', device([WATCH])), name: 'Phone', policy: { watchName: 'W' } }]
    h.releases = RELEASES
    const d = await machineDetail(ctx, `${PHONE}.watch`, PHONE)
    if (d === null || d.kind !== 'accessory') throw new Error('not an accessory')
    expect(d.via).toEqual({ id: PHONE, name: 'Phone' })
    expect(d.machine).toMatchObject({
      id: `${PHONE}.watch`,
      kind: 'accessory',
      name: 'W',
      os: 'watchos',
      state: 'approved',
      connected: null,
      lastSeenAt: WATCH.at,
      self: false,
      via: { id: PHONE, name: 'Phone' },
    })
    // The existing AccessoryView: the reported name, never the display name.
    expect(d.accessory).toEqual({ ...WATCH, osReleases: { ...RELEASES, releases: [row] } })
    // The node loader was not asked: a watch is no node.
    expect(h.asked).toEqual([])
  })

  it('has no list for a watch that has not said its watchOS', async () => {
    h.rows = [node(PHONE, 'ios', device([{ ...WATCH, osVersion: null, osBuild: null }]))]
    h.releases = RELEASES
    const d = await machineDetail(ctx, `${PHONE}.watch`, PHONE)
    if (d === null || d.kind !== 'accessory') throw new Error('not an accessory')
    expect(d.accessory.osReleases).toBeNull()
  })

  it('is no machine when the phone has no watch, is revoked, is gone, or is a computer', async () => {
    h.rows = [
      node(BARE, 'ios', device([])),
      { ...node(PHONE, 'ios', device([WATCH])), state: 'revoked' },
      node(MAC, 'macos', null),
    ]
    for (const id of [BARE, PHONE, MAC, 'dddddddddddddddd']) {
      expect(await machineDetail(ctx, `${id}.watch`, PHONE), id).toBeNull()
    }
  })
})

describe('GET /machines/:id', () => {
  it('gives a phone its watch, with Apple’s watchOS list cut to what a screen shows', async () => {
    const n = node(PHONE, 'ios', device([WATCH]))
    h.system = system(n, [{ ...WATCH, releases: RELEASES }])
    const d = await machineDetail(ctx, PHONE, PHONE)
    expect(h.asked).toEqual([[PHONE, { ios: true, watch: true }]])
    if (d === null || d.kind !== 'node') throw new Error('not a node')
    expect(d.machine.accessories).toEqual([
      { kind: 'watch', name: 'Santiago’s Apple Watch', battery: { percent: 64, charging: false } },
    ])
    const { notes: _notes, ...row } = RELEASES.releases[0] as AppleOsReleases['releases'][number]
    expect(d.device?.accessories).toEqual([
      { ...WATCH, osReleases: { ...RELEASES, releases: [row] } },
    ])
    // The phone's own facts are untouched beside it.
    expect(d.device).toMatchObject({
      model: 'iPhone17,1',
      battery: { percent: 82, charging: true },
    })
  })

  it('answers the live list over the row’s, and no list for a watch that said no version', async () => {
    // The row kept a watch; the phone's last sample has another reading.
    const n = node(PHONE, 'ios', device([WATCH]))
    const live = { ...WATCH, osVersion: null, osBuild: null, battery: null }
    h.system = system(n, [{ ...live, releases: null }])
    const d = await machineDetail(ctx, PHONE, PHONE)
    if (d === null || d.kind !== 'node') throw new Error('not a node')
    expect(d.device?.accessories).toEqual([{ ...live, osReleases: null }])
    expect(d.machine.accessories).toEqual([
      { kind: 'watch', name: 'Santiago’s Apple Watch', battery: null },
    ])
  })

  it('has no accessories for a phone without a watch or for a computer', async () => {
    const bare = node(BARE, 'ios', device([]))
    h.system = system(bare, [])
    const phone = await machineDetail(ctx, BARE, PHONE)
    if (phone === null || phone.kind !== 'node') throw new Error('not a node')
    expect(phone.machine.accessories).toEqual([])
    expect(phone.device?.accessories).toEqual([])

    h.system = system(node(MAC, 'macos', null), [])
    const mac = await machineDetail(ctx, MAC, PHONE)
    if (mac === null || mac.kind !== 'node') throw new Error('not a node')
    expect(mac.machine.accessories).toEqual([])
    expect(mac.device).toBeNull()
  })
})
