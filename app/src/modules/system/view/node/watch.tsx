import { Link } from '@tanstack/react-router'
import { Ago } from '../../../../components/ago'
import { HeadStrip, OS_MARK } from '../../../../components/machine-head'
import { Board, BoardGrid, Chip, Facts } from '../../../../components/viz'
import { lightKind } from '../../../../lib/agent/light'
import type { AccessorySystemData } from '../../../../lib/dashboard/accessory-system'
import { DASH, num } from '../../../../lib/format'
import type { Tone } from '../../../../lib/tone'
import { BatteryBoard, StorageBoard } from './device'
import { ReleaseRow } from './macos-boards'
import { CAPTION, EMPTY, FOOT, LIST, MONO, NOTE } from './shared'

/* ── Watch ────────────────────────────────────────────────────────────── */

// A phone's watch as the System page's subject (lib/agent/accessory.ts). It is
// a machine here and nowhere the box acts: it holds no key and no link, its
// watchOS app hands its facts to the iPhone app, and the phone reports them
// inside its own sample. So every board is as old as the watch's last word to
// its phone, says so, and names the phone.

const SYSTEM = 'watchOS'

/** The phone's row on this page. */
function PhoneLink({ d }: { d: AccessorySystemData }) {
  return (
    <Link to="/c/$category" params={{ category: 'system' }} search={{ machine: d.phone.id }}>
      {d.phone.name}
    </Link>
  )
}

/** The strip under the picker: what the watch is, and through whom the box knows. */
export function WatchHead({ d }: { d: AccessorySystemData }) {
  const a = d.accessory
  const line = [
    'Apple Watch',
    a.model,
    a.osVersion === null ? null : `${SYSTEM} ${a.osVersion}`,
    `via ${d.phone.name}`,
  ]
    .filter((x) => x !== null && x !== '')
    .join(' · ')
  return (
    <HeadStrip
      compact
      mark={OS_MARK.watchos}
      name={d.name}
      title={line}
      aside={
        <>
          reported <Ago at={a.at} />
        </>
      }
      line={line}
    />
  )
}

export function WatchSystemView({ d, tab }: { d: AccessorySystemData; tab: string }) {
  return tab === 'ios' ? <WatchOsView d={d} /> : <WatchDeviceView d={d} />
}

/** The watch's first tab, as Device is a phone's: what it is and how it stands. */
function WatchDeviceView({ d }: { d: AccessorySystemData }) {
  const a = d.accessory
  const phone = lightKind(d.phone.os)
  return (
    <BoardGrid>
      <Board
        title="This watch"
        icon="◔"
        span={4}
        aside={
          <span className={NOTE}>
            {d.live ? 'live' : 'read'} <Ago at={a.at} />
          </span>
        }
      >
        <Facts
          rows={[
            { k: 'Model', v: a.model === null ? DASH : <span className={MONO}>{a.model}</span> },
            {
              k: SYSTEM,
              v: a.osVersion === null ? DASH : <span className={MONO}>{a.osVersion}</span>,
            },
            { k: 'Build', v: <span className={MONO}>{a.osBuild ?? DASH}</span> },
            { k: 'Calls itself', v: a.name ?? DASH },
            { k: 'Reported by', v: <PhoneLink d={d} /> },
            { k: 'Facts read', v: <Ago at={a.at} /> },
          ]}
        />
        <p className={FOOT}>
          A watch is not a machine of the box: it has no key and no link of its own. Its watchOS app
          tells the {phone} what it is, and the {phone} passes that on while Daedalus is open on it,
          so these are as old as the watch&rsquo;s last word to its {phone}. It leaves this page
          when {d.phone.name} does.
        </p>
      </Board>

      <BatteryBoard battery={a.battery}>
        As the watch last told its {phone}: the charge and whether it is charging, and nothing about
        the battery&rsquo;s health.
      </BatteryBoard>

      <StorageBoard storage={a.storage}>
        The watch&rsquo;s own volume, as watchOS counts it for an app.
      </StorageBoard>
    </BoardGrid>
  )
}

/** The watch's own tab, as iOS is a phone's: the watchOS it runs and what Apple has shipped since. */
function WatchOsView({ d }: { d: AccessorySystemData }) {
  const a = d.accessory
  const m = a.releases
  const failed = m === null || m.error !== null
  const behind = m?.behind ?? 0
  const unlisted = m === null ? 0 : Math.max(0, behind - m.releases.length)
  const verdict: { tone: Tone; label: string } = failed
    ? { tone: 'muted', label: 'not checked' }
    : behind === 0
      ? { tone: 'ok', label: 'newest' }
      : { tone: behind >= 3 ? 'bad' : 'warn', label: `${num(behind)} behind` }
  return (
    <BoardGrid>
      <Board
        title="This watch runs"
        icon="⌘"
        span={4}
        aside={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
      >
        <Facts
          rows={[
            { k: SYSTEM, v: <span className={MONO}>{a.osVersion ?? DASH}</span> },
            {
              k: 'Build',
              v: <span className={MONO}>{a.osBuild ?? m?.current.build ?? DASH}</span>,
            },
            { k: 'Model', v: a.model === null ? DASH : <span className={MONO}>{a.model}</span> },
            { k: 'Newest', v: <span className={MONO}>{m?.latest ?? DASH}</span> },
            { k: 'Said', v: <Ago at={a.at} /> },
          ]}
        />
        <p className={FOOT}>
          The version is what the watch last told <PhoneLink d={d} />, so an update installed since
          shows here only after the two have talked and Daedalus has been opened on the phone.
        </p>
      </Board>

      <Board
        title={
          failed
            ? `${SYSTEM} since this version`
            : behind === 0
              ? `No newer ${SYSTEM}`
              : `${num(behind)} newer ${SYSTEM}`
        }
        icon="⎌"
        span={8}
        aside={
          m !== null && (
            <span className={NOTE}>
              read <Ago at={m.checkedAt} />
            </span>
          )
        }
      >
        {m === null ? (
          <p className={EMPTY}>
            {a.osVersion === null
              ? `The watch has not said which ${SYSTEM} it runs.`
              : 'Apple’s list was not read for this page.'}
          </p>
        ) : m.error !== null ? (
          <p className={EMPTY}>{m.error}</p>
        ) : m.releases.length === 0 ? (
          <p className={EMPTY}>
            {m.current.version} is the newest {SYSTEM} Apple has published; nothing waits.
          </p>
        ) : (
          <ul className={LIST}>
            {m.releases.map((r) => (
              <ReleaseRow key={r.version} r={r} label={SYSTEM} major={false} bare={r.summary} />
            ))}
          </ul>
        )}
        {unlisted > 0 && (
          <p className={CAPTION}>
            And {num(unlisted)} older {unlisted === 1 ? 'release' : 'releases'} between these and
            the running one, not listed.
          </p>
        )}
        <p className={FOOT}>
          Newest first, across majors, from Apple&rsquo;s release table, its version feed for the
          builds and its {SYSTEM} developer release notes. A release Apple shipped only for newer
          watches counts too: the table says which models get it, and each row links to its notes
          and its security content.
        </p>
      </Board>
    </BoardGrid>
  )
}
