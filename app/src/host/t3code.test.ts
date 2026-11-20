import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import { fakeController } from './controller/fake'
import { readT3RestartConfirm, restartT3Code } from './t3code'

// T3 Code's restart, against fakes: the live controller is never asked
// anything here, and nothing is restarted.

describe('restarting T3 Code', () => {
  const asking = (answer: { outcome: string; detail: string }) => {
    const asked: unknown[][] = []
    const c = {
      ...fakeController({}),
      call: (...args: unknown[]) => {
        asked.push(args)
        return Promise.resolve({ run: 'r1', verb: 't3code-restart', ...answer, verbs: [] })
      },
    } as unknown as ControllerClient
    return { asked, c }
  }

  it('asks the root helper for t3code-restart, with no selectors, past its 150 s', async () => {
    const { asked, c } = asking({ outcome: 'done', detail: '' })
    expect(await restartT3Code({ controller: c }, { actor: 'alice' })).toEqual({
      outcome: 'done',
      detail: '',
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[0]).toBe('root.run')
    expect(asked[0]?.[1]).toEqual({ verb: 't3code-restart', selectors: {} })
    const [, , o] = asked[0] as [string, unknown, { waitMs: number }]
    expect(o.waitMs).toBeGreaterThan(150_000)
  })

  it('hands back the helper’s refusal as it is', async () => {
    const { c } = asking({ outcome: 'refused', detail: 't3code-restart is already running' })
    expect(await restartT3Code({ controller: c }, { actor: 'alice' })).toEqual({
      outcome: 'refused',
      detail: 't3code-restart is already running',
    })
  })

  it('is a failure that says why when the controller cannot be asked', async () => {
    const c = fakeController({})
    expect(await restartT3Code({ controller: c }, { actor: 'alice' })).toMatchObject({
      outcome: 'failed',
    })
  })
})

describe('the confirm, read afresh', () => {
  it('does not claim a count on a box that binds no status file', async () => {
    const ctx = {
      env: () => undefined,
      snapshot: () => Promise.reject(new Error('no file is read without a path')),
    }
    expect(await readT3RestartConfirm(ctx as never)).toMatch(/is not known right now/)
  })
})
