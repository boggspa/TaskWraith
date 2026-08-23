import type { AgenticServiceId, ProviderId } from '../main/store/types'
import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from './taskWraithMcpCatalog'

/**
 * The harness-level action vocabulary. Provider-native spellings stay native,
 * but policy, audit, summaries, and future lock acquisition consume one of
 * these values. In particular write/create/edit/replace/patch all converge on
 * `workspace.mutate`.
 */
export const CANONICAL_PROVIDER_ACTIONS = [
  'workspace.read',
  'workspace.search',
  'workspace.mutate',
  'shell.execute',
  'network.read',
  'external.mutate',
  'control.read',
  'control.mutate',
  'user.elicit',
  'application.read',
  'application.mutate',
  'media.read',
  'media.mutate'
] as const

export type CanonicalProviderAction = (typeof CANONICAL_PROVIDER_ACTIONS)[number]

export type CanonicalToolClass =
  | 'workspace_read'
  | 'web_read'
  | 'workspace_write'
  | 'orchestration'
  | 'ui_elicitation'

export const CANONICAL_DISPATCH_OWNERS = [
  'workspace-tools',
  'git-tools',
  'web-tools',
  'github-tools',
  'process-tools',
  'run-control',
  'attachment-tools',
  'workspace-board',
  'outlook-connector',
  'project-reference',
  'evidence-tools',
  'subthread-control',
  'browser-tools',
  'window-capture',
  'appwatch',
  'appshots',
  'provider-status',
  'creative-app',
  'ide-tools',
  'ensemble-control',
  'scheduler',
  'user-question',
  'goal-control',
  'blackboard',
  'launch-control',
  'canvas',
  'mesh-canvas',
  'simulator-canvas',
  'theme-control',
  'cross-thread-recall',
  'introspection',
  'skills',
  'image-tools',
  'audio-tools',
  'ffmpeg-tools',
  'native-media',
  'document-tools',
  'capability-gateway',
  'audit-tools'
] as const

export type CanonicalDispatchOwner = (typeof CANONICAL_DISPATCH_OWNERS)[number]

export type CanonicalMutationScope =
  | 'none'
  | 'workspace'
  | 'host-state'
  | 'runtime'
  | 'external-state'
  | 'attached-application'

export type CanonicalLockSemantics =
  | 'none'
  | 'workspace-paths'
  | 'workspace-repository'
  | 'workspace-runtime'
  | 'host-resource'
  | 'external-resource'
  | 'application-resource'

export type CanonicalNetworkEgress = 'none' | 'always' | 'url-argument'

export interface CanonicalToolActionMetadata {
  readonly toolClass: CanonicalToolClass
  readonly service: AgenticServiceId
  readonly operation: CanonicalProviderAction
  readonly dispatchOwner: CanonicalDispatchOwner
  readonly mutation: CanonicalMutationScope
  readonly lock: CanonicalLockSemantics
  readonly networkEgress: CanonicalNetworkEgress
}

function tool(
  toolClass: CanonicalToolClass,
  service: AgenticServiceId,
  operation: CanonicalProviderAction,
  dispatchOwner: CanonicalDispatchOwner,
  mutation: CanonicalMutationScope,
  lock: CanonicalLockSemantics,
  networkEgress: CanonicalNetworkEgress = operation === 'network.read' ||
  operation === 'external.mutate'
    ? 'always'
    : 'none'
): CanonicalToolActionMetadata {
  return { toolClass, service, operation, dispatchOwner, mutation, lock, networkEgress }
}

export type ProviderNativeSurface =
  | 'catalog-only'
  | 'closed-native'
  | 'unobservable-native'
  /** Native tools are display-projected (e.g. Muse session.jsonl) but not TW-mediated. */
  | 'observed-native'

export type ProviderMcpAttachmentPosture = 'required' | 'conditional' | 'none' | 'route-dependent'

export type ProviderNativeMediationPosture =
  | 'not-applicable'
  | 'taskwraith-preflight-and-approval'
  | 'provider-runtime-containment'
  | 'route-dependent'

export const PROVIDER_STRUCTURED_TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'other'
] as const

export type ProviderStructuredToolKind = (typeof PROVIDER_STRUCTURED_TOOL_KINDS)[number]

export type ProviderStructuredKindDisposition<ActionId extends string = string> =
  | ActionId
  | readonly [ActionId, ...ActionId[]]

export interface ProviderNativeActionMapping {
  readonly aliases: readonly [string, ...string[]]
  readonly catalogTool: TaskWraithMcpToolName
  readonly action: CanonicalProviderAction
}

export interface ProviderNativeActionContext {
  readonly toolKind?: string | null
  readonly rawToolCall?: unknown
}

export interface ProviderActionAdapterDeclaration {
  readonly nativeSurface: ProviderNativeSurface
  readonly mcpAttachment: ProviderMcpAttachmentPosture
  readonly nativeMediation: ProviderNativeMediationPosture
  readonly declaredNativeActions: readonly string[]
  readonly nativeActionMappings: Readonly<Record<string, ProviderNativeActionMapping>>
  readonly declaredDeniedNativeActions: readonly string[]
  readonly deniedNativeActionMappings: Readonly<Record<string, ProviderNativeActionMapping>>
  readonly structuredKindMappings: Readonly<
    Partial<Record<ProviderStructuredToolKind, ProviderStructuredKindDisposition>>
  >
}

function adapter<
  const NativeActionIds extends readonly string[],
  const DeniedNativeActionIds extends readonly string[]
>(input: {
  readonly nativeSurface: ProviderNativeSurface
  readonly mcpAttachment: ProviderMcpAttachmentPosture
  readonly nativeMediation: ProviderNativeMediationPosture
  readonly declaredNativeActions: NativeActionIds
  readonly nativeActionMappings: {
    readonly [ActionId in NativeActionIds[number]]: ProviderNativeActionMapping
  }
  readonly declaredDeniedNativeActions: DeniedNativeActionIds
  readonly deniedNativeActionMappings: {
    readonly [ActionId in DeniedNativeActionIds[number]]: ProviderNativeActionMapping
  }
  readonly structuredKindMappings: Readonly<
    Partial<
      Record<ProviderStructuredToolKind, ProviderStructuredKindDisposition<NativeActionIds[number]>>
    >
  >
}): ProviderActionAdapterDeclaration {
  return input
}

const NO_NATIVE_ACTIONS = [] as const

/**
 * One declaration per ProviderId. The `satisfies Record<ProviderId, ...>` is
 * intentional: provider #11 cannot typecheck until its attachment and native
 * mediation posture are declared. Each adapter separately lists its native
 * action ids; the generic `adapter` helper then makes an omitted mapping a
 * compile-time error.
 */
