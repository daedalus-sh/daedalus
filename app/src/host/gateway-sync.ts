import { createHash } from 'node:crypto'
import type { Ctx, Gateway } from '../core/ctx'
import { isRecord } from '../lib/is-record'
import {
  type LitellmRoute,
  type ProviderModel,
  routeFor,
  upstreamFor,
} from '../lib/providers/kinds'
import {
  BOX_PROVIDERS_KEY,
  type BoxProviderPolicy,
  isBoxProviderPolicy,
  type ModelPolicies,
  resolveModel,
} from '../lib/providers/policy'
import { listNodes } from '../lib/repo/nodes'
import { type FleetProvider, readFleetProviders } from './providers/fleet'
import type { ProviderReading } from './providers/read'

// The gateway sync: every offered provider's downloaded models, as LiteLLM
// routes, through LiteLLM's own model table.
//
// A model comes and goes with a click in Lemonade's window. A rebuild and a
// gateway restart per click would be the wrong cost, and the catalog is the
// provider's state, not the box's — so this reconciles LiteLLM's database
// with what the providers answer, after every policy save
// and every five minutes. It owns exactly the routes it made: each carries
// `model_info.daedalus = { node, kind, id }`, and a route without the tag
// (config.yaml's, or one an operator typed into LiteLLM's own UI) is never
// touched. A provider that does not answer this tick keeps its routes: a
// machine asleep must not lose them, and a route to a sleeping machine
// fails fast on its own.

export type SyncSummary = {
  at: number
  created: string[]
  updated: string[]
  deleted: string[]
  kept: string[]
  skipped: { alias: string; why: string }[]
  /**
   * No gateway, the providers or the gateway could not be read, or a write failed. The
   * run stopped there: writes before the failure stand, and the lists are empty.
   */
  error: string | null
}

/** A row of LiteLLM's /model/info, reduced to what the reconcile compares. */
export type GatewayModel = {
  id: string
  dbModel: boolean
  modelName: string
  upstream: string
  apiBase: string | null
  timeout: number | null
  modelInfo: Record<string, unknown>
  /** The sync's mark, with `rev`, the hash it wrote the route with (null on a route made before revs). */
  tag: { node: string; kind: string; id: string; rev: string | null } | null
}

/** The three calls the sync makes. Abstracted so the test can hand it a fake gateway. */
export type GatewayClient = {
  info(): Promise<GatewayModel[]>
  add(route: LitellmRoute): Promise<void>
  remove(id: string): Promise<void>
}

const TIMEOUT_MS = 15_000

function tagOf(info: unknown): GatewayModel['tag'] {
  if (!isRecord(info) || !isRecord(info.daedalus)) return null
  const d = info.daedalus
  return typeof d.node === 'string' && typeof d.kind === 'string' && typeof d.id === 'string'
    ? { node: d.node, kind: d.kind, id: d.id, rev: typeof d.rev === 'string' ? d.rev : null }
    : null
}

/** JSON with every object's keys sorted, so equal routes hash equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/**
 * The hash of a route as the sync writes it, `rev` itself left out. The sync
 * stamps it on the route's tag and compares it on the next tick, rather than
 * comparing fields against /model/info: LiteLLM answers that with fields it
 * computed itself (catalog token limits) and without ones it stored as zero,
 * so a field-by-field comparison never matched and every route was rewritten
 * every tick.
 */
export function revOf(route: LitellmRoute): string {
  const { rev: _rev, ...tag } = route.model_info.daedalus
  const body = { ...route, model_info: { ...route.model_info, daedalus: tag } }
  return createHash('sha256').update(canonical(body)).digest('hex').slice(0, 16)
}

/** The route with its rev stamped on the tag, as the sync sends it. */
function stamped(route: LitellmRoute): LitellmRoute {
  return {
    ...route,
    model_info: {
      ...route.model_info,
      daedalus: { ...route.model_info.daedalus, rev: revOf(route) },
    },
  }
}

