import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type JSX
} from 'react'
import type {
  ChatRecord,
  PooledAgentIdentitySnapshot,
  ProviderId
} from '../../../main/store/types'
import {
  addChatToProject,
  createProject,
  deleteProject,
  listProjects,
  moveProject,
  removeChatFromProject,
  renameProject,
  reorderProject,
  setProjectIconAndHue,
  subscribeProjects,
  type Project
} from '../lib/projectsStore'
import { getProviderLabel } from '../lib/providerLabels'
import { PooledAgentIcon } from './icons/PooledAgentIcon'
import { ProviderGlyph } from './icons/ProviderGlyph'
import { IdentityIconPicker } from './IdentityIconPicker'

interface ProjectsSidebarViewProps {
  chats: ChatRecord[]
  currentChat: ChatRecord | null
  activeChatId?: string | null
  runningChatIds?: string[]
  searchQuery: string
  isSearchActive: boolean
  onSelectChat: (chat: ChatRecord) => void
  onSearchResultCountChange?: (count: number) => void
}

interface ProjectNode {
  project: Project
  children: ProjectNode[]
}

function sortProjects(left: Project, right: Project): number {
  if (left.order === right.order) return left.name.localeCompare(right.name)
  return left.order - right.order
}

function buildProjectTree(projects: Project[]): ProjectNode[] {
  const nodes = new Map<string, ProjectNode>()
  for (const project of projects) {
    nodes.set(project.id, { project, children: [] })
  }

  const roots: ProjectNode[] = []
  for (const node of nodes.values()) {
    const parent = node.project.parentId ? nodes.get(node.project.parentId) : null
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortNode = (node: ProjectNode): void => {
    node.children.sort((a, b) => sortProjects(a.project, b.project))
    node.children.forEach(sortNode)
  }
  roots.sort((a, b) => sortProjects(a.project, b.project))
  roots.forEach(sortNode)
  return roots
}

function collectDescendantIds(node: ProjectNode, out = new Set<string>()): Set<string> {
  for (const child of node.children) {
    out.add(child.project.id)
    collectDescendantIds(child, out)
  }
  return out
}

function flattenNodes(nodes: ProjectNode[]): ProjectNode[] {
  const out: ProjectNode[] = []
  const visit = (node: ProjectNode): void => {
    out.push(node)
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return out
}

function chatProviderId(chat: ChatRecord): ProviderId | 'ensemble' {
  return chat.chatKind === 'ensemble' ? 'ensemble' : chat.provider || 'gemini'
}

function providerLabel(chat: ChatRecord): string {
  if (chat.chatKind === 'ensemble') return 'Ensemble'
  return getProviderLabel(chat.provider || 'gemini')
}

function chatMatchesSearch(chat: ChatRecord, query: string): boolean {
  if (!query) return true
  return [chat.title, providerLabel(chat), chat.workspacePath, chat.appChatId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(query)
}

function projectMatchesSearch(project: Project, memberChats: ChatRecord[], query: string): boolean {
  if (!query) return true
  if (project.name.toLowerCase().includes(query)) return true
  return memberChats.some((chat) => chatMatchesSearch(chat, query))
}

function projectIdentity(project: Project): PooledAgentIdentitySnapshot {
  return {
    schemaVersion: 1,
    agentId: project.id,
    nickname: project.name,
    iconKind: project.icon.iconKind,
    hue: project.hue,
    accent: project.icon.accent,
    slug: project.icon.slug,
    assetKey: project.icon.assetKey,
    seed: project.icon.seed || project.id,
    hueEnabled: true
  }
}

function HighlightMatch({ text, query }: { text: string; query: string }): JSX.Element | string {
  if (!query) return text
  const lowerText = text.toLowerCase()
  const index = lowerText.indexOf(query)
  if (index < 0) return text
  const end = index + query.length
  return (
    <>
      {text.slice(0, index)}
      <mark className="sidebar-search-highlight">{text.slice(index, end)}</mark>
      {text.slice(end)}
    </>
  )
}

export function ProjectsSidebarView({
  chats,
  currentChat,
  activeChatId,
  runningChatIds = [],
  searchQuery,
  isSearchActive,
  onSelectChat,
  onSearchResultCountChange
}: ProjectsSidebarViewProps): JSX.Element {
  const [projects, setProjects] = useState<Project[]>(() => listProjects())
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    const refresh = (): void => setProjects(listProjects())
    refresh()
    return subscribeProjects(refresh)
  }, [])

  const chatById = useMemo(() => {
    const map = new Map<string, ChatRecord>()
    for (const chat of chats) {
      if (!chat.archived) map.set(chat.appChatId, chat)
    }
    return map
  }, [chats])

  const runningChatIdSet = useMemo(() => new Set(runningChatIds), [runningChatIds])
  const selectedChatId = activeChatId ?? currentChat?.appChatId ?? null
  const projectTree = useMemo(() => buildProjectTree(projects), [projects])
  const flatNodes = useMemo(() => flattenNodes(projectTree), [projectTree])
  const selectedProject = selectedProjectId
    ? projects.find((project) => project.id === selectedProjectId) ?? null
    : null

  const descendantIdsByProjectId = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const node of flatNodes) {
      map.set(node.project.id, collectDescendantIds(node))
    }
    return map
  }, [flatNodes])

  const eligibleParentProjects = selectedProject
    ? projects
        .filter(
          (project) =>
            project.id !== selectedProject.id &&
            !descendantIdsByProjectId.get(selectedProject.id)?.has(project.id)
        )
        .sort(sortProjects)
    : []

  const runStoreAction = (action: () => Project | void): void => {
    try {
      const result = action()
      setProjects(listProjects())
      if (result && 'id' in result) setSelectedProjectId(result.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Project update failed.')
    }
  }

  const promptForProject = (parentId: string | null): void => {
    const name = window.prompt(parentId ? 'New child project name' : 'New project name')
    const trimmed = name?.trim()
    if (!trimmed) return
    runStoreAction(() => {
      const project = createProject({ name: trimmed, parentId })
      if (parentId) {
        setExpandedProjectIds((current) => new Set(current).add(parentId))
      }
      return project
    })
  }

  const promptRename = (project: Project): void => {
    const name = window.prompt('Rename project', project.name)
    const trimmed = name?.trim()
    if (!trimmed || trimmed === project.name) return
    runStoreAction(() => renameProject(project.id, trimmed))
  }

  const confirmDelete = (project: Project): void => {
    const descendantCount = descendantIdsByProjectId.get(project.id)?.size ?? 0
    const label = descendantCount > 0 ? ` and ${descendantCount} child project(s)` : ''
    if (!window.confirm(`Delete "${project.name}"${label}?`)) return
    runStoreAction(() => {
      deleteProject(project.id)
      setSelectedProjectId((current) => (current === project.id ? null : current))
    })
  }

  const addMember = (projectId: string, chatId: string): void => {
    if (!chatId) return
    runStoreAction(() => addChatToProject(projectId, chatId))
  }

  const removeMember = (projectId: string, chatId: string): void => {
    runStoreAction(() => removeChatFromProject(projectId, chatId))
  }

  const visibleNodeIds = useMemo(() => {
    if (!isSearchActive) return new Set(projects.map((project) => project.id))
    const visible = new Set<string>()
    const visit = (node: ProjectNode): boolean => {
      const memberChats = node.project.memberChatIds
        .map((id) => chatById.get(id))
        .filter((chat): chat is ChatRecord => Boolean(chat))
      const selfMatches = projectMatchesSearch(node.project, memberChats, searchQuery)
      const childMatches = node.children.map(visit).some(Boolean)
      if (selfMatches || childMatches) visible.add(node.project.id)
      return selfMatches || childMatches
    }
    projectTree.forEach(visit)
    return visible
  }, [chatById, isSearchActive, projectTree, projects, searchQuery])

  const searchResultCount = useMemo(() => {
    if (!isSearchActive) return 0
    const matchedMemberChatIds = new Set<string>()
    let matchedProjects = 0
    for (const project of projects) {
      const memberChats = project.memberChatIds
        .map((id) => chatById.get(id))
        .filter((chat): chat is ChatRecord => Boolean(chat))
      if (projectMatchesSearch(project, memberChats, searchQuery)) {
        matchedProjects += 1
      }
      for (const chat of memberChats) {
        if (chatMatchesSearch(chat, searchQuery)) matchedMemberChatIds.add(chat.appChatId)
      }
    }
    return matchedProjects + matchedMemberChatIds.size
  }, [chatById, isSearchActive, projects, searchQuery])

  useEffect(() => {
    onSearchResultCountChange?.(searchResultCount)
  }, [onSearchResultCountChange, searchResultCount])

  const renderChatRow = (chat: ChatRecord, project: Project): JSX.Element => {
    const provider = chatProviderId(chat)
    const isRunning = runningChatIdSet.has(chat.appChatId)
    return (
      <div
        role="button"
        tabIndex={0}
        key={chat.appChatId}
        className={`sidebar-project-member provider-${provider} ${
          selectedChatId === chat.appChatId ? 'active' : ''
        } ${isRunning ? 'running' : ''}`}
        onClick={() => onSelectChat(chat)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelectChat(chat)
          }
        }}
        title={chat.title}
      >
        <span className={`sidebar-provider-icon provider-${provider}`} aria-hidden>
          <ProviderGlyph provider={provider} />
        </span>
        <span className="sidebar-project-member-copy">
          <span className="sidebar-project-member-title">
            <HighlightMatch text={chat.title} query={searchQuery} />
          </span>
          <span className="sidebar-project-member-meta">{providerLabel(chat)}</span>
        </span>
        {isRunning && <span className="sidebar-chat-busy" title="Task running" />}
        <button
          type="button"
          className="sidebar-project-icon-button danger"
          onClick={(event) => {
            event.stopPropagation()
            removeMember(project.id, chat.appChatId)
          }}
          title="Remove from project"
          aria-label={`Remove ${chat.title} from ${project.name}`}
        >
          -
        </button>
      </div>
    )
  }

  const renderNode = (node: ProjectNode, depth = 0): JSX.Element | null => {
    const { project } = node
    if (!visibleNodeIds.has(project.id)) return null
    const expanded = isSearchActive || expandedProjectIds.has(project.id)
    const selected = selectedProjectId === project.id
    const memberChats = project.memberChatIds
      .map((id) => chatById.get(id))
      .filter((chat): chat is ChatRecord => Boolean(chat))
      .filter((chat) => !isSearchActive || chatMatchesSearch(chat, searchQuery))
    const availableChats = chats
      .filter((chat) => !chat.archived && !project.memberChatIds.includes(chat.appChatId))
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title))
    const siblings = projects.filter((item) => item.parentId === project.parentId)
    const hasChildren = node.children.length > 0
    const childRows = node.children.map((child) => renderNode(child, depth + 1))

    return (
      <div
        key={project.id}
        className={`sidebar-project-node ${selected ? 'is-selected' : ''}`}
        style={{ '--project-depth': depth } as CSSProperties}
      >
        <div
          role="button"
          tabIndex={0}
          className="sidebar-project-row"
          onClick={() => setSelectedProjectId((current) => (current === project.id ? null : project.id))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setSelectedProjectId((current) => (current === project.id ? null : project.id))
            }
          }}
          title={project.name}
        >
          <button
            type="button"
            className="sidebar-project-disclosure"
            disabled={!hasChildren}
            onClick={(event) => {
              event.stopPropagation()
              if (!hasChildren) return
              setExpandedProjectIds((current) => {
                const next = new Set(current)
                if (next.has(project.id)) next.delete(project.id)
                else next.add(project.id)
                return next
              })
            }}
            title={expanded ? 'Collapse project' : 'Expand project'}
            aria-label={expanded ? 'Collapse project' : 'Expand project'}
            aria-expanded={expanded}
          >
            {hasChildren ? (expanded ? 'v' : '>') : ''}
          </button>
          <PooledAgentIcon
            identity={projectIdentity(project)}
            size={24}
            className="sidebar-project-icon"
          />
          <span className="sidebar-project-copy">
            <span className="sidebar-project-name">
              <HighlightMatch text={project.name} query={searchQuery} />
            </span>
            <span className="sidebar-project-meta">
              {memberChats.length} thread{memberChats.length === 1 ? '' : 's'}
              {node.children.length > 0
                ? ` / ${node.children.length} folder${node.children.length === 1 ? '' : 's'}`
                : ''}
            </span>
          </span>
          <span className="sidebar-project-actions">
            <button
              type="button"
              className="sidebar-project-icon-button"
              onClick={(event) => {
                event.stopPropagation()
                promptForProject(project.id)
              }}
              title="New child project"
              aria-label={`New child project under ${project.name}`}
            >
              +
            </button>
            <button
              type="button"
              className="sidebar-project-icon-button"
              onClick={(event) => {
                event.stopPropagation()
                promptRename(project)
              }}
              title="Rename project"
              aria-label={`Rename ${project.name}`}
            >
              Rename
            </button>
            <button
              type="button"
              className="sidebar-project-icon-button"
              disabled={project.order <= 1}
              onClick={(event) => {
                event.stopPropagation()
                runStoreAction(() => reorderProject(project.id, project.order - 1))
              }}
              title="Move up"
              aria-label={`Move ${project.name} up`}
            >
              Up
            </button>
            <button
              type="button"
              className="sidebar-project-icon-button"
              disabled={project.order >= siblings.length}
              onClick={(event) => {
                event.stopPropagation()
                runStoreAction(() => reorderProject(project.id, project.order + 1))
              }}
              title="Move down"
              aria-label={`Move ${project.name} down`}
            >
              Dn
            </button>
            <button
              type="button"
              className="sidebar-project-icon-button danger"
              onClick={(event) => {
                event.stopPropagation()
                confirmDelete(project)
              }}
              title="Delete project"
              aria-label={`Delete ${project.name}`}
            >
              x
            </button>
          </span>
        </div>

        {selected && (
          <div className="sidebar-project-detail">
            <IdentityIconPicker
              value={{
                iconKind: project.icon.iconKind,
                hue: project.hue,
                slug: project.icon.slug,
                seed: project.icon.seed,
                assetKey: project.icon.assetKey,
                accent: project.icon.accent
              }}
              seedBase={project.id}
              onChange={(next) =>
                runStoreAction(() =>
                  setProjectIconAndHue(project.id, {
                    icon: {
                      iconKind: next.iconKind,
                      slug: next.slug,
                      seed: next.seed,
                      assetKey: next.assetKey,
                      accent: next.accent
                    },
                    hue: next.hue
                  })
                )
              }
            />
            <label className="sidebar-project-select-row">
              <span>Parent</span>
              <select
                value={project.parentId ?? ''}
                onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                  runStoreAction(() => moveProject(project.id, event.target.value || null))
                }
              >
                <option value="">Root</option>
                {eligibleParentProjects.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="sidebar-project-select-row">
              <span>Add thread</span>
              <select
                value=""
                onChange={(event: ChangeEvent<HTMLSelectElement>) => {
                  addMember(project.id, event.target.value)
                }}
              >
                <option value="">Choose thread...</option>
                {availableChats.map((chat) => (
                  <option key={chat.appChatId} value={chat.appChatId}>
                    {chat.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {memberChats.length > 0 && <div className="sidebar-project-members">{memberChats.map((chat) => renderChatRow(chat, project))}</div>}
        {expanded && childRows.some(Boolean) && (
          <div className="sidebar-project-children">{childRows}</div>
        )}
      </div>
    )
  }

  return (
    <section className="sidebar-projects-view" aria-label="Projects">
      <div className="sidebar-section-header sidebar-projects-header">
        <button type="button" className="sidebar-section-header-toggle" disabled>
          <h4 className="sidebar-section-title">Projects</h4>
        </button>
        <button
          type="button"
          className="sidebar-section-header-action sidebar-project-create"
          onClick={() => promptForProject(null)}
          title="New project"
          aria-label="New project"
        >
          +
        </button>
      </div>

      {projects.length === 0 ? (
        <div className="sidebar-empty-state sidebar-project-empty">
          <strong>No projects yet</strong>
          <span>Create a project to group threads across workspaces, providers, or folders.</span>
          <button type="button" className="sidebar-project-create-large" onClick={() => promptForProject(null)}>
            New project
          </button>
        </div>
      ) : isSearchActive && visibleNodeIds.size === 0 ? (
        <div className="sidebar-empty-state">
          <strong>No project matches</strong>
          <span>Try a project name, provider, or thread title.</span>
        </div>
      ) : (
        <div className="sidebar-project-tree">{projectTree.map((node) => renderNode(node))}</div>
      )}
    </section>
  )
}
