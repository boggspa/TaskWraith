import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { permissionOptionCanBeSelected } from '../lib/chatPopoutAuthority'
import { CombinedPermissionsPicker } from './CombinedPermissionsPicker'

const pickerSource = readFileSync(
  new URL('./CombinedPermissionsPicker.tsx', import.meta.url),
  'utf8'
)

const permissionOptions = [
  { value: 'default', label: 'Accept Edits' },
  { value: 'plan', label: 'Plan Mode' }
]

function renderPicker(): string {
  return renderToStaticMarkup(
    <CombinedPermissionsPicker
      provider="codex"
      composerStyle="codex"
      permissionOptions={permissionOptions}
      selectedPermission="default"
      onSelectPermission={() => undefined}
    />
  )
}

describe('CombinedPermissionsPicker', () => {
  it('refuses an authority-only permission row that its host disabled', () => {
    expect(permissionOptionCanBeSelected({ disabled: true })).toBe(false)
    expect(permissionOptionCanBeSelected({})).toBe(true)
  })

  it('renders the selected permission without a second grant-state label', () => {
    const html = renderPicker()

    expect(html).toContain('Accept Edits')
    expect(html).toContain('data-permission-value="default"')
    expect(html).not.toContain('composer-combined-picker-trigger-suffix')
    expect(html).not.toContain('grant')
  })

  it('contains no Tool Grants column or grant-mutation API', () => {
    expect(pickerSource).not.toContain('Tool Grants')
    expect(pickerSource).not.toContain('grantServices')
    expect(pickerSource).not.toContain('enabledGrantIds')
    expect(pickerSource).not.toContain('onToggleGrant')
    expect(pickerSource).not.toContain('has-tool-grants')
  })

  it('does not render Apply to all unless the ensemble callback is provided', () => {
    const html = renderPicker()
    expect(html).not.toContain('Apply to all participants')
  })
})
