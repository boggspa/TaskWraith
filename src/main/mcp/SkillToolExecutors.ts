/**
 * MCP executors for TaskWraith-owned skills (`skill_list`, `skill_read`).
 *
 * Progressive disclosure: seats see a compact discovery block in the prompt,
 * then pull catalog / full bodies through these tools. Factory over injected
 * SkillsStore-shaped deps so unit tests need no Electron.
 *
 * Wired from `executeGeminiMcpTool` via `isSkillMcpToolName` + `executeSkillTool`
 * (same pattern as introspection). Catalog / taxonomy / auto-allow / gateway v12
 * entries live alongside those registration sites.
 */

import type { McpToolExecutionResult } from './McpBridgeRuntime'
import type { EffectiveSkill } from '../../shared/skills/SkillTypes'

export const SKILL_MCP_TOOL_NAMES = ['skill_list', 'skill_read'] as const

export type SkillMcpToolName = (typeof SKILL_MCP_TOOL_NAMES)[number]

const SKILL_TOOL_NAME_SET: ReadonlySet<string> = new Set(SKILL_MCP_TOOL_NAMES)

export function isSkillMcpToolName(name: string): name is SkillMcpToolName {
  return SKILL_TOOL_NAME_SET.has(name)
}

export interface SkillToolContext {
  workspacePath?: string
  workspaceId?: string
}

/** Narrow store surface used by the executors (SkillsStore satisfies this). */
export interface SkillToolStore {
  resolveEffectiveSkills(workspacePath: string, workspaceId?: string): EffectiveSkill[]
}

export interface SkillToolExecutorDeps {
  skillsStore: SkillToolStore
}

export type SkillToolExecutor = (
  rawArgs: unknown,
  context: SkillToolContext
) => Promise<McpToolExecutionResult>

export type SkillToolExecutorMap = Record<SkillMcpToolName, SkillToolExecutor>

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown, max = 240): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function jsonResult(value: Record<string, unknown>, isError = false): McpToolExecutionResult {
  const serialized = JSON.stringify(value)
  return {
    text: serialized,
    isError: isError || undefined,
    structuredContent: value,
    content: [{ type: 'text', text: serialized }]
  }
}

function fail(toolName: string, message: string): McpToolExecutionResult {
  return jsonResult({ ok: false, tool: toolName, error: message }, true)
}

function requireWorkspacePath(context: SkillToolContext): string | null {
  const path = (context.workspacePath || '').trim()
  return path || null
}

function summarizeSkill(skill: EffectiveSkill): Record<string, unknown> {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    scope: skill.scope,
    source: skill.source,
    updatedAt: skill.updatedAt,
    ...(skill.workspaceId ? { workspaceId: skill.workspaceId } : {}),
    ...(skill.relativePath ? { relativePath: skill.relativePath } : {})
  }
}

async function executeSkillList(
  deps: SkillToolExecutorDeps,
  _rawArgs: unknown,
  context: SkillToolContext
): Promise<McpToolExecutionResult> {
  const workspacePath = requireWorkspacePath(context)
  if (!workspacePath) {
    return fail(
      'skill_list',
      'skill_list requires an active workspace path (global chats have no workspace skill overlay).'
    )
  }
  const skills = deps.skillsStore.resolveEffectiveSkills(
    workspacePath,
    context.workspaceId?.trim() || undefined
  )
  return jsonResult({
    ok: true,
    tool: 'skill_list',
    count: skills.length,
    skills: skills.map(summarizeSkill),
    note: 'Call skill_read with a skill id to load the full body.'
  })
}

async function executeSkillRead(
  deps: SkillToolExecutorDeps,
  rawArgs: unknown,
  context: SkillToolContext
): Promise<McpToolExecutionResult> {
  const workspacePath = requireWorkspacePath(context)
  if (!workspacePath) {
    return fail(
      'skill_read',
      'skill_read requires an active workspace path (global chats have no workspace skill overlay).'
    )
  }
  const id = text(asRecord(rawArgs).id, 128)
  if (!id) {
    return fail('skill_read', 'skill_read requires a skill `id` string.')
  }
  const skills = deps.skillsStore.resolveEffectiveSkills(
    workspacePath,
    context.workspaceId?.trim() || undefined
  )
  const skill = skills.find((entry) => entry.id === id)
  if (!skill) {
    return fail('skill_read', `Skill not found or not enabled in the effective catalog: ${id}`)
  }
  return jsonResult({
    ok: true,
    tool: 'skill_read',
    skill: {
      ...summarizeSkill(skill),
      body: skill.body
    }
  })
}

/**
 * Create the skill MCP executor map (`skill_list` / `skill_read`).
 * Ready for one-line registration into the host MCP dispatcher later.
 */
export function createSkillToolExecutors(deps: SkillToolExecutorDeps): SkillToolExecutorMap {
  return {
    skill_list: (rawArgs, context) => executeSkillList(deps, rawArgs, context),
    skill_read: (rawArgs, context) => executeSkillRead(deps, rawArgs, context)
  }
}

/** Alias kept for call-sites that prefer a "register" name. */
export const registerSkillToolExecutors = createSkillToolExecutors

export async function executeSkillTool(
  executors: SkillToolExecutorMap,
  toolName: string,
  rawArgs: unknown,
  context: SkillToolContext
): Promise<McpToolExecutionResult> {
  if (!isSkillMcpToolName(toolName)) {
    return fail(toolName, `Unknown skill tool: ${toolName}`)
  }
  return executors[toolName](rawArgs, context)
}
