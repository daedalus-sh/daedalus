import { describe, expect, it } from 'vitest'
import type { T3CodeData, T3Project } from '../../lib/dashboard/t3code'
import { projectRows, type T3Facts } from './facts'

const project = (root: string, threads: number): T3Project => ({
  title: root.split('/').pop() ?? root,
  workspaceRoot: root,
  repository: null,
  threads,
})

function facts(projects: T3Project[], committed: string[], desired: string[]): T3Facts {
  return {
    data: { hidden: { committed, desired } } as T3CodeData,
    live: { projects } as T3Facts['live'],
    gap: null,
    running: null,
  }
}

describe('the Projects board rows', () => {
  it('lists T3’s projects, then the hidden ones it no longer does', () => {
    const rows = projectRows(facts([project('/p/a', 2)], ['/p/gone'], ['/p/gone']))
    expect(rows.map((r) => [r.root, r.shown, r.threads])).toEqual([
      ['/p/a', true, 2],
      ['/p/gone', false, null],
    ])
  })

  it('says a switch is pending until an Apply, and a hidden project kept for its threads', () => {
    const [pending] = projectRows(facts([project('/p/a', 0)], [], ['/p/a']))
    expect(pending).toMatchObject({ shown: false, pending: true, kept: false })
    const [kept] = projectRows(facts([project('/p/a', 3)], ['/p/a'], ['/p/a']))
    expect(kept).toMatchObject({ shown: false, pending: false, kept: true })
  })
})
