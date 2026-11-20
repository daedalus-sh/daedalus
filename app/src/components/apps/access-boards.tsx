// The Access tab's boards: where requests came from, who sent them, what
// they asked for, and what was refused.

import { type ReactNode, useEffect, useState } from 'react'
import type { AccessWindow } from '../../lib/access-window'
import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { useSite } from '../../lib/site-context'
import { type Tone, toneStyle } from '../../lib/tone'
import { EMPTY, FOOT } from '../tokens'
import { Button } from '../ui/button'
import { Board } from '../viz'
import type { AccessData } from './access'
import { GHOST_BTN } from './shared'

export function CountriesBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Countries" icon="⊕" span={4}>
      <Bars
        rows={access.byCountry.map((c) => ({
          key: c.code,
          label: (
            <>
              {c.flag && (
                <span className="text-[0.95rem] leading-none" aria-hidden="true">
                  {c.flag}
                </span>
              )}
              {c.name}
            </>
          ),
          count: c.count,
        }))}
        total={access.total}
        tone="muted"
      />
    </Board>
  )
}

export function ClientsBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Top clients" icon="◉" span={6}>
      <Bars
        rows={access.byClient.map((c) => ({
          key: c.ip,
          label: (
            <>
              <code>{c.ip}</code>
              {c.flag && (
                <span className="text-[0.95rem] leading-none" aria-hidden="true">
                  {c.flag}
                </span>
              )}
            </>
          ),
          count: c.count,
        }))}
        total={access.total}
        tone="muted"
      />
    </Board>
  )
}

export function PathsBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Top paths" icon="⇢" span={8}>
      <Bars
        rows={access.byPath.map((p) => ({
          key: `${p.path}-${p.status}`,
          label: (
            <>
              <StatusCode code={p.status} />
              <code title={p.path}>{p.path}</code>
            </>
          ),
          count: p.count,
        }))}
        total={access.total}
        tone="muted"
      />
    </Board>
  )
}

export function AgentsBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Top user agents" icon="◇" span={4}>
      <Bars
        rows={access.byAgent.map((a) => ({
          key: a.key,
          label: <span title={a.key}>{shortAgent(a.key)}</span>,
          count: a.count,
        }))}
        total={access.total}
        tone="muted"
      />
    </Board>
  )
}

export function RejectsBoard({
  access,
  grafanaUrl,
  range,
}: {
  access: AccessData
  grafanaUrl: string
  range: AccessWindow
}) {
  return (
    access.recentRejects.length > 0 && (
      <Board
        title="Recent rejected requests"
        icon="⊘"
        span={12}
        aside={
          <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
            <a
              href={`${grafanaUrl}/d/s2-security/security?from=now-${range}&to=now`}
              target="_blank"
              rel="noreferrer"
              className="hover:no-underline"
            >
              ↗ Grafana
            </a>
          </Button>
        }
      >
        <div className="flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto text-[0.8rem]">
          {access.recentRejects.map((r, i) => (
            // Phones: the four-column row has nowhere to go, so the
            // timestamp drops out and path + client share the width.
            <div
              key={`${r.ts}-${String(i)}`}
              className="grid grid-cols-[8.5rem_3rem_minmax(0,1fr)_auto] items-center gap-3 py-1 max-[34rem]:grid-cols-[3rem_minmax(0,1fr)] max-[34rem]:gap-y-0"
            >
              {/* Already formatted by the server — see RejectRow. */}
              <time
                className="font-mono text-[0.75rem] text-muted-foreground max-[34rem]:hidden"
                dateTime={r.ts}
              >
                {r.at}
              </time>
              <StatusCode code={r.status} />
              <span
                className="min-w-0 overflow-hidden font-mono text-[0.75rem] text-ellipsis whitespace-nowrap"
                title={`${r.method} ${r.path}`}
              >
                <span className="text-muted-foreground">{r.method}</span> {r.path}
              </span>
              <span
                className="flex items-center gap-1.5 whitespace-nowrap text-subdued max-[34rem]:col-start-2"
                title={r.agent}
              >
                {r.flag && <span aria-hidden="true">{r.flag}</span>}
                <code>{r.ip}</code>
              </span>
            </div>
          ))}
        </div>
        <p className={FOOT}>
          4xx and 5xx from the tunnel. Most of this is background noise: the internet scans every
          public hostname for WordPress paths within hours of the DNS record appearing, and a 404 is
          the correct answer. The line worth reading is a <em>succeeding</em> request to somewhere
          unexpected.
        </p>
      </Board>
    )
  )
}

