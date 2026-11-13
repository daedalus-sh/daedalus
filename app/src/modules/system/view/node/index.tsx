import type { NavIconName } from '../../../../components/nav-icon'
import { isLightOs } from '../../../../lib/agent/light'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { NodeBoardView } from './board'
import { NodeBrowsersView } from './browsers'
import { NodeBuildView } from './build'
import { NodeDeviceView } from './device'
import { NodeDisksView } from './disks'
import { NodeGraphicsView } from './graphics'
import { NodeHostView } from './host'
import { NodeIosView } from './ios'
import { NodeMacosView } from './macos'
import { NodeMemoryView } from './memory'
import { NoDocument } from './shared'
import { NodeSoftwareView } from './software'
import { NodeUpdatesView } from './updates'

export { BoxHead, MachineHead } from './shared'

// The System page for a machine that is not this box, drawn from the one
// document its agent publishes — and shaped to the KIND of machine.
//
// Four kinds of node, four tab rows. Four tabs are the machine as a
// machine and are the same everywhere: Host, Memory, Disks, Build, with the
// box's ids so `?tab=memory` means the memory of whichever machine is picked.
// After them the row is the operating system's own story:
//
// - a Windows PC has a motherboard whose maker publishes firmware, a
//   graphics card whose driver is the thing a gamer updates, a software
//   inventory where runtimes and games live, and Windows Update;
// - a Mac has none of that. Its firmware moves with macOS, Apple publishes
//   one list of what is newer with notes, and its apps come from the App
//   Store, Homebrew and a folder; so it gets macOS and Apps;
// - any other OS gets Motherboard and Updates only;
// - a phone or tablet (lib/agent/light.ts) is none of the above: it is
//   connected only while its app is open and reports a handful of facts, so
//   its row is two tabs — Device, under Host's id so the picker keeps its
//   place, and iOS or iPadOS, what Apple has shipped since. No Claude and no
//   Chromium: neither runs there. Its watch is no node, and is drawn as a
//   machine all the same (./watch.tsx): Watch and watchOS.
//
// The box itself is not a node: its row, with pools, backups and the browser
// lab, is modules/system/manifest.ts.
//
// Claude and Chromium close every row: the remote-control server and the
// sessions' eyes exist on each machine.

type NodeTabSpec = {
  id: string
  label: string
  boardSpans: readonly number[]
  icon?: NavIconName
  dividerBefore?: boolean
  /** Opens with a ServiceHead, which the skeleton has to know. */
  head?: boolean
}

const HOST: NodeTabSpec = { id: 'host', label: 'Host', boardSpans: [8, 4, 4, 4, 4, 8, 4, 12] }
const MEMORY: NodeTabSpec = { id: 'memory', label: 'Memory', boardSpans: [8, 4, 4, 8] }
const DISKS: NodeTabSpec = { id: 'disks', label: 'Disks', boardSpans: [4, 4, 4, 12] }
const BUILD: NodeTabSpec = { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 4, 4, 4, 12] }
const BOARD: NodeTabSpec = { id: 'board', label: 'Motherboard', boardSpans: [4, 8, 12] }
const GRAPHICS: NodeTabSpec = { id: 'graphics', label: 'Graphics', boardSpans: [8, 4, 6, 6] }
const SOFTWARE: NodeTabSpec = {
  id: 'software',
  label: 'Software',
  boardSpans: [4, 4, 4, 6, 6, 12],
}
const UPDATES: NodeTabSpec = { id: 'updates', label: 'Updates', boardSpans: [4, 8, 12, 6, 6] }
const MACOS: NodeTabSpec = { id: 'macos', label: 'macOS', boardSpans: [4, 8, 12, 6, 6] }
const APPS: NodeTabSpec = { id: 'apps', label: 'Apps', boardSpans: [4, 4, 4, 12] }
// Who maintains it, as on the box: the remote-control server the agent's
// tray runs there. Drawn by modules/system/view/node/claude.tsx from the node's
// Claude report rather than from the telemetry document.
const CLAUDE: NodeTabSpec = {
  id: 'claude',
  label: 'Claude',
  boardSpans: [6, 6, 12, 6],
}
// The sessions' eyes, as Shotter is on the box: the Chromium-based
// browsers the machine has, against what their vendors ship today.
const BROWSERS: NodeTabSpec = {
  id: 'browsers',
  label: 'Chromium',
  boardSpans: [6, 6, 12],
  head: true,
}

