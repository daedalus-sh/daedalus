import { describe, expect, it } from 'vitest'
import { PAIR_LINK_PREFIX, type PairPayload, pairLink, pairQrSvg, readPairLink } from './pair-link'

const PAYLOAD: PairPayload = {
  v: 1,
  app: 'https://daedalus-app.example.org',
  box: 'bóx',
  code: 'c'.repeat(43),
  wireguard: {
    private_key: 'oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=',
    address: '10.8.0.9',
    server_public_key: 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=',
    preshared_key: 'FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=',
    endpoint: 'box.example.org:51820',
    allowed_ips: ['192.168.0.2/32'],
  },
}

describe('the pair link', () => {
  it('is daedalus://pair?p= and unpadded base64url of the JSON', () => {
    const link = pairLink(PAYLOAD)
    expect(link.startsWith(PAIR_LINK_PREFIX)).toBe(true)
    const p = link.slice(PAIR_LINK_PREFIX.length)
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/)
    // What any client does: base64url → UTF-8 → JSON.
    expect(JSON.parse(Buffer.from(p, 'base64url').toString('utf8'))).toEqual(PAYLOAD)
  })

  it('reads back, non-ASCII included', () => {
    expect(readPairLink(pairLink(PAYLOAD))).toEqual(PAYLOAD)
  })

  it('reads nothing else', () => {
    expect(readPairLink('https://example.org')).toBeNull()
    expect(readPairLink(`${PAIR_LINK_PREFIX}!!!`)).toBeNull()
    expect(readPairLink(pairLink({ ...PAYLOAD, v: 2 as 1 }))).toBeNull()
    expect(
      readPairLink(`${PAIR_LINK_PREFIX}${Buffer.from('{"v":1}').toString('base64url')}`),
    ).toBeNull()
  })

  it('draws black on white with a quiet zone, whatever the theme', () => {
    const svg = pairQrSvg(pairLink(PAYLOAD))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('white')
    expect(svg).toContain('black')
  })
})
