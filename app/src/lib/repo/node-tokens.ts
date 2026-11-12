import { eq } from 'drizzle-orm'
import { db } from '../../host/db'
import { nodes, nodeTokens } from '../../host/schema'

// The node API tokens' rows (host/node-tokens.ts is what they mean).

/** Store a node's token digest, replacing the one it had. */
export async function putNodeToken(nodeId: string, tokenHash: string): Promise<void> {
  await db
    .insert(nodeTokens)
    .values({ nodeId, tokenHash })
    .onConflictDoUpdate({
      target: nodeTokens.nodeId,
      set: { tokenHash, createdAt: new Date(), lastUsedAt: null },
    })
}

/** The token row with this digest, joined to the node that holds it. */
export async function findNodeToken(tokenHash: string): Promise<
  | {
      tokenHash: string
      id: string
      state: string
      hostname: string
      os: string
      displayName: string | null
    }
  | undefined
> {
  const [row] = await db
    .select({
      tokenHash: nodeTokens.tokenHash,
      id: nodes.id,
      state: nodes.state,
      hostname: nodes.hostname,
      os: nodes.os,
      policy: nodes.policy,
    })
    .from(nodeTokens)
    .innerJoin(nodes, eq(nodes.id, nodeTokens.nodeId))
    .where(eq(nodeTokens.tokenHash, tokenHash))
    .limit(1)
  if (row === undefined) return undefined
  const { policy, ...rest } = row
  return { ...rest, displayName: policy?.displayName?.trim() || null }
}

export async function setNodeTokenUsed(nodeId: string): Promise<void> {
  await db.update(nodeTokens).set({ lastUsedAt: new Date() }).where(eq(nodeTokens.nodeId, nodeId))
}

/** Delete a node's token. True when it had one. */
export async function deleteNodeToken(nodeId: string): Promise<boolean> {
  const gone = await db
    .delete(nodeTokens)
    .where(eq(nodeTokens.nodeId, nodeId))
    .returning({ id: nodeTokens.nodeId })
  return gone.length > 0
}
