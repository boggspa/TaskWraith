// Schedule/copy helpers extracted from `src/renderer/src/App.tsx` (Wave 2 W2-B).
// Pure helpers with zero renderer -> main imports — intentionally architecture-safe.
// Behaviour-preserving move: bodies are byte-identical to the App.tsx originals,
// with `export` added. App.tsx reimports from here.
export const STREAM_FLUSH_ITEM_KEY_SEPARATOR = '\u0000'

export function streamFlushItemKey(runId: string, itemId?: string): string {
  return `${runId}${STREAM_FLUSH_ITEM_KEY_SEPARATOR}${itemId || ''}`
}

export function runIdFromStreamFlushItemKey(key: string): string {
  const separatorIndex = key.indexOf(STREAM_FLUSH_ITEM_KEY_SEPARATOR)
  return separatorIndex >= 0 ? key.slice(0, separatorIndex) : key
}

export function compactShortcutHint(keys: string[]): string {
  if (keys.length === 0 || keys[0] === 'Unassigned') return ''
  return keys
    .map((key) => {
      if (key === 'Cmd/Ctrl') return '⌘'
      if (key === 'Shift') return '⇧'
      if (key === 'Alt') return '⌥'
      return key
    })
    .join('')
}

export function scheduleAfterPaint(callback: () => void, timeout = 700): () => void {
  if (typeof window === 'undefined') return () => {}
  const win = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }
  let cancelled = false
  const run = () => {
    if (!cancelled) callback()
  }
  if (typeof win.requestIdleCallback === 'function') {
    const handle = win.requestIdleCallback(run, { timeout })
    return () => {
      cancelled = true
      win.cancelIdleCallback?.(handle)
    }
  }
  let timeoutHandle: number | null = null
  const rafHandle = window.requestAnimationFrame(() => {
    timeoutHandle = window.setTimeout(run, 0)
  })
  return () => {
    cancelled = true
    window.cancelAnimationFrame(rafHandle)
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
  }
}

export function scheduleAfterNextPaint(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  let cancelled = false
  let timeoutHandle: number | null = null
  const rafHandle = window.requestAnimationFrame(() => {
    timeoutHandle = window.setTimeout(() => {
      if (!cancelled) callback()
    }, 0)
  })
  return () => {
    cancelled = true
    window.cancelAnimationFrame(rafHandle)
    if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
  }
}

export function appendMessageContentToPromptDraft(previous: string, content: string): string {
  const addition = content.trim()
  if (!addition) return previous
  if (!previous.trim()) return addition
  const separator = previous.endsWith('\n\n') ? '' : previous.endsWith('\n') ? '\n' : '\n\n'
  return `${previous}${separator}${addition}`
}

export function hasGitSnapshotSubscriptionApi(): boolean {
  return (
    typeof (window.api as { gitSubscribeSnapshot?: unknown }).gitSubscribeSnapshot === 'function'
  )
}