export const PROVIDER_ACTION_ADAPTERS = {
  gemini: adapter({
    nativeSurface: 'catalog-only',
    mcpAttachment: 'conditional',
    nativeMediation: 'not-applicable',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: NO_NATIVE_ACTIONS,
    nativeActionMappings: {}
  }),
  codex: adapter({
    nativeSurface: 'closed-native',
    mcpAttachment: 'conditional',
    nativeMediation: 'taskwraith-preflight-and-approval',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: ['command-execution', 'file-change'] as const,
    nativeActionMappings: {
      'command-execution': {
        aliases: ['commandExecution'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      'file-change': {
        aliases: ['fileChange'],
        catalogTool: 'apply_patch',
        action: 'workspace.mutate'
      }
    }
  }),
  claude: adapter({
    nativeSurface: 'catalog-only',
    mcpAttachment: 'conditional',
    nativeMediation: 'not-applicable',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: NO_NATIVE_ACTIONS,
    nativeActionMappings: {}
  }),
  kimi: adapter({
    nativeSurface: 'catalog-only',
    mcpAttachment: 'required',
    nativeMediation: 'not-applicable',
    structuredKindMappings: {},
    declaredNativeActions: NO_NATIVE_ACTIONS,
    nativeActionMappings: {},
    declaredDeniedNativeActions: [
      'fetch-url',
      'web-search',
      'agent-swarm',
      'shell',
      'find',
      'search',
      'read',
      'write',
      'edit'
    ] as const,
    deniedNativeActionMappings: {
      'fetch-url': {
        aliases: ['FetchURL'],
        catalogTool: 'web_fetch',
        action: 'network.read'
      },
      'web-search': {
        aliases: ['WebSearch'],
        catalogTool: 'web_search',
        action: 'network.read'
      },
      'agent-swarm': {
        aliases: ['AgentSwarm'],
        catalogTool: 'ensemble_fanout',
        action: 'control.mutate'
      },
      shell: {
        aliases: ['Bash'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      find: {
        aliases: ['Glob'],
        catalogTool: 'find_files',
        action: 'workspace.search'
      },
      search: {
        aliases: ['Grep'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      },
      read: {
        aliases: ['Read'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      write: {
        aliases: ['Write'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['Edit'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      }
    }
  }),
  grok: adapter({
    nativeSurface: 'closed-native',
    mcpAttachment: 'conditional',
    nativeMediation: 'taskwraith-preflight-and-approval',
    structuredKindMappings: {
      read: ['read', 'list'],
      edit: ['write', 'edit', 'patch', 'create-directory'],
      delete: 'delete',
      move: ['move', 'rename'],
      search: ['find', 'search', 'web-search'],
      execute: 'shell',
      fetch: 'web-fetch'
    },
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: [
      'read',
      'list',
      'find',
      'search',
      'write',
      'edit',
      'patch',
      'create-directory',
      'delete',
      'move',
      'rename',
      'shell',
      'web-search',
      'web-fetch'
    ] as const,
    nativeActionMappings: {
      read: {
        aliases: ['Read', 'Read file', 'read_file', 'Open file'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      list: {
        aliases: ['LS', 'List directory', 'list_directory'],
        catalogTool: 'list_directory',
        action: 'workspace.read'
      },
      find: {
        aliases: ['Glob', 'Find files'],
        catalogTool: 'find_files',
        action: 'workspace.search'
      },
      search: {
        aliases: ['Grep', 'Search workspace'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      },
      write: {
        aliases: ['Write', 'Write file', 'Create file'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['Edit', 'Edit file', 'Replace', 'search_replace'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      patch: {
        aliases: ['apply_patch', 'Apply patch', 'Patch'],
        catalogTool: 'apply_patch',
        action: 'workspace.mutate'
      },
      'create-directory': {
        aliases: ['Create directory', 'Mkdir'],
        catalogTool: 'create_directory',
        action: 'workspace.mutate'
      },
      delete: {
        aliases: ['Delete', 'Delete file', 'Delete path', 'Remove'],
        catalogTool: 'delete_path',
        action: 'workspace.mutate'
      },
      move: {
        aliases: ['Move', 'Move file', 'Move path'],
        catalogTool: 'move_path',
        action: 'workspace.mutate'
      },
      rename: {
        aliases: ['Rename', 'Rename file', 'Rename path'],
        catalogTool: 'rename_path',
        action: 'workspace.mutate'
      },
      shell: {
        aliases: ['Bash', 'Shell', 'run_terminal_command', 'Run terminal command'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      'web-search': {
        aliases: ['WebSearch', 'web_search', 'Search web'],
        catalogTool: 'web_search',
        action: 'network.read'
      },
      'web-fetch': {
        aliases: ['Fetch', 'WebFetch', 'web_fetch'],
        catalogTool: 'web_fetch',
        action: 'network.read'
      }
    }
  }),
  cursor: adapter({
    nativeSurface: 'unobservable-native',
    mcpAttachment: 'route-dependent',
    nativeMediation: 'provider-runtime-containment',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: [
      'read',
      'list',
      'find',
      'search',
      'write',
      'edit',
      'patch',
      'delete',
      'shell',
      'diagnostics',
      'web-search',
      'web-fetch',
      'todo'
    ] as const,
    nativeActionMappings: {
      read: {
        aliases: ['read', 'readFile'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      list: {
        aliases: ['ls', 'list', 'listDir'],
        catalogTool: 'list_directory',
        action: 'workspace.read'
      },
      find: {
        aliases: ['glob'],
        catalogTool: 'find_files',
        action: 'workspace.search'
      },
      search: {
        aliases: ['grep', 'search', 'codebaseSearch', 'semanticSearch'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      },
      write: {
        aliases: ['write', 'create', 'createFile'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['edit', 'multiEdit', 'searchReplace'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      patch: {
        aliases: ['applyPatch'],
        catalogTool: 'apply_patch',
        action: 'workspace.mutate'
      },
      delete: {
        aliases: ['delete', 'deleteFile', 'remove'],
        catalogTool: 'delete_path',
        action: 'workspace.mutate'
      },
      shell: {
        aliases: ['shell', 'run', 'runTerminal', 'runTerminalCommand', 'terminal'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      diagnostics: {
        aliases: ['readLints'],
        catalogTool: 'get_diagnostics',
        action: 'workspace.read'
      },
      'web-search': {
        aliases: ['web_search', 'webSearch', 'googleWebSearch'],
        catalogTool: 'web_search',
        action: 'network.read'
      },
      'web-fetch': {
        aliases: ['webFetch', 'web_fetch', 'fetch', 'web'],
        catalogTool: 'web_fetch',
        action: 'network.read'
      },
      todo: {
        aliases: ['createPlan', 'plan', 'todo', 'todoWrite', 'updateTodo'],
        catalogTool: 'todo_write',
        action: 'control.mutate'
      }
    }
  }),
  ollama: adapter({
    nativeSurface: 'catalog-only',
    mcpAttachment: 'conditional',
    nativeMediation: 'not-applicable',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: NO_NATIVE_ACTIONS,
    nativeActionMappings: {}
  }),
  antigravity: adapter({
    nativeSurface: 'closed-native',
    mcpAttachment: 'route-dependent',
    nativeMediation: 'route-dependent',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: [
      'write_to_file',
      'replace_file_content',
      'create_file',
      'delete_file',
      'rename_file',
      'grep_search',
      'view_file',
      'read_file',
      'capability_search',
      'capability_invoke'
    ] as const,
    nativeActionMappings: {
      write_to_file: {
        aliases: ['write_to_file'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      replace_file_content: {
        aliases: ['replace_file_content'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      create_file: {
        aliases: ['create_file'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      delete_file: {
        aliases: ['delete_file'],
        catalogTool: 'delete_path',
        action: 'workspace.mutate'
      },
      rename_file: {
        aliases: ['rename_file'],
        catalogTool: 'rename_path',
        action: 'workspace.mutate'
      },
      grep_search: {
        aliases: ['grep_search'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      },
      view_file: {
        aliases: ['view_file'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      read_file: {
        aliases: ['read_file'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      capability_search: {
        aliases: ['capability_search'],
        catalogTool: 'capability_search',
        action: 'control.read'
      },
      capability_invoke: {
        aliases: ['capability_invoke'],
        catalogTool: 'capability_invoke',
        action: 'control.mutate'
      }
    }
  }),
  pi: adapter({
    nativeSurface: 'unobservable-native',
    mcpAttachment: 'none',
    nativeMediation: 'provider-runtime-containment',
    structuredKindMappings: {},
    declaredDeniedNativeActions: ['write', 'edit', 'shell'] as const,
    deniedNativeActionMappings: {
      write: {
        aliases: ['write'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['edit'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      shell: {
        aliases: ['bash'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      }
    },
    declaredNativeActions: ['read', 'list', 'find', 'search'] as const,
    nativeActionMappings: {
      read: {
        aliases: ['read'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      list: {
        aliases: ['ls'],
        catalogTool: 'list_directory',
        action: 'workspace.read'
      },
      find: {
        aliases: ['find'],
        catalogTool: 'find_files',
        action: 'workspace.search'
      },
      search: {
        aliases: ['grep'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      }
    }
  }),
  mistral: adapter({
    nativeSurface: 'closed-native',
    mcpAttachment: 'conditional',
    nativeMediation: 'taskwraith-preflight-and-approval',
    structuredKindMappings: {
      read: ['read', 'list'],
      edit: ['write', 'edit', 'patch', 'create-directory'],
      delete: 'delete',
      move: ['move', 'rename'],
      search: ['find', 'search', 'web-search'],
      execute: 'shell',
      fetch: 'web-fetch'
    },
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: [
      'read',
      'list',
      'find',
      'search',
      'write',
      'edit',
      'patch',
      'create-directory',
      'delete',
      'move',
      'rename',
      'shell',
      'web-search',
      'web-fetch'
    ] as const,
    nativeActionMappings: {
      read: {
        aliases: ['Read', 'Read file', 'read_file', 'Open file'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      list: {
        aliases: ['LS', 'List directory', 'list_directory'],
        catalogTool: 'list_directory',
        action: 'workspace.read'
      },
      find: {
        aliases: ['Glob', 'Find files'],
        catalogTool: 'find_files',
        action: 'workspace.search'
      },
      search: {
        aliases: ['Grep', 'Search workspace'],
        catalogTool: 'workspace_search',
        action: 'workspace.search'
      },
      write: {
        aliases: ['Write', 'Write file', 'Create file'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['Edit', 'Edit file', 'Replace', 'search_replace'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      patch: {
        aliases: ['apply_patch', 'Apply patch', 'Patch'],
        catalogTool: 'apply_patch',
        action: 'workspace.mutate'
      },
      'create-directory': {
        aliases: ['Create directory', 'Mkdir'],
        catalogTool: 'create_directory',
        action: 'workspace.mutate'
      },
      delete: {
        aliases: ['Delete', 'Delete file', 'Delete path', 'Remove'],
        catalogTool: 'delete_path',
        action: 'workspace.mutate'
      },
      move: {
        aliases: ['Move', 'Move file', 'Move path'],
        catalogTool: 'move_path',
        action: 'workspace.mutate'
      },
      rename: {
        aliases: ['Rename', 'Rename file', 'Rename path'],
        catalogTool: 'rename_path',
        action: 'workspace.mutate'
      },
      shell: {
        aliases: ['Bash', 'Shell', 'run_terminal_command', 'Run terminal command'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      'web-search': {
        aliases: ['WebSearch', 'web_search', 'Search web'],
        catalogTool: 'web_search',
        action: 'network.read'
      },
      'web-fetch': {
        aliases: ['Fetch', 'WebFetch', 'web_fetch'],
        catalogTool: 'web_fetch',
        action: 'network.read'
      }
    }
  }),
  muse: adapter({
    // Muse exec --json: native tools are projected into ActivityStack from
    // durable session.jsonl (observed-native), still not TW-mediated — argv +
    // isolated-home + sandbox containment remain the execution boundary.
    // No TaskWraith MCP broker in v1 (COORDINATION / wave1-F).
    nativeSurface: 'observed-native',
    mcpAttachment: 'none',
    nativeMediation: 'provider-runtime-containment',
    structuredKindMappings: {},
    declaredDeniedNativeActions: NO_NATIVE_ACTIONS,
    deniedNativeActionMappings: {},
    declaredNativeActions: [
      'read',
      'write',
      'edit',
      'patch',
      'delete',
      'shell',
      'web-search',
      'web-fetch'
    ] as const,
    nativeActionMappings: {
      read: {
        aliases: ['read_file', 'Read', 'Read file'],
        catalogTool: 'read_file',
        action: 'workspace.read'
      },
      write: {
        aliases: ['write_file', 'Write', 'Write file'],
        catalogTool: 'write_file',
        action: 'workspace.mutate'
      },
      edit: {
        aliases: ['edit_file'],
        catalogTool: 'replace',
        action: 'workspace.mutate'
      },
      patch: {
        aliases: ['apply_patch'],
        catalogTool: 'apply_patch',
        action: 'workspace.mutate'
      },
      delete: {
        aliases: ['delete_file'],
        catalogTool: 'delete_path',
        action: 'workspace.mutate'
      },
      shell: {
        aliases: ['bash', 'exec_command', 'Bash', 'shell', 'Shell'],
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      },
      'web-search': {
        aliases: ['web_search', 'WebSearch', 'Search web'],
        catalogTool: 'web_search',
        action: 'network.read'
      },
      'web-fetch': {
        aliases: ['web_fetch', 'WebFetch', 'Fetch'],
        catalogTool: 'web_fetch',
        action: 'network.read'
      }
    }
  })
} as const satisfies Record<ProviderId, ProviderActionAdapterDeclaration>

/**
 * Closed-world metadata for every advertised TaskWraith action.
 *
 * There is deliberately no classifier fallback here. Adding a catalog tool
 * without its class, service, operation, dispatcher owner, mutation scope, and
 * lock semantics fails TypeScript at this declaration.
 */
export const TASKWRAITH_TOOL_ACTIONS = {
  run_shell_command: tool(
    'workspace_write',
    'shellCommands',
    'shell.execute',
    'workspace-tools',
    'runtime',
    'workspace-runtime'
  ),
  write_file: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  replace: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  create_directory: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  delete_path: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  move_path: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  rename_path: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  read_file: tool(
    'workspace_read',
    'mcpTools',
    'workspace.read',
    'workspace-tools',
    'none',
    'none'
  ),
  list_directory: tool(
    'workspace_read',
    'mcpTools',
    'workspace.read',
    'workspace-tools',
    'none',
    'none'
  ),
  find_files: tool(
    'workspace_read',
    'mcpTools',
    'workspace.search',
    'workspace-tools',
    'none',
    'none'
  ),
  workspace_search: tool(
    'workspace_read',
    'mcpTools',
    'workspace.search',
    'workspace-tools',
    'none',
    'none'
  ),
  web_search: tool('web_read', 'mcpTools', 'network.read', 'web-tools', 'none', 'none'),
  web_fetch: tool('web_read', 'mcpTools', 'network.read', 'web-tools', 'none', 'none'),
  apply_patch: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'workspace-tools',
    'workspace',
    'workspace-paths'
  ),
  git_status: tool('workspace_read', 'mcpTools', 'workspace.read', 'git-tools', 'none', 'none'),
  git_diff: tool('workspace_read', 'mcpTools', 'workspace.read', 'git-tools', 'none', 'none'),
  git_log: tool('workspace_read', 'mcpTools', 'workspace.read', 'git-tools', 'none', 'none'),
  git_show: tool('workspace_read', 'mcpTools', 'workspace.read', 'git-tools', 'none', 'none'),
  git_blame: tool('workspace_read', 'mcpTools', 'workspace.read', 'git-tools', 'none', 'none'),
  git_stage: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'git-tools',
    'workspace',
    'workspace-repository'
  ),
  git_commit: tool(
    'workspace_write',
    'fileChanges',
    'workspace.mutate',
    'git-tools',
    'workspace',
    'workspace-repository'
  ),
  git_push: tool(
    'workspace_write',
    'externalPublish',
    'external.mutate',
    'git-tools',
    'external-state',
    'external-resource'
  ),
  git_create_pr: tool(
    'workspace_write',
    'externalPublish',
    'external.mutate',
    'git-tools',
    'external-state',
    'external-resource'
  ),
  github_ci_status: tool('web_read', 'mcpTools', 'network.read', 'github-tools', 'none', 'none'),
  run_task: tool(
    'workspace_write',
    'shellCommands',
    'shell.execute',
    'process-tools',
    'runtime',
    'workspace-runtime'
  ),
  start_background_process: tool(
    'workspace_write',
    'shellCommands',
    'shell.execute',
    'process-tools',
    'runtime',
    'workspace-runtime'
  ),
  list_background_processes: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'process-tools',
    'none',
    'none'
  ),
  read_background_process: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'process-tools',
    'none',
    'none'
  ),
  kill_background_process: tool(
    'workspace_write',
    'shellCommands',
    'control.mutate',
    'process-tools',
    'runtime',
    'host-resource'
  ),
  get_diagnostics: tool(
    'workspace_write',
    'shellCommands',
    'workspace.read',
    'workspace-tools',
    'runtime',
    'workspace-runtime'
  ),
  list_active_runs: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'run-control',
    'none',
    'none'
  ),
  cancel_active_run: tool(
    'workspace_write',
    'mcpTools',
    'control.mutate',
    'run-control',
    'host-state',
    'host-resource'
  ),
  list_chat_attachments: tool(
    'workspace_read',
    'mcpTools',
    'workspace.read',
    'attachment-tools',
    'none',
    'none'
  ),
  inspect_chat_attachment: tool(
    'workspace_read',
    'mcpTools',
    'workspace.read',
    'attachment-tools',
    'none',
    'none'
  ),
  workspace_board_snapshot: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'workspace-board',
    'none',
    'none'
  ),
  workspace_board_preview_plan: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'workspace-board',
    'none',
    'none'
  ),
  workspace_board_apply_plan: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'workspace-board',
    'host-state',
    'host-resource'
  ),
  outlook_list_messages: tool(
    'web_read',
    'mcpTools',
    'network.read',
    'outlook-connector',
    'none',
    'none'
  ),
  outlook_search_messages: tool(
    'web_read',
    'mcpTools',
    'network.read',
    'outlook-connector',
    'none',
    'none'
  ),
  outlook_get_message: tool(
    'web_read',
    'mcpTools',
    'network.read',
    'outlook-connector',
    'none',
    'none'
  ),
  outlook_list_events: tool(
    'web_read',
    'mcpTools',
    'network.read',
    'outlook-connector',
    'none',
    'none'
  ),
  outlook_create_draft: tool(
    'workspace_write',
    'mcpTools',
    'external.mutate',
    'outlook-connector',
    'external-state',
    'external-resource'
  ),
  outlook_create_event: tool(
    'workspace_write',
    'mcpTools',
    'external.mutate',
    'outlook-connector',
    'external-state',
    'external-resource'
  ),
  project_reference_propose: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'project-reference',
    'host-state',
    'host-resource'
  ),
  project_reference_list: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'project-reference',
    'host-state',
    'host-resource'
  ),
  test_result_summary: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'evidence-tools',
    'none',
    'none'
  ),
  prompt_task_normalize: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'evidence-tools',
    'none',
    'none'
  ),
  scope_radar: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'evidence-tools',
    'host-state',
    'host-resource'
  ),
  repo_convention_scan: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'evidence-tools',
    'host-state',
    'host-resource'
  ),
  coherence_gate_check: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'evidence-tools',
    'none',
    'none'
  ),
  evidence_pack_write: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'evidence-tools',
    'host-state',
    'host-resource'
  ),
  completion_claim_check: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'evidence-tools',
    'none',
    'none'
  ),
  list_subthreads: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'subthread-control',
    'none',
    'none'
  ),
  read_subthread_result: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'subthread-control',
    'none',
    'none'
  ),
  cancel_subthread: tool(
    'orchestration',
    'subThreadDelegation',
    'control.mutate',
    'subthread-control',
    'host-state',
    'host-resource'
  ),
  claim_fleet_wave: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'subthread-control',
    'host-state',
    'host-resource'
  ),
  workspace_symbols: tool(
    'workspace_read',
    'mcpTools',
    'workspace.search',
    'workspace-tools',
    'none',
    'none'
  ),
  browser_open: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'browser-tools',
    'attached-application',
    'application-resource',
    'url-argument'
  ),
  browser_click: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'browser-tools',
    'attached-application',
    'application-resource'
  ),
  browser_screenshot: tool(
    'workspace_write',
    'mcpTools',
    'application.read',
    'browser-tools',
    'host-state',
    'application-resource'
  ),
  browser_console: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'browser-tools',
    'none',
    'none'
  ),
  attached_window_capture: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'window-capture',
    'host-state',
    'application-resource'
  ),
  attached_window_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'window-capture',
    'none',
    'none'
  ),
  appwatch_start: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'appwatch',
    'host-state',
    'application-resource'
  ),
  appwatch_stop: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'appwatch',
    'host-state',
    'application-resource'
  ),
  appwatch_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'appwatch',
    'none',
    'none'
  ),
  appwatch_latest_frame: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'appwatch',
    'host-state',
    'application-resource'
  ),
  appwatch_frames: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'appwatch',
    'host-state',
    'application-resource'
  ),
  appshots: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'appshots',
    'host-state',
    'application-resource'
  ),
  appshots_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'appshots',
    'none',
    'none'
  ),
  approval_status: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'provider-status',
    'none',
    'none'
  ),
  provider_auth_status: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'provider-status',
    'none',
    'none'
  ),
  provider_usage_status: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'provider-status',
    'none',
    'none'
  ),
  run_timeline: tool('orchestration', 'mcpTools', 'control.read', 'run-control', 'none', 'none'),
  raw_provider_events: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'run-control',
    'none',
    'none'
  ),
  // `orchestration`, NOT `workspace_write` (user decision 2026-07-30). Opening a
  // file is a focus-change, not a state mutation — the same reasoning already
  // recorded for open_in_ide in McpAutoAllowedTools. Its three siblings
  // (open_in_ide, open_in_ide_at_position, reveal_in_finder) carry an identical
  // operation/mutation/lock triple and are all `orchestration`, so classifying
  // this one as a write made it the sole member of the read-only deny set with
  // no behavioural difference to justify it — read-only and recon seats were
  // denied opening a file in the editor while being allowed to open one in an
  // IDE. `dispatchOwner` stays `workspace-tools`: routing is a separate axis
  // from the permission class.
  open_workspace_file: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'workspace-tools',
    'attached-application',
    'application-resource'
  ),
  creative_app_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_app_capabilities: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_project_snapshot: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_timeline_validate: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_timeline_ir: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_timeline_diff: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'creative-app',
    'none',
    'none'
  ),
  creative_timeline_import: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'creative-app',
    'attached-application',
    'application-resource'
  ),
  creative_applescript_dispatch: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'creative-app',
    'attached-application',
    'application-resource'
  ),
  creative_blender_python: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'creative-app',
    'runtime',
    'application-resource'
  ),
  creative_midi_dispatch: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'creative-app',
    'attached-application',
    'application-resource'
  ),
  open_in_ide: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'ide-tools',
    'attached-application',
    'application-resource'
  ),
  open_in_ide_at_position: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'ide-tools',
    'attached-application',
    'application-resource'
  ),
  reveal_in_finder: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'ide-tools',
    'attached-application',
    'application-resource'
  ),
  ide_app_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'ide-tools',
    'none',
    'none'
  ),
  ide_app_capabilities: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'ide-tools',
    'none',
    'none'
  ),
  list_running_ides: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'ide-tools',
    'none',
    'none'
  ),
  create_handoff_card: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  switch_auth_profile: tool(
    'workspace_write',
    'mcpTools',
    'control.mutate',
    'provider-status',
    'host-state',
    'host-resource'
  ),
  agent_delegation_role: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_yield: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_send: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_fanout: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_fanout_all: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_await: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'ensemble-control',
    'none',
    'none'
  ),
  ensemble_lane_result: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'ensemble-control',
    'none',
    'none'
  ),
  thread_message: tool(
    'orchestration',
    'threadMessage',
    'control.mutate',
    'ensemble-control',
    'external-state',
    'external-resource'
  ),
  ensemble_control: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_bossman_control: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_poll_response: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_propose_goal_complete: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_roster_edit: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  ensemble_brief_update: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  list_ensemble_participants: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'ensemble-control',
    'none',
    'none'
  ),
  schedule_wakeup: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'scheduler',
    'host-state',
    'host-resource'
  ),
  cancel_wakeup: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'scheduler',
    'host-state',
    'host-resource'
  ),
  capability_search: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'capability-gateway',
    'none',
    'none'
  ),
  capability_invoke: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'capability-gateway',
    'none',
    'none'
  ),
  ask_user_question: tool(
    'ui_elicitation',
    'mcpTools',
    'user.elicit',
    'user-question',
    'host-state',
    'host-resource'
  ),
  request_tool_permission: tool(
    'ui_elicitation',
    'mcpTools',
    'user.elicit',
    'user-question',
    'host-state',
    'host-resource'
  ),
  goal_read: tool('orchestration', 'mcpTools', 'control.read', 'goal-control', 'none', 'none'),
  goal_update: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'goal-control',
    'host-state',
    'host-resource'
  ),
  update_goal: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'goal-control',
    'host-state',
    'host-resource'
  ),
  goal_complete: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'goal-control',
    'host-state',
    'host-resource'
  ),
  goal_blocked: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'goal-control',
    'host-state',
    'host-resource'
  ),
  todo_write: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'goal-control',
    'host-state',
    'host-resource'
  ),
  // Orchestration (not workspace_write): Ask/Plan seats are readOnly:true and
  // isReadOnlyBlockedTool hard-denies workspace_write before the dedicated
  // subThreadDelegation modal can fire. The spawn itself does not mutate the
  // parent workspace; child writes are capped by SubThreadPermissions.
  delegate_to_subthread: tool(
    'orchestration',
    'subThreadDelegation',
    'control.mutate',
    'subthread-control',
    'host-state',
    'host-resource'
  ),
  // Batch spawn-only wave: same service/gate family as delegate_to_subthread.
  // Not auto-allowed; one approval card covers the whole wave when required.
  delegate_wave: tool(
    'orchestration',
    'subThreadDelegation',
    'control.mutate',
    'subthread-control',
    'host-state',
    'host-resource'
  ),
  ultra_task: tool(
    'orchestration',
    'subThreadDelegation',
    'control.mutate',
    'subthread-control',
    'host-state',
    'host-resource'
  ),
  scout_brief: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'ensemble-control',
    'host-state',
    'host-resource'
  ),
  blackboard_post: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'blackboard',
    'host-state',
    'host-resource'
  ),
  blackboard_read: tool('orchestration', 'mcpTools', 'control.read', 'blackboard', 'none', 'none'),
  blackboard_delete: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'blackboard',
    'host-state',
    'host-resource'
  ),
  launch_list_targets: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'launch-control',
    'none',
    'none'
  ),
  launch_start: tool(
    'workspace_write',
    'shellCommands',
    'shell.execute',
    'launch-control',
    'runtime',
    'workspace-runtime'
  ),
  launch_adopt: tool(
    'workspace_write',
    'shellCommands',
    'control.mutate',
    'launch-control',
    'runtime',
    'host-resource'
  ),
  launch_stop: tool(
    'workspace_write',
    'shellCommands',
    'control.mutate',
    'launch-control',
    'runtime',
    'host-resource'
  ),
  launch_status: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'launch-control',
    'none',
    'none'
  ),
  canvas_open: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource',
    'url-argument'
  ),
  canvas_render_html: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  // Dock chart render: orchestration (not workspace_write) so the read-only
  // mcpTools→shellCommands remapping never fires. Service stays mcpTools —
  // Ask/Plan already resolve mcpTools to per-invocation ASK (grant-held);
  // Accept Edits / Full WS / Full Access follow normal mcpTools allow.
  canvas_render_chart: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  canvas_open_attachment: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_open_launch: tool(
    'workspace_write',
    'mcpTools',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_sketch_open: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'canvas',
    'none',
    'none'
  ),
  canvas_sketch_get: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'canvas',
    'none',
    'none'
  ),
  canvas_sketch_update: tool(
    'workspace_write',
    'sketchCanvas',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  canvas_list: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_status: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_drive_report: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'canvas',
    'none',
    'none'
  ),
  canvas_drive_verify: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'canvas',
    'none',
    'none'
  ),
  canvas_snapshot: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_screenshot: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'canvas',
    'host-state',
    'application-resource'
  ),
  canvas_inspect: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_network: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_console: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_resize: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  canvas_click: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_fill: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_key: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_scroll: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_hover: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_select: tool(
    'workspace_write',
    'canvasInteraction',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  canvas_wait_for: tool('orchestration', 'mcpTools', 'application.read', 'canvas', 'none', 'none'),
  canvas_annotate: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  canvas_eval: tool(
    'workspace_write',
    'canvasEval',
    'application.mutate',
    'canvas',
    'attached-application',
    'application-resource'
  ),
  // Browser navigation rides its DEDICATED webBrowsing service (never the
  // generic mcpTools) so the read-only gate's mcpTools→shellCommands reroute
  // cannot fire: Recon/Plan resolve it straight to the preset's per-invocation
  // ASK. Orchestration class like canvas_resize — it retargets the preview
  // surface but mutates no workspace state; egress follows the url argument.
  canvas_navigate: tool(
    'orchestration',
    'webBrowsing',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource',
    'url-argument'
  ),
  canvas_close: tool(
    'orchestration',
    'mcpTools',
    'application.mutate',
    'canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_create: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_list: tool(
    'orchestration',
    'meshCanvas',
    'application.read',
    'mesh-canvas',
    'none',
    'none'
  ),
  mesh_scene_inspect: tool(
    'orchestration',
    'meshCanvas',
    'application.read',
    'mesh-canvas',
    'none',
    'none'
  ),
  mesh_scene_import: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_apply: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_set_material: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_present: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_close: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_scene_delete: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_topology_convert: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  mesh_topology_inspect: tool(
    'orchestration',
    'meshCanvas',
    'application.read',
    'mesh-canvas',
    'none',
    'none'
  ),
  mesh_topology_edit: tool(
    'workspace_write',
    'meshCanvas',
    'application.mutate',
    'mesh-canvas',
    'host-state',
    'application-resource'
  ),
  // Simulator Canvas — status is a safe capability probe (auto-allowed). The
  // mutating verbs stay orchestration-class so Ask/Plan seats are not
  // read-only-floor denied before the simulatorCanvas modal; they still never
  // auto-run.
  simulator_status: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'simulator-canvas',
    'none',
    'none'
  ),
  simulator_open: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_boot: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_install: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_launch: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_screenshot: tool(
    'orchestration',
    'simulatorCanvas',
    'application.read',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_terminate: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  // AX dump is observation-only (truncated tree); auto-allowed like status.
  simulator_inspect: tool(
    'orchestration',
    'mcpTools',
    'application.read',
    'simulator-canvas',
    'none',
    'none'
  ),
  simulator_button: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_rotate: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_tap: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_type: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  simulator_scroll: tool(
    'orchestration',
    'simulatorCanvas',
    'application.mutate',
    'simulator-canvas',
    'host-state',
    'application-resource'
  ),
  theme_tokens_get: tool(
    'workspace_read',
    'mcpTools',
    'control.read',
    'theme-control',
    'none',
    'none'
  ),
  theme_tokens_set: tool(
    'workspace_write',
    'mcpTools',
    'control.mutate',
    'theme-control',
    'host-state',
    'host-resource'
  ),
  tw_recall_find: tool(
    'orchestration',
    'crossThreadRead',
    'control.read',
    'cross-thread-recall',
    'none',
    'none'
  ),
  tw_recall_read: tool(
    'orchestration',
    'crossThreadRead',
    'control.read',
    'cross-thread-recall',
    'none',
    'none'
  ),
  tw_recall_read_events: tool(
    'orchestration',
    'crossThreadRead',
    'control.read',
    'cross-thread-recall',
    'none',
    'none'
  ),
  tw_introspection_run: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'introspection',
    'host-state',
    'host-resource'
  ),
  tw_introspection_list: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'introspection',
    'none',
    'none'
  ),
  tw_introspection_read: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'introspection',
    'none',
    'none'
  ),
  tw_introspection_review: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'introspection',
    'host-state',
    'host-resource'
  ),
  skill_list: tool('orchestration', 'mcpTools', 'control.read', 'skills', 'none', 'none'),
  skill_read: tool('orchestration', 'mcpTools', 'control.read', 'skills', 'none', 'none'),
  image_view: tool('workspace_read', 'mcpTools', 'media.read', 'image-tools', 'none', 'none'),
  image_edit: tool(
    'workspace_write',
    'mcpTools',
    'media.mutate',
    'image-tools',
    'host-state',
    'host-resource'
  ),
  svg_rasterize: tool(
    'workspace_write',
    'mcpTools',
    'media.mutate',
    'image-tools',
    'host-state',
    'host-resource'
  ),
  image_generate: tool(
    'workspace_write',
    'mcpTools',
    'media.mutate',
    'image-tools',
    'host-state',
    'host-resource',
    'always'
  ),
  audio_render_wav: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'audio-tools',
    'host-state',
    'host-resource'
  ),
  audio_analyze: tool(
    'workspace_write',
    'mediaEditing',
    'media.read',
    'audio-tools',
    'host-state',
    'host-resource'
  ),
  inspect_audio_segment: tool(
    'orchestration',
    'mediaEditing',
    'media.read',
    'audio-tools',
    'host-state',
    'host-resource'
  ),
  video_probe: tool(
    'workspace_write',
    'mediaEditing',
    'media.read',
    'ffmpeg-tools',
    'runtime',
    'workspace-runtime'
  ),
  video_thumbnail: tool(
    'workspace_write',
    'mediaEditing',
    'media.read',
    'ffmpeg-tools',
    'host-state',
    'host-resource'
  ),
  video_decode_frame: tool(
    'orchestration',
    'mediaEditing',
    'media.read',
    'native-media',
    'host-state',
    'host-resource'
  ),
  inspect_video_frames: tool(
    'orchestration',
    'mediaEditing',
    'media.read',
    'native-media',
    'host-state',
    'host-resource'
  ),
  video_encode_clip: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'native-media',
    'workspace',
    'workspace-paths'
  ),
  video_concat_clips: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'native-media',
    'workspace',
    'workspace-paths'
  ),
  audio_extract: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'ffmpeg-tools',
    'workspace',
    'workspace-paths'
  ),
  transcode_audio: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'ffmpeg-tools',
    'workspace',
    'workspace-paths'
  ),
  audio_mix: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'native-media',
    'workspace',
    'workspace-paths'
  ),
  transcribe_audio: tool(
    'orchestration',
    'mediaEditing',
    'media.read',
    'native-media',
    'none',
    'none'
  ),
  document_extract_text: tool(
    'orchestration',
    'mcpTools',
    'media.read',
    'document-tools',
    'none',
    'none'
  ),
  document_ocr_image: tool(
    'orchestration',
    'mcpTools',
    'media.read',
    'document-tools',
    'none',
    'none'
  ),
  transcode_video: tool(
    'workspace_write',
    'mediaEditing',
    'media.mutate',
    'ffmpeg-tools',
    'workspace',
    'workspace-paths'
  )
} as const satisfies Record<TaskWraithMcpToolName, CanonicalToolActionMetadata>

