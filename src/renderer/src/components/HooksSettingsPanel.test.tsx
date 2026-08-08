import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HookCommand } from '../../../shared/hooks/HookTypes'
import { countEffectiveHooksAfterTrust } from '../lib/skillsHooksSettingsApi'
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
    expect(html).toContain('Workspace trust')
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

  it('shows effective hook count after trust-aware merge', () => {
    const hooks = [
      makeHook({ id: 'u1', scope: 'user', enabled: true }),
      makeHook({ id: 'u2', scope: 'user', enabled: false }),
      makeHook({ id: 'w1', scope: 'workspace', enabled: true }),
      makeHook({ id: 'shared', scope: 'user', enabled: true, command: 'echo user-shared' }),
      makeHook({
        id: 'shared',
        scope: 'workspace',
        enabled: true,
        command: 'echo workspace-shared'
      })
    ]

    const untrusted = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={hooks}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        trustWorkspaceHooks={false}
      />
    )
    expect(untrusted).toContain('data-testid="hooks-effective-count"')
    expect(untrusted).toContain('>2<')
    expect(untrusted).toContain('user only')

    const trusted = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={hooks}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        trustWorkspaceHooks
      />
    )
    expect(trusted).toContain('>3<')
    expect(trusted).toContain('user + trusted workspace')
  })

  it('surfaces ask-before-run toggle from props', () => {
    const html = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={[]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        askBeforeHookCommands
        onAskBeforeHookCommandsChange={vi.fn()}
      />
    )
    expect(html).toContain('aria-label="Ask before running hook commands"')
    expect(html).toContain('Ask before running hook commands')
    expect(html).toContain('checked=""')
  })

  it('exposes reveal hooks.json actions when onRevealRoot is provided', () => {
    const html = renderToStaticMarkup(
      <HooksSettingsPanel
        hooks={[]}
        onUpsert={vi.fn()}
        onDelete={vi.fn()}
        onSetEnabled={vi.fn()}
        onRevealRoot={vi.fn()}
        workspaceLabel="AGBench"
      />
    )
    expect(html).toContain('Reveal user hooks.json')
    expect(html).toContain('Reveal workspace hooks.json')
  })
})

describe('countEffectiveHooksAfterTrust', () => {
  it('counts enabled user hooks and trusted workspace merge by id', () => {
    const hooks: HookCommand[] = [
      makeHook({ id: 'a', scope: 'user', enabled: true }),
      makeHook({ id: 'b', scope: 'user', enabled: false }),
      makeHook({ id: 'c', scope: 'workspace', enabled: true }),
      makeHook({ id: 'a', scope: 'workspace', enabled: true })
    ]
    expect(countEffectiveHooksAfterTrust(hooks, false)).toBe(1)
    expect(countEffectiveHooksAfterTrust(hooks, true)).toBe(2)
  })
})
