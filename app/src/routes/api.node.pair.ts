import { createFileRoute } from '@tanstack/react-router'
import { readCapped } from '../lib/read-capped'

// Where a phone or tablet redeems the ticket it scanned (host/pair.ts
// `redeemPair`): the ticket and its public key in; the controller's pin and
// address, and its API token, out.
//
// OUTSIDE the sign-in (EXEMPT in core/request-gate.ts): the caller is an app
// with no browser session. It carries its own authorization — the single-use
// ticket an admin's "Add a phone or tablet" minted minutes earlier and showed
// once, as a QR code. The first use spends it, right or wrong.

const NO_STORE = { 'cache-control': 'no-store' }

/** A redeem is seven short strings; the cap is in bytes, enforced while reading. */
const MAX_BODY_BYTES = 4096

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE })

export const Route = createFileRoute('/api/node/pair')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let bytes: Uint8Array | null
        try {
          bytes = await readCapped(request.body, MAX_BODY_BYTES)
        } catch {
          return answer(400, { error: 'the body could not be read' })
        }
        if (bytes === null) return answer(413, { error: 'the body is too large' })
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return answer(400, { error: 'the body is not JSON' })
        }
        const { redeemPair } = await import('../host/pair')
        const { pairDeps } = await import('../host/pair-deps')
        const deps = await pairDeps()
        if (deps === null) return answer(503, { error: 'this box cannot make tunnels yet' })
        try {
          const a = await redeemPair(deps, body)
          return answer(a.status, a.body)
        } catch (e) {
          // The message only: the answer being built carries a token.
          console.warn(`pair: redeem failed: ${e instanceof Error ? e.message : String(e)}`)
          return answer(500, { error: 'the device could not be paired' })
        }
      },
    },
  },
})
