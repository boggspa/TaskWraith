import { describe, expect, it } from 'vitest'
import { approvalActionPresentation } from './approvalActionPresentation'

describe('approvalActionPresentation', () => {
  it('describes the historical session action as a current-run grant', () => {
    expect(
      approvalActionPresentation('acceptForSession', { serviceLabel: 'Shell commands' })
    ).toEqual({
      label: 'Allow all shell commands for this run',
      title: 'Allow all shell commands for the rest of this run. This grant ends when the run ends.'
    })
  })

  it('keeps workspace approval visibly broader and revocable', () => {
    expect(
      approvalActionPresentation('acceptForWorkspace', { serviceLabel: 'Shell commands' })
    ).toEqual({
      label: 'Allow all shell commands in this workspace',
      title:
        'Allow all shell commands in this workspace. This broad grant persists until revoked in Approvals & Grants.'
    })
  })

  it('uses truthful generic copy when the service is unavailable to a compact surface', () => {
    expect(approvalActionPresentation('acceptForSession')).toMatchObject({
      label: 'Allow matching requests for this run',
      title: expect.stringContaining('ends when the run ends')
    })
  })
})
