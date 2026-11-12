import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { addPhoneFn } from '../../../server/nodes'
import { Until } from '../../ago'
import { Button } from '../../ui/button'
import { useAction } from '../../use-action'
import { ASIDE, Band, ERROR_NOTE, NOTE_SHOWN } from '../shared'

// How a phone or tablet joins: no line to run, a code to scan. The box makes
// it a tunnel and a ticket that works once (host/pair.ts) and answers with
// the two as a QR code; the app on the device scans it, and the device is in
// the table above, approved, without a decision here.
//
// The code is a secret, shown once. It lives in this component's state and
// nowhere else — not the URL, not a cache, not storage — and it is dropped on
// Done and when its five minutes are up, whichever comes first. The table is
// read again at both, which is when the new device shows.

type Offer = { svg: string; expiresAt: string }

/** The ticket's life when its own stamp does not parse. */
const LIFE_MS = 5 * 60_000

// A fixed square, so the row is the same height whatever the code holds. The
// SVG draws its own white ground and quiet zone, which is what keeps it
// scannable on either theme; the box only rounds it.
const QR = 'size-52 flex-none overflow-hidden rounded-xl [&>svg]:block [&>svg]:size-full'

export function AddPhone({ canPair }: { canPair: boolean }) {
  const router = useRouter()
  const { run, busy, error } = useAction()
  const [offer, setOffer] = useState<Offer | null>(null)
  const [ranOut, setRanOut] = useState(false)

  // The code dies with its ticket.
  useEffect(() => {
    if (offer === null) return
    const left = Date.parse(offer.expiresAt) - Date.now()
    const timer = setTimeout(
      () => {
        setOffer(null)
        setRanOut(true)
        void router.invalidate()
      },
      Number.isFinite(left) ? Math.max(0, left) : LIFE_MS,
    )
    return () => clearTimeout(timer)
  }, [offer, router])

  const add = () => {
    setRanOut(false)
    run(() => addPhoneFn(), {
      // Nothing in the table changed yet: the device is not there until it scans.
      invalidate: false,
      onDone: (r) => setOffer({ svg: r.value.svg, expiresAt: r.value.expiresAt }),
    })
  }
  const done = () => {
    setOffer(null)
    void router.invalidate()
  }

  if (offer !== null) {
    return (
      <Band>
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <div
            role="img"
            aria-label="Pairing code"
            className={QR}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the QR code this box's own server drew (lib/pair-link.ts), not user input
            dangerouslySetInnerHTML={{ __html: offer.svg }}
          />
          <div className="flex min-w-0 flex-1 basis-56 flex-col items-start gap-2">
            <p className={NOTE_SHOWN}>
              Open Daedalus on the iPhone or iPad and scan this. It works once, for 5 minutes.
            </p>
            <p className={`${ASIDE} m-0 tabular-nums`}>
              expires in <Until at={offer.expiresAt} />
            </p>
            <Button size="sm" onClick={done}>
              Done
            </Button>
          </div>
        </div>
      </Band>
    )
  }
  return (
    <Band>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button size="sm" variant="outline" disabled={busy || !canPair} onClick={add}>
          Add a phone or tablet
        </Button>
        {!canPair && <span className={ASIDE}>This box cannot make tunnels yet.</span>}
      </div>
      {ranOut && <p className={NOTE_SHOWN}>The code ran out. Add again for a new one.</p>}
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </Band>
  )
}
