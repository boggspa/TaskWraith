import { describe, expect, it } from 'vitest'
import type { ProviderId } from '../main/store/types'
import {
  PROVIDER_ACTION_ADAPTERS,
  resolveProviderNativeActionForDisplay,
  resolveProviderNativeActionStrict,
  resolveProviderActionStrict,
  type ProviderActionAdapterDeclaration,
  type ProviderNativeSurface,
  type ProviderNativeMediationPosture,
  type ProviderMcpAttachmentPosture
} from './providerActionTaxonomy'
import { TASKWRAITH_MCP_TOOLS } from './taskWraithMcpCatalog'

const providers = Object.keys(PROVIDER_ACTION_ADAPTERS) as ProviderId[]

// Hosted model families ride pi/ollama and must never appear as first-class ProviderIds.
const HOSTED_MODEL_FAMILIES = [
  'qwen',
  'minimax',
  'mimo',
  'glm',
  'openrouter',
  'deepseek',
  'xiaomi',
  'qwen-token-plan',
  'openrouter-stealth'
] as const

type ToolRouteCategory =
  | 'catalog-only'
  | 'strict-mediated-native'
  | 'provider-contained-fixed-surface'
  | 'explicitly-no-mcp'

function routeCategory(
  surface: ProviderNativeSurface,
  mediation: ProviderNativeMediationPosture,
  _attachment: ProviderMcpAttachmentPosture
): ToolRouteCategory {
  if (surface === 'catalog-only') return 'catalog-only'
  if (surface === 'closed-native' && mediation === 'taskwraith-preflight-and-approval') {
    return 'strict-mediated-native'
  }
  if (
    (surface === 'unobservable-native' || surface === 'observed-native') &&
    (mediation === 'provider-runtime-containment' || mediation === 'route-dependent')
  ) {
    return 'provider-contained-fixed-surface'
  }
  if (surface === 'closed-native' && mediation === 'route-dependent') {
    // Antigravity: native surface is closed but mediation is route-dependent and
    // attachment is route-dependent, so execution authority depends on the route.
    // Treat it as a mediated native route because the adapter declares native actions.
    return 'strict-mediated-native'
  }
  return 'explicitly-no-mcp'
}

function expectRouteCategory(
  declaration: ProviderActionAdapterDeclaration,
  expected: ToolRouteCategory
) {
  expect(
    routeCategory(declaration.nativeSurface, declaration.nativeMediation, declaration.mcpAttachment)
  ).toBe(expected)
}

