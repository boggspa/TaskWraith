#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.join(__dirname, '..')
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json')
const LOCKFILE_PATH = path.join(REPO_ROOT, 'package-lock.json')
const NODE_MODULES_PATH = path.join(REPO_ROOT, 'node_modules')

const DENYLIST = [
  { pattern: /^@antv\//, reason: 'recent @antv npm supply-chain compromise' },
  { pattern: /^@tanstack\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@uipath\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@mistralai\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@opensearch-project\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@lint-md\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@openclaw-cn\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@starmind\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@cap-js\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^@sap\//, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^echarts-for-react$/, reason: 'flagged during recent @antv/ecosystem compromise' },
  {
    pattern: /^echarts$/,
    reason: 'charting dependency review required during @antv incident window'
  },
  { pattern: /^timeago\.js$/, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^size-sensor$/, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^canvas-nest\.js$/, reason: 'recent Mini Shai-Hulud package compromise wave' },
  { pattern: /^intercom-client$/, reason: 'recent Mini Shai-Hulud package compromise wave' }
]

const ALLOWED_INSTALL_SCRIPTS = new Map([
  ['@google/genai@2.4.0', { preinstall: "echo 'preinstall: no-op'" }],
  ['@google/genai@2.13.0', { preinstall: "echo 'preinstall: no-op'" }],
  ['electron@39.8.9', { postinstall: 'node install.js' }],
  ['electron@39.8.10', { postinstall: 'node install.js' }],
  ['electron-winstaller@5.4.0', { install: 'node ./script/select-7z-arch.js' }],
  ['esbuild@0.25.12', { postinstall: 'node install.js' }],
  ['esbuild@0.27.7', { postinstall: 'node install.js' }],
  ['esbuild@0.28.1', { postinstall: 'node install.js' }],
  [
    'node-pty@1.1.0',
    {
      install: 'node scripts/prebuild.js || node-gyp rebuild',
      postinstall: 'node scripts/post-install.js'
    }
  ],
  ['protobufjs@7.6.4', { postinstall: 'node scripts/postinstall' }],
  ['protobufjs@7.6.5', { postinstall: 'node scripts/postinstall' }]
])

const INSTALL_HOOKS = new Set(['preinstall', 'install', 'postinstall'])
const MALWARE_TEXT_PATTERNS = [
  /router_runtime/i,
  /router_init/i,
  /@antv\/setup/i,
  /@tanstack\/setup/i,
  /bun\s+run\s+index\.js/i,
  /execution\.js/i,
  /t\.m-kosche/i,
  /getsession/i,
  /shai-hulud/i
]
const MALWARE_FILE_NAMES = new Set([
  'router_runtime.js',
  'router_init.js',
  'setup.mjs',
  'execution.js'
])

const failures = []
const warnings = []

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    fail(`Failed to read ${path.relative(REPO_ROOT, filePath)}: ${error.message}`)
    return null
  }
}

function packageNameFromLockPath(lockPath) {
  return lockPath.replace(/^node_modules\//, '')
}

function isLocalOrLinkPackage(meta) {
  return Boolean(
    meta.link || (typeof meta.resolved === 'string' && meta.resolved.startsWith('file:'))
  )
}

function checkRootDependencySpecs(pkg, lock) {
  const root = lock.packages && lock.packages['']
  if (!root) {
    fail('package-lock.json is missing the root package entry.')
    return
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const expected = pkg[field] || {}
    const actual = root[field] || {}
    const expectedKeys = Object.keys(expected).sort()
    const actualKeys = Object.keys(actual).sort()
    if (expectedKeys.join('\n') !== actualKeys.join('\n')) {
      fail(`package-lock.json root ${field} does not match package.json.`)
      continue
    }
    for (const name of expectedKeys) {
      if (expected[name] !== actual[name]) {
        fail(
          `package-lock.json root ${field}.${name} is ${actual[name]}, expected ${expected[name]}.`
        )
      }
    }
  }
}

function checkLockIntegrity(lock) {
  if (Number(lock.lockfileVersion) < 3) {
    fail(`package-lock.json must be lockfileVersion >= 3; found ${lock.lockfileVersion}.`)
  }
  for (const [lockPath, meta] of Object.entries(lock.packages || {})) {
    if (!lockPath || isLocalOrLinkPackage(meta)) continue
    if (!meta.integrity) {
      fail(`${lockPath} is missing an integrity hash in package-lock.json.`)
    }
  }
}

function checkDenylist(lock) {
  if (process.env.TASKWRAITH_SECURITY_ALLOW_DENYLIST === '1') {
    warn('TASKWRAITH_SECURITY_ALLOW_DENYLIST=1 set; dependency incident denylist bypassed.')
    return
  }
  for (const lockPath of Object.keys(lock.packages || {})) {
    if (!lockPath.startsWith('node_modules/')) continue
    const name = packageNameFromLockPath(lockPath)
    for (const entry of DENYLIST) {
      if (entry.pattern.test(name)) {
        fail(`${name} is on the supply-chain incident denylist: ${entry.reason}.`)
      }
    }
  }
}

function readInstalledPackageJson(lockPath) {
  const packageJsonPath = path.join(REPO_ROOT, lockPath, 'package.json')
  if (!fs.existsSync(packageJsonPath)) return null
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  } catch (error) {
    fail(`Failed to parse ${path.relative(REPO_ROOT, packageJsonPath)}: ${error.message}`)
    return null
  }
}

