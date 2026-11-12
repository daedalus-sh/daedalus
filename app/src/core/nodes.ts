import type {
  Command,
  CommandOk,
  NodeDetail,
  NodeSummary,
  PolicyRequest,
} from '../host/controller/generated'
import {
  enrollValues,
  observedFacts,
  requestDesiredSync,
  syncDesired,
} from '../host/controller/nodes'
import { dhcpHostsMissing, householdMacs, writeDhcpHosts } from '../host/dhcp-hosts'
import { fingerprintOf, releaseTunnel } from '../host/enroll'
import { requestGatewaySync } from '../host/gateway-sync'
import type { NodePolicy } from '../host/schema'
import { readSessionHost } from '../host/session-host'
import { deviceFactsFrom, isLightOs, lightKind, sameDeviceFacts } from '../lib/agent/light'
import { keepLifecycle } from '../lib/agent/policy-patch'
import { netNameOf } from '../lib/nodes-file'
import { enrollStore } from '../lib/repo/enroll'
import {
  allNodeRows,
  deleteNode,
  insertEnrolled,
  type NodeRecord,
  netNameTakenBy,
  nodeById,
  type PolicyPatch,
  setApproved,
  setRevoked,
  writeDevice,
  writeObserved,
  writePolicy,
  writePolicyRequest,
  writeSantreeOn,
} from '../lib/repo/nodes'
import type { Result } from '../lib/result'
import type { Ctx } from './ctx'

// The decisions about a machine, and what follows each. The rows are
// lib/repo/nodes.ts; this is the order things happen in around them.
//
// Every decision and policy save ends in a desired-state sync
// (host/controller/nodes.ts), which is how it reaches the machine, and a
// gateway sync (host/gateway-sync.ts), which is how its providers do; a
// decision also re-renders the DHCP lines.

/**
 * Change a node's policy from the page, recorded under `by`. santree is
 * turned ON only through `grantSantree`: the page's patch refuses it
 * (lib/agent/policy-patch.ts, the one gate a web patch passes).
 */
export async function setNodePolicy(
  ctx: Ctx,
  id: string,
  p: PolicyPatch,
  by: string,
): Promise<boolean> {
  // Two machines cannot share a name on the network: the lease, the
  // nodes.json entry and every consumer dial it.
  const name = p.set.name
  if (name !== undefined) {
    const taken = await netNameTakenBy(name, id)
    if (taken !== null) throw new Error(`"${name}" is already ${taken}'s name on the network`)
  }
  // A providers object from a page keeps the lifecycle keys it did not name.
  const set =
    p.set.providers === undefined
      ? p.set
      : {
          ...p.set,
          providers: keepLifecycle((await nodeById(id))?.policy?.providers, p.set.providers),
        }
  const updated = await writePolicy(id, { ...p, set }, by)
  await afterDecision(ctx)
  return updated
}

/**
 * A machine asks for its own settings (the controller's
 * `nodes.policy_request`): keep awake, Claude Remote Control, santree OFF —
 * never santree ON, which the controller refuses where the request enters
 * (link/wire.rs `PolicyRequest::check`). Only
 * the keys it sent are written, only into an approved row, and only when the
 * row does not hold them already; then the desired set goes to the
 * controller, which is what changes the machine. Never the DHCP lines or the
 * gateway: none of these keys moves either, and a DHCP write reloads
 * pi-hole for the whole house. True when the row changed.
 */
export async function applyNodePolicyRequest(
  ctx: Ctx,
  id: string,
  changes: PolicyRequest,
): Promise<boolean> {
  const set: NodePolicy = {
    ...(changes.awake_hold === undefined ? {} : { awakeHold: changes.awake_hold }),
    ...(changes.claude_remote_control === undefined
      ? {}
      : { claudeRemoteControl: changes.claude_remote_control }),
    ...(changes.santree === undefined ? {} : { santree: changes.santree }),
  }
  if (Object.keys(set).length === 0) return false
  const row = await writePolicyRequest(id, set)
  if (row === undefined) return false
  const name = row.policy?.displayName?.trim() || row.hostname
  const said = Object.entries(set)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  console.info(`nodes: ${id} (${name}) set ${said} from the machine`)
  requestDesiredSync(ctx)
  return true
}

/** How a santree grant ended (`grantSantree`). */
export type SantreeGrant = { ok: true; already: boolean } | { ok: false; reason: string }

