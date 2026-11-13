import type { Ctx } from '../../core/ctx'
import { readNode } from '../../host/controller/nodes'
import { accessoryOf, phoneIdOf, watchOf } from '../agent/accessory'
import { deviceFactsFrom } from '../agent/light'
import { getNode, type NodeRow } from '../repo/nodes'
import { type NodeAccessory, watchReleases } from './node-system'

// The System page for a phone's watch (lib/agent/accessory.ts): a machine to
// look at, and nothing the box reaches. Everything here is read from its
// PHONE — the phone's row for whether there is a watch at all and what it is
// called, the phone's live sample over that for the facts — so the page is as
// old as the watch's last word to its phone.

export type AccessorySystemData = {
  /** `<phone id>.watch`. */
  id: string
  /** What the pages call it. */
  name: string
  /** The watch's facts, with Apple's watchOS list when asked for. */
  accessory: NodeAccessory
  /** The phone that reports it. */
  phone: NodeRow
  /** The facts are from the sample the controller holds now, not from what the row kept. */
  live: boolean
}

/** One watch by its id; null when its phone is gone, not approved, or reports no watch. */
export async function loadAccessorySystem(
  ctx: Pick<Ctx, 'controller'>,
  id: string,
  opts: { releases?: boolean } = {},
): Promise<AccessorySystemData | null> {
  const phoneId = phoneIdOf(id)
  if (phoneId === null) return null
  const read = await readNode(ctx, phoneId, true)
  const phone = await getNode(phoneId, read)
  if (phone === null) return null
  const d = read.detail
  const now = d === null ? null : deviceFactsFrom(d, phone.device, new Date().toISOString())
  const fresh = d?.telemetry == null ? null : watchOf(now)
  const a = accessoryOf(phone, fresh)
  if (a === null) return null
  return {
    id: a.id,
    name: a.name,
    accessory: {
      ...a.facts,
      releases: opts.releases === true ? await watchReleases(a.facts) : null,
    },
    phone,
    live: fresh !== null,
  }
}
