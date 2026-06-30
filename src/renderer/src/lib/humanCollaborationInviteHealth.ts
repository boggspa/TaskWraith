export interface HumanCollaborationRelayAvailability {
  relayUrls: string[]
  lanAvailable: boolean
  remoteAvailable: boolean
  loopbackOnly: boolean
}

export interface HumanCollaborationInviteHealth {
  chatAvailable: boolean
  shareEnabled: boolean
  bridgeEnabled: boolean
  bridgeRunning: boolean
  bridgeError: string
  relayUrls: string[]
  lanAvailable: boolean
  remoteAvailable: boolean
  tailscaleConfigured: boolean
  tailscaleSuggestedUrl: string
  tailscaleReason: string
}

export type HumanCollaborationInviteCopyFailureCode =
  | 'chat-unavailable'
  | 'share-disabled'
  | 'bridge-stopped'
  | 'no-relay-url'
  | 'clipboard-failed'
  | 'unknown'

export type HumanCollaborationInviteCopyResult =
  | {
      ok: true
      copied: boolean
      invitePayload: string
      relayUrls: string[]
      relayWarning: string
      availability: HumanCollaborationRelayAvailability
      health: HumanCollaborationInviteHealth
      message: string
    }
  | {
      ok: false
      code: HumanCollaborationInviteCopyFailureCode
      message: string
      invitePayload?: string
      relayUrls?: string[]
      relayWarning?: string
      availability?: HumanCollaborationRelayAvailability
      health?: HumanCollaborationInviteHealth
      canCopyLanOnly?: boolean
    }

export function classifyHumanCollaborationRelayUrls(
  relayUrls: readonly string[] | null | undefined
): HumanCollaborationRelayAvailability {
  const urls = Array.from(
    new Set(
      (Array.isArray(relayUrls) ? relayUrls : [])
        .map((url) => (typeof url === 'string' ? url.trim() : ''))
        .filter(Boolean)
    )
  )
  let lanAvailable = false
  let remoteAvailable = false
  let loopbackOnly = urls.length > 0

  for (const url of urls) {
    const kind = classifyRelayUrl(url)
    if (kind !== 'loopback') loopbackOnly = false
    if (kind === 'lan') lanAvailable = true
    if (kind === 'remote') remoteAvailable = true
  }

  return {
    relayUrls: urls,
    lanAvailable,
    remoteAvailable,
    loopbackOnly
  }
}

function classifyRelayUrl(url: string): 'loopback' | 'lan' | 'remote' {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.startsWith('127.')
    ) {
      return 'loopback'
    }
    if (parsed.protocol === 'wss:') return 'remote'
    if (
      hostname.endsWith('.ts.net') ||
      hostname.endsWith('.tailnet') ||
      hostname.endsWith('.tailscale.net')
    ) {
      return 'remote'
    }
    if (
      hostname.endsWith('.local') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('192.168.') ||
      isPrivate172Address(hostname)
    ) {
      return 'lan'
    }
    return parsed.protocol === 'ws:' ? 'lan' : 'remote'
  } catch {
    return 'remote'
  }
}

function isPrivate172Address(hostname: string): boolean {
  const match = /^172\.(\d{1,3})\./.exec(hostname)
  if (!match) return false
  const secondOctet = Number(match[1])
  return Number.isInteger(secondOctet) && secondOctet >= 16 && secondOctet <= 31
}