/**
 * Turn santree on for machine `id` — a shell on the box as its operator,
 * who has root through sudo — once an admin confirmed it on a page that
 * showed the machine and its key. Only an approved row, only the key the
 * page showed (`fingerprint`, checked again against the row), only on a box
 * with a session host, recorded under `by`; then the desired set is sent and
 * its answer awaited, so the reply says what the controller took.
 */
export async function grantSantree(
  ctx: Ctx,
  input: { id: string; fingerprint: string; by: string },
): Promise<SantreeGrant> {
  const n = await nodeById(input.id)
  if (n === undefined || n.state !== 'approved') {
    return { ok: false, reason: 'This machine is not approved.' }
  }
  if (isLightOs(n.os)) return { ok: false, reason: 'A phone or tablet runs no santree.' }
  if (fingerprintOf(n.publicKey) !== input.fingerprint) {
    return { ok: false, reason: 'This machine has another key now; reload the page.' }
  }
  if (n.policy?.santree === true) return { ok: true, already: true }
  if ((await readSessionHost(ctx)) === null) {
    return { ok: false, reason: 'This box runs no session host, so santree has nowhere to go.' }
  }
  if (!(await writeSantreeOn(input.id, n.publicKey, input.by))) {
    return { ok: false, reason: 'This machine changed; reload the page.' }
  }
  console.info(`nodes: ${input.id} santree turned on by ${input.by}`)
  await syncNow(ctx)
  return { ok: true, already: false }
}

/** Approve a row the table already holds (a revoked key, trusted again). */
export async function approveNode(ctx: Ctx, id: string, by: string): Promise<boolean> {
  const updated = await setApproved(id, by)
  await afterDecision(ctx)
  return updated
}

/**
 * Approve a key the controller holds pending: the row is made from its key
 * and its hello, approved in the same write.
 */
export async function enrollNode(ctx: Ctx, detail: NodeDetail, by: string): Promise<boolean> {
  const made = await insertEnrolled(enrollValues(detail), by)
  await afterDecision(ctx)
  return made
}

export async function revokeNode(ctx: Ctx, id: string): Promise<boolean> {
  // A phone's API token first: the credential ends before anything else does.
  await dropNodeToken(id)
  const updated = await setRevoked(id)
  await afterDecision(ctx)
  if (updated && (await hasTunnel(id))) {
    // Told first, through the tunnel, so the machine forgets its log-in
    // rather than dialling a tunnel that is gone.
    await syncNow(ctx)
    await releaseTunnel({ store: enrollStore, wg: await boxWgEasy() }, id)
  }
  return updated
}

/**
 * Forget a row entirely — for a machine that is gone, or a key that was a
 * mistake. Left out of the desired set, a key that connects again waits
 * pending, as a stranger's would.
 *
 * A logged-in machine (one with a tunnel) is revoked first and the
 * controller's answer awaited, so it hears `revoked` before its tunnel goes;
 * one that logged out itself (`left`, the controller's `nodes.left`) already
 * forgot, and only its tunnel and row go.
 */
export async function forgetNode(
  ctx: Ctx,
  id: string,
  opts: { left?: boolean } = {},
): Promise<boolean> {
  await dropNodeToken(id)
  if (await hasTunnel(id)) {
    if (opts.left !== true && (await setRevoked(id))) await syncNow(ctx)
    await releaseTunnel({ store: enrollStore, wg: await boxWgEasy() }, id)
  }
  const gone = await deleteNode(id)
  await afterDecision(ctx)
  return gone
}

/**
 * Delete the node's API token (host/node-tokens.ts), if it has one. A table
 * that cannot be written is logged and the decision goes on: every call
 * checks the row's state, and a forgotten row takes its token with it.
 */
