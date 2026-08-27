import type { GeminiAuthStatus, ProviderApiKeyStatus } from '../../../main/store/types'

export type ProviderAuthVariant =
  | 'signed-in'
  | 'partial'
  | 'not-signed-in'
  | 'not-available'
  /** Signed in, but the provider's quota window is at ~100% so runs
   * are rate-limited. Surfaced by FirstLaunchSheet from usageSummary —
   * the state a tester hits that otherwise reads as "broken". */
  | 'out-of-usage'

export interface ProviderAuthSummary {
  variant: ProviderAuthVariant
  statusText: string
  hint: string
}

/** Mistral Vibe reports credential presence through its own `_auth/status`
 * ACP extension. TaskWraith consumes only that boolean/source metadata; it
 * never opens, copies, or stores Vibe's keyring item or credential file. */
export function summariseMistralVibeStatus(status: unknown): ProviderAuthSummary {
  const record = status && typeof status === 'object' ? (status as Record<string, unknown>) : null
  if (!record) {
    return {
      variant: 'not-signed-in',
      statusText: 'Mistral setup not checked yet',
      hint: 'Open Terminal to run `vibe --setup`.'
    }
  }
  if (record.available === false) {
    return {
      variant: 'not-available',
      statusText: 'Mistral Vibe CLI not found',
      hint:
        'Install Mistral Vibe first, then use `vibe --setup` to finish the Mistral plan or API-key setup.'
    }
  }

  const authState = String(record.authState || '').trim().toLowerCase()
  const credentialPresent = record.credentialPresent
  if (credentialPresent === true || ['authenticated', 'api-key', 'oauth'].includes(authState)) {
    return {
      variant: 'signed-in',
      statusText: 'Mistral Vibe signed in',
      hint: "Verified through Mistral Vibe's credential-opaque ACP status. TaskWraith did not read or store the credential."
    }
  }
  if (
    credentialPresent === false ||
    ['missing', 'signed-out', 'signed_out', 'unauthenticated'].includes(authState)
  ) {
    return {
      variant: 'not-signed-in',
      statusText: 'Mistral Vibe not signed in',
      hint: 'Open Terminal to run `vibe --setup` and complete Mistral Vibe sign-in.'
    }
  }

  return {
    variant: 'partial',
    statusText: 'Vibe CLI ready · sign-in status unavailable',
    hint: 'TaskWraith could not get the credential-opaque auth status from Vibe. Upgrade Vibe, or run `vibe --setup` if sign-in is incomplete.'
  }
}

/**
 * Muse Code opaque CLI status. Binary presence is knowable; Meta Model API
 * credential state is owned by Muse's relocated auth path — do not treat a
 * resolvable binary alone as "signed in".
 */
export function summariseMuseCodeStatus(status: unknown): ProviderAuthSummary {
  const record = status && typeof status === 'object' ? (status as Record<string, unknown>) : null
  if (!record) {
    return {
      variant: 'not-signed-in',
      statusText: 'Muse setup not checked yet',
      hint:
        'Install the Muse Code CLI and complete Meta Model API login / key setup. TaskWraith probes the binary fail-closed and does not invent auth state.'
    }
  }
  if (record.available === false) {
    return {
      variant: 'not-available',
      statusText: 'Muse Code CLI not found',
      hint: 'Install `muse`, then return here after Meta Model API login / key setup.'
    }
  }

  const authState = String(record.authState || '').trim().toLowerCase()
  const credentialPresent = record.credentialPresent === true
  if (credentialPresent || ['authenticated', 'api-key', 'oauth'].includes(authState)) {
    return {
      variant: 'signed-in',
      statusText: 'Muse Code configured',
      hint: 'You can launch Muse runs from TaskWraith.'
    }
  }

  return {
    variant: 'partial',
    statusText: 'Muse CLI ready · setup unverified',
    hint:
      'Complete Muse / Meta Model API login so the fail-closed probe can admit the seat. TaskWraith does not store the Meta API key in this card.'
  }
}

