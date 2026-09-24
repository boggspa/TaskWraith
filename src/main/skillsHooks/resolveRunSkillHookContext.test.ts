import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  digestSessionStartContext,
  digestSkillDiscoveryPrompt,
  resetRunSkillHookContextCacheForTests,
  resolveRunSkillHookContext
} from './resolveRunSkillHookContext'

describe('resolveRunSkillHookContext', () => {
  afterEach(() => {
    resetRunSkillHookContextCacheForTests()
  })

  it('returns skill discovery + SessionStart context for a workspace path', async () => {
    const runSessionStart = vi.fn(async () => ({
      sessionStartContext: 'branch=main'
    }))
    const skillsStore = {
      resolveEffectiveSkills: vi.fn(() => [
        {
          id: 'deploy',
          name: 'Deploy',
          description: 'Ship the build.',
          body: 'full body',
          enabled: true,
          source: 'user' as const
        }
      ])
    }

    const ctx = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-skills',
      workspaceId: 'ws-1',
      allowWorkspaceHooks: true,
      skillsStore,
      runSessionStart
    })

    expect(skillsStore.resolveEffectiveSkills).toHaveBeenCalledWith('/tmp/ws-skills', 'ws-1')
    expect(runSessionStart).toHaveBeenCalledTimes(1)
    expect(ctx.skillDiscoverySkills).toEqual([
      { id: 'deploy', name: 'Deploy', description: 'Ship the build.' }
    ])
    expect(ctx.skillDiscoveryDigest).toBe(
      digestSkillDiscoveryPrompt([{ id: 'deploy', name: 'Deploy', description: 'Ship the build.' }])
    )
    expect(ctx.sessionStartContext).toBe('branch=main')
    expect(ctx.sessionStartContextDigest).toBe(digestSessionStartContext('branch=main'))
  })

  it('keeps rendered-body digests stable and changes only the edited context', async () => {
    const skillByWorkspace = new Map([
      ['/tmp/ws-digest-a', 'Ship the build.'],
      ['/tmp/ws-digest-b', 'Ship the build.'],
      ['/tmp/ws-digest-skill-edit', 'Ship and verify the build.'],
      ['/tmp/ws-digest-hook-edit', 'Ship the build.']
    ])
    const skillsStore = {
      resolveEffectiveSkills: vi.fn((workspacePath: string) => [
        {
          id: 'deploy',
          name: 'Deploy',
          description: skillByWorkspace.get(workspacePath) || '',
          body: 'full body',
          enabled: true,
          source: 'user' as const
        }
      ])
    }
    const runSessionStart = vi.fn(async (workspacePath: string) => ({
      sessionStartContext:
        workspacePath === '/tmp/ws-digest-hook-edit' ? 'branch=feature' : 'branch=main'
    }))

    const first = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-digest-a',
      skillsStore,
      runSessionStart
    })
    const same = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-digest-b',
      skillsStore,
      runSessionStart
    })
    const skillEdited = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-digest-skill-edit',
      skillsStore,
      runSessionStart
    })
    const hookEdited = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-digest-hook-edit',
      skillsStore,
      runSessionStart
    })

    expect(first.skillDiscoveryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.sessionStartContextDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(same.skillDiscoveryDigest).toBe(first.skillDiscoveryDigest)
    expect(same.sessionStartContextDigest).toBe(first.sessionStartContextDigest)
    expect(skillEdited.skillDiscoveryDigest).not.toBe(first.skillDiscoveryDigest)
    expect(skillEdited.sessionStartContextDigest).toBe(first.sessionStartContextDigest)
    expect(hookEdited.skillDiscoveryDigest).toBe(first.skillDiscoveryDigest)
    expect(hookEdited.sessionStartContextDigest).not.toBe(first.sessionStartContextDigest)
  })

  it('returns explicit none digests for an authoritatively empty workspace context', async () => {
    const ctx = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-empty-context',
      skillsStore: { resolveEffectiveSkills: vi.fn(() => []) },
      runSessionStart: vi.fn(async () => ({ sessionStartContext: '' }))
    })

    expect(ctx).toEqual({
      skillDiscoveryDigest: 'none',
      sessionStartContextDigest: 'none'
    })
  })

  it('skips skills and SessionStart for global / missing workspace path', async () => {
    const runSessionStart = vi.fn(async () => ({
      sessionStartContext: 'should-not-run'
    }))
    const skillsStore = {
      resolveEffectiveSkills: vi.fn(() => [
        {
          id: 'deploy',
          name: 'Deploy',
          description: 'Ship',
          body: 'x',
          enabled: true,
          source: 'user' as const
        }
      ])
    }

    await expect(
      resolveRunSkillHookContext({
        workspacePath: '  ',
        isGlobalRun: false,
        skillsStore,
        runSessionStart
      })
    ).resolves.toEqual({})

    await expect(
      resolveRunSkillHookContext({
        workspacePath: '/tmp/ws',
        isGlobalRun: true,
        skillsStore,
        runSessionStart
      })
    ).resolves.toEqual({})

    expect(skillsStore.resolveEffectiveSkills).not.toHaveBeenCalled()
    expect(runSessionStart).not.toHaveBeenCalled()
  })

  it('runs SessionStart once per workspace and reuses cached stdout', async () => {
    const runSessionStart = vi.fn(async () => ({
      sessionStartContext: 'cached-stdout'
    }))
    const skillsStore = {
      resolveEffectiveSkills: vi.fn(() => [])
    }

    const first = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-cache',
      skillsStore,
      runSessionStart
    })
    const second = await resolveRunSkillHookContext({
      workspacePath: '/tmp/ws-cache',
      skillsStore,
      runSessionStart
    })

    expect(runSessionStart).toHaveBeenCalledTimes(1)
    expect(first.sessionStartContext).toBe('cached-stdout')
    expect(second.sessionStartContext).toBe('cached-stdout')
    expect(second.sessionStartContextDigest).toBe(first.sessionStartContextDigest)
  })
})
