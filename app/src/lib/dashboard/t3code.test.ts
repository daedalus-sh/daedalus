import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshot } from '../../host/contract/snapshot'
import { readingOf, readT3Code, restartConfirm, STALE_MS } from './t3code'

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

const VALUES = {
  version: '0.1.9',
  rev: '0123456789abcdef0123456789abcdef01234567',
  srchash: '0'.repeat(26) + 'abcdefghijklmnopqrstuvwxyz',
  pnpmhash: '1'.repeat(52),
  chromeversion: '141.0.7390.37',
  chromehash: 'z'.repeat(52),
}

/** A newer release as the resolver writes it once it has the pin's values. */
const ready = (now: number, over: Record<string, unknown> = {}) => ({
  version: '0.1.9',
  current: false,
  checkedAt: iso(now - 60_000),
  blocked: null,
  values: VALUES,
  ...over,
})

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

  it('has no update when the resolver has not run, or the server is down', async () => {
    const now = Date.now()
    await writeFile(path, JSON.stringify(full(now)))
    expect((await readT3Code(ctx())).status?.update).toBeNull()
    await writeFile(path, JSON.stringify({ ...full(now), update: null }))
    expect((await readT3Code(ctx())).status?.update).toBeNull()
  })

  it('reads a pin that is on the newest release', async () => {
    const now = Date.now()
    const update = { version: '0.1.8', current: true, checkedAt: iso(now - 60_000) }
    await writeFile(path, JSON.stringify({ ...full(now), update }))
    expect((await readT3Code(ctx())).status?.update).toEqual(update)
  })

  it('reads a newer release that is ready, with exactly the six values', async () => {
    const now = Date.now()
    await writeFile(path, JSON.stringify({ ...full(now), update: ready(now) }))
    expect((await readT3Code(ctx())).status?.update).toEqual({
      version: '0.1.9',
      current: false,
      checkedAt: iso(now - 60_000),
      blocked: null,
      values: VALUES,
    })
  })

  it('reads a newer release that cannot be built yet, with the host’s sentence', async () => {
    const now = Date.now()
    const blocked = 'The resource monitor’s dependencies changed in 0.1.9.'
    await writeFile(path, JSON.stringify({ ...full(now), update: ready(now, { blocked }) }))
    expect((await readT3Code(ctx())).status?.update).toMatchObject({ current: false, blocked })
  })

  it('drops an update that does not match, and keeps the rest of the reading', async () => {
    const now = Date.now()
    const bad: unknown[] = [
      'soon',
      { version: '0.1.9', checkedAt: iso(now) },
      { version: 'v0.1.9', current: true, checkedAt: iso(now) },
      ready(now, { values: undefined }),
      ready(now, { values: { ...VALUES, rev: 'main' } }),
      ready(now, { values: { ...VALUES, rev: VALUES.rev.toUpperCase() } }),
      ready(now, { values: { ...VALUES, srchash: `${VALUES.srchash}0` } }),
      ready(now, { values: { ...VALUES, pnpmhash: 'sha256-AAAA' } }),
      ready(now, { values: { ...VALUES, chromeversion: '141.0.7390' } }),
      ready(now, { values: { ...VALUES, chromehash: '' } }),
      ready(now, { values: { ...VALUES, version: '0.1.9; reboot' } }),
      // Values of another release than the one the button would name.
      ready(now, { values: { ...VALUES, version: '0.2.0' } }),
      // A field the pin does not have.
      ready(now, { values: { ...VALUES, extra: 'x' } }),
      ready(now, { blocked: 7 }),
    ]
    for (const update of bad) {
      await writeFile(path, JSON.stringify({ ...full(now), update }))
      const r = await readT3Code(ctx())
      expect(r.error).toBeNull()
      expect(r.status?.update).toBeNull()
      expect(r.status?.server?.version).toBe('0.1.8')
    }
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

describe('the restart confirm', () => {
  const reading = async (over: Record<string, unknown>) => {
    const now = Date.now()
    await writeFile(path, JSON.stringify({ ...full(now), ...over }))
    return readT3Code(ctx())
  }
  const counts = (running: number, waiting: number) => ({
    counts: { projects: 2, threads: 3, archived: 0, running, waiting, failed: 0 },
  })

  it('counts the threads running and waiting, and names the terminals', async () => {
    expect(restartConfirm(await reading(counts(2, 1)))).toBe(
      '2 threads are running and 1 is waiting on an answer right now. Restarting the server ends them and every open terminal.',
    )
    expect(restartConfirm(await reading(counts(1, 0)))).toBe(
      '1 thread is running right now. Restarting the server ends it and every open terminal.',
    )
    expect(restartConfirm(await reading(counts(0, 2)))).toBe(
      '2 threads are waiting on an answer right now. Restarting the server ends them and every open terminal.',
    )
  })

  it('says so when nothing is running, and still names the terminals', async () => {
    expect(restartConfirm(await reading(counts(0, 0)))).toBe(
      'No thread is running or waiting right now. Restarting the server still ends every open terminal.',
    )
  })

  it('does not pass off zeros that mean "not asked" as a count', async () => {
    const unknown = /^How many threads are running is not known right now\./
    expect(restartConfirm({ status: null, stale: false, error: null })).toMatch(unknown)
    expect(restartConfirm(await reading({ reader: false }))).toMatch(unknown)
    expect(restartConfirm(await reading({ reachable: false }))).toMatch(unknown)
    expect(restartConfirm({ ...(await reading(counts(3, 0))), stale: true })).toMatch(unknown)
  })
})
