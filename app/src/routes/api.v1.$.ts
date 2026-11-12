import { createFileRoute } from '@tanstack/react-router'

// The native app's API, `/api/v1/*` (host/api/v1/handle.ts; the contract is
// ios/docs/api.md). One splat route: the paths, their auth and their answers
// are one table there, not a file each here.
//
// OUTSIDE the sign-in (EXEMPT_PREFIXES in core/request-gate.ts): the caller is
// an app with no browser session. Every request carries a node's token, which
// the handler checks before anything else.
export const Route = createFileRoute('/api/v1/$')({
  server: {
    handlers: {
      GET: async ({ request }) => (await import('../host/api/v1/handle')).handleApiV1(request),
      POST: async ({ request }) => (await import('../host/api/v1/handle')).handleApiV1(request),
    },
  },
})
