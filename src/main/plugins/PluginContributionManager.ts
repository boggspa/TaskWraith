import type {
  AppSettings,
  RuntimeProfile,
  UserMcpServerConfig
} from '../store/types'
import type { PluginHost } from './PluginHost'
import type {
  TaskWraithPluginActivatedConnector,
  TaskWraithPluginActivatedLocalService,
  TaskWraithPluginActivatedMobileProjection,
  TaskWraithPluginActivatedProviderSetup,
  TaskWraithPluginActivatedToolBundle,
  TaskWraithPluginActivatedWorkflowTemplate,
  TaskWraithPluginActivationSnapshot,
  TaskWraithPluginContributionProvenance,
  TaskWraithPluginContributionSnapshot,
  TaskWraithPluginResourceKind,
  TaskWraithPluginResourceProvenance
} from '../../shared/plugins/PluginTypes'

type RuntimeProfileInput = Partial<RuntimeProfile> & Pick<RuntimeProfile, 'name' | 'provider'>

export interface PluginContributionManagerOptions {
  pluginHost: Pick<PluginHost, 'getContributionSnapshot'>
  getSettings: () => AppSettings
  updateSettings: (partial: Partial<AppSettings>) => void
  getRuntimeProfiles: () => RuntimeProfile[]
  saveRuntimeProfile: (profile: RuntimeProfileInput) => RuntimeProfile
  deleteRuntimeProfile: (id: string) => void
  now?: () => Date
  log?: (line: string) => void
}

const RESOURCE_KIND_ID_SEGMENTS: Record<TaskWraithPluginResourceKind, string> = {
  mcpServer: 'mcp',
  toolBundle: 'tool',
  workflowTemplate: 'workflow',
  runtimeProfile: 'runtime',
  connector: 'connector',
  localService: 'service',
  providerSetup: 'setup',
  remoteProjection: 'remote'
}

function pluginObjectId(pluginId: string, kind: TaskWraithPluginResourceKind, objectId: string): string {
  return `plugin:${pluginId}:${RESOURCE_KIND_ID_SEGMENTS[kind]}:${objectId}`
}

function provenanceFor(
  plugin: TaskWraithPluginContributionProvenance,
  kind: TaskWraithPluginResourceKind,
  objectId: string,
  materializedAt: string
): TaskWraithPluginResourceProvenance {
  return {
    ...plugin,
    kind,
    objectId,
    materializedAt
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (typeof child !== 'undefined') output[key] = stableJsonValue(child)
  }
  return output
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

function samePersistedResource(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b)
}

function pluginMcpReviewState(
  plugin: TaskWraithPluginContributionProvenance,
  existing: UserMcpServerConfig | undefined,
  sameManifest: boolean,
  materializedAt: string
): UserMcpServerConfig['pluginReview'] {
  if (sameManifest && existing?.enabled) {
    return {
      status: 'accepted',
      reason: 'user-enabled-reviewed-resource',
      manifestHash: plugin.manifestHash,
      reviewedAt: existing.pluginReview?.reviewedAt || materializedAt
    }
  }
  if (sameManifest && existing?.pluginReview?.manifestHash === plugin.manifestHash) {
    return existing.pluginReview
  }
  return {
    status: 'pending',
    reason: existing?.pluginProvenance ? 'manifest-update' : 'new-plugin-resource',
    manifestHash: plugin.manifestHash
  }
}

function pluginResourceBelongsTo(
  provenance: TaskWraithPluginResourceProvenance | undefined,
  plugin: TaskWraithPluginContributionProvenance,
  kind: TaskWraithPluginResourceKind,
  objectId: string
): boolean {
  return (
    provenance?.pluginId === plugin.pluginId &&
    provenance.kind === kind &&
    provenance.objectId === objectId
  )
}

function pluginResourceIsSameManifest(
  provenance: TaskWraithPluginResourceProvenance | undefined,
  plugin: TaskWraithPluginContributionProvenance,
  kind: TaskWraithPluginResourceKind,
  objectId: string
): boolean {
  return (
    pluginResourceBelongsTo(provenance, plugin, kind, objectId) &&
    provenance?.publisher === plugin.publisher &&
    provenance.version === plugin.version &&
    provenance.source === plugin.source &&
    provenance.namespace === plugin.namespace &&
    provenance.manifestHash === plugin.manifestHash
  )
}

