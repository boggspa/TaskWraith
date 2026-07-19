#!/usr/bin/env node

// Credentialed provider permission-conformance canary orchestrator.
//
// The live suites exercise real provider binaries and may make real model calls.
// This runner therefore defaults to a read-only probe. Pass --live deliberately
// (the release entry point does) to execute live tests. A successful Vitest exit
// is not accepted on its own: every non-availability assertion must have run,
// and no assertion may be skipped.

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const REPO_ROOT = path.join(__dirname, '..')
const DEFAULT_MANIFEST_PATH = path.join(__dirname, 'provider-containment-fingerprints.json')
const DEFAULT_OUTPUT_PATH = path.join(
  REPO_ROOT,
  'artifacts',
  'provider-permission-conformance.json'
)
const DEFAULT_JUNIT_OUTPUT_PATH = path.join(
  REPO_ROOT,
  'artifacts',
  'provider-permission-conformance.xml'
)
const PROVIDERS = ['kimi', 'cursor']
const QUALIFICATION_SCOPES = Object.freeze({
  kimi: 'acp-synthetic-cwd-gateway-v1',
  cursor: 'cursor-native-sandbox-readonly-v1'
})
const KIMI_PRODUCTION_POSTURE_VERSION = 'synthetic-cwd-gateway-v1'
const KIMI_REVIEWED_ATTESTATION_SOURCE = 'credentialed-live-containment-canary'
const CURSOR_STARTUP_POSTURE_VERSION = 'cursor-native-sandbox-readonly-v1'
const CURSOR_REVIEWED_ATTESTATION_SOURCE = 'credentialed-live-containment-canary'
// Per-provider posture/attestation used by qualificationFor(). The manifest
// providers.cursor roster ships EMPTY, so no Cursor tuple can match regardless
// of these constants — Cursor stays fail-closed until a real live-canary pass
// mints its exact fingerprint. These simply make the matcher provider-aware so
// the pipeline is ready to admit the reviewed Cursor build once one exists.
const POSTURE_VERSIONS = Object.freeze({
  kimi: KIMI_PRODUCTION_POSTURE_VERSION,
  cursor: CURSOR_STARTUP_POSTURE_VERSION
})
const REVIEWED_ATTESTATION_SOURCES = Object.freeze({
  kimi: KIMI_REVIEWED_ATTESTATION_SOURCE,
  cursor: CURSOR_REVIEWED_ATTESTATION_SOURCE
})
const LIVE_TIMEOUT_MS = 25 * 60 * 1000
// Deliberately reviewed allowlist. Never glob arbitrary *.live.test.ts files on
// a credentialed worker: adding a file here is part of the release-security
// review, not ordinary test discovery. Cursor's DRAFT startup-containment suite
// is allowlisted so the pipeline is ready to qualify, but the manifest roster
// stays empty (fail-closed): a live pass mints the fingerprint before Cursor is
// ever admissible. The suite's live turn self-skips without CURSOR_API_KEY.
const REVIEWED_LIVE_TESTS = Object.freeze({
  kimi: Object.freeze(['src/main/kimi/KimiProductionContainment.live.test.ts']),
  cursor: Object.freeze(['src/main/cursor/CursorStartupContainment.live.test.ts'])
})
const REVIEWED_LIVE_ASSERTIONS = Object.freeze({
  'src/main/kimi/KimiProductionContainment.live.test.ts': Object.freeze([
    'uses the private production process/session cwd and leaves workspace project config inert',
    'advertises no ACP client fs and keeps the exact native deny roster',
    'reads the real workspace only through the authenticated TaskWraith HTTP gateway',
    'cold-starts a legacy posture through session/new without session/resume',
    'tears down the provider, gateway, private cwd, workspace, and credential home',
    'returns a same-id structured terminal denial for native FetchURL with zero client-fs fallback',
    'returns a same-id structured terminal denial for native WebSearch with zero client-fs fallback',
    'returns a same-id structured terminal denial for native AgentSwarm with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Bash with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Glob with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Grep with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Read with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Write with zero client-fs fallback',
    'returns a same-id structured terminal denial for native Edit with zero client-fs fallback',
    'rejects gateway disablement and bridge startup failure before invoking provider spawn',
    'is gated behind KIMI_ACP_LIVE_TRACE + an authenticated Kimi Code install'
  ]),
  'src/main/cursor/CursorStartupContainment.live.test.ts': Object.freeze([
    'spawns the contained read-only argv the production runtime builds (sandbox enabled, prompt guarded)',
    'never auto-executes a hostile project MCP server in a read-only turn',
    'lets an in-workspace write land but sandbox-blocks a write to the user home',
    'requires a real contained attempt and tears down the workspace and process',
    'builds a contained managed argv that enforces the sandbox and never emits force, yolo, or approve-mcps',
    'denies an unqualified cursor-agent binary while the embedded runtime roster is empty',
    'is gated behind CURSOR_API_KEY and an installed cursor-agent binary'
  ])
})

// Provider processes must not inherit arbitrary secrets from the hosted runner.
// Keep only OS/runtime plumbing and explicit network/TLS
// configuration. Authentication is never part of this generic allowlist: Kimi
// receives only a reviewed source-home path and copies its credential into an
// owned ephemeral home; disabled Cursor credentials never reach a child.
const SUBPROCESS_ENV_ALLOWLIST = [
  'HOME',
  'PATH',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'CI',
  // GitHub Actions uses this non-secret marker to reap descendants when a job
  // is cancelled. Preserve it even though provider credentials are stripped.
  'RUNNER_TRACKING_ID',
  'SYSTEMROOT',
  'WINDIR',
  'PATHEXT',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy'
]

function canarySubprocessEnv(extra = {}, source = process.env) {
  const selected = {}
  for (const key of SUBPROCESS_ENV_ALLOWLIST) {
    if (typeof source[key] === 'string') selected[key] = source[key]
  }
  return { ...selected, ...extra, FORCE_COLOR: '0', NO_COLOR: '1' }
}

function cursorUnauthenticatedProbeSourceEnv(source = process.env) {
  const selected = { ...source }
  delete selected.CURSOR_AUTH_TOKEN
  delete selected.CURSOR_API_KEY
  return selected
}

function usage() {
  return `Usage: node scripts/provider-containment-canary.cjs [options]

By default this performs only non-mutating binary/auth/capability probes.

Options:
  --live                         Run credentialed live permission-conformance tests.
  --providers=kimi,cursor        Providers to inspect (default: both).
  --require=kimi,cursor          Providers that must be available and pass.
  --require-known-fingerprints   Block live tests and fail if a required
                                 provider's fingerprint is not in the manifest.
  --manifest=<path>              Qualification manifest path.
  --output=<path>                Aggregate JSON report path.
  --junit-output=<path>          Aggregate JUnit report path.
  --help                         Show this help.

Environment overrides:
  TASKWRAITH_KIMI_CANARY_BIN     Exact Kimi binary to certify.
  TASKWRAITH_KIMI_CANARY_HOME    Kimi Code home containing config/credentials.
  TASKWRAITH_CURSOR_CANARY_BIN   Exact Cursor Agent binary to certify.
`
}

