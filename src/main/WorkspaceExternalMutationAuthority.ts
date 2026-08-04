import { isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  ChatScope,
  EffectiveRunPermissions,
  EnsembleRunIdentity,
  ProviderId
} from './store/types'
import {
  createTrustedSessionExternalMutationAuthorityReceipt,
  createWorkspaceExternalMutationAuthorityReceipt,
  type WorkspaceExternalMutationAuthorityReceipt
} from './WorkspaceLockRuntime'

export interface WorkspaceExternalMutationAuthorityContext {
  scope: ChatScope
  cwd: string
  workspacePath?: string
  appRunId?: string
  appChatId?: string
  runtimeProfileId?: string
  ensembleRun?: EnsembleRunIdentity
  effectivePermissions?: EffectiveRunPermissions
}

export interface WorkspaceExternalSignedWriteGrant {
  id: string
  signature: string
}

export interface WorkspaceExternalSignedWriteGrantQuery<
  Context extends WorkspaceExternalMutationAuthorityContext =
    WorkspaceExternalMutationAuthorityContext
> {
  context: Context
  provider: ProviderId
  runId: string
  targetPath: string
}

export interface WorkspaceTrustedSessionExternalWriteQuery {
  provider: ProviderId
  runId: string
  targetPath: string
  chatId?: string
  workspacePath?: string
  runtimeProfileId?: string
  ensembleRun?: EnsembleRunIdentity
  effectivePermissions?: EffectiveRunPermissions
}

export interface WorkspaceExternalMutationAuthorityIssuerDependencies<
  Context extends WorkspaceExternalMutationAuthorityContext =
    WorkspaceExternalMutationAuthorityContext
> {
  canonicalizePath: (path: string) => string | null
  resolvePrimaryWorkspacePath: (chatId: string | undefined) => string | undefined
  findValidatedSignedWriteGrant: (
    query: WorkspaceExternalSignedWriteGrantQuery<Context>
  ) => WorkspaceExternalSignedWriteGrant | undefined
  isTrustedSessionWriteAuthorized: (query: WorkspaceTrustedSessionExternalWriteQuery) => boolean
}

export interface WorkspaceExternalMutationAuthorityIssueInput<
  Context extends WorkspaceExternalMutationAuthorityContext =
    WorkspaceExternalMutationAuthorityContext
> {
  context: Context
  provider: ProviderId
  toolName: string
  args: Record<string, unknown>
}

/**
 * Issues operation-scoped external-write receipts after main has established
 * either a validated signed grant or an exact Full Access authority.
 *
 * The returned receipt is bound to provider, run, target and the complete
 * mutation fingerprint by WorkspaceLockRuntime's receipt builders.
 */
export class WorkspaceExternalMutationAuthorityIssuer<
  Context extends WorkspaceExternalMutationAuthorityContext =
    WorkspaceExternalMutationAuthorityContext
> {
  constructor(
    private readonly deps: WorkspaceExternalMutationAuthorityIssuerDependencies<Context>
  ) {}

  issue(
    input: WorkspaceExternalMutationAuthorityIssueInput<Context>
  ): WorkspaceExternalMutationAuthorityReceipt | undefined {
    if (input.context.scope === 'global') return undefined
    if (input.toolName !== 'write_file' && input.toolName !== 'replace') {
      return undefined
    }

    const runId = input.context.appRunId?.trim()
    if (!runId) return undefined
    const rawPath = externalMutationPath(input.args)
    if (rawPath === undefined) return undefined

    const effectiveWorkspacePath = resolve(input.context.workspacePath || input.context.cwd)
    const lexicalTargetPath = isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(effectiveWorkspacePath, rawPath)
    const targetPath = this.deps.canonicalizePath(lexicalTargetPath)
    const canonicalWorkspacePath = this.deps.canonicalizePath(effectiveWorkspacePath)
    if (
      !targetPath ||
      !canonicalWorkspacePath ||
      !isAbsolute(targetPath) ||
      !isAbsolute(canonicalWorkspacePath) ||
      pathIsInside(canonicalWorkspacePath, targetPath)
    ) {
      return undefined
    }

    const primaryWorkspacePath = this.deps.resolvePrimaryWorkspacePath(input.context.appChatId)
    const mutation = {
      source: 'taskwraith-catalog' as const,
      provider: input.provider,
      workspacePath: resolve(primaryWorkspacePath || effectiveWorkspacePath),
      worktreePath: effectiveWorkspacePath,
      action: input.toolName,
      args: input.args
    }
    const grant = this.deps.findValidatedSignedWriteGrant({
      context: input.context,
      provider: input.provider,
      runId,
      targetPath
    })
    if (grant?.id && grant.signature) {
      return createWorkspaceExternalMutationAuthorityReceipt({
        mutation,
        provider: input.provider,
        runId,
        targetPath,
        grantId: grant.id,
        grantSignature: grant.signature
      })
    }

    const trustedSessionQuery: WorkspaceTrustedSessionExternalWriteQuery = {
      provider: input.provider,
      runId,
      targetPath,
      ...(input.context.appChatId ? { chatId: input.context.appChatId } : {}),
      ...(input.context.workspacePath ? { workspacePath: input.context.workspacePath } : {}),
      ...(input.context.runtimeProfileId
        ? { runtimeProfileId: input.context.runtimeProfileId }
        : {}),
      ...(input.context.ensembleRun ? { ensembleRun: input.context.ensembleRun } : {}),
      ...(input.context.effectivePermissions
        ? { effectivePermissions: input.context.effectivePermissions }
        : {})
    }
    if (!this.deps.isTrustedSessionWriteAuthorized(trustedSessionQuery)) {
      return undefined
    }

    return createTrustedSessionExternalMutationAuthorityReceipt({
      mutation,
      provider: input.provider,
      runId,
      targetPath,
      trustContextId: JSON.stringify([
        input.context.appChatId || null,
        runId,
        input.context.runtimeProfileId || 'default',
        input.context.ensembleRun?.participantId || null,
        input.context.ensembleRun?.laneId || null
      ])
    })
  }
}

function externalMutationPath(args: Record<string, unknown>): string | undefined {
  const value = args.path || args.file_path
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  return value
}

function pathIsInside(rootPath: string, targetPath: string): boolean {
  const pathFromRoot = relative(rootPath, targetPath)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  )
}