function isConflictingPluginNamespaceResource(
  id: string,
  provenance: TaskWraithPluginResourceProvenance | undefined,
  pluginId: string,
  kind: TaskWraithPluginResourceKind
): boolean {
  const expectedPrefix = `plugin:${pluginId}:${RESOURCE_KIND_ID_SEGMENTS[kind]}:`
  return id.startsWith(expectedPrefix) && provenance?.pluginId !== pluginId
}

function pluginRuntimeProfileFromContribution(
  contribution: TaskWraithPluginContributionSnapshot['runtimeProfiles'][number],
  existing: RuntimeProfile | undefined,
  materializedAt: string
): RuntimeProfileInput {
  const { plugin, profile, runtimeProfileId } = contribution
  const provenance = provenanceFor(plugin, 'runtimeProfile', profile.id, materializedAt)
  return {
    id: runtimeProfileId,
    name: profile.name,
    provider: profile.provider,
    scope: profile.scope,
    workspaceMode: profile.workspaceMode,
    env: profile.env ? { ...profile.env } : {},
    mcpProfileId: profile.mcpProfileId,
    approvalMode: profile.approvalMode,
    agenticServices: profile.agenticServices,
    networkPolicy: profile.networkPolicy || 'inherit',
    persistence: profile.persistence || 'reusable',
    pluginProvenance: provenance,
    createdAt: existing?.createdAt || materializedAt,
    updatedAt: materializedAt
  }
}

export class PluginContributionManager {
  private snapshot: TaskWraithPluginActivationSnapshot | null = null

  constructor(private readonly options: PluginContributionManagerOptions) {}

  sync(): TaskWraithPluginActivationSnapshot {
    const contributions = this.options.pluginHost.getContributionSnapshot()
    const generatedAt = this.nowIso()
    this.materializeMcpServers(contributions, generatedAt)
    this.materializeRuntimeProfiles(contributions, generatedAt)
    this.snapshot = this.buildActivationSnapshot(contributions, generatedAt)
    return this.snapshot
  }

  getActivationSnapshot(): TaskWraithPluginActivationSnapshot {
    return this.sync()
  }

  private nowIso(): string {
    return (this.options.now?.() ?? new Date()).toISOString()
  }

  private materializeMcpServers(
    contributions: TaskWraithPluginContributionSnapshot,
    materializedAt: string
  ): void {
    const settings = this.options.getSettings()
    const current = settings.userMcpServers || []
    const byId = new Map(current.map((server) => [server.id, server]))
    const desired = new Map<string, UserMcpServerConfig>()

    for (const contribution of contributions.mcpServers) {
      const { plugin, preset } = contribution
      const base = contribution.userMcpServerConfig as UserMcpServerConfig
      const existing = byId.get(base.id)
      if (
        existing &&
        isConflictingPluginNamespaceResource(
          base.id,
          existing?.pluginProvenance,
          plugin.pluginId,
          'mcpServer'
        )
      ) {
        this.options.log?.(
          `[plugins] skipped MCP preset ${base.id}: id is in plugin namespace without matching provenance`
        )
        continue
      }
      const sameManifest = pluginResourceIsSameManifest(
        existing?.pluginProvenance,
        plugin,
        'mcpServer',
        preset.id
      )
      const next: UserMcpServerConfig = {
        ...base,
        enabled: sameManifest ? Boolean(existing?.enabled) : false,
        pluginProvenance: provenanceFor(plugin, 'mcpServer', preset.id, materializedAt),
        pluginReview: pluginMcpReviewState(plugin, existing, sameManifest, materializedAt),
        createdAt: existing?.createdAt || materializedAt,
        updatedAt: materializedAt
      }
      if (sameManifest && existing?.updatedAt && samePersistedResource({ ...existing, updatedAt: undefined }, { ...next, updatedAt: undefined })) {
        next.updatedAt = existing.updatedAt
      }
      desired.set(next.id, next)
    }

    const nextServers: UserMcpServerConfig[] = []
    for (const server of current) {
      const wanted = desired.get(server.id)
      if (wanted) {
        nextServers.push(wanted)
        desired.delete(server.id)
        continue
      }
      if (server.pluginProvenance?.kind === 'mcpServer' && server.enabled) {
        nextServers.push({
          ...server,
          enabled: false,
          updatedAt: materializedAt
        })
        continue
      }
      nextServers.push(server)
    }
    nextServers.push(...desired.values())

    if (!samePersistedResource(current, nextServers)) {
      this.options.updateSettings({ userMcpServers: nextServers })
    }
  }

