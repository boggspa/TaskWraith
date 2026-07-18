import type { ProviderId } from '../store/types'
import type { ProjectReferenceProposalService } from '../services/ProjectReferenceProposalService'
import type { ProjectReferenceKind } from '../../shared/projects'

export const PROJECT_REFERENCE_MCP_TOOL_NAMES = ['project_reference_propose'] as const

export type ProjectReferenceMcpToolName = (typeof PROJECT_REFERENCE_MCP_TOOL_NAMES)[number]

const PROJECT_REFERENCE_MCP_TOOL_NAME_SET = new Set<string>(
  PROJECT_REFERENCE_MCP_TOOL_NAMES
)

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

export interface ProjectReferenceToolExecutors {
  executeProjectReferenceMcpTool: (
    toolName: ProjectReferenceMcpToolName,
    args: Record<string, unknown>,
    context: ProjectReferenceToolContext,
    metadata: ProjectReferenceToolMetadata
  ) => Promise<{ result: unknown; isError: boolean }>
}

export function createProjectReferenceToolExecutors(input: {
  proposalService: Pick<ProjectReferenceProposalService, 'propose'>
  notifyChanged?: (projectId: string) => void
}): ProjectReferenceToolExecutors {
  return {
    executeProjectReferenceMcpTool: async (toolName, args, context, metadata) => {
      try {
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

        const proposal = input.proposalService.propose({
          runId,
          chatId,
          ...(typeof args.projectId === 'string' ? { projectId: args.projectId } : {}),
          kind: referenceKind,
          locator: args.locator,
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
          reason,
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
