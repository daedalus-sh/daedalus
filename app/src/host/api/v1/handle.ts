import { z } from 'zod'
import type { Ctx } from '../../../core/ctx'
import { isAccessoryId } from '../../../lib/agent/accessory'
import { isLightOs } from '../../../lib/agent/light'
import { NODE_COMMANDS } from '../../../lib/agent/policy'
import type { ApiErrorBody, ApiErrorCode } from '../../../lib/api-v1'
import { API_V1 } from '../../../lib/api-v1'
import { PRIVATE_CONTAINER } from '../../../lib/dashboard/log-noise'
import { readCapped } from '../../../lib/read-capped'
import { errorText } from '../../../lib/redact'
import { ControllerError } from '../../controller/wire'
import type { NodeIdentity } from '../../node-tokens'
import { BOX } from './views'

// The native app's API: `/api/v1/*`, JSON over HTTPS, for the phones and
// tablets paired on Settings › Machines. The contract is ios/docs/api.md.
//
// The third door onto the box, beside the pages' server functions and the
// agents' MCP tools, and like them an adapter: each route below calls the
// function the matching page or tool calls (the reads through ./views.ts, the
// writes straight into the flows), so the app can do nothing a button cannot
// and a ceremony refuses here in the flow's own words.
//
// Every request is authenticated before any work: `Authorization: Bearer
// dnode_…`, matched against its stored digest (host/node-tokens.ts), its node
// `approved`. A write is then authorised by core/authz.ts
// `assertMachineActor`'s node-token door and recorded as `node:<name>`, with
// the `[audit]` line an admin's server function writes.
//
// Answers are JSON with `cache-control: no-store`; an error is always
// `{"error":{"code","message"}}`. Input is checked strictly — an unknown
// query key or body field is a `bad_request`, and a body is capped while it
// is read.

const PREFIX = '/api/v1'

/** A JSON body is a handful of short strings. */
const MAX_BODY_BYTES = 16 * 1024

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  bad_request: 400,
  refused: 409,
  unavailable: 503,
  internal: 500,
}

const HEADERS = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' }

/** A refusal a route answers with: the envelope's code and sentence. */
export class ApiFail extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  constructor(code: ApiErrorCode, message: string, status: number = STATUS[code]) {
    super(message)
    this.name = 'ApiFail'
    this.code = code
    this.status = status
  }
}

const fail = (code: ApiErrorCode, message: string): never => {
  throw new ApiFail(code, message)
}

const errorResponse = (code: ApiErrorCode, message: string, status = STATUS[code]): Response => {
  const body: ApiErrorBody = { error: { code, message } }
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...HEADERS,
      ...(status === 401 ? { 'www-authenticate': 'Bearer realm="daedalus"' } : {}),
    },
  })
}

/* ── input ────────────────────────────────────────────────────────────── */

const none = z.strictObject({})
const hours = z.coerce.number().int().min(1).max(168).default(24)
const container = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'not a container name')
const tag = z.string().min(1).max(128)
const nodeId = z.string().regex(/^[0-9a-f]{16}$/, 'not a machine id')
/** `box`, null, or a node id: null and `box` both mean the box. */
const machine = z.union([z.literal(BOX), nodeId]).nullable()
const target = z.strictObject({ container, toTag: tag.optional() })
/** A watch's id: its phone's, then `.watch` (lib/agent/accessory.ts). */
const accessoryId = z.string().refine(isAccessoryId, 'not a machine id')
const machineParam = z.strictObject({ id: z.union([z.literal(BOX), nodeId, accessoryId]) })

const first = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `${issue.path.join('.')}: ${issue.message}`

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  const issue = r.error.issues[0]
  throw new ApiFail('bad_request', `${what}: ${issue === undefined ? 'invalid' : first(issue)}`)
}

/** A flow's outcome as an answer: its value, or its own sentence as a refusal. */
function started<O extends { ok: true } | { ok: false; code?: string; reason: string }>(
  outcome: O,
): Extract<O, { ok: true }> {
  if (outcome.ok) return outcome as Extract<O, { ok: true }>
  throw new ApiFail(outcome.code === 'unavailable' ? 'unavailable' : 'refused', outcome.reason)
}

/** A function that refuses by throwing a sentence: that sentence, as `refused`. */
async function orRefuse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof ApiFail || e instanceof ControllerError) throw e
    throw new ApiFail('refused', errorText(e))
  }
}

/* ── the routes ───────────────────────────────────────────────────────── */

/** What a route is handed. `actor` is set on a write and nowhere else. */
type Call<Q, B> = {
  ctx: Ctx
  node: NodeIdentity
  actor: string
  /** The path's `:name` segments. */
  params: Record<string, string>
  query: Q
  body: B
}

