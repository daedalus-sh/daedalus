import type { Ctx } from '../../../core/ctx'
import type { DeviceAccessory } from '../../../lib/agent/light'
import type {
  AccessoryItem,
  AppleOsReleases as ApiAppleOsReleases,
  Apps,
  Claude,
  ClaudeMachine,
  ClaudeSummary,
  MachineDetail,
  MachineItem,
  MachineSystem,
  Machines,
  Overview,
  OverviewHost,
  OverviewMemory,
  Section,
  StorageHealth,
  Updates,
  UpdatesStatus,
} from '../../../lib/api-v1'
import type { AppleOsReleases } from '../../../lib/dashboard/ios-releases'
import type { NodeRow } from '../../../lib/repo/nodes'
import type { Report, Roster, StatusDocument, Summary, Telemetry } from '../../controller/generated'

// What /api/v1 answers, assembled. Every function here calls the loader a
// page or an MCP tool already calls and cuts its answer down to what a phone
// screen shows: no second query, no second idea of what is behind or what an
// Apply carries. A new fact for the app is a field taken from a loader here,
// never a new read.

/** The box's id in a path and an answer. */
export const BOX = 'box'

/** A section, or what stopped it. */
const section = async <T>(read: () => Promise<T>): Promise<Section<T>> => {
  try {
    return await read()
  } catch (e) {
    return { unavailable: e instanceof Error ? e.message : String(e) }
  }
}

/* ── the box's own vitals ─────────────────────────────────────────────── */

async function hostSection(ctx: Ctx): Promise<OverviewHost> {
  const { loadHost } = await import('../../../modules/system/data/host')
  const h = await loadHost(ctx)
  return {
    cpuPct: h.cpuPct,
    cpuSpark: h.cpuSpark,
    cores: h.cores,
    load: h.load,
    uptimeSeconds: h.uptimeSeconds,
    temps: h.temps,
    pressure: h.pressure,
    containers: h.containers,
    failedUnits: h.failedUnitsList,
  }
}

async function memorySection(ctx: Ctx): Promise<OverviewMemory> {
  const { loadMemory } = await import('../../../modules/system/data/memory')
  const m = await loadMemory(ctx)
  return {
    totalBytes: m.total,
    usedBytes: m.used,
    availableBytes: m.available,
    arcBytes: m.arc.size,
    swapUsedBytes: m.zram.used,
    swapTotalBytes: m.zram.total,
    oomKills: m.oomKills,
  }
}

async function storageSection(ctx: Ctx): Promise<StorageHealth> {
  const { storageHealth } = await import('../../mcp/ops')
  return storageHealth(ctx)
}

/* ── overview ─────────────────────────────────────────────────────────── */

export async function overview(ctx: Ctx, hours: number): Promise<Overview> {
  const ops = await import('../../mcp/ops')
  // The Loki readers one after another (it runs few queries at once); the
  // rest beside them.
  const lokiBound = (async () => {
    const alerts = await section(async () => {
      const { loadAlerts } = await import('../../../modules/monitoring/data/alerts')
      const a = await loadAlerts(ctx)
      return { firing: a.firing, pending: a.pending, active: a.active }
    })
    const errors = await section(async () => {
      const e = (await ops.errorSummary(ctx, hours, { samples: false })).content
      return { containers: e.containers, more: e.moreContainers }
    })
    return { alerts, errors }
  })()
  const [head, host, memory, health, storage, jobs, updates, apply, loki] = await Promise.all([
    section(async () => (await import('../../../lib/dashboard/box-head')).loadBoxHead()),
    section(() => hostSection(ctx)),
    section(() => memorySection(ctx)),
    section(async () => {
      const { loadHealth } = await import('../../../lib/dashboard/health')
      const h = await loadHealth(ctx)
      if (h.unavailable) throw new Error('Prometheus answered no probes, so health is unknown.')
      return { probes: h.probes.length, failing: h.failing }
    }),
    section(() => storageSection(ctx)),
    section(async () => {
      const j = await ops.jobsStatus(ctx)
      return {
        watched: j.watched,
        trouble: j.trouble.map((t) => ({
          unit: t.unit,
          result: t.result,
          exitStatus: t.exitStatus,
          status: t.status,
        })),
      }
    }),
    section(async () => {
      const [p, s] = await Promise.all([ops.pendingUpdates(ctx), ops.updateStatus(ctx)])
      return {
        behind: p.behind,
        engine: p.engine.verdict,
        claudeCodeBehind: p.claudeCode?.behind ?? null,
        queued: p.queued.length,
        running: [s.images, s.engine, s.claudeCode].some((x) => x.state === 'running'),
      }
    }),
    section(async () => {
      const { pendingApply } = await import('../../pending-apply')
      const a = await pendingApply(ctx)
      return {
        pending: a.changed.length,
        changed: a.changed,
        state: a.status.state,
        phase: a.status.phase,
        rebootPending: a.status.rebootPending === true,
      }
    }),
    lokiBound,
  ])
  return {
    at: new Date().toISOString(),
    hours,
    head,
    host,
    memory,
    health,
    alerts: loki.alerts,
    storage,
    jobs,
    errors: loki.errors,
    updates,
    apply,
  }
}