  private materializeRuntimeProfiles(
    contributions: TaskWraithPluginContributionSnapshot,
    materializedAt: string
  ): void {
    const current = this.options.getRuntimeProfiles()
    const currentById = new Map(current.map((profile) => [profile.id, profile]))
    const desiredIds = new Set<string>()

    for (const contribution of contributions.runtimeProfiles) {
      const existing = currentById.get(contribution.runtimeProfileId)
      if (
        existing &&
        isConflictingPluginNamespaceResource(
          existing.id,
          existing.pluginProvenance,
          contribution.plugin.pluginId,
          'runtimeProfile'
        )
      ) {
        this.options.log?.(
          `[plugins] skipped runtime profile ${existing.id}: id is in plugin namespace without matching provenance`
        )
        continue
      }
      desiredIds.add(contribution.runtimeProfileId)
      const next = pluginRuntimeProfileFromContribution(contribution, existing, materializedAt)
      if (
        existing &&
        pluginResourceIsSameManifest(
          existing.pluginProvenance,
          contribution.plugin,
          'runtimeProfile',
          contribution.profile.id
        ) &&
        samePersistedResource({ ...existing, updatedAt: undefined }, { ...next, updatedAt: undefined })
      ) {
        continue
      }
      this.options.saveRuntimeProfile(next)
    }

    for (const profile of current) {
      if (
        profile.pluginProvenance?.kind === 'runtimeProfile' &&
        !desiredIds.has(profile.id)
      ) {
        this.options.deleteRuntimeProfile(profile.id)
      }
    }
  }

