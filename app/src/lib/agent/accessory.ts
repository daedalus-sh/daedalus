import type { NodePolicy, NodeState } from '../../host/schema'
import type { DeviceAccessory, DeviceFacts } from './light'
import { hasControlChar } from './policy'

// A phone's watch, shown as a machine of its own.
//
// Technically it stays what lib/agent/light.ts says it is: no key, no link,
// no row — facts its iPhone reports inside its own sample, kept in the
// phone's row. So nothing that acts on machines (the desired set, the
// providers, the DHCP lines, site/nodes.json) ever lists it: none of the
// readers of the nodes table return it. It becomes a machine only where one
// is DRAWN — the Machines table, the System picker, /api/v1's list — and each
// of those derives it here, from the phone's row it already holds.
//
// Its id is its phone's with `.watch` after it: one watch per phone
// (WatchConnectivity pairs one active watch), and when a sample lists
// several, the first is it. It exists exactly while the phone is approved
// and its kept facts list a watch, so a phone revoked or forgotten takes its
// watch with it.
//
// Pure: the pages, the routes and the tests import it.

const SUFFIX = '.watch'
const NODE_ID = /^[0-9a-f]{16}$/
const ACCESSORY_ID = /^[0-9a-f]{16}\.watch$/

/** The id of the box in a machine id (host/api/v1/views.ts `BOX`). */
const BOX = 'box'

export const accessoryIdOf = (phoneId: string): string => `${phoneId}${SUFFIX}`

export const isAccessoryId = (v: unknown): v is string =>
  typeof v === 'string' && ACCESSORY_ID.test(v)

/** The phone an accessory id names; null for anything else. */
export const phoneIdOf = (id: string): string | null =>
  ACCESSORY_ID.test(id) ? id.slice(0, -SUFFIX.length) : null

/** What a machine id names: the box, a node, or the watch of the phone `phone`. */
export type MachineRef =
  | { kind: 'box' }
  | { kind: 'node'; id: string }
  | { kind: 'accessory'; id: string; phone: string }

/** A machine id, read; null when it is none of the three forms. */
export function parseMachineId(v: unknown): MachineRef | null {
  if (typeof v !== 'string') return null
  if (v === BOX) return { kind: 'box' }
  if (NODE_ID.test(v)) return { kind: 'node', id: v }
  const phone = phoneIdOf(v)
  return phone === null ? null : { kind: 'accessory', id: v, phone }
}

/** What a watch is called when neither the box nor its owner named it. */
export const WATCH_NAME_DEFAULT = 'Apple Watch'

/** The watch in a phone's facts: the first one its sample listed, or null. */
export function watchOf(device: Pick<DeviceFacts, 'accessories'> | null): DeviceAccessory | null {
  return device?.accessories.find((a) => a.kind === 'watch') ?? null
}

/** What the pages call a watch: the name set on Settings › Machines, else the reported one, else what it is. */
export function watchNameOf(
  policy: Pick<NodePolicy, 'watchName'> | null,
  a: Pick<DeviceAccessory, 'name'>,
): string {
  return policy?.watchName?.trim() || a.name?.trim() || WATCH_NAME_DEFAULT
}

/** A watch as a machine in a list: its id and name, what its phone last said of it, and that phone. */
export type Accessory = {
  /** `<phone id>.watch`. */
  id: string
  name: string
  /** The name set on Settings › Machines; null while it goes by the reported one. */
  given: string | null
  facts: DeviceAccessory
  phone: { id: string; name: string }
}

/** The phone's row, as much of it as says whether it has a watch to show. */
type PhoneRow = {
  id: string
  name: string
  state: NodeState
  light: boolean
  policy: NodePolicy
  device: Pick<DeviceFacts, 'accessories'> | null
}

/**
 * The watch a row's phone shows as a machine, or null: only an approved phone
 * has one, and only while its kept facts list it. `facts` is a fresher
 * reading of the same watch when the caller holds one (the phone's live
 * sample); the row decides whether there is a watch at all.
 */
export function accessoryOf(n: PhoneRow, facts?: DeviceAccessory | null): Accessory | null {
  if (!n.light || n.state !== 'approved') return null
  const kept = watchOf(n.device)
  if (kept === null) return null
  const a = facts ?? kept
  return {
    id: accessoryIdOf(n.id),
    name: watchNameOf(n.policy, a),
    given: n.policy.watchName?.trim() || null,
    facts: a,
    phone: { id: n.id, name: n.name },
  }
}

const NAME_MAX = 40

/**
 * A watch's display name from the page, checked the way a machine's is
 * (lib/agent/policy-patch.ts): `id` the watch's, `name` one bounded line,
 * empty to go back to the reported name.
 */
export function accessoryNamePatch(data: unknown): { id: string; phone: string; name: string } {
  const { id, name } = (data ?? {}) as { id?: unknown; name?: unknown }
  const ref = parseMachineId(id)
  if (ref === null || ref.kind !== 'accessory') throw new Error('expected a watch’s id')
  if (typeof name !== 'string') throw new Error('name must be text')
  const clean = name.trim().replace(/\s+/g, ' ')
  if (clean.length > NAME_MAX) throw new Error(`name is longer than ${String(NAME_MAX)}`)
  if (hasControlChar(clean)) throw new Error('name has a control character')
  return { id: ref.id, phone: ref.phone, name: clean }
}