export const TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES = [
  'capability_search',
  'capability_invoke'
] as const

export type TaxonomyCapabilityGatewayToolName =
  (typeof TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES)[number]

export interface TargetDerivedGatewayActionMetadata {
  readonly resolution: 'target-derived'
  readonly toolClass: 'target-derived'
  readonly service: 'target-derived'
  readonly operation: 'target-derived'
  readonly dispatchOwner: 'capability-gateway'
  readonly mutation: 'target-derived'
  readonly lock: 'target-derived'
  readonly networkEgress: 'target-derived'
}

/**
 * `capability_invoke` is a transparent envelope: it has no independent grant,
 * mutation class, or lock. The resolved concrete target supplies all three.
 */
export const CAPABILITY_GATEWAY_ACTIONS = {
  capability_search: tool(
    'orchestration',
    'mcpTools',
    'control.read',
    'capability-gateway',
    'none',
    'none'
  ),
  capability_invoke: {
    resolution: 'target-derived',
    toolClass: 'target-derived',
    service: 'target-derived',
    operation: 'target-derived',
    dispatchOwner: 'capability-gateway',
    mutation: 'target-derived',
    lock: 'target-derived',
    networkEgress: 'target-derived'
  }
} as const satisfies Record<
  TaxonomyCapabilityGatewayToolName,
  CanonicalToolActionMetadata | TargetDerivedGatewayActionMetadata
