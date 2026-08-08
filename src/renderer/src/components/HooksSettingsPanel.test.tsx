import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HookCommand } from '../../../shared/hooks/HookTypes'
import { HooksSettingsPanel } from './HooksSettingsPanel'

function makeHook(overrides: Partial<HookCommand> = {}): HookCommand {
  return {
    id: 'hook-1',
    event: 'SessionStart',
    command: 'echo start',
    enabled: true,
    scope: 'user',
    onError: 'continue',
    timeoutMs: 15000,
    ...overrides
  }
}

describe('HooksSettingsPanel', () => {
  it('groups hooks by lifecycle event and exposes create controls', () => {
    const html = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={[
          makeHook(),
          makeHook({
            id: 'hook-2',
            event: 'PreToolUse',
            command: 'echo pre',
            matcher: 'run_shell_command',
            onError: 'block'
          }),
          makeHook({
            id: 'hook-3',
            event: 'Stop',
            command: 'echo stop',
            scope: 'workspace'
          })
        ]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        workspaceLabel="AGBench"
      />
    )

    expect(html).toContain('Hooks')
    expect(html).toContain('Session start')
    expect(html).toContain('Pre tool use')
    expect(html).toContain('Post tool use')
    expect(html).toContain('Stop')
    expect(html).toContain('echo start')
    expect(html).toContain('matcher: run_shell_command')
    expect(html).toContain('Add hook')
    expect(html).toContain('No post tool use hooks.')
    expect(html).toContain('aria-label="Enable hook hook-1"')
    expect(html).toContain('Trust workspace hooks')
    expect(html).toContain('agent-writable')
  })

  it('reflects the trustWorkspaceHooks prop on the checkbox', () => {
    const html = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={[]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        trustWorkspaceHooks
        onTrustWorkspaceHooksChange={vi.fn()}
      />
    )
    expect(html).toContain('aria-label="Trust workspace hooks"')
    expect(html).toContain('checked=""')
  })

  it('renders empty groups when no hooks exist', () => {
    const html = renderToStaticMarkup(
      <HooksSettingsPanel hooks={[]} onUpsert={vi.fn()} onDelete={vi.fn()} onSetEnabled={vi.fn()} />
    )
    expect(html).toContain('No session start hooks.')
    expect(html).toContain('No pre tool use hooks.')
    expect(html).toContain('No post tool use hooks.')
    expect(html).toContain('No stop hooks.')
  })
})
