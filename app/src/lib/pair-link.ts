import { renderSVG } from 'uqr'
import type { WireguardConfig } from '../host/controller/generated'

// The link "Add a phone or tablet" shows once, as a QR code, and the native
// app scans (ios/docs/api.md "Pairing" is the contract): the single-use
// ticket and the confined tunnel the app brings up before it redeems it.
//
// Pure: Settings › Machines and the tests import it.

/** How long a ticket works. */
export const PAIR_TICKET_MS = 5 * 60_000

/** What the link carries, version 1. */
export type PairPayload = {
  v: 1
  /** The control plane's origin, `https://<hostname>`: the SNI and Host of every call. */
  app: string
  /** The box's hostname, for the device to show. */
  box: string
  /** The single-use ticket. */
  code: string
  /** The device's tunnel. Its private key exists here and in wg-easy, nowhere else. */
  wireguard: WireguardConfig
}

export const PAIR_LINK_PREFIX = 'daedalus://pair?p='

const toBase64Url = (text: string): string => {
  let binary = ''
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (s: string): string => {
  const binary = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(binary, (c) => c.charCodeAt(0)),
  )
}

/** `daedalus://pair?p=<base64url(JSON)>`, unpadded. */
export function pairLink(payload: PairPayload): string {
  return PAIR_LINK_PREFIX + toBase64Url(JSON.stringify(payload))
}

/** The payload of a link `pairLink` made, or null: what the device's own parser does. */
export function readPairLink(link: string): PairPayload | null {
  if (!link.startsWith(PAIR_LINK_PREFIX)) return null
  try {
    const v = JSON.parse(fromBase64Url(link.slice(PAIR_LINK_PREFIX.length))) as PairPayload
    return v.v === 1 &&
      typeof v.code === 'string' &&
      typeof v.app === 'string' &&
      typeof v.box === 'string' &&
      typeof v.wireguard === 'object' &&
      v.wireguard !== null
      ? v
      : null
  } catch {
    return null
  }
}

/**
 * The link as a QR code: black on white whatever the page's theme, with a
 * four-module quiet zone, which a camera needs on a dark page.
 */
export function pairQrSvg(link: string): string {
  return renderSVG(link, { ecc: 'L', border: 4, whiteColor: 'white', blackColor: 'black' })
}