async function dropNodeToken(id: string): Promise<void> {
  try {
    const { revokeNodeToken } = await import('../host/node-tokens')
    if (await revokeNodeToken(id)) console.info(`nodes: ${id}'s API token deleted`)
  } catch (e) {
    console.warn(
      `nodes: ${id}'s API token not deleted: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * One instruction to one machine, through the controller: what the Machines
 * page's buttons and the native app's API both send. A phone or tablet takes
 * none: it runs no updater of ours and no Claude.
 */
export async function sendNodeCommand(
  ctx: Pick<Ctx, 'controller'>,
  id: string,
  command: Command,
): Promise<Result<CommandOk>> {
  const n = await nodeById(id)
  if (n === undefined) return { ok: false, reason: 'No such machine.' }
  if (isLightOs(n.os)) {
    return { ok: false, reason: `An ${lightKind(n.os)} takes no commands from the box.` }
  }
  return { ok: true, value: await ctx.controller.call('nodes.command', { id, command }) }
}

/** Whether the node logged in with a tunnel of its own; a table that cannot be read says no. */
async function hasTunnel(id: string): Promise<boolean> {
  try {
    return (await enrollStore.tunnelOf(id)) !== null
  } catch (e) {
    console.warn(`nodes: ${id}'s tunnel not read: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** The desired set, sent and answered now (a decision's own sync is not awaited). */
async function syncNow(ctx: Ctx): Promise<void> {
  const s = await syncDesired(ctx)
  if (s.error !== null) console.warn(`nodes: the controller did not take the set: ${s.error}`)
}

async function boxWgEasy() {
  const { wgEasy } = await import('../host/wg-easy')
  return wgEasy()
}

/**
 * What follows every decision about a machine and every policy save: its DHCP
 * line, the desired set that tells the controller, and the gateway — a machine
 * trusted, revoked or forgotten is one whose providers are routed or not, now
 * rather than at the next five-minute sync.
 */
async function afterDecision(ctx: Ctx): Promise<void> {
  await publishDhcpHosts(ctx)
  requestDesiredSync(ctx)
  requestGatewaySync()
}

/**
 * Keep each decided row's last-known facts from what the controller
 * observed (host/controller/nodes.ts `observedFacts`), and re-render the
 * DHCP lines when an address, a MAC or a name moved.
 */
export async function recordObserved(
  ctx: Pick<Ctx, 'controller'>,
  seen: readonly NodeSummary[],
): Promise<void> {
  if (seen.length === 0) return
  const byId = new Map(seen.map((s) => [s.id, s]))
  const moved: { id: string; facts: Partial<NodeRecord> }[] = []
  let dhcp = await dhcpHostsMissing()
  const rows = await allNodeRows()
  for (const n of rows) {
    const s = byId.get(n.id)
    if (s === undefined || n.state !== 'approved') continue
    const facts = observedFacts(n, s)
    if (facts === null) continue
    moved.push({ id: n.id, facts })
    if (facts.lanIp !== undefined || facts.mac !== undefined || facts.hostname !== undefined) {
      dhcp = true
    }
  }
  await writeObserved(moved)
  await recordDevices(ctx, rows, byId)
  if (dhcp) await publishDhcpHosts(ctx)
  // A new address is a new origin for its Lemonade (lib/agent/policy.ts).
  if (moved.some((m) => m.facts.lanIp !== undefined)) requestDesiredSync(ctx)
}

/**
 * Write the approved nodes' dnsmasq lines (host/dhcp-hosts.ts): how each
 * machine gets its name from pi-hole. A MAC the household file already
 * names is theirs to name, and skipped. Best effort: a failure to hand them
 * over is logged and never fails the decision that triggered it — the lines
 * are a consequence, not the act.
 */
async function publishDhcpHosts(ctx: Pick<Ctx, 'controller'>): Promise<void> {
  try {
    const [all, household] = await Promise.all([allNodeRows(), householdMacs()])
    await writeDhcpHosts(
      ctx,
      all
        .filter((n) => n.state === 'approved')
        .filter((n) => n.mac !== null && !household.has(n.mac.toLowerCase()))
        .map((n) => ({
          id: n.id,
          mac: n.mac ?? '',
          name: netNameOf(n),
          lanIp: n.policy?.pinAddress === true ? n.lanIp : null,
        })),
    )
  } catch (e) {
    console.warn(`dhcp hosts not written: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Keep what each connected phone or tablet says about itself (lib/agent/
 * light.ts): it is connected only while its app is open, and the controller
 * forgets it on a restart. One `nodes.get` per connected light node, and a
 * write only when a fact moved. Best effort.
 */
async function recordDevices(
  ctx: Pick<Ctx, 'controller'>,
  rows: readonly NodeRecord[],
  seen: ReadonlyMap<string, NodeSummary>,
): Promise<void> {
  for (const n of rows) {
    if (n.state !== 'approved' || !isLightOs(n.os) || seen.get(n.id)?.connected !== true) continue
    try {
      const d = await ctx.controller.call('nodes.get', { id: n.id, full: true })
      const facts = deviceFactsFrom(d, n.device, new Date().toISOString())
      if (facts !== null && !sameDeviceFacts(facts, n.device)) await writeDevice(n.id, facts)
    } catch (e) {
      console.warn(
        `nodes: ${n.id}'s device facts not kept: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }
}