export function gatewayModelsOf(body: unknown): GatewayModel[] {
  if (!isRecord(body) || !Array.isArray(body.data)) return []
  const out: GatewayModel[] = []
  for (const m of body.data) {
    if (!isRecord(m) || typeof m.model_name !== 'string') continue
    const params = isRecord(m.litellm_params) ? m.litellm_params : {}
    const info = isRecord(m.model_info) ? m.model_info : {}
    if (typeof info.id !== 'string') continue
    out.push({
      id: info.id,
      dbModel: info.db_model === true,
      modelName: m.model_name,
      upstream: typeof params.model === 'string' ? params.model : '',
      apiBase: typeof params.api_base === 'string' ? params.api_base : null,
      timeout: typeof params.timeout === 'number' ? params.timeout : null,
      modelInfo: info,
      tag: tagOf(info),
    })
  }
  return out
}

function litellmClient(gateway: Gateway): GatewayClient {
  const headers = {
    Authorization: `Bearer ${gateway.apiKey}`,
    'Content-Type': 'application/json',
  }
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const res = await fetch(`${gateway.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${path}: ${String(res.status)} ${text.slice(0, 200)}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  }
  return {
    info: async () => gatewayModelsOf(await call('/model/info', { method: 'GET' })),
    add: async (route) => {
      await call('/model/new', { method: 'POST', body: JSON.stringify(route) })
    },
    remove: async (id) => {
      await call('/model/delete', { method: 'POST', body: JSON.stringify({ id }) })
    },
  }
}

/* ── the plan ─────────────────────────────────────────────────────────── */

export type Desired = { route: LitellmRoute; provider: FleetProvider }

/**
 * A provider's tag key, and a route's: the sync matches on node + kind + id,
 * never on the alias, so renaming a model is an update, not a delete and a
 * create.
 */
const key = (t: { node: string; kind: string; id: string }) => `${t.node}/${t.kind}/${t.id}`

/**
 * What a chat route should say its context is: what the provider reports
 * for the model while it is loaded, else what the route already says — a
 * model unloaded between two ticks must not lose its limits.
 */
function contextFor(
  model: ProviderModel,
  reading: ProviderReading,
  existing: GatewayModel | undefined,
): number | null {
  const loaded = reading.health.loaded.find((l) => l.id === model.id)
  if (loaded?.maxContext !== null && loaded?.maxContext !== undefined) return loaded.maxContext
  const inTok = existing?.modelInfo.max_input_tokens
  const outTok = existing?.modelInfo.max_output_tokens
  return typeof inTok === 'number' && typeof outTok === 'number' ? inTok + outTok : null
}

/**
 * The routes the gateway should hold for the providers that answered, and
 * the aliases that could not be used. Pure: given the readings, the
 * policies and what the gateway holds now.
 */
export function planRoutes(input: {
  readings: { provider: FleetProvider; reading: ProviderReading }[]
  policies: (p: FleetProvider) => ModelPolicies | undefined
  existing: GatewayModel[]
}): { desired: Desired[]; skipped: { alias: string; why: string }[] } {
  const desired: Desired[] = []
  const skipped: { alias: string; why: string }[] = []
  const byTag = new Map(
    input.existing
      .filter((m) => m.tag !== null)
      .map((m) => [key(m.tag as NonNullable<GatewayModel['tag']>), m]),
  )
  const taken = new Map<string, string>()
  // Config routes hold their alias unless they dial the same upstream: the
  // migration of a hand-written route to a synced one runs both under one
  // name until the config line goes.
  const config = new Map(
    input.existing.filter((m) => m.tag === null).map((m) => [m.modelName, m.upstream]),
  )

  for (const { provider, reading } of input.readings) {
    if (!provider.offered || !reading.reachable) continue
    const policies = input.policies(provider)
    // Two models whose plain names coincide (Gemma with and without the
    // draft head both read "gemma-4-12b"): the one the operator named keeps
    // it, the other falls back to its full id. An alias someone typed is
    // never rewritten.
    const chosen = new Map<string, number>()
    for (const model of reading.models) {
      const r = resolveModel(policies, model)
      if (r.offer) chosen.set(r.alias, (chosen.get(r.alias) ?? 0) + 1)
    }
    for (const model of reading.models) {
      const resolved = resolveModel(policies, model)
      const explicit = policies?.[model.id]?.alias !== undefined
      const r =
        !explicit && (chosen.get(resolved.alias) ?? 0) > 1
          ? { ...resolved, alias: model.id.toLowerCase() }
          : resolved
      if (!r.offer) continue
      const upstream = upstreamFor(r.mode, model.id)
      const owner = taken.get(r.alias)
      if (owner !== undefined) {
        skipped.push({ alias: r.alias, why: `already ${owner}` })
        continue
      }
      const cfg = config.get(r.alias)
      if (cfg !== undefined && cfg !== upstream) {
        skipped.push({ alias: r.alias, why: `a config.yaml route to ${cfg}` })
        continue
      }
      const tag = { node: provider.machine, kind: provider.kind, id: model.id }
      const route = routeFor({
        node: provider.machine,
        kind: provider.kind,
        base: provider.base,
        model: { ...model, mode: r.mode },
        alias: r.alias,
        maxContext: contextFor(model, reading, byTag.get(key(tag))),
      })
      taken.set(r.alias, `${model.id} on ${provider.machineName}`)
      desired.push({ route, provider })
    }
  }
  return { desired, skipped }
}

/** Whether a held route was written from exactly the desired one. */
function sameRoute(have: GatewayModel, want: LitellmRoute): boolean {
  return have.tag?.rev === revOf(want)
}

/**
 * Reconcile: create what is missing, remake what changed, delete what the
 * sync made for a model that is gone or a provider switched off — and keep
 * what belongs to a provider that did not answer this tick.
 */
export async function reconcile(
  gw: GatewayClient,
  readings: { provider: FleetProvider; reading: ProviderReading }[],
  policies: (p: FleetProvider) => ModelPolicies | undefined,
  now: number,
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    at: now,
    created: [],
    updated: [],
    deleted: [],
    kept: [],
    skipped: [],
    error: null,
  }
  const existing = [...(await gw.info())]
  const { desired, skipped } = planRoutes({ readings, policies, existing })
  summary.skipped = skipped

  const wanted = new Map(desired.map((d) => [key(d.route.model_info.daedalus), d]))
  const answered = new Set(
    readings
      .filter((r) => r.reading.reachable || !r.provider.offered)
      .map((r) => `${r.provider.machine}/${r.provider.kind}`),
  )
  const known = new Set(readings.map((r) => `${r.provider.machine}/${r.provider.kind}`))

  for (const have of existing) {
    if (have.tag === null) continue
    const k = key(have.tag)
    const want = wanted.get(k)
    if (want !== undefined) {
      if (sameRoute(have, want.route)) summary.kept.push(want.route.model_name)
      else {
        // A change is the old route gone and a new one made, never
        // /model/update: LiteLLM's update keeps a route's name and its mode
        // whatever the body says (1.108: a chat route patched to `decisions`
        // stayed `chat`), so a patch cannot be trusted to land.
        await gw.remove(have.id)
        await gw.add(stamped(want.route))
        summary.updated.push(want.route.model_name)
      }
      wanted.delete(k)
      continue
    }
    const owner = `${have.tag.node}/${have.tag.kind}`
    // Gone from a provider that answered, switched off, or from a machine
    // the box no longer knows: delete. Silent this tick: keep.
    if (answered.has(owner) || !known.has(owner)) {
      await gw.remove(have.id)
      summary.deleted.push(have.modelName)
    } else {
      summary.kept.push(have.modelName)
    }
  }
  for (const d of wanted.values()) {
    await gw.add(stamped(d.route))
    summary.created.push(d.route.model_name)
  }
  return summary
}

/* ── running it ───────────────────────────────────────────────────────── */

type Slot = {
  last: SyncSummary | null
  running: Promise<SyncSummary> | null
  handle: unknown
  debounce: unknown
}
const SLOT = '__daedalusGatewaySync'
const g = globalThis as unknown as Record<string, unknown>
const slot = (): Slot => {
  const v = g[SLOT]
  if (isRecord(v) && 'last' in v) return v as Slot
  const s: Slot = { last: null, running: null, handle: null, debounce: null }
  g[SLOT] = s
  return s
}

const SYNC_EVERY_MS = 5 * 60_000
const DEBOUNCE_MS = 3_000

export function lastGatewaySync(): SyncSummary | null {
  return slot().last
}

async function policiesOf(ctx: Ctx): Promise<(p: FleetProvider) => ModelPolicies | undefined> {
  const nodes = await listNodes(ctx)
  const box =
    (await ctx.store.read(BOX_PROVIDERS_KEY, isBoxProviderPolicy)) ?? ({} as BoxProviderPolicy)
  return (p) => {
    if (p.machine === 'box') return p.kind === 'subgen' ? box.subgen?.models : undefined
    const n = nodes.find((x) => x.id === p.machine)
    return n?.policy.providers?.[p.kind]?.models
  }
}
/** One sync, now. Concurrent callers share the run in flight. */
export function syncGateway(ctx: Ctx, gw?: GatewayClient): Promise<SyncSummary> {
  const s = slot()
  if (s.running !== null) return s.running
  const run = (async (): Promise<SyncSummary> => {
    const now = Date.now()
    if (ctx.gateway === null) {
      return {
        at: now,
        created: [],
        updated: [],
        deleted: [],
        kept: [],
        skipped: [],
        error: 'no gateway on this box',
      }
    }
    try {
      // Each reading carries its provider's `offered` (host/providers/fleet.ts
      // reads it from the box's policy or the node's); the policies below are
      // the per-model offer, alias and mode.
      const readings = await readFleetProviders(ctx)
      const summary = await reconcile(
        gw ?? litellmClient(ctx.gateway),
        readings,
        await policiesOf(ctx),
        now,
      )
      s.last = summary
      return summary
    } catch (e) {
      const summary: SyncSummary = {
        at: now,
        created: [],
        updated: [],
        deleted: [],
        kept: [],
        skipped: [],
        error: e instanceof Error ? e.message : String(e),
      }
      s.last = summary
      return summary
    } finally {
      s.running = null
    }
  })()
  s.running = run
  return run
}

/**
 * A sync soon: a burst of saves runs one, a few seconds after the
 * last. Never throws — a save must not fail because the gateway did.
 */
export function requestGatewaySync(): void {
  const s = slot()
  if (s.debounce !== null) clearTimeout(s.debounce as ReturnType<typeof setTimeout>)
  s.debounce = setTimeout(() => {
    s.debounce = null
    void import('../core/ctx')
      .then(({ makeCtx }) => makeCtx())
      .then((ctx) => syncGateway(ctx))
      .catch(() => undefined)
  }, DEBOUNCE_MS)
  const t = s.debounce as { unref?: () => void }
  t.unref?.()
}

/** The five-minute run, started once per process by host/background.ts. Idempotent. */
export function ensureGatewaySync(): void {
  const s = slot()
  if (s.handle !== null) return
  const handle = setInterval(() => requestGatewaySync(), SYNC_EVERY_MS)
  ;(handle as { unref?: () => void }).unref?.()
  s.handle = handle
  if (s.last === null) requestGatewaySync()
}

/** Stop the five-minute run and a sync still waiting out its debounce. Idempotent. */
export function stopGatewaySync(): void {
  const s = slot()
  if (s.handle !== null) clearInterval(s.handle as ReturnType<typeof setInterval>)
  if (s.debounce !== null) clearTimeout(s.debounce as ReturnType<typeof setTimeout>)
  s.handle = null
  s.debounce = null
}
