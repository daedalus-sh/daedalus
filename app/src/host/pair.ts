import { isIpv4 } from '../lib/agent/enroll'
import { type DeviceFacts, isLightOs, type LightOs } from '../lib/agent/light'
import { hasControlChar } from '../lib/agent/policy'
import { PAIR_TICKET_MS, pairLink, pairQrSvg } from '../lib/pair-link'
import type { SystemInfo } from './controller/generated'
import { MAX_HOSTNAME } from './controller/generated/constants'
import type { DesiredSync } from './controller/nodes'
import { nodeIdOf } from './controller/nodes'
import {
  clientName,
  codeHash,
  confinedClient,
  type EnrollStore,
  ensureFirewall,
  type NodeStanding,
  type Outcome,
  portOf,
  type Tunnel,
  token,
} from './enroll'
import type { WgEasy } from './wg-easy'

// A phone or tablet joining the box, the app's half (the device's is ios/).
// The device is a node — its own ed25519 key, a row in `nodes`, a link to the
// controller — approved by scanning a code instead of by a consent page:
//
//   Add (adminFn)          a wg-easy client made and confined, a single-use
//                          ticket bound to it and to the admin, and the pair
//                          link, shown once as a QR code: the ticket and the
//                          client's config
//   POST /api/node/pair    the device, through that tunnel and outside the
//                          sign-in: the ticket and its public key → the node
//                          approved under the ticket's admin and handed to
//                          the controller, the client bound to it, its API
//                          token (host/node-tokens.ts) → the controller's
//                          pin and address, and the token
//
// The ticket is spent by its first redeem, right or wrong, and lives five
// minutes. A redeem that fails after that undoes what it did — the node put
// back as it was, the controller told — and deletes the ticket's client: the
// ticket is dead, so its tunnel is good for nothing. One nobody redeemed is
// swept, client and row, by the next Add or the next look at Settings ›
// Machines. The client's private key is wg-easy's to keep: read once at Add
// for the link, never stored here and never logged.
//
// ── what the tunnel reaches ────────────────────────────────────────────────
//
// AllowedIPs is the box's LAN address alone, and the per-client firewall is
// two entries:
//
//   <WG_EASY_HOST_ALIAS>:<link port>/tcp   the controller's link
//   <lan address>:443/tcp                  traefik, for /api/v1
//
// Both are needed because wg-easy filters a client in its container's FORWARD
// chain (`-A FORWARD -i wg0 -j WG_CLIENTS_wg0`: an ACCEPT per `firewallIps`
// entry of the client, then one DROP), and neither destination is the
// container's own. The container holds 10.8.0.1 and its bridge addresses, not
// the LAN address: a packet for `<lan>:443` leaves by its default route to
// the bridge, where traefik's port is published in the rootless netns one hop
// on — forwarded, so filtered, still addressed to the LAN address because no
// DNAT names 443. The controller's port is DNATed to the host alias in
// PREROUTING, before the filter, so its entry names the alias (as a Mac's
// log-in does, host/enroll.ts). Only what the container itself serves — the
// wg-easy UI at 10.8.0.1 — is INPUT and reachable regardless. Read off the
// running container's `iptables -S` and `ip addr`; a Mac's client, confined
// to the link and the session host, reaches no 443.
//
// So a paired device reaches the controller's link and every hostname traefik
// serves on the LAN, each behind its own sign-in — and not the session host,
// sshd or any other port.
//
// ── pairing again ──────────────────────────────────────────────────────────
//
// A key whose node already exists pairs again cleanly when that node is a
// phone or tablet: approved (again, if it was revoked), its tunnel replaced
// by the ticket's and the old client deleted, its token replaced. A key that
// belongs to any other kind of machine is refused: the body only states a
// key, and a ticket must not be a way to take a Mac's tunnel and mint a token
// in its name.
//
// Everything that reaches the machine is passed in (`PairDeps`), so the tests
// drive the flow with fakes.

export type TicketRow = {
  ticketHash: string
  clientId: number
  address: string
  createdBy: string
  expiresAt: Date
}

/** The database, as the flow uses it (lib/repo/pair.ts is the real one). */
export type PairStore = Pick<
  EnrollStore,
  'standing' | 'approve' | 'restore' | 'tunnelOf' | 'setTunnel' | 'deleteTunnel'
> & {
  /** The OS a node's row states, or null when the key has no row. */
  osOf: (id: string) => Promise<string | null>
  /** What the device said it is, onto its row. */
  setFacts: (
    id: string,
    f: { hostname: string; os: string; arch: string; version: string; device: DeviceFacts },
  ) => Promise<void>
  putTicket: (row: TicketRow) => Promise<void>
  /** The unspent ticket, marked spent in the same statement: whoever takes it first spends it. */
  takeTicket: (hash: string, at: Date) => Promise<TicketRow | null>
  deleteTicket: (hash: string) => Promise<void>
  /** Every ticket, spent or not, that expired before `before`. */
  ticketsBefore: (before: Date) => Promise<TicketRow[]>
  /** Whether a node's tunnel is this client: a pairing that completed. */
  clientBound: (clientId: number) => Promise<boolean>
}

