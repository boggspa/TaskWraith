import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore } from '../store'
import type { ChatRecord } from './types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-project-reconcile-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const chatsDir = join(userDataPath, 'chats')

let projectCounter = 0
function createProjectWithMembers(memberChatIds: string[]): string {
  projectCounter += 1
  const id = `project-test-${projectCounter}`
  AppStore.applyProjectOp({
    kind: 'create',
    input: { name: `Project ${projectCounter}`, memberChatIds },
    id,
    now: Date.now(),
    defaultHue: 200
  })
  return id
}

function membersOf(projectId: string): string[] {
  const project = AppStore.getProjects().find((entry) => entry.id === projectId)
  if (!project) throw new Error(`Missing project ${projectId}`)
  return project.memberChatIds
}

/**
 * Main-side membership reconciliation: chat deletions that never pass through
 * the renderer (reaper, clear-chats, iOS-bridge cleanup) must still remove the
 * chat id from every project's memberChatIds. The hook lives at the
 * AppStore.deleteChat choke point plus a wholesale sweep in the full
 * clearChats() branch.
 */
describe('project membership reconciliation on chat deletion', () => {
  beforeEach(() => {
    AppStore.resetTransientDeletionGuardsForTests()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
  })

  it('deleteChat removes the id from every project that references it', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    const keeper = 'chat-keeper'
    const projectA = createProjectWithMembers([chat.appChatId, keeper])
    const projectB = createProjectWithMembers([chat.appChatId])

    AppStore.deleteChat(chat.appChatId)

    expect(membersOf(projectA)).toEqual([keeper])
    expect(membersOf(projectB)).toEqual([])
  })

  it('cascade deletes reconcile child-chat membership too', () => {
    const parent = AppStore.createChat('ws-1', '/repo')
    const child = AppStore.createChat('ws-1', '/repo')
    AppStore.saveChat({ ...child, parentChatId: parent.appChatId } as ChatRecord)
    const project = createProjectWithMembers([parent.appChatId, child.appChatId])

    AppStore.deleteChat(parent.appChatId)

    expect(fs.existsSync(join(chatsDir, `${child.appChatId}.json`))).toBe(false)
    expect(membersOf(project)).toEqual([])
  })

  it('deleting an id with no chat file still heals stale membership', () => {
    const project = createProjectWithMembers(['chat-already-gone'])

    AppStore.deleteChat('chat-already-gone')

    expect(membersOf(project)).toEqual([])
  })

  it('a full clearChats() sweeps every membership, including already-stale ids', () => {
    const chat = AppStore.createChat('ws-1', '/repo')
    const projectA = createProjectWithMembers([chat.appChatId])
    const projectB = createProjectWithMembers(['chat-stale-before-clear'])

    AppStore.clearChats()

    expect(membersOf(projectA)).toEqual([])
    expect(membersOf(projectB)).toEqual([])
  })

  it("a workspace-scoped clearChats reconciles only that workspace's chats", () => {
    const inWorkspace = AppStore.createChat('ws-1', '/repo')
    const elsewhere = AppStore.createChat('ws-2', '/other')
    const project = createProjectWithMembers([inWorkspace.appChatId, elsewhere.appChatId])

    AppStore.clearChats('ws-1')

    expect(membersOf(project)).toEqual([elsewhere.appChatId])
  })
})