export type Route = {
  method: 'GET' | 'POST'
  /** Under /api/v1; `:name` is one segment. */
  path: string
  /** Changes the box: authorised by the node-token door and audited. */
  write: boolean
  /** The path's `:name` segments, checked before the route runs. */
  params: z.ZodType
  query: z.ZodType
  body: z.ZodType
  // biome-ignore lint/suspicious/noExplicitAny: each route's schemas type its own Call; the table erases them.
  run: (call: Call<any, any>) => Promise<unknown>
}

function route<Q extends z.ZodType, B extends z.ZodType>(
  method: Route['method'],
  path: string,
  opts: { write?: boolean; params?: z.ZodType; query?: Q; body?: B },
  run: (call: Call<z.output<Q>, z.output<B>>) => Promise<unknown>,
): Route {
  return {
    method,
    path,
    write: opts.write ?? method === 'POST',
    params: opts.params ?? none,
    query: opts.query ?? none,
    body: opts.body ?? none,
    run,
  }
}

const views = () => import('./views')
const ops = () => import('../../mcp/ops')

/** A node the app may act on: an approved machine that is not a phone. */
async function actionable(id: string): Promise<void> {
  const { nodeById } = await import('../../../lib/repo/nodes')
  const n = await nodeById(id)
  if (n === undefined) fail('not_found', 'No such machine.')
  else if (n.state !== 'approved') fail('refused', 'This machine is not approved.')
  else if (isLightOs(n.os)) fail('refused', 'A phone or tablet runs no Claude.')
}