export type PairDeps = {
  store: PairStore
  wg: WgEasy
  systemInfo: () => Promise<SystemInfo>
  sync: () => Promise<DesiredSync>
  /** A new API token for the node, replacing the one it had (host/node-tokens.ts). */
  mintToken: (nodeId: string) => Promise<string>
  /** The box's LAN address: the one address the tunnel reaches. */
  lanIp: string
  /** WG_EASY_HOST_ALIAS: where the tunnel's host ports land after wg-easy's DNAT. */
  hostAlias: string
  /** The control plane's hostname, or null when the box publishes none. */
  appHostname: string | null
  boxHostname: string
  now?: () => number
  log?: (line: string) => void
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A ticket is swept this long after it expired: a redeem under way at the last second finishes first. */
const SWEEP_GRACE_MS = 60_000

/** wg-easy's name for a client nobody has scanned yet. */
const UNPAIRED_CLIENT = 'daedalus-pairing'

/** Where machines reach the controller, and the key they pin. */
async function controllerOf(
  deps: Pick<PairDeps, 'systemInfo'>,
): Promise<{ pin: string; port: number }> {
  const c = (await deps.systemInfo()).controller
  const port = portOf(c?.advertise[0]) ?? portOf(c?.listen)
  if (c === null || port === null) throw new Error('it says nowhere machines reach it')
  return { pin: c.fingerprint, port }
}

// ── tickets nobody redeemed ────────────────────────────────────────────────

/**
 * Delete the tickets that ran out, each with its wg-easy client — unless a
 * node's tunnel is that client, which is a pairing that completed and whose
 * ticket row alone stayed behind. A ticket whose client could not be deleted
 * stays for the next sweep. Never throws.
 */
export async function sweepTickets(
  deps: {
    store: Pick<PairStore, 'ticketsBefore' | 'clientBound' | 'deleteTicket'>
    wg: WgEasy | null
  } & Pick<PairDeps, 'now' | 'log'>,
): Promise<number> {
  const log = deps.log ?? ((l: string) => console.info(l))
  if (deps.wg === null) return 0
  let gone = 0
  try {
    const before = new Date((deps.now ?? Date.now)() - SWEEP_GRACE_MS)
    for (const t of await deps.store.ticketsBefore(before)) {
      try {
        if (!(await deps.store.clientBound(t.clientId))) await deps.wg.deleteClient(t.clientId)
        await deps.store.deleteTicket(t.ticketHash)
        gone++
      } catch (e) {
        log(`pair: wg-easy client ${String(t.clientId)} was never paired and not swept: ${why(e)}`)
      }
    }
  } catch (e) {
    log(`pair: the sweep could not read the tickets: ${why(e)}`)
  }
  if (gone > 0) log(`pair: swept ${String(gone)} ticket(s) nobody redeemed`)
  return gone
}

// ── Add ────────────────────────────────────────────────────────────────────

/** What Add answers: the link and its QR code — the only time either exists. */
export type PairOffer = { link: string; svg: string; expiresAt: string }

/**
 * "Add a phone or tablet": a confined wg-easy client, a single-use ticket and
 * the pair link. On a failure the client is deleted again and nothing is kept.
 */
export async function addPhone(
  deps: PairDeps,
  input: { actor: string },
): Promise<Outcome<PairOffer>> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.info(l))
  if (!isIpv4(deps.lanIp)) return { ok: false, reason: 'The box’s LAN address is not known here.' }
  if (deps.hostAlias === '') return { ok: false, reason: 'WG_EASY_HOST_ALIAS is not set.' }
  if (deps.appHostname === null || deps.appHostname === '') {
    return { ok: false, reason: 'The control plane’s hostname is not known here.' }
  }
  let port: number
  try {
    port = (await controllerOf(deps)).port
  } catch (e) {
    return { ok: false, reason: `The controller could not be asked: ${why(e)}` }
  }

  await sweepTickets(deps)

  let clientId: number | null = null
  try {
    if (await ensureFirewall(deps.wg)) log("pair: wg-easy's per-client firewall turned on")
    const made = await confinedClient(deps.wg, {
      name: UNPAIRED_CLIENT,
      lanIp: deps.lanIp,
      // The header says why these two and no others.
      firewallIps: [`${deps.hostAlias}:${String(port)}/tcp`, `${deps.lanIp}:443/tcp`],
      onCreated: (c) => {
        clientId = c
      },
    })
    const code = token()
    const expiresAt = new Date(now() + PAIR_TICKET_MS)
    await deps.store.putTicket({
      ticketHash: codeHash(code),
      clientId: made.clientId,
      address: made.config.address,
      createdBy: input.actor,
      expiresAt,
    })
    const link = pairLink({
      v: 1,
      app: `https://${deps.appHostname}`,
      box: deps.boxHostname,
      code,
      wireguard: made.config,
    })
    log(
      `pair: a ticket made by ${input.actor}; wg-easy client ${String(made.clientId)} at ${made.config.address}`,
    )
    return { ok: true, value: { link, svg: pairQrSvg(link), expiresAt: expiresAt.toISOString() } }
  } catch (e) {
    const reason = `The code could not be made: ${why(e)}.`
    if (clientId === null) return { ok: false, reason: `${reason} Nothing was changed.` }
    const made: number = clientId
    try {
      await deps.wg.deleteClient(made)
      log(`pair: no ticket made, undone: ${why(e)}`)
      return { ok: false, reason: `${reason} Nothing was changed.` }
    } catch (left) {
      log(
        `pair: no ticket made: ${why(e)}; NOT undone: wg-easy client ${String(made)} (${why(left)})`,
      )
      return {
        ok: false,
        reason: `${reason} Undoing it left wg-easy client ${String(made)} behind.`,
      }
    }
  }
}

