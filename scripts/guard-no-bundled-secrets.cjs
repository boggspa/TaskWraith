#!/usr/bin/env node

/**
 * guard-no-bundled-secrets.cjs — the Tier-2 APNs gateway's #1-invariant guard.
 *
 * Three independent checks:
 *
 *   1. FORBIDDEN-IMPORT, transitive (always runs; no build needed). Walks the
 *      relay's server.ts runtime import graph and FAILS if it ever reaches the
 *      gateway implementation / Apple sender / a .p8. server.ts is bundled into
 *      Electron main (src/main/index.ts imports it at :227), so anything in its
 *      runtime graph ships to every user. `import type` is erased and allowed;
 *      importing the impl module AT ALL — even a type from it — is a violation
 *      (types belong in apnsGatewayTypes.ts).
 *
 *   2. FORBIDDEN-IMPORT, direct (always runs). Flat-scans src/main + src/preload
 *      so a file there can't import the gateway impl directly, bypassing
 *      server.ts.
 *
 *   3. BUNDLE-SCAN (runs when build output exists). Raw-scans out/main/index.js
 *      and any packaged app.asar for a PEM PRIVATE KEY BODY (a real key, NOT the
 *      bare "BEGIN PRIVATE KEY" marker that the Tier-1 PEM validators
 *      legitimately contain) and for any known secret fingerprint.
 *
 * Why this exists: a 1.4.9 packaging review found Gemini public CLI OAuth
 * metadata in app.asar. That was not a private OAuth secret, but it showed how
 * build-time credential-looking material can drift into shipped bundles. The
 * APNs .p8 / configured fingerprints are real secrets, so this guard makes the
 * boundary explicit. See docs/ios-push-gateway-design.md §4.4.
 *
 * Fingerprints (optional) come from TASKWRAITH_SECRET_FINGERPRINTS (comma-
 * separated); the gateway key id is added there once Tier-2 ships.
 *
 * Exit 0 = clean; exit 1 = a leak / boundary violation / hard error.
 */

const fs = require('fs')
const path = require('path')

const REPO_ROOT = path.join(__dirname, '..')

// Matched against resolved, posix-normalized file paths.
const FORBIDDEN_P8 = /\.p8['"]?$/ // any direct .p8 reference
const FORBIDDEN_GATEWAY_IMPL = /\/relay\/src\/apnsGateway\.ts$/ // gateway impl (cli-only)
const FORBIDDEN_SEND_CORE = /\/apnsSendCore\.ts$/ // keyless Apple sender

// relay/src/server.ts is bundled into Electron main; it does NO APNs sending and
// holds NO key, so its import graph must reach none of these.
const SERVER_GRAPH_FORBIDDEN = [FORBIDDEN_GATEWAY_IMPL, FORBIDDEN_SEND_CORE, FORBIDDEN_P8]

// Electron main MAY use the keyless send-core (Tier-1's Http2ApnsPusher imports
// it — no key, no secret), but must never import the relay GATEWAY impl or a
// .p8 directly.
const MAIN_DIRECT_FORBIDDEN = [FORBIDDEN_GATEWAY_IMPL, FORBIDDEN_P8]

// Back-compat alias (the colocated test's "real server.ts passes" check).
const FORBIDDEN_MODULE_MATCHERS = SERVER_GRAPH_FORBIDDEN

// server.ts is the relay entrypoint bundled into Electron main; it is what we
// protect transitively.
const GUARDED_ENTRY = path.join(REPO_ROOT, 'relay/src/server.ts')

// Flat-scanned roots that must not import the forbidden modules directly.
const MAIN_SCAN_DIRS = ['src/main', 'src/preload']

// A real PEM private-key BODY: the BEGIN marker, then >=80 chars of base64 /
// line separators / escaped newlines (real keys are hundreds), then the END
// marker. This does NOT match a bare "-----BEGIN PRIVATE KEY-----" string
// literal (the Tier-1 validators), which has no base64 body + END marker.
const PEM_PRIVATE_KEY_BODY =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----(?:[A-Za-z0-9+/=]|\\r|\\n|\r|\n|\s){80,}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/

function rel(filePath) {
  return path.relative(REPO_ROOT, filePath) || filePath
}

/**
 * Returns [{ specifier, typeOnly }] for every import/export-from + dynamic
 * import. Conservative: only a statement-level `import type` / `export type` is
 * erased; `import { type X }` (inline type) is treated as a value import.
 */
function parseImports(source) {
  const results = []
  const fromRe = /\b(import|export)\s+(type\s+)?[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g
  let m
  while ((m = fromRe.exec(source)) !== null) {
    results.push({ specifier: m[3], typeOnly: Boolean(m[2]) })
  }
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g
  while ((m = sideEffectRe.exec(source)) !== null) {
    results.push({ specifier: m[1], typeOnly: false })
  }
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dynamicRe.exec(source)) !== null) {
    results.push({ specifier: m[1], typeOnly: false })
  }
  return results
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js')
  ]
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    } catch {
      // ignore
    }
  }
  // Unresolved (e.g. a ".p8" that isn't a real file): return a best-effort path
  // so forbidden matchers can still catch the specifier.
  return path.extname(base) ? base : `${base}.ts`
}

