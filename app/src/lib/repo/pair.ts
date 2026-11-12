import { and, eq, isNull, lt } from 'drizzle-orm'
import { db } from '../../host/db'
import type { PairStore, TicketRow } from '../../host/pair'
import { nodePairTickets, nodes, nodeTunnels } from '../../host/schema'
import { enrollStore } from './enroll'

// The database under a phone's pairing (host/pair.ts): the tickets, and the
// node, tunnel and token rows a redeem writes.

const ticket = (r: typeof nodePairTickets.$inferSelect): TicketRow => ({
  ticketHash: r.ticketHash,
  clientId: r.clientId,
  address: r.address,
  createdBy: r.createdBy,
  expiresAt: r.expiresAt,
})

export const pairStore: PairStore = {
  standing: enrollStore.standing,
  approve: enrollStore.approve,
  restore: enrollStore.restore,
  tunnelOf: enrollStore.tunnelOf,
  setTunnel: enrollStore.setTunnel,
  deleteTunnel: enrollStore.deleteTunnel,

  osOf: async (id) => {
    const [n] = await db.select({ os: nodes.os }).from(nodes).where(eq(nodes.id, id)).limit(1)
    return n?.os ?? null
  },

  setFacts: async (id, f) => {
    await db
      .update(nodes)
      .set({
        hostname: f.hostname,
        os: f.os,
        arch: f.arch,
        agentVersion: f.version,
        device: f.device,
      })
      .where(eq(nodes.id, id))
  },

  putTicket: async (row) => {
    await db.insert(nodePairTickets).values(row)
  },

  takeTicket: async (hash, at) => {
    const [row] = await db
      .update(nodePairTickets)
      .set({ spentAt: at })
      .where(and(eq(nodePairTickets.ticketHash, hash), isNull(nodePairTickets.spentAt)))
      .returning()
    return row === undefined ? null : ticket(row)
  },

  deleteTicket: async (hash) => {
    await db.delete(nodePairTickets).where(eq(nodePairTickets.ticketHash, hash))
  },

  ticketsBefore: async (before) =>
    (await db.select().from(nodePairTickets).where(lt(nodePairTickets.expiresAt, before))).map(
      ticket,
    ),

  clientBound: async (clientId) => {
    const [t] = await db
      .select({ id: nodeTunnels.nodeId })
      .from(nodeTunnels)
      .where(eq(nodeTunnels.clientId, clientId))
      .limit(1)
    return t !== undefined
  },
}
