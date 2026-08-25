import { describe, expect, it } from 'vitest'
import { buildClaudeCliArgs } from '../main/ClaudeCliArgs'
import { codexToolUseFromItem } from '../main/codex/CodexEventFormatting'
import { cursorToolKind } from '../main/cursor/CursorStreamJson'
import { KIMI_ACP_DENY_TOOLS } from '../main/kimi/KimiAcpContainment'
import { AUDIT_MCP_TOOL_NAMES } from '../main/mcp/AuditToolExecutors'
import { CAPABILITY_GATEWAY_TOOL_NAMES } from '../main/mcp/McpToolGateway'
import {
  CORE_MCP_ADVERTISE_TOOLS,
  CORE_V2_MCP_ADVERTISE_TOOLS,
  FULL_MCP_ADVERTISE_TOOLS,
  FULL_V2_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_ADVERTISE_TOOLS,
  GATEWAY_V6_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS
} from '../main/mcp/McpToolProfiles'
import { PI_READ_ONLY_TOOLS, PI_WRITE_TOOLS } from '../main/pi/PiCliArgs'
import { PROVIDER_RUN_MANAGEMENT_IDS } from '../main/run/ProviderRunManagementMatrix'
import type { ProviderId } from '../main/store/types'
import {
  AUDIT_MCP_TOOL_ACTIONS,
  CANONICAL_DISPATCH_OWNERS,
  CANONICAL_PROVIDER_ACTIONS,
  CAPABILITY_GATEWAY_ACTIONS,
  PROVIDER_ACTION_ADAPTERS,
  TASKWRAITH_OWNED_MCP_ACTIONS,
  TASKWRAITH_TOOL_ACTIONS,
  TAXONOMY_AUDIT_MCP_TOOL_NAMES,
  TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES,
  compactProviderActionIdentifier,
  resolveCatalogActionStrict,
  resolveProviderActionStrict,
  resolveProviderNativeActionForDisplay,
  resolveProviderNativeActionStrict,
  resolveToolDispatchContractForServerStrict,
  resolveToolDispatchContractStrict
} from './providerActionTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './taskWraithMcpCatalog'

const providers: readonly ProviderId[] = PROVIDER_RUN_MANAGEMENT_IDS
const advertisedProfiles = [
  FULL_MCP_ADVERTISE_TOOLS,
  FULL_V2_MCP_ADVERTISE_TOOLS,
  CORE_MCP_ADVERTISE_TOOLS,
  CORE_V2_MCP_ADVERTISE_TOOLS,
  GATEWAY_MCP_ADVERTISE_TOOLS,
  GATEWAY_V6_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MCP_ADVERTISE_TOOLS,
  GATEWAY_V7_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MCP_ADVERTISE_TOOLS,
  GATEWAY_V8_MESH_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MCP_ADVERTISE_TOOLS,
  GATEWAY_V9_MESH_MCP_ADVERTISE_TOOLS
] as const

