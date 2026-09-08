[read_file: lines 1-283 of 283]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { promisify } = require('node:util')
const { loadHelper, fingerprint } = require('./common.cjs')
const { SAFE_ENV_KEYS } = require('./plan.cjs')
const { readSchemaIndex } = require('./protocol.cjs')

function privateDirectory(value, label) {
  if (!value || !path.isAbsolute(value)) throw new Error(label + '_absolute_path_required')
  const actual = fs.realpathSync(value)
  const stat = fs.lstatSync(value)
  if (
    actual !== path.resolve(value) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
  ) {
    throw new Error(label + '_private_nonsymlink_directory_required')
  }
  return actual
}

function validateLive(options, manifest) {
  if (!options.live || !options.iHaveCredentials)
    throw new Error('live_requires_explicit_credential_ack')
  const home = privateDirectory(options.codeHome, 'code_home')
  const output = privateDirectory(options.outputDir, 'output')
  const configFile = path.join(home, 'config.toml')
  if (fs.existsSync(configFile)) {
    const config = fs.lstatSync(configFile)
    if (
      !config.isFile() ||
      config.isSymbolicLink() ||
      config.size > 1024 * 1024 ||
      /\bmcp_servers\b/.test(fs.readFileSync(configFile, 'utf8'))
    ) {
      throw new Error('proof_home_must_not_contain_existing_mcp_configuration')
    }
  }
  if (output === home || output.startsWith(home + path.sep) || home.startsWith(output + path.sep)) {
    throw new Error('evidence_and_native_state_must_be_disjoint')
  }
  if (
    !manifest ||
    !path.isAbsolute(manifest.workspace || '') ||
    !manifest.bridgeCommand ||
    !manifest.endpoint?.brokerToken ||
    !manifest.endpoint?.instanceEpoch ||
    !Array.isArray(manifest.models) ||
    manifest.models.length < 2 ||
    !Array.isArray(manifest.runtimes) ||
    manifest.runtimes.length < 2
  ) {
    throw new Error('complete_real_bridge_manifest_required')
  }
  for (const role of ['solo', 'ensemble', 'mesh'])
    for (const phase of ['fresh', 'resume', 'retained']) {
      const route = manifest.routes?.[role]?.[phase]
      if (!route?.appRunId || !route?.appChatId)
        throw new Error('explicit_live_route_required:' + role + ':' + phase)
    }
  for (const runtime of manifest.runtimes) {
    if (!runtime.id || !runtime.binary || /<.*>/.test(runtime.binary))
      throw new Error('real_runtime_required')
    if (
      Object.entries(runtime.env || {}).some(
        ([key, value]) =>
          typeof value !== 'string' ||
          /^(?:CODEX_HOME|OPENAI_API_KEY|CODEX_API_KEY|TASKWRAITH_PROOF_)/i.test(key)
      )
    ) {
      throw new Error('runtime_must_not_override_home_auth_or_observer')
    }
  }
  if (manifest.models.some((value) => typeof value !== 'string' || !value || /<.*>/.test(value))) {
    throw new Error('real_models_required')
  }
  if (!manifest.directCall?.name || manifest.directCall.readOnly !== true) {
    throw new Error('operator_declared_readonly_direct_call_required')
  }
  // This probe exercises the signed write posture without writing a file.
  if (
    !/^(?:TaskWraith__)?apply_patch$/.test(manifest.permissionCall?.name || '') ||
    !(
      manifest.permissionCall?.arguments?.check === true ||
      manifest.permissionCall?.arguments?.dryRun === true
    )
  ) {
    throw new Error('permission_probe_requires_apply_patch_check_or_dry_run')
  }
  if (options.reuseExistingLogin !== Boolean(options.loginSource))
    throw new Error('login_source_requires_explicit_reuse_consent')
  if (options.reuseExistingLogin) {
    const source = privateDirectory(options.loginSource, 'login_source')
    if (
      source === home ||
      source.startsWith(home + path.sep) ||
      home.startsWith(source + path.sep)
    ) {
      throw new Error('borrow_source_and_private_home_must_be_disjoint')
    }
    if (path.basename(home) !== 'codex-home')
      throw new Error('borrow_home_must_match_canonical_codex_home_layout')
  } else {
    if (fs.existsSync(path.join(home, '.taskwraith-oauth-authority-v1', 'lease.json'))) {
      throw new Error('private_home_is_a_credential_source_with_a_lease')
    }
    const auth = fs.lstatSync(path.join(home, 'auth.json'))
    if (
      !auth.isFile() ||
      auth.isSymbolicLink() ||
      auth.nlink !== 1 ||
      (process.platform !== 'win32' && auth.mode & 0o077)
    )
      throw new Error('private_auth_file_required')
  }
  return { home, output }
}

