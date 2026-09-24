import { isHostUuid, isSafeHostIdentifier } from '../../host-shared/HostCommandIdentity'

/**
 * Compatibility export for Electron-main consumers.
 *
 * Host command identity is transport-neutral and lives below the host runtime
 * so Node-host clients can use the exact same fail-closed identifiers.
 */
export * from '../../host-shared/HostCommandIdentity'

export const HOST_COMMAND_ACTION_ID_PREFIX = 'host:command:' as const
export type HostCommandActionId = `${typeof HOST_COMMAND_ACTION_ID_PREFIX}${string}`

/**
 * Accepts only the Main/Host correlation minted by HostBridgeCommandExecutor.
 * The exact lower-case UUID form prevents client-shaped Bridge action ids from
 * being confused with Host receipt authority.
 */
export function resolveHostCommandActionId(value: unknown): HostCommandActionId | undefined {
  if (!isSafeHostIdentifier(value) || !value.startsWith(HOST_COMMAND_ACTION_ID_PREFIX)) {
    return undefined
  }
  const commandId = value.slice(HOST_COMMAND_ACTION_ID_PREFIX.length)
  if (!isHostUuid(commandId) || commandId !== commandId.toLowerCase()) return undefined
  return value as HostCommandActionId
}
