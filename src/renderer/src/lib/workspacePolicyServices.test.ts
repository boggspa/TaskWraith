import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_POLICY_SERVICES,
  getWorkspacePolicyServiceLabel
} from './workspacePolicyServices'

describe('workspacePolicyServices', () => {
  it('exposes human labels for every workspace-grant service', () => {
    expect(WORKSPACE_POLICY_SERVICES.map((service) => service.label)).toEqual([
      'Shell commands',
      'File changes',
      'Tool calls',
      'Sub-thread delegation',
      'Canvas interaction',
      'Media editing'
    ])
  })

  it('resolves service labels for approval admin surfaces', () => {
    expect(getWorkspacePolicyServiceLabel('mcpTools')).toBe('Tool calls')
    expect(getWorkspacePolicyServiceLabel('subThreadDelegation')).toBe('Sub-thread delegation')
  })
})