export const ROUTES: readonly Route[] = [
  route('GET', '/me', {}, async ({ node }) => {
    const { siteIdentity } = await import('../../contract/domains/site')
    const { repoFacts } = await import('../../contract/domains/repo')
    const [site, repo] = await Promise.all([siteIdentity(), repoFacts()])
    return {
      node: { id: node.id, name: node.name, os: node.os },
      box: {
        hostname: site.data.hostname,
        engineRev: repo.available && !repo.stale ? (repo.data.engine?.rev ?? null) : null,
      },
      api: API_V1,
    }
  }),

  route('GET', '/overview', { query: z.strictObject({ hours }) }, async ({ ctx, query }) =>
    (await views()).overview(ctx, query.hours),
  ),

  route('GET', '/alerts', { query: z.strictObject({ hours }) }, async ({ ctx, query }) => {
    const a = await (await ops()).recentAlerts(ctx, query.hours)
    return {
      hours: query.hours,
      firing: a.firing,
      pending: a.pending,
      active: a.active,
      firedRecently: a.firedRecently,
    }
  }),

  route('GET', '/errors', { query: z.strictObject({ hours }) }, async ({ ctx, query }) =>
    (await ops()).errorSummary(ctx, query.hours),
  ),

  route(
    'GET',
    '/logs',
    {
      query: z.strictObject({
        container,
        text: z.string().max(200).default(''),
        hours,
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    },
    async ({ ctx, query }) => {
      // searchLogs refuses these itself; said here so it reads as a refusal.
      if (PRIVATE_CONTAINER.test(query.container)) {
        fail(
          'refused',
          `${query.container} carries private messages, so its logs are not readable here.`,
        )
      }
      return (await ops()).searchLogs(ctx, query)
    },
  ),

  /* ── updates ── */

  route('GET', '/updates', {}, async ({ ctx }) => (await views()).updates(ctx)),

  route('GET', '/updates/status', {}, async ({ ctx }) => (await views()).updatesStatus(ctx)),

  route('GET', '/updates/changelog', { query: z.strictObject({ container }) }, async ({ query }) =>
    (await ops()).changelog(query.container),
  ),

  route(
    'POST',
    '/updates/queue',
    {
      body: z
        .strictObject({
          add: z
            .strictObject({
              container,
              toTag: tag.optional(),
              confirm: z.string().max(128).optional(),
            })
            .optional(),
          remove: container.optional(),
          clear: z.literal(true).optional(),
        })
        .refine((b) => [b.add, b.remove, b.clear].filter((x) => x !== undefined).length === 1, {
          message: 'exactly one of add, remove and clear',
        }),
    },
    async ({ ctx, body }) => {
      const { unqueueItem, clearQueue } = await import('../../../core/update-queue')
      if (body.add !== undefined) {
        const add = body.add
        return {
          queue: await orRefuse(async () =>
            (await ops()).enqueue(ctx, {
              container: add.container,
              toTag: add.toTag ?? null,
              typed: add.confirm ?? '',
            }),
          ),
        }
      }
      if (body.remove !== undefined) return { queue: await unqueueItem(ctx, body.remove) }
      return { queue: await clearQueue(ctx) }
    },
  ),

  route(
    'POST',
    '/updates/run',
    {
      body: z.strictObject({
        targets: z.array(target).min(1).max(64).optional(),
        confirm: z.array(z.string().max(128)).max(64).optional(),
      }),
    },
    async ({ ctx, body, actor }) => {
      if (body.targets === undefined) {
        if (body.confirm !== undefined) {
          fail('bad_request', 'confirm goes with targets; a queued pin carries its own')
        }
        const o = started(await orRefuse(async () => (await ops()).runQueue(ctx, actor)))
        return { id: o.id, targets: o.targets }
      }
      const { runImageUpdate } = await import('../../update-flow')
      const o = started(
        await runImageUpdate({
          ctx,
          targets: body.targets.map((t) => ({
            container: t.container,
            ...(t.toTag === undefined ? {} : { toTag: t.toTag }),
          })),
          confirm: body.confirm ?? [],
          actor,
        }),
      )
      return { id: o.id, targets: o.targets }
    },
  ),

  route('POST', '/updates/engine', {}, async ({ ctx, actor }) => {
    const { runEngineUpdate } = await import('../../engine-flow')
    return { id: started(await runEngineUpdate({ ctx, actor })).id }
  }),

  route('POST', '/updates/claude-code', {}, async ({ ctx, actor }) => {
    const { runClaudeCodeUpdate } = await import('../../claude-code-flow')
    return { id: started(await runClaudeCodeUpdate({ ctx, actor })).id }
  }),

  /* ── apply ── */

  route('GET', '/apply', {}, async ({ ctx }) =>
    (await import('../../pending-apply')).pendingApply(ctx),
  ),

  route('POST', '/apply', {}, async ({ ctx, actor }) => {
    const { runApply } = await import('../../apply-flow')
    const o = started(await runApply(ctx, actor))
    return { id: o.id, changed: o.changed }
  }),

  route('POST', '/apply/discard', {}, async ({ ctx }) => {
    const { discardChanges } = await import('../../apply-flow')
    const o = await discardChanges(ctx)
    return o.ok ? o.value : fail('refused', o.reason)
  }),

  /* ── machines ── */

  route('GET', '/machines', {}, async ({ ctx, node }) => (await views()).machines(ctx, node.id)),

  route('GET', '/machines/:id', { params: machineParam }, async ({ ctx, node, params }) => {
    const d = await (await views()).machineDetail(ctx, params.id ?? '', node.id)
    return d ?? fail('not_found', 'No such machine.')
  }),

  route(
    'POST',
    '/machines/:id/command',
    {
      params: machineParam,
      body: z.strictObject({ command: z.enum(NODE_COMMANDS as [string, ...string[]]) }),
    },
    async ({ ctx, params, body }) => {
      const id = params.id ?? ''
      if (id === BOX) {
        fail('refused', 'The box takes no machine commands: its updates are under /updates.')
      }
      if (isAccessoryId(id)) {
        fail('refused', 'A watch takes no commands from the box: its iPhone reports it.')
      }
      const { sendNodeCommand } = await import('../../../core/nodes')
      const command = NODE_COMMANDS.find((c) => c === body.command)
      if (command === undefined) return fail('bad_request', 'command: not a command')
      const sent = await sendNodeCommand(ctx, id, command)
      if (sent.ok) return sent.value
      return fail(sent.reason === 'No such machine.' ? 'not_found' : 'refused', sent.reason)
    },
  ),

  /* ── claude ── */

  route('GET', '/claude', {}, async ({ ctx }) => (await views()).claude(ctx)),

  route('POST', '/claude/restart', { body: z.strictObject({ machine }) }, async ({ ctx, body }) => {
    if (body.machine === null || body.machine === BOX) {
      const q = await ctx.controller.call('claude.restart')
      return { queued: q.queued, delivered: false }
    }
    await actionable(body.machine)
    const { sendNodeCommand } = await import('../../../core/nodes')
    const sent = await sendNodeCommand(ctx, body.machine, 'claude_restart')
    return sent.ok ? sent.value : fail('refused', sent.reason)
  }),

  route(
    'POST',
    '/claude/session',
    {
      body: z.strictObject({
        machine,
        action: z.enum(['resume', 'stop', 'remove']),
        session: z.string().regex(/^[0-9a-f-]{8,36}$/, 'not a session or agent id'),
      }),
    },
    async ({ ctx, body }) => {
      if (body.machine === null || body.machine === BOX) {
        const q = await ctx.controller.call('claude.session', {
          action: body.action,
          id: body.session,
        })
        return { request: q.request }
      }
      await actionable(body.machine)
      const q = await ctx.controller.call('nodes.claude_session', {
        id: body.machine,
        action: body.action,
        session: body.session,
      })
      return { request: q.request }
    },
  ),

  route(
    'GET',
    '/claude/action',
    {
      query: z.strictObject({
        machine: z.union([z.literal(BOX), nodeId]).default(BOX),
        request: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'not a request id'),
      }),
    },
    async ({ ctx, query }) => ({
      outcome: await ctx.controller.call('actions.get', {
        ...(query.machine === BOX ? {} : { node: query.machine }),
        request: query.request,
      }),
    }),
  ),

  /* ── apps ── */

  route('GET', '/apps', {}, async ({ ctx }) => (await views()).apps(ctx)),
]

/* ── the handler ──────────────────────────────────────────────────────── */

type Match = { route: Route; params: Record<string, string> }

/** The route for a method and a path under the prefix, with its `:name` segments. */
export function matchRoute(method: string, path: string): Match | null {
  const got = path.split('/')
  for (const r of ROUTES) {
    if (r.method !== method) continue
    const want = r.path.split('/')
    if (want.length !== got.length) continue
    const params: Record<string, string> = {}
    const hit = want.every((w, i) => {
      const g = got[i] ?? ''
      if (!w.startsWith(':')) return w === g
      if (g === '') return false
      params[w.slice(1)] = g
      return true
    })
    if (hit) return { route: r, params }
  }
  return null
}

/** What the handler reaches; the tests hand it fakes. */
export type ApiDeps = {
  identify: (token: string | null) => Promise<NodeIdentity | null>
  stamp: (nodeId: string) => void
  ctx: () => Promise<Ctx>
}

const realDeps: ApiDeps = {
  identify: async (t) => (await import('../../node-tokens')).identifyNodeToken(t),
  stamp: (id) => {
    void import('../../node-tokens').then((m) => m.stampNodeTokenUse(id))
  },
  ctx: async () => (await import('../../../core/ctx')).makeCtx(),
}

const BEARER = /^Bearer\s+(.+)$/i

/** The controller's codes that are an answer about the request, not about reaching it. */
const REFUSALS: ReadonlySet<string> = new Set([
  'unsupported',
  'busy',
  'forbidden',
  'revoked',
  'santree_off',
  'too_large',
])

async function readBody(request: Request): Promise<unknown> {
  let bytes: Uint8Array | null
  try {
    bytes = await readCapped(request.body, MAX_BODY_BYTES)
  } catch {
    throw new ApiFail('bad_request', 'the body could not be read')
  }
  if (bytes === null) throw new ApiFail('bad_request', 'the body is too large', 413)
  // No body at all is the empty object: most writes take nothing.
  if (bytes.length === 0) return {}
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new ApiFail('bad_request', 'the body is not JSON')
  }
}

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of url.searchParams) {
    if (Object.hasOwn(out, k)) throw new ApiFail('bad_request', `query: ${k} is given twice`)
    out[k] = v
  }
  return out
}

