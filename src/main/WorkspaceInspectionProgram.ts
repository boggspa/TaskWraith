import * as fs from 'node:fs'
import * as path from 'node:path'

import type { HostCommandResult } from './runStateTypes'
import {
  workspaceInspectionExecutionPlan,
  type WorkspaceInspectionExecutionPlan,
  type WorkspaceInspectionShellContext
} from './WorkspaceInspectionShell'
import { shellCommandFromRawCommand } from './ReadOnlyGitShellCommand'

const MAX_PROGRAM_CHARS = 8 * 1024
const MAX_PROGRAM_STEPS = 16
const MAX_PROGRAM_OUTPUT_CHARS = 500_000
const MAX_MARKER_ENTRIES = 256
const MAX_MARKER_OUTPUT_BYTES = 64 * 1024
const MARKER_PREFIX = '.WORK-IN-PROGRESS'
const issuedProgramPlans = new WeakSet<object>()

export type WorkspaceInspectionStepCondition = 'always' | 'previous_succeeded'

export interface WorkspaceInspectionCommandStep {
  kind: 'command'
  condition: WorkspaceInspectionStepCondition
  discardStderr: boolean
  source: string
  plan: WorkspaceInspectionExecutionPlan
}

export interface WorkspaceInspectionMarkerListStep {
  kind: 'marker_list'
  condition: WorkspaceInspectionStepCondition
  discardStderr: boolean
  cwd: string
  prefix: typeof MARKER_PREFIX
}

export interface WorkspaceInspectionLiteralStep {
  kind: 'literal'
  condition: WorkspaceInspectionStepCondition
  discardStderr: false
  stdout: string
}

export type WorkspaceInspectionProgramStep =
  | WorkspaceInspectionCommandStep
  | WorkspaceInspectionMarkerListStep
  | WorkspaceInspectionLiteralStep

export interface WorkspaceInspectionProgramPlan {
  reason: 'inspection_shell'
  recipe: 'workspace_git_snapshot_v1'
  workspaceLexicalPath: string
  workspaceRealPath: string
  steps: WorkspaceInspectionProgramStep[]
}

export interface WorkspaceInspectionProgramCommandInvocation {
  executableRealPath: string
  argv: string[]
  cwd: string
  environment?: Readonly<Record<string, string>>
  unsetEnvironment?: readonly string[]
}

export type WorkspaceInspectionProgramCommandRunner = (
  invocation: WorkspaceInspectionProgramCommandInvocation
) => Promise<HostCommandResult>

export type WorkspaceInspectionProgramAuthorityCheck = () => void | Promise<void>

interface ParsedSequenceSegment {
  source: string
  condition: WorkspaceInspectionStepCondition
  discardStderr: boolean
}

interface StaticWord {
  value: string
  unquotedGlob: boolean
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function stripDiscardStderrRedirect(source: string): {
  source: string
  discardStderr: boolean
} | null {
  let quote: 'single' | 'double' | null = null
  let escaped = false
  const redirects: number[] = []
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      continue
    }
    if (character === '"') {
      quote = 'double'
      continue
    }
    if (character === '<' || character === '>') redirects.push(index)
  }
  if (quote || escaped) return null
  if (redirects.length === 0) return { source: source.trim(), discardStderr: false }
  if (redirects.length !== 1 || source[redirects[0]] !== '>') return null
  const redirectIndex = redirects[0]
  if (redirectIndex < 1 || source[redirectIndex - 1] !== '2') return null
  const prefix = source.slice(0, redirectIndex - 1)
  if (prefix && !/\s$/.test(prefix)) return null
  if (!/^>\s*\/dev\/null\s*$/.test(source.slice(redirectIndex))) return null
  const commandSource = prefix.trim()
  return commandSource ? { source: commandSource, discardStderr: true } : null
}

function parseSequence(command: string): ParsedSequenceSegment[] | null {
  if (!command.trim() || command.length > MAX_PROGRAM_CHARS) return null
  const rawSegments: Array<{
    source: string
    condition: WorkspaceInspectionStepCondition
  }> = []
  let segment = ''
  let condition: WorkspaceInspectionStepCondition = 'always'
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = (): boolean => {
    const source = segment.trim()
    segment = ''
    if (!source) return false
    rawSegments.push({ source, condition })
    return rawSegments.length <= MAX_PROGRAM_STEPS
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (escaped) {
      if (character === '\n' || character === '\r') return null
      segment += character
      escaped = false
      continue
    }
    if (quote === 'single') {
      segment += character
      if (character === "'") quote = null
      continue
    }
    if (character === '\\') {
      segment += character
      escaped = true
      continue
    }
    if (quote === 'double') {
      segment += character
      if (character === '"') quote = null
      continue
    }
    if (character === "'") {
      quote = 'single'
      segment += character
      continue
    }
    if (character === '"') {
      quote = 'double'
      segment += character
      continue
    }
    if (character === '\n' || character === '\r' || character === '|') return null
    if (character === '&') {
      if (command[index + 1] !== '&' || !push()) return null
      condition = 'previous_succeeded'
      index += 1
      continue
    }
    if (character === ';') {
      if (!push()) return null
      condition = 'always'
      continue
    }
    segment += character
  }
  if (quote || escaped || !push() || rawSegments.length < 2) return null
  const parsed: ParsedSequenceSegment[] = []
  for (const raw of rawSegments) {
    const redirect = stripDiscardStderrRedirect(raw.source)
    if (!redirect) return null
    parsed.push({
      source: redirect.source,
      condition: raw.condition,
      discardStderr: redirect.discardStderr
    })
  }
  return parsed
}