/* ── updates ──────────────────────────────────────────────────────────── */

export async function updatesStatus(ctx: Ctx): Promise<UpdatesStatus> {
  const { updateStatus } = await import('../../mcp/ops')
  const s = await updateStatus(ctx)
  return { images: s.images, engine: s.engine, claudeCode: s.claudeCode }
}

export async function updates(ctx: Ctx): Promise<Updates> {
  const { pendingUpdates } = await import('../../mcp/ops')
  const { readQueue } = await import('../../../core/update-queue')
  const [p, queue, status] = await Promise.all([
    pendingUpdates(ctx),
    readQueue(ctx),
    updatesStatus(ctx),
  ])
  return {
    checkedAt: p.checkedAt,
    probeMissing: p.probeMissing,
    behind: p.behind,
    images: p.images,
    engine: p.engine,
    claudeCode: p.claudeCode,
    queue,
    status,
  }
}

/* ── machines ─────────────────────────────────────────────────────────── */

const claudeSummary = (s: Summary | null): ClaudeSummary | null =>
  s === null
    ? null
    : {
        state: s.state,
        detail: s.detail,
        cliVersion: s.cli_version,
        serverVersion: s.server_version,
        sessions: s.sessions,
        startedAt: s.started_at,
        signedIn: s.signed_in,
      }

const accessoryItem = (a: DeviceAccessory): AccessoryItem => ({
  kind: a.kind,
  name: a.name,
  battery: a.battery,
})

function nodeItem(
  n: NodeRow,
  status: StatusDocument | null,
  self: string,
  // The list a detail read already resolved (live over kept); the row's otherwise.
  accessories: readonly DeviceAccessory[] = n.device?.accessories ?? [],
): MachineItem {
  return {
    id: n.id,
    kind: 'node',
    name: n.name,
    os: n.os,
    arch: n.arch,
    agentVersion: n.agentVersion,
    state: n.state === 'revoked' ? 'revoked' : 'approved',
    connected: n.connected,
    lastSeenAgo: Math.max(0, Math.round(n.lastSeenAgo)),
    lastSeenAt: n.lastSeenAt,
    light: n.light,
    self: n.id === self,
    model: n.device?.model ?? null,
    updateAvailable: status?.update_available ?? null,
    restartPending: status?.restart_pending ?? false,
    claude: n.light ? null : claudeSummary(n.claude),
    battery: n.device?.battery ?? null,
    accessories: n.light ? accessories.map(accessoryItem) : [],
  }
}

async function boxItem(ctx: Ctx): Promise<MachineItem> {
  const { loadBoxHead } = await import('../../../lib/dashboard/box-head')
  const { readControllerClaude } = await import('../../../lib/dashboard/claude')
  const [head, info, claude] = await Promise.all([
    loadBoxHead(),
    ctx.controller.call('system.info').catch(() => null),
    readControllerClaude(ctx.controller),
  ])
  const r = claude.report
  return {
    id: BOX,
    kind: 'box',
    name: head.hostname,
    os: 'linux',
    arch: head.arch,
    agentVersion: info?.version ?? null,
    state: 'approved',
    connected: true,
    lastSeenAgo: 0,
    lastSeenAt: new Date().toISOString(),
    light: false,
    self: false,
    model: head.model,
    updateAvailable: null,
    restartPending: false,
    claude:
      r === null
        ? null
        : {
            state: r.state,
            detail: r.detail,
            cliVersion: r.cli_version,
            serverVersion: r.server.version,
            sessions: r.sessions.filter((s) => s.alive).length,
            startedAt: r.started_at,
            signedIn: r.credentials.present,
          },
    battery: null,
    accessories: [],
  }
}

