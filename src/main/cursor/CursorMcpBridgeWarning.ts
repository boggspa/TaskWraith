import { CursorGlobalBrokerRegistryInstallError } from './CursorGlobalBrokerRegistryLease'

export type CursorMcpBridgeFailurePhase = 'enable' | 'ready-probe' | 'registry' | 'other'

export function classifyCursorMcpBridgeFailure(error: unknown): CursorMcpBridgeFailurePhase {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CursorGlobalBrokerRegistryInstallError || /registry/i.test(message)) {
    return 'registry'
  }
  if (/mcp enable/i.test(message)) return 'enable'
  if (/mcp list failed|is not ready for this run/i.test(message)) return 'ready-probe'
  return 'other'
}

const FAILURE_TITLES: Record<CursorMcpBridgeFailurePhase, string> = {
  enable: 'Cursor MCP enable failed',
  'ready-probe': 'Cursor MCP broker not ready',
  registry: 'Cursor MCP registry install failed',
  other: 'Cursor MCP bridge unavailable'
}

function registryRecoverySuffix(error: unknown): string {
  if (!(error instanceof CursorGlobalBrokerRegistryInstallError)) return ''
  const { cleanup } = error
  if (cleanup.outcome === 'cleanup-failed') {
    return ` Registry recovery outcome: ${cleanup.outcome} (${cleanup.message}).`
  }
  if (cleanup.outcome === 'restore-attempted-unverified' && cleanup.detail) {
    return ` Registry recovery outcome: ${cleanup.outcome} (${cleanup.detail}).`
  }
  return ` Registry recovery outcome: ${cleanup.outcome}.`
}

export function buildCursorMcpBridgeUnavailableWarning(input: {
  readonly writeCapable: boolean
  readonly error: unknown
}): { readonly title: string; readonly message: string } {
  const phase = classifyCursorMcpBridgeFailure(input.error)
  const detail = input.error instanceof Error ? input.error.message : String(input.error)
  const surface = input.writeCapable
    ? 'the user-approved native Shell/Write surface inside Cursor’s workspace sandbox'
    : 'native reads only'
  return {
    title: FAILURE_TITLES[phase],
    message: `TaskWraith could not set up the MCP broker; Cursor is continuing with ${surface}. ${detail}${registryRecoverySuffix(input.error)}`
  }
}
