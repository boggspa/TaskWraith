import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgenticServiceId, AgenticServicesSettings } from '../../../main/store/types'
import { permissionOptionCanBeSelected } from '../lib/chatPopoutAuthority'
import { countEffectiveToolGrants, toolGrantCanBeApplied } from '../lib/toolGrantApplicability'
import { WORKSPACE_POLICY_SERVICES } from '../lib/workspacePolicyServices'
import { CombinedPermissionsPicker } from './CombinedPermissionsPicker'

const permissionOptions = [
  { value: 'default', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan Mode' }
]

const agenticServices: AgenticServicesSettings = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  canvasEval: 'ask',
  networkAccess: 'allow'
}

function renderPicker(enabledGrantIds: Set<AgenticServiceId>): string {
  return renderToStaticMarkup(
    <CombinedPermissionsPicker
      provider="codex"
      composerStyle="codex"
      permissionOptions={permissionOptions}
      selectedPermission="default"
      onSelectPermission={() => undefined}
      grantServices={WORKSPACE_POLICY_SERVICES}
      enabledGrantIds={enabledGrantIds}
      agenticServices={agenticServices}
      onToggleGrant={() => undefined}
    />
  )
}

describe('CombinedPermissionsPicker', () => {
  it('refuses an authority-only permission row that its host disabled', () => {
    expect(
      permissionOptionCanBeSelected({ disabled: true })
    ).toBe(false)
    expect(permissionOptionCanBeSelected({})).toBe(true)
  })

  it('shows a workspace grant count in the trigger', () => {
    const html = renderPicker(new Set(['fileChanges']))

    expect(html).toContain('Accept Edits')
    expect(html).toContain('composer-combined-picker-trigger-suffix')
    expect(html).toContain('1 grant')
    expect(html).toContain('data-permission-value="default"')
  })

  it('omits the grant-count suffix after the Settings revoke state removes the grant', () => {
    const html = renderPicker(new Set())

    expect(html).toContain('Accept Edits')
    expect(html).not.toContain('composer-combined-picker-trigger-suffix')
  })

  it('does not count a grant that global policy blocks', () => {
    const blockedServices = { ...agenticServices, fileChanges: 'deny' as const }

    expect(toolGrantCanBeApplied('fileChanges', blockedServices)).toBe(false)
    expect(
      countEffectiveToolGrants(WORKSPACE_POLICY_SERVICES, new Set(['fileChanges']), blockedServices)
    ).toBe(0)
  })

  it('does not render Apply to all unless the ensemble callback is provided', () => {
    const html = renderPicker(new Set(['fileChanges']))
    expect(html).not.toContain('Apply to all participants')
  })
})