/** The box first, then every decided machine in the order it joined. */
export async function machines(ctx: Ctx, self: string): Promise<Machines> {
  const { loadMachines } = await import('../../../lib/dashboard/machines')
  const [box, m] = await Promise.all([boxItem(ctx), loadMachines(ctx)])
  const nodes = m.machines
    .filter((x) => x.node !== null)
    .map((x) => nodeItem(x.node as NodeRow, x.status, self))
  return { machines: [box, ...nodes] }
}

const systemOf = (s: StatusDocument, t: Telemetry): MachineSystem => ({
  sampledAt: t.sampled_at,
  osName: s.os_name,
  osVersion: s.os_version,
  kernel: t.os.kernel,
  cpu: s.cpu,
  cpuPct: t.cpu.usage_pct,
  uptimeSeconds: s.os_uptime_secs,
  bootedAt: s.booted_at,
  model: t.machine.model,
  form: t.machine.form,
  memory: {
    totalBytes: t.memory.total_bytes,
    usedBytes: t.memory.used_bytes,
    availableBytes: t.memory.available_bytes,
  },
  disks: t.disks.map((d) => ({
    mount: d.mount,
    name: d.name,
    totalBytes: d.total_bytes,
    usedBytes: d.used_bytes,
    freeBytes: d.free_bytes,
  })),
  battery:
    t.battery === null
      ? null
      : {
          percent: t.battery.percent,
          charging: t.battery.charging,
          healthPct: t.battery.health_pct,
          cycles: t.battery.cycles,
          condition: t.battery.condition,
        },
  temperatures: t.temperatures.map((x) => ({ label: x.label, celsius: x.celsius })),
  osUpdatesPending: t.updates === null ? null : t.updates.pending.length,
  osRebootPending: t.updates?.reboot_pending ?? null,
})

/** Apple's list as a phone screen shows it: each release's facts and links, not the notes' text. */
const withoutNotes = (r: AppleOsReleases): ApiAppleOsReleases => ({
  ...r,
  releases: r.releases.map(({ notes: _notes, ...rest }) => rest),
})

/** One machine's page: the box's vitals for `box`, a node's last report otherwise. Null: no such machine. */
export async function machineDetail(
  ctx: Ctx,
  id: string,
  self: string,
): Promise<MachineDetail | null> {
  if (id === BOX) {
    const [machine, host, memory, storage] = await Promise.all([
      boxItem(ctx),
      section(() => hostSection(ctx)),
      section(() => memorySection(ctx)),
      section(() => storageSection(ctx)),
    ])
    return { machine, kind: 'box', host, memory, storage }
  }
  const { loadNodeSystem } = await import('../../../lib/dashboard/node-system')
  const d = await loadNodeSystem(ctx, id, { ios: true, watch: true })
  if (d === null) return null
  const n = d.node
  const system = d.status !== null && d.telemetry !== null ? systemOf(d.status, d.telemetry) : null
  return {
    machine: nodeItem(n, d.status, self, d.accessories),
    kind: 'node',
    system,
    cpuSpark: d.cpuSpark,
    device:
      n.light && n.device !== null
        ? {
            ...n.device,
            accessories: d.accessories.map(({ releases, ...a }) => ({
              ...a,
              osReleases: releases === null ? null : withoutNotes(releases),
            })),
          }
        : null,
    osReleases: d.ios === null ? null : withoutNotes(d.ios),
    note: system !== null ? null : (d.error ?? 'no telemetry has arrived yet'),
  }
}

/* ── claude ───────────────────────────────────────────────────────────── */

const TRANSCRIPTS = 10
const AGENT_ID = /^[0-9a-f]{8}$/

async function claudeGap(installed: string | null): Promise<ClaudeMachine['update']> {
  const { versionGap } = await import('../../../lib/dashboard/github')
  const g = await versionGap('anthropics/claude-code', installed).catch(() => null)
  return g === null || g.latest === null
    ? null
    : { installed: g.installed, latest: g.latest, behind: g.behind.length }
}

