import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ipcChannelRequiresMainRenderer,
  MAIN_RENDERER_ONLY_IPC_CHANNELS
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
    'app:quit'
  ])('keeps %s behind main-renderer authority', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(true)
  })

  it.each([
    'get-settings',
    'get-agent-models',
    'get-chat',
    'run-agent',
    'save-clipboard-image-attachment',
    'get-run-queue-jobs',
    'check-trust',
    'audit-run:start',
    'read-image-preview',
    'record-product-crash'
  ])('leaves %s to its read or owner-scoped domain policy', (channel) => {
    expect(ipcChannelRequiresMainRenderer(channel)).toBe(false)
  })

  it('contains no accidental duplicate entries', () => {
    expect(MAIN_RENDERER_ONLY_IPC_CHANNELS.size).toBe(
      [...MAIN_RENDERER_ONLY_IPC_CHANNELS].length
    )
  })

  it('exposes no generic renderer-string image-preview authorizer', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const preloadTypes = readFileSync(join(process.cwd(), 'src/preload/index.d.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const renderer = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(ipcChannelRequiresMainRenderer('authorize-image-preview')).toBe(false)
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

  it('requires a preload-minted trusted one-shot intent for host clipboard image reads', () => {
    const preload = readFileSync(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    expect(ipcChannelRequiresMainRenderer('save-clipboard-image-attachment')).toBe(false)
    expect(preload).toContain("window.addEventListener(\n  'paste'")
    expect(preload).toContain('if (!event.isTrusted) return')
    expect(preload).toContain("ipcRenderer.send('authorize-clipboard-paste-intent', token)")
    expect(preload).toContain(
      "ipcRenderer.invoke('save-clipboard-image-attachment', intent.token)"
    )
    expect(main).toContain("ipcMain.on('authorize-clipboard-paste-intent'")
    expect(main).toContain('saveClipboardImageFromTrustedPaste({')
  })

  it('projects provider status reads for secondary renderers instead of returning account/path payloads', () => {
    const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    expect(main).toContain('return isMainRendererSender(event) ? status : rendererSafeProviderStatus(status)')
    expect(ipcChannelRequiresMainRenderer('get-gemini-oauth-login-status')).toBe(true)
  })
})
