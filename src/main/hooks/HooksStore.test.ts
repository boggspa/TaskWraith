import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HookCommand } from '../../shared/hooks/HookTypes'
import { HooksStore } from './HooksStore'

let userDataPath: string
let workspacePath: string

function makeHook(overrides: Partial<HookCommand> & Pick<HookCommand, 'id'>): HookCommand {
  return {
    id: overrides.id,
    event: overrides.event ?? 'PreToolUse',
    command: overrides.command ?? `echo ${overrides.id}`,
    enabled: overrides.enabled ?? true,
    scope: overrides.scope ?? 'user',
    ...(overrides.matcher !== undefined ? { matcher: overrides.matcher } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
    ...(overrides.onError !== undefined ? { onError: overrides.onError } : {}),
    ...(overrides.workspaceId !== undefined ? { workspaceId: overrides.workspaceId } : {})
  }
}

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hooks-user-'))
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-hooks-ws-'))
})

afterEach(() => {
  fs.rmSync(userDataPath, { recursive: true, force: true })
  fs.rmSync(workspacePath, { recursive: true, force: true })
})

describe('HooksStore resolveEffectiveHooks', () => {
  it('lets workspace hooks override user hooks by id and drops disabled entries', () => {
    const store = new HooksStore({ userDataPath })

    store.upsertHook({
      scope: 'user',
      hook: makeHook({
        id: 'shared',
        command: 'echo user-shared',
        scope: 'user',
        enabled: true
      })
    })
    store.upsertHook({
      scope: 'user',
      hook: makeHook({
        id: 'user-only',
        command: 'echo user-only',
        scope: 'user',
        enabled: true
      })
    })
    store.upsertHook({
      scope: 'user',
      hook: makeHook({
        id: 'user-disabled',
        command: 'echo user-disabled',
        scope: 'user',
        enabled: false
      })
    })

    store.upsertHook({
      scope: 'workspace',
      workspacePath,
      hook: makeHook({
        id: 'shared',
        command: 'echo workspace-shared',
        scope: 'workspace',
        enabled: true
      })
    })
    store.upsertHook({
      scope: 'workspace',
      workspacePath,
      hook: makeHook({
        id: 'ws-only',
        command: 'echo ws-only',
        scope: 'workspace',
        enabled: true
      })
    })
    store.upsertHook({
      scope: 'workspace',
      workspacePath,
      hook: makeHook({
        id: 'user-only',
        command: 'echo workspace-disabled-override',
        scope: 'workspace',
        enabled: false
      })
    })

    const effective = store.resolveEffectiveHooks(workspacePath)
    const byId = new Map(effective.hooks.map((hook) => [hook.id, hook]))

    expect(byId.get('shared')?.command).toBe('echo workspace-shared')
    expect(byId.get('shared')?.source).toBe('workspace')
    expect(byId.has('ws-only')).toBe(true)
    expect(byId.has('user-only')).toBe(false)
    expect(byId.has('user-disabled')).toBe(false)
    expect(effective.hooks.every((hook) => hook.enabled)).toBe(true)
    expect(effective.hooks).toHaveLength(2)
  })

  it('persists user hooks under userData/hooks.json and workspace under .taskwraith/hooks.json', () => {
    const store = new HooksStore({ userDataPath })
    store.upsertHook({
      scope: 'user',
      hook: makeHook({ id: 'u1', scope: 'user' })
    })
    store.upsertHook({
      scope: 'workspace',
      workspacePath,
      hook: makeHook({ id: 'w1', scope: 'workspace' })
    })

    expect(fs.existsSync(path.join(userDataPath, 'hooks.json'))).toBe(true)
    expect(fs.existsSync(path.join(workspacePath, '.taskwraith', 'hooks.json'))).toBe(true)

    const userSnap = store.getUserHooks()
    const workspaceSnap = store.getWorkspaceHooks(workspacePath)
    expect(userSnap.hooks.map((h) => h.id)).toEqual(['u1'])
    expect(workspaceSnap.hooks.map((h) => h.id)).toEqual(['w1'])
  })
})

describe('HooksStore path safety', () => {
  it('rejects invalid workspace paths for workspace load/save and resolve', () => {
    const store = new HooksStore({ userDataPath })

    expect(() => store.getWorkspaceHooks('')).toThrow(/workspace/i)
    expect(() => store.getWorkspaceHooks('   ')).toThrow(/workspace/i)
    expect(() => store.resolveEffectiveHooks('')).toThrow(/workspace/i)

    expect(() =>
      store.upsertHook({
        scope: 'workspace',
        workspacePath: '',
        hook: makeHook({ id: 'x', scope: 'workspace' })
      })
    ).toThrow(/workspace/i)

    // Relative / traversal roots are rejected so callers cannot smuggle `..` segments.
    expect(() => store.getWorkspaceHooks('../not-absolute')).toThrow(/workspace/i)
    expect(() => store.getWorkspaceHooks(path.join('..', 'escape'))).toThrow(/workspace/i)
  })

  it('rejects workspace upsert without a workspacePath', () => {
    const store = new HooksStore({ userDataPath })
    expect(() =>
      store.upsertHook({
        scope: 'workspace',
        hook: makeHook({ id: 'x', scope: 'workspace' })
      })
    ).toThrow(/workspace/i)
  })
})

describe('HooksStore mutations', () => {
  it('deleteHook and setEnabled update the targeted scope only', () => {
    const store = new HooksStore({ userDataPath })
    store.upsertHook({
      scope: 'user',
      hook: makeHook({ id: 'keep', scope: 'user', enabled: true })
    })
    store.upsertHook({
      scope: 'user',
      hook: makeHook({ id: 'flip', scope: 'user', enabled: true })
    })
    store.upsertHook({
      scope: 'workspace',
      workspacePath,
      hook: makeHook({ id: 'flip', scope: 'workspace', enabled: true })
    })

    store.setEnabled({ scope: 'user', id: 'flip', enabled: false })
    store.deleteHook({ scope: 'workspace', workspacePath, id: 'flip' })

    expect(store.getUserHooks().hooks.find((h) => h.id === 'flip')?.enabled).toBe(false)
    expect(
      store.getWorkspaceHooks(workspacePath).hooks.find((h) => h.id === 'flip')
    ).toBeUndefined()
    expect(store.resolveEffectiveHooks(workspacePath).hooks.map((h) => h.id)).toEqual(['keep'])
  })
})