describe('provider action taxonomy', () => {
  it('declares exactly one adapter posture for every run-management ProviderId', () => {
    expect(Object.keys(PROVIDER_ACTION_ADAPTERS)).toEqual(providers)
    for (const provider of providers) {
      const declaration = PROVIDER_ACTION_ADAPTERS[provider]
      expect(declaration.nativeSurface).toBeTruthy()
      expect(declaration.mcpAttachment).toBeTruthy()
      expect(declaration.nativeMediation).toBeTruthy()
      expect(Object.keys(declaration.nativeActionMappings)).toEqual([
        ...declaration.declaredNativeActions
      ])
      expect(Object.keys(declaration.deniedNativeActionMappings)).toEqual([
        ...declaration.declaredDeniedNativeActions
      ])
    }
  })

  it('preserves Pi as a deliberate no-MCP, unobservable-native adapter', () => {
    expect(PROVIDER_ACTION_ADAPTERS.pi).toMatchObject({
      nativeSurface: 'unobservable-native',
      mcpAttachment: 'none',
      nativeMediation: 'provider-runtime-containment'
    })
  })

  it('marks Muse as observed-native for session-log tool projection without TW mediation', () => {
    expect(PROVIDER_ACTION_ADAPTERS.muse).toMatchObject({
      nativeSurface: 'observed-native',
      mcpAttachment: 'none',
      nativeMediation: 'provider-runtime-containment'
    })
  })

  it('pins Muse native tool names to honest taxonomy actions', () => {
    const muse = PROVIDER_ACTION_ADAPTERS.muse
    expect(muse.declaredNativeActions).toEqual([
      'read',
      'write',
      'edit',
      'patch',
      'delete',
      'shell',
      'web-search',
      'web-fetch'
    ])

    const aliasSet = (action: string) => new Set(muse.nativeActionMappings[action]?.aliases ?? [])

    expect(aliasSet('read')).toEqual(new Set(['read_file', 'Read', 'Read file']))
    expect(aliasSet('write')).toEqual(new Set(['write_file', 'Write', 'Write file']))
    expect(aliasSet('edit')).toEqual(new Set(['edit_file']))
    expect(aliasSet('patch')).toEqual(new Set(['apply_patch']))
    expect(aliasSet('delete')).toEqual(new Set(['delete_file']))
    expect(aliasSet('shell')).toEqual(new Set(['bash', 'exec_command', 'Bash', 'shell', 'Shell']))
    expect(aliasSet('web-search')).toEqual(new Set(['web_search', 'WebSearch', 'Search web']))
    expect(aliasSet('web-fetch')).toEqual(new Set(['web_fetch', 'WebFetch', 'Fetch']))

    // Display resolution maps Muse-specific tool names to their canonical catalog actions.
    expect(resolveProviderNativeActionForDisplay('muse', 'edit_file')).toMatchObject({
      nativeAction: 'edit',
      catalogTool: 'replace'
    })
    expect(resolveProviderNativeActionForDisplay('muse', 'apply_patch')).toMatchObject({
      nativeAction: 'patch',
      catalogTool: 'apply_patch'
    })
    expect(resolveProviderNativeActionForDisplay('muse', 'delete_file')).toMatchObject({
      nativeAction: 'delete',
      catalogTool: 'delete_path'
    })
    expect(resolveProviderNativeActionForDisplay('muse', 'exec_command')).toMatchObject({
      nativeAction: 'shell',
      catalogTool: 'run_shell_command'
    })

    // Strict execution still fails observed-native; taxonomy only answers display/parity.
    for (const spelling of ['edit_file', 'apply_patch', 'delete_file', 'exec_command']) {
      expect(resolveProviderNativeActionStrict('muse', spelling)).toMatchObject({
        ok: false,
        denied: true,
        code: 'native_surface_unobservable'
      })
    }
  })

  it('keeps Cursor broker attachment route-dependent while Pi remains none', () => {
    expect(PROVIDER_ACTION_ADAPTERS.cursor).toMatchObject({
      nativeSurface: 'unobservable-native',
      mcpAttachment: 'route-dependent',
      nativeMediation: 'provider-runtime-containment'
    })
    expect(PROVIDER_ACTION_ADAPTERS.pi.mcpAttachment).toBe('none')
  })

  it('matches Claude launch truth: native tools disabled, TaskWraith catalog only', () => {
    expect(PROVIDER_ACTION_ADAPTERS.claude).toMatchObject({
      nativeSurface: 'catalog-only',
      nativeMediation: 'not-applicable',
      declaredNativeActions: []
    })
    const args = buildClaudeCliArgs({
      prompt: 'test',
      permissionMode: 'default',
      model: 'default'
    })
    const toolsFlag = args.indexOf('--tools')
    expect(toolsFlag).toBeGreaterThanOrEqual(0)
    expect(args[toolsFlag + 1]).toBe('')
  })

  it('pins Codex native actions to structural app-server item identities', () => {
    const commandItem = {
      type: 'commandExecution',
      id: 'cmd-1',
      command: ['npm', 'test'],
      cwd: '/workspace'
    }
    expect(codexToolUseFromItem(commandItem)).toMatchObject({
      tool_name: 'run_shell_command'
    })
    expect(resolveProviderNativeActionStrict('codex', commandItem.type)).toMatchObject({
      ok: true,
      nativeAction: 'command-execution',
      catalogTool: 'run_shell_command'
    })

    const fileChangeItem = {
      type: 'fileChange',
      id: 'edit-1',
      changes: [{ kind: 'update', path: 'src/file.ts' }]
    }
    expect(codexToolUseFromItem(fileChangeItem)).toMatchObject({ tool_name: 'edit_file' })
    expect(resolveProviderNativeActionStrict('codex', fileChangeItem.type)).toMatchObject({
      ok: true,
      nativeAction: 'file-change',
      catalogTool: 'apply_patch'
    })
    expect(resolveProviderNativeActionStrict('codex', 'Edit')).toMatchObject({
      ok: false,
      code: 'native_action_not_declared'
    })
  })

  it('pins Kimi denied-only and Pi launch-time native inventories', () => {
    const kimi = PROVIDER_ACTION_ADAPTERS.kimi
    const kimiDeniedAliases = kimi.declaredDeniedNativeActions.flatMap(
      (action) => kimi.deniedNativeActionMappings[action].aliases
    )
    expect(kimi.declaredNativeActions).toEqual([])
    expect(kimiDeniedAliases).toEqual([...KIMI_ACP_DENY_TOOLS])
    for (const alias of KIMI_ACP_DENY_TOOLS) {
      expect(resolveProviderNativeActionStrict('kimi', alias)).toMatchObject({
        ok: false,
        code: 'native_surface_closed'
      })
    }

    const piAliases = PROVIDER_ACTION_ADAPTERS.pi.declaredNativeActions.flatMap(
      (action) => PROVIDER_ACTION_ADAPTERS.pi.nativeActionMappings[action].aliases
    )
    const piNonLaunchableAliases = PROVIDER_ACTION_ADAPTERS.pi.declaredDeniedNativeActions.flatMap(
      (action) => PROVIDER_ACTION_ADAPTERS.pi.deniedNativeActionMappings[action].aliases
    )
    expect(PI_WRITE_TOOLS).toEqual(PI_READ_ONLY_TOOLS)
    expect(new Set(piAliases)).toEqual(new Set([...PI_READ_ONLY_TOOLS, ...PI_WRITE_TOOLS]))
    expect(new Set(piNonLaunchableAliases)).toEqual(new Set(['write', 'edit', 'bash']))
  })

  it('pins every Cursor parser-known native base to an explicit display disposition', () => {
    const parserKnownBases = [
      'read',
      'readFile',
      'ls',
      'list',
      'listDir',
      'readLints',
      'glob',
      'grep',
      'search',
      'codebaseSearch',
      'semanticSearch',
      'web_search',
      'webSearch',
      'googleWebSearch',
      'edit',
      'write',
      'create',
      'createFile',
      'multiEdit',
      'searchReplace',
      'applyPatch',
      'delete',
      'deleteFile',
      'remove',
      'shell',
      'run',
      'runTerminal',
      'runTerminalCommand',
      'terminal',
      'createPlan',
      'plan',
      'todo',
      'todoWrite',
      'updateTodo',
      'webFetch',
      'web_fetch',
      'fetch',
      'web'
    ] as const
    const declaredAliases = PROVIDER_ACTION_ADAPTERS.cursor.declaredNativeActions.flatMap(
      (action) => PROVIDER_ACTION_ADAPTERS.cursor.nativeActionMappings[action].aliases
    )
    expect(new Set(declaredAliases.map((alias) => alias.toLowerCase()))).toEqual(
      new Set(parserKnownBases.map((alias) => alias.toLowerCase()))
    )
    for (const base of parserKnownBases) {
      expect(cursorToolKind(base), base).toBeTruthy()
      expect(resolveProviderNativeActionForDisplay('cursor', base), base).not.toBeNull()
      expect(resolveProviderNativeActionStrict('cursor', base), base).toMatchObject({
        ok: false,
        code: 'native_surface_unobservable'
      })
    }
  })

  it('has explicit metadata for every catalog entry and no extra semantic default', () => {
    expect(Object.keys(TASKWRAITH_TOOL_ACTIONS)).toEqual([...TASKWRAITH_MCP_TOOLS])
    for (const toolName of TASKWRAITH_MCP_TOOLS) {
      const metadata = TASKWRAITH_TOOL_ACTIONS[toolName]
      expect(CANONICAL_PROVIDER_ACTIONS).toContain(metadata.operation)
      expect(metadata.toolClass).toBeTruthy()
      expect(metadata.service).toBeTruthy()
      expect(metadata.dispatchOwner).toBeTruthy()
      expect(metadata.mutation).toBeTruthy()
      expect(metadata.lock).toBeTruthy()
      expect(['none', 'always', 'url-argument'], toolName).toContain(metadata.networkEgress)
      expect(CANONICAL_DISPATCH_OWNERS).toContain(metadata.dispatchOwner)
    }
  })

  it('covers the real advertised gateway and role-scoped audit unions exactly', () => {
    expect(TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES).toEqual(CAPABILITY_GATEWAY_TOOL_NAMES)
    expect(TAXONOMY_AUDIT_MCP_TOOL_NAMES).toEqual(AUDIT_MCP_TOOL_NAMES)
    expect(Object.keys(TASKWRAITH_OWNED_MCP_ACTIONS)).toEqual([
      ...TASKWRAITH_MCP_TOOLS,
      ...CAPABILITY_GATEWAY_TOOL_NAMES,
      ...AUDIT_MCP_TOOL_NAMES
    ])
    for (const profile of advertisedProfiles) {
      for (const toolName of profile) {
        expect(
          Object.prototype.hasOwnProperty.call(TASKWRAITH_OWNED_MCP_ACTIONS, toolName),
          toolName
        ).toBe(true)
      }
      for (const auditTool of AUDIT_MCP_TOOL_NAMES) {
        expect(
          Object.prototype.hasOwnProperty.call(TASKWRAITH_OWNED_MCP_ACTIONS, auditTool),
          auditTool
        ).toBe(true)
      }
    }
    expect(CAPABILITY_GATEWAY_ACTIONS.capability_invoke).toEqual({
      resolution: 'target-derived',
      toolClass: 'target-derived',
      service: 'target-derived',
      operation: 'target-derived',
      dispatchOwner: 'capability-gateway',
      mutation: 'target-derived',
      lock: 'target-derived',
      networkEgress: 'target-derived'
    })
    expect(Object.keys(AUDIT_MCP_TOOL_ACTIONS)).toEqual([...AUDIT_MCP_TOOL_NAMES])
  })

  it('resolves a declared dispatcher owner and visibly rejects an unknown dispatch', () => {
    expect(resolveToolDispatchContractStrict('mcp__taskwraith__apply_patch')).toEqual({
      ok: true,
      toolName: 'apply_patch',
      effectiveToolName: 'apply_patch',
      resolution: 'fixed',
      toolClass: 'workspace_write',
      action: 'workspace.mutate',
      dispatchOwner: 'workspace-tools',
      service: 'fileChanges',
      mutation: 'workspace',
      lock: 'workspace-paths',
      networkEgress: 'none'
    })
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        name: 'write_file',
        arguments: { path: 'src/file.ts', content: 'body' }
      })
    ).toMatchObject({
      ok: true,
      toolName: 'capability_invoke',
      effectiveToolName: 'write_file',
      resolution: 'target-derived',
      dispatchOwner: 'workspace-tools',
      gatewayDispatchOwner: 'capability-gateway',
      service: 'fileChanges',
      mutation: 'workspace',
      lock: 'workspace-paths'
    })
    expect(resolveToolDispatchContractStrict('capability_invoke')).toMatchObject({
      ok: false,
      code: 'gateway_target_required'
    })
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        input: { name: 'write_file' }
      })
    ).toMatchObject({
      ok: false,
      code: 'gateway_target_required'
    })
    for (const args of [
      {
        name: 'write_file',
        input: { name: 'mcp__evil__write_file' }
      },
      {
        name: 'mcp__evil__write_file',
        input: { name: 'write_file' }
      },
      {
        name: 'write_file',
        rawInput: { name: 'read_file' }
      },
      {
        name: 'write_file',
        parameters: { name: null }
      }
    ]) {
      expect(resolveToolDispatchContractStrict('capability_invoke', args), JSON.stringify(args)).toMatchObject({
        ok: false,
        code: 'gateway_target_identity_conflict'
      })
    }
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        name: 'write_file',
        rawInput: { name: 'write_file' }
      })
    ).toMatchObject({
      ok: true,
      effectiveToolName: 'write_file'
    })
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        name: 'capability_invoke',
        arguments: {}
      })
    ).toMatchObject({
      ok: false,
      code: 'gateway_target_not_declared'
    })
    expect(resolveToolDispatchContractStrict('audit_record_finding')).toMatchObject({
      ok: true,
      effectiveToolName: 'audit_record_finding',
      dispatchOwner: 'audit-tools',
      mutation: 'host-state',
      lock: 'host-resource'
    })
    expect(resolveToolDispatchContractStrict('unowned_future_dispatch')).toMatchObject({
      ok: false,
      denied: true,
      code: 'unmapped_catalog_action',
      reason: expect.stringMatching(/no declared catalog metadata or dispatcher owner/i)
    })
    for (const spoofed of [
      'mcp__evil__write_file',
      'taskwraith-broker__mcp__evil__write_file',
      'mcp__taskwraith__mcp__evil__write_file'
    ]) {
      expect(resolveToolDispatchContractStrict(spoofed), spoofed).toMatchObject({
        ok: false,
        denied: true,
        code: 'unmapped_catalog_action'
      })
    }
  })

  it('routes canvas_open(driver=device) to simulatorCanvas (arg-dependent service)', () => {
    expect(resolveToolDispatchContractStrict('canvas_open')).toMatchObject({
      ok: true,
      service: 'mcpTools'
    })
    expect(
      resolveToolDispatchContractStrict('canvas_open', { url: 'http://localhost:3000' })
    ).toMatchObject({ ok: true, service: 'mcpTools' })
    expect(
      resolveToolDispatchContractStrict('canvas_open', {
        driver: 'device',
        bundleId: 'com.example.App'
      })
    ).toMatchObject({ ok: true, service: 'simulatorCanvas' })
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        name: 'canvas_open',
        arguments: { driver: 'device', bundleId: 'com.example.App' }
      })
    ).toMatchObject({
      ok: true,
      effectiveToolName: 'canvas_open',
      resolution: 'target-derived',
      service: 'simulatorCanvas'
    })
    expect(
      resolveToolDispatchContractStrict('capability_invoke', {
        name: 'canvas_open',
        rawInput: { driver: 'web', url: 'http://localhost:3000' }
      })
    ).toMatchObject({ ok: true, service: 'mcpTools' })
  })

  it('gives every mutation scope an explicit matching lock policy', () => {
    for (const [toolName, metadata] of Object.entries(TASKWRAITH_OWNED_MCP_ACTIONS)) {
      if (metadata.mutation === 'target-derived') continue
      if (metadata.mutation === 'none') {
        expect(metadata.lock, toolName).toBe('none')
      } else {
        expect(metadata.lock, toolName).not.toBe('none')
      }
      if (metadata.mutation === 'workspace') {
        expect(['workspace-paths', 'workspace-repository'], toolName).toContain(metadata.lock)
      }
      expect(CANONICAL_DISPATCH_OWNERS, toolName).toContain(metadata.dispatchOwner)
    }
    expect(TASKWRAITH_TOOL_ACTIONS.get_diagnostics).toMatchObject({
      toolClass: 'workspace_write',
      service: 'shellCommands',
      mutation: 'runtime',
      lock: 'workspace-runtime'
    })
    expect(TASKWRAITH_TOOL_ACTIONS.start_background_process.lock).toBe('workspace-runtime')
    expect(TASKWRAITH_TOOL_ACTIONS.launch_start.lock).toBe('workspace-runtime')
    expect(TASKWRAITH_TOOL_ACTIONS.kill_background_process.lock).toBe('host-resource')
    expect(TASKWRAITH_TOOL_ACTIONS.launch_stop.lock).toBe('host-resource')
  })

  it('keeps every adapter mapping aligned with the canonical catalog metadata', () => {
    for (const provider of providers) {
      const declaration = PROVIDER_ACTION_ADAPTERS[provider]
      const seenAliases = new Map<string, string>()
      for (const nativeAction of declaration.declaredNativeActions) {
        const mapping = declaration.nativeActionMappings[nativeAction]
        expect(mapping).toBeDefined()
        expect(mapping.action).toBe(TASKWRAITH_TOOL_ACTIONS[mapping.catalogTool].operation)
        for (const alias of mapping.aliases) {
          const compact = compactProviderActionIdentifier(alias)
          expect(compact).not.toBe('')
          const prior = seenAliases.get(compact)
          if (prior) {
            expect(
              declaration.nativeActionMappings[prior].catalogTool,
              `${provider} alias ${alias}`
            ).toBe(mapping.catalogTool)
          }
          seenAliases.set(compact, nativeAction)
        }
      }
      for (const nativeAction of declaration.declaredDeniedNativeActions) {
        const mapping = declaration.deniedNativeActionMappings[nativeAction]
        expect(mapping).toBeDefined()
        expect(mapping.action).toBe(TASKWRAITH_TOOL_ACTIONS[mapping.catalogTool].operation)
        for (const alias of mapping.aliases) {
          expect(compactProviderActionIdentifier(alias)).not.toBe('')
        }
      }
      for (const disposition of Object.values(declaration.structuredKindMappings)) {
        for (const nativeAction of typeof disposition === 'string' ? [disposition] : disposition) {
          expect(declaration.nativeActionMappings[nativeAction]).toBeDefined()
        }
      }
    }
  })

  it('coalesces native write/edit/patch spellings onto one harness action', () => {
    for (const [provider, spellings] of [
      ['grok', ['Create file', 'Edit file', 'Apply patch']],
      ['cursor', ['create', 'edit', 'applyPatch']],
      ['mistral', ['Write file', 'search_replace', 'Patch']]
    ] as const) {
      for (const spelling of spellings) {
        const display = resolveProviderNativeActionForDisplay(provider, spelling)
        expect(display?.action, `${provider}:${spelling}`).toBe('workspace.mutate')
      }
    }
    expect(resolveProviderNativeActionForDisplay('codex', 'fileChange')).toMatchObject({
      catalogTool: 'apply_patch',
      action: 'workspace.mutate'
    })
    for (const catalogTool of ['write_file', 'replace', 'apply_patch'] as const) {
      expect(TASKWRAITH_TOOL_ACTIONS[catalogTool]).toMatchObject({
        operation: 'workspace.mutate',
        service: 'fileChanges',
        mutation: 'workspace',
        lock: 'workspace-paths'
      })
    }
  })

  it('strictly resolves only mediated native actions', () => {
    expect(resolveProviderNativeActionStrict('codex', 'fileChange')).toMatchObject({
      ok: true,
      provider: 'codex',
      source: 'provider-native',
      catalogTool: 'apply_patch',
      action: 'workspace.mutate'
    })
    expect(
      resolveProviderNativeActionStrict('grok', 'Arbitrary ACP display title', {
        toolKind: 'read',
        rawToolCall: { rawInput: { path: 'src/generated.ts' } }
      })
    ).toMatchObject({
      ok: true,
      catalogTool: 'read_file',
      action: 'workspace.read'
    })
  })

  it('binds structured ACP decisions to provider + tool kind, never the display title', () => {
    expect(
      resolveProviderNativeActionStrict('mistral', 'Write file src/generated.ts', {
        toolKind: 'edit'
      })
    ).toMatchObject({ ok: true, catalogTool: 'write_file' })
    expect(
      resolveProviderNativeActionStrict('mistral', 'Totally unrelated human title', {
        toolKind: 'edit'
      })
    ).toMatchObject({ ok: true, catalogTool: 'write_file' })
    expect(
      resolveProviderNativeActionStrict('grok', 'Write file src/generated.ts', {
        toolKind: 'execute'
      })
    ).toMatchObject({ ok: true, catalogTool: 'run_shell_command' })
    expect(
      resolveProviderNativeActionStrict('grok', 'Write file src/generated.ts', {
        toolKind: 'search'
      })
    ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    expect(resolveProviderNativeActionStrict('grok', 'Read file')).toMatchObject({
      ok: false,
      code: 'native_action_not_declared'
    })
    expect(
      resolveProviderNativeActionStrict('grok', 'Same title', {
        toolKind: 'search',
        rawToolCall: { rawInput: { tool_name: 'WebSearch', query: 'release gates' } }
      })
    ).toMatchObject({ ok: true, catalogTool: 'web_search' })
    expect(
      resolveProviderNativeActionStrict('grok', 'Same title', {
        toolKind: 'search',
        rawToolCall: {
          rawInput: { tool_name: 'Grep', path: 'src', query: 'release gates' }
        }
      })
    ).toMatchObject({ ok: true, catalogTool: 'workspace_search' })
    expect(
      resolveProviderNativeActionStrict('mistral', 'Untrusted list title', {
        toolKind: 'read',
        rawToolCall: { rawInput: { tool_name: 'List directory' } }
      })
    ).toMatchObject({ ok: true, catalogTool: 'list_directory' })
    expect(
      resolveProviderNativeActionStrict('mistral', 'Untrusted rename title', {
        toolKind: 'move',
        rawToolCall: { rawInput: { path: 'old.ts', newName: 'new.ts' } }
      })
    ).toMatchObject({ ok: true, catalogTool: 'rename_path' })
    expect(
      resolveProviderNativeActionStrict('grok', 'Untrusted patch title', {
        toolKind: 'edit',
        rawToolCall: { rawInput: { patch: '--- a/x\\n+++ b/x' } }
      })
    ).toMatchObject({ ok: true, catalogTool: 'apply_patch' })
    for (const [toolKind, toolName] of [
      ['read', 'Write'],
      ['read', 'Mkdir'],
      ['search', 'Bash']
    ] as const) {
      expect(
        resolveProviderNativeActionStrict('grok', 'Irrelevant display title', {
          toolKind,
          rawToolCall: { rawInput: { tool_name: toolName, path: 'src/file.ts' } }
        }),
        `${toolKind}:${toolName}`
      ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    }
    for (const rawToolCall of [
      { tool_name: 'Read', name: 'Delete', path: 'src/file.ts' },
      {
        tool_name: 'Read',
        rawInput: { tool_name: 'Delete', path: 'src/file.ts' }
      }
    ]) {
      expect(
        resolveProviderNativeActionStrict('grok', 'Irrelevant display title', {
          toolKind: 'read',
          rawToolCall
        })
      ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    }
    expect(
      resolveProviderNativeActionStrict('grok', 'Irrelevant display title', {
        toolKind: 'search',
        rawToolCall: {
          name: 'Grep',
          rawInput: { name: 'Bash', path: 'src', query: 'needle' }
        }
      })
    ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    expect(
      resolveProviderNativeActionStrict('grok', 'Harmless display title', {
        toolKind: 'read',
        rawToolCall: {
          kind: 'read',
          rawInput: { path: 'README.md', command: 'rm -rf ../outside' }
        }
      })
    ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    expect(
      resolveProviderNativeActionStrict('mistral', 'Harmless display title', {
        toolKind: 'execute',
        rawToolCall: {
          kind: 'execute',
          rawInput: { command: 'pwd', content: 'write-shaped contradiction' }
        }
      })
    ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    for (const [toolKind, rawInput] of [
      ['read', { tool_name: 'TotallyNewExfiltrateTool', path: 'README.md' }],
      [
        'edit',
        {
          toolName: 'TotallyNewOverwriteTool',
          path: 'src/generated.ts',
          content: 'owned'
        }
      ],
      [
        'search',
        {
          name: 'TotallyNewNetworkSearchTool',
          path: 'src',
          query: 'needle'
        }
      ]
    ] as const) {
      expect(
        resolveProviderNativeActionStrict('grok', 'Untrusted display title', {
          toolKind,
          rawToolCall: { rawInput }
        }),
        toolKind
      ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    }
    expect(
      resolveProviderNativeActionStrict('claude', 'Write file src/generated.ts', {
        toolKind: 'edit'
      })
    ).toMatchObject({ ok: false, code: 'native_surface_closed' })
  })

  it('returns typed denies for unknown, closed, and unobservable native actions', () => {
    expect(resolveProviderNativeActionStrict('claude', 'TeleportRepository')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_surface_closed',
      provider: 'claude'
    })
    expect(resolveProviderNativeActionStrict('kimi', 'Read')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_surface_closed',
      provider: 'kimi'
    })
    expect(resolveProviderNativeActionStrict('pi', 'edit')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_action_not_declared',
      provider: 'pi'
    })
    expect(resolveProviderNativeActionForDisplay('pi', 'edit')).toMatchObject({
      ok: true,
      catalogTool: 'replace',
      action: 'workspace.mutate'
    })
    expect(resolveProviderActionStrict('pi', 'write_file')).toMatchObject({
      ok: false,
      denied: true,
      code: 'mcp_attachment_unavailable',
      provider: 'pi'
    })
  })

  it('fails explicit catalog resolution instead of inventing generic policy', () => {
    expect(resolveCatalogActionStrict('mcp__taskwraith__apply_patch')).toMatchObject({
      ok: true,
      catalogTool: 'apply_patch',
      action: 'workspace.mutate'
    })
    expect(resolveCatalogActionStrict('mcp__TaskWraith__apply_patch')).toMatchObject({
      ok: true,
      catalogTool: 'apply_patch'
    })
    expect(resolveCatalogActionStrict('TaskWraith__read_file')).toMatchObject({
      ok: true,
      catalogTool: 'read_file'
    })
    expect(resolveCatalogActionStrict('mcp_TaskWraith_read_file')).toMatchObject({
      ok: true,
      catalogTool: 'read_file'
    })
    expect(resolveCatalogActionStrict('taskwraith-grok__read_file')).toMatchObject({
      ok: true,
      catalogTool: 'read_file'
    })
    expect(resolveCatalogActionStrict('mcp__evil__write_file')).toMatchObject({
      ok: false,
      denied: true,
      code: 'unmapped_catalog_action'
    })
    for (const untrustedPresentation of [
      'Ask User Question',
      'AskUserQuestion',
      'Request_User_Input',
      'READ_FILE',
      'mcp__taskwraith__AskUserQuestion',
      'mcp__TASKWRAITH__read_file',
      'TaskWraith__Read_File',
      'MCP_TaskWraith_read_file'
    ]) {
      expect(
        resolveCatalogActionStrict(untrustedPresentation),
        untrustedPresentation
      ).toMatchObject({
        ok: false,
        denied: true,
        code: 'unmapped_catalog_action'
      })
    }
    for (const trustedPrefix of [
      'mcp__taskwraith__',
      'mcp__taskwraith-broker__',
      'mcp__taskwraith-grok__',
      'mcp__taskwraith-mistral__',
      'mcp_taskwraith-broker_',
      'mcp_taskwraith-broker-',
      'mcp_taskwraith_',
      'mcp_taskwraith-',
      'taskwraith-broker__',
      'taskwraith_broker__',
      'taskwraith-broker_',
      'taskwraith_broker_',
      'taskwraith-broker-',
      'taskwraith_broker-',
      'taskwraith-grok__',
      'taskwraith-mistral__',
      'taskwraith__'
    ]) {
      expect(
        resolveCatalogActionStrict(`${trustedPrefix}mcp__evil__write_file`),
        trustedPrefix
      ).toMatchObject({
        ok: false,
        denied: true,
        code: 'unmapped_catalog_action'
      })
    }
    expect(resolveCatalogActionStrict('future_tool_without_a_mapping')).toMatchObject({
      ok: false,
      denied: true,
      code: 'unmapped_catalog_action',
      provider: null
    })
    expect(resolveProviderActionStrict('claude', 'future_tool_without_a_mapping')).toMatchObject({
      ok: false,
      denied: true,
      code: 'native_surface_closed',
      provider: 'claude'
    })
  })

  // A Codex seat may report the MCP server and tool as SEPARATE fields. That
  // path must accept exactly what the single-string path accepts: its guard
  // delegates to the folding resolver, so leaving the guard case-exact made it
  // stricter than the function it guards and silently dropped identities.
  it('resolves a split server/tool identity exactly as the single string does', () => {
    const parity: Array<[string, string]> = [
      ['TaskWraith', 'READ_FILE'],
      ['taskwraith', 'AskUserQuestion'],
      ['taskwraith', 'ENSEMBLE_CONTROL'],
      ['taskwraith', 'read_file']
    ]
    for (const [server, tool] of parity) {
      const single = resolveToolDispatchContractStrict(`mcp__${server}__${tool}`)
      const split = resolveToolDispatchContractForServerStrict(server, tool)
      expect(single.ok).toBe(true)
      expect(split.ok).toBe(true)
      expect(split.ok && single.ok && split.toolName).toBe(single.ok && single.toolName)
    }
    // Still fails closed for a server the catalog does not own, on both paths.
    expect(resolveToolDispatchContractForServerStrict('evilserver', 'read_file').ok).toBe(false)
    expect(resolveToolDispatchContractStrict('mcp__evilserver__read_file').ok).toBe(false)
  })
})
