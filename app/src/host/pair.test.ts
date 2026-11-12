import { describe, expect, it } from 'vitest'
import { PAIR_TICKET_MS, readPairLink } from '../lib/pair-link'
import type { SystemInfo } from './controller/generated'
import type { DesiredSync } from './controller/nodes'
import { nodeIdOf } from './controller/nodes'
import { codeHash, type NodeStanding, type Tunnel } from './enroll'
import {
  addPhone,
  type PairDeps,
  type PairRedeemed,
  type PairStore,
  pairBody,
  redeemPair,
  sweepTickets,
  type TicketRow,
} from './pair'
import type { WgEasy } from './wg-easy'

// A phone's pairing against fakes: an in-memory store, a wg-easy that records
// its calls and fails where told, a controller that answers or does not.

const KEY = 'ab'.repeat(32)
const ID = nodeIdOf(KEY)
const LAN = '192.168.0.2'
const ALIAS = '169.254.1.2'
const T0 = 1_800_000_000_000

const conf = (address: string) => `[Interface]
PrivateKey = oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=
Address = ${address}/32
MTU = 1280

[Peer]
PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
PresharedKey = FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=
AllowedIPs = ${LAN}/32
PersistentKeepalive = 25
Endpoint = box.example.org:51820`

type Node = NodeStanding & { os: string; hostname: string; model: string | null }

function memoryStore(failAt?: 'setTunnel' | 'approve') {
  const nodes = new Map<string, Node>()
  const tunnels = new Map<string, Tunnel>()
  const tickets = new Map<string, TicketRow & { spentAt: Date | null }>()
  const standingOf = (n: Node): NodeStanding => ({
    state: n.state,
    approvedAt: n.approvedAt,
    approvedBy: n.approvedBy,
    revokedAt: n.revokedAt,
  })
  const store: PairStore = {
    standing: async (id) => {
      const n = nodes.get(id)
      return n === undefined ? null : standingOf(n)
    },
    approve: async (r) => {
      if (failAt === 'approve') throw new Error('the table is gone')
      const n = nodes.get(r.id)
      nodes.set(r.id, {
        os: n?.os ?? r.os,
        hostname: n?.hostname ?? r.hostname,
        model: n?.model ?? null,
        state: 'approved',
        approvedAt: new Date(T0),
        approvedBy: r.by,
        revokedAt: null,
      })
      return n === undefined ? null : standingOf(n)
    },
    restore: async (id, prior) => {
      const n = nodes.get(id)
      if (prior === null) nodes.delete(id)
      else if (n !== undefined) nodes.set(id, { ...n, ...prior })
    },
    tunnelOf: async (id) => tunnels.get(id) ?? null,
    setTunnel: async (id, t) => {
      if (failAt === 'setTunnel') throw new Error('the table is gone')
      tunnels.set(id, t)
    },
    deleteTunnel: async (id) => {
      tunnels.delete(id)
    },
    osOf: async (id) => nodes.get(id)?.os ?? null,
    setFacts: async (id, f) => {
      const n = nodes.get(id)
      if (n !== undefined) {
        nodes.set(id, { ...n, hostname: f.hostname, os: f.os, model: f.device.model })
      }
    },
    putTicket: async (row) => {
      tickets.set(row.ticketHash, { ...row, spentAt: null })
    },
    takeTicket: async (hash, at) => {
      const t = tickets.get(hash)
      if (t === undefined || t.spentAt !== null) return null
      t.spentAt = at
      return t
    },
    deleteTicket: async (hash) => {
      tickets.delete(hash)
    },
    ticketsBefore: async (before) =>
      [...tickets.values()].filter((t) => t.expiresAt.getTime() < before.getTime()),
    clientBound: async (clientId) => [...tunnels.values()].some((t) => t.clientId === clientId),
  }
  return { store, nodes, tunnels, tickets }
}

