/**
 * Wave 3.6e — stable per-install Host identity.
 *
 * Resolves the `hostId` that the Host protocol advertises in its bootstrap
 * welcome. Boss ruling `host-arc-hostid-ruling`: a UUID generated ONCE and
 * persisted INSIDE the Host runtime data directory (the same directory the
 * journal lives in).
 *
 * Why there, and not anywhere else:
 * - Stable across restarts. Clients key cached snapshots, generations and
 *   cursors on `hostId`; an id that drifts forces spurious full resnapshots.
 * - Automatically per-instance, because the Host data dir already derives
 *   from `userDataPath`. This repo genuinely runs concurrent instances with
 *   separate userData (`--taskwraith-isolated-instance`); two instances
 *   sharing one id would make clients conflate two distinct hosts.
 * - Correctly dies with Host state: wiping the Host data dir legitimately
 *   means a new host, and clients are meant to resnapshot.
 * - Survives a userData move/migration, which a path-derived id would not.
 *
 * Deliberately NOT derived from the Ed25519 pairing key (that conflates a
 * credential with a protocol id, and re-pairing would silently change host
 * identity), NOT hashed from a path, and NOT an AppStore setting (host
 * identity is not a user preference and must not be user-editable).
 *
 * Electron-free by import, and pinned so by test: this module is called from
 * the composition root as a plain value, exactly like `app.getVersion()`.
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { HOST_PROTOCOL_MAX_ID } from '../../shared/hostProtocol'

import { hostRuntimeDataDir } from '../../host-runtime/HostRuntimePaths'

/** File that carries the durable install identity, beside the Host journal. */
export const HOST_INSTALL_IDENTITY_FILE_NAME = 'host-install-identity.json'

/** Bumped only if the on-disk shape changes incompatibly. */
export const HOST_INSTALL_IDENTITY_SCHEMA_VERSION = 1

/** Lowest printable code unit; anything below is a control character. */
const FIRST_PRINTABLE_CODE_UNIT = 0x20

/** DEL. Printable-range upper exclusion. */
const DELETE_CODE_UNIT = 0x7f

/**
 * Emitted whenever this module does something a reader would be surprised by.
 *
 * A silently regenerated identity is precisely the failure that makes a client
 * look like it is hallucinating stale state: every cached snapshot is suddenly
 * keyed to a host that no longer exists. It must never be silent.
 */
export type HostInstallIdentityWarning =
  | {
      readonly kind: 'regenerated-after-damage'
      readonly identityPath: string
      readonly quarantinePath: string | null
      readonly reason: string
    }
  | {
      readonly kind: 'quarantine-failed'
      readonly identityPath: string
      readonly reason: string
    }

export interface HostInstallIdentityOptions {
  /** Absolute userData path. The Host data dir is derived from it. */
  readonly userDataPath: string
  /** Observability sink. Defaults to a console warning — never silence. */
  readonly onWarn?: (warning: HostInstallIdentityWarning) => void
  /** Test seam for deterministic ids. Defaults to `randomUUID`. */
  readonly generateId?: () => string
}

interface StoredIdentityDocument {
  readonly schemaVersion: number
  readonly hostId: string
  readonly createdAt: string
}

function defaultWarn(warning: HostInstallIdentityWarning): void {
  console.warn(`[HostInstallIdentity] ${warning.kind}: ${warning.reason}`)
}

/** True when every code unit is printable, so the id can cross a projection. */
function isPrintable(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < FIRST_PRINTABLE_CODE_UNIT || code === DELETE_CODE_UNIT) {
      return false
    }
  }
  return true
}

/**
 * A stored id is usable only if it would survive protocol validation.
 *
 * `hostProtocol.ts` gates `hostId` with `isNonEmptyString(value.hostId,
 * HOST_PROTOCOL_MAX_ID)`, so anything this returns must clear that same bar —
 * otherwise the Host would boot and then fail every bootstrap handshake.
 *
 * Intentionally shape-tolerant rather than strict-UUID: an operator who has
 * hand-written a readable id has expressed intent, and silently discarding it
 * would be the same identity-churn failure this module exists to prevent.
 */
function usableId(candidate: unknown): string | null {
  if (typeof candidate !== 'string') {
    return null
  }
  const trimmed = candidate.trim()
  if (trimmed.length === 0 || trimmed.length > HOST_PROTOCOL_MAX_ID) {
    return null
  }
  if (!isPrintable(trimmed)) {
    return null
  }
  return trimmed
}

