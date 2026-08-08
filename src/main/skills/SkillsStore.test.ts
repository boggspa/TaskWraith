import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SkillsStore } from './SkillsStore'

let userDataPath = ''
let workspacePath = ''

beforeEach(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-skills-user-'))
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-skills-ws-'))
})

afterEach(() => {
  if (userDataPath) fs.rmSync(userDataPath, { recursive: true, force: true })
  if (workspacePath) fs.rmSync(workspacePath, { recursive: true, force: true })
  userDataPath = ''
  workspacePath = ''
})

function makeStore(now = '2026-08-08T12:00:00.000Z'): SkillsStore {
  return new SkillsStore({
    userDataPath,
    now: () => new Date(now)
  })
}

describe('SkillsStore', () => {
  it('workspace skills override user skills by id and drop disabled entries', () => {
    const store = makeStore()
    store.upsertUserSkill({
      id: 'shared',
      name: 'User Shared',
      description: 'from user',
      body: 'user body',
      enabled: true
    })
    store.upsertUserSkill({
      id: 'user-only',
      name: 'User Only',
      description: 'user only',
      body: 'only user',
      enabled: true
    })
    store.upsertUserSkill({
      id: 'disabled-user',
      name: 'Disabled User',
      description: 'off',
      body: 'off',
      enabled: false
    })

    store.upsertWorkspaceSkill(
      workspacePath,
      {
        id: 'shared',
        name: 'Workspace Shared',
        description: 'from workspace',
        body: 'workspace body',
        enabled: true
      },
      'ws-1'
    )
    store.upsertWorkspaceSkill(
      workspacePath,
      {
        id: 'ws-disabled',
        name: 'WS Disabled',
        description: 'off',
        body: 'off',
        enabled: false
      },
      'ws-1'
    )

    const effective = store.resolveEffectiveSkills(workspacePath, 'ws-1')
    expect(effective.map((s) => s.id).sort()).toEqual(['shared', 'user-only'])
    const shared = effective.find((s) => s.id === 'shared')
    expect(shared).toMatchObject({
      name: 'Workspace Shared',
      description: 'from workspace',
      body: 'workspace body',
      source: 'workspace',
      scope: 'workspace',
      workspaceId: 'ws-1'
    })
    const userOnly = effective.find((s) => s.id === 'user-only')
    expect(userOnly).toMatchObject({
      name: 'User Only',
      source: 'user',
      scope: 'user'
    })
  })

  it('rejects path-escape skill ids under user and workspace roots', () => {
    const store = makeStore()
    expect(() =>
      store.upsertUserSkill({
        id: '../escape',
        name: 'Bad',
        body: 'nope'
      })
    ).toThrow(/invalid skill id|escape|path/i)

    expect(() =>
      store.upsertWorkspaceSkill(workspacePath, {
        id: '..',
        name: 'Bad',
        body: 'nope'
      })
    ).toThrow(/invalid skill id|escape|path/i)

    expect(() =>
      store.upsertUserSkill({
        id: 'ok/../../evil',
        name: 'Bad',
        body: 'nope'
      })
    ).toThrow(/invalid skill id|escape|path/i)

    const outside = path.join(userDataPath, 'outside.txt')
    expect(fs.existsSync(outside)).toBe(false)
    expect(fs.existsSync(path.join(userDataPath, 'skills', '..', 'outside.txt'))).toBe(false)
  })

  it('rejects non-absolute workspacePath for workspace skills roots and mutations', () => {
    const store = makeStore()
    expect(() => store.workspaceSkillsRoot('../not-absolute')).toThrow(/absolute/i)
    expect(() => store.listWorkspaceSkills(path.join('..', 'escape'))).toThrow(/absolute/i)
    expect(() =>
      store.upsertWorkspaceSkill('relative/ws', {
        id: 'x',
        name: 'X',
        body: 'nope'
      })
    ).toThrow(/absolute/i)
    expect(() => store.deleteWorkspaceSkill('../not-absolute', 'x')).toThrow(/absolute/i)
  })

  it('setEnabled toggles without losing body and persists across list', () => {
    const store = makeStore()
    store.upsertUserSkill({
      id: 'toggle-me',
      name: 'Toggle',
      description: 'desc',
      body: 'keep this body',
      enabled: true
    })

    const disabled = store.setUserSkillEnabled('toggle-me', false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.body).toBe('keep this body')

    const listed = store.listUserSkills()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: 'toggle-me',
      enabled: false,
      body: 'keep this body',
      name: 'Toggle'
    })

    const reenabled = store.setUserSkillEnabled('toggle-me', true)
    expect(reenabled.enabled).toBe(true)

    const effective = store.resolveEffectiveSkills(workspacePath)
    expect(effective.map((s) => s.id)).toEqual(['toggle-me'])
  })

  it('parses SKILL.md YAML frontmatter for name, description, and enabled', () => {
    const store = makeStore()
    const skillDir = path.join(userDataPath, 'skills', 'frontmatter-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: Front Name',
        'description: Front Desc',
        'enabled: false',
        '---',
        '',
        'Body from file'
      ].join('\n'),
      'utf8'
    )

    const listed = store.listUserSkills()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: 'frontmatter-skill',
      name: 'Front Name',
      description: 'Front Desc',
      enabled: false,
      body: 'Body from file',
      relativePath: 'SKILL.md',
      scope: 'user'
    })
    expect(store.resolveEffectiveSkills(workspacePath)).toEqual([])
  })
})
