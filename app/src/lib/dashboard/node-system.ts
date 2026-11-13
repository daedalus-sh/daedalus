import type { Ctx } from '../../core/ctx'
import type {
  NodeDetail,
  ProviderReport,
  StatusDocument,
  Telemetry,
} from '../../host/controller/generated'
import { readNode } from '../../host/controller/nodes'
import { type DeviceAccessory, deviceFactsFrom, isLightOs } from '../agent/light'
import { getNode, type NodeRow } from '../repo/nodes'
import { type BoardReleases, boardReleases } from './board-releases'
import { type BrowserLatest, browserLatest } from './browser-releases'
import { type AppleOsReleases, iosReleases } from './ios-releases'
import { type MacReleases, macosReleases } from './macos-releases'

// The System page for a machine that is not this box, the same tabs the
// box draws for itself (modules/system/view/node/): what the controller
// holds for the machine — its status document and the full telemetry
// document it pushed up its link (agent/src/telemetry.rs: drive serials,
// the heaviest processes, the services that are down, the OS's pending
// updates) — and the box's own Prometheus for the six-hour processor
// history it has scraped from the controller's `/nodes/metrics`, which
// serves every connected machine's telemetry labelled by node id.
//
// One read serves every tab. The tabs are a way of reading one document,
// not five requests. A machine that is not connected shows what the
// controller last heard from it, and nothing once the controller has
// restarted since.

/** A phone's watch: what the phone last said about it, and Apple's list past its watchOS when asked for. */
export type NodeAccessory = DeviceAccessory & {
  /** Null when not asked for, or when the watch has not said which watchOS it runs. */
  releases: AppleOsReleases | null
}

export type NodeSystemData = {
  node: NodeRow
  status: StatusDocument | null
  /** The full document; null before the machine's first sample reached the controller. */
  telemetry: Telemetry | null
  /**
   * What the machine's agent read from its providers (agent/src/node/providers/),
   * as it last reported them; null until it has.
   */
  providers: ProviderReport[] | null
  /**
   * The maker's BIOS releases, read only for the Motherboard tab (it asks a
   * download host on the internet, which the other tabs have no use for).
   */
  releases: BoardReleases | null
  /** The vendors' current stable per installed browser, read only for the Chromium tab. */
  browserLatest: BrowserLatest[] | null
  /** What Apple has shipped past the running macOS, read only for the macOS tab. */
  macos: MacReleases | null
  /** What Apple has shipped past a phone's or tablet's OS, read only for its Software tab. */
  ios: AppleOsReleases | null
  /**
   * A phone's paired watch, from its live sample when the controller holds
   * one and from what the box kept when it does not; empty for every other
   * machine. Its `releases` are read only for /api/v1's page of the phone;
   * the web draws the watch as a machine of its own (./accessory-system.ts).
   */
  accessories: NodeAccessory[]
  /** Processor busy, six hours at two-minute steps, from the box's Prometheus. */
  cpuSpark: number[]
  error: string | null
}

export async function loadNodeSystem(
  ctx: Pick<Ctx, 'controller' | 'prom'>,
  id: string,
  opts: {
    board?: boolean
    browsers?: boolean
    macos?: boolean
    ios?: boolean
    watch?: boolean
  } = {},
): Promise<NodeSystemData | null> {
  // One read: the machine, its status, its full telemetry and its providers.
  // The spark does not need the machine: it is what the box has scraped,
  // and a machine that is asleep still has a history.
  const [read, cpuSpark] = await Promise.all([
    readNode(ctx, id, true),
    ctx.prom
      .series(`daedalus_agent_cpu_usage_percent{node=${ctx.prom.quote(id)}}`, 6 * 60, 120)
      .catch(() => []),
  ])
  const node = await getNode(id, read)
  if (node === null) return null
  const d = read.detail
  // A phone is rarely connected: Apple's list is read from what it last said
  // it runs, live or kept (the row's `device`).
  const ios =
    opts.ios === true && isLightOs(node.os)
      ? await iosFor(node, d?.status?.os_version || null)
      : null
  const accessories = isLightOs(node.os) ? await accessoriesFor(node, d, opts.watch === true) : []
  const none = {
    node,
    status: null,
    telemetry: null,
    providers: null,
    releases: null,
    browserLatest: null,
    macos: null,
    ios,
    accessories,
    cpuSpark,
  }
  if (d === null) return { ...none, error: read.error }
  if (d.status === null) {
    return {
      ...none,
      error: d.connected ? 'connected, but no status has arrived yet' : 'not connected',
    }
  }
  const { status, telemetry: t, providers } = d
  if (t === null) {
    return { ...none, status, providers, error: null }
  }

  const releases =
    opts.board === true
      ? await boardReleases({
          vendor: t.machine.board_manufacturer ?? t.machine.manufacturer,
          product: t.machine.board_product ?? t.machine.model,
          biosVersion: t.machine.bios_version,
          biosDate: t.machine.bios_date,
        })
      : null
  const browsers =
    opts.browsers === true
      ? await browserLatest(
          t.browsers.map((b) => b.kind),
          node.os,
          node.arch,
        )
      : null
  // The Mac's own version is on the status document, so Apple's list does
  // not need the full one either.
  const macos =
    opts.macos === true && node.os === 'macos'
      ? await macosReleases(status.os_version, t.machine.target)
      : null
  return {
    ...none,
    status,
    telemetry: t,
    providers,
    releases,
    browserLatest: browsers,
    macos,
    error: null,
  }
}

async function iosFor(node: NodeRow, live: string | null): Promise<AppleOsReleases | null> {
  const version = live ?? node.device?.osVersion ?? null
  if (version === null || version === '' || !isLightOs(node.os)) return null
  return iosReleases(node.os, version, node.device?.model ?? null)
}

/**
 * The watch a phone reports beside itself: the live sample's list over the
 * row's (lib/agent/light.ts `deviceFactsFrom`), each with Apple's watchOS
 * list when `releases` asks for it.
 */
async function accessoriesFor(
  node: NodeRow,
  d: NodeDetail | null,
  releases: boolean,
): Promise<NodeAccessory[]> {
  const live = d === null ? null : deviceFactsFrom(d, node.device, new Date().toISOString())
  const list = (live ?? node.device)?.accessories ?? []
  return Promise.all(
    list.map(async (a) => ({ ...a, releases: releases ? await watchReleases(a) : null })),
  )
}

/** Apple's watchOS list past what a watch runs; null when it has not said which. */
export async function watchReleases(a: DeviceAccessory): Promise<AppleOsReleases | null> {
  if (a.osVersion === null) return null
  return iosReleases(
    'watchos',
    a.osBuild === null ? a.osVersion : `${a.osVersion} (${a.osBuild})`,
    a.model,
  )
}