  private buildActivationSnapshot(
    contributions: TaskWraithPluginContributionSnapshot,
    generatedAt: string
  ): TaskWraithPluginActivationSnapshot {
    const settings = this.options.getSettings()
    const runtimeProfiles = this.options.getRuntimeProfiles()
    const activeMcpIds = new Set(contributions.mcpServers.map((entry) => entry.userMcpServerConfig.id))
    const mcpServers = (settings.userMcpServers || []).filter(
      (server) => server.pluginProvenance?.kind === 'mcpServer' && activeMcpIds.has(server.id)
    )
    const activeRuntimeIds = new Set(contributions.runtimeProfiles.map((entry) => entry.runtimeProfileId))
    const runtimeProfileIds = runtimeProfiles
      .filter(
        (profile) =>
          profile.pluginProvenance?.kind === 'runtimeProfile' && activeRuntimeIds.has(profile.id)
      )
      .map((profile) => profile.id)
    const taskwraithToolBundles: TaskWraithPluginActivatedToolBundle[] =
      contributions.taskwraithToolBundles.map(({ plugin, bundle }) => ({
        id: pluginObjectId(plugin.pluginId, 'toolBundle', bundle.id),
        plugin,
        bundle,
        pluginProvenance: provenanceFor(plugin, 'toolBundle', bundle.id, generatedAt)
      }))
    const workflowTemplates: TaskWraithPluginActivatedWorkflowTemplate[] =
      contributions.workflowTemplates.map(({ plugin, template }) => ({
        id: pluginObjectId(plugin.pluginId, 'workflowTemplate', template.id),
        plugin,
        template,
        pluginProvenance: provenanceFor(plugin, 'workflowTemplate', template.id, generatedAt)
      }))
    const connectors: TaskWraithPluginActivatedConnector[] = contributions.connectors.map(
      ({ plugin, connector }) => ({
        id: pluginObjectId(plugin.pluginId, 'connector', connector.id),
        plugin,
        connector,
        pluginProvenance: provenanceFor(plugin, 'connector', connector.id, generatedAt)
      })
    )
    const localServices: TaskWraithPluginActivatedLocalService[] = contributions.localServices.map(
      ({ plugin, service, serviceId }) => ({
        id: serviceId,
        plugin,
        service,
        pluginProvenance: provenanceFor(plugin, 'localService', service.id, generatedAt),
        enabled: true,
        running: false,
        managedByTaskWraith: service.managedByTaskWraith === true
      })
    )
    const providerSetup: TaskWraithPluginActivatedProviderSetup[] = contributions.providerSetup.map(
      ({ plugin, setup }) => ({
        id: pluginObjectId(plugin.pluginId, 'providerSetup', setup.provider),
        plugin,
        setup,
        pluginProvenance: provenanceFor(plugin, 'providerSetup', setup.provider, generatedAt)
      })
    )
    const mobileRemoteProjection: TaskWraithPluginActivatedMobileProjection[] =
      contributions.mobileRemoteProjection.map(({ plugin, projection, projectionId }) => ({
        id: projectionId,
        plugin,
        projection,
        pluginProvenance: provenanceFor(plugin, 'remoteProjection', projection.id, generatedAt),
        enabled: true
      }))
    const materializedResources: TaskWraithPluginActivationSnapshot['materializedResources'] = [
      ...mcpServers.map((server) => ({
        id: server.id,
        kind: 'mcpServer' as const,
        label: server.name,
        enabled: server.enabled,
        pluginProvenance: server.pluginProvenance
      })),
      ...runtimeProfiles
        .filter((profile) => profile.pluginProvenance?.kind === 'runtimeProfile')
        .map((profile) => ({
          id: profile.id,
          kind: 'runtimeProfile' as const,
          label: profile.name,
          enabled: true,
          pluginProvenance: profile.pluginProvenance
        })),
      ...taskwraithToolBundles.map((bundle) => ({
        id: bundle.id,
        kind: 'toolBundle' as const,
        label: bundle.bundle.label,
        enabled: true,
        pluginProvenance: bundle.pluginProvenance
      })),
      ...workflowTemplates.map((template) => ({
        id: template.id,
        kind: 'workflowTemplate' as const,
        label: template.template.name,
        enabled: true,
        pluginProvenance: template.pluginProvenance
      })),
      ...connectors.map((connector) => ({
        id: connector.id,
        kind: 'connector' as const,
        label: connector.connector.label,
        enabled: true,
        pluginProvenance: connector.pluginProvenance
      })),
      ...localServices.map((service) => ({
        id: service.id,
        kind: 'localService' as const,
        label: service.service.label,
        enabled: service.enabled,
        running: service.running,
        pluginProvenance: service.pluginProvenance
      })),
      ...providerSetup.map((setup) => ({
        id: setup.id,
        kind: 'providerSetup' as const,
        label: setup.setup.label || setup.setup.provider,
        enabled: true,
        pluginProvenance: setup.pluginProvenance
      })),
      ...mobileRemoteProjection.map((projection) => ({
        id: projection.id,
        kind: 'remoteProjection' as const,
        label: projection.projection.label,
        enabled: projection.enabled,
        pluginProvenance: projection.pluginProvenance
      }))
    ]

    return {
      schemaVersion: 1,
      generatedAt,
      mcpServers,
      runtimeProfileIds,
      taskwraithToolBundles,
      workflowTemplates,
      connectors,
      localServices,
      providerSetup,
      mobileRemoteProjection,
      materializedResources,
      counts: {
        enabledPlugins: contributions.counts.enabledPlugins,
        mcpServers: mcpServers.length,
        runtimeProfiles: runtimeProfileIds.length,
        taskwraithToolBundles: taskwraithToolBundles.length,
        workflowTemplates: workflowTemplates.length,
        connectors: connectors.length,
        localServices: localServices.length,
        providerSetup: providerSetup.length,
        mobileRemoteProjection: mobileRemoteProjection.length
      }
    }
  }
}
