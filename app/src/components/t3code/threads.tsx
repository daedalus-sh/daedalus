import { cn } from '../../lib/cn'
import type { T3Thread } from '../../lib/dashboard/t3code'
import { DASH, num, text } from '../../lib/format'
import { Ago } from '../ago'
import {
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../table'
import { TableSection } from '../table-section'
import { FOOT } from '../tokens'
import { Chip } from '../viz'
import { GAP_SUB, type T3Facts } from './facts'

/* thread · state · mode · model · since. The state is the column that
   differs, so it is the one with a chip; the rest recede. */
const GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.6fr)_8rem_5rem_minmax(0,1fr)_5.5rem]',
  '@max-[48rem]/table:grid-cols-[minmax(0,1fr)_8rem_5.5rem]',
  '@max-[34rem]/table:grid-cols-[minmax(0,1fr)_auto]',
)
const WIDE = '@max-[48rem]/table:hidden'
const PHONE_HIDE = '@max-[34rem]/table:hidden'

const FAILED = /^(failed|error)$/

/**
 * The threads that want someone first, then the newest of the rest.
 *
 * `recent` is the newest twelve whatever their state, so a running thread is
 * in both lists; it is drawn once, at the top.
 */
export function ThreadsBoard({ f }: { f: T3Facts }) {
  const { live } = f
  const active = live?.active ?? []
  const rest = (live?.recent ?? []).filter((t) => t.state === 'idle')
  const rows = [...active, ...rest]
  return (
    <TableSection
      title="Threads"
      aside={
        live === null || !live.reader
          ? undefined
          : `${num(active.length)} active · ${num(live.counts.threads)} in all`
      }
    >
      <ul className={TABLE}>
        <li aria-hidden="true" className={cn(GRID, TABLE_HEAD)}>
          <span>Thread</span>
          <span>State</span>
          <span className={WIDE}>Mode</span>
          <span className={WIDE}>Model</span>
          <span className={cn('text-right', PHONE_HIDE)}>Since</span>
        </li>
        {rows.length === 0 && (
          <li className={TABLE_EMPTY}>
            {f.gap !== null
              ? `Nothing to show: ${GAP_SUB[f.gap]}.`
              : live?.reader === false
                ? 'The server answered, but the status helper could not sign in to list its threads.'
                : 'No threads yet. One started in T3 Code shows up here within two minutes.'}
          </li>
        )}
        {rows.map((t, i) => (
          // No id in the reading; a title can repeat, so the position is part of the key.
          <ThreadRow key={`${String(i)}:${t.title}`} t={t} />
        ))}
      </ul>
      <p className={FOOT}>
        Running and waiting threads first, then the twelve that moved last. Waiting means the agent
        stopped to ask for an approval or an answer, and it stays stopped until someone gives one in
        T3 Code. The reading is two minutes old at most, so a thread that just started may not be
        here yet.
      </p>
    </TableSection>
  )
}

function StateCell({ t }: { t: T3Thread }) {
  if (t.state === 'running') return <Chip tone="info">running</Chip>
  if (t.state === 'waiting') return <Chip tone="warn">waiting on you</Chip>
  if (FAILED.test(t.status)) return <Chip tone="bad">{t.status}</Chip>
  return <span className={CELL_QUIET}>{text(t.status === '' ? null : t.status)}</span>
}

function ThreadRow({ t }: { t: T3Thread }) {
  const active = t.state !== 'idle'
  // An active thread is timed from when its run began; an idle one from when it last moved.
  const at = active ? (t.startedAt ?? t.updatedAt) : t.updatedAt
  return (
    <li className={cn(GRID, TABLE_ROW)}>
      <span className="flex min-w-0 flex-col">
        <span className={CELL_NAME}>{t.title === '' ? 'Untitled thread' : t.title}</span>
        <span className={CELL_SUB}>{t.project ?? 'no project'}</span>
        {t.error !== null && <span className="truncate text-[0.75rem] text-danger">{t.error}</span>}
      </span>
      <span className="flex">
        <StateCell t={t} />
      </span>
      <span className={cn(CELL_QUIET, WIDE)}>{t.mode ?? DASH}</span>
      <span className={cn(CELL_QUIET, WIDE, 'truncate')}>{t.model ?? DASH}</span>
      <span className={cn(CELL_QUIET, PHONE_HIDE, 'text-right')}>
        {at === null ? DASH : <Ago at={at} />}
      </span>
    </li>
  )
}
