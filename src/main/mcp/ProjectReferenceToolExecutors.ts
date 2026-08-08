import type { ProviderId } from '../store/types'
import type { ProjectReferenceProposalService } from '../services/ProjectReferenceProposalService'
import type {
  Project,
  ProjectReference,
  ProjectReferenceKind
} from '../../shared/projects'
import type { ProjectReferenceProposalPreviewSource } from '../../shared/projectReferenceProposal'

export const PROJECT_REFERENCE_MCP_TOOL_NAMES = [
  'project_reference_propose',
  'project_reference_list'
] as const

export type ProjectReferenceMcpToolName = (typeof PROJECT_REFERENCE_MCP_TOOL_NAMES)[number]

/** Hard cap for list responses — metadata catalogue browse only. */
export const PROJECT_REFERENCE_LIST_MAX = 200

const PROJECT_REFERENCE_MCP_TOOL_NAME_SET = new Set<string>(
  PROJECT_REFERENCE_MCP_TOOL_NAMES
)

const PREVIEW_SOURCES = new Set<ProjectReferenceProposalPreviewSource>([
  'web_search',
  'web_fetch',
  'document_extract',
  'agent_context',
  'manual'
])

export function isProjectReferenceMcpToolName(
  value: string
): value is ProjectReferenceMcpToolName {
  return PROJECT_REFERENCE_MCP_TOOL_NAME_SET.has(value)
}

export interface ProjectReferenceToolContext {
  appChatId?: string
  appRunId?: string
}

export interface ProjectReferenceToolMetadata {
  provider: ProviderId
  toolCallId?: string
}

export interface ProjectReferenceListItem {
  id: string
  kind: ProjectReferenceKind
  locator: string
  title: string
  contextPolicy: ProjectReference['contextPolicy']
  lastVerified?: ProjectReference['lastVerified']
  updatedAt: number
}

export interface ProjectReferenceToolExecutors {
  executeProjectReferenceMcpTool: (
    toolName: ProjectReferenceMcpToolName,
    args: Record<string, unknown>,
    context: ProjectReferenceToolContext,
    metadata: ProjectReferenceToolMetadata
  ) => Promise<{ result: unknown; isError: boolean }>
}

function resolveProjectForChat(
  projects: readonly Project[],
  chatId: string,
  requestedProjectId?: string
): Project {
  const membership = projects.filter((project) => project.memberChatIds.includes(chatId))
  const requested = requestedProjectId?.trim()
  if (requested) {
    const project = membership.find((candidate) => candidate.id === requested)
    if (!project) throw new Error('Current chat is not a member of the requested Project.')
    return project
  }
  if (membership.length === 0) throw new Error('Current chat is not a member of a Project.')
  if (membership.length > 1) {
    throw new Error(
      'Current chat belongs to multiple Projects; an explicit Project id is required.'
    )
  }
  return membership[0]
}

function isReferenceKind(value: unknown): value is ProjectReferenceKind {
  return (
    value === 'file' || value === 'folder' || value === 'url' || value === 'connector'
  )
}

function isPreviewSource(value: unknown): value is ProjectReferenceProposalPreviewSource {
  return typeof value === 'string' && PREVIEW_SOURCES.has(value as ProjectReferenceProposalPreviewSource)
}

function toListItem(reference: ProjectReference): ProjectReferenceListItem {
  return {
    id: reference.id,
    kind: reference.kind,
    locator: reference.locator,
    title: reference.title,
    contextPolicy: reference.contextPolicy,
    ...(reference.lastVerified ? { lastVerified: { ...reference.lastVerified } } : {}),
    updatedAt: reference.updatedAt
  }
}

export function createProjectReferenceToolExecutors(input: {
  proposalService: Pick<ProjectReferenceProposalService, 'propose'>
  getProjects: () => readonly Project[]
  getReferences: () => readonly ProjectReference[]
  notifyChanged?: (projectId: string) => void
}): ProjectReferenceToolExecutors {
  return {
    executeProjectReferenceMcpTool: async (toolName, args, context, metadata) => {
      try {
        if (toolName === 'project_reference_list') {
          const chatId = context.appChatId?.trim()
          if (!chatId) {
            throw new Error('Project reference list requires an active routed chat.')
          }
          const project = resolveProjectForChat(
            input.getProjects(),
            chatId,
            typeof args.projectId === 'string' ? args.projectId : undefined
          )
          const includeOff = args.includeOff === false ? false : true
          const kindFilter = isReferenceKind(args.kind) ? args.kind : null
          if (args.kind !== undefined && args.kind !== null && !kindFilter) {
            throw new Error('Reference kind must be file, folder, url, or connector.')
          }
          const matched = input
            .getReferences()
            .filter((reference) => reference.projectId === project.id)
            .filter((reference) => (includeOff ? true : reference.contextPolicy !== 'off'))
            .filter((reference) => (kindFilter ? reference.kind === kindFilter : true))
            .slice()
            .sort((left, right) => {
              if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt
              return left.id.localeCompare(right.id)
            })
          const truncated = matched.length > PROJECT_REFERENCE_LIST_MAX
          const references = matched.slice(0, PROJECT_REFERENCE_LIST_MAX).map(toListItem)
          return {
            result: {
              ok: true,
              tool: toolName,
              projectId: project.id,
              references,
              truncated
            },
            isError: false
          }
        }

        if (toolName !== 'project_reference_propose') {
          throw new Error(`Unknown Project reference tool: ${toolName}`)
        }
        const runId = context.appRunId?.trim()
        const chatId = context.appChatId?.trim()
        if (!runId || !chatId) {
          throw new Error(
            'Project reference proposals require an active, routed chat run.'
          )
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        if (!reason) throw new Error('Proposal reason is required.')
        const referenceKind: ProjectReferenceKind | null =
          args.referenceKind === 'file' ||
          args.referenceKind === 'folder' ||
          args.referenceKind === 'url'
            ? args.referenceKind
            : null
        if (!referenceKind) throw new Error('Reference kind must be file, folder, or url.')
        if (typeof args.locator !== 'string') throw new Error('Reference locator is required.')

        const previewSnippet =
          typeof args.previewSnippet === 'string' ? args.previewSnippet : undefined
        const previewSource = isPreviewSource(args.previewSource)
          ? args.previewSource
          : undefined

        const proposal = input.proposalService.propose({
          runId,
          chatId,
          ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
          kind: referenceKind,
          locator: args.locator,
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          reason,
          ...(previewSnippet !== undefined ? { previewSnippet } : {}),
          ...(previewSource !== undefined ? { previewSource } : {}),
          provider: metadata.provider,
          toolCallId: metadata.toolCallId
        })
        if (proposal.created) input.notifyChanged?.(proposal.proposal.payload.projectId)
        return {
          result: {
            ok: true,
            tool: toolName,
            created: proposal.created,
            status: 'proposed_for_human_review',
            proposalId: proposal.proposal.payload.proposalId,
            projectId: proposal.proposal.payload.projectId,
            candidate: proposal.proposal.payload.candidate,
            message: proposal.created
              ? 'Proposed for human review in the Project reference library.'
              : 'This reference was already proposed by the current run.'
          },
          isError: false
        }
      } catch (error) {
        return {
          result: {
            ok: false,
            tool: toolName,
            error: error instanceof Error ? error.message : String(error)
          },
          isError: true
        }
      }
    }
  }
}
