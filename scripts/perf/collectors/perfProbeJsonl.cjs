'use strict'

/**
 * Perf probe JSONL ingestion (write/fsync/rename byte + duration rows).
 * Pure parser — pairs with scripts/perf/preloadProbe.cjs (disabled by default).
 */

/**
 * @param {string} text
 * @param {{ parseLine?: (line: string) => object | null }} [adapters]
 */
function ingestPerfProbeJsonl(text, adapters = {}) {
  if (typeof text !== 'string') throw new Error('probe JSONL text required')
  const parseLine =
    adapters.parseLine ||
    ((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  /** @type {object[]} */
  const rows = []
  let parseErrors = 0
  for (const line of lines) {
    const row = parseLine(line)
    if (!row || typeof row !== 'object') {
      parseErrors++
      continue
    }
    rows.push(row)
  }

  let writeBytesTotal = 0
  let fsyncCount = 0
  let renameCount = 0
  let persistenceSyncOver16msCount = 0
  /** @type {number[]} */
  const writeDurationsMs = []
  /** @type {number[]} */
  const fsyncDurationsMs = []
  /** @type {number[]} */
  const stringifyDurationsMs = []
  let stringifyUnsupported = false

  for (const row of rows) {
    const kind = row.kind || row.op
    const bytes = typeof row.bytes === 'number' ? row.bytes : 0
    const durationMs = typeof row.durationMs === 'number' ? row.durationMs : 0
    if (kind === 'write' || kind === 'writeFileSync' || kind === 'fs_write') {
      writeBytesTotal += bytes
      writeDurationsMs.push(durationMs)
      if (durationMs > 16) persistenceSyncOver16msCount++
    } else if (kind === 'fsync' || kind === 'fsyncSync') {
      fsyncCount++
      fsyncDurationsMs.push(durationMs)
      if (durationMs > 16) persistenceSyncOver16msCount++
    } else if (kind === 'rename' || kind === 'renameSync') {
      renameCount++
      if (durationMs > 16) persistenceSyncOver16msCount++
    } else if (kind === 'stringify' || kind === 'json_stringify') {
      if (row.unsupported === true) stringifyUnsupported = true
      else stringifyDurationsMs.push(durationMs)
    } else if (kind === 'stringify_unsupported') {
      stringifyUnsupported = true
    }
  }

  return {
    rowCount: rows.length,
    parseErrors,
    writeBytesTotal,
    fsyncCount,
    renameCount,
    persistenceSyncOver16msCount,
    writeDurationsMs,
    fsyncDurationsMs,
    stringifyDurationsMs,
    stringifyMsUnsupported: stringifyUnsupported || stringifyDurationsMs.length === 0,
    rows
  }
}

module.exports = {
  ingestPerfProbeJsonl
}