function staticWords(source: string): StaticWord[] | null {
  const words: StaticWord[] = []
  let word = ''
  let started = false
  let unquotedGlob = false
  let quote: 'single' | 'double' | null = null
  let escaped = false

  const push = (): void => {
    if (started) words.push({ value: word, unquotedGlob })
    word = ''
    started = false
    unquotedGlob = false
  }

  for (const character of source) {
    const characterCode = character.charCodeAt(0)
    if (characterCode <= 0x1f || characterCode === 0x7f) return null
    if (escaped) {
      word += character
      started = true
      escaped = false
      continue
    }
    if (quote === 'single') {
      if (character === "'") quote = null
      else word += character
      started = true
      continue
    }
    if (character === '\\') {
      escaped = true
      started = true
      continue
    }
    if (quote === 'double') {
      if (character === '"') quote = null
      else if (character === '$' || character === '`') return null
      else word += character
      started = true
      continue
    }
    if (character === "'") {
      quote = 'single'
      started = true
      continue
    }
    if (character === '"') {
      quote = 'double'
      started = true
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    if (character === '$' || character === '`' || character === '{' || character === '}') {
      return null
    }
    if (character === '*' || character === '?' || character === '[') unquotedGlob = true
    word += character
    started = true
  }
  if (quote || escaped) return null
  push()
  return words.length > 0 ? words : null
}

function literalEchoStep(segment: ParsedSequenceSegment): WorkspaceInspectionLiteralStep | null {
  if (segment.discardStderr) return null
  const words = staticWords(segment.source)
  if (!words || words[0].value !== 'echo' || words.length < 2) return null
  // This is rendered directly rather than passed to `/bin/echo`, so a leading
  // dash is literal output rather than an option surface.
  if (words.slice(1).some((word) => word.unquotedGlob)) return null
  return {
    kind: 'literal',
    condition: segment.condition,
    discardStderr: false,
    stdout: `${words
      .slice(1)
      .map((word) => word.value)
      .join(' ')}\n`
  }
}

function markerListStep(
  segment: ParsedSequenceSegment,
  workspaceRealPath: string,
  context: WorkspaceInspectionShellContext
): WorkspaceInspectionMarkerListStep | null {
  const words = staticWords(segment.source)
  if (!words || (words[0].value !== 'ls' && words[0].value !== '/bin/ls')) return null
  if (words.length !== 3 || !['-la', '-al'].includes(words[1].value)) return null
  if (words[1].unquotedGlob) return null
  const pattern = words[2]
  if (!pattern.unquotedGlob || pattern.value !== `${MARKER_PREFIX}*`) return null
  let cwd: string
  try {
    cwd = fs.realpathSync(path.resolve(context.cwd || context.workspacePath || ''))
  } catch {
    return null
  }
  if (cwd !== workspaceRealPath) return null
  return {
    kind: 'marker_list',
    condition: segment.condition,
    discardStderr: segment.discardStderr,
    cwd,
    prefix: MARKER_PREFIX
  }
}

function isWorkspaceGitSnapshotRecipe(steps: readonly WorkspaceInspectionProgramStep[]): boolean {
  if (steps.length !== 5) return false
  const [branch, revision, status, markers, terminator] = steps
  const isGitStep = (
    step: WorkspaceInspectionProgramStep,
    condition: WorkspaceInspectionStepCondition,
    argv: readonly string[]
  ): boolean =>
    step.kind === 'command' &&
    step.condition === condition &&
    !step.discardStderr &&
    path.basename(step.plan.executableRealPath) === 'git' &&
    sameStringArray(step.plan.argv, argv)
  return (
    isGitStep(branch, 'always', ['branch', '--show-current']) &&
    isGitStep(revision, 'previous_succeeded', ['rev-parse', 'HEAD']) &&
    isGitStep(status, 'previous_succeeded', ['status', '--porcelain']) &&
    markers.kind === 'marker_list' &&
    markers.condition === 'previous_succeeded' &&
    markers.discardStderr &&
    markers.prefix === MARKER_PREFIX &&
    terminator.kind === 'literal' &&
    terminator.condition === 'always' &&
    terminator.stdout === '---markers-end---\n'
  )
}

/**
 * Recognize the repository doctrine's exact workspace Git snapshot recipe and
 * compile it into direct, individually proven stages. It is intentionally not a
 * general compound-shell tier: the marker glob is enumerated by TaskWraith and
 * every other command shape remains on the ordinary approval path.
 */
export function workspaceInspectionProgramPlan(
  rawCommand: unknown,
  context: WorkspaceInspectionShellContext
): WorkspaceInspectionProgramPlan | null {
  const command = shellCommandFromRawCommand(rawCommand)
  if (command === null || !context.workspacePath) return null
  const segments = parseSequence(command)
  if (!segments) return null
  let workspaceLexicalPath: string
  let workspaceRealPath: string
  let cwd: string
  try {
    workspaceLexicalPath = path.resolve(context.workspacePath)
    workspaceRealPath = fs.realpathSync(workspaceLexicalPath)
    cwd = fs.realpathSync(path.resolve(context.cwd || context.workspacePath))
  } catch {
    return null
  }
  if (!isInside(workspaceRealPath, cwd)) return null

  const steps: WorkspaceInspectionProgramStep[] = []
  for (const [index, segment] of segments.entries()) {
    const commandPlan = workspaceInspectionExecutionPlan(segment.source, context)
    if (commandPlan) {
      if (commandPlan.workspaceRealPath !== workspaceRealPath) return null
      steps.push({
        kind: 'command',
        condition: segment.condition,
        discardStderr: segment.discardStderr,
        source: segment.source,
        plan: commandPlan
      })
      continue
    }
    const markerStep = markerListStep(segment, workspaceRealPath, context)
    if (markerStep) {
      steps.push(markerStep)
      continue
    }
    const literalStep = literalEchoStep(segment)
    if (
      literalStep?.condition === 'always' &&
      literalStep.stdout === '---markers-end---\n' &&
      index === segments.length - 1
    ) {
      steps.push(literalStep)
      continue
    }
    return null
  }
  if (!isWorkspaceGitSnapshotRecipe(steps)) return null
  const frozenSteps = steps.map((step): WorkspaceInspectionProgramStep => {
    if (step.kind !== 'command') return Object.freeze({ ...step })
    const frozenPlan = Object.freeze({
      ...step.plan,
      argv: Object.freeze([...step.plan.argv]) as unknown as string[],
      ...(step.plan.environment
        ? { environment: Object.freeze({ ...step.plan.environment }) }
        : {}),
      ...(step.plan.unsetEnvironment
        ? {
            unsetEnvironment: Object.freeze([
              ...step.plan.unsetEnvironment
            ]) as unknown as readonly string[]
          }
        : {})
    })
    return Object.freeze({ ...step, plan: frozenPlan })
  })
  const plan = Object.freeze({
    reason: 'inspection_shell' as const,
    recipe: 'workspace_git_snapshot_v1' as const,
    workspaceLexicalPath,
    workspaceRealPath,
    steps: Object.freeze(frozenSteps) as unknown as WorkspaceInspectionProgramStep[]
  })
  issuedProgramPlans.add(plan)
  return plan
}

function resultFailed(result: HostCommandResult): boolean {
  return Boolean(
    result.error || result.timedOut || (result.exitCode !== null && result.exitCode !== 0)
  )
}

function sameStringArray(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (!left || !right) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameEnvironment(
  left: Readonly<Record<string, string>> | undefined,
  right: Readonly<Record<string, string>> | undefined
): boolean {
  if (!left || !right) return left === right
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return sameStringArray(leftKeys, rightKeys) && leftKeys.every((key) => left[key] === right[key])
}

function sameExecutionPlan(
  left: WorkspaceInspectionExecutionPlan,
  right: WorkspaceInspectionExecutionPlan
): boolean {
  return (
    left.reason === right.reason &&
    left.workspaceRealPath === right.workspaceRealPath &&
    left.executableRealPath === right.executableRealPath &&
    left.cwd === right.cwd &&
    sameStringArray(left.argv, right.argv) &&
    sameEnvironment(left.environment, right.environment) &&
    sameStringArray(left.unsetEnvironment, right.unsetEnvironment)
  )
}

function boundedAppend(current: string, addition: string): string {
  const combined = current + addition
  return combined.length > MAX_PROGRAM_OUTPUT_CHARS
    ? combined.slice(-MAX_PROGRAM_OUTPUT_CHARS)
    : combined
}

function syntheticResult(stdout: string, startedAt: number, error?: string): HostCommandResult {
  return {
    stdout,
    stderr: '',
    exitCode: error ? 1 : 0,
    ...(error ? { error } : {}),
    timedOut: false,
    durationMs: Date.now() - startedAt
  }
}

function executeMarkerListStep(
  step: WorkspaceInspectionMarkerListStep,
  workspaceRealPath: string
): HostCommandResult {
  const startedAt = Date.now()
  try {
    const liveCwd = fs.realpathSync(step.cwd)
    if (liveCwd !== workspaceRealPath) {
      return syntheticResult('', startedAt, 'Workspace marker scope changed before inspection.')
    }
    const names = fs
      .readdirSync(liveCwd)
      .filter((name) => name.startsWith(step.prefix))
      .sort((left, right) => left.localeCompare(right))
    if (names.length > MAX_MARKER_ENTRIES) {
      return syntheticResult('', startedAt, 'Workspace marker listing exceeded the entry limit.')
    }
    const output =
      names.length > 0 ? `${names.map((name) => JSON.stringify(name)).join('\n')}\n` : ''
    if (Buffer.byteLength(output, 'utf8') > MAX_MARKER_OUTPUT_BYTES) {
      return syntheticResult('', startedAt, 'Workspace marker listing exceeded the output limit.')
    }
    return syntheticResult(output, startedAt)
  } catch (error) {
    return syntheticResult('', startedAt, error instanceof Error ? error.message : String(error))
  }
}

/** Execute an already-compiled program without reconstructing shell source. */
export async function executeWorkspaceInspectionProgram(
  plan: WorkspaceInspectionProgramPlan,
  runCommand: WorkspaceInspectionProgramCommandRunner,
  assertAuthorityStillLive: WorkspaceInspectionProgramAuthorityCheck
): Promise<HostCommandResult> {
  const startedAt = Date.now()
  if (!issuedProgramPlans.has(plan)) {
    return syntheticResult('', startedAt, 'Workspace inspection plan was not issued by TaskWraith.')
  }
  issuedProgramPlans.delete(plan)
  let stdout = ''
  let stderr = ''
  let previous: HostCommandResult | null = null
  let firstFailure: HostCommandResult | null = null

  for (const step of plan.steps) {
    if (step.condition === 'previous_succeeded' && previous && resultFailed(previous)) continue
    await assertAuthorityStillLive()
    let result: HostCommandResult
    if (step.kind === 'command') {
      let liveWorkspaceRealPath: string
      let liveCwd: string
      let liveExecutableRealPath: string
      try {
        liveWorkspaceRealPath = fs.realpathSync(step.plan.workspaceRealPath)
        liveCwd = fs.realpathSync(step.plan.cwd)
        liveExecutableRealPath = fs.realpathSync(step.plan.executableRealPath)
      } catch {
        liveWorkspaceRealPath = ''
        liveCwd = ''
        liveExecutableRealPath = ''
      }
      const livePlan = workspaceInspectionExecutionPlan(step.source, {
        workspacePath: plan.workspaceLexicalPath,
        cwd: step.plan.cwd
      })
      if (
        liveWorkspaceRealPath !== plan.workspaceRealPath ||
        liveCwd !== step.plan.cwd ||
        !isInside(plan.workspaceRealPath, liveCwd) ||
        liveExecutableRealPath !== step.plan.executableRealPath ||
        !livePlan ||
        !sameExecutionPlan(step.plan, livePlan)
      ) {
        result = syntheticResult(
          '',
          Date.now(),
          'Workspace inspection scope changed before a command stage.'
        )
      } else {
        result = await runCommand({
          executableRealPath: livePlan.executableRealPath,
          argv: [...livePlan.argv],
          cwd: livePlan.cwd,
          ...(livePlan.environment ? { environment: livePlan.environment } : {}),
          ...(livePlan.unsetEnvironment ? { unsetEnvironment: livePlan.unsetEnvironment } : {})
        })
      }
    } else if (step.kind === 'marker_list') {
      result = executeMarkerListStep(step, plan.workspaceRealPath)
    } else {
      result = syntheticResult(step.stdout, Date.now())
    }
    previous = result
    if (!firstFailure && resultFailed(result)) firstFailure = result
    stdout = boundedAppend(stdout, result.stdout)
    if (!step.discardStderr) stderr = boundedAppend(stderr, result.stderr)
  }

  // Preserve the first failed inspection stage even though the legacy recipe's
  // final `; echo` would make a shell report success. The sentinel is framing,
  // not authority to hide an incomplete repository snapshot.
  const terminal = firstFailure || previous
  return {
    stdout,
    stderr,
    exitCode: terminal?.exitCode ?? 0,
    ...(terminal?.error ? { error: terminal.error } : {}),
    timedOut: terminal?.timedOut ?? false,
    durationMs: Date.now() - startedAt
  }
}