/** Transitive walk of an entry file's VALUE import graph. */
function collectImportViolations(entryFile, matchers) {
  const visited = new Set()
  const stack = [path.resolve(entryFile)]
  const violations = []
  while (stack.length > 0) {
    const file = stack.pop()
    if (visited.has(file)) continue
    visited.add(file)
    let source
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const imp of parseImports(source)) {
      const resolved = resolveRelativeImport(file, imp.specifier)
      if (!resolved) continue
      const norm = resolved.split(path.sep).join('/')
      if (matchers.some((re) => re.test(norm))) {
        violations.push(
          `${rel(file)} imports forbidden module "${imp.specifier}" (${imp.typeOnly ? 'type-only' : 'value'}) — the gateway impl / Apple sender / .p8 must never enter server.ts's graph`
        )
      }
      // Only VALUE imports pull a module into the runtime bundle; traverse those.
      if (!imp.typeOnly && !visited.has(resolved)) stack.push(resolved)
    }
  }
  return violations
}

/** Flat scan of a set of dirs for any direct import of a forbidden module. */
function collectDirectForbiddenImports(rootDirs, matchers) {
  const violations = []
  for (const dir of rootDirs) {
    const root = path.join(REPO_ROOT, dir)
    if (!fs.existsSync(root)) continue
    for (const file of findFiles(root, (p) => /\.(?:ts|tsx|cts|mts|js)$/.test(p))) {
      let source
      try {
        source = fs.readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const imp of parseImports(source)) {
        const resolved = resolveRelativeImport(file, imp.specifier)
        if (!resolved) continue
        const norm = resolved.split(path.sep).join('/')
        if (matchers.some((re) => re.test(norm))) {
          violations.push(
            `${rel(file)} imports forbidden module "${imp.specifier}" — the gateway impl / Apple sender / .p8 must never be imported by Electron main`
          )
        }
      }
    }
  }
  return violations
}

function scanBufferForSecrets(label, text, fingerprints) {
  const findings = []
  if (PEM_PRIVATE_KEY_BODY.test(text)) {
    findings.push(`${label}: contains a PEM PRIVATE KEY body`)
  }
  for (const fingerprint of fingerprints) {
    // Never echo the fingerprint value itself.
    if (fingerprint && text.includes(fingerprint)) {
      findings.push(`${label}: contains a known secret fingerprint`)
    }
  }
  return findings
}

function findFiles(root, predicate) {
  const matches = []
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
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        stack.push(full)
      } else if (entry.isFile() && predicate(full)) {
        matches.push(full)
      }
    }
  }
  return matches
}

function bundleScanTargets() {
  const targets = []
  const mainBundle = path.join(REPO_ROOT, 'out/main/index.js')
  if (fs.existsSync(mainBundle)) targets.push(mainBundle)
  for (const dir of ['dist', 'dist-debug']) {
    const root = path.join(REPO_ROOT, dir)
    if (!fs.existsSync(root)) continue
    for (const asar of findFiles(root, (p) => path.basename(p) === 'app.asar')) {
      targets.push(asar)
    }
  }
  return targets
}

function main() {
  const fingerprints = (process.env.TASKWRAITH_SECRET_FINGERPRINTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const problems = []

  // 1 + 2. Import boundary (always).
  problems.push(...collectImportViolations(GUARDED_ENTRY, SERVER_GRAPH_FORBIDDEN))
  problems.push(...collectDirectForbiddenImports(MAIN_SCAN_DIRS, MAIN_DIRECT_FORBIDDEN))

  // 3. Bundle scan (when present).
  const targets = bundleScanTargets()
  if (targets.length === 0) {
    console.log(
      '[guard-no-bundled-secrets] no build output to scan (out/main, app.asar) — ran import checks only'
    )
  }
  for (const target of targets) {
    let text
    try {
      text = fs.readFileSync(target, 'latin1')
    } catch (err) {
      problems.push(`${rel(target)}: unreadable (${err instanceof Error ? err.message : String(err)})`)
      continue
    }
    problems.push(...scanBufferForSecrets(rel(target), text, fingerprints))
  }

  if (problems.length > 0) {
    console.error('[guard-no-bundled-secrets] FAILED — potential secret leak / boundary violation:')
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    console.error(
      '\nSee docs/ios-push-gateway-design.md §4. The shared .p8 + gateway impl must never reach the embedded relay bundle.'
    )
    process.exit(1)
  }
  console.log(
    `[guard-no-bundled-secrets] ok — server.ts graph + Electron main clean; scanned ${targets.length} bundle target(s)`
  )
}

module.exports = {
  parseImports,
  resolveRelativeImport,
  collectImportViolations,
  collectDirectForbiddenImports,
  scanBufferForSecrets,
  PEM_PRIVATE_KEY_BODY,
  FORBIDDEN_MODULE_MATCHERS,
  SERVER_GRAPH_FORBIDDEN,
  MAIN_DIRECT_FORBIDDEN,
  GUARDED_ENTRY
}

if (require.main === module) {
  main()
}
