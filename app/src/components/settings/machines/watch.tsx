import { Link } from '@tanstack/react-router'
import { useState } from 'react'

import { type Accessory, WATCH_NAME_DEFAULT } from '../../../lib/agent/accessory'
import { cn } from '../../../lib/cn'
import { bytes, pct } from '../../../lib/format'
import { saveAccessoryNameFn } from '../../../server/nodes'
import { Ago } from '../../ago'
import { TABLE_ROW } from '../../table'
import { Input } from '../../ui/input'
import { useAction } from '../../use-action'
import { ASIDE, Band, CONTROL_H, ERROR_NOTE, HINT, Mono, NOTE_SHOWN, Rows, Stack } from '../shared'
import { type Fact, Facts, OPEN, Summary } from './machine-section'
import { blurOnEnter } from './policy-rows'

// A phone's watch in the Machines table (lib/agent/accessory.ts): a row of its
// own, directly under its phone, and a story of its own when opened. It is a
// machine to look at only — no key, no link, no policy — so the row says who
// reports it and when, in the muted ink a phone's "last seen" wears, and the
// one thing the box holds about it is what the pages call it.

/** Where a machine's row is on this page. */
const rowOf = (id: string) => ({ to: '/settings', search: { tab: 'machines', node: id } }) as const

/** "Watch7,5 · watchOS 26.1": the line under the name. */
const subOf = (w: Accessory): string =>
  [w.facts.model, w.facts.osVersion === null ? null : `watchOS ${w.facts.osVersion}`]
    .filter((x) => x !== null && x !== '')
    .join(' · ') || WATCH_NAME_DEFAULT

function factsOf(w: Accessory): Fact[] {
  const { model, osVersion, osBuild, battery, storage, at } = w.facts
  const none = <span className={ASIDE}>—</span>
  return [
    { k: 'Apple Watch', v: model === null ? none : <Mono>{model}</Mono> },
    {
      k: 'watchOS',
      v:
        osVersion === null ? (
          none
        ) : (
          <Mono>
            {osVersion}
            {osBuild !== null && ` (${osBuild})`}
          </Mono>
        ),
    },
    {
      k: 'Battery',
      v:
        battery === null || battery.percent === null ? (
          none
        ) : (
          <span className="tabular-nums">
            {pct(battery.percent)}
            {battery.charging === true && <span className={ASIDE}> · charging</span>}
          </span>
        ),
    },
    {
      k: 'Storage',
      v:
        storage === null || storage.totalBytes === null ? (
          none
        ) : (
          <span className="tabular-nums">
            {storage.freeBytes === null ? '' : `${bytes(storage.freeBytes)} free of `}
            {bytes(storage.totalBytes)}
          </span>
        ),
    },
    {
      k: 'Reported by',
      v: (
        <Link {...rowOf(w.phone.id)} replace resetScroll={false}>
          {w.phone.name}
        </Link>
      ),
    },
    {
      k: 'Last reported',
      v: (
        <span className={ASIDE}>
          <Ago at={at} />
        </span>
      ),
    },
  ]
}

/** The name field: typed, saved on blur or Enter, like a machine's display name. */
function WatchName({ w }: { w: Accessory }) {
  const { run, busy, error } = useAction()
  const reported = w.facts.name?.trim() || WATCH_NAME_DEFAULT
  const set = w.given ?? ''
  const [name, setName] = useState(set)
  const save = () => {
    const trimmed = name.trim()
    if (trimmed === set) return
    run(() => saveAccessoryNameFn({ data: { id: w.id, name: trimmed } }))
  }
  return (
    <>
      <Rows
        framed
        rows={[
          {
            k: 'Display name',
            v: (
              <Stack className="w-full max-w-[36rem]">
                <Input
                  className={cn(CONTROL_H, 'w-[15rem] max-w-full')}
                  value={name}
                  placeholder={reported}
                  maxLength={40}
                  disabled={busy}
                  aria-label="Display name"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={save}
                  onKeyDown={blurOnEnter}
                />
                <span className={HINT}>
                  What the pages call it; empty means the name the watch reports. It is kept with
                  its iPhone and sent to no machine.
                </span>
              </Stack>
            ),
          },
        ]}
      />
      {error !== null && (
        <Band>
          <p className={ERROR_NOTE}>{error}</p>
        </Band>
      )}
    </>
  )
}

/** One watch: the row, and — open — its facts, its name and who reports it. */
export function WatchRow({ w, open }: { w: Accessory; open: boolean }) {
  return (
    <li className={cn(TABLE_ROW, 'block min-h-0 py-0', open && OPEN)}>
      <Summary
        id={w.id}
        open={open}
        toggles
        name={w.name}
        sub={subOf(w)}
        os="watchos"
        status={
          <span className="text-[0.78rem] text-muted-foreground">
            via {w.phone.name} · reported <Ago at={w.facts.at} />
          </span>
        }
        address={null}
        agent={null}
      />
      {open && (
        <div className="cursor-auto">
          <Facts facts={factsOf(w)} />
          <WatchName w={w} />
          <Band>
            <p className={NOTE_SHOWN}>
              Reported by {w.phone.name}: a watch holds no key and no link of its own, so the box
              asks nothing of it and there is nothing here to revoke. It leaves this list with{' '}
              {w.phone.name}, or when {w.phone.name} stops reporting a watch.
            </p>
          </Band>
        </div>
      )}
    </li>
  )
}
