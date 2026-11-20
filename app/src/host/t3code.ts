import type { Ctx } from '../core/ctx'
import { readT3Code, restartConfirm } from '../lib/dashboard/t3code'
import { type RootAnswer, runRoot } from './root'

// T3 Code's restart (a host stack's `t3code-restart` root verb): the only way
// a build a rebuild installed takes over, since a switch leaves the running
// server alone. It ends every running agent turn and every terminal, so the
// page reads the status file again as the confirm arms and says how many
// threads that is.

/** The confirm's sentence, from the status file as it stands now. */
export async function readT3RestartConfirm(ctx: Pick<Ctx, 'env' | 'snapshot'>): Promise<string> {
  return restartConfirm(await readT3Code(ctx))
}

/** The helper waits 150 s for the unit (the stack's `rootVerbs`); this is that and slack. */
const RESTART_WAIT_MS = 160_000

export async function restartT3Code(
  ctx: Pick<Ctx, 'controller'>,
  input: { actor: string },
): Promise<RootAnswer> {
  console.info(`[t3code] restart asked by ${input.actor}`)
  return runRoot(ctx, 't3code-restart', {}, RESTART_WAIT_MS)
}
