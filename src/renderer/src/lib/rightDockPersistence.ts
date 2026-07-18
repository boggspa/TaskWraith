import { RIGHT_DOCK_PANEL_IDS, type RightDockTab } from './rightDockState'

/**
 * Per-CONTEXT memory of the last-selected right-dock surface for this window
 * session.
 *
 * The active dock surface is ephemeral React state (App.tsx `useState('run')`)
 * with no memory — every context switch dropped back to Run. This stores the
 * chosen surface per context in sessionStorage so destinations survive
 * switching around without carrying dock chrome across a cold launch.
 *
 * A context is either a chat (`chat:<chatId>`, stored under the bare chatId
 * for continuity with pre-context entries) or a Work project
 * (`work:<projectId>`). Contextual keying replaces the push/pop dock
 * juggling the right-dock redesign burned us on: entering Work reads the
 * project's own remembered surface, leaving Work reads the chat's — there is
 * no save/restore lifecycle to get wrong after a reload.
 *
 * Best-effort: missing/blocked sessionStorage or an unknown id degrades to
 * "no memory", never throws. Values are validated against
 * RIGHT_DOCK_PANEL_IDS on read.
 */

const KEY_PREFIX = 'taskwraith.rightDockSurface.'

export type DockSurfaceContext =
  | { kind: 'chat'; chatId: string }
  | { kind: 'work'; projectId: string }

/** Membership slice the resolver needs; matches the shared Project record. */
export interface DockContextProjectLike {
  id: string
  memberChatIds: readonly string[]
}

/**
 * Which context owns the dock right now. On the Work tab a focused chat that
 * belongs to exactly ONE project keys by that project — switching between the
 * project's member threads retains the project's dock surface. Ambiguous
 * membership (a chat shared across projects) falls back to the chat's own
 * key rather than guessing, and every non-Work surface keys by chat.
 */
export function resolveDockSurfaceContext(input: {
  activeSidebarTab: string | null | undefined
  activeProjectId?: string | null
  chatId: string | null | undefined
  projects: ReadonlyArray<DockContextProjectLike>
}): DockSurfaceContext | null {
  if (input.activeSidebarTab === 'projects') {
    const activeProjectId = input.activeProjectId?.trim()
    if (activeProjectId && input.projects.some((project) => project.id === activeProjectId)) {
      return { kind: 'work', projectId: activeProjectId }
    }
  }
  const chatId = input.chatId?.trim()
  if (!chatId) return null
  if (input.activeSidebarTab === 'projects') {
    const owners = input.projects.filter((project) => project.memberChatIds.includes(chatId))
    if (owners.length === 1) return { kind: 'work', projectId: owners[0].id }
  }
  return { kind: 'chat', chatId }
}

function keyFor(context: DockSurfaceContext): string {
  return context.kind === 'work'
    ? `${KEY_PREFIX}work:${context.projectId}`
    : `${KEY_PREFIX}${context.chatId}`
}

export function readDockSurface(context: DockSurfaceContext | null): RightDockTab | null {
  if (!context) return null
  try {
    const raw = window.sessionStorage.getItem(keyFor(context))
    if (raw && (RIGHT_DOCK_PANEL_IDS as readonly string[]).includes(raw)) {
      return raw as RightDockTab
    }
  } catch {
    // sessionStorage unavailable / blocked — persistence is best-effort.
  }
  return null
}

export function writeDockSurface(context: DockSurfaceContext | null, tab: RightDockTab): void {
  if (!context) return
  try {
    window.sessionStorage.setItem(keyFor(context), tab)
  } catch {
    // best-effort — a failed write just means this context won't remember.
  }
}
