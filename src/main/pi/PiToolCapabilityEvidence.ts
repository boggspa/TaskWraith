/**
 * Pi's catalogue evidence for the run tool capability receipt.
 *
 * Pi is the first lane outside AntiGravity to write the receipt's observation
 * half, and the reason is its readiness marker. The managed extension is
 * app-created, the host fixes its tool list before launch, and the marker is
 * all-or-nothing over exactly that list: Pi prints it only once the extension
 * has attached and every one of those routes exists. That is an ATTACHMENT
 * fact, which is what `attached` was defined to carry.
 *
 * What the marker is NOT is Pi observing its own catalogue back to us. Pi never
 * enumerates its tool list, so `observed` stays null on both surfaces, and
 * `served` stays null too because this transport has no tools/list anywhere.
 * Native `attached` stays null as well: the marker says nothing about whether
 * pi's own read/grep/find/ls are present, only about the managed extension.
 */

import type { ToolCatalogueEvidence } from '../providers/RunToolCapabilityReceipt'

/**
 * The receipt surface this module needs. Type-only, so nothing is imported at
 * runtime, and taken from the receipt's own evidence type so a widened source
 * union cannot silently drift away from what this writer is allowed to record.
 */
export interface PiToolCatalogueReporter {
  requireManagedTools(required: readonly string[]): void
  catalogue(
    surface: 'native' | 'managed',
    evidence: Omit<ToolCatalogueEvidence, 'generation'>,
    generation?: number
  ): boolean
  connection(
    status: 'unknown' | 'configured' | 'ready' | 'unavailable',
    reason?: string,
    generation?: number
  ): boolean
}

const clean = (names: readonly string[]): string[] =>
  names
    .map((name) => (typeof name === 'string' ? name.trim() : ''))
    .filter((name) => name.length > 0)

/**
 * The exact tool list this run's argv carries.
 *
 * Read from the argv rather than recomputed from the constants the builder used,
 * so the receipt cannot drift from what Pi was actually told. `--tools` is a
 * single comma-joined value (see buildPiRpcArgs), and an absent flag means the
 * host passed no allowlist at all.
 */
export function piToolsFromArgs(args: readonly string[]): string[] {
  const flag = args.lastIndexOf('--tools')
  if (flag < 0 || flag + 1 >= args.length) return []
  return clean(String(args[flag + 1]).split(','))
}

/**
 * Record what the host arranged for this run, before Pi starts.
 *
 * Both catalogues are `host-config`, so they land on `advertised`: the host
 * wrote the argv and the extension manifest, which proves what was OFFERED and
 * nothing about what Pi can see. `connection` is only touched when the run
 * actually wants managed tools; a run that never asked for a broker has no
 * connection state to report and is left unknown rather than described.
 */
export function configurePiRunToolReceipt(
  receipt: PiToolCatalogueReporter | null | undefined,
  input: {
    nativeTools: readonly string[]
    managedTools: readonly string[]
    managedPrepared: boolean
    failure?: string | null
  }
): void {
  if (!receipt) return
  const nativeTools = clean(input.nativeTools)
  const managedTools = clean(input.managedTools)
  try {
    receipt.requireManagedTools(managedTools)
    if (nativeTools.length > 0) {
      receipt.catalogue('native', {
        names: nativeTools,
        source: 'host-config',
        complete: true,
        namespace: null
      })
    }
    if (managedTools.length === 0) return
    receipt.catalogue('managed', {
      names: managedTools,
      source: 'host-config',
      complete: true,
      namespace: null
    })
    if (input.managedPrepared) {
      receipt.connection('configured')
      return
    }
    receipt.connection(
      'unavailable',
      input.failure?.trim() || 'The Pi managed tool extension was not prepared for this run.'
    )
  } catch {
    /* Evidence recording cannot change run authority. */
  }
}

/**
 * Promote the managed route once Pi prints the readiness marker.
 *
 * The marker is the extension's own confirmation that it attached with exactly
 * this fixed list, so the catalogue is complete for what it covers. It still
 * says nothing about Pi's own native tools, and it is not a model-side
 * observation, so only the managed `attached` field moves.
 */
export function recordPiAttachedTools(
  receipt: PiToolCatalogueReporter | null | undefined,
  managedTools: readonly string[]
): boolean {
  if (!receipt) return false
  const names = clean(managedTools)
  if (names.length === 0) return false
  try {
    const recorded = receipt.catalogue('managed', {
      names,
      source: 'extension-ready',
      complete: true,
      namespace: null
    })
    receipt.connection('ready')
    return recorded
  } catch {
    return false
  }
}
