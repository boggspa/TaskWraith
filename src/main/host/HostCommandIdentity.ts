/**
 * Compatibility export for Electron-main consumers.
 *
 * Host command identity is transport-neutral and lives below the host runtime
 * so Node-host clients can use the exact same fail-closed identifiers.
 */
export * from '../../host-shared/HostCommandIdentity'
