import { Ago } from '../../../../components/ago'
import { Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../../../components/viz'
import { deviceFactsFrom, lightKind } from '../../../../lib/agent/light'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { bytes, DASH, pct } from '../../../../lib/format'
import { EMPTY, FOOT, lightOsName, loadTone, MONO, NOTE, share } from './shared'

/* ── Device ───────────────────────────────────────────────────────────── */

/**
 * A phone's or tablet's first tab: what it is and how it stands.
 *
 * A light node (lib/agent/light.ts) is connected only while its app is open,
 * so most of the time the controller holds nothing for it. The tab reads the
 * live document when there is one and, when there is not, what the box kept
 * from the device's last connection — the same facts, with the time they were
 * read beside them. Being away is the device's usual state and is said as
 * when it was last seen, never as a fault.
 */
export function NodeDeviceView({ d }: { d: NodeSystemData }) {
  const { node } = d
  const live = d.telemetry !== null
  // The live document over what the row kept: a field the device did not
  // send this time keeps its last value.
  const f =
    deviceFactsFrom(
      {
        status: d.status,
        telemetry: d.telemetry,
        model: null,
        agent_version: node.agentVersion,
      },
      node.device,
      d.telemetry?.sampled_at ?? node.lastSeenAt,
    ) ?? node.device
  const kind = lightKind(node.os)

  if (f === null) {
    return (
      <p className={EMPTY}>
        {node.name} has not reported yet. It says what it is the first time its app is open and
        connected to the box.
      </p>
    )
  }

  const battery = f.battery
  const total = f.storage?.totalBytes ?? null
  const free = f.storage?.freeBytes ?? null
  const used = total === null || free === null ? null : total - free
  const usedPct = share(used, total)

  return (
    <BoardGrid>
      <Board
        title={`This ${kind}`}
        icon="▯"
        span={4}
        aside={
          <span className={NOTE}>
            {live ? 'live' : 'read'} <Ago at={f.at} />
          </span>
        }
      >
        <Facts
          rows={[
            { k: 'Model', v: f.model === null ? DASH : <span className={MONO}>{f.model}</span> },
            {
              k: lightOsName(node.os),
              v: f.osVersion === null ? DASH : <span className={MONO}>{f.osVersion}</span>,
            },
            {
              k: 'App',
              v: <span className={MONO}>{f.appVersion ?? node.agentVersion}</span>,
            },
            { k: 'Memory', v: bytes(f.memoryBytes) },
            {
              k: 'Link',
              v:
                node.connected === null ? (
                  'unknown'
                ) : node.connected ? (
                  'connected'
                ) : (
                  <>
                    last seen <Ago at={node.lastSeenAt} />
                  </>
                ),
            },
            { k: 'Facts read', v: <Ago at={f.at} /> },
          ]}
        />
        <p className={FOOT}>
          A {kind} is connected only while Daedalus is open on it, so these are what it said the
          last time it was, kept by the box. It runs no Claude and no model server, and the box asks
          nothing of it.
        </p>
      </Board>

      <Board
        title="Battery"
        icon="▮"
        span={4}
        aside={
          battery !== null &&
          battery.charging !== null && (
            <Chip tone={battery.charging ? 'ok' : 'muted'}>
              {battery.charging ? 'charging' : 'on battery'}
            </Chip>
          )
        }
      >
        {battery === null || battery.percent === null ? (
          <p className={EMPTY}>not reported</p>
        ) : (
          <>
            <Measures items={[{ k: 'charge', v: pct(battery.percent, 0) }]} />
            <Progress pct={battery.percent} tone="muted" />
          </>
        )}
        <p className={FOOT}>
          {live ? 'As the device reads it now.' : 'As of the last time the device was connected.'}{' '}
          iOS tells an app the charge and whether it is charging, and nothing about the
          battery&rsquo;s health or cycles.
        </p>
      </Board>

      <Board title="Storage" icon="◫" span={4}>
        {total === null ? (
          <p className={EMPTY}>not reported</p>
        ) : (
          <>
            <Measures
              items={[
                { k: 'used', v: bytes(used) },
                { k: 'free', v: bytes(free) },
                { k: 'total', v: bytes(total) },
              ]}
            />
            <Progress pct={usedPct} tone={loadTone(usedPct)} />
          </>
        )}
        <p className={FOOT}>
          The device&rsquo;s own volume, as iOS counts it for an app: free is what could be written
          now, which iOS can enlarge by clearing caches.
        </p>
      </Board>
    </BoardGrid>
  )
}
