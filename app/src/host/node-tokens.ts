import { createHash, randomBytes } from 'node:crypto'
import {
  deleteNodeToken,
  findNodeToken,
  putNodeToken,
  setNodeTokenUsed,
} from '../lib/repo/node-tokens'
import { safeEqual } from './github-app-crypto'

// The credential a phone or tablet presents to /api/v1 (host/api/v1/): the
// native app's door, beside the MCP tokens' and sharing nothing with them.
//
// `dnode_` plus 32 random bytes, base64url, stored as its SHA-256 and looked
// up by that digest, then confirmed in constant time (host/mcp/tokens.ts says
// why a plain digest is enough for a value nobody chose). One per node: a
// pairing replaces it, and a revoke, a forget or the node's own leave deletes
// it (core/nodes.ts), so a removed phone has nothing left to present.
//
// A token is only as good as its node: the row must be `approved`, read on
// every call. Unknown, malformed, and a token whose node was revoked all
// answer the same null.

export const NODE_TOKEN_PREFIX = 'dnode_'

const BYTES = 32

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Who a node token proved to be. */
export type NodeIdentity = {
  id: string
  /** The policy's display name, or the hostname. */
  name: string
  os: string
  /** The node row's state when the token was checked: only an approved node is identified. */
  state: 'approved'
}

/** A new token for the node, replacing the one it had. The only moment the value exists. */
export async function mintNodeToken(nodeId: string): Promise<string> {
  const token = NODE_TOKEN_PREFIX + randomBytes(BYTES).toString('base64url')
  await putNodeToken(nodeId, hash(token))
  return token
}

/** Delete the node's token. True when it had one. */
export const revokeNodeToken = (nodeId: string): Promise<boolean> => deleteNodeToken(nodeId)

/** The approved node behind a presented token, or null — for every failure alike. */
export async function identifyNodeToken(presented: string | null): Promise<NodeIdentity | null> {
  const token = presented?.trim() ?? ''
  if (!token.startsWith(NODE_TOKEN_PREFIX)) return null
  const digest = hash(token)
  const row = await findNodeToken(digest)
  if (row === undefined) return null
  if (!safeEqual(row.tokenHash, digest)) return null
  if (row.state !== 'approved') return null
  return { id: row.id, name: row.displayName ?? row.hostname, os: row.os, state: 'approved' }
}

/** Record that a token was used. Best effort: a failed stamp never fails a call. */
export async function stampNodeTokenUse(nodeId: string): Promise<void> {
  try {
    await setNodeTokenUsed(nodeId)
  } catch (err) {
    console.warn('[api] could not stamp token use:', err instanceof Error ? err.message : err)
  }
}
