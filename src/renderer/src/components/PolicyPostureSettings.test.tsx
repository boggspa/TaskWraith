import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgenticServicesSettings } from '../../../main/store/types'
import { buildPolicyPostureRows, SUGGESTED_POLICY_POSTURE } from '../lib/policyPosture'
import {
  POLICY_POSTURE_OVERRIDE_ACKNOWLEDGEMENT_ID,
  PolicyPostureOverrideSheetSurface,
  PolicyPostureSettings
} from './PolicyPostureSettings'

const settings: AgenticServicesSettings = {
  ...SUGGESTED_POLICY_POSTURE,
  canvasEval: 'ask',
  mediaRecording: 'deny'
}

describe('PolicyPostureSettings', () => {
  it('keeps policy values read-only until the override hatch is unlocked', () => {
    const html = renderToStaticMarkup(
      <PolicyPostureSettings
        agenticServices={settings}
        rows={buildPolicyPostureRows(settings)}
        overrideUnlocked={false}
        managedLocked={false}
        onChange={() => {}}
      />
    )

    expect(html).toContain('Shell commands')
    expect(html).toContain('Ask, then allow workspace')
    expect(html).toContain('Suggested')
    expect(html).not.toContain('<select')
  })

  it('renders one scoped editor per posture row after acknowledgement', () => {
    const html = renderToStaticMarkup(
      <PolicyPostureSettings
        agenticServices={settings}
        rows={buildPolicyPostureRows(settings)}
        overrideUnlocked
        managedLocked={false}
        onChange={() => {}}
      />
    )

    expect(html.match(/<select/g)).toHaveLength(10)
    expect(html).toContain('aria-label="Shell commands policy"')
    expect(html).toContain('aria-label="Network access policy"')
  })

  it('does not expose editors when organization policy owns the setting', () => {
    const html = renderToStaticMarkup(
      <PolicyPostureSettings
        agenticServices={settings}
        rows={buildPolicyPostureRows(settings)}
        overrideUnlocked
        managedLocked
        onChange={() => {}}
      />
    )

    expect(html).not.toContain('<select')
  })
})

describe('PolicyPostureOverrideSheet', () => {
  it('reuses the high-risk access sheet and requires explicit acknowledgement', () => {
    const html = renderToStaticMarkup(
      <PolicyPostureOverrideSheetSurface
        acknowledged={false}
        onAcknowledgedChange={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(html).toContain('Open the policy override hatch?')
    expect(html).toContain('data-elevation-tier="2"')
    expect(html).toContain(`id="${POLICY_POSTURE_OVERRIDE_ACKNOWLEDGEMENT_ID}"`)
    expect(html).toContain(`for="${POLICY_POSTURE_OVERRIDE_ACKNOWLEDGEMENT_ID}"`)
    expect(html).toMatch(/disabled=""[^>]*>Open override hatch<\/button>/)
  })
})
