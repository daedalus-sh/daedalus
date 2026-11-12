import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The node API token: the stored value is never the token, and a token is
// only as good as its node's standing. The repository is faked; what is
// asserted is what node-tokens.ts stored and answered.

type Row = {
  tokenHash: string
  id: string
  state: string
  hostname: string
  os: string
  displayName: string | null
}

const h = vi.hoisted(() => ({
  rows: new Map<string, { tokenHash: string }>(),
  node: { state: 'approved', hostname: 'iphone', os: 'ios', displayName: null as string | null },
  used: [] as string[],
  failStamp: false,
}))

vi.mock('../lib/repo/node-tokens', () => ({
  putNodeToken: async (nodeId: string, tokenHash: string) => {
    h.rows.set(nodeId, { tokenHash })
  },
  findNodeToken: async (tokenHash: string): Promise<Row | undefined> => {
    for (const [id, r] of h.rows) if (r.tokenHash === tokenHash) return { ...r, id, ...h.node }
    return undefined
  },
  setNodeTokenUsed: async (nodeId: string) => {
    if (h.failStamp) throw new Error('the table is gone')
    h.used.push(nodeId)
  },
  deleteNodeToken: async (nodeId: string) => h.rows.delete(nodeId),
}))

const tokens = await import('./node-tokens')
const ID = '0123456789abcdef'

beforeEach(() => {
  h.rows.clear()
  h.node = { state: 'approved', hostname: 'iphone', os: 'ios', displayName: null }
  h.used = []
  h.failStamp = false
})

describe('a node token', () => {
  it('is dnode_ and 32 random bytes, stored as its SHA-256 and nothing else', async () => {
    const token = await tokens.mintNodeToken(ID)
    expect(token).toMatch(/^dnode_[A-Za-z0-9_-]{43}$/)
    expect(await tokens.mintNodeToken(ID)).not.toBe(token)
    const second = await tokens.mintNodeToken('fedcba9876543210')
    expect(h.rows.get('fedcba9876543210')?.tokenHash).toBe(
      createHash('sha256').update(second).digest('hex'),
    )
    expect(JSON.stringify([...h.rows])).not.toContain(second)
  })

  it('identifies its approved node, by the name the pages show', async () => {
    const token = await tokens.mintNodeToken(ID)
    expect(await tokens.identifyNodeToken(token)).toEqual({
      id: ID,
      name: 'iphone',
      os: 'ios',
      state: 'approved',
    })
    h.node.displayName = 'Santi’s iPhone'
    expect((await tokens.identifyNodeToken(` ${token} `))?.name).toBe('Santi’s iPhone')
  })

  it('is replaced by the next one minted for the node', async () => {
    const first = await tokens.mintNodeToken(ID)
    const second = await tokens.mintNodeToken(ID)
    expect(await tokens.identifyNodeToken(first)).toBeNull()
    expect((await tokens.identifyNodeToken(second))?.id).toBe(ID)
  })

  it('opens nothing once its node is revoked, or once it is deleted', async () => {
    const token = await tokens.mintNodeToken(ID)
    h.node.state = 'revoked'
    expect(await tokens.identifyNodeToken(token)).toBeNull()
    h.node.state = 'approved'
    expect(await tokens.revokeNodeToken(ID)).toBe(true)
    expect(await tokens.identifyNodeToken(token)).toBeNull()
    expect(await tokens.revokeNodeToken(ID)).toBe(false)
  })

  it('answers the same nothing for every other value', async () => {
    await tokens.mintNodeToken(ID)
    for (const t of [null, '', 'dnode_', `dnode_${'x'.repeat(43)}`, 'dmcp_abc', 'Bearer x']) {
      expect(await tokens.identifyNodeToken(t)).toBeNull()
    }
  })

  it('stamps its use, and a failed stamp fails nothing', async () => {
    await tokens.stampNodeTokenUse(ID)
    expect(h.used).toEqual([ID])
    h.failStamp = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await expect(tokens.stampNodeTokenUse(ID)).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