function fakeWg(failAt?: string) {
  const calls: string[] = []
  const clients = new Map<number, Record<string, unknown>>()
  let iface: Record<string, unknown> = { firewallEnabled: false }
  let next = 7
  const step = (s: string, detail = '') => {
    calls.push(detail === '' ? s : `${s} ${detail}`)
    if (failAt === s) throw new Error(`wg-easy answered ${s} with 500`)
  }
  const wg: WgEasy = {
    getInterface: async () => ({ ...iface }),
    updateInterface: async (i) => {
      iface = { ...i }
    },
    createClient: async (name) => {
      step('createClient', name)
      const id = next++
      clients.set(id, { id, name, ipv4Address: `10.8.0.${String(id)}` })
      return id
    },
    getClient: async (id) => {
      step('getClient', String(id))
      return { ...(clients.get(id) as Record<string, unknown>), id }
    },
    updateClient: async (id, c) => {
      step('updateClient', String(id))
      clients.set(id, { ...c })
    },
    configuration: async (id) => {
      step('configuration', String(id))
      return conf(String(clients.get(id)?.ipv4Address))
    },
    deleteClient: async (id) => {
      step('deleteClient', String(id))
      clients.delete(id)
    },
  }
  return { wg, calls, clients, iface: () => iface }
}

const SYSTEM = {
  controller: {
    public_key: 'cd'.repeat(32),
    fingerprint: 'c0de:f00d',
    listen: '0.0.0.0:7788',
    advertise: ['box.example.org:7788'],
    rotation: null,
  },
} as unknown as SystemInfo

const syncWith =
  (over: Partial<DesiredSync> = {}, count = { n: 0 }) =>
  async (): Promise<DesiredSync> => {
    count.n++
    return {
      at: '',
      sent: [{ id: ID, state: 'approved' }],
      skipped: [],
      answer: null,
      error: null,
      ...over,
    }
  }

function world(over: Partial<PairDeps> = {}, failStore?: 'setTunnel' | 'approve') {
  const s = memoryStore(failStore)
  const w = fakeWg()
  const minted: string[] = []
  const clock = { now: T0 }
  const deps: PairDeps = {
    store: s.store,
    wg: w.wg,
    systemInfo: async () => SYSTEM,
    sync: syncWith(),
    mintToken: async (id) => {
      minted.push(id)
      return `dnode_${'t'.repeat(43)}`
    },
    lanIp: LAN,
    hostAlias: ALIAS,
    appHostname: 'daedalus-app.example.org',
    boxHostname: 'box',
    now: () => clock.now,
    log: () => {},
    ...over,
  }
  return { ...s, ...w, deps, minted, clock }
}

const BODY = {
  public_key: KEY,
  hostname: 'Santi’s iPhone',
  os: 'ios',
  arch: 'arm64',
  version: '1.0.0',
  model: 'iPhone17,1',
}

async function offer(w: ReturnType<typeof world>, actor = 'santi@example.org') {
  const made = await addPhone(w.deps, { actor })
  if (!made.ok) throw new Error(made.reason)
  const payload = readPairLink(made.value.link)
  if (payload === null) throw new Error('the link does not read back')
  return { ...made.value, payload }
}

