import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { useShown } from '../../lib/shown'
import { setT3ProjectShownFn } from '../../server/t3code'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_N, ROW_SIDE } from '../tokens'
import { Switch } from '../ui/switch'
import { useAction } from '../use-action'
import { Board, Chip } from '../viz'
import { GAP_SUB, type ProjectRow, projectRows, type T3Facts } from './facts'

// The projects T3 Code can open a thread in, each with its switch.
//
// A switch is a site edit (site.json `modules.hiddenProjects.t3code`) and
// lands on the next Apply, like the Minecraft roster's: it writes the draft
// and rebuilds nothing. The host's sync then leaves a hidden workspace out
// and removes it from T3 while it holds no thread, archived ones included.

/** The projects T3 Code can open a thread in, with how many it holds. */
export function ProjectsBoard({ f }: { f: T3Facts }) {
  const rows = projectRows(f)
  const shown = rows.filter((r) => r.shown).length
  return (
    <Board
      title="Projects"
      span={6}
      aside={
        rows.length === 0 ? undefined : (
          <span className={NOTE}>
            {shown === rows.length ? num(rows.length) : `${num(shown)} of ${num(rows.length)}`}
          </span>
        )
      }
    >
      {rows.length === 0 ? (
        <p className={EMPTY}>
          {f.gap !== null
            ? `Nothing to show: ${GAP_SUB[f.gap]}.`
            : f.live?.reader === false
              ? 'The server answered, but the status helper could not sign in to list its projects.'
              : 'No projects yet. The first workspace cloned here becomes one.'}
        </p>
      ) : (
        // A long list beside a short board: it scrolls rather than stretch the row.
        <ul className={cn(LIST, 'm-0 max-h-[26rem] list-none overflow-y-auto p-0')}>
          {rows.map((r) => (
            <ProjectLine key={r.root === '' ? r.title : r.root} r={r} />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Every workspace the control plane keeps is added to T3 Code automatically, unless its switch
        is off. The switches are kept in site.json (
        <span className={MONO}>modules.hiddenProjects.t3code</span>) and take effect on the next
        Apply: a hidden project is then removed from T3, but only while it holds no thread, archived
        ones included, so one with threads stays until they are deleted in T3. A project made by
        hand is left alone. The number is the threads each one holds.
      </p>
    </Board>
  )
}

function ProjectLine({ r }: { r: ProjectRow }) {
  const { run, busy, error } = useAction()
  const [shown, showShown] = useShown(r.shown, busy, error !== null)
  return (
    <li className={cn(ROW, 'flex-wrap')}>
      <Switch
        aria-label={`Show ${r.title} in T3 Code`}
        checked={shown}
        disabled={busy || r.root === ''}
        onCheckedChange={(v) => {
          showShown(v)
          run(() => setT3ProjectShownFn({ data: { root: r.root, shown: v } }))
        }}
      />
      <span className={cn(ROW_MAIN, !shown && 'text-muted-foreground')} title={r.root}>
        {r.title}
      </span>
      {r.pending && <Chip tone="info">{r.shown ? 'shown on Apply' : 'hidden on Apply'}</Chip>}
      {!r.pending && r.kept && <Chip tone="warn">hidden, still holds threads</Chip>}
      <span className={ROW_SIDE}>
        {r.threads === null ? 'not in T3' : (r.repository ?? 'no repository')}
      </span>
      <span className={ROW_N} title="Threads in this project">
        {r.threads === null ? '' : num(r.threads)}
      </span>
      {error !== null && <p className={cn(NOTE, 'm-0 w-full text-danger')}>{error}</p>}
    </li>
  )
}