// ── the redeem ─────────────────────────────────────────────────────────────

/** What the pair route answers on success (ios/docs/api.md "Pairing"). */
export type PairRedeemed = {
  /** The node id the box approved: this device's, or the app stops. */
  node: string
  controller: { pin: string; address: string }
  box: { hostname: string }
  /** `dnode_…`: the only time it exists. */
  token: string
}

export type PairAnswer = { status: number; body: PairRedeemed | { error: string } }

export type PairBody = {
  publicKey: string
  hostname: string
  os: LightOs
  arch: string
  version: string
  model: string
}

const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/
const KEY_RE = /^[0-9a-f]{64}$/
const ARCH_RE = /^[a-z0-9_]{1,16}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/
const MODEL_MAX = 64
const FIELDS = ['code', 'public_key', 'hostname', 'os', 'arch', 'version', 'model']

/** One printable line of 1 to `max` characters. */
const line = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim() !== '' && v.length <= max && !hasControlChar(v)

/** The body's `code`, when it is shaped like one this app hands out. */
export function pairCode(v: unknown): string | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const code = (v as Record<string, unknown>).code
  return typeof code === 'string' && CODE_RE.test(code) ? code : null
}

/** Everything but the code, checked: the seven fields and nothing else. */
export function pairBody(v: unknown): Outcome<PairBody> {
  const bad = (reason: string) => ({ ok: false as const, reason })
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return bad('the body is not a JSON object')
  }
  const o = v as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => !FIELDS.includes(k))
  if (extra.length > 0) return bad(`unknown fields: ${extra.join(', ')}`)
  if (typeof o.public_key !== 'string' || !KEY_RE.test(o.public_key)) {
    return bad('public_key is not 64 lowercase hex characters')
  }
  if (!line(o.hostname, MAX_HOSTNAME)) return bad('hostname is not a name')
  if (!isLightOs(typeof o.os === 'string' ? o.os : null)) return bad('os is not ios or ipados')
  if (typeof o.arch !== 'string' || !ARCH_RE.test(o.arch)) return bad('arch is not an architecture')
  if (typeof o.version !== 'string' || !VERSION_RE.test(o.version)) {
    return bad('version is not a version')
  }
  if (!line(o.model, MODEL_MAX)) return bad('model is not a device model')
  return {
    ok: true,
    value: {
      publicKey: o.public_key,
      hostname: o.hostname.trim(),
      os: o.os as LightOs,
      arch: o.arch,
      version: o.version,
      model: o.model.trim(),
    },
  }
}

/**
 * A device redeems its ticket. The ticket is spent before anything else is
 * checked, so a second try with it finds nothing; from there every refusal
 * deletes the ticket's client, and one after the approval undoes that too.
 */
