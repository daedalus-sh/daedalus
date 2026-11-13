import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { desiredSet } from '../../host/controller/nodes'
import type { NodePolicy } from '../../host/schema'
import {
  accessoryIdOf,
  accessoryNamePatch,
  accessoryOf,
  isAccessoryId,
  parseMachineId,
  phoneIdOf,
  watchNameOf,
  watchOf,
} from './accessory'
import type { DeviceAccessory } from './light'
import { lightPolicy, wirePolicy } from './policy'
import { nodePolicyPatch } from './policy-patch'

// A phone's watch as a machine: its id, its name, and when there is one. And
// the other half of the promise — that it is a machine only where one is
// drawn: nothing that acts on machines can come by it.

const PHONE = '0123456789abcdef'

const watch = (over: Partial<DeviceAccessory> = {}): DeviceAccessory => ({
  kind: 'watch',
  name: 'Santiago’s Apple Watch',
  model: 'Watch7,5',
  osVersion: '26.1',
  osBuild: '23S37',
  battery: { percent: 64, charging: false },
  storage: null,
  at: '2026-11-12T09:58:30Z',
  ...over,
})

const phone = (over: Record<string, unknown> = {}) => ({
  id: PHONE,
  name: 'Santi’s iPhone',
  state: 'approved' as const,
  light: true,
  policy: {} as NodePolicy,
  device: { accessories: [watch()] },
  ...over,
})

describe('a machine id', () => {
  it('is the box, a node, or a phone’s watch', () => {
    expect(parseMachineId('box')).toEqual({ kind: 'box' })
    expect(parseMachineId(PHONE)).toEqual({ kind: 'node', id: PHONE })
    expect(parseMachineId(`${PHONE}.watch`)).toEqual({
      kind: 'accessory',
      id: `${PHONE}.watch`,
      phone: PHONE,
    })
  })

  it('is nothing else', () => {
    for (const v of [
      '',
      'watch',
      '.watch',
      `${PHONE}.Watch`,
      `${PHONE}.watch.watch`,
      `${PHONE}.watch2`,
      `${PHONE}.phone`,
      `${PHONE.toUpperCase()}.watch`,
      `${PHONE.slice(1)}.watch`,
      'box.watch',
      ` ${PHONE}.watch`,
      `${PHONE}.watch\n`,
      null,
      undefined,
      7,
    ]) {
      expect(parseMachineId(v), String(v)).toBeNull()
      expect(isAccessoryId(v), String(v)).toBe(false)
    }
  })

  it('round-trips a phone’s id', () => {
    expect(accessoryIdOf(PHONE)).toBe(`${PHONE}.watch`)
    expect(phoneIdOf(accessoryIdOf(PHONE))).toBe(PHONE)
    expect(phoneIdOf(PHONE)).toBeNull()
    expect(isAccessoryId(`${PHONE}.watch`)).toBe(true)
  })
})

describe('the watch of a phone', () => {
  it('is the first one its sample listed', () => {
    const second = watch({ name: 'Old watch' })
    expect(watchOf({ accessories: [watch(), second] })?.name).toBe('Santiago’s Apple Watch')
    expect(watchOf({ accessories: [] })).toBeNull()
    expect(watchOf(null)).toBeNull()
  })

  it('exists while its phone is approved and reports one, under the phone’s id', () => {
    expect(accessoryOf(phone())).toEqual({
      id: `${PHONE}.watch`,
      name: 'Santiago’s Apple Watch',
      given: null,
      facts: watch(),
      phone: { id: PHONE, name: 'Santi’s iPhone' },
    })
  })

  it('goes with a revoked phone, a phone without one, and never hangs off a computer', () => {
    expect(accessoryOf(phone({ state: 'revoked' }))).toBeNull()
    expect(accessoryOf(phone({ device: { accessories: [] } }))).toBeNull()
    expect(accessoryOf(phone({ device: null }))).toBeNull()
    expect(accessoryOf(phone({ light: false }))).toBeNull()
  })

  it('takes a fresher reading of the same watch, and never one the row does not hold', () => {
    const fresh = watch({ battery: { percent: 12, charging: true } })
    expect(accessoryOf(phone(), fresh)?.facts.battery?.percent).toBe(12)
    expect(accessoryOf(phone({ device: { accessories: [] } }), fresh)).toBeNull()
  })
})