/** Maps a Claude/Kimi auth status to the shared onboarding/settings summary. */
export function summariseProviderApiKeyStatus(
  status: ProviderApiKeyStatus | null,
  providerLabel: string
): ProviderAuthSummary {
  if (!status) {
    return {
      variant: 'not-signed-in',
      statusText: 'Not checked yet',
      hint: `Open Settings → ${providerLabel} to authenticate.`
    }
  }
  if (!status.available) {
    if (providerLabel === 'Kimi' && status.binaryPath) {
      return {
        variant: 'not-available',
        statusText: 'Managed runtime unavailable',
        hint:
          'Kimi Code is installed, but its stable identity, bounded startup, or ACP compatibility checks failed. Structural ACP admission is always enabled; credentials do not bypass these checks. Admitted unreviewed runtimes are labelled unattested-development.'
      }
    }
    return {
      variant: 'not-available',
      statusText: 'CLI not found',
      hint: `Install the ${providerLabel} CLI first, then return here.`
    }
  }
  // Kimi's encrypted Settings key is deliberately usage-query-only. Managed
  // ACP authentication comes from the admitted Kimi Code home's OAuth or
  // provider configuration, reported through authState below.
  if (providerLabel !== 'Kimi' && status.apiKeyConfigured) {
    return {
      variant: 'signed-in',
      statusText: 'API key saved',
      hint: 'You can launch runs against this provider.'
    }
  }
  const authState = (status.authState || '').toLowerCase()
  const looksAuthed = ['authenticated', 'api-key', 'oauth'].includes(authState)
  if (looksAuthed) {
    return {
      variant: 'signed-in',
      statusText: 'Signed in',
      hint: 'You can launch runs against this provider.'
    }
  }
  if (authState === 'unknown') {
    return {
      variant: 'partial',
      statusText: 'Credential state not observed',
      hint:
        providerLabel === 'Kimi'
          ? 'Use `kimi login` or configure a provider key in ~/.kimi-code/config.toml. The TaskWraith Settings key is usage-only; structural runtime compatibility is separate, and admitted unreviewed runtimes are labelled unattested-development.'
          : `Open Settings → ${providerLabel} to check sign-in or paste an API key.`
    }
  }
  return {
    variant: 'not-signed-in',
    statusText: 'Not authenticated',
    hint:
      providerLabel === 'Kimi'
        ? 'Use `kimi login` or configure a provider key in ~/.kimi-code/config.toml. The TaskWraith Settings key is usage-only; structural runtime compatibility is separate, and admitted unreviewed runtimes are labelled unattested-development.'
        : `Open Settings → ${providerLabel} to sign in or paste an API key.`
  }
}

export function summariseGeminiStatus(status: GeminiAuthStatus | null): ProviderAuthSummary {
  if (!status) {
    return {
      variant: 'not-signed-in',
      statusText: 'Not checked yet',
      hint: 'Open Settings → Gemini to add an OAuth profile or API key.'
    }
  }
  if (!status.available) {
    return {
      variant: 'not-available',
      statusText: 'Gemini CLI not found',
      hint: 'Install the Gemini CLI first, then return here.'
    }
  }
  if (status.activeProfileId) {
    return {
      variant: 'signed-in',
      statusText: status.activeProfileLabel
        ? `Active profile: ${status.activeProfileLabel}`
        : 'Profile active',
      hint: 'You can launch runs against Gemini.'
    }
  }
  return {
    variant: 'not-signed-in',
    statusText: 'No active profile',
    hint: 'Open Settings → Gemini to authenticate via Google OAuth or paste an API key.'
  }
}

/**
 * CLI-login provider summary. TaskWraith only knows whether the provider is
 * *enabled* (adapter registered), not
 * whether the CLI is signed in. Surface an honest "available · finish
 * sign-in" state that deep-links to Settings, or "disabled" when the
 * provider's adapter isn't registered.
 */
export function summariseCliProviderEnabled(
  enabled: boolean,
  providerLabel: string,
  authHint: string
): ProviderAuthSummary {
  if (!enabled) {
    return {
      variant: 'not-available',
      statusText: `${providerLabel} disabled`,
      hint: `${providerLabel} is turned off in this build.`
    }
  }
  return {
    variant: 'partial',
    statusText: 'Available · CLI sign-in',
    hint: authHint
  }
}

export function summariseCodexStatus(status: any): ProviderAuthSummary {
  if (!status || typeof status !== 'object') {
    return {
      variant: 'not-signed-in',
      statusText: 'Status not loaded yet',
      hint: 'Open Settings → Providers → Codex to check the private TaskWraith sign-in.'
    }
  }
  if (status.available === false) {
    return {
      variant: 'not-available',
      statusText: 'Codex CLI not found',
      hint: 'Install Codex first (`npm i -g @openai/codex` or upstream installer).'
    }
  }
  const authState = String(status.authState || '').toLowerCase()
  if (status.requiresOpenaiAuth === true || authState === 'missing') {
    return {
      variant: 'not-signed-in',
      statusText: 'TaskWraith Codex sign-in required',
      hint: 'Open Settings → Providers → Codex to sign in.'
    }
  }
  const account = status.account && typeof status.account === 'object' ? status.account : null
  if (account || authState === 'not-required') {
    const plan = String(status.planType || account?.planType || '').toLowerCase()
    return {
      variant: 'signed-in',
      statusText: plan ? `Signed in (${plan})` : 'Signed in',
      hint: 'You can launch Codex runs from TaskWraith.'
    }
  }
  const usage = status.codexUsage
  if (usage && (usage.planType || usage.userId)) {
    return {
      variant: 'partial',
      statusText: 'Usage session available',
      hint:
        'Usage telemetry does not sign the private TaskWraith Codex runtime in. Use the Codex sign-in action in Settings.'
    }
  }
  if (usage && usage.error) {
    return {
      variant: 'partial',
      statusText: 'Usage credential missing',
      hint: 'Open Settings → Providers → Codex to sign in to TaskWraith Codex.'
    }
  }
  return {
    variant: 'not-signed-in',
    statusText: 'Not signed in',
    hint: 'Open Settings → Providers → Codex to sign in to TaskWraith Codex.'
  }
}
