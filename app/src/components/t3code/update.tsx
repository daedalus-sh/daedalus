import { useRouter } from '@tanstack/react-router'
import { VersionProgress } from '../../modules/gaming/view/version-progress'
import { fetchVersionUpdateStatus, requestVersionUpdateFn } from '../../server/versions'
import { Ago } from '../ago'
import { ArmedConfirm } from '../armed-confirm'
import { usePolledStatus } from '../status'
import { CAPTION, FOOT, MONO, NOTE } from '../tokens'
import { Button } from '../ui/button'
import { useArmed } from '../use-armed'
import { Board } from '../viz'
import { type Offer, type T3Facts, t3Offer } from './facts'

// Moving the pinned release. The host resolves the next release into the
// pin's six values every hour; this board says what it found and hands those
// values, untouched, to the version-update agent the game tabs use. Nothing
// here is typed by a person.

/** The fleet.versionPins id of the host's pin. */
const TARGET = 't3code'

/** Long enough to read what the update does; disarms on its own after. */
const ARM_MS = 30_000

/* This switch restarts nothing, and the verifier asks what is installed. */
const PHASES = {
  switching: 'switching to the new build',
  verifying: 'checking that the new build is the installed one',
}

export function T3UpdateBoard({ f }: { f: T3Facts }) {
  const router = useRouter()
  const offer = t3Offer(f)
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const { status, running, refusal, start } = usePolledStatus({
    initial: f.data.versionStatus,
    fetch: () => fetchVersionUpdateStatus(),
    onSettle: () => void router.invalidate(),
  })

  return (
    <Board
      title="Pinned release"
      icon="hash"
      span={12}
      aside={
        <span className={NOTE}>
          pinned <span className={MONO}>{f.data.installed ?? '?'}</span> · running{' '}
          <span className={MONO}>{f.running ?? '?'}</span>
        </span>
      }
    >
      <p className={CAPTION}>
        <Found offer={offer} />
      </p>

      {offer.kind === 'ready' &&
        (armed ? (
          <ArmedConfirm
            ms={ARM_MS}
            variant="default"
            cost={
              <>
                The pin moves to {offer.version}. The box builds that release, which takes about ten
                minutes, and switches to it. A build that fails changes nothing.{' '}
                {f.running === null
                  ? 'The running server keeps its current version until it is restarted.'
                  : `The running server stays on ${f.running} until it is restarted.`}
              </>
            }
            confirm={`Update to ${offer.version}`}
            onConfirm={() => {
              disarm()
              // The host's values as it resolved them, all six.
              const { values } = offer
              start(async () => {
                const r = await requestVersionUpdateFn({ data: { target: TARGET, values } })
                return r.ok ? { ok: true, value: r.id } : { ok: false, reason: r.reason }
              })
            }}
            onCancel={disarm}
          />
        ) : (
          <div>
            <Button type="button" size="sm" disabled={running} onClick={arm}>
              {running ? 'Updating…' : `Update to ${offer.version}`}
            </Button>
          </div>
        ))}

      <VersionProgress
        target={TARGET}
        status={status}
        running={running}
        refusal={refusal}
        phases={PHASES}
      />

      <p className={FOOT}>
        The box looks for a newer release every hour and works out the pin’s values ahead of time,
        so an update has nothing to look up. It commits the pin, builds, switches, and passes when
        the new build is the installed one. It never restarts the server: Restart, at the top of
        this page, does that.
      </p>
    </Board>
  )
}

/** What the hourly check found, in a sentence. */
function Found({ offer }: { offer: Offer }) {
  switch (offer.kind) {
    case 'unread':
      return <>The last reading carries no release check, so there is nothing to offer.</>
    case 'unchecked':
      return <>The check for a newer release has not run yet. It runs every hour.</>
    case 'current':
      return (
        <>
          The pin is on the newest release, <span className={MONO}>{offer.version}</span>.{' '}
          <Checked at={offer.checkedAt} />
        </>
      )
    case 'blocked':
      return (
        <>
          <span className={MONO}>{offer.version}</span> is out and cannot be built here yet.{' '}
          {offer.why} <Checked at={offer.checkedAt} />
        </>
      )
    case 'ready':
      return (
        <>
          <span className={MONO}>{offer.version}</span> is out, and its build is worked out and
          ready. <Checked at={offer.checkedAt} />
        </>
      )
  }
}

function Checked({ at }: { at: string | null }) {
  if (at === null) return null
  return (
    <>
      Last checked <Ago at={at} />.
    </>
  )
}