describe('provider tool coalesce matrix', () => {
  it('covers exactly the 12 declared ProviderIds', () => {
    expect(providers.sort()).toEqual(
      [
        'gemini',
        'codex',
        'claude',
        'kimi',
        'grok',
        'cursor',
        'ollama',
        'antigravity',
        'pi',
        'mistral',
        'muse',
        'devin'
      ].sort()
    )
  })

  it('never encodes hosted model families as ProviderIds', () => {
    const providerSet = new Set(providers)
    for (const family of HOSTED_MODEL_FAMILIES) {
      expect(providerSet.has(family as ProviderId)).toBe(false)
    }
  })

  describe('read/search/edit/shell route posture', () => {
    it('catalog-only providers route standard operations through the catalog', () => {
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.gemini, 'catalog-only')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.claude, 'catalog-only')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.kimi, 'catalog-only')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.ollama, 'catalog-only')
    })

    it('closed-native providers route through strict TaskWraith preflight + approval', () => {
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.codex, 'strict-mediated-native')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.grok, 'strict-mediated-native')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.mistral, 'strict-mediated-native')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.antigravity, 'strict-mediated-native')
    })

    it('unobservable-native providers keep a fixed, provider-contained surface', () => {
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.cursor, 'provider-contained-fixed-surface')
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.pi, 'provider-contained-fixed-surface')
    })

    it('observed-native Muse has no MCP attachment and is provider-contained for display only', () => {
      expectRouteCategory(PROVIDER_ACTION_ADAPTERS.muse, 'provider-contained-fixed-surface')
      expect(PROVIDER_ACTION_ADAPTERS.muse.mcpAttachment).toBe('none')
    })
  })

  it('every provider has one of the four route categories', () => {
    for (const provider of providers) {
      const declaration = PROVIDER_ACTION_ADAPTERS[provider]
      const category = routeCategory(
        declaration.nativeSurface,
        declaration.nativeMediation,
        declaration.mcpAttachment
      )
      expect([
        'catalog-only',
        'strict-mediated-native',
        'provider-contained-fixed-surface',
        'explicitly-no-mcp'
      ]).toContain(category)
    }
  })

  describe('native alias coalescing invariants', () => {
    it('every declared native action has a mapping and maps to an advertised catalog tool', () => {
      for (const provider of providers) {
        const declaration = PROVIDER_ACTION_ADAPTERS[provider]
        for (const actionId of declaration.declaredNativeActions) {
          const mapping = declaration.nativeActionMappings[actionId]
          expect(mapping, `${provider}.${actionId} has a mapping`).toBeTruthy()
          expect(TASKWRAITH_MCP_TOOLS).toContain(mapping.catalogTool)
        }
      }
    })

    it('every declared denied native action has a mapping and maps to an advertised catalog tool', () => {
      for (const provider of providers) {
        const declaration = PROVIDER_ACTION_ADAPTERS[provider]
        for (const actionId of declaration.declaredDeniedNativeActions) {
          const mapping = declaration.deniedNativeActionMappings[actionId]
          expect(mapping, `${provider}.${actionId} denied mapping`).toBeTruthy()
          expect(TASKWRAITH_MCP_TOOLS).toContain(mapping.catalogTool)
        }
      }
    })

    it('every active native alias resolves to exactly one catalog identity', () => {
      for (const provider of providers) {
        const declaration = PROVIDER_ACTION_ADAPTERS[provider]
        for (const actionId of declaration.declaredNativeActions) {
          const mapping = declaration.nativeActionMappings[actionId]
          for (const alias of mapping.aliases) {
            const resolution = resolveProviderNativeActionForDisplay(provider, alias)
            expect(resolution, `${provider}.${alias} should resolve`).toBeTruthy()
            expect(resolution!.catalogTool).toBe(mapping.catalogTool)
          }
        }
      }
    })

    it('denied native aliases resolve to their declared catalog tool for display', () => {
      for (const provider of providers) {
        const declaration = PROVIDER_ACTION_ADAPTERS[provider]
        for (const actionId of declaration.declaredDeniedNativeActions) {
          const mapping = declaration.deniedNativeActionMappings[actionId]
          for (const alias of mapping.aliases) {
            const display = resolveProviderNativeActionForDisplay(provider, alias)
            expect(display).toBeTruthy()
            expect(display!.catalogTool).toBe(mapping.catalogTool)
          }
        }
      }
    })

    it('strict resolution denies catalog-only, unobservable-native, and observed-native surfaces', () => {
      // catalog-only
      expect(resolveProviderNativeActionStrict('claude', 'read_file').ok).toBe(false)
      // unobservable-native
      expect(resolveProviderNativeActionStrict('cursor', 'read_file').ok).toBe(false)
      expect(resolveProviderNativeActionStrict('pi', 'read').ok).toBe(false)
      // observed-native (Muse)
      expect(resolveProviderNativeActionStrict('muse', 'read_file').ok).toBe(false)
    })

    function toolKindForAction(
      declaration: ProviderActionAdapterDeclaration,
      actionId: string
    ): string | undefined {
      for (const [kind, disposition] of Object.entries(declaration.structuredKindMappings)) {
        if (typeof disposition === 'string') {
          if (disposition === actionId) return kind
        } else if (Array.isArray(disposition) && disposition.includes(actionId)) {
          return kind
        }
      }
      return undefined
    }

    it('strict resolution allows closed-native declared aliases', () => {
      for (const provider of ['codex', 'grok', 'mistral', 'antigravity'] as ProviderId[]) {
        const declaration = PROVIDER_ACTION_ADAPTERS[provider]
        for (const actionId of declaration.declaredNativeActions) {
          const mapping = declaration.nativeActionMappings[actionId]
          const alias = mapping.aliases[0]
          const kind = toolKindForAction(declaration, actionId)
          const context = kind ? { toolKind: kind, rawToolCall: { name: alias } } : undefined
          const resolution = resolveProviderNativeActionStrict(provider, alias, context)
          expect(resolution.ok, `${provider}.${alias} should resolve`).toBe(true)
          if (resolution.ok) {
            expect(resolution.catalogTool).toBe(mapping.catalogTool)
          }
        }
      }
    })
  })

  describe('catalog-only providers accept canonical TaskWraith tool names', () => {
    it('resolves catalog names for catalog-only providers', () => {
      for (const provider of ['claude', 'gemini', 'kimi', 'ollama'] as ProviderId[]) {
        const read = resolveProviderActionStrict(provider, 'read_file')
        expect(read.ok).toBe(true)
        if (read.ok) expect(read.catalogTool).toBe('read_file')

        const shell = resolveProviderActionStrict(provider, 'run_shell_command')
        expect(shell.ok).toBe(true)
        if (shell.ok) expect(shell.catalogTool).toBe('run_shell_command')
      }
    })
  })
})
