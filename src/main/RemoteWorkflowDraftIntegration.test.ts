import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('remote workflow draft integration', () => {
  it('persists the main-derived effective workflow mode in the saved template', () => {
    const start = indexSource.indexOf('if (isRemoteWorkflowDraftChat(existingChatForPrompt))')
    const end = indexSource.indexOf('// Phone-attached images', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const workflowDraftBranch = indexSource.slice(start, end)
    expect(workflowDraftBranch).toContain('workflowMode: effectiveWorkflowMode,')
  })
})
