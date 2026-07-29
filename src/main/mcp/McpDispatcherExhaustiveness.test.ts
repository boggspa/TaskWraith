import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  TASKWRAITH_OWNED_MCP_ACTIONS,
  resolveToolDispatchContractStrict,
  type CanonicalDispatchOwner
} from '../../shared/providerActionTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from '../../shared/taskWraithMcpCatalog'
import { AUDIO_MCP_TOOL_NAMES } from './AudioToolExecutors'
import { AUDIT_MCP_TOOL_NAMES } from './AuditToolExecutors'
import { CANVAS_MCP_TOOL_NAMES } from './CanvasToolExecutors'
import { DESKTOP_MCP_TOOL_NAMES } from './DesktopToolExecutors'
import { DOCUMENT_MCP_TOOL_NAMES } from './DocumentToolExecutors'
import { EVIDENCE_MCP_TOOL_NAMES } from './EvidenceToolExecutors'
import { FFMPEG_MCP_TOOL_NAMES } from './FfmpegToolExecutors'
import { IMAGE_GEN_TOOL_NAMES } from './ImageGenExecutor'
import { IMAGE_MCP_TOOL_NAMES } from './ImageToolExecutors'
import { INTROSPECTION_MCP_TOOL_NAMES } from './IntrospectionToolExecutors'
import { LAUNCH_MCP_TOOL_NAMES } from './LaunchToolExecutors'
import { MESH_MCP_TOOL_NAMES } from './MeshToolExecutors'
import { CAPABILITY_GATEWAY_TOOL_NAMES } from './McpToolGateway'
import { OUTLOOK_MCP_TOOL_NAMES } from './OutlookToolExecutors'
import { PROJECT_REFERENCE_MCP_TOOL_NAMES } from './ProjectReferenceToolExecutors'
import { RECALL_MCP_TOOL_NAMES } from './RecallToolExecutors'
import { THEME_TOKEN_MCP_TOOL_NAMES } from './ThemeTokenToolExecutors'
import { THREAD_MESSAGE_MCP_TOOL_NAMES } from './ThreadMessageToolExecutors'
import { TOOL_PERMISSION_RETRY_TOOL_NAME } from './ToolPermissionRetry'
import { VT_MCP_TOOL_NAMES } from './VtToolExecutors'
import { WORKSPACE_BOARD_MCP_TOOL_NAMES } from './WorkspaceBoardToolExecutors'
import { WORKSPACE_MCP_TOOL_NAMES } from './WorkspaceToolExecutors'

interface DispatcherBranchContract {
  condition: string
  toolNames: readonly string[]
  owners: readonly CanonicalDispatchOwner[]
}

const branch = (
  condition: string,
  toolNames: readonly string[],
  ...owners: readonly CanonicalDispatchOwner[]
): DispatcherBranchContract => ({ condition, toolNames, owners })

