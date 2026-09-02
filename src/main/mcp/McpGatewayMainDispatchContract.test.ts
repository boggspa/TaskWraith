import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
const executorStart = indexSource.indexOf('async function executeGeminiMcpTool(')
const executorEnd = indexSource.indexOf('\nasync function startGeminiMcpBroker()', executorStart)
const executorSource = indexSource.slice(executorStart, executorEnd)
const canonicalDispatchStart = executorSource.indexOf(
  'const argumentCoalesce = coalesceToolArguments('
)
const gatewayDispatchSource = executorSource.slice(0, canonicalDispatchStart)
const canonicalDispatchSource = executorSource.slice(canonicalDispatchStart)

describe('main capability gateway dispatch contract', () => {
  it('unwraps the gateway before wrapper-level route, approval, or lock decisions', () => {
    expect(executorStart).toBeGreaterThan(-1)
    expect(executorEnd).toBeGreaterThan(executorStart)
    expect(canonicalDispatchStart).toBeGreaterThan(-1)
    expect(gatewayDispatchSource).toContain('if (isCapabilityGatewayToolName(toolName))')
    expect(gatewayDispatchSource).toContain('resolveGatewayInvocation({')
    expect(gatewayDispatchSource).not.toContain('previewForGeminiMcpTool(')
    expect(gatewayDispatchSource).not.toContain('requestAgenticServiceApproval(')
    expect(gatewayDispatchSource).not.toContain('workspaceLockMcpAdmissionCoordinator.admit({')
    // Guards the assertion above against going vacuous: the workspace-lock
    // admission seam must exist somewhere in the executor, just never ahead of
    // the gateway unwrap.
    expect(executorSource).toContain('workspaceLockMcpAdmissionCoordinator.admit({')
    expect(gatewayDispatchSource).not.toContain('coalesceToolArguments(')
    expect((executorSource.match(/coalesceToolArguments\(/g) || []).length).toBe(1)
  })

  it('hands the exact target route and caller context to the executable dispatch seam', () => {
    expect(gatewayDispatchSource).toMatch(
      /return dispatchResolvedGatewayTarget\(\{\s*targetName: resolution\.name,\s*targetArguments: resolution\.arguments,\s*route: effectiveRoute,\s*parentProvider,\s*callerContext,\s*executeCanonical: executeGeminiMcpTool\s*\}\)/s
    )
  })

  it('keeps the canonical target safeguards and rich-result path downstream', () => {
    for (const seam of [
      'validateMcpToolArgumentsBeforeApproval(',
      'validateMutatingMcpRoute(toolName, effectiveRoute)',
      'validateMcpCallerWorkspace({',
      'previewForGeminiMcpTool(toolName, args, cwd, context, parentProvider)',
      'applyMcpWriteLockApprovalContext(approvalPreview, context, toolName, args, cwd)',
      'requestAgenticServiceApproval(',
      'networkAccessBlockedToolName(',
      'workspaceLockMcpAdmissionCoordinator.admit({',
      'imageToolCallBudget.tryConsume(',
      'finalRichResult?.trustedMediaRefs'
    ]) {
      expect(canonicalDispatchSource, seam).toContain(seam)
    }
    // The pinned literal used to carry the argument ordering too. The call now
    // takes a third argument across several lines, so the ordering is asserted
    // on its own: the tool name first, the caller's effective permissions
    // second — never the reverse, which would silently evaluate the block
    // against the wrong posture.
    const networkBlockCalls =
      canonicalDispatchSource.match(/networkAccessBlockedToolName\([^)]*\)/gs) ?? []
    expect(networkBlockCalls.length).toBeGreaterThan(0)
    for (const call of networkBlockCalls) {
      expect(call, 'networkAccessBlockedToolName argument ordering').toMatch(
        /^networkAccessBlockedToolName\(\s*[A-Za-z_$][\w.$]*,\s*context\.effectivePermissions\b/s
      )
    }
    expect(canonicalDispatchSource.indexOf('validateMcpToolArgumentsBeforeApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')
    )
    expect(canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')).toBeLessThan(
      canonicalDispatchSource.indexOf('workspaceLockMcpAdmissionCoordinator.admit({')
    )
    expect(canonicalDispatchSource.indexOf('coalesceToolArguments(')).toBeLessThan(
      canonicalDispatchSource.indexOf('validateMcpToolArgumentsBeforeApproval(')
    )
    expect(canonicalDispatchSource.indexOf('coalesceToolArguments(')).toBeLessThan(
      canonicalDispatchSource.indexOf('validateMutatingMcpRoute(')
    )
    expect(canonicalDispatchSource.indexOf('coalesceToolArguments(')).toBeLessThan(
      canonicalDispatchSource.indexOf('previewForGeminiMcpTool(')
    )
    expect(canonicalDispatchSource.indexOf('coalesceToolArguments(')).toBeLessThan(
      canonicalDispatchSource.indexOf('workspaceLockMcpAdmissionCoordinator.admit({')
    )
  })

  it('returns an ambiguous alias conflict before route, policy, approval, or lock', () => {
    const rejectStart = canonicalDispatchSource.indexOf('if (!argumentCoalesce.ok)')
    const argumentPreflight = canonicalDispatchSource.indexOf(
      'validateMcpToolArgumentsBeforeApproval('
    )
    const routeGuard = canonicalDispatchSource.indexOf('validateMutatingMcpRoute(')
    const approval = canonicalDispatchSource.indexOf('requestAgenticServiceApproval(')
    const lockAdmit = canonicalDispatchSource.indexOf(
      'workspaceLockMcpAdmissionCoordinator.admit({'
    )
    expect(rejectStart).toBeGreaterThan(-1)
    expect(argumentPreflight).toBeGreaterThan(rejectStart)
    expect(routeGuard).toBeGreaterThan(rejectStart)
    expect(approval).toBeGreaterThan(rejectStart)
    expect(lockAdmit).toBeGreaterThan(rejectStart)
    const rejectBlock = canonicalDispatchSource.slice(rejectStart, argumentPreflight)
    expect(rejectBlock).toContain('argumentCoalesce.code')
    expect(rejectBlock).toContain('argumentCoalesce.conflicts')
    expect(rejectBlock).toContain('argumentCoalesce.message')
    expect(rejectBlock).toContain('mcpStructuredJsonResult({')
    expect(rejectBlock).not.toMatch(/\barguments\s*:/)
    expect(executorSource).toContain('normalizeMcpToolArguments(rawArgs)')
    expect(executorSource).not.toMatch(/\brawArgs\s*=/)
  })

  it('resolves every brokered shell cwd through the workspace scope before execution', () => {
    const scopeResolution = canonicalDispatchSource.indexOf('cwd = resolveScopedDirectory(')
    const shellExecution = canonicalDispatchSource.indexOf("if (toolName === 'run_shell_command')")
    // Anchored on the call head, not the full argument list: the brokered shell
    // also forwards a session release-lease approval, so the call is no longer
    // two-arity. The contract being guarded is the ordering, not the arity.
    const hostCommand = canonicalDispatchSource.indexOf(
      'runHostCommand(executionCommand, executionCwd'
    )

    expect(scopeResolution).toBeGreaterThan(-1)
    expect(hostCommand).toBeGreaterThan(-1)
    expect(canonicalDispatchSource.slice(scopeResolution, shellExecution)).toContain(
      "String(args.cwd || args.working_directory || args.workdir || '')"
    )
    expect(scopeResolution).toBeLessThan(shellExecution)
    expect(shellExecution).toBeLessThan(hostCommand)
  })

  it('revalidates an exact command rule after lock admission and executes direct argv', () => {
    const lockAdmission = canonicalDispatchSource.indexOf(
      'workspaceLockMcpAdmissionCoordinator.admit({'
    )
    const liveRematch = canonicalDispatchSource.indexOf(
      'commandRuleApprovalFlowRef?.matchLive(commandRuleInput)',
      lockAdmission
    )
    const directArgv = canonicalDispatchSource.indexOf(
      'executionCommand = [liveMatch.executableRealPath, ...liveMatch.argv]'
    )
    const spawn = canonicalDispatchSource.indexOf('runHostCommand(executionCommand, executionCwd')
    expect(lockAdmission).toBeGreaterThan(-1)
    expect(liveRematch).toBeGreaterThan(lockAdmission)
    expect(directArgv).toBeGreaterThan(liveRematch)
    expect(spawn).toBeGreaterThan(directArgv)
  })

  it('wires fresh opaque opportunity issuance and redemption through main-owned authority', () => {
    expect(indexSource).toContain(
      'const permissionOpportunityRegistry = new PermissionOpportunityRegistry()'
    )
    expect(indexSource).toContain('permissionOpportunityRegistry.clearForRun(event.session.runId)')
    expect(indexSource).toContain('issueHostPermissionOpportunity({')
    expect(canonicalDispatchSource).toContain(
      'toolName === PERMISSION_OPPORTUNITY_REDEMPTION_TOOL_NAME'
    )
    expect(canonicalDispatchSource).toContain('createPermissionOpportunityResolver({')
    expect(canonicalDispatchSource).toContain(
      'const liveContext = getAgentToolContext(parentProvider, effectiveRoute)'
    )
    expect(canonicalDispatchSource).toContain('surfaceToolName: toolName')
  })

  it('never writes an opaque opportunity id into durable tool transcripts', () => {
    const genericDeniedStart = canonicalDispatchSource.indexOf('if (!allowed)')
    const genericDeniedEnd = canonicalDispatchSource.indexOf(
      'if (appDriveSurfaceDescriptor)',
      genericDeniedStart
    )
    const genericDenied = canonicalDispatchSource.slice(genericDeniedStart, genericDeniedEnd)
    expect(genericDenied).toContain('permissionRepairForDeniedInvocation({')
    expect(genericDenied).toContain('redactPermissionOpportunityIdsForDurableStorage(')

    const lockDeniedStart = canonicalDispatchSource.indexOf('if (!workspaceMutationAdmission.ok)')
    const lockDeniedEnd = canonicalDispatchSource.indexOf(
      'if (!canvasMcpExecutionAuthorityStillLive(',
      lockDeniedStart
    )
    const lockDenied = canonicalDispatchSource.slice(lockDeniedStart, lockDeniedEnd)
    expect(lockDenied).toContain('permissionRepairForDeniedInvocation({')
    expect(lockDenied).toContain('durableAdmissionDeniedText')
    expect(lockDenied).toContain('redactPermissionOpportunityIdsForDurableStorage(')

    const transcriptUseStart = canonicalDispatchSource.indexOf(
      "emitMcpToolTranscriptEvent({\n    type: 'tool_use'"
    )
    expect(transcriptUseStart).toBeGreaterThan(-1)
    const transcriptUse = canonicalDispatchSource.slice(transcriptUseStart)
    expect(transcriptUse).toContain('redactPermissionOpportunityIdsForDurableStorage(')
  })

  it('keeps emulator images out of raw transcript content while preserving the trusted media spine', () => {
    const canvasLikeStart = indexSource.indexOf('function isCanvasLikeMcpToolName(')
    const canvasLike = indexSource.slice(canvasLikeStart, canvasLikeStart + 220)
    expect(canvasLikeStart).toBeGreaterThan(-1)
    expect(canvasLike).toContain('isCanvasMcpToolName(toolName)')
    expect(canvasLike).toContain('isEmulatorMcpToolName(toolName)')
    expect(canonicalDispatchSource).toContain('} else if (isEmulatorMcpToolName(toolName)) {')
    expect(canonicalDispatchSource).toContain("markDispatchHandled('emulator')")
    expect(canonicalDispatchSource).toContain(
      'await emulatorToolExecutors.executeEmulatorTool(\n        toolName,\n        args,\n        context,\n        parentProvider'
    )
    expect(canonicalDispatchSource).toContain(
      'if (!canvasMcpExecutionAuthorityStillLive(providerMcpExecutionAuthority))'
    )
    expect(canonicalDispatchSource).toContain('return staleCanvasMcpResult(toolName)')
    expect(canonicalDispatchSource).toContain(
      'isCanvasLikeMcpToolName(toolName) || isMeshMcpToolName(toolName)'
    )
    expect(canonicalDispatchSource).toContain(
      'publicFinalRichResult?.content && !isCanvasLikeMcpToolName(toolName)'
    )
    expect(canonicalDispatchSource).toContain(
      'const resultImageBlocks = (publicFinalRichResult?.content ?? []).filter('
    )
    expect(canonicalDispatchSource).toContain('createOwnedToolResultMediaRefs({')
    expect(canonicalDispatchSource).toContain('...publicFinalRichResult')
  })
})

// The suites below resolve their own copy of the dispatch source so they can be
// replayed against a HISTORICAL index.ts for a red proof without touching the
// working tree (a shared checkout with concurrent writers must never be
// checked out from under a peer). Point MCP_DISPATCH_CONTRACT_INDEX_SOURCE at a
// `git show <ref>:src/main/index.ts` dump to see these go red at the commit
// that preceded each fix. Unset, they read the live file exactly as above.
function loadDispatchSource(): { indexSource: string; canonicalDispatchSource: string } {
  const override = process.env.MCP_DISPATCH_CONTRACT_INDEX_SOURCE
  const source = override
    ? readFileSync(override, 'utf8')
    : readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function executeGeminiMcpTool(')
  const end = source.indexOf('\nasync function startGeminiMcpBroker()', start)
  const executor = source.slice(start, end)
  const coalesce = executor.indexOf('const argumentCoalesce = coalesceToolArguments(')
  return { indexSource: source, canonicalDispatchSource: executor.slice(coalesce) }
}

describe('ensemble repair-hint wrapper coverage', () => {
  const { indexSource: source, canonicalDispatchSource: dispatch } = loadDispatchSource()
  // Dispatch branches are discovered generically, so a tool added LATER is
  // covered by this guard automatically rather than needing a list update.
  const branchNames = [...dispatch.matchAll(/else if \(toolName === '([a-z_]+)'\)/g)].map(
    (match) => match[1]
  )
  const repairWrappedTools = branchNames.filter(
    (name) => name.startsWith('ensemble_') || name === 'scout_brief'
  )

  it('discovers the dispatch branches it claims to guard', () => {
    // Vacuity guard: every assertion below is meaningless if this is empty.
    expect(branchNames.length).toBeGreaterThan(10)
    expect(repairWrappedTools).toContain('ensemble_bossman_control')
    expect(repairWrappedTools).toContain('ensemble_fanout')
    expect(repairWrappedTools).toContain('scout_brief')
  })

  it('routes every ensemble and scout_brief result through the repair wrapper', () => {
    for (const toolName of repairWrappedTools) {
      const branchStart = dispatch.indexOf(`else if (toolName === '${toolName}')`)
      const nextBranch = dispatch.indexOf('else if (toolName === ', branchStart + 1)
      const branch = dispatch.slice(branchStart, nextBranch === -1 ? undefined : nextBranch)
      // The wrapper is applied BY HAND per handler, so a 13th ensemble tool
      // added later would silently lose its repair hints. That is the whole
      // reason this guard exists.
      expect(branch, `${toolName} must serialize through mcpEnsembleJson`).toContain(
        'mcpEnsembleJson('
      )
      expect(branch, `${toolName} must not bypass the wrapper with bare mcpJson`).not.toMatch(
        /[^e]\bmcpJson\(/
      )
    }
  })

  it('keeps every repair-map entry backed by a wrapped dispatch branch', () => {
    const repairSource = readFileSync(new URL('./McpResultRepairHints.ts', import.meta.url), 'utf8')
    const repairTools = [...repairSource.matchAll(/input\.toolName === '([a-z_]+)'/g)].map(
      (match) => match[1]
    )
    expect(repairTools.length).toBeGreaterThan(0)
    for (const repairTool of repairTools) {
      // ensemble_control is the portable spelling; dispatch only ever sees the
      // canonical name, so fold it before demanding a branch.
      const canonical = repairTool === 'ensemble_control' ? 'ensemble_bossman_control' : repairTool
      expect(
        repairWrappedTools,
        `${repairTool} has a repair entry but no wrapped branch`
      ).toContain(canonical)
    }
  })

  it('feeds the wrapper BOTH the received and the normalized arguments', () => {
    const wrapperStart = source.indexOf('const mcpEnsembleJson = (result: unknown): string =>')
    expect(wrapperStart).toBeGreaterThan(-1)
    const wrapper = source.slice(wrapperStart, wrapperStart + 400)
    // receivedArguments is the echo half of the fix: a repair template that
    // echoed the NORMALIZED args would hide what the caller actually sent.
    expect(wrapper).toContain('receivedArguments: receivedArgs')
    expect(wrapper).toContain('normalizedArguments: args')
  })
})

describe('provider-native argument adaptation contract', () => {
  const { indexSource: source, canonicalDispatchSource: dispatch } = loadDispatchSource()
  const listDirectoryHandler = dispatch.slice(
    dispatch.indexOf("if (toolName === 'list_directory')"),
    dispatch.indexOf("if (toolName === 'write_file')")
  )
  const shellHandler = dispatch.slice(dispatch.indexOf("if (toolName === 'run_shell_command')"))

  it('never lets an unaccepted list_directory path spelling default to the workspace root', () => {
    expect(listDirectoryHandler).toContain('list_directory')
    expect(listDirectoryHandler).toContain('resolveListDirectoryPathArgument(args)')
    // The silent default IS the bug: a Grok/Cursor-native `target_directory`
    // fell through the `||` chain and listed the REPO ROOT as a success, which
    // the caller has no way to detect.
    expect(listDirectoryHandler).not.toContain("args.path || args.directory || '.'")

    const resolverStart = source.indexOf('function resolveListDirectoryPathArgument(')
    expect(resolverStart).toBeGreaterThan(-1)
    const resolver = source.slice(
      resolverStart,
      source.indexOf('const SEMANTIC_UNSUPPORTED_SHELL_ARGUMENT_KEYS')
    )
    // Fails closed on an unaccepted path-ish key rather than guessing...
    expect(resolver).toContain('unacceptedPathKeys')
    expect(resolver).toContain('throw new Error(')
    // ...while the deliberate no-arg workspace-root listing still survives.
    expect(resolver).toContain("return '.'")
  })

  it('discloses ignored native shell fields on the run_shell_command receipt', () => {
    expect(shellHandler).toContain('collectIgnoredShellArgumentKeys(args)')
    expect(shellHandler).toContain('formatIgnoredShellArgumentNotice(')

    // Disclosure must land on the text the caller actually receives: after the
    // result is formatted and before it is emitted and returned.
    const formatted = shellHandler.indexOf('formatHostCommandResult(result)')
    const disclosed = shellHandler.indexOf('collectIgnoredShellArgumentKeys(args)')
    const emitted = shellHandler.indexOf('emitMcpToolTranscriptEvent({')
    expect(formatted).toBeGreaterThan(-1)
    expect(emitted).toBeGreaterThan(-1)
    expect(disclosed).toBeGreaterThan(formatted)
    expect(disclosed).toBeLessThan(emitted)
  })

  it('discloses ignored shell fields without implementing or widening them', () => {
    const execution = shellHandler.slice(0, shellHandler.indexOf('formatHostCommandResult(result)'))
    // Vacuity guard: the execution seam really is inside this slice.
    expect(execution).toContain('runHostCommand(executionCommand, executionCwd')
    // Disclosure is DISCLOSURE. None of these native fields may ever be wired
    // into execution, which would silently widen a grant or change semantics.
    for (const semanticKey of [
      'timeout',
      'run_in_background',
      'background',
      'tty',
      'sandbox_permissions',
      'bypass_sandbox'
    ]) {
      expect(execution, semanticKey).not.toContain(`args.${semanticKey}`)
    }
  })
})

describe('read_file line-window truncation contract', () => {
  const { canonicalDispatchSource: dispatch } = loadDispatchSource()
  const readFileHandler = dispatch.slice(
    dispatch.indexOf("if (toolName === 'read_file')"),
    dispatch.indexOf("if (toolName === 'list_directory')")
  )

  it('discovers the windowed read branch it guards', () => {
    // Vacuity guard: the assertions below mean nothing against an empty slice.
    expect(readFileHandler).toContain('readScopedRegularFileLineWindow(')
    expect(readFileHandler).toContain('formatReadFileLineWindow(')
  })

  it('never lets a truncated window reach the success formatter', () => {
    // The streaming reader raises `truncated` when maxWindowBytes cuts a
    // requested window short. Dropping that flag hands back incomplete bytes
    // under a normal `[read_file: lines X-Y of N]` header whose endLine is the
    // line the caller ASKED for, not the last line actually delivered — the
    // same confidently-wrong-data class this whole goal exists to remove.
    expect(readFileHandler).toContain('windowResult.truncated')
    const decided = readFileHandler.indexOf('windowResult.truncated')
    const formatted = readFileHandler.indexOf('formatReadFileLineWindow(')
    expect(decided).toBeGreaterThan(-1)
    expect(formatted).toBeGreaterThan(-1)
    expect(decided).toBeLessThan(formatted)
  })

  it('fails closed on truncation and hands back a usable retry', () => {
    const truncationBranch = readFileHandler.slice(
      readFileHandler.indexOf('windowResult.truncated'),
      readFileHandler.indexOf('formatReadFileLineWindow(')
    )
    expect(truncationBranch).toContain('throw new Error(')
    // Disclose or fail closed, but never silently succeed — and the refusal has
    // to name the argument the caller must change, not merely state a verdict.
    expect(truncationBranch).toContain('limit')
  })
})
