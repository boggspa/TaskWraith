import type { ExtensionSecretMutationResult, ExtensionSecretRef } from './ExtensionSecretStore'
import { canPersistPlaintextFieldValue } from './PlaintextSecretPolicy'

type SecretSetter = (ref: ExtensionSecretRef, value: string) => Pick<ExtensionSecretMutationResult, 'ok'>

export interface ExtensionSecretMigrationResult<T> {
  value: T
  changed: boolean
  migrated: number
  failed: number
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_KEY_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function uniqueStrings(value: unknown, re: RegExp): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(
    new Set(value.filter((item): item is string => typeof item === 'string' && re.test(item)))
  )
}

function addRefName(secretRefs: Record<string, unknown>, key: 'env' | 'headers', name: string, re: RegExp): void {
  const names = uniqueStrings(secretRefs[key], re)
  if (!names.includes(name)) names.push(name)
  secretRefs[key] = names
}

function migrateFieldMap(input: {
  ownerKind: 'userMcpServer' | 'runtimeProfile'
  ownerId: string
  fieldKind: 'env' | 'header'
  fields: Record<string, unknown>
  secretRefs: Record<string, unknown>
  secretRefKey: 'env' | 'headers'
  keyRe: RegExp
  setSecret: SecretSetter
}): { fields: Record<string, unknown>; secretRefs: Record<string, unknown>; changed: boolean; migrated: number; failed: number } {
  const fields = { ...input.fields }
  const secretRefs = { ...input.secretRefs }
  let changed = false
  let migrated = 0
  let failed = 0
  for (const [key, value] of Object.entries(input.fields)) {
    if (!input.keyRe.test(key) || typeof value !== 'string') continue
    if (canPersistPlaintextFieldValue({ key, value, kind: input.fieldKind })) continue
    const ref = {
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      fieldKind: input.fieldKind,
      fieldName: key
    } as ExtensionSecretRef
    const result = input.setSecret(ref, value)
    if (!result.ok) {
      failed += 1
      continue
    }
    delete fields[key]
    addRefName(secretRefs, input.secretRefKey, key, input.keyRe)
    changed = true
    migrated += 1
  }
  return { fields, secretRefs, changed, migrated, failed }
}

export function migrateUserMcpServerPlaintextSecrets(
  serversInput: unknown,
  setSecret: SecretSetter
): ExtensionSecretMigrationResult<unknown> {
  if (!Array.isArray(serversInput)) {
    return { value: serversInput, changed: false, migrated: 0, failed: 0 }
  }
  let changed = false
  let migrated = 0
  let failed = 0
  const servers = serversInput.map((item) => {
    if (!isRecord(item)) return item
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) return item
    const next = { ...item }
    let secretRefs = isRecord(item.secretRefs) ? { ...item.secretRefs } : {}

    if (isRecord(item.env)) {
      const result = migrateFieldMap({
        ownerKind: 'userMcpServer',
        ownerId: id,
        fieldKind: 'env',
        fields: item.env,
        secretRefs,
        secretRefKey: 'env',
        keyRe: ENV_KEY_RE,
        setSecret
      })
      if (result.changed) {
        next.env = Object.keys(result.fields).length > 0 ? result.fields : undefined
        secretRefs = result.secretRefs
        changed = true
      }
      migrated += result.migrated
      failed += result.failed
    }

    if (isRecord(item.headers)) {
      const result = migrateFieldMap({
        ownerKind: 'userMcpServer',
        ownerId: id,
        fieldKind: 'header',
        fields: item.headers,
        secretRefs,
        secretRefKey: 'headers',
        keyRe: HEADER_KEY_RE,
        setSecret
      })
      if (result.changed) {
        next.headers = Object.keys(result.fields).length > 0 ? result.fields : undefined
        secretRefs = result.secretRefs
        changed = true
      }
      migrated += result.migrated
      failed += result.failed
    }

    if (Object.keys(secretRefs).length > 0) next.secretRefs = secretRefs
    if (next.env === undefined) delete next.env
    if (next.headers === undefined) delete next.headers
    return next
  })
  return { value: changed ? servers : serversInput, changed, migrated, failed }
}

export function migrateRuntimeProfilePlaintextSecrets(
  profilesInput: unknown,
  setSecret: SecretSetter
): ExtensionSecretMigrationResult<unknown> {
  if (!Array.isArray(profilesInput)) {
    return { value: profilesInput, changed: false, migrated: 0, failed: 0 }
  }
  let changed = false
  let migrated = 0
  let failed = 0
  const profiles = profilesInput.map((item) => {
    if (!isRecord(item)) return item
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id || !isRecord(item.env)) return item
    const secretRefs = isRecord(item.secretRefs) ? { ...item.secretRefs } : {}
    const result = migrateFieldMap({
      ownerKind: 'runtimeProfile',
      ownerId: id,
      fieldKind: 'env',
      fields: item.env,
      secretRefs,
      secretRefKey: 'env',
      keyRe: ENV_KEY_RE,
      setSecret
    })
    migrated += result.migrated
    failed += result.failed
    if (!result.changed) return item
    changed = true
    const next = {
      ...item,
      env: Object.keys(result.fields).length > 0 ? result.fields : undefined,
      secretRefs: result.secretRefs
    }
    if (next.env === undefined) delete next.env
    return next
  })
  return { value: changed ? profiles : profilesInput, changed, migrated, failed }
}