describe('Add a phone or tablet', () => {
  it('makes a client confined to the link and traefik, and a link that carries it', async () => {
    const w = world()
    const o = await offer(w)
    expect(w.iface().firewallEnabled).toBe(true)
    const client = w.clients.get(7)
    expect(client?.allowedIps).toEqual([`${LAN}/32`])
    // The controller's link at the host alias (DNATed), traefik at the LAN
    // address (forwarded) — and no session host, no sshd.
    expect(client?.firewallIps).toEqual([`${ALIAS}:7788/tcp`, `${LAN}:443/tcp`])
    expect(client?.mtu).toBe(1280)
    expect(client?.persistentKeepalive).toBe(25)

    expect(o.payload.v).toBe(1)
    expect(o.payload.app).toBe('https://daedalus-app.example.org')
    expect(o.payload.box).toBe('box')
    expect(o.payload.wireguard).toEqual({
      private_key: 'oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=',
      address: '10.8.0.7',
      server_public_key: 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=',
      preshared_key: 'FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=',
      endpoint: 'box.example.org:51820',
      allowed_ips: [`${LAN}/32`],
    })
    expect(o.svg.startsWith('<svg')).toBe(true)
    expect(Date.parse(o.expiresAt)).toBe(T0 + PAIR_TICKET_MS)

    // Stored by digest, bound to the admin and the client; never the code.
    const [ticket] = [...w.tickets.values()]
    expect(ticket?.ticketHash).toBe(codeHash(o.payload.code))
    expect(ticket?.createdBy).toBe('santi@example.org')
    expect(ticket?.clientId).toBe(7)
    expect(JSON.stringify([...w.tickets.values()])).not.toContain(o.payload.code)
  })

  it('refuses before making anything when the box cannot say where it is', async () => {
    for (const over of [
      { lanIp: '' },
      { hostAlias: '' },
      { appHostname: null },
      {
        systemInfo: async () => {
          throw new Error('socket gone')
        },
      },
    ] as Partial<PairDeps>[]) {
      const w = world(over)
      expect((await addPhone(w.deps, { actor: 'a' })).ok).toBe(false)
      expect(w.calls).toEqual([])
      expect(w.tickets.size).toBe(0)
    }
  })

  it('deletes the client again when a later step fails', async () => {
    const w = world()
    const broken = fakeWg('configuration')
    const made = await addPhone({ ...w.deps, wg: broken.wg }, { actor: 'a' })
    expect(made.ok).toBe(false)
    expect(broken.clients.size).toBe(0)
    expect(w.tickets.size).toBe(0)
  })

  it('sweeps the tickets nobody redeemed, client and row, on the next Add', async () => {
    const w = world()
    await offer(w)
    expect(w.clients.has(7)).toBe(true)
    w.clock.now = T0 + PAIR_TICKET_MS + 61_000
    await offer(w)
    expect(w.clients.has(7)).toBe(false)
    expect([...w.clients.keys()]).toEqual([8])
    expect(w.tickets.size).toBe(1)
  })
})

describe('the sweep', () => {
  it('leaves a live ticket, and one whose redeem may still be running', async () => {
    const w = world()
    await offer(w)
    w.clock.now = T0 + PAIR_TICKET_MS + 30_000
    expect(await sweepTickets(w.deps)).toBe(0)
    expect(w.clients.has(7)).toBe(true)
  })

  it('never deletes a client a node’s tunnel is', async () => {
    const w = world()
    await offer(w)
    w.tunnels.set(ID, { clientId: 7, address: '10.8.0.7' })
    w.clock.now = T0 + 3_600_000
    expect(await sweepTickets(w.deps)).toBe(1)
    expect(w.clients.has(7)).toBe(true)
    expect(w.tickets.size).toBe(0)
  })

  it('keeps the row when wg-easy fails, and does nothing without one', async () => {
    const w = world()
    await offer(w)
    w.clock.now = T0 + 3_600_000
    expect(await sweepTickets({ ...w.deps, wg: fakeWg('deleteClient').wg })).toBe(0)
    expect(w.tickets.size).toBe(1)
    expect(await sweepTickets({ ...w.deps, wg: null })).toBe(0)
    expect(w.tickets.size).toBe(1)
  })
})