>

export const TAXONOMY_AUDIT_MCP_TOOL_NAMES = [
  'audit_set_profile',
  'audit_record_finding',
  'audit_record_verdict'
] as const

export type TaxonomyAuditMcpToolName = (typeof TAXONOMY_AUDIT_MCP_TOOL_NAMES)[number]

export const AUDIT_MCP_TOOL_ACTIONS = {
  audit_set_profile: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'audit-tools',
    'host-state',
    'host-resource'
  ),
  audit_record_finding: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'audit-tools',
    'host-state',
    'host-resource'
  ),
  audit_record_verdict: tool(
    'orchestration',
    'mcpTools',
    'control.mutate',
    'audit-tools',
    'host-state',
    'host-resource'
  )
} as const satisfies Record<TaxonomyAuditMcpToolName, CanonicalToolActionMetadata>

export const TASKWRAITH_OWNED_MCP_ACTIONS = {
  ...TASKWRAITH_TOOL_ACTIONS,
  ...CAPABILITY_GATEWAY_ACTIONS,
  ...AUDIT_MCP_TOOL_ACTIONS
} as const

export type TaskWraithOwnedMcpToolName = keyof typeof TASKWRAITH_OWNED_MCP_ACTIONS

const TASKWRAITH_TOOL_NAME_SET: ReadonlySet<string> = new Set(TASKWRAITH_MCP_TOOLS)

