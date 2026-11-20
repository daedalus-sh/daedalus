import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshot } from '../../host/contract/snapshot'
import { readingOf, readT3Code, STALE_MS } from './t3code'

// The status file the T3 Code stack's helper writes (schema v1), read the way
// the System page reads it: through the snapshot reader, from a real file.

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 't3code-'))
  path = join(dir, 'status.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** What the page is handed instead of a Ctx: the path's row, and the real reader. */
const ctx = (bound: string | undefined = path) => ({
  env: () => bound,
  snapshot: readSnapshot,
})

const iso = (ms: number) => new Date(ms).toISOString()

const thread = (now: number, over: Record<string, unknown> = {}) => ({
  title: 'install check',
  project: 'config',
  status: 'completed',
  state: 'idle',
  mode: 'auto',
  model: 'some-model',
  updatedAt: iso(now - 60_000),
  startedAt: iso(now - 90_000),
  error: null,
  ...over,
})

/** A full document, as the helper writes it with the server up. */
function full(now: number) {
  return {
    schemaVersion: 1,
    generatedAt: iso(now - 30_000),
    reachable: true,
    reader: true,
    installedVersion: '0.1.8',
    server: {
      version: '0.1.8',
      environmentId: '4dd089d3-9c03-4fcc-8edb-ee6dcfd84972',
      label: 'box',
      startedAt: iso(now - 3_600_000),
    },
    counts: { projects: 2, threads: 3, archived: 1, running: 1, waiting: 1, failed: 0 },
    projects: [
      { title: 'alpha', workspaceRoot: '/w/alpha', repository: 'someone/alpha', threads: 3 },
      { title: 'config', workspaceRoot: '/etc/config', repository: null, threads: 0 },
    ],
    active: [
      thread(now, { title: 'fix the build', state: 'running', status: 'running' }),
      thread(now, { title: 'may I push?', state: 'waiting', status: 'running', startedAt: null }),
    ],
    recent: [thread(now)],
    devices: [
      {
        label: 'daedalus-status',
        deviceType: 'bot',
        os: null,
        browser: null,
        method: 'bearer-access-token',
        subject: 'cli-issued-session',
        connected: false,
        issuedAt: iso(now - 86_400_000),
        lastConnectedAt: null,
        expiresAt: iso(now + 86_400_000),
        fullAccess: false,
      },
      {
        label: null,
        deviceType: 'desktop',
        os: 'macOS',
        browser: 'Safari',
        method: 'browser-session-cookie',
        subject: 'pairing',
        connected: true,
        issuedAt: iso(now - 3_600_000),
        lastConnectedAt: iso(now - 5_000),
        expiresAt: iso(now + 30 * 86_400_000),
        fullAccess: true,
      },
    ],
    pendingPairings: 1,
  }
}

describe('the T3 Code status file', () => {
  it('has no reading when the path is not bound', async () => {
    expect(await readT3Code(ctx(undefined))).toEqual({ status: null, stale: false, error: null })
  })

  it('has no reading, and no error, when the file is missing', async () => {
    expect(await readT3Code(ctx())).toEqual({ status: null, stale: false, error: null })
  })

  it('reports an unparseable file as an error, not a throw', async () => {
    await writeFile(path, '{"schemaVersion": 1, "generat')
    const r = await readT3Code(ctx())
    expect(r.status).toBeNull()
    expect(r.error).toBe('unparseable JSON')
  })

  it('refuses another schema version by name', async () => {
    await writeFile(path, JSON.stringify({ ...full(Date.now()), schemaVersion: 2 }))
    const r = await readT3Code(ctx())
    expect(r.status).toBeNull()
    expect(r.error).toMatch(/schema version 1/)
  })

  it('reads a server that is down: four keys, everything else empty', async () => {
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: iso(Date.now() - 1_000),
        reachable: false,
        installedVersion: '0.1.8',
      }),
    )
    const r = await readT3Code(ctx())
    expect(r.error).toBeNull()
    expect(r.stale).toBe(false)
    expect(r.status).toMatchObject({
      reachable: false,
      reader: false,
      installedVersion: '0.1.8',
      server: null,
      counts: { projects: 0, threads: 0, archived: 0, running: 0, waiting: 0, failed: 0 },
      projects: [],
      active: [],
      recent: [],
      devices: [],
      pendingPairings: 0,
    })
  })

  it('reads a full document', async () => {
    const now = Date.now()
    await writeFile(path, JSON.stringify(full(now)))
    const r = await readT3Code(ctx())
    expect(r.error).toBeNull()
    expect(r.stale).toBe(false)
    const s = r.status
    expect(s?.server?.version).toBe('0.1.8')
    expect(s?.counts).toEqual({
      projects: 2,
      threads: 3,
      archived: 1,
      running: 1,
      waiting: 1,
      failed: 0,
    })
    expect(s?.projects.map((p) => [p.title, p.repository, p.threads])).toEqual([
      ['alpha', 'someone/alpha', 3],
      ['config', null, 0],
    ])
    expect(s?.active.map((t) => t.state)).toEqual(['running', 'waiting'])
    expect(s?.active[1]?.startedAt).toBeNull()
    expect(s?.recent[0]).toMatchObject({ title: 'install check', state: 'idle', mode: 'auto' })
    expect(s?.devices.map((d) => [d.deviceType, d.fullAccess, d.connected])).toEqual([
      ['bot', false, false],
      ['desktop', true, true],
    ])
    expect(s?.pendingPairings).toBe(1)
  })

  it('reads a thread state it does not know as idle', async () => {
    const now = Date.now()
    const doc = { ...full(now), active: [], recent: [thread(now, { state: 'paused' })] }
    await writeFile(path, JSON.stringify(doc))
    expect((await readT3Code(ctx())).status?.recent[0]?.state).toBe('idle')
  })

  it('calls a document older than ten minutes stale, by its own clock', async () => {
    const now = Date.now()
    await writeFile(
      path,
      JSON.stringify({ ...full(now), generatedAt: iso(now - STALE_MS - 1_000) }),
    )
    const r = await readT3Code(ctx())
    expect(r.stale).toBe(true)
    // The last word is kept: the page says how old it is.
    expect(r.status?.server?.version).toBe('0.1.8')
  })

  it('draws the line at STALE_MS exactly, and distrusts a clock it cannot parse', async () => {
    const now = 1_800_000_000_000
    await writeFile(path, JSON.stringify(full(now)))
    const snap = await readSnapshot({
      path,
      decoder: (await import('./t3code')).t3Status,
      fallback: null,
    })
    const at = (generatedAt: string) =>
      readingOf({ ...snap, data: snap.data && { ...snap.data, generatedAt } }, now).stale
    expect(at(iso(now - STALE_MS))).toBe(false)
    expect(at(iso(now - STALE_MS - 1))).toBe(true)
    expect(at('yesterday')).toBe(true)
  })
})