function launchEnvironment(explicit, inherited = process.env) {
  const env = {}
  for (const key of SAFE_ENV_KEYS) if (typeof inherited[key] === 'string') env[key] = inherited[key]
  return { ...env, ...explicit }
}

async function acquireHome(options, overrides = {}) {
  const home = privateDirectory(options.codeHome, 'code_home')
  const lock = path.join(home, '.taskwraith-proof.lock')
  // Never adopt another run's lock. Crashed runs require manual reconciliation.
  fs.mkdirSync(lock, { mode: 0o700 })
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), {
    mode: 0o600,
    flag: 'wx'
  })
  let released = false
  let lease
  const unlock = () => {
    fs.unlinkSync(path.join(lock, 'owner.json'))
    fs.rmdirSync(lock)
  }
  try {
    if (options.reuseExistingLogin) {
      const helper =
        overrides.credentials || loadHelper('src/main/codex/CodexOAuthCredentialLease.ts', true)
      const acquired = await helper.acquireCodexOAuthCredentialLease({
        userDataPath: path.dirname(home),
        sourceHome: options.loginSource
      })
      if (!acquired.ok) {
        unlock()
        return { ok: false, reason: acquired.reason || 'credential_refused' }
      }
      lease = acquired.lease
      await lease.seedIntoIsolatedHome()
    }
    return {
      ok: true,
      mode: lease ? 'canonical-borrow' : 'private-login',
      async noteProviderProcess(pid) {
        if (lease) await lease.noteProviderProcess(pid)
      },
      // Caller MUST prove provider death first. On failure retain the lease/lock.
      async release() {
        if (released) return { alreadyReleased: true }
        const result = lease
          ? await lease.commitAndRelease()
          : { status: 'private-login-preserved' }
        unlock()
        released = true
        return result
      }
    }
  } catch (error) {
    // A canonical acquisition may have created durable recovery state: never
    // bypass it. Only our independent proof lock can be released here.
    unlock()
    throw error
  }
}

/** Inspect bytes, not the credential store; never export raw state or tokens. */
function scanNativeState(home, needles, { maxBytes = 64 * 1024 * 1024, maxFiles = 10000 } = {}) {
  let readBytes = 0
  let files = 0
  let censored = false
  const matches = []
  const excluded = /^(?:auth\.json|\.taskwraith-oauth-authority-v1|\.taskwraith-proof\.lock)$/
  const patterns = Object.entries(needles)
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => [name, Buffer.from(value)])
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (excluded.test(entry.name)) continue
      const filename = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        censored = true
        continue
      }
      if (entry.isDirectory()) {
        walk(filename)
        continue
      }
      if (!entry.isFile()) continue
      if (++files > maxFiles || readBytes >= maxBytes) {
        censored = true
        return
      }
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
      try {
        const size = fs.fstatSync(fd).size
        const length = Math.min(size, maxBytes - readBytes)
        const bytes = Buffer.alloc(length)
        const actual = fs.readSync(fd, bytes, 0, length, 0)
        readBytes += actual
        if (length < size || actual < length) censored = true
        const found = patterns
          .filter(([, needle]) => bytes.subarray(0, actual).includes(needle))
          .map(([name]) => name)
        if (found.length) matches.push({ nativeRelativePath: path.relative(home, filename), found })
      } finally {
        fs.closeSync(fd)
      }
    }
  }
  try {
    walk(home)
  } catch {
    censored = true
  }
  return {
    status: matches.length ? 'observed' : 'inconclusive',
    readBytes,
    files,
    censored,
    matches,
    limitation:
      'Positive raw-byte matches only; absence cannot rule out encryption, encoding, delayed writes, compression or omitted files. auth.json and the authority are excluded.'
  }
}

function readEvents(file) {
  const size = fs.statSync(file).size
  if (size > 16 * 1024 * 1024) throw new Error('proof_event_limit')
  const raw = fs.readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  lines.pop() // Writers append one whole JSON line; ignore a partial trailing write.
  return lines.filter(Boolean).map((line) => JSON.parse(line))
}

async function nativeSchemas(
  binary,
  env,
  output,
  execute = promisify(require('node:child_process').execFile)
) {
  const directory = fs.mkdtempSync(path.join(output, 'native-schema-'))
  try {
    await execute(
      binary,
      ['app-server', 'generate-json-schema', '--experimental', '--out', directory],
      { env, timeout: 30000, maxBuffer: 1024 * 1024 }
    )
    const index = readSchemaIndex(directory)
    const version = await execute(binary, ['--version'], { env, timeout: 10000, maxBuffer: 65536 })
    return { index, sha256: fingerprint(Object.fromEntries(index)), version: version.stdout.trim() }
  } finally {
    // Keep only a fingerprint in evidence, never unredacted generated JSON.
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

module.exports = {
  privateDirectory,
  validateLive,
  launchEnvironment,
  acquireHome,
  scanNativeState,
  readEvents,
  nativeSchemas
}
