/**
 * Provider-native Codex sandbox controls shared by Electron main and the
 * standalone Node Host.
 *
 * Authority verification deliberately lives outside this module. Callers may
 * set `fullAccessGranted` only from their own trusted, post-clamp consent
 * boundary. Once that boolean is established, this resolver is the sole
 * mapping from TaskWraith's permission boundary to BOTH app-server wire
 * controls, so `thread/start.sandbox` and `turn/start.sandboxPolicy` cannot
 * drift independently.
 */

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type CodexSandboxPolicy =
  | Readonly<{
      type: 'dangerFullAccess'
    }>
  | Readonly<{
      type: 'readOnly'
      readableRoots: readonly string[]
      networkAccess: false
    }>
  | Readonly<{
      type: 'workspaceWrite'
      readableRoots: readonly string[]
      writableRoots: readonly string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: false
      excludeSlashTmp: false
    }>

export interface CodexSandboxControls {
  readonly sandbox: CodexSandboxMode
  readonly sandboxPolicy: CodexSandboxPolicy
}

export interface ResolveCodexSandboxControlsInput {
  /** Plan is an absolute read-only floor, even if wider authority leaks in. */
  readonly planMode: boolean
  /** Trusted, post-verification Full Access authority from the caller. */
  readonly fullAccessGranted: boolean
  /** Whether this adapter permits provider-native writes below Full Access. */
  readonly allowNativeWorkspaceWrite: boolean
  readonly readableRoots: readonly string[]
  readonly writableRoots: readonly string[]
  readonly networkAccess: boolean
}

export function resolveCodexSandboxControls(
  input: ResolveCodexSandboxControlsInput
): CodexSandboxControls {
  if (input.planMode) {
    return {
      sandbox: 'read-only',
      sandboxPolicy: {
        type: 'readOnly',
        readableRoots: [...input.readableRoots],
        networkAccess: false
      }
    }
  }
  if (input.fullAccessGranted) {
    return {
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'dangerFullAccess' }
    }
  }
  if (!input.allowNativeWorkspaceWrite) {
    return {
      sandbox: 'read-only',
      sandboxPolicy: {
        type: 'readOnly',
        readableRoots: [...input.readableRoots],
        networkAccess: false
      }
    }
  }
  return {
    sandbox: 'workspace-write',
    sandboxPolicy: {
      type: 'workspaceWrite',
      readableRoots: [...input.readableRoots],
      writableRoots: [...input.writableRoots],
      networkAccess: input.networkAccess,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  }
}
