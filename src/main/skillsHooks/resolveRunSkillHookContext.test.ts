import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
    expect(ctx.sessionStartContext).toBe('branch=main')
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
  })
})
