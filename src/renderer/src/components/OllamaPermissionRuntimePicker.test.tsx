import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgenticServiceId, AgenticServicesSettings } from '../../../main/store/types'
import { WORKSPACE_POLICY_SERVICES } from '../lib/workspacePolicyServices'
import {
  formatOllamaPermissionRuntimeChip,
  OllamaPermissionRuntimePicker
} from './OllamaPermissionRuntimePicker'

const permissionOptions = [
  { value: 'plan', label: 'Plan / Read-only' },
  { value: 'default', label: 'Default Approval' },
  { value: 'auto_edit', label: 'Full Workspace Access' }
]

const agenticServices: AgenticServicesSettings = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  mcpTools: 'allow',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  canvasEval: 'ask',
  networkAccess: 'allow',
  crossThreadRead: 'ask',
  mediaEditing: 'ask',
  mediaRecording: 'deny'
}

function renderPicker(enabledGrantIds: Set<AgenticServiceId>): string {
  return renderToStaticMarkup(
    <OllamaPermissionRuntimePicker
      provider="ollama"
      composerStyle="codex"
      permissionOptions={permissionOptions}
      selectedPermission="default"
      onSelectPermission={() => undefined}
      grantServices={WORKSPACE_POLICY_SERVICES}
      enabledGrantIds={enabledGrantIds}
      agenticServices={agenticServices}
      onToggleGrant={() => undefined}
      selectedTier="provider_parity"
      onSelectTier={() => undefined}
      selectedRunProfile="provider_parity"
      onSelectRunProfile={() => undefined}
      tier4Granted
    />
  )
}

describe('OllamaPermissionRuntimePicker', () => {
  it('folds permission, tier, and grant count into one trigger', () => {
    const html = renderPicker(new Set(['shellCommands']))

    expect(html).toContain('Default Approval')
    expect(html).toContain('Tier 4')
    expect(html).toContain('1 grant')
    expect(html).toContain('data-composer-control="permission"')
    expect(html).not.toContain('data-composer-control="ollama-tier"')
    expect(html).toContain('data-ollama-tier="provider_parity"')
    expect(html).toContain('data-ollama-run-profile="provider_parity"')
  })

  it('keeps Tier 4 ineffective state on the unified trigger when ungranted', () => {
    const html = renderToStaticMarkup(
      <OllamaPermissionRuntimePicker
        provider="ollama"
        composerStyle="codex"
        permissionOptions={permissionOptions}
        selectedPermission="default"
        onSelectPermission={() => undefined}
        grantServices={WORKSPACE_POLICY_SERVICES}
        enabledGrantIds={new Set()}
        agenticServices={agenticServices}
        onToggleGrant={() => undefined}
        selectedTier="provider_parity"
        onSelectTier={() => undefined}
        selectedRunProfile="provider_parity"
        onSelectRunProfile={() => undefined}
        tier4Granted={false}
      />
    )

    expect(html).toContain('data-ollama-tier-ineffective="true"')
    expect(html).toContain('composer-ollama-tier-warning')
  })
})

describe('formatOllamaPermissionRuntimeChip', () => {
  it('formats the compact unified chip suffix', () => {
    expect(
      formatOllamaPermissionRuntimeChip({
        permissionLabel: 'Default Approval',
        selectedTier: 'approved_shell',
        grantsCount: 2
      })
    ).toEqual({ primary: 'Default Approval', suffix: 'Tier 3 · 2 grants' })
  })
})
