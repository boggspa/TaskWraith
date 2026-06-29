import { describe, expect, it } from 'vitest'
import {
  buildPluginProvenanceCleanupPlan,
  materializedResourceBelongsToPlugin,
  materializedResourceHasPluginIdPrefix
} from './PluginProvenanceCleanup'
import type {
  TaskWraithPluginMaterializedResourceRef,
  TaskWraithPluginResourceProvenance
} from './PluginManifest'

function provenance(
  objectId: string,
  kind: TaskWraithPluginResourceProvenance['kind'],
  pluginId = 'demo-bundle'
): TaskWraithPluginResourceProvenance {
  return {
    pluginId,
    publisher: 'acme',
    version: '1.0.0',
    source: 'builtin',
    namespace: `plugin.acme.${pluginId}`,
    manifestHash: 'sha256:abc123',
    kind,
    objectId,
    materializedAt: '2026-06-29T12:00:00.000Z'
  }
}

describe('PluginProvenanceCleanup', () => {
  it('plans disable/stop/remove actions for resources with exact plugin provenance', () => {
    const resources: TaskWraithPluginMaterializedResourceRef[] = [
      {
        id: 'plugin:demo-bundle:workflow:review',
        kind: 'workflowTemplate',
        enabled: true,
        pluginProvenance: provenance('review', 'workflowTemplate')
      },
      {
        id: 'plugin:demo-bundle:runtime:codex',
        kind: 'runtimeProfile',
        enabled: true,
        pluginProvenance: provenance('codex', 'runtimeProfile')
      },
      {
        id: 'plugin:demo-bundle:service:browser',
        kind: 'localService',
        running: true,
        pluginProvenance: provenance('browser', 'localService')
      },
      {
        id: 'plugin:other-bundle:runtime:kimi',
        kind: 'runtimeProfile',
        enabled: true,
        pluginProvenance: provenance('kimi', 'runtimeProfile', 'other-bundle')
      }
    ]

    const plan = buildPluginProvenanceCleanupPlan('demo-bundle', resources)

    expect(plan.manualReview).toEqual([])
    expect(plan.actions.map((action) => [action.action, action.resource.id])).toEqual([
      ['disable', 'plugin:demo-bundle:workflow:review'],
      ['remove', 'plugin:demo-bundle:workflow:review'],
      ['disable', 'plugin:demo-bundle:runtime:codex'],
      ['remove', 'plugin:demo-bundle:runtime:codex'],
      ['stop', 'plugin:demo-bundle:service:browser'],
      ['remove', 'plugin:demo-bundle:service:browser']
    ])
  })

  it('routes prefix-only or provenance-mismatch resources to manual review', () => {
    const resources: TaskWraithPluginMaterializedResourceRef[] = [
      {
        id: 'plugin:demo-bundle:runtime:prefix-only',
        kind: 'runtimeProfile',
        enabled: true
      },
      {
        id: 'plugin:demo-bundle:service:mismatch',
        kind: 'localService',
        running: true,
        pluginProvenance: provenance('mismatch', 'localService', 'other-bundle')
      }
    ]

    const plan = buildPluginProvenanceCleanupPlan('demo-bundle', resources)

    expect(plan.actions).toEqual([])
    expect(plan.manualReview.map((item) => item.reason)).toEqual([
      'Resource id uses the plugin namespace but lacks plugin provenance; automatic cleanup is unsafe.',
      'Resource id uses this plugin namespace but provenance points at a different plugin.'
    ])
  })

  it('exposes exact provenance and id-prefix predicates separately', () => {
    const resource: TaskWraithPluginMaterializedResourceRef = {
      id: 'plugin:demo-bundle:mcp:docs',
      kind: 'mcpServer',
      pluginProvenance: provenance('docs', 'mcpServer')
    }

    expect(materializedResourceHasPluginIdPrefix('demo-bundle', resource)).toBe(true)
    expect(materializedResourceBelongsToPlugin('demo-bundle', resource)).toBe(true)
    expect(materializedResourceBelongsToPlugin('other-bundle', resource)).toBe(false)
  })
})