function rosterParts(
  roster: Roster | null,
): Pick<ClaudeMachine, 'agents' | 'transcripts' | 'actions'> {
  if (roster === null) return { agents: [], transcripts: [], actions: [] }
  return {
    agents: roster.agents.flatMap((a) =>
      a.kind === 'background' && a.id !== null && AGENT_ID.test(a.id)
        ? [{ id: a.id, state: a.state, name: a.name, cwd: a.cwd, startedAt: a.started_at }]
        : [],
    ),
    transcripts: [...roster.transcripts]
      .sort((a, b) => b.modified_at - a.modified_at)
      .slice(0, TRANSCRIPTS)
      .map((t) => ({
        id: t.id,
        title: t.title,
        project: t.project,
        cwd: t.cwd,
        modifiedAt: t.modified_at,
      })),
    actions: roster.actions.map((a) => ({
      request: a.request,
      action: a.action,
      session: a.id,
      state: a.state,
      detail: a.detail,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
    })),
  }
}

const sessionsOf = (r: Report | null): ClaudeMachine['sessions'] =>
  (r?.sessions ?? []).map((s) => ({
    id: s.transcript_id,
    remoteId: s.remote_id,
    name: s.name,
    cwd: s.cwd,
    kind: s.kind,
    status: s.status,
    startedAt: s.started_at,
    lastActivityAt: s.last_activity_at,
    alive: s.alive,
  }))

const serverOf = (
  r: Report | null,
  state: string,
  detail: string | null,
): ClaudeMachine['server'] => ({
  state: r?.state ?? state,
  detail: r?.detail ?? detail,
  version: r?.server.version ?? null,
  cliVersion: r?.cli_version ?? null,
  restarts: r?.restarts ?? null,
  startedAt: r?.started_at ?? null,
  signedIn: r?.credentials.present ?? false,
})

/** Every machine that runs Claude: the box, then each approved, connected machine that is not a phone. */
export async function claude(ctx: Ctx): Promise<Claude> {
  const { readControllerClaude, readRoster } = await import('../../../lib/dashboard/claude')
  const { loadNodeClaude } = await import('../../../lib/dashboard/node-claude')
  const { loadBoxHead } = await import('../../../lib/dashboard/box-head')
  const { listNodes } = await import('../../../lib/repo/nodes')

  const box = (async (): Promise<ClaudeMachine> => {
    const [head, read, roster] = await Promise.all([
      loadBoxHead(),
      readControllerClaude(ctx.controller),
      readRoster(
        () => ctx.controller.call('claude.roster'),
        'the controller’s Claude session has not reported a roster yet',
      ),
    ])
    const r = read.report
    return {
      id: BOX,
      name: head.hostname,
      server: serverOf(r, read.state ?? 'unknown', read.detail),
      update: await claudeGap(r?.server.version ?? r?.cli_version ?? null),
      sessions: sessionsOf(r),
      ...rosterParts(roster.roster),
      note: roster.missing,
    }
  })()

  const rows = (await listNodes(ctx)).filter(
    (n) => n.state === 'approved' && !n.light && n.connected === true,
  )
  const nodes = rows.map(async (n): Promise<ClaudeMachine | null> => {
    const d = await loadNodeClaude(ctx, n.id)
    if (d === null) return null
    return {
      id: n.id,
      name: n.name,
      server: serverOf(
        d.report,
        d.status?.claude?.state ?? 'no-report',
        d.reportError ?? d.error ?? d.status?.claude?.detail ?? null,
      ),
      update: await claudeGap(d.report?.server.version ?? d.report?.cli_version ?? null),
      sessions: sessionsOf(d.report),
      ...rosterParts(d.roster),
      note: d.rosterMissing ?? d.error,
    }
  })
  const all = await Promise.all([box, ...nodes])
  return { machines: all.filter((m) => m !== null) }
}

/* ── apps ─────────────────────────────────────────────────────────────── */

export async function apps(ctx: Ctx): Promise<Apps> {
  const { loadAppList } = await import('../../../lib/apps/list')
  const list = await loadAppList(ctx)
  return {
    apps: list.apps.map((a) => ({
      name: a.name,
      stage: a.stage,
      hostname: a.hostname,
      description: a.description ?? null,
      state: a.status.state,
      containerUp: a.status.containerUp,
      healthy: a.status.healthy,
      isNew: a.isNew,
      drift: a.drift,
      lastDeploy: a.deployed,
    })),
  }
}
