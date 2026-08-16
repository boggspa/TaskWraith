/**
 * Main-owned confirmation for a consequential web Canvas action.
 *
 * Mirrors the native click dialog (NativeWindowConsentDialog): main-owned, one
 * exact action, value-free summary, cancel-by-default. The summary is
 * TaskWraith's own words built from the matched term — the page's label never
 * reaches this dialog, so a page cannot write the prose the human reads.
 */
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { dialog } from 'electron'

import type { CanvasConsequentialConfirmRequest } from './CanvasService'

export interface CanvasConsequentialDialogDependencies {
  showMessageBox: {
    (options: MessageBoxOptions): Promise<{ response: number }>
    (owner: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>
  }
}

const DEFAULT_DEPENDENCIES: CanvasConsequentialDialogDependencies = {
  showMessageBox: dialog.showMessageBox as CanvasConsequentialDialogDependencies['showMessageBox']
}

/** Bound anything that reaches the dialog, even our own strings. */
function boundedLabel(value: string | undefined, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return fallback
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed
}

/**
 * Show the origin without letting a long or crafted URL dominate the dialog.
 * Path and query are dropped: they are page-controlled and carry no authority.
 */
function originLabel(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export async function requestCanvasConsequentialConfirmation(
  owner: BrowserWindow | null,
  request: CanvasConsequentialConfirmRequest,
  dependencies: CanvasConsequentialDialogDependencies = DEFAULT_DEPENDENCIES
): Promise<boolean> {
  const summary = boundedLabel(request.summary, 'a page control')
  const origin = originLabel(request.url)
  const verb = request.action === 'fill' ? 'type into' : 'click'
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Allow one consequential action?',
    message: `Allow the agent to ${verb} ${summary}?`,
    detail:
      (origin ? `Page: ${origin}\n\n` : '') +
      'This authorizes one exact action, now. TaskWraith flagged it because the ' +
      'control looks irreversible or financial.\n\n' +
      'This check reads the page’s own labels, so it can miss a control that is ' +
      'named misleadingly. Treat it as a prompt to look, not a guarantee.',
    buttons: [`Allow one ${request.action}`, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const result = owner
    ? await dependencies.showMessageBox(owner, options)
    : await dependencies.showMessageBox(options)
  return result.response === 0
}
