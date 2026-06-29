import type {
  TaskWraithPluginCleanupAction,
  TaskWraithPluginCleanupManualReviewItem,
  TaskWraithPluginCleanupPlan,
  TaskWraithPluginMaterializedResourceRef,
  TaskWraithPluginResourceKind
} from './PluginManifest'

const RESOURCE_KIND_ID_SEGMENTS: Record<TaskWraithPluginResourceKind, string> = {
  mcpServer: 'mcp',
  workflowTemplate: 'workflow',
  runtimeProfile: 'runtime',
  connector: 'connector',
  localService: 'service',
  remoteProjection: 'remote'
}

function expectedPluginIdPrefix(pluginId: string, kind: TaskWraithPluginResourceKind): string {
  return `plugin:${pluginId}:${RESOURCE_KIND_ID_SEGMENTS[kind]}:`
}

export function materializedResourceHasPluginIdPrefix(
  pluginId: string,
  resource: Pick<TaskWraithPluginMaterializedResourceRef, 'id' | 'kind'>
): boolean {
  return resource.id.startsWith(expectedPluginIdPrefix(pluginId, resource.kind))
}

export function materializedResourceBelongsToPlugin(
  pluginId: string,
  resource: Pick<TaskWraithPluginMaterializedResourceRef, 'pluginProvenance'>
): boolean {
  return resource.pluginProvenance?.pluginId === pluginId
}

function cleanupActionsForResource(
  resource: TaskWraithPluginMaterializedResourceRef
): TaskWraithPluginCleanupAction[] {
  const actions: TaskWraithPluginCleanupAction[] = []
  if (resource.kind === 'localService' && resource.running) {
    actions.push({
      action: 'stop',
      resource,
      reason: 'Plugin-owned local service must be stopped before uninstall cleanup.'
    })
  } else if (resource.enabled) {
    actions.push({
      action: 'disable',
      resource,
      reason: 'Plugin-owned resource must be disabled before removal.'
    })
  }
  actions.push({
    action: 'remove',
    resource,
    reason: 'Plugin provenance matches the plugin being uninstalled.'
  })
  return actions
}

export function buildPluginProvenanceCleanupPlan(
  pluginId: string,
  resources: readonly TaskWraithPluginMaterializedResourceRef[]
): TaskWraithPluginCleanupPlan {
  const actions: TaskWraithPluginCleanupAction[] = []
  const manualReview: TaskWraithPluginCleanupManualReviewItem[] = []

  for (const resource of resources) {
    const provenancePluginId = resource.pluginProvenance?.pluginId
    const idPrefixMatches = materializedResourceHasPluginIdPrefix(pluginId, resource)
    if (provenancePluginId === pluginId) {
      actions.push(...cleanupActionsForResource(resource))
      continue
    }
    if (idPrefixMatches && !provenancePluginId) {
      manualReview.push({
        resource,
        reason:
          'Resource id uses the plugin namespace but lacks plugin provenance; automatic cleanup is unsafe.'
      })
      continue
    }
    if (idPrefixMatches && provenancePluginId && provenancePluginId !== pluginId) {
      manualReview.push({
        resource,
        reason:
          'Resource id uses this plugin namespace but provenance points at a different plugin.'
      })
    }
  }

  return {
    pluginId,
    actions,
    manualReview
  }
}
