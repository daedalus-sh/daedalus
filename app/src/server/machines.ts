import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { accessoryIdField, flagField, nodeIdField } from '../lib/contract/fields'
import { readFn } from './fn'

// The machine picker's list and a node's System page. Read-only.

/** Every approved node: what the pickers on System and Claude offer beside this box. */
export const fetchMachineNodesFn = readFn.handler(async ({ context }) => {
  const { listNodes } = await import('../lib/repo/nodes')
  return (await listNodes(await context.ctx())).filter((n) => n.state === 'approved')
})

export const fetchNodeSystemFn = readFn
  .validator(
    asValidator(
      withMessage(
        obj({
          id: nodeIdField,
          board: flagField,
          browsers: flagField,
          macos: flagField,
          ios: flagField,
        }),
        'expected a node id',
      ),
    ),
  )
  .handler(async ({ data, context }) => {
    const { loadNodeSystem } = await import('../lib/dashboard/node-system')
    return loadNodeSystem(await context.ctx(), data.id, {
      board: data.board,
      browsers: data.browsers,
      macos: data.macos,
      ios: data.ios,
    })
  })

/** A phone's watch as the System page draws it (lib/dashboard/accessory-system.ts). */
export const fetchAccessorySystemFn = readFn
  .validator(
    asValidator(
      withMessage(obj({ id: accessoryIdField, releases: flagField }), 'expected a watch id'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { loadAccessorySystem } = await import('../lib/dashboard/accessory-system')
    return loadAccessorySystem(await context.ctx(), data.id, { releases: data.releases })
  })

/** The strip above the box's own System tabs: its release, kernel and board. */
export const fetchBoxHeadFn = readFn.handler(async () => {
  const { loadBoxHead } = await import('../lib/dashboard/box-head')
  return loadBoxHead()
})
