/**
 * Orchestration-level provider-action parity proof (1.9.3 must-close).
 *
 * Adapter taxonomy tests prove table alignment. This suite proves that every
 * run-management provider resolves ONE declared set of catalog verbs and
 * native permission actions through the strict resolvers orchestration
 * consumes, and that WorkspaceLockMcpAdmissionCoordinator fails closed on
 * provider-native labels before claims.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  WorkspaceLockMcpAdmissionCoordinator,
  type WorkspaceLockMcpAdmissionCoordinatorDependencies,
  type WorkspaceLockMcpAdmissionInput
} from '../main/WorkspaceLockMcpAdmissionCoordinator'
import { PROVIDER_RUN_MANAGEMENT_IDS } from '../main/run/ProviderRunManagementMatrix'
import type { ProviderId } from '../main/store/types'
import {
  PROVIDER_ACTION_ADAPTERS,
  TASKWRAITH_TOOL_ACTIONS,
  resolveCatalogActionStrict,
  resolveProviderActionStrict,
  resolveProviderNativeActionStrict
} from './providerActionTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './taskWraithMcpCatalog'

const providers: readonly ProviderId[] = PROVIDER_RUN_MANAGEMENT_IDS

const UNDECLARED_NATIVE_CORPUS = [
  'TotallyNewExfiltrateTool',
  'not-a-real-native-action',
  'TeleportRepository'
] as const

function admissionInput(
  overrides: Partial<WorkspaceLockMcpAdmissionInput> = {}
): WorkspaceLockMcpAdmissionInput {
  return {
    context: {
      scope: 'workspace',
      cwd: '/worktree',
      workspacePath: '/worktree',
      appRunId: 'run-parity-1',
      appChatId: 'chat-parity-1'
    },
    provider: 'codex',
    toolName: 'write_file',
    args: { path: '/worktree/file.txt', content: 'body' },
    resourcePath: '/worktree/file.txt',
    ...overrides
  }
}

function admissionDeps(
  overrides: Partial<WorkspaceLockMcpAdmissionCoordinatorDependencies> = {}
): WorkspaceLockMcpAdmissionCoordinatorDependencies {
  return {
    getRuntime: () => null,
    getRuntimeUnavailableReason: () =>
      'Workspace-lock authority is not available; mutation was not started.',
    getChat: () => ({ workspacePath: '/primary', title: 'Parity chat' }),
    getOpaqueOwnerId: () => 'opaque-owner-parity',
    getProviderScopeAdmission: () => null,
    acquireProviderScopeSublease: async () => {
      throw new Error('No provider-scope admission was expected.')
    },
    validateLaneWriteScope: () => undefined,
    markLaneBlocked: vi.fn(),
    encode: (payload) => JSON.stringify(payload),
    providerDisplayName: (provider) => `Provider ${provider}`,
    ...overrides
  }
}

describe('provider action parity (orchestration)', () => {
  it('resolves the same catalog action set across every run-management provider', () => {
    const expectedDenyProviders = providers.filter(
      (provider) => PROVIDER_ACTION_ADAPTERS[provider].mcpAttachment === 'none'
    )

    // Adapter declaration is the sole source of the expected-deny set.
    expect(expectedDenyProviders.sort()).toEqual(
      providers
        .filter((provider) => PROVIDER_ACTION_ADAPTERS[provider].mcpAttachment === 'none')
        .sort()
    )
    expect(expectedDenyProviders).toEqual(['pi'])

    for (const provider of providers) {
      const declaration = PROVIDER_ACTION_ADAPTERS[provider]
      const deniedCatalogTools = new Set<string>()

      for (const catalogTool of TASKWRAITH_MCP_TOOLS) {
        const resolved = resolveProviderActionStrict(provider, catalogTool)
        const catalog = resolveCatalogActionStrict(catalogTool)
        expect(catalog.ok, `catalog baseline ${catalogTool}`).toBe(true)
        if (!catalog.ok) continue

        if (declaration.mcpAttachment === 'none') {
          expect(resolved, `${provider}:${catalogTool}`).toMatchObject({
            ok: false,
            denied: true,
            code: 'mcp_attachment_unavailable',
            provider,
            source: 'taskwraith-catalog'
          })
          deniedCatalogTools.add(catalogTool)
          continue
        }

        expect(resolved, `${provider}:${catalogTool}`).toMatchObject({
          ok: true,
          provider,
          source: 'taskwraith-catalog',
          catalogTool: catalog.catalogTool,
          action: catalog.action,
          metadata: catalog.metadata
        })
        if (resolved.ok) {
          expect(resolved.action).toBe(TASKWRAITH_TOOL_ACTIONS[catalogTool].operation)
          expect(resolved.metadata).toEqual(TASKWRAITH_TOOL_ACTIONS[catalogTool])
        }
      }

      if (declaration.mcpAttachment === 'none') {
        expect([...deniedCatalogTools].sort()).toEqual([...TASKWRAITH_MCP_TOOLS].sort())
      } else {
        expect(deniedCatalogTools.size).toBe(0)
      }
    }
  })

  it('resolves declared native actions to one canonical set and fails undeclared spellings explicitly', () => {
    for (const provider of providers) {
      const declaration = PROVIDER_ACTION_ADAPTERS[provider]
      const usesStructuredKinds = Object.keys(declaration.structuredKindMappings).length > 0

      for (const nativeAction of declaration.declaredNativeActions) {
        const mapping = declaration.nativeActionMappings[nativeAction]
        expect(mapping, `${provider}:${nativeAction}`).toBeDefined()
        // Alias index is the execution surface; bare native ids are not always aliases.
        const spellings = [...mapping.aliases]
        expect(spellings.length, `${provider}:${nativeAction} aliases`).toBeGreaterThan(0)

        for (const spelling of spellings) {
          const resolved = resolveProviderNativeActionStrict(provider, spelling)

          if (declaration.nativeSurface === 'catalog-only') {
            expect(resolved, `${provider}:${spelling}`).toMatchObject({
              ok: false,
              denied: true,
              code: 'native_surface_closed',
              provider
            })
            continue
          }

          // ACP structured-kind providers (grok/mistral) refuse bare display/alias
          // resolution without toolKind — the kind axis is the execution authority.
          if (usesStructuredKinds) {
            expect(resolved, `${provider}:${spelling}`).toMatchObject({
              ok: false,
              denied: true,
              code: 'native_action_not_declared',
              provider
            })
            continue
          }

          if (declaration.nativeSurface === 'unobservable-native') {
            expect(resolved, `${provider}:${spelling}`).toMatchObject({
              ok: false,
              denied: true,
              code: 'native_surface_unobservable',
              provider
            })
            continue
          }

          // closed-native without structured kinds (e.g. codex): canonical match.
          expect(resolved, `${provider}:${spelling}`).toMatchObject({
            ok: true,
            provider,
            source: 'provider-native',
            catalogTool: mapping.catalogTool,
            action: mapping.action,
            nativeAction
          })
          if (resolved.ok) {
            expect(resolved.action).toBe(
              TASKWRAITH_TOOL_ACTIONS[mapping.catalogTool].operation
            )
            expect(resolved.metadata).toEqual(TASKWRAITH_TOOL_ACTIONS[mapping.catalogTool])
          }
        }
      }

      // Declared denied natives must NEVER resolve to ok under strict execution.
      for (const nativeAction of declaration.declaredDeniedNativeActions) {
        const mapping = declaration.deniedNativeActionMappings[nativeAction]
        expect(mapping, `${provider}:denied:${nativeAction}`).toBeDefined()
        for (const spelling of mapping.aliases) {
          const resolved = resolveProviderNativeActionStrict(provider, spelling)
          expect(resolved.ok, `${provider}:denied:${spelling}`).toBe(false)
          if (!resolved.ok) {
            expect(resolved.denied).toBe(true)
            // catalog-only adapters close the whole native surface; others leave
            // denied spellings outside the active native index (or structured gate).
            if (declaration.nativeSurface === 'catalog-only') {
              expect(resolved.code, `${provider}:denied:${spelling}`).toBe(
                'native_surface_closed'
              )
            } else {
              expect(resolved.code, `${provider}:denied:${spelling}`).toBe(
                'native_action_not_declared'
              )
            }
          }
        }
      }

      for (const undeclared of UNDECLARED_NATIVE_CORPUS) {
        const resolved = resolveProviderNativeActionStrict(provider, undeclared)
        expect(resolved, `${provider}:undeclared:${undeclared}`).toMatchObject({
          ok: false,
          denied: true,
          provider,
          code:
            declaration.nativeSurface === 'catalog-only'
              ? 'native_surface_closed'
              : 'native_action_not_declared'
        })
      }
    }

    // Structured-kind axis (ACP display titles are untrusted; kind binds).
    for (const provider of ['grok', 'mistral'] as const) {
      expect(
        resolveProviderNativeActionStrict(provider, 'Arbitrary ACP display title', {
          toolKind: 'read',
          rawToolCall: { rawInput: { path: 'src/generated.ts' } }
        }),
        `${provider}:structured-read`
      ).toMatchObject({ ok: true, catalogTool: 'read_file', action: 'workspace.read' })
      expect(
        resolveProviderNativeActionStrict(provider, 'Totally unrelated human title', {
          toolKind: 'edit'
        }),
        `${provider}:structured-edit`
      ).toMatchObject({ ok: true, catalogTool: 'write_file', action: 'workspace.mutate' })
      expect(
        resolveProviderNativeActionStrict(provider, 'Shell display title', {
          toolKind: 'execute'
        }),
        `${provider}:structured-execute`
      ).toMatchObject({
        ok: true,
        catalogTool: 'run_shell_command',
        action: 'shell.execute'
      })
      // Kind/title contradiction: execute kind wins over write-shaped title.
      expect(
        resolveProviderNativeActionStrict(provider, 'Write file src/generated.ts', {
          toolKind: 'execute'
        })
      ).toMatchObject({ ok: true, catalogTool: 'run_shell_command' })
      // Missing shape for ambiguous search kind fails closed.
      expect(
        resolveProviderNativeActionStrict(provider, 'Write file src/generated.ts', {
          toolKind: 'search'
        })
      ).toMatchObject({ ok: false, code: 'native_action_not_declared' })
    }
    expect(
      resolveProviderNativeActionStrict('claude', 'Write file src/generated.ts', {
        toolKind: 'edit'
      })
    ).toMatchObject({ ok: false, code: 'native_surface_closed' })
  })

  it('admits only the single declared catalog set and typed-denies provider-native labels before claims', async () => {
    const getRuntime = vi.fn(() => null)
    const getOpaqueOwnerId = vi.fn(() => 'opaque-owner-parity')
    const coordinator = new WorkspaceLockMcpAdmissionCoordinator(
      admissionDeps({ getRuntime, getOpaqueOwnerId })
    )

    // No-lock catalog tool: admits without runtime/owner (canonical path, empty claims).
    const readAdmit = await coordinator.admit(
      admissionInput({ toolName: 'read_file', args: { path: '/worktree/file.txt' } })
    )
    expect(readAdmit).toEqual({
      ok: true,
      claims: [],
      canonicalClaims: [],
      claimsHeld: false,
      releaseAfterOperation: false
    })
    expect(getRuntime).not.toHaveBeenCalled()
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()

    // Provider-native label at admission must fail closed BEFORE claims/runtime.
    const nativeLabel = 'fileChange'
    const nativeResolution = resolveProviderNativeActionStrict('codex', nativeLabel)
    expect(nativeResolution).toMatchObject({
      ok: true,
      catalogTool: 'apply_patch',
      action: 'workspace.mutate'
    })

    getRuntime.mockClear()
    getOpaqueOwnerId.mockClear()
    const nativeAdmit = await coordinator.admit(
      admissionInput({
        provider: 'codex',
        toolName: nativeLabel,
        args: { path: '/worktree/file.txt' }
      })
    )
    expect(nativeAdmit.ok).toBe(false)
    if (nativeAdmit.ok) throw new Error('Expected provider-native label denial.')
    expect(nativeAdmit).toMatchObject({
      ok: false,
      code: 'unmapped_catalog_action'
    })
    expect(JSON.parse(nativeAdmit.text)).toMatchObject({
      ok: false,
      tool: nativeLabel,
      code: 'unmapped_catalog_action'
    })
    expect(getRuntime).not.toHaveBeenCalled()
    expect(getOpaqueOwnerId).not.toHaveBeenCalled()

    // Canonical catalog tool from the native mapping enters the claims path
    // (runtime consulted; missing authority still typed-denies after taxonomy).
    getRuntime.mockClear()
    getOpaqueOwnerId.mockClear()
    if (!nativeResolution.ok) throw new Error('Expected codex native resolution.')
    const canonicalAdmit = await coordinator.admit(
      admissionInput({
        provider: 'codex',
        toolName: nativeResolution.catalogTool,
        args: { path: '/worktree/file.txt', patch: '--- a/x\n+++ b/x' }
      })
    )
    expect(canonicalAdmit.ok).toBe(false)
    if (canonicalAdmit.ok) throw new Error('Expected runtime-unavailable denial after taxonomy.')
    expect(canonicalAdmit.reason).toMatch(/not available|mutation was not started/i)
    expect(getRuntime).toHaveBeenCalled()
    // Taxonomy accepted the catalog verb; identity/runtime come after.
    expect(canonicalAdmit.code).not.toBe('unmapped_catalog_action')

    // Combined strict resolver is what orchestration must use for catalog×provider
    // attachment: pi has no MCP attachment and must fail before any claims path.
    expect(resolveProviderActionStrict('pi', 'write_file')).toMatchObject({
      ok: false,
      code: 'mcp_attachment_unavailable'
    })
  })
})
