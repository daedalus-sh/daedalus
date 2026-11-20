import { cn } from '../../lib/cn'
import type { T3Device } from '../../lib/dashboard/t3code'
import { DASH, num } from '../../lib/format'
import { Ago, Until } from '../ago'
import {
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../table'
import { TableSection } from '../table-section'
import { FOOT } from '../tokens'
import { Chip } from '../viz'
import { GAP_SUB, isBot, type T3Facts } from './facts'

/* device · access · seen · expires. */
const GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_7rem_7rem_5rem]',
  '@max-[34rem]/table:grid-cols-[minmax(0,1fr)_auto]',
)
const PHONE_HIDE = '@max-[34rem]/table:hidden'

/**
 * Everything holding a session on the server: people's devices first, then
 * the sessions the box minted for its own helpers.
 */
export function DevicesBoard({ f }: { f: T3Facts }) {
  const all = f.live?.devices ?? []
  const devices = [...all.filter((d) => !isBot(d)), ...all.filter(isBot)]
  const full = all.filter((d) => d.fullAccess).length
  return (
    <TableSection
      title="Devices"
      aside={
        f.live === null
          ? undefined
          : full === 0
            ? `${num(all.length)} sessions`
            : `${num(all.length)} sessions · ${num(full)} with full access`
      }
    >
      <ul className={TABLE}>
        <li aria-hidden="true" className={cn(GRID, TABLE_HEAD)}>
          <span>Device</span>
          <span>Access</span>
          <span className={PHONE_HIDE}>Seen</span>
          <span className={cn('text-right', PHONE_HIDE)}>Expires</span>
        </li>
        {devices.length === 0 && (
          <li className={TABLE_EMPTY}>
            {f.gap !== null
              ? `Nothing to show: ${GAP_SUB[f.gap]}.`
              : 'Nothing is paired. A pairing link made on the server pairs the first browser.'}
          </li>
        )}
        {devices.map((d, i) => (
          <DeviceRow key={`${String(i)}:${d.subject}:${d.issuedAt ?? ''}`} d={d} />
        ))}
      </ul>
      <p className={FOOT}>
        A paired device holds a session until it expires or is revoked in T3 Code. Full access means
        the session may open a terminal, which is a shell on the server as the user the server runs
        as: treat it like an SSH key. The box&rsquo;s own sessions are the ones its helpers use to
        read this page&rsquo;s numbers and to add projects.
      </p>
    </TableSection>
  )
}

function DeviceRow({ d }: { d: T3Device }) {
  const bot = isBot(d)
  const what = bot
    ? 'the box’s own session'
    : [d.deviceType, d.os, d.browser].filter((x) => x !== null && x !== '').join(' · ')
  return (
    <li className={cn(GRID, TABLE_ROW)}>
      <span className="flex min-w-0 flex-col">
        <span className={CELL_NAME}>{d.label ?? (bot ? 'Unnamed session' : 'Unnamed device')}</span>
        <span className={CELL_SUB}>{what === '' ? 'no details reported' : what}</span>
      </span>
      <span className="flex">
        {d.fullAccess ? (
          <Chip tone="warn" title="This session may open a terminal on the server.">
            full access
          </Chip>
        ) : (
          <span className={CELL_QUIET}>no terminal</span>
        )}
      </span>
      <span className={cn(CELL_QUIET, PHONE_HIDE)}>
        {d.connected ? (
          'connected'
        ) : d.lastConnectedAt === null ? (
          'never'
        ) : (
          <Ago at={d.lastConnectedAt} />
        )}
      </span>
      <span className={cn(CELL_QUIET, PHONE_HIDE, 'text-right')}>
        {d.expiresAt === null ? DASH : <Until at={d.expiresAt} />}
      </span>
    </li>
  )
}