const DISPATCHER_BRANCH_CONTRACTS = [
  branch(
    'toolName === TOOL_PERMISSION_RETRY_TOOL_NAME',
    [TOOL_PERMISSION_RETRY_TOOL_NAME],
    'user-question'
  ),
  branch("toolName === 'run_shell_command'", ['run_shell_command'], 'workspace-tools'),
  branch('isAuditMcpToolName(candidateAuditToolName)', AUDIT_MCP_TOOL_NAMES, 'audit-tools'),
  branch('isOutlookMcpToolName(toolName)', OUTLOOK_MCP_TOOL_NAMES, 'outlook-connector'),
  branch(
    'isWorkspaceBoardMcpToolName(toolName)',
    WORKSPACE_BOARD_MCP_TOOL_NAMES,
    'workspace-board'
  ),
  branch(
    'isProjectReferenceMcpToolName(toolName)',
    PROJECT_REFERENCE_MCP_TOOL_NAMES,
    'project-reference'
  ),
  branch('isEvidenceMcpToolName(toolName)', EVIDENCE_MCP_TOOL_NAMES, 'evidence-tools'),
  branch(
    'isWorkspaceMcpToolName(toolName)',
    WORKSPACE_MCP_TOOL_NAMES,
    'workspace-tools',
    'git-tools',
    'github-tools',
    'process-tools',
    'run-control',
    'attachment-tools',
    'subthread-control'
  ),
  branch('isWebMcpToolName(toolName)', ['web_search', 'web_fetch'], 'web-tools'),
  branch("toolName === 'test_result_summary'", ['test_result_summary'], 'evidence-tools'),
  branch(
    "toolName === 'browser_open' || toolName === 'browser_click' || toolName === 'browser_screenshot' || toolName === 'browser_console'",
    ['browser_open', 'browser_click', 'browser_screenshot', 'browser_console'],
    'browser-tools'
  ),
  branch('isCanvasMcpToolName(toolName)', CANVAS_MCP_TOOL_NAMES, 'canvas'),
  branch('isMeshMcpToolName(toolName)', MESH_MCP_TOOL_NAMES, 'mesh-canvas'),
  branch('isLaunchMcpToolName(toolName)', LAUNCH_MCP_TOOL_NAMES, 'launch-control'),
  branch('isRecallMcpToolName(toolName)', RECALL_MCP_TOOL_NAMES, 'cross-thread-recall'),
  branch('isThreadMessageMcpToolName(toolName)', THREAD_MESSAGE_MCP_TOOL_NAMES, 'ensemble-control'),
  branch('isIntrospectionMcpToolName(toolName)', INTROSPECTION_MCP_TOOL_NAMES, 'introspection'),
  branch('isImageMcpToolName(toolName)', IMAGE_MCP_TOOL_NAMES, 'image-tools'),
  branch('isImageGenMcpToolName(toolName)', IMAGE_GEN_TOOL_NAMES, 'image-tools'),
  branch('isFfmpegMcpToolName(toolName)', FFMPEG_MCP_TOOL_NAMES, 'ffmpeg-tools'),
  branch('isThemeTokenMcpToolName(toolName)', THEME_TOKEN_MCP_TOOL_NAMES, 'theme-control'),
  branch('isDocumentMcpToolName(toolName)', DOCUMENT_MCP_TOOL_NAMES, 'document-tools'),
  branch('isVtMcpToolName(toolName)', VT_MCP_TOOL_NAMES, 'native-media'),
  branch('isAudioMcpToolName(toolName)', AUDIO_MCP_TOOL_NAMES, 'audio-tools'),
  branch(
    'isDesktopMcpToolName(toolName)',
    DESKTOP_MCP_TOOL_NAMES,
    'window-capture',
    'appwatch',
    'creative-app',
    'ide-tools',
    'ensemble-control',
    'provider-status',
    'run-control',
    'workspace-tools'
  ),
  branch("toolName === 'switch_auth_profile'", ['switch_auth_profile'], 'provider-status'),
  branch("toolName === 'ensemble_yield'", ['ensemble_yield'], 'ensemble-control'),
  branch("toolName === 'ensemble_send'", ['ensemble_send'], 'ensemble-control'),
  branch("toolName === 'ensemble_fanout'", ['ensemble_fanout'], 'ensemble-control'),
  branch("toolName === 'ensemble_fanout_all'", ['ensemble_fanout_all'], 'ensemble-control'),
  branch("toolName === 'ensemble_await'", ['ensemble_await'], 'ensemble-control'),
  branch("toolName === 'ensemble_lane_result'", ['ensemble_lane_result'], 'ensemble-control'),
  branch(
    "toolName === 'ensemble_bossman_control'",
    ['ensemble_bossman_control'],
    'ensemble-control'
  ),
  branch("toolName === 'ensemble_poll_response'", ['ensemble_poll_response'], 'ensemble-control'),
  branch(
    "toolName === 'ensemble_propose_goal_complete'",
    ['ensemble_propose_goal_complete'],
    'ensemble-control'
  ),
  branch("toolName === 'ensemble_roster_edit'", ['ensemble_roster_edit'], 'ensemble-control'),
  branch("toolName === 'ensemble_brief_update'", ['ensemble_brief_update'], 'ensemble-control'),
  branch(
    "toolName === 'list_ensemble_participants'",
    ['list_ensemble_participants'],
    'ensemble-control'
  ),
  branch("toolName === 'schedule_wakeup'", ['schedule_wakeup'], 'scheduler'),
  branch("toolName === 'cancel_wakeup'", ['cancel_wakeup'], 'scheduler'),
  branch("toolName === 'scout_brief'", ['scout_brief'], 'ensemble-control'),
  branch("toolName === 'blackboard_post'", ['blackboard_post'], 'blackboard'),
  branch("toolName === 'blackboard_read'", ['blackboard_read'], 'blackboard'),
  branch("toolName === 'blackboard_delete'", ['blackboard_delete'], 'blackboard'),
  branch("toolName === 'goal_read'", ['goal_read'], 'goal-control'),
  branch(
    "toolName === 'goal_update' || toolName === 'update_goal' || toolName === 'goal_complete' || toolName === 'goal_blocked'",
    ['goal_update', 'update_goal', 'goal_complete', 'goal_blocked'],
    'goal-control'
  ),
  branch("toolName === 'todo_write'", ['todo_write'], 'goal-control'),
  branch("toolName === 'ask_user_question'", ['ask_user_question'], 'user-question'),
  branch("toolName === 'read_file'", ['read_file'], 'workspace-tools'),
  branch("toolName === 'list_directory'", ['list_directory'], 'workspace-tools'),
  branch("toolName === 'write_file'", ['write_file'], 'workspace-tools'),
  branch("toolName === 'replace'", ['replace'], 'workspace-tools'),
  branch("toolName === 'delegate_to_subthread'", ['delegate_to_subthread'], 'subthread-control')
] as const satisfies readonly DispatcherBranchContract[]

const indexPath = resolve(__dirname, '..', 'index.ts')
const indexSource = readFileSync(indexPath, 'utf8')
const sourceFile = ts.createSourceFile(indexPath, indexSource, ts.ScriptTarget.Latest, true)

function normalizeSource(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function executeDispatcherFunction(): ts.FunctionDeclaration {
  let found: ts.FunctionDeclaration | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'executeGeminiMcpTool') {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!found) throw new Error('executeGeminiMcpTool was not found in src/main/index.ts')
  return found
}