function parseProviderList(raw, flagName) {
  const values = String(raw || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  if (values.length === 0) throw new Error(`${flagName} requires at least one provider.`)
  for (const provider of values) {
    if (!PROVIDERS.includes(provider)) {
      throw new Error(`${flagName} contains unsupported provider "${provider}".`)
    }
  }
  return [...new Set(values)]
}

function takeOptionValue(argv, index, flagName) {
  const arg = argv[index]
  const prefix = `${flagName}=`
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), consumed: 0 }
  if (arg === flagName) {
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flagName} requires a value.`)
    return { value, consumed: 1 }
  }
  return null
}

function parseArgs(argv) {
  let explicitMode = null
  const options = {
    live: false,
    providers: [...PROVIDERS],
    required: [],
    requireKnownFingerprints: false,
    manifestPath: DEFAULT_MANIFEST_PATH,
    outputPath: DEFAULT_OUTPUT_PATH,
    junitOutputPath: DEFAULT_JUNIT_OUTPUT_PATH,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--live') {
      if (explicitMode === 'probe-only') {
        throw new Error('--live and --probe-only cannot be combined.')
      }
      explicitMode = 'live'
      options.live = true
      continue
    }
    if (arg === '--probe-only') {
      if (explicitMode === 'live') {
        throw new Error('--live and --probe-only cannot be combined.')
      }
      explicitMode = 'probe-only'
      options.live = false
      continue
    }
    if (arg === '--require-known-fingerprints') {
      options.requireKnownFingerprints = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    const providers = takeOptionValue(argv, index, '--providers')
    if (providers) {
      options.providers = parseProviderList(providers.value, '--providers')
      index += providers.consumed
      continue
    }
    const required = takeOptionValue(argv, index, '--require')
    if (required) {
      options.required = parseProviderList(required.value, '--require')
      index += required.consumed
      continue
    }
    const manifest = takeOptionValue(argv, index, '--manifest')
    if (manifest) {
      options.manifestPath = path.resolve(REPO_ROOT, manifest.value)
      index += manifest.consumed
      continue
    }
    const output = takeOptionValue(argv, index, '--output')
    if (output) {
      options.outputPath = path.resolve(REPO_ROOT, output.value)
      index += output.consumed
      continue
    }
    const junitOutput = takeOptionValue(argv, index, '--junit-output')
    if (junitOutput) {
      options.junitOutputPath = path.resolve(REPO_ROOT, junitOutput.value)
      index += junitOutput.consumed
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  for (const provider of options.required) {
    if (!options.providers.includes(provider)) {
      throw new Error(`Required provider "${provider}" is not in --providers.`)
    }
  }
  if (options.help && argv.some((arg) => arg !== '--help' && arg !== '-h')) {
    throw new Error('--help cannot be combined with execution or reporting options.')
  }
  if (
    !options.help &&
    options.requireKnownFingerprints &&
    (!options.live || options.required.length === 0)
  ) {
    throw new Error('--require-known-fingerprints requires --live and a non-empty --require list.')
  }
  return options
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    )
  }
  return value
}

function sha256Text(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function capabilityFingerprint(document) {
  return sha256Text(JSON.stringify(stableValue(document)))
}

const BINARY_STAT_FIELDS = Object.freeze([
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'blksize',
  'blocks',
  'mtimeNs',
  'ctimeNs'
])

function binaryStatSnapshot(stat) {
  return Object.fromEntries(BINARY_STAT_FIELDS.map((field) => [field, String(stat[field] ?? '')]))
}

function sameBinaryIdentity(left, right) {
  if (!left || !right || left.realPath !== right.realPath || left.sha256 !== right.sha256) {
    return false
  }
  return BINARY_STAT_FIELDS.every((field) => left.stat[field] === right.stat[field])
}

async function assertPinnedFileIdentity(sourcePath, expectedIdentity, label) {
  const current = await captureBinaryIdentity(sourcePath)
  if (!sameBinaryIdentity(expectedIdentity, current)) {
    throw new Error(`${label} identity changed`)
  }
}

/**
 * Resolve a provider executable once, open that exact realpath, and bind the
 * digest to descriptor fstat metadata. Path stat + source realpath are checked
 * after the descriptor read so a symlink or inode swap cannot bind bytes from
 * one file to metadata from another. Live execution repeats this capture before
 * and after every suite.
 */
async function captureBinaryIdentity(sourcePath, testHooks = {}) {
  const realPathBefore = await fs.promises.realpath(sourcePath)
  const handle = await fs.promises.open(realPathBefore, 'r')
  try {
    const statBefore = await handle.stat({ bigint: true })
    if (!statBefore.isFile()) {
      throw new Error('resolved provider executable is not a regular file')
    }
    if (statBefore.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('resolved provider executable is too large to hash safely')
    }

    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    const expectedBytes = Number(statBefore.size)
    let position = 0
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead <= 0) {
        throw new Error('provider executable ended while it was being hashed')
      }
      hash.update(buffer.subarray(0, bytesRead))
      position += bytesRead
    }

    // Deterministic unit-test seam for a path swap after the descriptor bytes
    // are read but before descriptor/path identity is joined. Production never
    // supplies this hook.
    if (typeof testHooks.afterDescriptorHash === 'function') {
      await testHooks.afterDescriptorHash()
    }

    const statAfter = await handle.stat({ bigint: true })
    const pathStatAfter = await fs.promises.stat(realPathBefore, { bigint: true })
    const realPathAfter = await fs.promises.realpath(sourcePath)
    const before = binaryStatSnapshot(statBefore)
    const after = binaryStatSnapshot(statAfter)
    const pathAfter = binaryStatSnapshot(pathStatAfter)
    if (
      realPathBefore !== realPathAfter ||
      !statAfter.isFile() ||
      !pathStatAfter.isFile() ||
      BINARY_STAT_FIELDS.some(
        (field) => before[field] !== after[field] || after[field] !== pathAfter[field]
      )
    ) {
      throw new Error('provider executable identity changed while it was being captured')
    }
    return {
      realPath: realPathBefore,
      sha256: `sha256:${hash.digest('hex')}`,
      stat: after
    }
  } finally {
    await handle.close()
  }
}

function extractLongFlags(text) {
  const flags = new Set()
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('-')) continue
    for (const match of trimmed.matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(match[0])
  }
  return [...flags].sort()
}

function extractCommands(text) {
  const lines = String(text || '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line.trim()))
  if (start === -1) return []
  const commands = new Set()
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) break
    const match = line.match(/^\s{2,4}([a-z][a-z0-9-]*)\b/)
    if (match && /\s{2,}\S/.test(line.slice(match[0].length))) commands.add(match[1])
  }
  return [...commands].sort()
}

function displayPath(filePath) {
  if (!filePath) return null
  const home = os.homedir()
  if (filePath === home) return '~'
  if (filePath.startsWith(`${home}${path.sep}`)) return `~${filePath.slice(home.length)}`
  const relative = path.relative(REPO_ROOT, filePath)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  return `<external>/${path.basename(filePath)}`
}

function hasConfiguredKimiApiKey(configBody) {
  let inKimiProvider = false
  let hasKimiType = false
  let hasApiKey = false
  const complete = () => inKimiProvider && hasKimiType && hasApiKey
  for (const line of String(configBody || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    const table = trimmed.match(/^\[providers\.(?:"kimi"|kimi)\]$/)
    if (/^\[/.test(trimmed)) {
      if (complete()) return true
      inKimiProvider = Boolean(table)
      hasKimiType = false
      hasApiKey = false
      continue
    }
    if (!inKimiProvider || !trimmed || trimmed.startsWith('#')) continue
    if (/^type\s*=\s*["']kimi["']\s*(?:#.*)?$/.test(trimmed)) hasKimiType = true
    const apiKey = trimmed.match(/^api_key\s*=\s*(["'])(.+)\1\s*(?:#.*)?$/)
    if (apiKey && apiKey[2].trim().length > 0) hasApiKey = true
  }
  return complete()
}

function parseKimiConfigContract(configBody) {
  const top = {}
  const providers = new Map()
  const models = new Map()
  let section = { kind: 'top', name: '' }
  for (const line of String(configBody || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const providerHeader = trimmed.match(/^\[providers\.(?:"([^"]+)"|([A-Za-z0-9:_-]+))\]$/)
    const modelHeader = trimmed.match(/^\[models\."([^"]+)"\]$/)
    if (providerHeader) {
      section = { kind: 'provider', name: providerHeader[1] || providerHeader[2] }
      if (!providers.has(section.name)) providers.set(section.name, {})
      continue
    }
    if (modelHeader) {
      section = { kind: 'model', name: modelHeader[1] }
      if (!models.has(section.name)) models.set(section.name, {})
      continue
    }
    if (/^\[/.test(trimmed)) {
      section = { kind: 'other', name: '' }
      continue
    }
    const assignment = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*(["'])(.*?)\2\s*(?:#.*)?$/)
    if (!assignment) continue
    const [, key, , value] = assignment
    if (section.kind === 'top') top[key] = value
    else if (section.kind === 'provider') providers.get(section.name)[key] = value
    else if (section.kind === 'model') models.get(section.name)[key] = value
  }
  const modelAlias = top.default_model
  const model = modelAlias ? models.get(modelAlias) : null
  const provider = model?.provider ? providers.get(model.provider) : null
  if (
    !modelAlias ||
    !model ||
    !provider ||
    provider.type !== 'kimi' ||
    !provider.api_key ||
    !provider.base_url ||
    !model.model
  ) {
    return null
  }
  return {
    authentication: provider.base_url.includes('api.kimi.com')
      ? 'kimi-code-provider-api-key'
      : 'kimi-platform-provider-api-key',
    providerType: provider.type,
    backendBaseUrl: provider.base_url,
    modelAlias,
    model: model.model
  }
}

function capture(
  command,
  args,
  timeoutMs = 15_000,
  extraEnv = {},
  sourceEnv = process.env,
  cwd = REPO_ROOT
) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: canarySubprocessEnv(extraEnv, sourceEnv)
  })
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.status,
    signal: result.signal || null,
    error: result.error ? result.error.message : null
  }
}

function providerInventoryProbeLayout(provider, root) {
  const home = path.join(root, 'home')
  const workspace = path.join(root, 'workspace')
  const env = {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'local-appdata')
  }
  if (provider === 'kimi') {
    env.KIMI_CODE_HOME = path.join(root, 'kimi-code')
  } else {
    env.CURSOR_CONFIG_DIR = path.join(home, '.cursor')
    env.CURSOR_DATA_DIR = path.join(root, 'cursor-data')
  }
  return { home, workspace, env }
}

function providerInventoryCommands(provider) {
  return provider === 'kimi'
    ? [['--version'], ['--help'], ['acp', '--help']]
    : [['--version'], ['--help']]
}

function captureProviderSurfaces(provider, binaryPath) {
  // Opaque provider inventory commands receive a fresh, unauthenticated home
  // and synthetic cwd. Cursor is intentionally limited to --version/--help;
  // Kimi additionally exposes its transport shape through inert `acp --help`.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-provider-probe-'))
  const layout = providerInventoryProbeLayout(provider, root)
  for (const directory of [
    layout.home,
    layout.workspace,
    ...Object.values(layout.env).filter((value) => path.isAbsolute(value))
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const unauthenticatedSourceEnv = cursorUnauthenticatedProbeSourceEnv()
  const commands = providerInventoryCommands(provider)
  const transportArgs = commands[2] || null
  try {
    return {
      transportArgs,
      versionCapture: capture(
        binaryPath,
        commands[0],
        15_000,
        layout.env,
        unauthenticatedSourceEnv,
        layout.workspace
      ),
      helpCapture: capture(
        binaryPath,
        commands[1],
        15_000,
        layout.env,
        unauthenticatedSourceEnv,
        layout.workspace
      ),
      transportCapture: transportArgs
        ? capture(
            binaryPath,
            transportArgs,
            15_000,
            layout.env,
            unauthenticatedSourceEnv,
            layout.workspace
          )
        : null
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function isExecutable(filePath) {
  if (!filePath) return false
  try {
    fs.accessSync(
      filePath,
      fs.constants.R_OK | (process.platform === 'win32' ? 0 : fs.constants.X_OK)
    )
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isReadableNonEmpty(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK)
    return fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}

function findOnPath(command) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter)
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const directory of pathEntries) {
    if (!directory) continue
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

function firstExecutable(candidates) {
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return path.resolve(candidate)
  }
  return null
}

function resolveProviderBinary(provider) {
  if (provider === 'kimi') {
    const configured = String(process.env.TASKWRAITH_KIMI_CANARY_BIN || '').trim()
    const binaryPath = firstExecutable([
      configured,
      path.join(
        os.homedir(),
        '.kimi-code',
        'bin',
        process.platform === 'win32' ? 'kimi.exe' : 'kimi'
      ),
      findOnPath('kimi')
    ])
    return {
      path: binaryPath,
      source: binaryPath
        ? configured && path.resolve(configured) === binaryPath
          ? 'environment'
          : binaryPath.includes(`${path.sep}.kimi-code${path.sep}`)
            ? 'common'
            : 'path'
        : 'missing'
    }
  }

  const configured = String(process.env.TASKWRAITH_CURSOR_CANARY_BIN || '').trim()
  const binaryPath = firstExecutable([
    configured,
    path.join(
      os.homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'cursor-agent.exe' : 'cursor-agent'
    ),
    findOnPath('cursor-agent')
  ])
  return {
    path: binaryPath,
    source: binaryPath
      ? configured && path.resolve(configured) === binaryPath
        ? 'environment'
        : binaryPath.includes(`${path.sep}.local${path.sep}bin${path.sep}`)
          ? 'common'
          : 'path'
      : 'missing'
  }
}

function parseVersion(raw) {
  const text = String(raw || '').trim()
  const cursor = text.match(/\b\d{4}\.\d{2}\.\d{2}(?:-[0-9a-f]+)?\b/i)
  if (cursor) return cursor[0]
  const semver = text.match(/\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)
  return semver ? semver[0].replace(/^v/, '') : null
}

function cursorEnvironmentAuthAvailable(env = process.env) {
  return ['CURSOR_AUTH_TOKEN', 'CURSOR_API_KEY'].some(
    (key) => typeof env[key] === 'string' && env[key].trim().length > 0
  )
}

function readManifest(manifestPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { providers: {} }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { providers: {} }
    throw new Error(`Could not read qualification manifest: ${error.message}`)
  }
}

function qualificationFor(manifest, provider, probe) {
  if (!probe.qualificationScope) return null
  const candidates = Array.isArray(manifest?.providers?.[provider])
    ? manifest.providers[provider]
    : []
  const expectedPosture = POSTURE_VERSIONS[provider]
  const expectedAttestation = REVIEWED_ATTESTATION_SOURCES[provider]
  const match = candidates.find((candidate) => {
    if (candidate.scope !== probe.qualificationScope) return false
    if (candidate.postureVersion !== expectedPosture) return false
    if (candidate.attestationSource !== expectedAttestation) return false
    if (candidate.version !== probe.binary.version) return false
    if (candidate.capabilityFingerprint !== probe.capabilities.fingerprint) return false
    // Qualification is exact. Version/capability matches are useful diagnostics,
    // but they do not attest another build, platform, or architecture.
    if (candidate.binarySha256 !== probe.binary.sha256) return false
    if (candidate.distribution !== probe.binary.distribution) return false
    if (candidate.harnessNodeVersion !== process.version) return false
    if (candidate.authentication !== probe.runtimeContract?.authentication) return false
    if (candidate.backendBaseUrl !== probe.runtimeContract?.backendBaseUrl) return false
    if (candidate.modelAlias !== probe.runtimeContract?.modelAlias) return false
    if (candidate.model !== probe.runtimeContract?.model) return false
    if (candidate.platform !== process.platform) return false
    if (candidate.arch !== process.arch) return false
    return true
  })
  return match || null
}

function reviewedLiveSuite(provider, repoRoot = REPO_ROOT, stat = fs.lstatSync) {
  const expected = [...(REVIEWED_LIVE_TESTS[provider] || [])]
  const present = []
  const missingOrInvalid = []
  for (const relativePath of expected) {
    const absolutePath = path.join(repoRoot, relativePath)
    try {
      if (!stat(absolutePath).isFile()) {
        missingOrInvalid.push(relativePath)
        continue
      }
      present.push(relativePath)
    } catch {
      missingOrInvalid.push(relativePath)
    }
  }
  return {
    expected,
    present,
    missingOrInvalid,
    complete: expected.length > 0 && present.length === expected.length
  }
}

async function probeProvider(provider, manifest) {
  const resolved = resolveProviderBinary(provider)
  const reviewedSuite = reviewedLiveSuite(provider)
  const result = {
    provider,
    qualificationScope: QUALIFICATION_SCOPES[provider],
    executionPosture:
      provider === 'cursor'
        ? 'unavailable-unqualified-credentialed-startup'
        : 'acp-synthetic-cwd-gateway-v1-candidate',
    runtimeAvailable: false,
    reviewedSuiteAvailable: false,
    // Backward-compatible aggregate: ready for a reviewed live qualification,
    // not merely installed/authenticated.
    available: false,
    unavailableReasons: [],
    qualificationBlockers: [],
    binary: {
      present: Boolean(resolved.path),
      path: displayPath(resolved.path),
      source: resolved.source,
      version: null,
      sha256: null,
      distribution:
        provider === 'kimi'
          ? String(process.env.TASKWRAITH_KIMI_CANARY_DISTRIBUTION || '').trim() ||
            'standalone-unverified-origin'
          : 'disabled-cursor-inventory'
    },
    auth: { available: false, method: null },
    runtimeContract: null,
    capabilities: {
      fingerprint: null,
      recognized: false,
      transportProbed: provider === 'kimi',
      flags: [],
      commands: [],
      transportFlags: [],
      transportCommands: []
    },
    qualification: null,
    liveTests: {
      status: 'not_run',
      testPaths: reviewedSuite.present,
      reports: [],
      counts: { total: 0, passed: 0, failed: 0, skipped: 0 },
      reason: null
    }
  }
  Object.defineProperties(result, {
    _binarySourcePath: { value: resolved.path, enumerable: false, writable: true },
    _binaryPath: { value: resolved.path, enumerable: false, writable: true },
    _binaryIdentity: { value: null, enumerable: false, writable: true },
    _qualificationCandidate: { value: null, enumerable: false, writable: true }
  })
  result.reviewedSuiteAvailable = reviewedSuite.complete
  if (!result.reviewedSuiteAvailable) {
    result.qualificationBlockers.push(
      reviewedSuite.missingOrInvalid.length > 0
        ? `missing or non-regular reviewed live suite file(s): ${reviewedSuite.missingOrInvalid.join(', ')}`
        : provider === 'cursor'
          ? 'credentialed Cursor startup containment is unqualified; TaskWraith must not spawn Cursor'
          : `no reviewed ${provider} live suite is allowlisted`
    )
  }
  if (!result.qualificationScope) {
    result.qualificationBlockers.push('provider has no admissible live qualification scope')
  }

  if (!resolved.path) {
    result.unavailableReasons.push(`${provider} binary not found`)
    return result
  }

  let binaryIdentity
  try {
    binaryIdentity = await captureBinaryIdentity(resolved.path)
    result._binaryPath = binaryIdentity.realPath
    result._binaryIdentity = binaryIdentity
    result.binary.path = displayPath(binaryIdentity.realPath)
    result.binary.sha256 = binaryIdentity.sha256
  } catch (error) {
    result.unavailableReasons.push(`binary identity capture failed: ${error.message}`)
    return result
  }

  const { versionCapture, helpCapture, transportCapture, transportArgs } = captureProviderSurfaces(
    provider,
    binaryIdentity.realPath
  )
  const versionRaw = versionCapture.stdout || versionCapture.stderr
  result.binary.version = parseVersion(versionRaw)
  try {
    const postProbeIdentity = await captureBinaryIdentity(resolved.path)
    if (!sameBinaryIdentity(binaryIdentity, postProbeIdentity)) {
      throw new Error('provider executable identity changed during bounded inventory probes')
    }
  } catch (error) {
    result.unavailableReasons.push(`binary identity verification failed: ${error.message}`)
  }
  if (versionCapture.code !== 0 || !result.binary.version) {
    result.unavailableReasons.push('bounded --version probe failed')
  }

  const help = helpCapture.stdout || helpCapture.stderr
  const transportHelp = transportCapture ? transportCapture.stdout || transportCapture.stderr : ''
  result.capabilities.flags = extractLongFlags(help)
  result.capabilities.commands = extractCommands(help)
  result.capabilities.transportFlags = extractLongFlags(transportHelp)
  result.capabilities.transportCommands = extractCommands(transportHelp)

  const capabilityDocument = {
    schemaVersion: 1,
    provider,
    version: result.binary.version,
    topLevel: {
      flags: result.capabilities.flags,
      commands: result.capabilities.commands
    },
    transport: transportArgs
      ? {
          probed: true,
          command: transportArgs[0],
          flags: result.capabilities.transportFlags,
          commands: result.capabilities.transportCommands
        }
      : { probed: false }
  }
  result.capabilities.fingerprint = capabilityFingerprint(capabilityDocument)

  if (helpCapture.code !== 0) result.unavailableReasons.push('bounded --help probe failed')
  if (transportCapture && transportArgs && transportCapture.code !== 0) {
    result.unavailableReasons.push(`bounded ${transportArgs.join(' ')} probe failed`)
  }

  if (provider === 'kimi') {
    const sourceHome = path.resolve(
      String(process.env.TASKWRAITH_KIMI_CANARY_HOME || path.join(os.homedir(), '.kimi-code'))
    )
    const credentialPath = path.join(sourceHome, 'credentials', 'kimi-code.json')
    const configPath = path.join(sourceHome, 'config.toml')
    const configPresent = isReadableNonEmpty(configPath)
    let configApiKeyPresent = false
    if (configPresent) {
      try {
        const configBody = fs.readFileSync(configPath, 'utf8')
        configApiKeyPresent = hasConfiguredKimiApiKey(configBody)
        const configContract = parseKimiConfigContract(configBody)
        if (configContract) {
          result.runtimeContract = {
            distribution: result.binary.distribution,
            harnessNodeVersion: process.version,
            ...configContract
          }
        }
      } catch {
        configApiKeyPresent = false
      }
    }
    const oauthCredentialPresent = isReadableNonEmpty(credentialPath)
    result.auth = {
      available: oauthCredentialPresent || configApiKeyPresent,
      method: configApiKeyPresent ? 'provider-api-key-config' : 'oauth-credential-file-presence',
      configPresent,
      configApiKeyPresent
    }
    if (!result.auth.available)
      result.unavailableReasons.push('Kimi OAuth credential/API-key profile is missing')
    if (!result.auth.configPresent)
      result.unavailableReasons.push('Kimi config.toml is missing or empty')
    if (configApiKeyPresent && !result.runtimeContract) {
      result.unavailableReasons.push('Kimi API-key profile has no complete provider/model contract')
    }
    if (!result.capabilities.commands.includes('acp')) {
      result.unavailableReasons.push('Kimi help does not advertise the ACP transport')
    }
    if (result.capabilities.flags.includes('--wire')) {
      result.unavailableReasons.push('binary advertises legacy --wire; expected Kimi Code ACP')
    }
    if (process.platform === 'win32') {
      result.unavailableReasons.push('Kimi live assertions are POSIX-specific')
    }
  } else {
    result.auth = {
      available: cursorEnvironmentAuthAvailable(),
      method: 'explicit-environment-token-presence'
    }
    if (!result.auth.available) {
      result.unavailableReasons.push(
        'Cursor explicit environment auth is missing (CURSOR_AUTH_TOKEN or CURSOR_API_KEY)'
      )
    }
    for (const requiredFlag of [
      '--print',
      '--output-format',
      '--force',
      '--approve-mcps',
      '--trust'
    ]) {
      if (!result.capabilities.flags.includes(requiredFlag)) {
        result.unavailableReasons.push(`Cursor help is missing ${requiredFlag}`)
      }
    }
  }

  result.runtimeAvailable = result.unavailableReasons.length === 0
  result._qualificationCandidate = qualificationFor(manifest, provider, result)
  result.capabilities.recognized = Boolean(result._qualificationCandidate)
  result.available = result.runtimeAvailable && result.reviewedSuiteAvailable
  return result
}

function flattenAssertions(report) {
  return (report?.testResults || []).flatMap((testResult) => testResult.assertionResults || [])
}

function validateVitestReport(report, expectedTitles) {
  const assertions = flattenAssertions(report)
  const skipped = assertions.filter((assertion) => assertion.status === 'skipped').length
  const failed = assertions.filter((assertion) => assertion.status === 'failed').length
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length
  const notPassed = assertions.filter((assertion) => assertion.status !== 'passed').length
  const errors = []
  const invalidTitleCount = assertions.filter(
    (assertion) => typeof assertion.title !== 'string' || assertion.title.trim().length === 0
  ).length
  const actualTitles = assertions
    .map((assertion) => assertion.title)
    .filter((title) => typeof title === 'string' && title.trim().length > 0)
  const expected = Array.isArray(expectedTitles) ? expectedTitles : []
  const expectedSet = new Set(expected)
  const actualSet = new Set(actualTitles)
  if (!report || report.success !== true) errors.push('Vitest report did not record success')
  if (invalidTitleCount > 0) errors.push(`${invalidTitleCount} assertion(s) had no stable title`)
  if (expected.length === 0) errors.push('reviewed live assertion roster is empty')
  if (expectedSet.size !== expected.length)
    errors.push('reviewed live assertion roster has duplicates')
  const missing = expected.filter((title) => !actualSet.has(title))
  const unexpected = actualTitles.filter((title) => !expectedSet.has(title))
  if (missing.length > 0) errors.push(`${missing.length} reviewed assertion(s) were missing`)
  if (unexpected.length > 0)
    errors.push(`${unexpected.length} unreviewed assertion(s) were present`)
  if (actualSet.size !== actualTitles.length) errors.push('live assertion titles were duplicated')
  if (assertions.length === 0) errors.push('no reviewed live assertion was discovered')
  if (skipped > 0) errors.push(`${skipped} assertion(s) were skipped`)
  if (failed > 0) errors.push(`${failed} assertion(s) failed`)
  if (notPassed > 0) errors.push(`${notPassed} assertion(s) did not pass`)
  return {
    valid: errors.length === 0,
    errors,
    counts: { total: assertions.length, passed, failed, skipped }
  }
}

function processControlFailure(error, action) {
  if (error && error.code === 'ESRCH') return null
  const message = error instanceof Error ? error.message : String(error)
  return `${action}: ${message}`
}

function executeVitestProcess(args, env) {
  return new Promise((resolveExecution) => {
    const detached = process.platform !== 'win32'
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      detached,
      env: canarySubprocessEnv(env),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let settled = false
    let timedOut = false
    let outputLimitExceeded = false
    let outputBytes = 0
    let errorMessage = null
    let forceKillTimer
    const recordExecutionError = (message) => {
      errorMessage = errorMessage ? `${errorMessage}; ${message}` : message
    }

    const signalTree = (signal) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        const failure = processControlFailure(error, `could not send ${signal} to process tree`)
        if (failure) recordExecutionError(failure)
      }
    }
    const beginTermination = () => {
      signalTree('SIGTERM')
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => signalTree('SIGKILL'), 2_000)
      }
    }
    const timeout = setTimeout(() => {
      timedOut = true
      beginTermination()
    }, LIVE_TIMEOUT_MS)
    const consume = (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 16 * 1024 * 1024 && !outputLimitExceeded) {
        outputLimitExceeded = true
        beginTermination()
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', consume)
    child.once('error', (error) => {
      recordExecutionError(error.message)
    })
    const waitForProcessGroupExit = async () => {
      if (!detached || !child.pid) return false
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        try {
          process.kill(-child.pid, 0)
          signalTree('SIGKILL')
          await new Promise((resolveWait) => setTimeout(resolveWait, 50))
        } catch (error) {
          const failure = processControlFailure(error, 'could not verify process-group exit')
          if (!failure) return false
          recordExecutionError(failure)
          return true
        }
      }
      return true
    }
    child.once('close', async (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      // A killed/crashed Vitest leader must not leave its Kimi grandchild alive.
      // On POSIX the detached child is the process-group leader, so this final
      // group kill closes descendants before the runner-owned root is removed.
      signalTree('SIGKILL')
      const processGroupSurvived = await waitForProcessGroupExit()
      resolveExecution({
        code,
        signal: signal || null,
        timedOut,
        outputLimitExceeded,
        processGroupSurvived,
        errorMessage
      })
    })
  })
}

async function runVitestFile(provider, testPath, outputDirectory, env) {
  const relativePath = path.relative(REPO_ROOT, testPath)
  const reportName = `${provider}-${path.basename(testPath).replace(/[^a-z0-9.-]+/gi, '-')}.json`
  const reportPath = path.join(outputDirectory, reportName)
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  try {
    fs.rmSync(reportPath, { force: true })
  } catch {
    // Best effort; Vitest will surface a write failure.
  }
  const vitestPath = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  const args = [
    vitestPath,
    'run',
    relativePath,
    '--no-file-parallelism',
    '--maxWorkers=1',
    '--bail=1',
    '--reporter=json',
    `--outputFile=${reportPath}`
  ]
  const startedAt = Date.now()
  const execution = await executeVitestProcess(args, env)
  let report = null
  let reportError = null
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  } catch (error) {
    reportError = error.message
  } finally {
    // The raw reporter can contain assertion context/provider output. Retain it
    // only long enough to parse the in-memory status summary.
    fs.rmSync(reportPath, { force: true })
  }
  const validation = validateVitestReport(report, REVIEWED_LIVE_ASSERTIONS[relativePath])
  const errors = [...validation.errors]
  if (execution.code !== 0) errors.push(`Vitest exited ${execution.code ?? 'without a code'}`)
  if (execution.errorMessage) errors.push(execution.errorMessage)
  if (execution.signal) errors.push(`Vitest ended via ${execution.signal}`)
  if (execution.timedOut) errors.push('Vitest exceeded the bounded live-suite timeout')
  if (execution.outputLimitExceeded) errors.push('Vitest exceeded the bounded output limit')
  if (execution.processGroupSurvived) {
    errors.push('Vitest process group survived bounded termination')
  }
  if (reportError) errors.push(`could not read JSON report: ${reportError}`)
  return {
    testPath: relativePath,
    status: errors.length === 0 ? 'passed' : 'failed',
    durationMs: Date.now() - startedAt,
    counts: validation.counts,
    // Provider stdout/stderr can contain prompts, account details, or model
    // output. The aggregate artifact keeps only structured status/errors.
    errors: [...new Set(errors)]
  }
}

function addCounts(target, source) {
  for (const key of ['total', 'passed', 'failed', 'skipped']) target[key] += source[key] || 0
}

function liveExecutionAllowed(provider) {
  // Kimi and Cursor both have a reviewed credentialed startup-containment suite.
  // This gate stays independent of the reviewed-file allowlist and qualification
  // scope so no single metadata edit can accidentally launch a provider; a live
  // run still requires the suite, the scope, and (for release) a known
  // fingerprint. Cursor's manifest roster is empty, so a live pass produces only
  // unattested review evidence until its exact fingerprint is minted.
  return provider === 'kimi' || provider === 'cursor'
}

function livePreflightFailure(probe, options) {
  if (!probe.runtimeAvailable) {
    return {
      status: 'unavailable',
      reason: probe.unavailableReasons.join('; ')
    }
  }
  if (!probe.reviewedSuiteAvailable) {
    return {
      status: 'blocked_no_reviewed_suite',
      reason: probe.qualificationBlockers.join('; ')
    }
  }
  // A reviewed test file alone must never make a disabled provider executable.
  // Re-enablement requires a separate, explicit qualification-scope decision.
  if (!probe.qualificationScope) {
    return {
      status: 'blocked_no_qualification_scope',
      reason: probe.qualificationBlockers.join('; ') || 'no admissible live qualification scope'
    }
  }
  if (
    options.requireKnownFingerprints &&
    options.required.includes(probe.provider) &&
    !probe.capabilities.recognized
  ) {
    return {
      status: 'blocked_unrecognized_fingerprint',
      reason: 'provider binary/capability fingerprint is not qualified'
    }
  }
  return null
}

function applyRequiredLivePreflight(probes, options) {
  const byProvider = new Map(probes.map((probe) => [probe.provider, probe]))
  const requiredBlockers = options.required
    .map((provider) => byProvider.get(provider))
    .filter(Boolean)
    .map((probe) => livePreflightFailure(probe, options))
    .filter(Boolean)

  if (requiredBlockers.length === 0) return false

  // Do not spend credentials or create partial evidence when another required
  // provider is already known to make the qualification run impossible.
  for (const probe of probes) {
    const failure = livePreflightFailure(probe, options)
    if (failure) {
      probe.liveTests.status = failure.status
      probe.liveTests.reason = failure.reason
    } else {
      probe.liveTests.status = 'blocked_by_required_provider_preflight'
      probe.liveTests.reason = 'another required provider did not pass qualification preflight'
    }
  }
  return true
}

async function runLiveTests(probe, options) {
  if (!liveExecutionAllowed(probe.provider)) {
    probe.liveTests.status = 'blocked_provider_execution_disabled'
    probe.liveTests.reason = 'credentialed live execution is disabled for this provider'
    return
  }
  const preflightFailure = livePreflightFailure(probe, options)
  if (preflightFailure) {
    probe.liveTests.status = preflightFailure.status
    probe.liveTests.reason = preflightFailure.reason
    return
  }

  // Vitest's raw JSON/JUnit reporters may include provider console output.
  // Parse JSON from a private temporary directory, retain only counts/status,
  // then delete it. Published evidence is the sanitized aggregate JSON + JUnit.
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-provider-canary-'))
  const runtimeRoot = path.join(outputDirectory, 'provider-runtime')
  const vitestHome = path.join(runtimeRoot, 'test-home')
  const vitestTmp = path.join(runtimeRoot, 'tmp')
  const vitestXdgRuntime = path.join(runtimeRoot, 'xdg-runtime')
  for (const directory of [runtimeRoot, vitestHome, vitestTmp, vitestXdgRuntime]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const env = {
    TASKWRAITH_PROVIDER_CANARY: '1',
    TASKWRAITH_PROVIDER_CANARY_ROOT: runtimeRoot,
    HOME: vitestHome,
    USERPROFILE: vitestHome,
    TMPDIR: vitestTmp,
    TMP: vitestTmp,
    TEMP: vitestTmp,
    XDG_CONFIG_HOME: path.join(runtimeRoot, 'xdg-config'),
    XDG_DATA_HOME: path.join(runtimeRoot, 'xdg-data'),
    XDG_CACHE_HOME: path.join(runtimeRoot, 'xdg-cache'),
    XDG_RUNTIME_DIR: vitestXdgRuntime
  }
  if (probe.provider === 'cursor') {
    // Cursor is isolated via CURSOR_CONFIG_DIR/CURSOR_DATA_DIR (set per-turn by
    // the reviewed suite), NOT via HOME. It requires the REAL HOME: the API-key
    // path avoids the login Keychain, and a temp HOME is itself sandbox-writable,
    // which would defeat the write-block probe (that proves the native sandbox
    // blocks a write into the user's HOME). The credential is passed only for a
    // cursor live run and is never copied into the sanitized report.
    const realHome =
      typeof process.env.HOME === 'string' && process.env.HOME.length > 0
        ? process.env.HOME
        : os.homedir()
    env.HOME = realHome
    env.USERPROFILE = realHome
    env.CURSOR_STARTUP_LIVE_TRACE = '1'
    env.TASKWRAITH_CURSOR_CANARY_BIN = probe._binaryPath
    if (
      typeof process.env.CURSOR_API_KEY === 'string' &&
      process.env.CURSOR_API_KEY.trim().length > 0
    ) {
      env.CURSOR_API_KEY = process.env.CURSOR_API_KEY
    }
  } else {
    env.KIMI_ACP_LIVE_TRACE = '1'
    env.TASKWRAITH_KIMI_CANARY_BIN = probe._binaryPath
    env.TASKWRAITH_KIMI_CANARY_HOME = path.resolve(
      String(process.env.TASKWRAITH_KIMI_CANARY_HOME || path.join(os.homedir(), '.kimi-code'))
    )
  }

  probe.liveTests.status = 'running'
  try {
    try {
      await assertPinnedFileIdentity(
        probe._binarySourcePath,
        probe._binaryIdentity,
        'provider executable'
      )
    } catch (error) {
      probe.liveTests.status = 'failed'
      probe.liveTests.reason = `binary identity preflight failed: ${error.message}`
      return
    }
    for (const relativePath of probe.liveTests.testPaths) {
      process.stdout.write(`[provider-canary] ${probe.provider}: ${relativePath}\n`)
      const testResult = await runVitestFile(
        probe.provider,
        path.join(REPO_ROOT, relativePath),
        outputDirectory,
        env
      )
      probe.liveTests.reports.push(testResult)
      addCounts(probe.liveTests.counts, testResult.counts)
      try {
        await assertPinnedFileIdentity(
          probe._binarySourcePath,
          probe._binaryIdentity,
          'provider executable'
        )
      } catch (error) {
        probe.liveTests.status = 'failed'
        probe.liveTests.reason = `binary identity post-suite verification failed: ${error.message}`
        return
      }
      if (testResult.status !== 'passed') {
        probe.liveTests.status = 'failed'
        probe.liveTests.reason = testResult.errors.join('; ')
        return
      }
    }
    try {
      await assertPinnedFileIdentity(
        probe._binarySourcePath,
        probe._binaryIdentity,
        'provider executable'
      )
    } catch (error) {
      probe.liveTests.status = 'failed'
      probe.liveTests.reason = `binary identity final verification failed: ${error.message}`
      return
    }
    if (probe.capabilities.recognized) {
      // Emit reviewed provenance only after the complete exact-title production
      // suite has passed. Probe-only and failed reports retain no live-canary
      // qualification object even when the manifest has a matching candidate.
      probe.qualification = probe._qualificationCandidate
      probe.liveTests.status = 'passed'
    } else {
      probe.liveTests.status = 'passed_unrecognized'
    }
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true })
  }
}

function summarize(probes, options) {
  const byProvider = new Map(probes.map((probe) => [probe.provider, probe]))
  const required = options.required.map((provider) => byProvider.get(provider)).filter(Boolean)
  const failed = probes.filter((probe) => probe.liveTests.status === 'failed')
  const runtimeAvailable = (probe) => probe.runtimeAvailable ?? probe.available
  const reviewedSuiteAvailable = (probe) => probe.reviewedSuiteAvailable ?? true
  const requiredUnavailable = required.filter((probe) => !runtimeAvailable(probe))
  const requiredWithoutSuite = required.filter((probe) => !reviewedSuiteAvailable(probe))
  const requiredWithoutScope = required.filter((probe) => !probe.qualificationScope)
  const requiredUnrecognized = required.filter((probe) => !probe.capabilities.recognized)
  const executed = probes.filter((probe) =>
    ['passed', 'passed_unrecognized', 'failed'].includes(probe.liveTests.status)
  )
  const incomplete = probes.filter(
    (probe) =>
      !runtimeAvailable(probe) || !reviewedSuiteAvailable(probe) || !probe.qualificationScope
  )
  const unrecognized = probes.filter((probe) => !probe.capabilities.recognized)
  const requiredNotPassed = required.filter(
    (probe) => !['passed', 'passed_unrecognized'].includes(probe.liveTests.status)
  )

  if (!options.live) {
    if (requiredUnavailable.length > 0) return { status: 'unavailable', exitCode: 2 }
    if (options.requireKnownFingerprints && requiredUnrecognized.length > 0) {
      return { status: 'unrecognized_fingerprint', exitCode: 3 }
    }
    return { status: 'probe_only', exitCode: 0 }
  }
  if (failed.length > 0) return { status: 'failed', exitCode: 1 }
  if (requiredUnavailable.length > 0) return { status: 'unavailable', exitCode: 2 }
  if (requiredWithoutSuite.length > 0) return { status: 'no_reviewed_suite', exitCode: 2 }
  if (requiredWithoutScope.length > 0) return { status: 'no_qualification_scope', exitCode: 2 }
  if (options.requireKnownFingerprints && requiredUnrecognized.length > 0) {
    return { status: 'unrecognized_fingerprint', exitCode: 3 }
  }
  if (requiredNotPassed.length > 0) return { status: 'incomplete', exitCode: 2 }
  if (executed.length === 0) return { status: 'unavailable', exitCode: 2 }
  if (unrecognized.some((probe) => probe.liveTests.status === 'passed_unrecognized')) {
    // This evidence-producing mode intentionally permits an unknown tuple to
    // run. Reviewers may add the exact tuple to the empty-by-default manifest
    // afterwards. Strict release mode blocks it above.
    return { status: 'unattested_pass', exitCode: 0 }
  }
  if (incomplete.length > 0) return { status: 'partial_pass', exitCode: 0 }
  return { status: 'passed', exitCode: 0 }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

function xmlEscape(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function aggregateJunitCases(report) {
  const required = new Set(report.requiredProviders)
  const strict = report.requireKnownFingerprints
  const cases = []

  for (const probe of report.providers) {
    const className = `provider-permission-conformance.${probe.provider}`
    if (probe.runtimeAvailable ?? probe.available) {
      cases.push({ className, name: 'binary, auth, and capability probe', status: 'passed' })
    } else {
      cases.push({
        className,
        name: 'binary, auth, and capability probe',
        status: required.has(probe.provider) ? 'failed' : 'skipped',
        message: probe.unavailableReasons.join('; ') || 'provider unavailable'
      })
    }

    if (probe.capabilities.recognized) {
      cases.push({
        className,
        name: `exact reviewed ${probe.qualificationScope || 'admissible'} fingerprint`,
        status: 'passed'
      })
    } else {
      cases.push({
        className,
        name: `exact reviewed ${probe.qualificationScope || 'admissible'} fingerprint`,
        status: strict && required.has(probe.provider) ? 'failed' : 'skipped',
        message: 'binary/capability tuple is not in the reviewed manifest'
      })
    }

    if (probe.liveTests.reports.length > 0) {
      for (const liveReport of probe.liveTests.reports) {
        cases.push({
          className,
          name: liveReport.testPath,
          status: liveReport.status === 'passed' ? 'passed' : 'failed',
          message: liveReport.errors.join('; '),
          durationMs: liveReport.durationMs
        })
      }
    } else {
      const liveRequired = report.mode === 'live' && required.has(probe.provider)
      cases.push({
        className,
        name: 'live permission-conformance suite',
        status: liveRequired ? 'failed' : 'skipped',
        message:
          probe.liveTests.reason ||
          (probe.qualificationBlockers || []).join('; ') ||
          (report.mode === 'live' ? probe.liveTests.status : 'probe-only mode')
      })
    }
  }
  return cases
}

function renderAggregateJunit(report) {
  const cases = aggregateJunitCases(report)
  const failures = cases.filter((item) => item.status === 'failed').length
  const skipped = cases.filter((item) => item.status === 'skipped').length
  const time = cases.reduce((total, item) => total + (item.durationMs || 0), 0) / 1000
  const body = cases
    .map((item) => {
      const attributes =
        `classname="${xmlEscape(item.className)}" name="${xmlEscape(item.name)}" ` +
        `time="${((item.durationMs || 0) / 1000).toFixed(3)}"`
      if (item.status === 'failed') {
        const message = item.message || 'failed'
        return `    <testcase ${attributes}><failure message="${xmlEscape(message)}">${xmlEscape(message)}</failure></testcase>`
      }
      if (item.status === 'skipped') {
        return `    <testcase ${attributes}><skipped message="${xmlEscape(item.message || 'skipped')}"/></testcase>`
      }
      return `    <testcase ${attributes}/>`
    })
    .join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<testsuites name="provider-permission-conformance" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n` +
    `  <testsuite name="provider-permission-conformance" tests="${cases.length}" failures="${failures}" skipped="${skipped}" time="${time.toFixed(3)}">\n` +
    `${body}\n` +
    '  </testsuite>\n' +
    '</testsuites>\n'
  )
}