/** Answer one request under /api/v1. Never throws. */
export async function handleApiV1(request: Request, deps: ApiDeps = realDeps): Promise<Response> {
  try {
    // The token before anything else: an unauthenticated caller learns
    // nothing about which paths exist.
    const presented = BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null
    const node = await deps.identify(presented)
    if (node === null || node.state !== 'approved') {
      return errorResponse('unauthorized', 'bad or missing node token')
    }
    deps.stamp(node.id)

    const url = new URL(request.url)
    if (!url.pathname.startsWith(`${PREFIX}/`)) return errorResponse('not_found', 'No such route.')
    const match = matchRoute(request.method, url.pathname.slice(PREFIX.length))
    if (match === null) return errorResponse('not_found', 'No such route.')
    const { route: r, params } = match

    parse(r.params, params, 'path')
    const query = parse(r.query, queryOf(url), 'query')
    const body = r.method === 'POST' ? parse(r.body, await readBody(request), 'body') : {}

    let actor = ''
    if (r.write) {
      const { assertMachineActor } = await import('../../../core/authz')
      try {
        actor = assertMachineActor({
          door: 'node-token',
          node: { id: node.id, name: node.name },
          state: node.state,
        })
      } catch (e) {
        return errorResponse('unauthorized', errorText(e))
      }
      console.info(`[audit] ${actor} (${node.id}) ${r.method} ${PREFIX}${r.path}`)
    }

    const value = await r.run({ ctx: await deps.ctx(), node, actor, params, query, body })
    return new Response(JSON.stringify(value), { status: 200, headers: HEADERS })
  } catch (e) {
    if (e instanceof ApiFail) return errorResponse(e.code, e.message, e.status)
    if (e instanceof ControllerError) {
      const code: ApiErrorCode =
        e.code === 'not_found' || e.code === 'bad_request'
          ? e.code
          : REFUSALS.has(e.code)
            ? 'refused'
            : 'unavailable'
      return errorResponse(code, `the controller: ${e.message}`)
    }
    console.warn(`[api] ${request.method} ${new URL(request.url).pathname} failed:`, e)
    return errorResponse('internal', errorText(e))
  }
}
