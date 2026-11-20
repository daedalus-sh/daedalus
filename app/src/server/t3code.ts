import { asValidator, bool, is, obj, withMessage } from '../lib/contract/decode'
import { adminFn, readFn } from './fn'

// The server functions behind System › T3 Code: the Restart
// (host/t3code.ts) and the switch on each project (core/site/hidden-projects.ts).
// Update is the shared version-update pair in server/versions.ts.

/** What a restart would end, read now: the confirm asks as it arms. */
export const fetchT3RestartConfirmFn = readFn.handler(async ({ context }) => {
  const { readT3RestartConfirm } = await import('../host/t3code')
  return readT3RestartConfirm(await context.ctx())
})

/**
 * Restart the T3 Code server (the root helper's `t3code-restart`), which is
 * how a build a rebuild installed takes over. Every running thread and open
 * terminal ends; the page says how many threads before the click. Answers
 * once the unit has finished.
 */
export const restartT3CodeFn = adminFn.handler(async ({ context }) => {
  const { restartT3Code } = await import('../host/t3code')
  return restartT3Code(await context.ctx(), { actor: context.actor })
})

const root = is((v): v is string => typeof v === 'string' && v.startsWith('/'), 'an absolute path')

/**
 * Show or hide one project in T3 Code. A site edit: it lands on the next
 * Apply, and nothing here rebuilds.
 */
export const setT3ProjectShownFn = adminFn
  .validator(asValidator(withMessage(obj({ root, shown: bool }), 'expected { root, shown }')))
  .handler(async ({ data, context }) => {
    const { setProjectShown } = await import('../core/site/hidden-projects')
    return setProjectShown(await context.ctx(), 't3code', data.root, data.shown)
  })
