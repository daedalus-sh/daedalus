import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../../core/ctx'
import type { DeviceAccessory, DeviceFacts } from '../../../lib/agent/light'
import type { AppleOsReleases } from '../../../lib/dashboard/ios-releases'
import type { NodeAccessory, NodeSystemData } from '../../../lib/dashboard/node-system'
import type { NodeRow } from '../../../lib/repo/nodes'
import { machineDetail, machines } from './views'

// What /api/v1 says of a phone's watch: in the list, a line of the phone's
// item; on the phone's page, the watch's facts with Apple's watchOS list.
// The loaders are the pages' own and are tested where they live; here they
// answer what a phone with a watch, a phone without one and a Mac would.

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  system: null as unknown,
  asked: [] as unknown[],
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
      [BARE, []],
      [MAC, []],
    ])
    // The watch is a line of its phone, never a machine in the list.
    expect(list).toHaveLength(4)
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