/**
 * Where this host's remote requests came from, drawn here.
 *
 * Shaded from `access.geo`, the same Cf-Ipcountry counts the Countries board
 * lists, over Natural Earth outlines baked into world-map.json
 * (scripts/world-map.mjs). It used to be the App access dashboard's Grafana
 * geomap in an iframe, which came back as Pocket ID's refusal to be framed
 * whenever the browser held no Grafana session, i.e. most of the time.
 *
 * The outlines are a lazy chunk (~120 kB), so the frame holds its size until
 * they arrive. Shade is log-scaled: one country usually dominates, and a linear
 * scale would leave every other country at the floor.
 */
export function GeoPanel({
  access,
  hostname,
  range,
}: {
  access: AccessData
  hostname: string
  range: AccessWindow
}) {
  const { grafanaUrl } = useSite()
  const [map, setMap] = useState<WorldMap | null>(null)
  useEffect(() => {
    let live = true
    void import('./world-map.json').then((m) => {
      if (live) setMap(m.default as WorldMap)
    })
    return () => {
      live = false
    }
  }, [])

  const counts = new Map(access.geo.map((g) => [g.code, g.count]))
  const max = Math.max(1, ...counts.values())
  const shade = (n: number) => 0.25 + 0.75 * (Math.log(n + 1) / Math.log(max + 1))
  const label = (name: string, n: number | undefined) =>
    n === undefined ? name : `${name}: ${num(n)} request${n === 1 ? '' : 's'}`

  return (
    <Board
      title="Where from"
      icon="🌐"
      span={8}
      aside={
        <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
          <a
            href={`${grafanaUrl}/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
            target="_blank"
            rel="noreferrer"
            className="hover:no-underline"
          >
            ↗ Grafana
          </a>
        </Button>
      }
    >
      <div className="aspect-[1000/487] w-full">
        {map !== null && (
          <svg
            viewBox={map.viewBox}
            className="block h-full w-full"
            role="img"
            aria-label={`Remote requests to ${hostname} by country`}
          >
            {Object.entries(map.countries).map(([code, c]) => {
              const n = counts.get(code)
              return (
                <path
                  key={code}
                  d={c.d}
                  className={cn(
                    'stroke-background [stroke-width:0.5]',
                    n === undefined ? 'fill-foreground/[0.08]' : 'fill-primary',
                  )}
                  fillOpacity={n === undefined ? undefined : shade(n)}
                >
                  <title>{label(c.name, n)}</title>
                </path>
              )
            })}
            {Object.entries(map.dots).map(([code, c]) => {
              const n = counts.get(code)
              if (n === undefined) return null
              return (
                <circle
                  key={code}
                  cx={c.x}
                  cy={c.y}
                  r={3.5}
                  className="fill-primary stroke-background [stroke-width:1]"
                  fillOpacity={shade(n)}
                >
                  <title>{label(c.name, n)}</title>
                </circle>
              )
            })}
          </svg>
        )}
      </div>
      <p className={FOOT}>{ACCESS_NOTE}</p>
    </Board>
  )
}

type WorldMap = {
  viewBox: string
  countries: Record<string, { name: string; d: string }>
  dots: Record<string, { name: string; x: number; y: number }>
}

/** What this tab counts and where its map comes from. Folds behind the map's ⓘ, and the
    empty board's when there is nothing to map. */
export const ACCESS_NOTE =
  'Only tunnel traffic is counted. Loki keeps 30 days, so that is the longest window there is. The map counts the same Cf-Ipcountry header as the Countries board, and its Grafana link opens the App access dashboard filtered to this host; the link on the rejected-requests board opens the fleet-wide Security dashboard instead.'

/** Status code, coloured by class. Keyed on the first digit so a code the
    dashboard has never seen still lands in the right bucket. */
const STATUS_TONE: Record<string, Tone> = { '2': 'ok', '3': 'info', '4': 'warn', '5': 'bad' }

function StatusCode({ code }: { code: string }) {
  const tone = STATUS_TONE[code.slice(0, 1)]
  return (
    <span
      className={cn(
        'rounded-[5px] px-1.5 py-px font-mono text-[0.72rem]',
        tone === undefined
          ? 'bg-foreground/[0.06] text-subdued'
          : 'bg-[color-mix(in_oklch,var(--tone)_14%,transparent)] text-(--tone)',
      )}
      style={tone === undefined ? undefined : toneStyle(tone)}
    >
      {code}
    </span>
  )
}

/** A ranked list with a proportion bar. The ranking is the information. */
function Bars({
  rows,
  total,
  tone,
}: {
  rows: { key: string; label: ReactNode; count: number }[]
  total: number
  /** One per board, so four lists side by side stay tellable apart. */
  tone: Tone
}) {
  if (rows.length === 0) return <p className={EMPTY}>Nothing recorded.</p>
  // Scaled against the top row, not the grand total: with one dominant source
  // every other bar would round to an invisible sliver, and the point of the
  // bar is to compare the rows to each other.
  const top = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className="flex flex-col gap-2" style={toneStyle(tone)}>
      {rows.map((r) => (
        // The label column can shrink to nothing before the bar or the count
        // do — a truncated user-agent is readable, a 3px bar is not.
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-3 text-[0.82rem] max-[34rem]:grid-cols-[minmax(0,1fr)_3.5rem_auto]"
        >
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap [&>code]:overflow-hidden [&>code]:text-ellipsis">
            {r.label}
          </span>
          <span
            className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-(--tone)"
              style={{ width: `${String(Math.max(2, (r.count / top) * 100))}%` }}
            />
          </span>
          <span className="text-[0.8rem] tabular-nums whitespace-nowrap text-subdued">
            {num(r.count)}
            {total > 0 && (
              <small className="ml-1.5 text-muted-foreground">
                {((r.count / total) * 100).toFixed(0)}%
              </small>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

const BROWSER_NAME: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' }
const OS_NAME: Record<string, string> = {
  'Windows NT': 'Windows',
  Macintosh: 'macOS',
  CrOS: 'ChromeOS',
}

/** Browser/bot out of a user-agent string. The full text is in the title. */
function shortAgent(ua: string): string {
  if (ua === '' || ua === '-') return 'none'

  // Crawlers name themselves — Googlebot, GPTBot, bingbot, SemrushBot. Capture
  // the whole token, not the substring "bot", so three different crawlers do
  // not collapse into three identical rows.
  const bot = /([A-Za-z][A-Za-z0-9_.-]*(?:bot|crawler|spider))/i.exec(ua)
  if (bot) return bot[1] ?? 'bot'
  const tool = /^(curl|Wget|python-requests|Go-http-client|okhttp)/i.exec(ua)
  if (tool) return tool[1] ?? ''

  // Edge and Opera both carry a Chrome token as well, and it comes first — so
  // they have to be matched before it or every Edge visit reads as Chrome.
  const branded = /(Firefox|Edg|OPR)\/([0-9]+)/.exec(ua) ?? /(Chrome)\/([0-9]+)/.exec(ua)
  // Safari/604 is the WebKit build, not the browser version; Safari puts its
  // own in Version/.
  const safari = /Version\/([0-9]+)[^)]*Safari\//.exec(ua)

  let label: string
  if (branded) label = `${BROWSER_NAME[branded[1] ?? ''] ?? branded[1] ?? ''} ${branded[2] ?? ''}`
  else if (safari) label = `Safari ${safari[1] ?? ''}`
  else return ua.slice(0, 48)

  const os = /(Windows NT|Macintosh|iPhone|iPad|Android|Linux|CrOS)/.exec(ua)?.[1]
  return os === undefined ? label : `${label} · ${OS_NAME[os] ?? os}`
}
