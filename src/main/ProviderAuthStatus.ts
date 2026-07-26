import type {
  ProviderAuthState,
  ProviderAuthStatusV2,
  ProviderAuthServerState,
  ProviderAuthTransport,
  ProviderId
} from './store/types'

/** Inputs the pure builder needs. All Electron / IPC lookups happen
 * in the caller; this module stays test-friendly and side-effect free. */
export interface ProviderAuthStatusV2Input {
  provider: ProviderId
  available: boolean
  /** Raw `authState` from the upstream CLI / auth probe. */
  rawAuthState?: string | null
  /** True when a local API key is stored. */
  apiKeyConfigured?: boolean
  /** True when the Codex app-server JSON-RPC client is currently up. */
  codexClientStarted?: boolean
  /** Optional error string surfaced as `authReason` when unavailable. */
  errorReason?: string
}

const TRANSPORT_BY_PROVIDER: Record<ProviderId, ProviderAuthTransport> = {
  gemini: 'cli',
  codex: 'app-server',
  claude: 'sdk',
  kimi: 'cli',
  // Grok (gated, G3) runs via the local headless CLI stream.
  grok: 'cli',
  // Managed Cursor Path-B runs spawn the official headless Cursor CLI and use
  // its real CLI-owned login.
  cursor: 'cli',
  // Ollama runs through the local HTTP API rather than a cloud auth flow.
  ollama: 'http',
  // Opt-in antigravity wraps the user's official `agy` CLI (neutral placeholder;
  // real transport wiring lands with the runtime slice).
  antigravity: 'cli',
  // Pi is a spawned CLI; auth is BYOK env keys, never an interactive login.
  pi: 'cli'
}

const APPROVAL_SUPPORT_BY_PROVIDER: Record<ProviderId, boolean> = {
  gemini: true,
  codex: true,
  claude: false,
  kimi: true,
  // Read-only G3 has no approval flow yet (G5 will add write-capable runs).
  grok: false,
  // False means native Cursor tool calls are not individually mediated by the
  // main approval callback. Brokered TaskWraith calls still use the main gate.
  cursor: false,
  // Phase 1 local chat is read-only/no-tools.
  ollama: false,
  // No runtime/approval flow yet (opt-in provider).
  antigravity: false,
  // Pi ships no permission prompts; posture is enforced via its tool allowlist.
  pi: false
}

const MCP_STATUS_SUPPORT_BY_PROVIDER: Record<ProviderId, boolean> = {
  gemini: false,
  codex: true,
  claude: false,
  // Admitted Kimi seats receive TaskWraith's mandatory authenticated HTTP MCP
  // gateway. This reports the managed gateway surface, never provider-native
  // MCP configuration.
  kimi: true,
  // No TaskWraith MCP for Grok until G5.
  grok: false,
  // Cursor can attach the TaskWraith broker per run, but the CLI exposes no safe
  // structured probe for that run-local attachment state.
  cursor: false,
  // Ollama exposes a TaskWraith-local read-only tool loop through the adapter.
  ollama: true,
  // No TaskWraith MCP gateway for the opt-in provider yet.
  antigravity: false,
  // Pi has no MCP support (extensions are its plugin story); no bridge in v1.
  pi: false
}

export function buildProviderAuthStatusV2(input: ProviderAuthStatusV2Input): ProviderAuthStatusV2 {
  const { provider } = input
  const available = input.available !== false
  const codexReachable = provider === 'codex' && (available || input.codexClientStarted === true)

  let serverState: ProviderAuthServerState
  if (provider === 'codex') {
    if (input.codexClientStarted) serverState = 'started'
    else if (available) serverState = 'lazy'
    else serverState = 'unavailable'
  } else if (!available) {
    serverState = 'unavailable'
  } else {
    serverState = 'lazy'
  }

  const transport: ProviderAuthTransport =
    available || codexReachable ? TRANSPORT_BY_PROVIDER[provider] : 'unavailable'

  const { authState, authReason } = deriveAuthState(input, available || codexReachable)

  return {
    provider,
    serverState,
    transport,
    approvalSupport: APPROVAL_SUPPORT_BY_PROVIDER[provider],
    mcpStatusSupport: MCP_STATUS_SUPPORT_BY_PROVIDER[provider],
    authState,
    ...(authReason ? { authReason } : {})
  }
}

