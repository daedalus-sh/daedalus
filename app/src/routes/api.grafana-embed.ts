import { createFileRoute } from '@tanstack/react-router'
import { env } from '../host/env'
import { embedTarget } from '../host/grafana-embed'

// What an embedded Grafana panel's frame points at: `?to=/d-solo/…` is
// answered with a redirect to that panel on the box's Grafana, carrying a
// freshly signed sign-in token (host/grafana-embed.ts says why). Behind the
// request gate like every route, so only a signed-in admin's browser is
// handed one; never cached, since the token in the Location expires.
export const Route = createFileRoute('/api/grafana-embed')({
  server: {
    handlers: {
      GET: ({ request }) => {
        const grafanaUrl = env.get('GRAFANA_URL')
        const to = new URL(request.url).searchParams.get('to') ?? ''
        const target =
          grafanaUrl === undefined
            ? null
            : embedTarget(grafanaUrl, to, env.get('GRAFANA_EMBED_KEY'), Date.now())
        if (target === null) return new Response(null, { status: 404 })
        return new Response(null, {
          status: 302,
          headers: {
            location: target,
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          },
        })
      },
    },
  },
})
