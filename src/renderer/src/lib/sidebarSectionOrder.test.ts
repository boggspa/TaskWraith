import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SIDEBAR_HIERARCHY_ORDER,
  loadSidebarHierarchyOrder,
  normalizeSidebarHierarchyOrder,
  type SidebarHierarchySectionId
} from './sidebarSectionOrder'

const STORAGE_KEY = 'taskwraith-sidebar-hierarchy-order'
const STORAGE_VERSION_KEY = 'taskwraith-sidebar-hierarchy-order-version'
const STORAGE_VERSION = 'hierarchy-v1'

const EXPECTED_DEFAULT_ORDER: SidebarHierarchySectionId[] = [
  'active-runs',
  'local-servers',
  'pinned',
  'recents',
  'workspaces',
  'chats',
  'shared',
  'workflows',
  'ensembles',
  'workspace-boards'
]

const LEGACY_DEFAULT_ORDER: SidebarHierarchySectionId[] = [
  'active-runs',
  'local-servers',
  'workflows',
  'workspace-boards',
  'pinned',
  'recents',
  'ensembles',
  'workspaces',
  'chats',
  'shared'
]

function stubWindowLocalStorage(values: Record<string, string>): void {
  const store = new Map(Object.entries(values))
  vi.stubGlobal('window', {
    localStorage: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value)
      })
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sidebarSectionOrder', () => {
  it('defaults the workspace sidebar hierarchy to the launch order', () => {
    expect([...DEFAULT_SIDEBAR_HIERARCHY_ORDER]).toEqual(EXPECTED_DEFAULT_ORDER)
    expect(normalizeSidebarHierarchyOrder(null)).toEqual(EXPECTED_DEFAULT_ORDER)
  })

  it('appends omitted sections in the default order', () => {
    expect(normalizeSidebarHierarchyOrder(['recents', 'pinned'])).toEqual([
      'recents',
      'pinned',
      'active-runs',
      'local-servers',
      'workspaces',
      'chats',
      'shared',
      'workflows',
      'ensembles',
      'workspace-boards'
    ])
  })

  it('migrates the saved legacy default order without rewriting custom orders', () => {
    stubWindowLocalStorage({
      [STORAGE_VERSION_KEY]: STORAGE_VERSION,
      [STORAGE_KEY]: JSON.stringify(LEGACY_DEFAULT_ORDER)
    })

    expect(loadSidebarHierarchyOrder()).toEqual(EXPECTED_DEFAULT_ORDER)

    const customOrder: SidebarHierarchySectionId[] = [
      'recents',
      'active-runs',
      'local-servers',
      'pinned',
      'workspaces',
      'chats',
      'shared',
      'workflows',
      'ensembles',
      'workspace-boards'
    ]
    stubWindowLocalStorage({
      [STORAGE_VERSION_KEY]: STORAGE_VERSION,
      [STORAGE_KEY]: JSON.stringify(customOrder)
    })

    expect(loadSidebarHierarchyOrder()).toEqual(customOrder)
  })
})
