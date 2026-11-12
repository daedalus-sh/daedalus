import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../../core/ctx'
import { ControllerError } from '../../controller/wire'
import type { NodeIdentity } from '../../node-tokens'
import { type ApiDeps, ApiFail, handleApiV1, matchRoute, ROUTES } from './handle'

// The native app's door: nothing answers without a token, a write passes the
// node-token door and is audited, and input is checked before a route runs.
// The routes' bodies are the pages' own loaders and flows, tested where they
// live; here every route is driven with a Ctx that fails on first touch, so
// what is asserted is what the door decided before any of them ran.

const NODE: NodeIdentity = {
  id: '0123456789abcdef',
  name: 'Santi’s iPhone',
  os: 'ios',
  state: 'approved',
}
const TOKEN = `dnode_${'t'.repeat(43)}`

const h = vi.hoisted(() => ({ ctxBuilt: 0, stamped: [] as string[] }))

/** A Ctx no route may reach in these tests: building one is counted, and touching it throws. */
const deadCtx = new Proxy(
  {},
  {
    get: (_t, key) => {
      if (key === 'then') return undefined
      throw new ApiFail('unavailable', `the test's box was reached (${String(key)})`)
    },
  },
) as Ctx

function deps(identity: NodeIdentity | null = NODE, ctx: Ctx = deadCtx): ApiDeps {
  return {
    identify: async (t) => (t === TOKEN ? identity : null),
    stamp: (id) => {
      h.stamped.push(id)
    },
    ctx: async () => {
      h.ctxBuilt++
      return ctx
    },
  }
}

const pathOf = (p: string) => p.replace(':id', '0123456789abcdef')

