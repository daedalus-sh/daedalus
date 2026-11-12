import { lightKind } from '../../../lib/agent/light'
import { cn } from '../../../lib/cn'
import { bytes, pct } from '../../../lib/format'
import { LINK_UNKNOWN } from '../../../lib/node-link'
import type { NodeRow } from '../../../lib/repo/nodes'
import { Ago } from '../../ago'
import { ASIDE, Mono } from '../shared'
import type { Fact } from './machine-section'

// A phone or tablet in the Machines table (lib/agent/light.ts): the same row
// as a computer, saying less. It links only while its app is open, so "not
// connected" is its usual state and reads as when it was last seen, in the
// muted ink, never as a warning. What it is comes from the facts the box kept
// from its last connection (`node.device`), since the controller holds
// nothing for it once it is away.

/** The link in words: connected, or when the box last saw it. */
export function LightLink({ n, className }: { n: NodeRow; className?: string }) {
  return (
    <span className={cn(className)}>
      {n.connected === null ? (
        LINK_UNKNOWN
      ) : n.connected ? (
        'connected'
      ) : (
        <>
          last seen <Ago at={n.lastSeenAt} />
        </>
      )}
    </span>
  )
}

/** "iPhone · iPhone17,1 · iOS 26.1": the line under the name. */
export function lightSub(n: NodeRow, osLabel: string): string {
  return [
    lightKind(n.os),
    n.device?.model ?? null,
    n.device?.osVersion == null ? null : `${osLabel} ${n.device.osVersion}`,
  ]
    .filter((x) => x !== null && x !== '')
    .join(' · ')
}

/** The open row's facts: what the device last said, and when. */
export function lightFacts(n: NodeRow, osLabel: string): Fact[] {
  const d = n.device
  const none = <span className={ASIDE}>—</span>
  const battery = d?.battery ?? null
  const storage = d?.storage ?? null
  return [
    {
      k: lightKind(n.os),
      v: d?.model == null ? none : <Mono>{d.model}</Mono>,
    },
    { k: osLabel, v: d?.osVersion == null ? none : <Mono>{d.osVersion}</Mono> },
    { k: 'App', v: <Mono>{n.agentVersion}</Mono> },
    {
      k: 'Battery',
      v:
        battery === null || battery.percent === null ? (
          none
        ) : (
          <span className="tabular-nums">
            {pct(battery.percent)}
            {battery.charging === true && <span className={ASIDE}> · charging</span>}
          </span>
        ),
    },
    {
      k: 'Storage',
      v:
        storage === null || storage.totalBytes === null ? (
          none
        ) : (
          <span className="tabular-nums">
            {storage.freeBytes === null ? '' : `${bytes(storage.freeBytes)} free of `}
            {bytes(storage.totalBytes)}
          </span>
        ),
    },
    {
      k: 'Memory',
      v:
        d?.memoryBytes == null ? (
          none
        ) : (
          <span className="tabular-nums">{bytes(d.memoryBytes)}</span>
        ),
    },
    { k: 'Link', v: <LightLink n={n} /> },
    {
      k: 'Facts read',
      v:
        d === null ? (
          <span className={ASIDE}>it has not reported yet</span>
        ) : (
          <span className={ASIDE}>
            <Ago at={d.at} />
          </span>
        ),
    },
  ]
}