function deriveAuthState(
  input: ProviderAuthStatusV2Input,
  available: boolean
): { authState: ProviderAuthState; authReason?: string } {
  const { provider, rawAuthState, apiKeyConfigured, errorReason } = input

  if (!available) {
    return {
      authState: 'missing',
      authReason:
        errorReason ||
        (provider === 'ollama' ? 'Ollama service not reachable' : `${provider} CLI not available`)
    }
  }

  if (provider === 'codex') {
    const normalized = String(rawAuthState || '').trim().toLowerCase()
    if (normalized === 'missing' || normalized === 'expired') {
      return {
        authState: normalized,
        authReason:
          errorReason ||
          (normalized === 'expired'
            ? 'TaskWraith Codex sign-in has expired.'
            : 'TaskWraith Codex sign-in is required.')
      }
    }
    if (
      normalized === 'authenticated' ||
      normalized === 'chatgpt' ||
      normalized === 'api-key' ||
      normalized === 'apikey' ||
      normalized === 'not-required'
    ) {
      return { authState: 'authenticated' }
    }
    return {
      authState: 'not-queried',
      authReason:
        errorReason || 'Codex app-server account/read did not return a definitive auth state.'
    }
  }

  if (provider === 'gemini') {
    if (apiKeyConfigured) return { authState: 'authenticated' }
    if (rawAuthState === 'oauth-login-required') {
      return { authState: 'missing', authReason: 'Gemini OAuth login required' }
    }
    if (rawAuthState === 'incomplete') {
      return { authState: 'missing', authReason: 'Gemini auth profile incomplete' }
    }
    if (
      rawAuthState === 'api-key' ||
      rawAuthState === 'google-oauth' ||
      rawAuthState === 'vertex-ai'
    ) {
      return { authState: 'authenticated' }
    }
    return { authState: 'not-queried' }
  }

  if (provider === 'claude') {
    if (apiKeyConfigured) return { authState: 'authenticated' }
    if (rawAuthState === 'authenticated' || rawAuthState === 'api-key') {
      return { authState: 'authenticated' }
    }
    if (rawAuthState === 'missing') {
      return { authState: 'missing', authReason: 'Claude CLI reports no credentials' }
    }
    return {
      authState: 'not-observable',
      authReason: 'Claude CLI did not return a known auth state'
    }
  }

  if (provider === 'grok') {
    // Read-only G3 does not probe Grok credentials (no token-file reads).
    // An unauthenticated run surfaces its own error on stderr at run time.
    return {
      authState: 'not-observable',
      authReason: 'Grok auth not probed (read-only)'
    }
  }

  if (provider === 'ollama') {
    return { authState: 'authenticated' }
  }

  if (provider === 'cursor') {
    const normalized = String(rawAuthState || '')
      .trim()
      .toLowerCase()
    if (
      normalized === 'authenticated' ||
      normalized === 'oauth' ||
      normalized === 'api-key'
    ) {
      return { authState: 'authenticated' }
    }
    if (
      normalized === 'missing' ||
      normalized === 'unauthenticated' ||
      normalized === 'not authenticated' ||
      normalized === 'not logged in'
    ) {
      return {
        authState: 'missing',
        authReason: 'Cursor CLI reports no current login'
      }
    }
    return {
      authState: 'not-observable',
      authReason: 'Cursor CLI credential state was not exposed by the status probe'
    }
  }

  if (provider === 'antigravity') {
    if (rawAuthState === 'api-key' || rawAuthState === 'authenticated') {
      return { authState: 'authenticated' }
    }
    if (rawAuthState === 'consent-required' || rawAuthState === 'missing') {
      return {
        authState: 'missing',
        authReason:
          rawAuthState === 'consent-required'
            ? 'AntiGravity consent and credentials are required'
            : 'AntiGravity credentials are missing'
      }
    }
    return {
      authState: 'not-observable',
      authReason: 'AntiGravity credential state was not exposed by the selected transport'
    }
  }

  if (provider === 'pi') {
    const normalized = String(rawAuthState || '')
      .trim()
      .toLowerCase()
    if (normalized === 'api-key' || normalized === 'authenticated') {
      return { authState: 'authenticated' }
    }
    if (normalized === 'missing') {
      return {
        authState: 'missing',
        authReason: 'Pi has no configured upstream API key'
      }
    }
    return {
      authState: 'not-observable',
      authReason: 'Pi upstream key state was not exposed by the status probe'
    }
  }

  // Managed Kimi ACP auth is observed from the admitted runtime's CURRENT
  // ~/.kimi-code home: OAuth or a provider key in that home's config.toml.
  // `apiKeyConfigured` describes the separate encrypted Settings key used for
  // usage queries; it must never authenticate a managed run by implication.
  const normalized = String(rawAuthState || '')
    .trim()
    .toLowerCase()
  if (normalized === 'oauth' || normalized === 'api-key' || normalized === 'authenticated') {
    return { authState: 'authenticated' }
  }
  if (
    normalized === 'missing' ||
    normalized === 'unauthenticated' ||
    normalized === 'not authenticated' ||
    normalized === 'not logged in'
  ) {
    return {
      authState: 'missing',
      authReason: 'Kimi Code reports no current OAuth login or config.toml provider API key'
    }
  }
  return {
    authState: 'not-observable',
    authReason: 'Kimi credential state was not observed from the admitted runtime'
  }
}
