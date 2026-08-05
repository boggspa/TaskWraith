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
      'External publishing',
      'Tool calls',
      'Sub-thread delegation',
      'Canvas interaction',
      'Sketch Canvas',
      'Mesh Canvas',
      'Media editing',
      'Browser navigation'
    ])
  })

  it('resolves service labels for approval admin surfaces', () => {
    expect(getWorkspacePolicyServiceLabel('mcpTools')).toBe('Tool calls')
    expect(getWorkspacePolicyServiceLabel('subThreadDelegation')).toBe('Sub-thread delegation')
    expect(getWorkspacePolicyServiceLabel('sketchCanvas')).toBe('Sketch Canvas')
  })
})
