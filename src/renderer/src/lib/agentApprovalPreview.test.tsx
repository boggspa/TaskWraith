import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderAgentApprovalPreview } from './agentApprovalPreview'

describe('agent approval preview', () => {
  it('renders shell risk labels and env deltas', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'command',
        command: 'npm install left-pad',
        cwd: '/workspace',
        riskLabels: ['workspace shell execution', 'dependency change'],
        envDeltas: { FORCE_COLOR: '0', NO_COLOR: '1' }
      })!
    )

    expect(markup).toContain('Risk')
    expect(markup).toContain('workspace shell execution, dependency change')
    expect(markup).toContain('Env deltas')
    expect(markup).toContain('FORCE_COLOR=0')
    expect(markup).toContain('NO_COLOR=1')
  })

  it('renders launch target context for approval review', () => {
    const markup = renderToStaticMarkup(
      renderAgentApprovalPreview({
        kind: 'launch-target',
        label: 'npm run dev',
        source: 'package-script',
        kindLabel: 'dev-server',
        platform: 'web',
        execution: 'long-running',
        command: 'npm run dev',
        cwd: '/workspace',
        shell: false,
        git: {
          isRepo: true,
          branch: 'feature/run-button'
        }
      })!
    )

    expect(markup).toContain('Launch context')
    expect(markup).toContain('Target: npm run dev')
    expect(markup).toContain('Source: package-script')
    expect(markup).toContain('Kind: dev-server')
    expect(markup).toContain('Platform: web')
    expect(markup).toContain('Execution: long-running')
    expect(markup).toContain('Shell: no')
    expect(markup).toContain('Branch: feature/run-button')
  })
})
