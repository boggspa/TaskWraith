[read_file: lines 1-148 of 148]
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '../..')
const cache = new Map()
const ALLOWED = new Set([
  'src/main/mcp/McpBridgeRoute.ts',
  'src/main/mcp/McpSessionProfileFence.ts',
  'src/main/InstanceLaunchPosture.ts',
  'src/host-shared/InstanceLaunchPosture.ts',
  'src/main/InstanceResourceIdentity.ts',
  'src/main/codex/CodexOAuthCredentialLease.ts',
  'src/main/codex/CodexHome.ts',
  'src/main/CodexSessionIdentity.ts',
  'src/main/kimi/KimiOAuthCredentialLease.ts'
])

/** Reuse reviewed Node-only helpers without importing Electron or the client. */
function loadHelper(relative, credentialMode = false) {
  const filename = path.resolve(ROOT, relative)
  const key = path.relative(ROOT, filename).split(path.sep).join('/')
  if (!ALLOWED.has(key)) throw new Error('unapproved helper dependency: ' + key)
  if (!credentialMode && /Credential|CodexHome|CodexSession/.test(key)) {
    throw new Error('credential helpers are live-only')
  }
  const cacheKey = credentialMode + ':' + filename
  if (cache.has(cacheKey)) return cache.get(cacheKey).exports
  const ts = require('typescript')
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  cache.set(cacheKey, module)
  const requireHelper = (request) => {
    if (request.startsWith('.')) {
      const target = path.resolve(path.dirname(filename), request)
      return loadHelper(
        path.relative(ROOT, target.endsWith('.ts') ? target : target + '.ts'),
        credentialMode
      )
    }
    const permitted = credentialMode
      ? ['crypto', 'path', 'os', 'fs', 'fs/promises', 'child_process']
      : ['crypto', 'path']
    if (!permitted.includes(request.replace(/^node:/, ''))) {
      throw new Error('non-Node or effectful helper import refused: ' + request)
    }
    return require(request)
  }
  try {
    vm.runInThisContext(
      '(function(exports, require, module, __filename, __dirname) {' + compiled + '\n})',
      { filename }
    )(module.exports, requireHelper, module, filename, path.dirname(filename))
    return module.exports
  } catch (error) {
    cache.delete(cacheKey)
    throw error
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])])
    )
  }
  return value
}

function fingerprint(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

function collectSecrets(value, result = []) {
  if (!value || typeof value !== 'object') return result
  for (const [key, child] of Object.entries(value)) {
    if (
      /SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY|AUTHORIZATION/i.test(key) &&
      typeof child === 'string'
    ) {
      if (child) result.push(child)
    } else if (child && typeof child === 'object') collectSecrets(child, result)
  }
  return result
}

/** All persisted evidence passes here; raw RPC bodies and stderr are not saved. */
function createRedactor({ secrets = [], paths = [] } = {}) {
  const replacements = [...new Set(secrets.filter(Boolean))]
    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])
    .sort((a, b) => b.length - a.length)
  const roots = [...new Set(paths.filter(Boolean))].sort((a, b) => b.length - a.length)
  function text(value) {
    let result = value
    for (const secret of replacements) result = result.split(secret).join('<REDACTED>')
    for (const root of roots) {
      result = result.split(root).join('<PRIVATE_PATH>')
      result = result.split(JSON.stringify(root).slice(1, -1)).join('<PRIVATE_PATH>')
    }
    if (!/^https?:\/\//i.test(result)) {
      result = result.replace(/[A-Za-z]:[\\/][^\s"'<>[\]{},;]*/g, '<EXTERNAL_PATH>')
      result = result.replace(/(^|[\s=("'[,])\/(?!\/)[^\s"'<>[\]{},;]+/g, '$1<EXTERNAL_PATH>')
    }
    return result
  }
  function redact(value) {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => {
          const envSecret =
            /^[A-Z][A-Z0-9_]*$/.test(key) && /SECRET|TOKEN|PASSWORD|CREDENTIAL|KEY/.test(key)
          const directSecret = /^(?:.*Token|.*Password|.*Secret|apiKey|authorization)$/i.test(key)
          return [text(key), envSecret || directSecret ? '<REDACTED>' : redact(child)]
        })
      )
    }
    return value
  }
  return redact
}

function writeEvidence(file, value, redact) {
  fs.writeFileSync(file, JSON.stringify(redact(value), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
}

module.exports = {
  ROOT,
  loadHelper,
  stable,
  fingerprint,
  collectSecrets,
  createRedactor,
  writeEvidence
}