export function isTaskWraithCatalogAction(value: string): value is TaskWraithMcpToolName {
  return TASKWRAITH_TOOL_NAME_SET.has(value)
}

export function compactProviderActionIdentifier(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

interface IndexedProviderNativeAction {
  readonly nativeAction: string
  readonly mapping: ProviderNativeActionMapping
}

function buildProviderNativeAliasIndex(
  provider: ProviderId,
  nativeActions: readonly string[],
  mappings: Readonly<Record<string, ProviderNativeActionMapping>>,
  disposition: 'active' | 'denied'
): ReadonlyMap<string, IndexedProviderNativeAction> {
  const index = new Map<string, IndexedProviderNativeAction>()
  for (const nativeAction of nativeActions) {
    const mapping = mappings[nativeAction]
    if (!mapping) {
      throw new TypeError(
        `Provider ${provider} declares ${disposition} native action ${nativeAction} without a mapping.`
      )
    }
    for (const alias of mapping.aliases) {
      const compact = compactProviderActionIdentifier(alias)
      if (!compact) {
        throw new TypeError(
          `Provider ${provider} native action ${nativeAction} has an empty alias.`
        )
      }
      const prior = index.get(compact)
      if (
        prior &&
        (prior.mapping.catalogTool !== mapping.catalogTool ||
          prior.mapping.action !== mapping.action)
      ) {
        throw new TypeError(
          `Provider ${provider} alias ${alias} maps to both ${prior.nativeAction} and ${nativeAction}.`
        )
      }
      index.set(compact, { nativeAction, mapping })
    }
  }
  return index
}

const PROVIDER_NATIVE_ALIAS_INDEX = Object.fromEntries(
  (Object.keys(PROVIDER_ACTION_ADAPTERS) as ProviderId[]).map((provider) => [
    provider,
    buildProviderNativeAliasIndex(
      provider,
      PROVIDER_ACTION_ADAPTERS[provider].declaredNativeActions,
      PROVIDER_ACTION_ADAPTERS[provider].nativeActionMappings,
      'active'
    )
  ])
) as Record<ProviderId, ReadonlyMap<string, IndexedProviderNativeAction>>

const PROVIDER_DENIED_NATIVE_ALIAS_INDEX = Object.fromEntries(
  (Object.keys(PROVIDER_ACTION_ADAPTERS) as ProviderId[]).map((provider) => [
    provider,
    buildProviderNativeAliasIndex(
      provider,
      PROVIDER_ACTION_ADAPTERS[provider].declaredDeniedNativeActions,
      PROVIDER_ACTION_ADAPTERS[provider].deniedNativeActionMappings,
      'denied'
    )
  ])
) as Record<ProviderId, ReadonlyMap<string, IndexedProviderNativeAction>>

type ProviderStructuredKindResolution =
  | { readonly applies: false }
  | {
      readonly applies: true
      readonly indexed: IndexedProviderNativeAction | null
    }

function structuredArgumentRecords(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const root = value as Record<string, unknown>
  const records = [root]
  for (const key of ['rawInput', 'input', 'parameters', 'arguments', 'args']) {
    const nested = root[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      records.push(nested as Record<string, unknown>)
    }
  }
  return records
}

function structuredShapeNativeAction(
  toolKind: ProviderStructuredToolKind,
  candidates: readonly string[],
  records: readonly Record<string, unknown>[]
): string | null {
  const hasAny = (keys: readonly string[]): boolean =>
    records.some((record) => keys.some((key) => record[key] !== undefined))
  const candidate = (nativeAction: string): string | null =>
    candidates.includes(nativeAction) ? nativeAction : null

  if (toolKind === 'edit') {
    if (hasAny(['patch', 'diff'])) return candidate('patch')
    if (hasAny(['old_string', 'new_string', 'oldString', 'newString'])) {
      return candidate('edit')
    }
    return candidate('write')
  }
  if (toolKind === 'read') {
    if (hasAny(['directory', 'dir'])) return candidate('list')
    return candidate('read')
  }
  if (toolKind === 'move') {
    if (hasAny(['newName', 'new_name', 'newFileName', 'new_file_name'])) {
      return candidate('rename')
    }
    return candidate('move')
  }
  if (toolKind === 'search') {
    if (hasAny(['glob', 'patternGlob', 'pattern_glob'])) return candidate('find')
    if (hasAny(['path', 'directory', 'dir', 'include', 'exclude'])) {
      return candidate('search')
    }
    return null
  }
  return candidates.length === 1 ? candidates[0] : null
}

function resolveProviderStructuredNativeKind(
  provider: ProviderId,
  context: ProviderNativeActionContext | undefined
): ProviderStructuredKindResolution {
  const declaration = PROVIDER_ACTION_ADAPTERS[provider]
  const declaredKinds = declaration.structuredKindMappings
  const rawToolKind =
    typeof context?.toolKind === 'string' ? context.toolKind.trim().toLowerCase() : ''
  if (Object.keys(declaredKinds).length === 0) return { applies: false }
  if (!rawToolKind) return { applies: true, indexed: null }
  if (!(PROVIDER_STRUCTURED_TOOL_KINDS as readonly string[]).includes(rawToolKind)) {
    return { applies: true, indexed: null }
  }
  const toolKind = rawToolKind as ProviderStructuredToolKind
  const disposition = declaredKinds[toolKind]
  if (!disposition) return { applies: true, indexed: null }
  const candidates = typeof disposition === 'string' ? [disposition] : disposition
  const records = structuredArgumentRecords(context?.rawToolCall)
  const hasAny = (keys: readonly string[]): boolean =>
    records.some((record) => keys.some((key) => record[key] !== undefined))
  const mutationShape = [
    'content',
    'streamContent',
    'patch',
    'diff',
    'old_string',
    'new_string',
    'oldString',
    'newString'
  ] as const
  const commandShape = ['command', 'cmd'] as const
  if (
    ((toolKind === 'read' || toolKind === 'search' || toolKind === 'fetch') &&
      hasAny(mutationShape)) ||
    (toolKind !== 'execute' && hasAny(commandShape)) ||
    (toolKind === 'execute' && hasAny(mutationShape))
  ) {
    return { applies: true, indexed: null }
  }
  const recognizedAliases: IndexedProviderNativeAction[] = []
  let stableIdentityCount = 0
  let hasUnknownStableIdentity = false
  for (const record of records) {
    for (const key of ['tool_name', 'toolName', 'name']) {
      const stableName = record[key]
      if (typeof stableName !== 'string' || !stableName.trim()) continue
      stableIdentityCount += 1
      const exact = PROVIDER_NATIVE_ALIAS_INDEX[provider].get(
        compactProviderActionIdentifier(stableName)
      )
      if (exact) {
        recognizedAliases.push(exact)
      } else {
        hasUnknownStableIdentity = true
      }
    }
  }
  if (stableIdentityCount > 0) {
    if (hasUnknownStableIdentity) return { applies: true, indexed: null }
    const nativeActions = new Set(recognizedAliases.map((entry) => entry.nativeAction))
    const exact = recognizedAliases[0]
    return nativeActions.size === 1 && candidates.includes(exact.nativeAction)
      ? { applies: true, indexed: exact }
      : { applies: true, indexed: null }
  }
  const nativeAction = structuredShapeNativeAction(toolKind, candidates, records)
  if (!nativeAction) return { applies: true, indexed: null }
  const mapping = declaration.nativeActionMappings[nativeAction]
  return mapping
    ? { applies: true, indexed: { nativeAction, mapping } }
    : { applies: true, indexed: null }
}

export type ProviderActionResolutionErrorCode =
  | 'unmapped_catalog_action'
  | 'gateway_target_required'
  | 'gateway_target_not_declared'
  | 'gateway_target_identity_conflict'
  | 'provider_identity_required'
  | 'mcp_attachment_unavailable'
  | 'native_action_not_declared'
  | 'native_surface_closed'
  | 'native_surface_unobservable'

export interface ResolvedProviderAction {
  readonly ok: true
  readonly provider: ProviderId | null
  readonly source: 'taskwraith-catalog' | 'provider-native'
  readonly rawAction: string
  readonly nativeAction: string | null
  readonly catalogTool: TaskWraithMcpToolName
  readonly action: CanonicalProviderAction
  readonly metadata: CanonicalToolActionMetadata
}

export interface UnmappedProviderAction {
  readonly ok: false
  readonly denied: true
  readonly provider: ProviderId | null
  readonly source: 'taskwraith-catalog' | 'provider-native'
  readonly rawAction: string
  readonly code: ProviderActionResolutionErrorCode
  readonly reason: string
}

export type StrictProviderActionResolution = ResolvedProviderAction | UnmappedProviderAction

function unmapped(
  provider: ProviderId | null,
  source: UnmappedProviderAction['source'],
  rawAction: string,
  code: ProviderActionResolutionErrorCode,
  reason: string
): UnmappedProviderAction {
  return { ok: false, denied: true, provider, source, rawAction, code, reason }
}

const STRICT_TASKWRAITH_MCP_SERVER_NAMES = new Set([
  'TaskWraith',
  'taskwraith',
  'taskwraith-broker',
  'taskwraith-grok',
  'taskwraith-mistral'
])

const STRICT_TASKWRAITH_FLAT_PREFIXES = [
  'TaskWraith__',
  'mcp_TaskWraith_',
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
] as const

/** True when the raw machine identity claims one of TaskWraith's MCP servers. */
export function claimsTaskWraithMcpNamespace(rawAction: string): boolean {
  const normalized = String(rawAction || '').trim()
  if (!normalized) return false
  if (normalized.startsWith('mcp__')) {
    const match = normalized.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/)
    return Boolean(match && STRICT_TASKWRAITH_MCP_SERVER_NAMES.has(match[1]))
  }
  return STRICT_TASKWRAITH_FLAT_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/** True for a provider-reported MCP machine identity, regardless of server owner. */
export function hasMcpToolNamespace(rawAction: string): boolean {
  const normalized = String(rawAction || '').trim()
  return /^mcp__[A-Za-z0-9_-]+__.+$/.test(normalized) || claimsTaskWraithMcpNamespace(normalized)
}

/**
 * How much spelling variance the TOOL half of an identity may carry. The two
 * modes answer different questions, so they cannot share one strictness:
 *
 * - `exact` (default) — PROVENANCE. The string is an untrusted provider report
 *   and the question is whether it CLAIMS TaskWraith broker authority. An ACP
 *   human title ("Ask User Question") or a display-cased echo ("READ_FILE") must
 *   NOT be readable as an authority claim, so only the declared spelling
 *   resolves. Pinned by providerActionTaxonomy.test.ts ('fails explicit catalog
 *   resolution instead of inventing generic policy') and relied on by
 *   NativeWorkspaceToolGate's broker-provenance split.
 * - `folded` — DISPATCH. The call already arrived on TaskWraith's own MCP
 *   transport under a declared server/prefix identity; the only open question
 *   is which declared tool it names. Providers echo the catalogue's snake_case
 *   names back in their own casing (`ASkUserQuestion`, `RUN_SHELL_COMMAND`),
 *   exactly as the pre-strict canonicalizer this resolver replaced
 *   (`canonicalTaskWraithToolName` in taskWraithMcpCatalog.ts) always tolerated.
 *   Dropping the fold rejected live mixed-case calls outright.
 */
type CatalogNamePresentation = 'exact' | 'folded'

function strictUnqualifiedCatalogCanonicalName(
  value: string,
  presentation: CatalogNamePresentation = 'exact'
): string | null {
  const trimmed = String(value || '').trim()
  // Fold BEFORE the double-namespace guard, never after: folding first keeps
  // `MCP_TaskWraith_...` / `TASKWRAITH_BROKER_...` caught as double-namespaced
  // instead of walking past a case-sensitive startsWith into the lookup.
  //
  // Folding cannot widen the accepted tool SET, only its accepted SPELLING:
  // every key of TASKWRAITH_OWNED_MCP_ACTIONS is already lowercase and no two
  // keys collide when lowercased, so the fold is 1:1 onto the same catalogue.
  const normalized = presentation === 'folded' ? trimmed.toLowerCase() : trimmed
  if (!normalized || normalized.startsWith('mcp_') || normalized.startsWith('taskwraith')) {
    return null
  }
  // AskUserQuestion is the other alias the pre-strict canonicalizer carried:
  // Claude and Ollama emit the tool under its provider-facing CamelCase
  // spelling (plus `Ask_User_Question` / `ask-user-question` variants) while
  // the executor is registered as `ask_user_question`. The separator-stripping
  // comparison is copied from `canonicalTaskWraithToolName` so the two
  // resolvers cannot drift. It is presentation-gated because a bare human title
  // is precisely what the provenance caller must keep rejecting.
  if (presentation === 'folded' && normalized.replace(/[\s_-]+/g, '') === 'askuserquestion') {
    return 'ask_user_question'
  }
  // Aliases resolve BEFORE the ownership check. `ensemble_control` is the
  // provider-portable invocation shape for the `ensemble_bossman_control`
  // authority primitive, and it is a declared member of
  // TASKWRAITH_OWNED_MCP_ACTIONS so it can be advertised and audited in its own
  // right. That membership satisfied the hasOwnProperty branch first and
  // returned the ALIAS, leaving the mapping below as dead code — so dispatch
  // looked for a branch named `ensemble_control`, of which there is none (the
  // executor is registered as `ensemble_bossman_control`). The MCP dispatcher
  // has no terminal else, so a missing branch is a SILENT EMPTY SUCCESS rather
  // than an error: every portable ensemble_control call would have reported
  // success while doing nothing. Caught by McpDispatcherExhaustiveness and
  // PortableEnsembleControl.
  //
  // This function must return the name the EXECUTOR is registered under. The
  // outward/advertised name is a separate concern, resolved through
  // `advertisedToolName` in McpBridgeRuntime, so the profile-fenced advertise
  // split (fresh profile shows ensemble_control, legacy shows
  // ensemble_bossman_control) is unaffected. Keep this in agreement with
  // `canonicalTaskWraithToolName` in taskWraithMcpCatalog.ts, which already
  // maps the same alias the same way.
  if (normalized === 'ensemble_control') return 'ensemble_bossman_control'
  if (Object.prototype.hasOwnProperty.call(TASKWRAITH_OWNED_MCP_ACTIONS, normalized)) {
    return normalized
  }
  return null
}

/**
 * Execution-only namespace parser. The shared display canonicalizer accepts a
 * generic `mcp__<server>__<tool>` shape for historical transcripts; dispatch
 * authority accepts only TaskWraith's exact declared server identifiers.
 *
 * `presentation` reaches the TOOL half ONLY. The server name and the flat
 * prefixes below stay case-EXACT in both modes because that half is the
 * OWNERSHIP CLAIM ("this is TaskWraith's MCP server"), not a tool name — the
 * declared sets already enumerate every casing real transports emit
 * (`TaskWraith` and `taskwraith`, `TaskWraith__` and `mcp_TaskWraith_`), and
 * folding them would let an undeclared `mcp__TASKWRAITH-BROKER__…` spelling
 * claim broker identity.
 */
function strictTaskWraithCatalogCanonicalName(
  rawAction: string,
  presentation: CatalogNamePresentation = 'exact'
): string | null {
  const normalized = String(rawAction || '').trim()
  if (!normalized) return null

  if (normalized.startsWith('mcp__')) {
    const match = normalized.match(/^mcp__([A-Za-z0-9_-]+)__(.+)$/)
    if (!match || !STRICT_TASKWRAITH_MCP_SERVER_NAMES.has(match[1])) return null
    return strictUnqualifiedCatalogCanonicalName(match[2], presentation)
  }

  for (const prefix of STRICT_TASKWRAITH_FLAT_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      const unqualified = normalized.slice(prefix.length)
      return strictUnqualifiedCatalogCanonicalName(unqualified, presentation)
    }
  }

  if (
    normalized.startsWith('mcp_') ||
    normalized.startsWith('taskwraith-') ||
    normalized.startsWith('taskwraith_')
  ) {
    return null
  }
  return strictUnqualifiedCatalogCanonicalName(normalized, presentation)
}

