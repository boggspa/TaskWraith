import type { TaskWraithPluginResourceProvenance } from '../../../shared/plugins/PluginTypes'
import type {
  AppSettings,
  ProductUpdateChangelog,
  RuntimeProfileSecretRefs,
  UserMcpServerConfig
} from '../types'

export function objectOrUndefined<T extends object>(value: T | null | undefined): T | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

export function normalizeKeyCommandBindings(
  value: Partial<AppSettings>['keyCommandBindings']
): AppSettings['keyCommandBindings'] {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return {}
  const normalized: AppSettings['keyCommandBindings'] = {}
  for (const [id, binding] of Object.entries(record)) {
    if (binding === null) {
      normalized[id] = null
      continue
    }
    const bindingRecord = objectOrUndefined(binding as Record<string, unknown> | null | undefined)
    if (!bindingRecord) continue
    const key = typeof bindingRecord.key === 'string' ? bindingRecord.key.trim() : ''
    if (!key) continue
    const modifiers = Array.isArray(bindingRecord.modifiers)
      ? bindingRecord.modifiers.filter(
          (modifier): modifier is 'primary' | 'shift' | 'alt' =>
            modifier === 'primary' || modifier === 'shift' || modifier === 'alt'
        )
      : []
    normalized[id] = { key, modifiers }
  }
  return normalized
}

export function isValidUserMcpRemoteUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeRuntimeProfileSecretRefs(
  value: unknown
): RuntimeProfileSecretRefs | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  const env = Array.isArray(record?.env)
    ? Array.from(
        new Set(
          record.env.filter(
            (key): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
          )
        )
      ).slice(0, 64)
    : []
  return env.length > 0 ? { env } : undefined
}

export function normalizePluginResourceProvenance(
  value: unknown
): TaskWraithPluginResourceProvenance | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return undefined
  const stringField = (key: string): string => {
    const raw = record[key]
    return typeof raw === 'string' ? raw.trim() : ''
  }
  const source =
    record.source === 'builtin' || record.source === 'local' || record.source === 'marketplace'
      ? record.source
      : undefined
  const kind =
    record.kind === 'mcpServer' ||
    record.kind === 'toolBundle' ||
    record.kind === 'workflowTemplate' ||
    record.kind === 'runtimeProfile' ||
    record.kind === 'connector' ||
    record.kind === 'localService' ||
    record.kind === 'providerSetup' ||
    record.kind === 'remoteProjection'
      ? record.kind
      : undefined
  const pluginId = stringField('pluginId')
  const publisher = stringField('publisher')
  const version = stringField('version')
  const namespace = stringField('namespace')
  const manifestHash = stringField('manifestHash')
  const objectId = stringField('objectId')
  const materializedAt = stringField('materializedAt')
  if (
    !pluginId ||
    !publisher ||
    !version ||
    !source ||
    !namespace ||
    !manifestHash ||
    !kind ||
    !objectId ||
    !materializedAt
  ) {
    return undefined
  }
  return {
    pluginId,
    publisher,
    version,
    source,
    namespace,
    manifestHash,
    kind,
    objectId,
    materializedAt
  }
}

export function normalizePluginReviewState(value: unknown): UserMcpServerConfig['pluginReview'] {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record) return undefined
  const status =
    record.status === 'pending' || record.status === 'accepted' ? record.status : undefined
  const reason =
    record.reason === 'new-plugin-resource' ||
    record.reason === 'manifest-update' ||
    record.reason === 'user-enabled-reviewed-resource'
      ? record.reason
      : undefined
  const manifestHash = typeof record.manifestHash === 'string' ? record.manifestHash.trim() : ''
  const reviewedAt = typeof record.reviewedAt === 'string' ? record.reviewedAt.trim() : ''
  if (!status || !reason || !manifestHash) return undefined
  return {
    status,
    reason,
    manifestHash,
    ...(reviewedAt ? { reviewedAt } : {})
  }
}

