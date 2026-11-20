import type { Ctx } from '../ctx'
import { saveSiteEdit, siteEdit } from './index'

// The projects a coding-agent server keeps out of its list, switched from
// its page.
//
// site.json `modules.hiddenProjects.<id>` lists workspace roots; every other
// project stays shown, so an empty list is the default and leaves the
// document. nix/platform/site.nix hands it to the stack as
// `fleet.site.hiddenProjects.<id>`. Like every site edit it goes to the draft
// and lands on the next Apply; what the server does with it is the stack's
// business (T3 Code's sync stops adding the project and removes it while it
// holds no thread).

/** The modules whose page has the switch. */
const MODULES = ['t3code'] as const

export type HidingModule = (typeof MODULES)[number]

export const isHidingModule = (id: string): id is HidingModule =>
  (MODULES as readonly string[]).includes(id)

/** An absolute path on one line: it reaches a shell script as one line of a list. */
export const ROOT = /^\/[^\n\r\0]{0,511}$/

/** The hidden roots as committed, and as the next Apply would write them. */
export async function hiddenProjects(
  ctx: Ctx,
  id: HidingModule,
): Promise<{ committed: string[]; desired: string[] }> {
  const edit = await siteEdit(ctx)
  return {
    committed: edit.committed?.modules.hiddenProjects[id] ?? [],
    desired: edit.desired.modules.hiddenProjects[id] ?? [],
  }
}

/** Show or hide one project on the draft. Idempotent: the same switch twice is one edit. */
export async function setProjectShown(
  ctx: Ctx,
  id: HidingModule,
  root: string,
  shown: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!ROOT.test(root)) return { ok: false, reason: 'a project is named by its absolute path' }
  const edit = await siteEdit(ctx)
  const all = { ...edit.desired.modules.hiddenProjects }
  const rest = (all[id] ?? []).filter((r) => r !== root)
  const next = shown ? rest : [...rest, root].sort()
  if (next.length === 0) delete all[id]
  else all[id] = next
  await saveSiteEdit(ctx, { 'modules.hiddenProjects': all })
  return { ok: true }
}
