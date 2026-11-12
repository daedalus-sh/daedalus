import { pairStore } from '../lib/repo/pair'
import { siteIdentity } from './contract/domains/site'
import { syncDesired } from './controller/nodes'
import { env } from './env'
import { mintNodeToken } from './node-tokens'
import type { PairDeps } from './pair'
import { wgEasy } from './wg-easy'

/**
 * What the pairing flows (host/pair.ts) reach on this box, read for one
 * request. Null while the box binds no wg-easy: there is no tunnel to hand a
 * device.
 */
export async function pairDeps(): Promise<PairDeps | null> {
  const wg = wgEasy()
  if (wg === null) return null
  const { makeCtx } = await import('../core/ctx')
  const ctx = await makeCtx()
  const site = (await siteIdentity()).data
  return {
    store: pairStore,
    wg,
    systemInfo: () => ctx.controller.call('system.info'),
    sync: () => syncDesired(ctx),
    mintToken: mintNodeToken,
    lanIp: site.lanIp,
    hostAlias: env.get('WG_EASY_HOST_ALIAS') ?? '',
    appHostname: site.controlPlane.hostname,
    boxHostname: site.hostname,
  }
}