export function normalizeUserMcpServers(value: unknown): UserMcpServerConfig[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const servers: UserMcpServerConfig[] = []
  for (const item of value.slice(0, 64)) {
    const record = objectOrUndefined(item as Record<string, unknown> | null | undefined)
    if (!record) continue
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    const transport =
      record.transport === 'http' || record.transport === 'sse' ? record.transport : 'stdio'
    const args = Array.isArray(record.args)
      ? record.args
          .filter((arg): arg is string => typeof arg === 'string')
          .map((arg) => arg.trim())
          .filter(Boolean)
          .slice(0, 64)
      : []
    const envRecord = objectOrUndefined(record.env as Record<string, unknown> | null | undefined)
    const env = envRecord
      ? Object.fromEntries(
          Object.entries(envRecord)
            .filter(([key, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof val === 'string')
            .map(([key, val]) => [key, val])
            .slice(0, 64)
        )
      : {}
    const headersRecord = objectOrUndefined(
      record.headers as Record<string, unknown> | null | undefined
    )
    const headers = headersRecord
      ? Object.fromEntries(
          Object.entries(headersRecord)
            .filter(
              ([key, val]) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) && typeof val === 'string'
            )
            .map(([key, val]) => [key, val])
            .slice(0, 64)
        )
      : {}
    const secretRefsRecord = objectOrUndefined(
      record.secretRefs as Record<string, unknown> | null | undefined
    )
    const secretEnvRefs = Array.isArray(secretRefsRecord?.env)
      ? Array.from(
          new Set(
            secretRefsRecord.env.filter(
              (key): key is string =>
                typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const secretHeaderRefs = Array.isArray(secretRefsRecord?.headers)
      ? Array.from(
          new Set(
            secretRefsRecord.headers.filter(
              (key): key is string =>
                typeof key === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)
            )
          )
        ).slice(0, 64)
      : []
    const command = typeof record.command === 'string' ? record.command.trim() : ''
    const rawUrl = typeof record.url === 'string' ? record.url.trim() : ''
    const url = rawUrl && isValidUserMcpRemoteUrl(rawUrl) ? rawUrl : ''
    const bearerTokenEnvVar =
      typeof record.bearerTokenEnvVar === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(record.bearerTokenEnvVar.trim())
        ? record.bearerTokenEnvVar.trim()
        : ''
    const pluginProvenance = normalizePluginResourceProvenance(record.pluginProvenance)
    const pluginReview = normalizePluginReviewState(record.pluginReview)
    const canEnable = transport === 'stdio' ? Boolean(command) : Boolean(url)
    const normalized: UserMcpServerConfig = {
      id,
      name,
      enabled: Boolean(record.enabled && canEnable),
      transport
    }
    if (command) normalized.command = command
    if (args.length > 0) normalized.args = args
    if (url) normalized.url = url
    if (Object.keys(env).length > 0) normalized.env = env
    if (Object.keys(headers).length > 0) normalized.headers = headers
    if (secretEnvRefs.length > 0 || secretHeaderRefs.length > 0) {
      normalized.secretRefs = {
        ...(secretEnvRefs.length > 0 ? { env: secretEnvRefs } : {}),
        ...(secretHeaderRefs.length > 0 ? { headers: secretHeaderRefs } : {})
      }
    }
    if (bearerTokenEnvVar) normalized.bearerTokenEnvVar = bearerTokenEnvVar
    if (typeof record.description === 'string' && record.description.trim()) {
      normalized.description = record.description.trim()
    }
    if (pluginProvenance) normalized.pluginProvenance = pluginProvenance
    if (pluginReview) normalized.pluginReview = pluginReview
    if (typeof record.createdAt === 'string' && record.createdAt.trim()) {
      normalized.createdAt = record.createdAt.trim()
    }
    if (typeof record.updatedAt === 'string' && record.updatedAt.trim()) {
      normalized.updatedAt = record.updatedAt.trim()
    }
    servers.push(normalized)
  }
  return servers
}

export function normalizeUpdateChangelog(value: unknown): ProductUpdateChangelog | undefined {
  const record = objectOrUndefined(value as Record<string, unknown> | null | undefined)
  if (!record || typeof record.version !== 'string' || !record.version.trim()) {
    return undefined
  }
  const releaseNotes = record.releaseNotes
  const normalized: ProductUpdateChangelog = {
    version: record.version.trim()
  }
  if (typeof record.releaseName === 'string' && record.releaseName.trim()) {
    normalized.releaseName = record.releaseName.trim()
  }
  if (typeof record.releaseDate === 'string' && record.releaseDate.trim()) {
    normalized.releaseDate = record.releaseDate.trim()
  }
  if (typeof releaseNotes === 'string') {
    normalized.releaseNotes = releaseNotes
  } else if (Array.isArray(releaseNotes)) {
    const notes = releaseNotes
      .map((item) => {
        const noteRecord = objectOrUndefined(item as Record<string, unknown> | null | undefined)
        if (!noteRecord || typeof noteRecord.version !== 'string' || !noteRecord.version.trim()) {
          return null
        }
        return {
          version: noteRecord.version.trim(),
          note: typeof noteRecord.note === 'string' ? noteRecord.note : null
        }
      })
      .filter((item): item is { version: string; note: string | null } => item !== null)
    if (notes.length > 0) {
      normalized.releaseNotes = notes
    }
  }
  return normalized
}