/** Parse an on-disk document, reporting damage instead of throwing. */
function readIdentityFile(identityPath: string): { id: string } | { damage: string } {
  let raw: string
  try {
    raw = readFileSync(identityPath, 'utf8')
  } catch (err) {
    return { damage: `unreadable: ${(err as Error).message}` }
  }

  if (raw.trim().length === 0) {
    return { damage: 'file is empty' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { damage: `unparseable JSON: ${(err as Error).message}` }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { damage: 'document is not an object' }
  }

  const id = usableId((parsed as { hostId?: unknown }).hostId)
  if (id === null) {
    return { damage: 'hostId is missing, empty, over-long or non-printable' }
  }

  return { id }
}

/**
 * Move a damaged identity file aside instead of deleting it.
 *
 * THE TENSION, named explicitly because the ruling asked for a documented side
 * rather than a silent default:
 *   - Regenerating changes host identity and invalidates every client cache.
 *   - Refusing to boot makes the Host unrecoverable without manual filesystem
 *     surgery over a single damaged byte.
 *
 * CHOSEN SIDE: regenerate, loudly, and preserve the evidence. An un-bootable
 * Host is strictly worse than a re-identified one — a user can always re-pair
 * a client, but they cannot start a Host that refuses to run, and the goal
 * requires that stopping Host stay a deliberate user action rather than an
 * accident of one corrupt byte. A forced resnapshot is a recoverable cost; an
 * unstartable Host is not. Quarantine keeps the original bytes for forensics,
 * and the warning makes the identity change observable rather than silent.
 */
function quarantineDamagedFile(
  identityPath: string,
  warn: (warning: HostInstallIdentityWarning) => void,
  damage: string
): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const quarantinePath = `${identityPath}.corrupt-${stamp}`
  try {
    renameSync(identityPath, quarantinePath)
    warn({ kind: 'regenerated-after-damage', identityPath, quarantinePath, reason: damage })
  } catch (err) {
    // Could not preserve it; say so rather than pretending the quarantine
    // happened. The identity still regenerates — booting matters more.
    warn({
      kind: 'quarantine-failed',
      identityPath,
      reason: `${damage} (quarantine failed: ${(err as Error).message})`
    })
    warn({ kind: 'regenerated-after-damage', identityPath, quarantinePath: null, reason: damage })
  }
}

/**
 * Durably create the identity file, then return whoever actually won.
 *
 * tmp + fsync + rename keeps a crash from leaving a torn file. The read-back
 * is what makes two racing first-boot callers converge: whichever rename lands
 * last is the file both callers subsequently read.
 *
 * HONEST LIMIT: this narrows the first-boot race, it does not eliminate it.
 * If caller A renames, A reads back, and only then B renames, A returns the id
 * it read while the file now holds B's. Closing that fully needs an exclusive
 * create or a lock. It is left open deliberately: production resolves this
 * once per process during composition, so there is no second in-process
 * caller, and the surviving window is bounded by two adjacent syscalls.
 */
function createIdentityFile(
  hostDataDir: string,
  identityPath: string,
  generateId: () => string
): string {
  const candidate = usableId(generateId()) ?? randomUUID()
  const document: StoredIdentityDocument = {
    schemaVersion: HOST_INSTALL_IDENTITY_SCHEMA_VERSION,
    hostId: candidate,
    createdAt: new Date().toISOString()
  }

  mkdirSync(hostDataDir, { recursive: true })

  const tmpPath = `${identityPath}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmpPath, `${JSON.stringify(document)}\n`, { encoding: 'utf8', mode: 0o600 })
  const fd = openSync(tmpPath, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }

  try {
    renameSync(tmpPath, identityPath)
  } catch (err) {
    // Never leave scratch behind if the rename could not complete.
    try {
      unlinkSync(tmpPath)
    } catch {
      /* already gone; nothing to clean up */
    }
    throw err
  }

  const readBack = readIdentityFile(identityPath)
  return 'id' in readBack ? readBack.id : candidate
}

/**
 * Resolve this install's stable `hostId`, creating it on first boot.
 *
 * Safe to call before the Host data directory exists: the composition root
 * evaluates this inside the options literal, which runs BEFORE the bootstrap
 * that would otherwise have created the directory.
 */
export function resolveHostInstallId(options: HostInstallIdentityOptions): string {
  if (!options || typeof options !== 'object') {
    throw new Error('HostInstallIdentity requires an options object')
  }
  if (typeof options.userDataPath !== 'string' || options.userDataPath.trim().length === 0) {
    throw new Error('HostInstallIdentity requires an injected userDataPath')
  }

  const warn = options.onWarn ?? defaultWarn
  const generateId = options.generateId ?? randomUUID
  const hostDataDir = hostRuntimeDataDir(options.userDataPath)
  const identityPath = join(hostDataDir, HOST_INSTALL_IDENTITY_FILE_NAME)

  if (existsSync(identityPath)) {
    const existing = readIdentityFile(identityPath)
    if ('id' in existing) {
      return existing.id
    }
    quarantineDamagedFile(identityPath, warn, existing.damage)
  }

  return createIdentityFile(hostDataDir, identityPath, generateId)
}

/** Absolute path of the identity file for an injected userData path. Pure. */
export function hostInstallIdentityPath(userDataPath: string): string {
  return join(hostRuntimeDataDir(userDataPath), HOST_INSTALL_IDENTITY_FILE_NAME)
}
