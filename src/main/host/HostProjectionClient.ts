/**
 * Compatibility export for existing Electron-main consumers.
 *
 * The authenticated projection client is a reusable Host client and must stay
 * available to the standalone Node TUI without pulling in `src/main`.
 */
export * from '../../host-client/HostProjectionClient'