export async function redeemPair(deps: PairDeps, body: unknown): Promise<PairAnswer> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((l: string) => console.info(l))
  const refuse = (status: number, error: string): PairAnswer => ({ status, body: { error } })

  const code = pairCode(body)
  if (code === null) return refuse(400, 'code is not one this app hands out')
  const hash = codeHash(code)
  const ticket = await deps.store.takeTicket(hash, new Date(now()))
  if (ticket === null) return refuse(400, 'this code is unknown or was used; add the device again')

  /** The ticket is dead: its client and its row go. What could not be deleted, named. */
  const drop = async (): Promise<string[]> => {
    const left: string[] = []
    await deps.wg.deleteClient(ticket.clientId).catch((e: unknown) => {
      left.push(`wg-easy client ${String(ticket.clientId)} (${why(e)})`)
    })
    // With its client still there the row stays, for the sweep to finish.
    if (left.length === 0) await deps.store.deleteTicket(hash).catch(() => undefined)
    return left
  }
  const end = async (status: number, error: string): Promise<PairAnswer> => {
    const left = await drop()
    if (left.length > 0) log(`pair: refused (${error}); NOT undone: ${left.join(', ')}`)
    return refuse(status, error)
  }

  if (ticket.expiresAt.getTime() <= now())
    return end(400, 'this code expired; add the device again')
  const b = pairBody(body)
  if (!b.ok) return end(400, b.reason)
  const d = b.value
  const id = nodeIdOf(d.publicKey)

  const known = await deps.store.osOf(id)
  if (known !== null && !isLightOs(known)) {
    log(`pair: a ticket by ${ticket.createdBy} named ${id}, a ${known} machine; refused`)
    return end(409, 'this key belongs to a machine that is not a phone or tablet')
  }

  let controller: { pin: string; port: number }
  try {
    controller = await controllerOf(deps)
  } catch (e) {
    return end(502, `the controller could not be asked: ${why(e)}`)
  }

  let prior: NodeStanding | null
  try {
    prior = await deps.store.approve({
      id,
      publicKey: d.publicKey,
      hostname: d.hostname,
      os: d.os,
      arch: d.arch,
      agentVersion: d.version,
      by: ticket.createdBy,
    })
  } catch (e) {
    return end(502, `the device could not be approved: ${why(e)}`)
  }

  let old: Tunnel | null = null
  let mapped = false
  const undo = async (status: number, reason: string): Promise<PairAnswer> => {
    const left: string[] = []
    if (mapped) {
      await (old === null ? deps.store.deleteTunnel(id) : deps.store.setTunnel(id, old)).catch(
        (e: unknown) => left.push(`the tunnel's record (${why(e)})`),
      )
    }
    await deps.store.restore(id, prior).catch((e: unknown) => left.push(`the node (${why(e)})`))
    const s = await deps.sync()
    if (s.error !== null) left.push(`the controller's set (${s.error})`)
    left.push(...(await drop()))
    log(
      `pair: ${id} not paired, undone: ${reason}${left.length > 0 ? `; NOT undone: ${left.join(', ')}` : ''}`,
    )
    return refuse(status, `${reason}; add the device again`)
  }

  // The controller first, as a log-in does: the key is approved before the
  // device's first connection through its tunnel.
  const s = await deps.sync()
  if (s.error !== null) return undo(502, `the controller did not take the approval: ${s.error}`)
  if (!s.sent.some((n) => n.id === id && n.state === 'approved')) {
    return undo(502, 'the controller’s set did not carry this device')
  }

  let minted: string
  try {
    await deps.store.setFacts(id, {
      hostname: d.hostname,
      os: d.os,
      arch: d.arch,
      version: d.version,
      device: {
        model: d.model,
        osVersion: null,
        appVersion: d.version,
        battery: null,
        storage: null,
        memoryBytes: null,
        accessories: [],
        at: new Date(now()).toISOString(),
      },
    })
    old = await deps.store.tunnelOf(id)
    mapped = true
    await deps.store.setTunnel(id, { clientId: ticket.clientId, address: ticket.address })
    // Last of what can fail: a token minted is a token to undo.
    minted = await deps.mintToken(id)
  } catch (e) {
    return undo(502, `the pairing could not be recorded: ${why(e)}`)
  }

  await deps.store.deleteTicket(hash).catch(() => undefined)
  // Recognisable in wg-easy's UI from here on; the tunnel works either way.
  await deps.wg
    .getClient(ticket.clientId)
    .then((c) => deps.wg.updateClient(ticket.clientId, { ...c, name: clientName(d.hostname) }))
    .catch((e: unknown) =>
      log(`pair: wg-easy client ${String(ticket.clientId)} not renamed: ${why(e)}`),
    )
  // The client an earlier pairing of this device left.
  if (old !== null && old.clientId !== ticket.clientId) {
    const stale = old.clientId
    await deps.wg.deleteClient(stale).catch((e: unknown) => {
      log(`pair: ${id}'s earlier wg-easy client ${String(stale)} not deleted: ${why(e)}`)
    })
  }
  log(
    `pair: ${id} (${d.hostname}, ${d.model}) paired under ${ticket.createdBy}'s ticket; wg-easy client ${String(ticket.clientId)} at ${ticket.address}`,
  )
  return {
    status: 200,
    body: {
      node: id,
      controller: {
        pin: controller.pin,
        address: `${deps.lanIp}:${String(controller.port)}`,
      },
      box: { hostname: deps.boxHostname },
      token: minted,
    },
  }
}
