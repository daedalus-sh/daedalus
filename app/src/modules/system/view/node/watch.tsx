import { Ago } from '../../../../components/ago'
import { Board, Chip, Facts } from '../../../../components/viz'
import type { NodeAccessory } from '../../../../lib/dashboard/node-system'
import { bytes, DASH, num, pct } from '../../../../lib/format'
import type { Tone } from '../../../../lib/tone'
import { ReleaseRow } from './macos-boards'
import { CAPTION, EMPTY, FOOT, LIST, MONO, NOTE } from './shared'

/* ── Watch ────────────────────────────────────────────────────────────── */

const SYSTEM = 'watchOS'

/** What the board is called: the name its owner gave the watch, else what it is. */
const watchName = (a: NodeAccessory): string => a.name ?? 'Apple Watch'

function verdictOf(a: NodeAccessory): { tone: Tone; label: string } {
  const m = a.releases
  if (m === null || m.error !== null) return { tone: 'muted', label: 'not checked' }
  if (m.behind === 0) return { tone: 'ok', label: 'newest' }
  return { tone: m.behind >= 3 ? 'bad' : 'warn', label: `${num(m.behind)} behind` }
}

/**
 * A phone's watch, on the phone's Device tab. A watch is no machine of the
 * box: it holds no key and no link, its watchOS app hands its facts to the
 * iPhone app, and the phone reports them inside its own sample
 * (lib/agent/light.ts). So everything here is as old as the watch's last
 * word to its phone, and the board says how old.
 */
export function WatchBoard({ a, phone }: { a: NodeAccessory; phone: string }) {
  const verdict = verdictOf(a)
  const { battery, storage } = a
  return (
    <Board
      title={watchName(a)}
      icon="◔"
      span={4}
      aside={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
    >
      <Facts
        rows={[
          { k: 'Model', v: a.model === null ? DASH : <span className={MONO}>{a.model}</span> },
          {
            k: SYSTEM,
            v: a.osVersion === null ? DASH : <span className={MONO}>{a.osVersion}</span>,
          },
          {
            k: 'Build',
            v: <span className={MONO}>{a.osBuild ?? a.releases?.current.build ?? DASH}</span>,
          },
          {
            k: 'Battery',
            v:
              battery === null || battery.percent === null ? (
                DASH
              ) : (
                <>
                  {pct(battery.percent, 0)}
                  {battery.charging !== null && (
                    <span className={NOTE}>
                      {' · '}
                      {battery.charging ? 'charging' : 'on battery'}
                    </span>
                  )}
                </>
              ),
          },
          {
            k: 'Storage',
            v:
              storage === null || storage.totalBytes === null ? (
                DASH
              ) : (
                <>
                  {storage.freeBytes === null ? '' : `${bytes(storage.freeBytes)} free of `}
                  {bytes(storage.totalBytes)}
                </>
              ),
          },
        ]}
      />
      <p className={CAPTION}>
        As its {phone} last reported, <Ago at={a.at} />.
      </p>
      <p className={FOOT}>
        A watch is not a machine of the box: it has no key and no link of its own. Its watchOS app
        tells the {phone} what it is, and the {phone} passes that on while Daedalus is open on it,
        so these are as old as the watch&rsquo;s last word to its {phone}.
      </p>
    </Board>
  )
}

/** What Apple has shipped past the watch's watchOS (lib/dashboard/ios-releases.ts). */
export function WatchReleasesBoard({ a }: { a: NodeAccessory }) {
  const m = a.releases
  const failed = m === null || m.error !== null
  const behind = m?.behind ?? 0
  const unlisted = m === null ? 0 : Math.max(0, behind - m.releases.length)
  return (
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
            newest <span className={MONO}>{m.latest ?? DASH}</span> · read <Ago at={m.checkedAt} />
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
          And {num(unlisted)} older {unlisted === 1 ? 'release' : 'releases'} between these and the
          running one, not listed.
        </p>
      )}
      <p className={FOOT}>
        Newest first, across majors, from Apple&rsquo;s release table, its version feed for the
        builds and its {SYSTEM} developer release notes. A release Apple shipped only for newer
        watches counts too: the table says which models get it, and each row links to its notes and
        its security content.
      </p>
    </Board>
  )
}
