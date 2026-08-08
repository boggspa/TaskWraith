import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain } from 'electron'
import { registerSkillsHandlers } from './skillsHandlers'
import type { SkillRecord } from '../../shared/skills/SkillTypes'

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  }
}))

const mockedHandle = vi.mocked(ipcMain.handle)

beforeEach(() => {
  mockedHandle.mockReset()
})

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown

function handlerFor(channel: string): RegisteredHandler {
  const handler = mockedHandle.mock.calls.find(([registered]) => registered === channel)?.[1] as
    | RegisteredHandler
    | undefined
  expect(handler).toBeTypeOf('function')
  if (!handler) throw new Error(`Handler not registered: ${channel}`)
  return handler
}

function skill(overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    id: 'demo',
    name: 'Demo',
    description: 'desc',
    body: 'body',
    relativePath: 'SKILL.md',
    enabled: true,
    scope: 'user',
    updatedAt: '2026-08-08T12:00:00.000Z',
    ...overrides
  }
}

describe('registerSkillsHandlers auth', () => {
  it('rejects non-main renderer senders on skills channels', () => {
    const deps = {
      skillsStore: {
        listUserSkills: vi.fn(() => [skill()]),
        listWorkspaceSkills: vi.fn(() => []),
        resolveEffectiveSkills: vi.fn(() => []),
        getLibrarySnapshot: vi.fn(),
        upsertUserSkill: vi.fn(),
        upsertWorkspaceSkill: vi.fn(),
        deleteUserSkill: vi.fn(() => true),
        deleteWorkspaceSkill: vi.fn(() => true),
        setUserSkillEnabled: vi.fn(),
        setWorkspaceSkillEnabled: vi.fn(),
        userSkillsRoot: vi.fn(() => '/tmp/user-skills'),
        workspaceSkillsRoot: vi.fn(() => '/tmp/ws/.taskwraith/skills')
      },
      revealPathInFinder: vi.fn(async () => ({ ok: true })),
      isMainRendererSender: vi.fn(() => false),
      requireRegisteredWorkspace: vi.fn((path: string) => path),
      assertSenderScope: vi.fn()
    }

    registerSkillsHandlers(deps)

    const event = { sender: { id: 99 } }
    expect(() => handlerFor('skills:list-user')(event)).toThrow(/main renderer/i)
    expect(() => handlerFor('skills:list-effective')(event, { workspacePath: '/tmp/ws' })).toThrow(
      /main renderer/i
    )
    expect(deps.skillsStore.listUserSkills).not.toHaveBeenCalled()
  })

  it('authorizes workspace scope through requireRegisteredWorkspace + assertSenderScope', () => {
    const registered = '/registered/ws'
    const deps = {
      skillsStore: {
        listUserSkills: vi.fn(() => []),
        listWorkspaceSkills: vi.fn(() => [skill({ scope: 'workspace', id: 'ws-skill' })]),
        resolveEffectiveSkills: vi.fn(() => []),
        getLibrarySnapshot: vi.fn(),
        upsertUserSkill: vi.fn(),
        upsertWorkspaceSkill: vi.fn((workspacePath: string, input) =>
          skill({
            id: input.id || 'new',
            name: input.name,
            scope: 'workspace',
            workspaceId: 'w1'
          })
        ),
        deleteUserSkill: vi.fn(() => true),
        deleteWorkspaceSkill: vi.fn(() => true),
        setUserSkillEnabled: vi.fn(),
        setWorkspaceSkillEnabled: vi.fn((_ws, id, enabled) =>
          skill({ id, enabled, scope: 'workspace' })
        ),
        userSkillsRoot: vi.fn(() => '/tmp/user-skills'),
        workspaceSkillsRoot: vi.fn(() => `${registered}/.taskwraith/skills`)
      },
      revealPathInFinder: vi.fn(async () => ({ ok: true })),
      isMainRendererSender: vi.fn(() => true),
      requireRegisteredWorkspace: vi.fn(() => registered),
      assertSenderScope: vi.fn()
    }

    registerSkillsHandlers(deps)
    const event = { sender: { id: 1 } }

    handlerFor('skills:list-workspace')(event, { workspacePath: '/alias/ws', workspaceId: 'w1' })
    expect(deps.requireRegisteredWorkspace).toHaveBeenCalledWith('/alias/ws')
    expect(deps.assertSenderScope).toHaveBeenCalledWith(event, registered)
    expect(deps.skillsStore.listWorkspaceSkills).toHaveBeenCalledWith(registered, 'w1')

    handlerFor('skills:upsert')(event, {
      scope: 'workspace',
      workspacePath: '/alias/ws',
      name: 'WS',
      body: 'x',
      workspaceId: 'w1'
    })
    expect(deps.skillsStore.upsertWorkspaceSkill).toHaveBeenCalledWith(
      registered,
      expect.objectContaining({ name: 'WS', scope: 'workspace' }),
      'w1'
    )
  })
})