const WINDOWS_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  BOARD,
  GRAPHICS,
  SOFTWARE,
  UPDATES,
  CLAUDE,
  BROWSERS,
]
const MACOS_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  MACOS,
  APPS,
  CLAUDE,
  BROWSERS,
]
const OTHER_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  BOARD,
  UPDATES,
  CLAUDE,
  BROWSERS,
]

// A light node's row. Both draw from what the box kept of the device
// (./device.tsx, ./ios.tsx), so they answer while it is away.
const DEVICE: NodeTabSpec = { id: 'host', label: 'Device', boardSpans: [4, 4, 4] }
const IOS_TABS: readonly NodeTabSpec[] = [
  DEVICE,
  { id: 'ios', label: 'iOS', boardSpans: [4, 8, 12] },
]
const IPADOS_TABS: readonly NodeTabSpec[] = [
  DEVICE,
  { id: 'ios', label: 'iPadOS', boardSpans: [4, 8, 12] },
]

// A phone's watch, where the picker shows it as a machine (./watch.tsx): the
// phone's two tabs under the same ids, so the picker keeps its place between
// a phone and its watch. `watchos` is no node's OS: the route names it for a
// watch's id.
const WATCH_TABS: readonly NodeTabSpec[] = [
  { id: 'host', label: 'Watch', boardSpans: [4, 4, 4] },
  { id: 'ios', label: 'watchOS', boardSpans: [4, 8] },
]

export function nodeTabsFor(os: string): readonly NodeTabSpec[] {
  if (os === 'watchos') return WATCH_TABS
  if (isLightOs(os)) return os === 'ipados' ? IPADOS_TABS : IOS_TABS
  return os === 'windows' ? WINDOWS_TABS : os === 'macos' ? MACOS_TABS : OTHER_TABS
}

export type NodeTabId =
  | 'host'
  | 'memory'
  | 'disks'
  | 'build'
  | 'board'
  | 'graphics'
  | 'software'
  | 'updates'
  | 'macos'
  | 'ios'
  | 'apps'
  | 'claude'
  | 'browsers'

// Switching the picker keeps the tab. Where the other machine has no such
// tab, the nearest subject is opened rather than Host: Updates on the box
// or the PC is macOS on the Mac, and the Mac's Apps are the PC's Software. A
// phone has two tabs: the OS's own story lands on its iOS tab, and every
// other subject it lacks on Device.
const LIGHT_NEAREST: Record<string, NodeTabId> = { updates: 'ios', macos: 'ios' }
const NEAREST: Record<string, Record<string, NodeTabId>> = {
  macos: { updates: 'macos', board: 'macos', software: 'apps', graphics: 'apps', ios: 'macos' },
  windows: { macos: 'updates', apps: 'software', ios: 'updates' },
  linux: { ios: 'updates' },
  ios: LIGHT_NEAREST,
  ipados: LIGHT_NEAREST,
  watchos: LIGHT_NEAREST,
}

export function resolveNodeTab(os: string, tab: string | undefined): NodeTabId {
  const tabs = nodeTabsFor(os)
  const hit = tabs.find((t) => t.id === tab)
  if (hit !== undefined) return hit.id as NodeTabId
  const near = tab === undefined ? undefined : NEAREST[os]?.[tab]
  return near !== undefined && tabs.some((t) => t.id === near) ? near : 'host'
}

export function MachineSystemView({ d, tab }: { d: NodeSystemData; tab: NodeTabId }) {
  // A phone is away most of the day and its tabs draw from what the box kept,
  // so a missing document is not "nothing to show" for it.
  if (d.node.light) return tab === 'ios' ? <NodeIosView d={d} /> : <NodeDeviceView d={d} />
  const ready = d.status !== null && d.telemetry !== null
  return (
    <>
      {!ready ? (
        <NoDocument d={d} />
      ) : tab === 'memory' ? (
        <NodeMemoryView d={d} />
      ) : tab === 'disks' ? (
        <NodeDisksView d={d} />
      ) : tab === 'browsers' ? (
        <NodeBrowsersView d={d} />
      ) : tab === 'board' ? (
        <NodeBoardView d={d} />
      ) : tab === 'graphics' ? (
        <NodeGraphicsView d={d} />
      ) : tab === 'software' || tab === 'apps' ? (
        <NodeSoftwareView d={d} />
      ) : tab === 'macos' ? (
        <NodeMacosView d={d} />
      ) : tab === 'build' ? (
        <NodeBuildView d={d} />
      ) : tab === 'updates' ? (
        <NodeUpdatesView d={d} />
      ) : (
        <NodeHostView d={d} />
      )}
    </>
  )
}
