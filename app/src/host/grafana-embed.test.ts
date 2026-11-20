import { generateKeyPairSync, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { embedTarget, embedToken } from './grafana-embed'

const pair = generateKeyPairSync('ed25519')
const key = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
const NOW = 1_800_000_000_000
const GRAFANA = 'https://grafana.example.test'

describe('embedToken', () => {
  it('signs the claims Grafana expects, for an hour', () => {
    const [head, body, sig] = embedToken(key, NOW).split('.')
    expect(JSON.parse(Buffer.from(String(head), 'base64url').toString())).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
    })
    expect(JSON.parse(Buffer.from(String(body), 'base64url').toString())).toEqual({
      iss: 'daedalus',
      aud: 'grafana-embed',
      sub: 'daedalus-embed',
      iat: 1_800_000_000,
      exp: 1_800_003_600,
    })
    expect(
      verify(
        null,
        Buffer.from(`${String(head)}.${String(body)}`),
        pair.publicKey,
        Buffer.from(String(sig), 'base64url'),
      ),
    ).toBe(true)
  })
})

describe('embedTarget', () => {
  it('sends a panel to Grafana with a token, keeping its query', () => {
    const url = new URL(
      String(embedTarget(GRAFANA, '/d-solo/container-logs/x?panelId=1&from=now-7d', key, NOW)),
    )
    expect(url.origin).toBe(GRAFANA)
    expect(url.pathname).toBe('/d-solo/container-logs/x')
    expect(url.searchParams.get('panelId')).toBe('1')
    expect(url.searchParams.get('from')).toBe('now-7d')
    expect(url.searchParams.get('auth_token')).toBe(embedToken(key, NOW))
  })

  it('carries no token without a key, and never the caller’s own', () => {
    const url = new URL(String(embedTarget(GRAFANA, '/d-solo/a/b?auth_token=mine', undefined, NOW)))
    expect(url.searchParams.has('auth_token')).toBe(false)
  })

  it('refuses anything but a single panel on the box’s Grafana', () => {
    for (const to of [
      '/d/container-logs/x',
      '/api/admin/users',
      '//evil.example/d-solo/a/b',
      'https://evil.example/d-solo/a/b',
      '/d-solo/../api/admin/users',
      '',
    ]) {
      expect(embedTarget(GRAFANA, to, key, NOW)).toBeNull()
    }
  })
})
