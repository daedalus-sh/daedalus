import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { NodeDetail, Telemetry } from '../../host/controller/generated'
import { ANSWERS } from '../../host/controller/wire'
import { decode } from '../contract/decode'
import {
  accessoriesOf,
  type DeviceFacts,
  deviceFactsFrom,
  keptDeviceFacts,
  sameDeviceFacts,
} from './light'

// A phone's facts and its watch's, from the document the controller answers
// (host/controller/generated/fixtures/nodes.get.json, written by the agent's
// gate, which carries one watch) to what the row keeps.

const detail: NodeDetail = decode(
  ANSWERS['nodes.get'],
  JSON.parse(
    readFileSync(
      new URL('../../host/controller/generated/fixtures/nodes.get.json', import.meta.url),
      'utf8',
    ),
  ),
)
const AT = '2026-11-12T10:00:00.000Z'
const telemetry = detail.telemetry as Telemetry

const WATCH = {
  kind: 'watch',
  name: 'Apple Watch',
  model: 'Watch7,5',
  osVersion: '26.1',
  osBuild: '23S37',
  battery: { percent: 64, charging: false },
  storage: { totalBytes: 64_000_000_000, freeBytes: 41_000_000_000 },
  at: '2026-09-27T10:00:05Z',
} as const

describe('a phone’s watch', () => {
  it('is read from the phone’s sample, with the time the watch read it', () => {
    expect(deviceFactsFrom(detail, null, AT)?.accessories).toEqual([WATCH])
  })

  it('takes the phone’s reading time when the watch gave none, and a bare version', () => {
    const [w] = telemetry.accessories ?? []
    if (w === undefined) throw new Error('the fixture has no watch')
    const said = { ...w, sampled_at: null, os_version: 'watchOS 26.1', battery: null }
    expect(accessoriesOf({ accessories: [said] }, AT)).toEqual([
      { ...WATCH, battery: null, at: AT },
    ])
    expect(accessoriesOf({ accessories: [{ ...w, sampled_at: 'soon' }] }, AT)[0]?.at).toBe(AT)
    const bare = {
      ...w,
      os_version: null,
      storage_total_bytes: null,
      storage_free_bytes: null,
    }
    expect(accessoriesOf({ accessories: [bare] }, AT)[0]).toMatchObject({
      osVersion: null,
      storage: null,
    })
  })

  it('leaves out a kind this box does not draw', () => {
    const [w] = telemetry.accessories ?? []
    if (w === undefined) throw new Error('the fixture has no watch')
    expect(accessoriesOf({ accessories: [{ ...w, kind: 'unknown' }, w] }, AT)).toEqual([WATCH])
    // An agent's document has no such key at all.
    const { accessories: _, ...rest } = telemetry
    const agent: Telemetry = rest
    expect(accessoriesOf(agent, AT)).toEqual([])
  })

  it('goes when a sample no longer lists it, and stays while there is no sample', () => {
    const prior = deviceFactsFrom(detail, null, AT) as DeviceFacts
    const { accessories: _, ...alone } = telemetry
    // A sample without the watch: the phone has none now.
    expect(deviceFactsFrom({ ...detail, telemetry: alone }, prior, AT)?.accessories).toEqual([])
    // A status and no sample (the controller restarted): what the row kept.
    expect(deviceFactsFrom({ ...detail, telemetry: null }, prior, AT)?.accessories).toEqual([WATCH])
  })

  it('counts as a change of the facts', () => {
    const a = deviceFactsFrom(detail, null, AT) as DeviceFacts
    expect(sameDeviceFacts(a, { ...a, at: 'later' })).toBe(true)
    expect(sameDeviceFacts(a, { ...a, accessories: [] })).toBe(false)
    const lower = { ...WATCH, battery: { percent: 63, charging: false } }
    expect(sameDeviceFacts(a, { ...a, accessories: [lower] })).toBe(false)
  })
})

describe('a row written before accessories existed', () => {
  it('reads as a phone without one', () => {
    const old = {
      model: 'iPhone17,1',
      osVersion: '26.1',
      appVersion: '1.0.0',
      battery: null,
      storage: null,
      memoryBytes: null,
      at: AT,
    }
    expect(keptDeviceFacts(old)).toEqual({ ...old, accessories: [] })
    expect(keptDeviceFacts(null)).toBeNull()
    // And is the same reading as its normalised self: no write for nothing.
    const kept = keptDeviceFacts(old)
    expect(sameDeviceFacts(kept, { ...old, accessories: [] })).toBe(true)
  })
})
