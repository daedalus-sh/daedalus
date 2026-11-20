import { createPrivateKey, sign } from 'node:crypto'

// Where an embedded Grafana panel really loads from.
//
// A framed panel cannot sign in: Grafana sends it to Pocket ID, and the IdP
// refuses to be framed, so an embed only ever worked in a browser that
// happened to hold a live Grafana session. Instead Grafana takes a signed
// token in the URL (`[auth.jwt] url_login`, nix/modules/monitoring) and serves
// the panel as a Viewer. The key is minted on the box and handed to this
// container alone (GRAFANA_EMBED_KEY: Ed25519, PKCS#8 DER, base64).
//
// The token never sits in a page: a frame's `src` is this app's own
// /api/grafana-embed, which signs one per load and redirects.

/** Long enough for a panel to boot and query; a new frame load gets a new one. */
const TTL_S = 60 * 60

const b64 = (v: object): string => Buffer.from(JSON.stringify(v)).toString('base64url')

/** A token Grafana accepts for the next hour. `now` is in milliseconds. */
export function embedToken(key: string, now: number): string {
  const iat = Math.floor(now / 1000)
  const body = `${b64({ alg: 'EdDSA', typ: 'JWT' })}.${b64({
    iss: 'daedalus',
    aud: 'grafana-embed',
    sub: 'daedalus-embed',
    iat,
    exp: iat + TTL_S,
  })}`
  const pk = createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })
  return `${body}.${sign(null, Buffer.from(body), pk).toString('base64url')}`
}

/**
 * The Grafana URL a frame asking for `to` is redirected to, or null when `to`
 * is not an embed: only a single panel (`/d-solo/…`) on the box's own Grafana,
 * so the route can be handed no other destination and signs for nothing wider.
 * Without a key the URL carries no token, and Grafana's own session decides.
 */
export function embedTarget(
  grafanaUrl: string,
  to: string,
  key: string | undefined,
  now: number,
): string | null {
  if (!to.startsWith('/d-solo/')) return null
  const base = new URL(grafanaUrl)
  let url: URL
  try {
    url = new URL(to, base)
  } catch {
    return null
  }
  if (url.origin !== base.origin || !url.pathname.startsWith('/d-solo/')) return null
  url.searchParams.delete('auth_token')
  if (key !== undefined && key !== '') url.searchParams.set('auth_token', embedToken(key, now))
  return url.toString()
}
