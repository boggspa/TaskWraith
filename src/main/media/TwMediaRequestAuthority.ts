import { parseTwMediaUrl } from './twMediaRange'

export type TwMediaWebContentsAuthority =
  | { kind: 'main' }
  | { kind: 'chat'; appChatId: string }

export interface TwMediaRequestDetails {
  url: string
  method: string
  webContentsId?: number
}

export interface TwMediaRequestAuthorityDeps {
  /** Main-owned lookup. Unknown and non-chat secondary renderers return null. */
  resolveWebContentsAuthority: (
    webContentsId: number
  ) => TwMediaWebContentsAuthority | null | undefined
  owns: (input: { sha256: string; mimeType: string; appChatId: string }) => boolean
}

export function isTwMediaRequestAuthorized(
  details: TwMediaRequestDetails,
  deps: TwMediaRequestAuthorityDeps
): boolean {
  const method = details.method.toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return false
  if (!Number.isSafeInteger(details.webContentsId) || (details.webContentsId ?? 0) <= 0) {
    return false
  }
  const asset = parseTwMediaUrl(details.url)
  if (!asset) return false
  try {
    const authority = deps.resolveWebContentsAuthority(details.webContentsId as number)
    if (authority?.kind === 'main') return true
    if (authority?.kind !== 'chat' || !authority.appChatId) return false
    return deps.owns({
      sha256: asset.sha256,
      mimeType: asset.mime,
      appChatId: authority.appChatId
    })
  } catch {
    return false
  }
}

/** Electron `webRequest.onBeforeRequest`-compatible, synchronous fail-closed gate. */
export function createTwMediaRequestGate(deps: TwMediaRequestAuthorityDeps) {
  return (
    details: TwMediaRequestDetails,
    callback: (response: { cancel: boolean }) => void
  ): void => {
    callback({ cancel: !isTwMediaRequestAuthorized(details, deps) })
  }
}
