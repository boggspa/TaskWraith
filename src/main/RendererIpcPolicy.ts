/**
 * Global desktop authority that must never be reachable from a chat, editor,
 * workbench, diff, or other secondary renderer. Owner-scoped chat/workspace
 * channels enforce their narrower rules in their domain handlers and are not
 * listed here.
 *
 * This is deliberately a deny list at the single `ipcMain.handle` wrapper so a
 * forgotten per-module event parameter cannot silently turn a settings panel
 * action into a popout capability.
 */
export const MAIN_RENDERER_ONLY_IPC_CHANNELS = new Set<string>([
  // Global settings, runtime profiles, encrypted secrets, and handoff records.
  'update-settings',
  'prompt-cache:get-policy',
  'prompt-cache:get-capabilities',
  'prompt-cache:get-diagnostics',
  'prompt-cache:save-policy',
  'set-bridge-daemon-enabled',
  'save-runtime-profile',
  'delete-runtime-profile',
  'get-extension-secret-status',
  'set-extension-secret',
  'clear-extension-secret',
  'get-managed-policy-status',
  'save-handoff-card',
  'update-handoff-card',
  'delete-handoff-card',

  // Plugin inventory, installation, and secret material.
  'plugins:get-catalog',
  'plugins:get-contributions',
  'plugins:get-secret-status',
  'plugins:set-secret',
  'plugins:clear-secret',
  'plugins:materialize-mcp-preset',
  'plugins:install',
  'plugins:set-enabled',
  'plugins:update',
  'plugins:uninstall',

  // Provider credentials, login processes, and host-wide provider bridges.
  'store-claude-api-key',
  'clear-claude-api-key',
  'trigger-claude-login',
  'store-kimi-api-key',
  'clear-kimi-api-key',
  'save-gemini-auth-profile',
  'delete-gemini-auth-profile',
  'set-default-gemini-auth-profile',
  'start-gemini-oauth-login',
  'get-gemini-oauth-login-status',
  'cancel-gemini-oauth-login',
  'provider:open-login-terminal',
  'provider:open-logout-terminal',
  'provider:open-upgrade-terminal',
  'provider:open-kimi-upgrade-terminal',
  'get-gemini-mcp-bridge-status',
  'install-gemini-mcp-bridge',
  'set-gemini-mcp-bridge-enabled',
  'import-codex-usage-credential',
  'clear-codex-usage-credential',

  // Mobile bridge, remote allowlist, pairing, and notification credentials.
  'bridge-allowlist-upsert',
  'bridge-allowlist-remove',
  'bridge-allowlist-clear',
  'bridge-begin-pairing',
  'bridge-finalize-pairing',
  'bridge-unpair-device',
  'ios-remote-tailscale-enable',
  'ios-remote-tailscale-test',
  'ios-remote-tailscale-disable',
  'ios-remote-tailscale-link',
  'ios-remote-tailscale-oauth-set',
  'ios-remote-tailscale-oauth-clear',
  'ios-remote-tailscale-status',
  'ios-remote-tailscale-oauth-status',
  'get-ios-remote-config',
  'set-ios-remote-config',
  'bridge-list-paired-devices',
  'bridge-networking-status',
  'bridge-allowlist-list',
  'select-apns-key-file',
  'get-apns-config',
  'set-apns-config',
  'clear-apns-config',
  'test-apns-push',

  // Host-wide generation credentials and capability toggles.
  'image-generation:set-enabled',
  'image-generation:set-key',
  'image-generation:clear-key',

  // Product update/install, diagnostics retention, and local process control.
  'check-for-updates',
  'download-update',
  'install-update-on-quit',
  'install-update-now',
  'mark-changelog-seen',
  'export-product-diagnostics',
  'export-product-audit-bundle',
  'verify-product-audit-bundle',
  'purge-product-audit-retention',
  'repair-product-install',
  'get-product-operations-status',
  'get-product-crashes',
  'submit-bug-report',
  'local-servers-snapshot',
  'local-servers-refresh',
  'local-servers-stop',
  'local-servers-stop-all',

  // Memory-promotion review/apply and its schedule are Settings-only surfaces.
  'update-memory-proposal',
  'apply-memory-proposal',
  'run-manual-introspection',
  'update-introspection-schedule',
  'get-memory-proposal-packs',
  'get-memory-proposal-pack',
  'get-introspection-schedule',

  // Host-wide integrations and confidential channel history are Settings-only.
  'discord-context:list-targets',
  'discord-context:read-channel',
  'fx-rates:refresh',
  'providerRates:probe',

  // Global app/roster state and user-authorized desktop capture/attachment gates.
  'ensemble-roster-presets:sync',
  'attach-window:pick',
  'attach-window:detach',
  'attach-window:status',
  'sticky-appwatch:get',
  'sticky-appwatch:stash',
  'sticky-appwatch:clear',
  'app:quit'
])

export function ipcChannelRequiresMainRenderer(channel: string): boolean {
  return MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel)
}
