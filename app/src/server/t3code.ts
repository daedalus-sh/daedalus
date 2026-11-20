import { adminFn, readFn } from './fn'

// The server functions behind System › T3 Code's Restart (host/t3code.ts).
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
