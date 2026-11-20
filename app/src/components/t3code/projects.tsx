import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { EMPTY, FOOT, LIST, NOTE, ROW, ROW_MAIN, ROW_N, ROW_SIDE } from '../tokens'
import { Board } from '../viz'
import { GAP_SUB, type T3Facts } from './facts'

/** The projects T3 Code can open a thread in, with how many it holds. */
export function ProjectsBoard({ f }: { f: T3Facts }) {
  const projects = f.live?.projects ?? []
  return (
    <Board
      title="Projects"
      span={6}
      aside={
        projects.length === 0 ? undefined : <span className={NOTE}>{num(projects.length)}</span>
      }
    >
      {projects.length === 0 ? (
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
          {projects.map((p) => (
            <li key={p.workspaceRoot === '' ? p.title : p.workspaceRoot} className={ROW}>
              <span className={ROW_MAIN} title={p.workspaceRoot}>
                {p.title}
              </span>
              <span className={ROW_SIDE}>{p.repository ?? 'no repository'}</span>
              <span className={ROW_N} title="Threads in this project">
                {num(p.threads)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Every workspace the control plane keeps is added to T3 Code automatically, when the server
        starts and whenever the workspace list changes. It only ever adds: nothing is removed or
        renamed for you, and a project made by hand is left alone. The number is the threads each
        one holds.
      </p>
    </Board>
  )
}