function req(
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; raw?: string } = {},
): Request {
  const token = opts.token === undefined ? TOKEN : opts.token
  return new Request(`https://daedalus-app.example.org/api/v1${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(opts.body === undefined && opts.raw === undefined
        ? {}
        : { 'content-type': 'application/json' }),
    },
    ...(opts.raw !== undefined
      ? { body: opts.raw }
      : opts.body === undefined
        ? {}
        : { body: JSON.stringify(opts.body) }),
  })
}

const errorOf = async (r: Response) =>
  ((await r.json()) as { error: { code: string; message: string } }).error

beforeEach(() => {
  h.ctxBuilt = 0
  h.stamped = []
  vi.restoreAllMocks()
})

describe('every route', () => {
  it.each(ROUTES.map((r) => [r.method, r.path] as const))(
    '%s %s answers 401 without a token, with a wrong one, and for a node that is not approved',
    async (method, path) => {
      for (const d of [
        { request: req(method, pathOf(path), { token: null }), deps: deps() },
        { request: req(method, pathOf(path), { token: 'dnode_wrong' }), deps: deps() },
        { request: req(method, pathOf(path), { token: 'dmcp_abc' }), deps: deps() },
        { request: req(method, pathOf(path)), deps: deps(null) },
        {
          request: req(method, pathOf(path)),
          deps: deps({ ...NODE, state: 'revoked' as 'approved' }),
        },
      ]) {
        const r = await handleApiV1(d.request, d.deps)
        expect(r.status).toBe(401)
        expect(r.headers.get('cache-control')).toBe('no-store')
        expect(r.headers.get('www-authenticate')).toBe('Bearer realm="daedalus"')
        expect(await errorOf(r)).toEqual({
          code: 'unauthorized',
          message: 'bad or missing node token',
        })
      }
      expect(h.ctxBuilt).toBe(0)
      expect(h.stamped).toEqual([])
    },
  )

  it('is a read on GET and a write on POST, and the table says so', () => {
    for (const r of ROUTES) expect(r.write, `${r.method} ${r.path}`).toBe(r.method === 'POST')
    expect(ROUTES.filter((r) => r.write).map((r) => r.path)).toEqual([
      '/updates/queue',
      '/updates/run',
      '/updates/engine',
      '/updates/claude-code',
      '/apply',
      '/apply/discard',
      '/machines/:id/command',
      '/claude/restart',
      '/claude/session',
    ])
  })

  it('is one method and one path', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('a write', () => {
  it.each(ROUTES.filter((r) => r.write).map((r) => [r.path] as const))(
    'POST %s is audited under the node before it runs',
    async (path) => {
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      // A valid body for each, so the request reaches the route.
      const bodies: Record<string, unknown> = {
        '/updates/queue': { clear: true },
        '/updates/run': { targets: [{ container: 'pg' }] },
        '/machines/:id/command': { command: 'check_update' },
        '/claude/restart': { machine: null },
        '/claude/session': { machine: null, action: 'stop', session: 'abcdef12' },
      }
      await handleApiV1(req('POST', pathOf(path), { body: bodies[path] ?? {} }), deps())
      expect(info).toHaveBeenCalledWith(
        `[audit] node:Santi’s iPhone (0123456789abcdef) POST /api/v1${path}`,
      )
      expect(h.stamped).toEqual(['0123456789abcdef'])
    },
  )

  it('is not audited when its body is refused, and a read never is', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    await handleApiV1(req('POST', '/updates/run', { body: { targets: [] } }), deps())
    await handleApiV1(req('GET', '/me'), deps())
    expect(info).not.toHaveBeenCalled()
  })
})

describe('input', () => {
  const bad = async (request: Request, status = 400) => {
    const r = await handleApiV1(request, deps())
    expect(r.status, request.url).toBe(status)
    expect((await errorOf(r)).code).toBe('bad_request')
    expect(h.ctxBuilt).toBe(0)
  }

  it('refuses a query key a route does not take, a repeated one, and a value out of range', async () => {
    await bad(req('GET', '/me?x=1'))
    await bad(req('GET', '/overview?hours=0'))
    await bad(req('GET', '/overview?hours=169'))
    await bad(req('GET', '/overview?hours=1.5'))
    await bad(req('GET', '/alerts?hours=abc'))
    await bad(req('GET', '/errors?hours=2&hours=3'))
    await bad(req('GET', '/logs'))
    await bad(req('GET', '/logs?container=../etc'))
    await bad(req('GET', '/logs?container=pg&limit=201'))
    await bad(req('GET', `/logs?container=pg&text=${'x'.repeat(201)}`))
    await bad(req('GET', '/updates/changelog'))
    await bad(req('GET', '/claude/action'))
    await bad(req('GET', '/claude/action?request=a%20b'))
    await bad(req('GET', '/claude/action?request=abc&machine=nope'))
    await bad(req('GET', '/machines/NOT-AN-ID'))
  })

  it('refuses a body that is not exactly what a route takes', async () => {
    await bad(req('POST', '/apply', { body: { force: true } }))
    await bad(req('POST', '/apply', { raw: '{' }))
    await bad(req('POST', '/apply', { raw: '[]' }))
    await bad(req('POST', '/updates/engine', { body: { rev: 'x' } }))
    await bad(req('POST', '/updates/queue', { body: {} }))
    await bad(req('POST', '/updates/queue', { body: { clear: false } }))
    await bad(req('POST', '/updates/queue', { body: { clear: true, remove: 'pg' } }))
    await bad(req('POST', '/updates/queue', { body: { add: { container: 'pg', extra: 1 } } }))
    await bad(req('POST', '/updates/run', { body: { targets: [] } }))
    await bad(req('POST', '/updates/run', { body: { targets: [{ container: 'pg', tag: 'x' }] } }))
    await bad(req('POST', '/updates/run', { body: { confirm: 'pg' } }))
    await bad(req('POST', '/machines/0123456789abcdef/command', { body: { command: 'reboot' } }))
    await bad(req('POST', '/claude/restart', { body: {} }))
    await bad(req('POST', '/claude/restart', { body: { machine: 'gaming-pc' } }))
    await bad(
      req('POST', '/claude/session', {
        body: { machine: null, action: 'kill', session: 'abcdef12' },
      }),
    )
    await bad(
      req('POST', '/claude/session', { body: { machine: null, action: 'stop', session: '../x' } }),
    )
  })

  it('caps a body while reading it', async () => {
    await bad(req('POST', '/apply', { raw: JSON.stringify({ x: 'y'.repeat(20_000) }) }), 413)
  })

  it('takes no body at all as the empty one', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const r = await handleApiV1(req('POST', '/apply'), deps())
    // Past validation: the route ran, and the box (dead here) was what failed.
    expect(r.status).toBeGreaterThanOrEqual(500)
    expect(h.ctxBuilt).toBe(1)
  })
})

describe('routing', () => {
  it('answers 404 for a path or a method that is not in the table', async () => {
    for (const [method, path] of [
      ['GET', '/nope'],
      ['GET', '/'],
      ['POST', '/me'],
      ['GET', '/apply/discard'],
      ['GET', '/machines/0123456789abcdef/command'],
      ['GET', '/machines/'],
      ['GET', '/me/'],
    ] as const) {
      const r = await handleApiV1(req(method, path), deps())
      expect(r.status, `${method} ${path}`).toBe(404)
      expect((await errorOf(r)).code).toBe('not_found')
    }
  })

  it('matches a :name segment, and only a whole one', () => {
    expect(matchRoute('GET', '/machines/box')?.params).toEqual({ id: 'box' })
    expect(matchRoute('POST', '/machines/abc/command')?.route.path).toBe('/machines/:id/command')
    expect(matchRoute('GET', '/machines')?.route.path).toBe('/machines')
    expect(matchRoute('GET', '/machines/a/b')).toBeNull()
  })
})

describe('answers', () => {
  const controller = (call: (m: string, p: unknown) => unknown) =>
    ({ controller: { call: async (m: string, p: unknown) => call(m, p) } }) as unknown as Ctx

  it('are JSON, never stored', async () => {
    const ctx = controller(() => ({ state: 'done', detail: 'stopped' }))
    const r = await handleApiV1(req('GET', '/claude/action?request=r1'), deps(NODE, ctx))
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('no-store')
    expect(r.headers.get('content-type')).toContain('application/json')
    expect(await r.json()).toEqual({ outcome: { state: 'done', detail: 'stopped' } })
  })

  it('send the box’s session verb to the controller, and a machine’s through it', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const asked: unknown[] = []
    const ctx = controller((m, p) => {
      asked.push([m, p])
      return { queued: true, request: 'r7' }
    })
    for (const machine of [null, 'box']) {
      const r = await handleApiV1(
        req('POST', '/claude/session', { body: { machine, action: 'stop', session: 'abcdef12' } }),
        deps(NODE, ctx),
      )
      expect(await r.json()).toEqual({ request: 'r7' })
    }
    expect(asked).toEqual([
      ['claude.session', { action: 'stop', id: 'abcdef12' }],
      ['claude.session', { action: 'stop', id: 'abcdef12' }],
    ])
    const action = await handleApiV1(
      req('GET', '/claude/action?request=r7&machine=fedcba9876543210'),
      deps(NODE, ctx),
    )
    expect(action.status).toBe(200)
    expect(asked.at(-1)).toEqual(['actions.get', { node: 'fedcba9876543210', request: 'r7' }])
  })

  it('say which kind of failure the controller’s was', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    for (const [code, status, api] of [
      ['unsupported', 409, 'refused'],
      ['busy', 409, 'refused'],
      ['not_found', 404, 'not_found'],
      ['unreachable', 503, 'unavailable'],
      ['internal', 503, 'unavailable'],
    ] as const) {
      const ctx = controller(() => {
        throw new ControllerError(code as never, 'said the controller')
      })
      const r = await handleApiV1(
        req('POST', '/claude/restart', { body: { machine: null } }),
        deps(NODE, ctx),
      )
      expect(r.status, code).toBe(status)
      expect(await errorOf(r)).toEqual({
        code: api,
        message: 'the controller: said the controller',
      })
    }
  })

  it('refuse the box a machine command, and private containers their logs', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const cmd = await handleApiV1(
      req('POST', '/machines/box/command', { body: { command: 'check_update' } }),
      deps(),
    )
    expect(cmd.status).toBe(409)
    expect((await errorOf(cmd)).code).toBe('refused')
    const logs = await handleApiV1(req('GET', '/logs?container=matrix-synapse'), deps())
    expect(logs.status).toBe(409)
    expect((await errorOf(logs)).message).toContain('private messages')
  })

  it('never leak what an unexpected failure said beyond its first line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ctx = controller(() => {
      throw new Error('boom\n    at secret (/app/src/x.ts:1:1)')
    })
    const r = await handleApiV1(req('GET', '/claude/action?request=r1'), deps(NODE, ctx))
    expect(r.status).toBe(500)
    const e = await errorOf(r)
    expect(e.code).toBe('internal')
    expect(e.message).not.toContain('/app/src')
    expect(warn).toHaveBeenCalled()
  })
})
