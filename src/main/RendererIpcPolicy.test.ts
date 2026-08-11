import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_ARGUMENT_SCHEMAS } from './IpcValidation'
import {
  ipcChannelRequiresMainRenderer,
  MAIN_RENDERER_ONLY_IPC_CHANNELS,
  SECONDARY_RENDERER_SAFE_IPC_CHANNELS
} from './RendererIpcPolicy'

describe('RendererIpcPolicy', () => {
  it.each([
    'update-settings',
    'prompt-cache:get-policy',
    'prompt-cache:get-capabilities',
    'prompt-cache:get-diagnostics',
    'save-runtime-profile',
    'get-extension-secret-status',
    'get-managed-policy-status',
    'plugins:get-catalog',
    'plugins:get-contributions',
    'plugins:get-secret-status',
    'plugins:install',
    'plugins:set-secret',
    'store-claude-api-key',
    'save-gemini-auth-profile',
    'get-gemini-oauth-login-status',
    'provider:open-login-terminal',
    'get-gemini-mcp-bridge-status',
    'bridge-allowlist-upsert',
    'bridge-list-paired-devices',
    'bridge-networking-status',
    'ios-remote-tailscale-enable',
    'get-ios-remote-config',
    'set-apns-config',
    'image-generation:set-key',
    'licenses:get-status',
    'licenses:open-notice',
    'install-update-now',
    'repair-product-install',
    'get-product-crashes',
    'verify-product-audit-bundle',
    'submit-bug-report',
    'local-servers-snapshot',
    'local-servers-stop-all',
    'apply-memory-proposal',
    'get-memory-proposal-packs',
    'discord-context:read-channel',
    'providerRates:probe',
    'ensemble-roster-presets:sync',
    'attach-window:pick',
    'attach-window:control-session',
    'canvas:open-embedded',
    'canvas:adopt-embedded',
    'canvas:set-bounds',
    'canvas:clear-browser-profile',
    'mesh-scene:import-user-model',
    'mesh-scene:import-user-package',
    'mesh-scene:view',
    'projects:list-reference-proposals',
    'projects:review-reference-proposal',
    'execution-graphs:diagnostics',
    'execution-graphs:list',
    'execution-runs:append-stack-step',
    'execution-runs:cancel',
    'execution-runs:formalize',
    'work-locks:force-release-recovery',
    'app:quit'
  ])('keeps %s behind main-renderer authority', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
  })

  it.each([
    'get-settings',
    'get-agent-models',
    'get-chat',
    'unarchive-chat',
    'export-archived-chat',
    'save-chat',
    'run-agent',
    'save-clipboard-image-attachment',
    'get-run-queue-jobs',
    'check-trust',
    'audit-run:start',
    'get-diff',
    'git:snapshot',
    'git:workspace-stats',
    'git:work-provenance',
    'work-locks:list',
    'work-locks:subscribe',
    'work-locks:unsubscribe',
    'read-workspace-file',
    'read-image-preview',
    'record-product-crash',
    'cancel-scheduled-task'
  ])('allows %s to reach its read or owner-scoped domain policy', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(false)
    expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(true)
  })

  it.each(['brand-new-settings-channel', 'get-setting', '', 'authorize-image-preview'])(
    'fails closed for unknown channel %j',
    (channel) => {
      expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
      expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(false)
    }
  )

  it('keeps Host projection reads popout-safe and governed mutations main-only', () => {
    for (const channel of ['host-projection:snapshot', 'host-projection:deltas-since']) {
      expect(ipcChannelRequiresMainRenderer(channel)).toBe(false)
      expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(true)
    }
    for (const channel of ['host-projection:command-submit', 'host-projection:receipt-lookup']) {
      expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
      expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel)).toBe(true)
    }
  })

  it.each([
    'channels:append',
    'channels:approve-human-review',
    'channels:audit',
    'channels:close',
    'channels:create',
    'channels:deny-human-review',
    'channels:human-reviews',
    'channels:issue-invite',
    'channels:list',
    'channels:migration-handoff',
    'channels:read',
    'channels:revoke-member'
  ])('lets scoped Channel handler %s reach its domain authority check', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(false)
    expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(true)
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel)).toBe(false)
  })

  it.each([
    'channels:member:list',
    'channels:member:snapshot',
    'channels:member:begin-join',
    'channels:member:confirm-join',
    'channels:member:reconnect',
    'channels:member:append',
    'channels:member:resume',
    'channels:member:disconnect',
    'channels:member:reset-local-history',
    'channels:member:forget'
  ])('keeps joined Channel member operation %s main-renderer-only', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel)).toBe(true)
    expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(false)
  })

  it.each([
    'channels:agent:overview',
    'channels:agent:enroll',
    'channels:agent:grant',
    'channels:agent:revoke',
    'channels:agent:rotate'
  ])('keeps Channel agent management operation %s main-renderer-only', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel)).toBe(true)
    expect(SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)).toBe(false)
  })

  it('classifies the complete registered IPC catalogue exactly once', () => {
    const registeredChannels = Object.keys(IPC_ARGUMENT_SCHEMAS).sort()
    const unclassified = registeredChannels.filter(
      (channel) =>
        !MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel) &&
        !SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)
    )
    const conflicting = registeredChannels.filter(
      (channel) =>
        MAIN_RENDERER_ONLY_IPC_CHANNELS.has(channel) &&
        SECONDARY_RENDERER_SAFE_IPC_CHANNELS.has(channel)
    )
    const staleMainOnly = [...MAIN_RENDERER_ONLY_IPC_CHANNELS].filter(
      (channel) => !(channel in IPC_ARGUMENT_SCHEMAS)
    )
    const staleSecondarySafe = [...SECONDARY_RENDERER_SAFE_IPC_CHANNELS].filter(
      (channel) => !(channel in IPC_ARGUMENT_SCHEMAS)
    )

    expect(unclassified).toEqual([])
    expect(conflicting).toEqual([])
    expect(staleMainOnly).toEqual([])
    expect(staleSecondarySafe).toEqual([])
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.size + SECONDARY_RENDERER_SAFE_IPC_CHANNELS.size).toBe(
      registeredChannels.length
    )
  })

  it('exposes no generic renderer-string image-preview authorizer', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const renderer = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(ipcChannelRequiresMainRenderer('authorize-image-preview')).toBe(true)
    expect(preload).not.toContain("ipcRenderer.invoke('authorize-image-preview'")
    expect(preloadTypes).not.toContain('authorizeImagePreview')
    expect(main).not.toContain("ipcMain.handle('authorize-image-preview'")
    expect(renderer).not.toContain('authorizeImagePreview')
  })

  it('keeps picker and detached OS file drops on main/preload-minted attachment capabilities', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    expect(main).toContain("ipcMain.handle('select-image-files'")
    expect(main).toContain('for (const filePath of filePaths)')
    expect(main).toContain('authorizeImagePreviewPath(filePath, {')
    expect(preload).toContain("ipcRenderer.send('authorize-dropped-attachment', filePath)")
    expect(main).toContain("ipcMain.on('authorize-dropped-attachment'")
  })

  it('exposes Canvas dock adoption and profile reset only through the main-renderer bridge', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')

    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has('canvas:adopt-embedded')).toBe(true)
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.has('canvas:clear-browser-profile')).toBe(true)
    expect(preload).toContain("ipcRenderer.invoke('canvas:adopt-embedded', args)")
    expect(preload).toContain("ipcRenderer.invoke('canvas:clear-browser-profile')")
    expect(preloadTypes).toContain('adoptEmbedded: (args: { chatId: string; canvasId: string })')
    expect(preloadTypes).toContain('clearBrowserProfile: () => Promise<')
  })

  it('requires a preload-minted trusted one-shot intent for host clipboard image reads', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    expect(ipcChannelRequiresMainRenderer('save-clipboard-image-attachment')).toBe(false)
    expect(preload).toContain("window.addEventListener(\n  'paste'")
    expect(preload).toContain('if (!event.isTrusted) return')
    expect(preload).toContain("ipcRenderer.send('authorize-clipboard-paste-intent', token)")
    expect(preload).toContain(
      "ipcRenderer.invoke('save-clipboard-image-attachment', appChatId, intent.token)"
    )
    expect(main).toContain("ipcMain.on('authorize-clipboard-paste-intent'")
    expect(main).toContain('saveClipboardImageFromTrustedPaste({')
    expect(main).toContain('assetStore: getTranscriptMediaAssetStore()')
    expect(main).not.toContain('taskwraith-paste-')
  })

  it('keeps sandboxed preload code free of unsupported Node crypto/util imports', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const persistence = readFileSync(
      join(process.cwd(), 'src/preload/SerializedChatPersistence.ts'),
      'utf8'
    )

    expect(preload).not.toContain("from 'node:crypto'")
    expect(preload).toContain('globalThis.crypto?.randomUUID?.()')
    expect(persistence).not.toContain("from 'node:util'")
  })

  it('projects provider status reads for secondary renderers instead of returning account/path payloads', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    expect(main).toContain(
      'return isMainRendererSender(event) ? status : rendererSafeProviderStatus(status)'
    )
    expect(ipcChannelRequiresMainRenderer('get-gemini-oauth-login-status')).toBe(true)
  })
})
