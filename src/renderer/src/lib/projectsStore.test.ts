import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keep the localStorage fake installed before importing the store module, matching
// the pattern used across existing renderer store tests.
const fake = vi.hoisted(() => {
  const store = new Map<string, string>()
  const listeners: Record<string, Array<(event: unknown) => void>> = {}
  const localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      const oldValue = store.get(key) ?? null
      store.set(key, value)
      ;(listeners.storage || []).forEach((cb) =>
        cb({
          storageArea: localStorage,
          key,
          oldValue,
          newValue: value
        })
      )
    },
    removeItem: (key: string) => {
      const oldValue = store.get(key) ?? null
      store.delete(key)
      ;(listeners.storage || []).forEach((cb) =>
        cb({
          storageArea: localStorage,
          key,
          oldValue,
          newValue: null
        })
      )
    },
    clear: () => {
      store.clear()
    }
  }
  const fakeWindow = {
    localStorage,
    addEventListener: (type: string, cb: (event: unknown) => void) => {
      ;(listeners[type] ||= []).push(cb)
    },
    removeEventListener: (type: string, cb: (event: unknown) => void) => {
      listeners[type] = (listeners[type] || []).filter((fn) => fn !== cb)
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  return { store, listeners, localStorage }
})

import {
  addChatToProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  moveProject,
  PROJECTS_STORAGE_KEY,
  reorderProject,
  removeChatFromAllProjects,
  removeChatFromProject,
  renameProject,
  setProjectIconAndHue
} from './projectsStore'

beforeEach(() => {
  fake.store.clear()
})

function expectSortedProjectOrder(projects: Array<{ id: string; order: number }>): string[] {
  return [...projects].sort((a, b) => a.order - b.order).map((project) => project.id)
}

describe('projectsStore CRUD', () => {
  it('creates, renames, and deletes projects, then reindexes root order', () => {
    const first = createProject({ name: 'First' })
    const second = createProject({ name: 'Second' })
    const third = createProject({ name: 'Third' })

    const renamed = renameProject(second.id, 'Second Renamed')
    expect(renamed.name).toBe('Second Renamed')
    expect(getProject(second.id)?.name).toBe('Second Renamed')

    const remainingBeforeDelete = expectSortedProjectOrder(
      listProjects()
        .filter((project) => project.parentId === null)
        .map((project) => ({ id: project.id, order: project.order }))
    )
    expect(remainingBeforeDelete).toEqual([first.id, second.id, third.id])

    deleteProject(renamed.id)
    const remaining = listProjects().filter((project) => project.parentId === null)
    expect(remaining).toHaveLength(2)
    expect(remaining[0].order).toBe(1)
    expect(remaining[1].order).toBe(2)
    expect(remaining.map((project) => project.id)).toEqual([first.id, third.id])
  })

  it('persists to and restores from localStorage while filtering malformed data', () => {
    fake.localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify([
        {
          schemaVersion: 1,
          id: 'bad-project',
          name: '',
          icon: { iconKind: 'seed', seed: 'x' },
          hue: 12,
          parentId: null,
          order: 2,
          memberChatIds: [],
          createdAt: 1,
          updatedAt: 1
        },
        {
          schemaVersion: 1,
          id: 'x1',
          name: 'Valid',
          icon: { iconKind: 'seed', seed: 'v' },
          hue: 12,
          parentId: null,
          order: 2,
          memberChatIds: [],
          createdAt: 1,
          updatedAt: 2
        },
        {
          schemaVersion: 1,
          id: 'x1',
          name: 'Duplicate',
          icon: { iconKind: 'seed', seed: 'dup' },
          hue: 18,
          parentId: null,
          order: 1,
          memberChatIds: [],
          createdAt: 2,
          updatedAt: 3
        }
      ])
    )

    const projects = listProjects()
    expect(projects).toHaveLength(1)
    expect(projects[0].id).toBe('x1')
    expect(projects[0].name).toBe('Valid')
  })
})

describe('projectsStore hierarchy and ordering', () => {
  it('reorders root projects', () => {
    const first = createProject({ name: 'Alpha' })
    const second = createProject({ name: 'Beta' })
    const third = createProject({ name: 'Gamma' })

    const moved = reorderProject(third.id, 1)
    expect(moved.order).toBe(1)

    const rootIds = listProjects()
      .filter((project) => project.parentId === null)
      .map((project) => ({ id: project.id, order: project.order }))
    expect(expectSortedProjectOrder(rootIds)).toEqual([third.id, first.id, second.id])
  })

  it('moves a project under a different parent and preserves hierarchy', () => {
    const rootA = createProject({ name: 'Root A' })
    const rootB = createProject({ name: 'Root B' })
    const child = createProject({ name: 'Child', parentId: rootA.id })

    const moved = moveProject(child.id, rootB.id, 1)
    expect(moved.parentId).toBe(rootB.id)

    const childIdsInA = listProjects().filter((project) => project.parentId === rootA.id)
    expect(childIdsInA).toHaveLength(0)
    const childIdsInB = listProjects().filter((project) => project.parentId === rootB.id)
    expect(childIdsInB).toHaveLength(1)
    expect(childIdsInB[0]?.id).toBe(child.id)
  })
})

describe('projectsStore membership', () => {
  it('adds and removes chat ids idempotently', () => {
    const project = createProject({ name: 'Project' })
    const withFirst = addChatToProject(project.id, 'chat-1')
    const withSecond = addChatToProject(withFirst.id, 'chat-1')
    expect(withSecond.memberChatIds).toEqual(['chat-1'])

    const withNew = addChatToProject(withSecond.id, 'chat-2')
    expect(withNew.memberChatIds).toEqual(['chat-1', 'chat-2'])

    const afterRemove = removeChatFromProject(withNew.id, 'chat-1')
    expect(afterRemove.memberChatIds).toEqual(['chat-2'])
  })

  it('removes a deleted chat id from every affected project only', () => {
    const first = createProject({ name: 'First', memberChatIds: ['chat-1', 'chat-2'] })
    const second = createProject({ name: 'Second', memberChatIds: ['chat-2', 'chat-3'] })
    const untouched = createProject({ name: 'Untouched', memberChatIds: ['chat-4'] })

    const changed = removeChatFromAllProjects('chat-2')
    expect(changed).toBe(2)

    expect(getProject(first.id)?.memberChatIds).toEqual(['chat-1'])
    expect(getProject(second.id)?.memberChatIds).toEqual(['chat-3'])
    expect(getProject(untouched.id)?.memberChatIds).toEqual(['chat-4'])
  })

  it('updates project icon and hue', () => {
    const project = createProject({ name: 'Visualized' })
    const next = setProjectIconAndHue(project.id, {
      hue: 42,
      icon: { iconKind: 'named', slug: 'demo-project-icon' }
    })
    expect(next.hue).toBe(42)
    expect(next.icon).toEqual({ iconKind: 'named', slug: 'demo-project-icon' })
  })
})