function normalizeScripts(scripts) {
  const result = {}
  for (const [name, value] of Object.entries(scripts || {})) {
    if (INSTALL_HOOKS.has(name)) result[name] = String(value)
  }
  return result
}

function sameObject(a, b) {
  return (
    JSON.stringify(
      Object.keys(a)
        .sort()
        .map((key) => [key, a[key]])
    ) ===
    JSON.stringify(
      Object.keys(b)
        .sort()
        .map((key) => [key, b[key]])
    )
  )
}

function checkInstallScripts(lock) {
  if (!fs.existsSync(NODE_MODULES_PATH)) {
    warn(
      'node_modules is absent; install-script allowlist check skipped. Run after npm ci for full coverage.'
    )
    return
  }
  for (const [lockPath, meta] of Object.entries(lock.packages || {})) {
    if (!lockPath.startsWith('node_modules/')) continue
    const installed = readInstalledPackageJson(lockPath)
    if (!installed) continue
    const scripts = normalizeScripts(installed.scripts)
    if (Object.keys(scripts).length === 0) continue
    const key = `${installed.name || packageNameFromLockPath(lockPath)}@${installed.version || meta.version || 'unknown'}`
    const allowed = ALLOWED_INSTALL_SCRIPTS.get(key)
    if (!allowed) {
      fail(
        `${key} declares install lifecycle scripts but is not allowlisted: ${JSON.stringify(scripts)}`
      )
      continue
    }
    if (!sameObject(scripts, allowed)) {
      fail(
        `${key} install lifecycle scripts changed. Found ${JSON.stringify(scripts)}, expected ${JSON.stringify(allowed)}.`
      )
    }
  }
}

function walkFiles(root, visitor) {
  if (!fs.existsSync(root)) return
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(fullPath)
      else if (entry.isFile()) visitor(fullPath)
    }
  }
}

function checkPersistenceIndicators() {
  const roots = ['.claude', '.vscode'].map((name) => path.join(REPO_ROOT, name))
  for (const root of roots) {
    walkFiles(root, (filePath) => {
      const basename = path.basename(filePath)
      const rel = path.relative(REPO_ROOT, filePath)
      if (MALWARE_FILE_NAMES.has(basename)) {
        fail(`Suspicious persistence indicator file found: ${rel}`)
        return
      }
      if (
        !['settings.json', 'settings.local.json', 'tasks.json', 'package.json'].includes(basename)
      ) {
        return
      }
      let text = ''
      try {
        text = fs.readFileSync(filePath, 'utf8')
      } catch {
        return
      }
      for (const pattern of MALWARE_TEXT_PATTERNS) {
        if (pattern.test(text)) {
          fail(`Suspicious persistence indicator matched ${pattern} in ${rel}.`)
        }
      }
    })
  }
}

const pkg = readJson(PACKAGE_JSON_PATH)
const lock = readJson(LOCKFILE_PATH)

if (pkg && lock) {
  checkRootDependencySpecs(pkg, lock)
  checkLockIntegrity(lock)
  checkDenylist(lock)
  checkInstallScripts(lock)
  checkPersistenceIndicators()
}

for (const message of warnings) {
  console.warn(`[security-supply-chain] warning: ${message}`)
}

if (failures.length > 0) {
  console.error('[security-supply-chain] failed:')
  for (const message of failures) {
    console.error(`  - ${message}`)
  }
  process.exit(1)
}

console.log('[security-supply-chain] ok')
