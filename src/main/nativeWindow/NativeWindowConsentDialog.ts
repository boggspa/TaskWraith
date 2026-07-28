import { dialog, type BrowserWindow, type MessageBoxOptions } from 'electron'

import type {
  NativeWindowCoordinatorCaptureConsentRequest,
  NativeWindowCoordinatorConsentDecision,
  NativeWindowCoordinatorConsentRequest
} from './NativeWindowCoordinator'
import type { CanvasWindowClickAuthorizationRequest } from '../canvas/CanvasWindowDriver'

export interface NativeWindowConsentDialogDependencies {
  showMessageBox: typeof dialog.showMessageBox
}

const DEFAULT_DEPENDENCIES: NativeWindowConsentDialogDependencies = {
  showMessageBox: dialog.showMessageBox.bind(dialog)
}

/**
 * Collects Screen Watch consent. Capture is always decided first; only an
 * eligible, capture-consented attachment can then ask for View & Control.
 */
export async function requestNativeWindowControlConsent(
  owner: BrowserWindow | null,
  request: NativeWindowCoordinatorConsentRequest,
  dependencies: NativeWindowConsentDialogDependencies = DEFAULT_DEPENDENCIES
): Promise<NativeWindowCoordinatorConsentDecision> {
  if (request.kind === 'capture') {
    return requestNativeWindowCaptureConsent(owner, request, dependencies)
  }
  const applicationName = boundedLabel(request.applicationName, 'Selected application')
  const windowTitle = boundedLabel(request.windowTitle, 'Untitled window')
  const provider = boundedLabel(request.provider, 'active provider')
  const minutes = Math.max(1, Math.ceil(request.expiresInMs / 60_000))
  const verbs = boundedLabel(request.allowedVerbs.join(', '), 'approved actions')
  const frameEgress = boundedLabel(
    request.frameEgress.disclosure,
    'Frame-egress details are unavailable.'
  )
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Allow View & Control?',
    message: `Allow ${provider} to control “${applicationName}”?`,
    detail:
      `Exact window: “${windowTitle}”\n\n` +
      `${frameEgress}\n\n` +
      `Control is limited to ${verbs}; ${request.stepBudget} action steps; ` +
      `and expires in about ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
      'TaskWraith will observe again after every action. Password and secure fields are refused.',
    buttons: ['View & Control', 'View only', 'Cancel'],
    defaultId: 1,
    cancelId: 2,
    noLink: true
  }
  const result = owner
    ? await dependencies.showMessageBox(owner, options)
    : await dependencies.showMessageBox(options)
  if (result.response === 0) return 'control'
  if (result.response === 1) return 'view'
  return 'cancel'
}

/**
 * Content-bound, per-click confirmation for a native-window Canvas action.
 * This deliberately receives only a semantic target summary and chat context;
 * lease/process/handle data stays main-owned and never enters the dialog.
 */
export async function requestNativeWindowClickAuthorization(
  owner: BrowserWindow | null,
  request: CanvasWindowClickAuthorizationRequest,
  dependencies: NativeWindowConsentDialogDependencies = DEFAULT_DEPENDENCIES
): Promise<boolean> {
  const chatId = boundedLabel(request.scope?.chatId, 'this chat')
  const summary = boundedLabel(request.semanticSummary, 'the selected control')
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Allow one native click?',
    message: `Allow one click on “${summary}”?`,
    detail:
      `Chat: “${chatId}”\n\n` +
      'This confirms one exact click only. Once allowed and accepted, the exact click may complete even if the window is detached immediately afterward.',
    buttons: ['Allow one click', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const result = owner
    ? await dependencies.showMessageBox(owner, options)
    : await dependencies.showMessageBox(options)
  return result.response === 0
}

async function requestNativeWindowCaptureConsent(
  owner: BrowserWindow | null,
  request: NativeWindowCoordinatorCaptureConsentRequest,
  dependencies: NativeWindowConsentDialogDependencies
): Promise<NativeWindowCoordinatorConsentDecision> {
  const applicationName = boundedLabel(request.applicationName, 'Selected application')
  const windowTitle = boundedLabel(request.windowTitle, 'Untitled window')
  const provider = boundedLabel(request.provider, 'the active chat provider')
  const chatId = boundedLabel(request.chatId, 'this chat')
  const frameEgress = boundedLabel(
    request.frameEgress.disclosure,
    'Frame-egress details are unavailable.'
  )
  const options: MessageBoxOptions = {
    type: 'warning',
    title: 'Allow Screen Watch?',
    message: `Allow ${provider} to view “${applicationName}”?`,
    detail:
      `Chat: “${chatId}”\n` +
      `Exact window: “${windowTitle}”\n\n` +
      `${frameEgress}\n\n` +
      'Screen Watch can include sensitive UI, pixels, and OCR text. This grants view-only frame capture for this chat. It does not allow clicks or typing; View & Control requires a separate prompt.',
    buttons: ['Allow view-only', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }
  const result = owner
    ? await dependencies.showMessageBox(owner, options)
    : await dependencies.showMessageBox(options)
  return result.response === 0 ? 'view' : 'cancel'
}

function boundedLabel(value: unknown, fallback: string): string {
  const normalized =
    typeof value === 'string' ? stripDisguisingCodePoints(value).trim().replace(/\s+/g, ' ') : ''
  if (!normalized) return fallback
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}…`
}

function stripDisguisingCodePoints(value: string): string {
  let cleaned = ''
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index)
    cleaned += isDisguisingCodePoint(codePoint) ? ' ' : value[index]
  }
  return cleaned
}

function isDisguisingCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    codePoint === 0x2060 ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  )
}