describe('a watch’s display name', () => {
  it('is the one set here, else the reported one, else what it is', () => {
    expect(watchNameOf({ watchName: 'Wrist' }, watch())).toBe('Wrist')
    expect(watchNameOf({}, watch())).toBe('Santiago’s Apple Watch')
    expect(watchNameOf({ watchName: '  ' }, watch())).toBe('Santiago’s Apple Watch')
    expect(watchNameOf(null, watch({ name: null }))).toBe('Apple Watch')
    expect(watchNameOf({}, watch({ name: '  ' }))).toBe('Apple Watch')
    const named = accessoryOf(phone({ policy: { watchName: 'Wrist' } }))
    expect([named?.name, named?.given]).toEqual(['Wrist', 'Wrist'])
  })

  it('is edited by the watch’s id: one bounded line, empty to clear', () => {
    const id = `${PHONE}.watch`
    expect(accessoryNamePatch({ id, name: '  My   watch ' })).toEqual({
      id,
      phone: PHONE,
      name: 'My watch',
    })
    expect(accessoryNamePatch({ id, name: '' }).name).toBe('')
    expect(() => accessoryNamePatch({ id: PHONE, name: 'x' })).toThrow('watch’s id')
    expect(() => accessoryNamePatch({ id: 'box', name: 'x' })).toThrow('watch’s id')
    expect(() => accessoryNamePatch({ id, name: 7 })).toThrow('text')
    expect(() => accessoryNamePatch({ id, name: 'x'.repeat(41) })).toThrow('longer')
    expect(() => accessoryNamePatch({ id, name: 'a\u0007b' })).toThrow('control')
    expect(() => accessoryNamePatch(null)).toThrow('watch’s id')
  })

  it('is no key of a machine’s policy patch', () => {
    expect(() => nodePolicyPatch({ id: PHONE, set: { watchName: 'Wrist' } })).toThrow(
      'watchName is not a policy key',
    )
    expect(() => nodePolicyPatch({ id: PHONE, unset: ['watchName'] })).toThrow('not a policy key')
  })
})

describe('what the controller hears', () => {
  const names = { netName: 'iphone', lanIp: null, lanDomain: 'lan', baseDomain: 'example.org' }

  it('never carries a watch’s name', () => {
    const policy: NodePolicy = { displayName: 'Santi’s iPhone', watchName: 'Wrist' }
    expect(JSON.stringify(wirePolicy(lightPolicy(policy), names))).not.toContain('Wrist')
    expect(JSON.stringify(wirePolicy(policy, names))).not.toContain('atch')
  })

  it('is one entry per row: a phone with a watch is still one key', () => {
    const { nodes } = desiredSet(
      [
        {
          id: PHONE,
          publicKey: 'ab'.repeat(32),
          state: 'approved',
          policy: { watchName: 'Wrist' },
          hostname: 'iPhone',
          lanIp: null,
          os: 'ios',
        },
      ],
      { lanDomain: 'lan', baseDomain: 'example.org' },
    )
    expect(nodes.map((n) => n.id)).toEqual([PHONE])
    expect(JSON.stringify(nodes)).not.toMatch(/watch|Wrist/i)
  })
})

describe('who can come by a watch', () => {
  // The watch is derived from its phone's row by this one module, so the files
  // that import it are every place a watch can appear. A reader of the nodes
  // table that is not on this list cannot return one: lib/repo/nodes.ts (the
  // rows, site/nodes.json), host/controller/nodes.ts (the desired set),
  // host/providers/** (the fleet, the gateway), host/dhcp-hosts.ts (the
  // names), the runners, the metrics targets, santree.
  const SRC = join(import.meta.dirname, '..', '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
    }
    return out
  }
  const importers = walk(SRC)
    .filter((f) => /from '(?:\.\/|[^']*\/agent\/)accessory'/.test(readFileSync(f, 'utf8')))
    .map((f) => relative(SRC, f))
    .sort()

  it('is the pages that draw one, /api/v1’s views, and the name’s one writer', () => {
    expect(importers).toEqual([
      // The Machines table and the System picker and page.
      'components/machine-picker.tsx',
      'components/settings/machines/index.tsx',
      'components/settings/machines/light.tsx',
      'components/settings/machines/watch.tsx',
      // Its name: `setAccessoryName`, which writes one key and syncs nothing.
      'core/nodes.ts',
      // /api/v1: the path's id, the list and the detail.
      'host/api/v1/handle.ts',
      'host/api/v1/views.ts',
      // An id's decoder.
      'lib/contract/fields.ts',
      // The watch's own page.
      'lib/dashboard/accessory-system.ts',
      'modules/system/view/node/device.tsx',
      'routes/c.$category.tsx',
      'server/nodes.ts',
    ])
  })
})