describe('the redeem', () => {
  it('approves the node under the ticket’s admin, binds the tunnel, mints its token', async () => {
    const count = { n: 0 }
    const w = world({ sync: syncWith({}, count) })
    const o = await offer(w)
    const a = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    expect(a.status).toBe(200)
    const body = a.body as PairRedeemed
    expect(body).toEqual({
      node: ID,
      controller: { pin: 'c0de:f00d', address: `${LAN}:7788` },
      box: { hostname: 'box' },
      token: `dnode_${'t'.repeat(43)}`,
    })
    const n = w.nodes.get(ID)
    expect(n?.state).toBe('approved')
    expect(n?.approvedBy).toBe('santi@example.org')
    expect(n?.os).toBe('ios')
    expect(n?.model).toBe('iPhone17,1')
    expect(w.tunnels.get(ID)).toEqual({ clientId: 7, address: '10.8.0.7' })
    expect(w.minted).toEqual([ID])
    expect(count.n).toBe(1)
    expect(w.tickets.size).toBe(0)
    // Recognisable in wg-easy from here on.
    expect(w.clients.get(7)?.name).toBe('daedalus-santi-s-iphone')
  })

  it('works once: the same code again finds nothing and changes nothing', async () => {
    const w = world()
    const o = await offer(w)
    await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    const again = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    expect(again.status).toBe(400)
    expect(w.minted).toHaveLength(1)
    expect(w.clients.has(7)).toBe(true)
  })

  it('spends the ticket before it checks the rest: a bad body costs the pairing', async () => {
    const w = world()
    const o = await offer(w)
    const bad = await redeemPair(w.deps, { code: o.payload.code, ...BODY, os: 'macos' })
    expect(bad.status).toBe(400)
    expect(w.nodes.size).toBe(0)
    // The dead ticket's tunnel goes with it.
    expect(w.clients.has(7)).toBe(false)
    expect(w.tickets.size).toBe(0)
    const good = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    expect(good.status).toBe(400)
    expect(w.minted).toEqual([])
  })

  it('refuses a code that is not one, without looking anything up', async () => {
    const w = world()
    await offer(w)
    for (const body of [null, [], 'x', {}, { code: 'short' }, { code: 7 }, { ...BODY }]) {
      expect((await redeemPair(w.deps, body)).status).toBe(400)
    }
    expect([...w.tickets.values()][0]?.spentAt).toBeNull()
    expect(w.clients.has(7)).toBe(true)
  })

  it('refuses an expired ticket, and spends it', async () => {
    const w = world()
    const o = await offer(w)
    w.clock.now = T0 + PAIR_TICKET_MS
    const a = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    expect(a).toEqual({ status: 400, body: { error: 'this code expired; add the device again' } })
    expect(w.nodes.size).toBe(0)
    expect(w.clients.has(7)).toBe(false)
  })

  it('refuses a key that belongs to a machine that is not a phone', async () => {
    const w = world()
    w.nodes.set(ID, {
      os: 'macos',
      hostname: 'mac',
      model: null,
      state: 'approved',
      approvedAt: new Date(1),
      approvedBy: 'earlier',
      revokedAt: null,
    })
    w.tunnels.set(ID, { clientId: 3, address: '10.8.0.3' })
    const o = await offer(w)
    const a = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
    expect(a.status).toBe(409)
    expect(w.minted).toEqual([])
    expect(w.tunnels.get(ID)).toEqual({ clientId: 3, address: '10.8.0.3' })
    expect(w.nodes.get(ID)?.approvedBy).toBe('earlier')
    expect(w.clients.has(7)).toBe(false)
  })

  it('undoes the approval when the controller does not take it', async () => {
    for (const sync of [
      syncWith({ error: 'socket gone' }),
      syncWith({ sent: [{ id: 'f'.repeat(16), state: 'approved' }] }),
    ]) {
      const w = world({ sync })
      const o = await offer(w)
      const a = await redeemPair(w.deps, { code: o.payload.code, ...BODY })
      expect(a.status).toBe(502)
      expect(w.nodes.size).toBe(0)
      expect(w.tunnels.size).toBe(0)
      expect(w.minted).toEqual([])
      expect(w.clients.has(7)).toBe(false)
      expect(w.tickets.size).toBe(0)
    }
  })

  it('answers 502 and changes nothing when the controller cannot be asked', async () => {
    const w = world()
    const o = await offer(w)
    const a = await redeemPair(
      {
        ...w.deps,
        systemInfo: async () => {
          throw new Error('socket gone')
        },
      },
      { code: o.payload.code, ...BODY },
    )
    expect(a.status).toBe(502)
    expect(w.nodes.size).toBe(0)
    expect(w.clients.has(7)).toBe(false)
  })

  it('puts everything back when the tunnel cannot be recorded or the token minted', async () => {
    const failing = world({}, 'setTunnel')
    const o1 = await offer(failing)
    expect((await redeemPair(failing.deps, { code: o1.payload.code, ...BODY })).status).toBe(502)
    expect(failing.nodes.size).toBe(0)
    expect(failing.clients.size).toBe(0)

    const w = world({
      mintToken: async () => {
        throw new Error('the table is gone')
      },
    })
    const o2 = await offer(w)
    expect((await redeemPair(w.deps, { code: o2.payload.code, ...BODY })).status).toBe(502)
    expect(w.nodes.size).toBe(0)
    expect(w.tunnels.size).toBe(0)
    expect(w.clients.size).toBe(0)
  })

  it('pairs the same phone again: its tunnel and token replaced, the old client deleted', async () => {
    const w = world()
    const first = await offer(w)
    await redeemPair(w.deps, { code: first.payload.code, ...BODY })
    const second = await offer(w, 'other@example.org')
    const a = await redeemPair(w.deps, { code: second.payload.code, ...BODY })
    expect(a.status).toBe(200)
    expect(w.tunnels.get(ID)).toEqual({ clientId: 8, address: '10.8.0.8' })
    expect([...w.clients.keys()]).toEqual([8])
    expect(w.minted).toEqual([ID, ID])
    expect(w.nodes.get(ID)?.approvedBy).toBe('other@example.org')
  })

  it('keeps an approved phone approved, with its tunnel, when pairing again fails', async () => {
    const w = world()
    const first = await offer(w)
    await redeemPair(w.deps, { code: first.payload.code, ...BODY })
    const second = await offer(w)
    const a = await redeemPair(
      { ...w.deps, sync: syncWith({ error: 'socket gone' }) },
      { code: second.payload.code, ...BODY },
    )
    expect(a.status).toBe(502)
    expect(w.nodes.get(ID)?.state).toBe('approved')
    expect(w.tunnels.get(ID)).toEqual({ clientId: 7, address: '10.8.0.7' })
    expect([...w.clients.keys()]).toEqual([7])
  })

  it('trusts a revoked phone again', async () => {
    const w = world()
    w.nodes.set(ID, {
      os: 'ios',
      hostname: 'old',
      model: null,
      state: 'revoked',
      approvedAt: null,
      approvedBy: null,
      revokedAt: new Date(1),
    })
    const o = await offer(w)
    expect((await redeemPair(w.deps, { code: o.payload.code, ...BODY })).status).toBe(200)
    expect(w.nodes.get(ID)?.state).toBe('approved')
  })
})

describe('the body', () => {
  it('takes exactly the seven fields', () => {
    expect(pairBody({ code: 'x', ...BODY }).ok).toBe(true)
    for (const [field, value] of [
      ['public_key', 'AB'.repeat(32)],
      ['public_key', 'ab'.repeat(31)],
      ['hostname', ''],
      ['hostname', 'a\nb'],
      ['hostname', 'x'.repeat(254)],
      ['os', 'macos'],
      ['os', 'iOS'],
      ['arch', 'ARM 64'],
      ['version', ''],
      ['version', '1.0 beta'],
      ['model', ''],
      ['model', 'x'.repeat(65)],
      ['extra', 'field'],
    ] as const) {
      expect(pairBody({ code: 'x', ...BODY, [field]: value }).ok, `${field}=${value}`).toBe(false)
    }
    for (const missing of Object.keys(BODY)) {
      const { [missing as keyof typeof BODY]: _gone, ...rest } = BODY
      expect(pairBody({ code: 'x', ...rest }).ok, missing).toBe(false)
    }
  })
})