/**
 * Strict TaskWraith catalog resolver for dispatch/preflight boundaries.
 * Unknown names are data, not an exception and never a generic-policy success:
 * callers receive a typed deny that can be audited or returned to the provider.
 */
export function resolveCatalogActionStrict(rawAction: string): StrictProviderActionResolution {
  const canonical = strictTaskWraithCatalogCanonicalName(rawAction)
  if (!canonical || !isTaskWraithCatalogAction(canonical)) {
    return unmapped(
      null,
      'taskwraith-catalog',
      rawAction,
      'unmapped_catalog_action',
      `TaskWraith action "${rawAction}" has no declared catalog metadata or dispatcher owner.`
    )
  }
  const metadata = TASKWRAITH_TOOL_ACTIONS[canonical]
  return {
    ok: true,
    provider: null,
    source: 'taskwraith-catalog',
    rawAction,
    nativeAction: null,
    catalogTool: canonical,
    action: metadata.operation,
    metadata
  }
}

/**
 * Provider-local alias lookup for telemetry/display only. This intentionally
 * includes unobservable native surfaces: historical transcripts still need a
 * stable label even when that surface cannot be used as execution authority.
 */
export function resolveProviderNativeActionForDisplay(
  provider: ProviderId,
  rawAction: string
): ResolvedProviderAction | null {
  const compact = compactProviderActionIdentifier(rawAction)
  const indexed =
    PROVIDER_NATIVE_ALIAS_INDEX[provider].get(compact) ||
    PROVIDER_DENIED_NATIVE_ALIAS_INDEX[provider].get(compact)
  if (!indexed) return null
  return {
    ok: true,
    provider,
    source: 'provider-native',
    rawAction,
    nativeAction: indexed.nativeAction,
    catalogTool: indexed.mapping.catalogTool,
    action: indexed.mapping.action,
    metadata: TASKWRAITH_TOOL_ACTIONS[indexed.mapping.catalogTool]
  }
}

