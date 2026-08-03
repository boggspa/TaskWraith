'use strict'

/**
 * Disabled-by-default preload probe design for fs write / fsync / rename
 * byte + duration capture (T1b).
 *
 * This module is harness-only design + unit-testable helpers. It does NOT
 * patch production Electron preload. Enable only under isolated perf runs
 * via PERF_PRELOAD_PROBE=1 (documented; not wired to launch in T1b).
 *
 * Stringify timing: when the probe cannot wrap JSON.stringify on the main
 * persist path, emit stringify_unsupported and leave metrics.stringifyMsUnsupported
 * true so T2 fails closed rather than inventing numbers.
 */

const DEFAULT_ENABLED = false

/**
 * @param {object} [env]
 */
function isPreloadProbeEnabled(env = process.env) {
  const raw = env && env.PERF_PRELOAD_PROBE
  if (raw == null || raw === '') return DEFAULT_ENABLED
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Build a probe sink that records JSONL rows through an injected writer.
 * @param {object} options
 * @param {(line: string) => void} options.writeLine
 * @param {() => number} [options.nowMs]
 * @param {boolean} [options.enabled]
 * @param {object} [options.env]
 */
function createPreloadProbe(options) {
  if (!options || typeof options.writeLine !== 'function') {
    throw new Error('writeLine adapter required')
  }
  const enabled =
    typeof options.enabled === 'boolean'
      ? options.enabled
      : isPreloadProbeEnabled(options.env || process.env)
  const nowMs = options.nowMs || (() => Date.now())

  /**
   * @param {string} kind
   * @param {object} [fields]
   */
  function emit(kind, fields = {}) {
    if (!enabled) return null
    const row = {
      schemaVersion: 1,
      kind,
      ts: nowMs(),
      ...fields
    }
    options.writeLine(JSON.stringify(row))
    return row
  }

  /**
   * Wrap a sync write-like function.
   * @param {Function} fn
   * @param {string} [kind]
   */
  function wrapSyncFsOp(fn, kind = 'write') {
    if (!enabled) return fn
    return function probedFsOp(...args) {
      const started = nowMs()
      try {
        const result = fn.apply(this, args)
        const durationMs = Math.max(0, nowMs() - started)
        let bytes = 0
        if (typeof args[1] === 'string') bytes = Buffer.byteLength(args[1], 'utf8')
        else if (Buffer.isBuffer(args[1])) bytes = args[1].length
        else if (typeof args[0] === 'string' && kind === 'rename') bytes = 0
        emit(kind, { bytes, durationMs, path: typeof args[0] === 'string' ? args[0] : null })
        return result
      } catch (err) {
        const durationMs = Math.max(0, nowMs() - started)
        emit(kind, {
          bytes: 0,
          durationMs,
          path: typeof args[0] === 'string' ? args[0] : null,
          error: true
        })
        throw err
      }
    }
  }

  /**
   * Attempt to observe JSON.stringify duration. If unsupported, emit that fact.
   * @param {Function} [stringifyFn]
   */
  function wrapStringifyOrMarkUnsupported(stringifyFn) {
    if (!enabled) {
      return { supported: false, stringify: stringifyFn || JSON.stringify }
    }
    if (typeof stringifyFn !== 'function') {
      emit('stringify_unsupported', { reason: 'no_stringify_wrapper_target' })
      return { supported: false, stringify: JSON.stringify }
    }
    const wrapped = function probedStringify(value, replacer, space) {
      const started = nowMs()
      const out = stringifyFn(value, replacer, space)
      const durationMs = Math.max(0, nowMs() - started)
      const bytes = typeof out === 'string' ? Buffer.byteLength(out, 'utf8') : 0
      emit('stringify', { durationMs, bytes })
      return out
    }
    return { supported: true, stringify: wrapped }
  }

  return {
    enabled,
    emit,
    wrapSyncFsOp,
    wrapStringifyOrMarkUnsupported,
    /**
     * Design descriptor for T2 attach docs / reviewers.
     */
    design: {
      envFlag: 'PERF_PRELOAD_PROBE',
      defaultEnabled: DEFAULT_ENABLED,
      ops: ['write', 'fsync', 'rename', 'stringify'],
      note: 'Disabled by default. When stringify cannot be wrapped on the main persist path, emit stringify_unsupported and keep metrics.main.saveChat.stringifyMsUnsupported=true so numeric gPerf fails closed.'
    }
  }
}

module.exports = {
  DEFAULT_ENABLED,
  isPreloadProbeEnabled,
  createPreloadProbe
}
