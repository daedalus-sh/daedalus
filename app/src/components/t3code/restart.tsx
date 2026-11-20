import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { RootAnswer } from '../../host/root'
import { cn } from '../../lib/cn'
import { fetchT3RestartConfirmFn, restartT3CodeFn } from '../../server/t3code'
import { ArmedConfirm, RESTART, RESTART_ARMED } from '../armed-confirm'
import { useRootAction } from '../root-action'
import { NOTE } from '../tokens'
import { Button } from '../ui/button'
import { useArmed } from '../use-armed'

// The restart, in two places that share one state: the button in the head, and
// under the head the step that says what it ends. A restart ends every running
// thread and every terminal, so it is armed first, and the count is read again
// as it arms: the page's own reading is up to two minutes old.

/** Long enough to read the count; disarms on its own after. */
const ARM_MS = 30_000

export type T3Restart = {
  armed: boolean
  running: boolean
  answer: RootAnswer | null
  /** What the confirm says: the fresh reading once it lands, the loaded one until then. */
  cost: string
  arm: () => void
  confirm: () => void
  cancel: () => void
}

export function useT3Restart(loaded: string): T3Restart {
  const router = useRouter()
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const [fresh, setFresh] = useState<string | null>(null)
  const { running, answer, start } = useRootAction({
    // The helper refreshes the status file behind the restart.
    onSettle: () => void router.invalidate(),
  })
  return {
    armed,
    running,
    answer,
    cost: fresh ?? loaded,
    arm: () => {
      setFresh(null)
      arm()
      void fetchT3RestartConfirmFn().then(setFresh, () => undefined)
    },
    confirm: () => {
      disarm()
      start(() => restartT3CodeFn())
    },
    cancel: disarm,
  }
}

/** The head's control. `pending`: a newer build is installed, and this is what applies it. */
export function RestartButton({ r, pending }: { r: T3Restart; pending: boolean }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={pending ? 'default' : 'outline'}
      disabled={r.running || r.armed}
      onClick={r.arm}
    >
      {r.running ? 'Restarting…' : 'Restart'}
    </Button>
  )
}

/** Under the head: the cost and the confirm while armed, and a restart that did not happen. */
export function RestartStep({ r }: { r: T3Restart }) {
  if (r.armed) {
    return (
      <ArmedConfirm
        ms={ARM_MS}
        className={cn(RESTART, RESTART_ARMED, 'mb-6')}
        cost={r.cost}
        confirm="Restart now"
        onConfirm={r.confirm}
        onCancel={r.cancel}
      />
    )
  }
  if (r.answer === null || r.answer.outcome === 'done') return null
  return (
    <p className={cn(NOTE, 'm-0 mb-6 text-danger')}>
      {r.answer.detail === '' ? `The restart ${r.answer.outcome}.` : r.answer.detail}
    </p>
  )
}