/**
 * Strict provider-native resolver for execution/preflight. A mapped alias is
 * not itself authority: catalog-only and unobservable surfaces are explicit
 * denies. Only a `closed-native` adapter may proceed to path/sandbox/approval
 * checks.
 */
export function resolveProviderNativeActionStrict(
  provider: ProviderId,
  rawAction: string,
  context?: ProviderNativeActionContext
): StrictProviderActionResolution {
  const declaration = PROVIDER_ACTION_ADAPTERS[provider]
  const structured = resolveProviderStructuredNativeKind(provider, context)
  const indexed = structured.applies
    ? structured.indexed
    : PROVIDER_NATIVE_ALIAS_INDEX[provider].get(compactProviderActionIdentifier(rawAction))
  if (!indexed) {
    return unmapped(
      provider,
      'provider-native',
      rawAction,
      declaration.nativeSurface === 'catalog-only'
        ? 'native_surface_closed'
        : 'native_action_not_declared',
      declaration.nativeSurface === 'catalog-only'
        ? `Provider ${provider} has a catalog-only action surface.`
        : `Provider ${provider} native action "${rawAction}" is not declared by its adapter.`
    )
  }
  if (declaration.nativeSurface === 'catalog-only') {
    return unmapped(
      provider,
      'provider-native',
      rawAction,
      'native_surface_closed',
      `Provider ${provider} has a catalog-only action surface.`
    )
  }
  if (declaration.nativeSurface === 'unobservable-native') {
    return unmapped(
      provider,
      'provider-native',
      rawAction,
      'native_surface_unobservable',
      `Provider ${provider} native action "${rawAction}" is display-observable but not a TaskWraith-mediated execution boundary.`
    )
  }
  if (declaration.nativeSurface === 'observed-native') {
    return unmapped(
      provider,
      'provider-native',
      rawAction,
      'native_surface_unobservable',
      `Provider ${provider} native action "${rawAction}" is session-log projected for display but not a TaskWraith-mediated execution boundary.`
    )
  }
  return {
    ok: true,
    provider,
    source: 'provider-native',
    rawAction,
    nativeAction: indexed.nativeAction,
    catalogTool: indexed.mapping.catalogTool,
    action: indexed.mapping.action,
    metadata: TASKWRAITH_TOOL_ACTIONS[indexed.mapping.catalogTool]
  }
}

