// The T3 Code tab: the coding-agent server a host stack runs over the box's
// workspaces — its threads, its projects, and who holds a session on it.
//
// One file per board: threads, devices, projects; facts.ts holds the pure
// derivations. Everything is read from one status file the host writes every
// two minutes, so the page works with the server down, and says so: the head
// and the logs never depend on the reading.
//
// Types only from lib/dashboard/t3code (it is server-only).
import type { T3CodeData } from '../../lib/dashboard/t3code'
import { DASH, num } from '../../lib/format'
import { Ago } from '../ago'
import { LogBoard } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead } from '../service-head'
import { CAPTION, EMPTY, FOOT, MONO, NOTE } from '../tokens'
import { Button } from '../ui/button'
import { BoardGrid, Stat, StatStrip } from '../viz'
import { DevicesBoard } from './devices'
import { GAP_SUB, isBot, type T3Facts, t3Facts, t3Verdict, type Verdict } from './facts'
import { ProjectsBoard } from './projects'
import { ThreadsBoard } from './threads'

export function T3CodeView({ data }: { data: T3CodeData }) {
  const f = t3Facts(data)
  const verdict = t3Verdict(f)
  return (
    <>
      <T3Head f={f} verdict={verdict} />
      <ReadingNotice f={f} />
      <T3Stats f={f} />

      <div className="flex flex-col gap-10">
        <ThreadsBoard f={f} />
        <DevicesBoard f={f} />
        <BoardGrid>
          <ProjectsBoard f={f} />
          <T3Releases f={f} verdict={verdict} />
          <T3Logs />
        </BoardGrid>
      </div>
    </>
  )
}

function T3Head({ f, verdict }: { f: T3Facts; verdict: Verdict }) {
  const { data, running } = f
  return (
    <ServiceHead
      logo="/icon-t3code.svg"
      name="T3 Code"
      version={running ?? data.installed}
      versionNote={
        running === null ? 'installed; the server has not said' : 'reported by the server'
      }
      verdict={{ label: verdict.label, tone: verdict.tone }}
      compare={[
        {
          k: 'Server reports',
          v: running,
          note: 'what the running process answered with',
        },
        {
          k: 'Installed',
          v: data.installed,
          note:
            running !== null && data.installed !== null && running !== data.installed
              ? 'a rebuild installed this; restarting the server applies it'
              : 'what the last rebuild installed',
        },
        {
          k: 'Latest release',
          v: data.gap.latest,
          note: 'stable releases only; nightly builds are not counted',
        },
      ]}
      lede={
        <>
          A server for coding agents: it runs agent threads in the workspaces on this box and shows
          them in a browser. A device paired with it can start agents and, with full access, open a
          terminal, so the Devices list below is the one to keep short.
        </>
      }
      actions={
        <Button asChild variant="outline" size="sm">
          <a href={data.url} target="_blank" rel="noreferrer">
            ↗ Open
          </a>
        </Button>
      }
    />
  )
}

/* Said once, at the top: without a current reading the boards are empty, and
   the reason is the one line worth reading. */
function ReadingNotice({ f }: { f: T3Facts }) {
  const { reading } = f.data
  switch (f.gap) {
    case null:
      return null
    case 'unreadable':
      return <p className={EMPTY}>The status file could not be read: {reading.error}.</p>
    case 'none':
      return (
        <p className={EMPTY}>
          No reading yet. The status helper writes its first one within two minutes of starting; if
          this stays, its log is at the foot of the page.
        </p>
      )
    case 'stale':
      return (
        <p className={EMPTY}>
          The last reading is from <Ago at={reading.status?.generatedAt} />, and one is due every
          two minutes: the status helper has stopped. Nothing below is current; its log is at the
          foot of the page.
        </p>
      )
    case 'down':
      return (
        <p className={EMPTY}>
          The server is not answering, as of <Ago at={reading.status?.generatedAt} />. Its log below
          says why.
        </p>
      )
  }
}