function writeAggregateJunit(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, renderAggregateJunit(report), { mode: 0o600 })
  fs.renameSync(temporaryPath, filePath)
}

async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`[provider-canary] ${error.message}\n\n${usage()}`)
    return 64
  }
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }

  const manifest = readManifest(options.manifestPath)
  const report = {
    schemaVersion: 2,
    reportKind: 'provider-permission-conformance',
    generatedAt: new Date().toISOString(),
    mode: options.live ? 'live' : 'probe-only',
    fingerprintEnforcementScope: 'release-evidence-only',
    requestedProviders: options.providers,
    requiredProviders: options.required,
    requireKnownFingerprints: options.requireKnownFingerprints,
    reviewedSuiteAllowlist: Object.fromEntries(
      options.providers.map((provider) => [provider, [...(REVIEWED_LIVE_TESTS[provider] || [])]])
    ),
    reviewedAssertionRoster: Object.fromEntries(
      options.providers.flatMap((provider) =>
        (REVIEWED_LIVE_TESTS[provider] || []).map((testPath) => [
          testPath,
          [...(REVIEWED_LIVE_ASSERTIONS[testPath] || [])]
        ])
      )
    ),
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      ci: Boolean(process.env.CI),
      gitCommit: capture('git', ['rev-parse', 'HEAD']).stdout.trim() || null
    },
    manifestPath: path.relative(REPO_ROOT, options.manifestPath),
    aggregateJunitPath: path.relative(REPO_ROOT, options.junitOutputPath),
    providers: [],
    summary: null
  }

  for (const provider of options.providers) {
    process.stdout.write(`[provider-canary] probing ${provider}\n`)
    report.providers.push(await probeProvider(provider, manifest))
  }
  if (options.live) {
    const preflightBlocked = applyRequiredLivePreflight(report.providers, options)
    if (!preflightBlocked) {
      for (const probe of report.providers) await runLiveTests(probe, options)
    }
  }
  report.summary = summarize(report.providers, options)
  writeJson(options.outputPath, report)
  writeAggregateJunit(options.junitOutputPath, report)

  for (const probe of report.providers) {
    const fingerprint = probe.capabilities.fingerprint || 'unavailable'
    const qualification = probe.capabilities.recognized ? 'qualified' : 'UNRECOGNIZED'
    process.stdout.write(
      `[provider-canary] ${probe.provider}: version=${probe.binary.version || 'unavailable'} ` +
        `fingerprint=${fingerprint} scope=${probe.qualificationScope || 'none-disabled'} ${qualification} ` +
        `posture=${probe.executionPosture} ` +
        `runtime=${probe.runtimeAvailable ? 'ready' : 'unavailable'} ` +
        `suite=${probe.reviewedSuiteAvailable ? 'reviewed' : 'missing'} live=${probe.liveTests.status}\n`
    )
    if (probe.unavailableReasons.length > 0) {
      process.stdout.write(`  runtime unavailable: ${probe.unavailableReasons.join('; ')}\n`)
    }
    if (probe.qualificationBlockers.length > 0) {
      process.stdout.write(`  qualification blocked: ${probe.qualificationBlockers.join('; ')}\n`)
    }
  }
  process.stdout.write(
    `[provider-canary] ${report.summary.status}; report=${path.relative(REPO_ROOT, options.outputPath)} ` +
      `junit=${path.relative(REPO_ROOT, options.junitOutputPath)}\n`
  )
  return report.summary.exitCode
}

if (require.main === module) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      process.stderr.write(`[provider-canary] fatal: ${error.stack || error.message}\n`)
      process.exitCode = 1
    })
}

module.exports = {
  applyRequiredLivePreflight,
  captureBinaryIdentity,
  canarySubprocessEnv,
  capabilityFingerprint,
  cursorEnvironmentAuthAvailable,
  cursorUnauthenticatedProbeSourceEnv,
  extractCommands,
  extractLongFlags,
  liveExecutionAllowed,
  parseArgs,
  parseVersion,
  processControlFailure,
  providerInventoryCommands,
  providerInventoryProbeLayout,
  qualificationFor,
  reviewedLiveSuite,
  REVIEWED_LIVE_ASSERTIONS,
  REVIEWED_LIVE_TESTS,
  renderAggregateJunit,
  sameBinaryIdentity,
  summarize,
  validateVitestReport
}