/**
 * Combined strict resolver for callers that genuinely accept either a catalog
 * call or an adapter-native action. Catalog membership is checked first; a
 * namespaced unknown then falls through to the provider-local closed surface.
 */
export function resolveProviderActionStrict(
  provider: ProviderId,
  rawAction: string
): StrictProviderActionResolution {
  const catalog = resolveCatalogActionStrict(rawAction)
  if (!catalog.ok) return resolveProviderNativeActionStrict(provider, rawAction)
  if (PROVIDER_ACTION_ADAPTERS[provider].mcpAttachment === 'none') {
    return unmapped(
      provider,
      'taskwraith-catalog',
      rawAction,
      'mcp_attachment_unavailable',
      `Provider ${provider} has no generic TaskWraith MCP attachment surface.`
    )
  }
  return { ...catalog, provider }
}

export interface ResolvedToolDispatchContract {
  readonly ok: true
  readonly toolName: TaskWraithOwnedMcpToolName
  readonly effectiveToolName: Exclude<TaskWraithOwnedMcpToolName, 'capability_invoke'>
  readonly resolution: 'fixed' | 'target-derived'
  readonly toolClass: CanonicalToolClass
  readonly action: CanonicalProviderAction
  readonly dispatchOwner: CanonicalDispatchOwner
  readonly gatewayDispatchOwner?: 'capability-gateway'
  readonly service: AgenticServiceId
  readonly mutation: CanonicalMutationScope
  readonly lock: CanonicalLockSemantics
  readonly networkEgress: CanonicalNetworkEgress
}

export type StrictToolDispatchContract = ResolvedToolDispatchContract | UnmappedProviderAction

/**
 * Arg-dependent agentic-service resolution for catalog tools.
 *
 * Fixed taxonomy rows stay the default; today only `canvas_open` with
 * `driver: 'device'` elevates to `simulatorCanvas` so simctl mutations cannot
 * ride a bare `mcpTools` allow when Simulator Canvas is deny/ask-demoted.
 */
export function resolveCatalogToolAgenticService(
  toolName: TaskWraithMcpToolName,
  args?: unknown
): AgenticServiceId {
  const base = TASKWRAITH_TOOL_ACTIONS[toolName].service
  if (toolName === 'canvas_open' && isCanvasOpenDeviceDriverArgs(args)) {
    return 'simulatorCanvas'
  }
  return base
}

function isCanvasOpenDeviceDriverArgs(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  return (args as Record<string, unknown>).driver === 'device'
}

/** Nested target args for a capability_invoke envelope (first present bag wins). */
function capabilityInvokeTargetArgs(root: Record<string, unknown>): unknown {
  for (const key of ['rawInput', 'input', 'parameters', 'arguments', 'args']) {
    const nested = root[key]
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      return nested
    }
  }
  return undefined
}

/**
 * Minimal strict contract for the MCP dispatcher entry/final guard. A caller
 * cannot get an owner for an unknown tool, and every success carries the same
 * action/service/lock metadata used by preflight and audit.
 */
export function resolveToolDispatchContractStrict(
  rawAction: string,
  args?: unknown
): StrictToolDispatchContract {
  // DISPATCH presentation: this identity reached us over TaskWraith's own MCP
  // transport (both bridge entry points — `tools/call` and the broker request
  // handler — resolve through here), so its server/prefix half has already been
  // matched exactly and only the tool half is in question. Folding restores what
  // `canonicalTaskWraithToolName` did before the strict resolver replaced it.
  // `resolveCatalogActionStrict` deliberately does NOT fold — it answers the
  // provenance question about untrusted provider-reported strings.
  const canonical = strictTaskWraithCatalogCanonicalName(rawAction, 'folded')
  if (
    !canonical ||
    !Object.prototype.hasOwnProperty.call(TASKWRAITH_OWNED_MCP_ACTIONS, canonical)
  ) {
    return unmapped(
      null,
      'taskwraith-catalog',
      rawAction,
      'unmapped_catalog_action',
      `TaskWraith action "${rawAction}" has no declared catalog metadata or dispatcher owner.`
    )
  }

  if (canonical === 'capability_invoke') {
    const root =
      args && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null
    const rawTarget =
      typeof root?.name === 'string' && root.name.trim().length > 0 ? root.name.trim() : null
    if (!rawTarget) {
      return unmapped(
        null,
        'taskwraith-catalog',
        rawAction,
        'gateway_target_required',
        'capability_invoke requires a non-empty concrete TaskWraith target name.'
      )
    }
    for (const key of ['rawInput', 'input', 'parameters', 'args']) {
      const nested = root?.[key]
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue
      const nestedRecord = nested as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(nestedRecord, 'name')) continue
      const nestedName = typeof nestedRecord.name === 'string' ? nestedRecord.name.trim() : ''
      if (nestedName !== rawTarget) {
        return unmapped(
          null,
          'taskwraith-catalog',
          rawAction,
          'gateway_target_identity_conflict',
          `capability_invoke root target "${rawTarget}" conflicts with nested ${key}.name identity.`
        )
      }
    }
    // Deliberately EXACT, not `'folded'`. This branch is the gateway's
    // permission-target resolution: the target must come from the argument ROOT
    // only, and the nested `rawInput/input/parameters/args` `.name` values above
    // stay pure conflict cross-checks compared byte-for-byte. Folding here would
    // also desync this from McpBridgeRuntime's
    // `resolveBridgeGatewayInvocationTarget`, which resolves the same target
    // through the exact `resolveCatalogActionStrict`; an unfolded target is
    // fail-closed against that helper, a folded one would not be.
    const target = strictTaskWraithCatalogCanonicalName(rawTarget)
    if (!target || !isTaskWraithCatalogAction(target)) {
      return unmapped(
        null,
        'taskwraith-catalog',
        rawAction,
        'gateway_target_not_declared',
        `capability_invoke target "${rawTarget}" is not a declared concrete TaskWraith catalog action.`
      )
    }
    if (target === 'capability_invoke') {
      return unmapped(
        null,
        'taskwraith-catalog',
        rawAction,
        'gateway_target_not_declared',
        'capability_invoke cannot invoke itself.'
      )
    }
    const metadata = TASKWRAITH_TOOL_ACTIONS[target]
    return {
      ok: true,
      toolName: canonical,
      effectiveToolName: target,
      resolution: 'target-derived',
      toolClass: metadata.toolClass,
      action: metadata.operation,
      dispatchOwner: metadata.dispatchOwner,
      gatewayDispatchOwner: 'capability-gateway',
      service: resolveCatalogToolAgenticService(target, capabilityInvokeTargetArgs(root!)),
      mutation: metadata.mutation,
      lock: metadata.lock,
      networkEgress: metadata.networkEgress
    }
  }

  const metadata =
    canonical === 'capability_search'
      ? CAPABILITY_GATEWAY_ACTIONS.capability_search
      : isTaskWraithCatalogAction(canonical)
        ? TASKWRAITH_TOOL_ACTIONS[canonical]
        : AUDIT_MCP_TOOL_ACTIONS[canonical as TaxonomyAuditMcpToolName]
  // capability_search is handled via CAPABILITY_GATEWAY_ACTIONS above and is
  // never a TaskWraith catalog action — do not re-compare it here (TS2367).
  const service = isTaskWraithCatalogAction(canonical)
    ? resolveCatalogToolAgenticService(canonical, args)
    : metadata.service
  return {
    ok: true,
    toolName: canonical as Exclude<TaskWraithOwnedMcpToolName, 'capability_invoke'>,
    effectiveToolName: canonical as Exclude<TaskWraithOwnedMcpToolName, 'capability_invoke'>,
    resolution: 'fixed',
    toolClass: metadata.toolClass,
    action: metadata.operation,
    dispatchOwner: metadata.dispatchOwner,
    service,
    mutation: metadata.mutation,
    lock: metadata.lock,
    networkEgress: metadata.networkEgress
  }
}

/**
 * Strict split-field MCP identity resolver for transports (such as Codex
 * app-server) that report server and tool names separately.
 */
export function resolveToolDispatchContractForServerStrict(
  serverName: string,
  rawAction: string,
  args?: unknown
): StrictToolDispatchContract {
  const normalizedServer = String(serverName || '').trim()
  const normalizedAction = String(rawAction || '').trim()
  if (
    !STRICT_TASKWRAITH_MCP_SERVER_NAMES.has(normalizedServer) ||
    // 'folded' is required, not cosmetic: this guard delegates to
    // `resolveToolDispatchContractStrict`, which folds case. Left at the default
    // 'exact' the guard is STRICTER than the function it guards, so a Codex seat
    // reporting server and tool as separate fields lost identities that resolve
    // fine as a single string — `AskUserQuestion` among them, the exact spelling
    // the case-folding fix exists to accept.
    !strictUnqualifiedCatalogCanonicalName(normalizedAction, 'folded')
  ) {
    return unmapped(
      null,
      'taskwraith-catalog',
      rawAction,
      'unmapped_catalog_action',
      `MCP server/tool identity "${serverName}/${rawAction}" is not an exact TaskWraith dispatcher route.`
    )
  }
  return resolveToolDispatchContractStrict(`mcp__${normalizedServer}__${normalizedAction}`, args)
}
