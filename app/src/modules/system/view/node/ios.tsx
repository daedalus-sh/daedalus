import { Ago } from '../../../../components/ago'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../../../components/viz'
import { lightKind } from '../../../../lib/agent/light'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { DASH, num } from '../../../../lib/format'
import type { Tone } from '../../../../lib/tone'
import { ReleaseRow } from './macos-boards'
import { CAPTION, EMPTY, FOOT, LIST, lightOsName, MONO, NOTE } from './shared'

/* ── iOS / iPadOS ─────────────────────────────────────────────────────── */

/**
 * A phone's or tablet's own tab, as macOS is a Mac's: the system it runs and
 * what Apple has shipped since, from Apple's release table, version feed and
 * developer notes (lib/dashboard/ios-releases.ts).
 *
 * Read from what the device last said it runs, so the tab answers while the
 * device is away. Nothing here installs anything: the box asks nothing of a
 * phone.
 */
export function NodeIosView({ d }: { d: NodeSystemData }) {
  const { node } = d
  const m = d.ios
  const system = lightOsName(node.os)
  const kind = lightKind(node.os)
  const running = m?.current.version ?? d.status?.os_version ?? node.device?.osVersion ?? null

  if (m === null && running === null) {
    return (
      <p className={EMPTY}>
        {node.name} has not said which {system} it runs yet. It does the first time its app is open
        and connected to the box.
      </p>
    )
  }

  const failed = m === null || m.error !== null
  const behind = m?.behind ?? 0
  const newest = m?.releases[0] ?? null
  const verdict: { tone: Tone; label: string } = failed
    ? { tone: 'muted', label: 'not checked' }
    : behind === 0
      ? { tone: 'ok', label: 'newest' }
      : { tone: behind >= 3 ? 'bad' : 'warn', label: `${num(behind)} behind` }
  const unlisted = m === null ? 0 : Math.max(0, behind - m.releases.length)

  return (
    <BoardGrid>
      <Board
        title={`This ${kind} runs`}
        icon="⌘"
        span={4}
        aside={<Chip tone={verdict.tone}>{verdict.label}</Chip>}
      >
        <Facts
          rows={[
            { k: system, v: <span className={MONO}>{running ?? DASH}</span> },
            { k: 'Build', v: <span className={MONO}>{m?.current.build ?? DASH}</span> },
            {
              k: 'Model',
              v:
                node.device?.model == null ? (
                  DASH
                ) : (
                  <span className={MONO}>{node.device.model}</span>
                ),
            },
            { k: 'App', v: <span className={MONO}>{node.agentVersion}</span> },
            {
              k: 'Said',
              v: node.device === null ? DASH : <Ago at={node.device.at} />,
            },
          ]}
        />
        <p className={FOOT}>
          The version is what the device said the last time Daedalus was open on it, so an update
          installed since shows here only after the app is opened again.
        </p>
      </Board>

      <Board
        title="Apple ships"
        icon="⇣"
        span={8}
        aside={
          m !== null && (
            <span className={NOTE}>
              read <Ago at={m.checkedAt} />
            </span>
          )
        }
      >
        <Measures
          items={[
            { k: 'newest', v: m?.latest ?? DASH },
            {
              k: 'published',
              v: newest === null || newest.date === null ? DASH : <Ago at={newest.date} />,
            },
            { k: 'behind', v: failed ? DASH : num(behind) },
          ]}
        />
        <p className={CAPTION}>
          {m === null ? (
            `Apple’s list was not read for this page.`
          ) : m.error !== null ? (
            m.error
          ) : (
            <>
              From Apple&rsquo;s own release table, which lists every {system} by date, its version
              feed for the builds, and its developer release notes for what changed.{' '}
              {behind > 0 &&
                `Being ${num(behind)} behind is a fact, not a verdict: each release below says what it fixed.`}
            </>
          )}
        </p>
      </Board>

      <Board
        title={
          failed ? 'Since this version' : behind === 0 ? 'Nothing newer' : `${num(behind)} newer`
        }
        icon="⎌"
        span={12}
        aside={
          m !== null && (
            <span className={`${NOTE} ${MONO}`}>{m.source.replace(/^https?:\/\//, '')}</span>
          )
        }
      >
        {m === null || m.error !== null ? (
          <p className={EMPTY}>{m?.error ?? 'Not read.'}</p>
        ) : m.releases.length === 0 ? (
          <p className={EMPTY}>
            {m.current.version} is the newest {system} Apple has published; nothing waits.
          </p>
        ) : (
          <ul className={LIST}>
            {m.releases.map((r) => (
              <ReleaseRow key={r.version} r={r} label={system} major={false} bare={r.summary} />
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
          Newest first, across majors. The notes are Apple&rsquo;s developer release notes, one set
          for iOS and iPadOS, shared by a point release with its minor; the security content counts
          the vulnerabilities a release closes. Each row links to both.
        </p>
      </Board>
    </BoardGrid>
  )
}