function T3Stats({ f }: { f: T3Facts }) {
  const { live } = f
  const why = f.gap === null ? undefined : GAP_SUB[f.gap]
  // The server answered but the helper's own session could not list: the
  // counts would be zeros that mean "not asked".
  const listed = live !== null && live.reader
  const unlisted = why ?? 'could not list'
  const people = live?.devices.filter((d) => !isBot(d)) ?? []
  const connected = people.filter((d) => d.connected).length
  const full = people.filter((d) => d.fullAccess).length
  return (
    <StatStrip>
      <Stat
        label="Projects"
        value={listed ? live.counts.projects : DASH}
        sub={listed ? 'workspaces it can open' : unlisted}
      />
      <Stat
        label="Threads"
        value={listed ? live.counts.threads : DASH}
        sub={
          !listed
            ? unlisted
            : live.counts.failed > 0
              ? `${num(live.counts.failed)} failed · ${num(live.counts.archived)} archived`
              : `${num(live.counts.archived)} archived`
        }
      />
      <Stat
        label="Running now"
        value={listed ? live.counts.running : DASH}
        sub={listed ? 'agents mid-turn' : unlisted}
        title="Threads with an agent run in progress that is not waiting on anyone."
      />
      <Stat
        label="Waiting on you"
        value={listed ? live.counts.waiting : DASH}
        // The one number here that is a request: an agent stopped until answered.
        tone={listed && live.counts.waiting > 0 ? 'warn' : undefined}
        sub={listed ? 'stopped for an answer' : unlisted}
        title="Threads whose agent asked for an approval or an answer and is stopped until it gets one."
      />
      <Stat
        label="Paired devices"
        value={live === null ? DASH : people.length}
        sub={
          live === null
            ? why
            : full > 0
              ? `${num(connected)} connected · ${num(full)} full access`
              : `${num(connected)} connected`
        }
        title="Sessions held by people’s devices. The box’s own helper sessions are listed below and not counted."
      />
      <Stat
        label="Pairing links"
        value={live === null ? DASH : live.pendingPairings}
        // An unspent link is a way in for whoever holds it.
        tone={live !== null && live.pendingPairings > 0 ? 'warn' : undefined}
        sub={live === null ? why : 'unspent'}
        title="One-time pairing links that were made and not used yet. Each pairs one more device."
      />
    </StatStrip>
  )
}

function T3Releases({ f, verdict }: { f: T3Facts; verdict: Verdict }) {
  return (
    <Changelog
      gap={f.data.gap}
      span={6}
      aside={<span className={NOTE}>pingdotgg/t3code</span>}
      foot={
        <>
          <p className={FOOT}>
            The build is a pin, on System › Updates. A rebuild installs a new one and leaves the
            running server alone, because every agent turn and terminal is its child: restarting{' '}
            <span className={MONO}>t3code.service</span> applies it, when nothing is mid-turn. The
            web client is served by the server, so the two never differ. Nightly builds are not
            counted as releases.
          </p>
          {verdict.note !== '' && <p className={CAPTION}>{verdict.note}</p>}
        </>
      }
    />
  )
}

function T3Logs() {
  return (
    <LogBoard
      source={{ unit: 't3code.service' }}
      title="T3 Code logs"
      foot={
        <p className={FOOT}>
          The server unit&rsquo;s own output. Look here first when the page says the server is not
          answering.
        </p>
      }
      neighbours={[
        {
          source: { unit: 't3code-projects.service' },
          label: 'Project sync',
          role: 'what adds each workspace as a project',
          note: 'Runs when the server starts and whenever the workspace list changes, and says which projects it added. Look here when a workspace that was just cloned is missing from Projects.',
        },
        {
          source: { unit: 't3code-status.service' },
          label: 'Status helper',
          role: 'what writes the reading this page draws',
          note: 'Runs every two minutes. Look here when the page says there is no reading or that it is stale, or when the server answers and the lists stay empty.',
        },
      ]}
    />
  )
}