interface MarkedBranch {
  condition: string
  owners: string[]
  firstStatementIsMarker: boolean
}

function markedDispatcherBranches(fn: ts.FunctionDeclaration): MarkedBranch[] {
  const result: MarkedBranch[] = []
  const visit = (node: ts.Node, branchStack: ts.IfStatement[]): void => {
    if (ts.isIfStatement(node)) {
      visit(node.thenStatement, [...branchStack, node])
      if (node.elseStatement) visit(node.elseStatement, branchStack)
      return
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(sourceFile) === 'markDispatchHandled'
    ) {
      const ownerBranch = branchStack.at(-1)
      if (!ownerBranch) throw new Error('markDispatchHandled call has no owning if branch')
      const block = ts.isBlock(ownerBranch.thenStatement) ? ownerBranch.thenStatement : null
      const firstStatement = block?.statements[0]
      result.push({
        condition: normalizeSource(ownerBranch.expression.getText(sourceFile)),
        owners: node.arguments.map((argument) =>
          argument.getText(sourceFile).replace(/^['"]|['"]$/g, '')
        ),
        firstStatementIsMarker:
          Boolean(firstStatement) &&
          firstStatement!.getStart(sourceFile) === node.parent.getStart(sourceFile)
      })
    }
    ts.forEachChild(node, (child) => visit(child, branchStack))
  }
  visit(fn, [])
  return result
}

describe('canonical MCP dispatcher exhaustiveness', () => {
  const dispatcher = executeDispatcherFunction()
  const dispatcherSource = dispatcher.getText(sourceFile)
  const markedBranches = markedDispatcherBranches(dispatcher)

  it('maps every concrete advertised/catalog action to exactly one real marked branch', () => {
    const mapped = new Map<string, DispatcherBranchContract[]>()
    for (const contract of DISPATCHER_BRANCH_CONTRACTS) {
      for (const toolName of contract.toolNames) {
        const matches = mapped.get(toolName) ?? []
        matches.push(contract)
        mapped.set(toolName, matches)
      }
    }

    const concreteOwnedNames = Object.keys(TASKWRAITH_OWNED_MCP_ACTIONS).filter(
      (toolName) => !CAPABILITY_GATEWAY_TOOL_NAMES.includes(toolName as never)
    )
    for (const advertisedName of concreteOwnedNames) {
      const resolution = resolveToolDispatchContractStrict(advertisedName)
      expect(resolution.ok, advertisedName).toBe(true)
      if (!resolution.ok) continue
      expect(
        mapped.get(resolution.toolName)?.map((entry) => entry.condition),
        advertisedName
      ).toHaveLength(1)
    }

    const canonicalConcreteNames = new Set(
      [...TASKWRAITH_MCP_TOOLS, ...AUDIT_MCP_TOOL_NAMES].map((toolName) => {
        const resolution = resolveToolDispatchContractStrict(toolName)
        if (!resolution.ok) throw new Error(resolution.reason)
        return resolution.toolName
      })
    )
    expect([...mapped.keys()].sort()).toEqual([...canonicalConcreteNames].sort())
  })

  it('binds each source branch marker to the taxonomy owner declared for its real tools', () => {
    const actualByCondition = new Map(
      markedBranches.map((entry) => [entry.condition, entry] as const)
    )
    expect(markedBranches).toHaveLength(DISPATCHER_BRANCH_CONTRACTS.length)
    expect(new Set(actualByCondition).size).toBe(markedBranches.length)

    for (const contract of DISPATCHER_BRANCH_CONTRACTS) {
      const condition = normalizeSource(contract.condition)
      const actual = actualByCondition.get(condition)
      expect(actual, condition).toBeDefined()
      expect(actual?.owners, condition).toEqual(contract.owners)
      expect(actual?.firstStatementIsMarker, condition).toBe(true)
      for (const toolName of contract.toolNames) {
        const resolution = resolveToolDispatchContractStrict(toolName)
        expect(resolution.ok, toolName).toBe(true)
        if (resolution.ok) {
          expect(contract.owners, toolName).toContain(resolution.dispatchOwner)
        }
      }
    }
  })

  it('fail-closes every unmarked concrete route and explicitly returns both gateway routes', () => {
    expect(normalizeSource(dispatcherSource)).toContain(
      normalizeSource(
        'if (!handledDispatchOwner) { throw new Error( `Tool ${toolName} reached the end of the canonical dispatcher without an owning branch.` ) }'
      )
    )
    expect(dispatcherSource.indexOf('if (!handledDispatchOwner)')).toBeLessThan(
      dispatcherSource.indexOf('const finalRichResult')
    )
    expect(dispatcherSource).toContain('if (isCapabilityGatewayToolName(toolName))')
    expect(dispatcherSource).toContain("if (toolName === 'capability_search')")
    expect(dispatcherSource).toContain('return dispatchResolvedGatewayTarget({')
    expect(CAPABILITY_GATEWAY_TOOL_NAMES).toEqual(['capability_search', 'capability_invoke'])
  })
})
