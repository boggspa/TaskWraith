#!/usr/bin/env node
'use strict'

/**
 * Guard: the checked-in `ios/TaskWraithApp/Generated/Info.plist` must still
 * agree with `project.yml`, its XcodeGen source of truth.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Generated/Info.plist` is generated output that is nonetheless TRACKED (the
 * TestFlight archive path builds from a clean checkout, so it cannot simply be
 * gitignored). Xcode rewrites that file in place whenever someone toggles a
 * checkbox in the target editor — and the orientation checkboxes are easy to
 * hit by accident. The rewrite lands as a plausible-looking two-line diff in a
 * file nobody reads, so a deliberate product decision gets reverted with no
 * review and nothing failing.
 *
 * Not hypothetical: the iPhone target is portrait-only on purpose, and an Xcode
 * session silently re-added LandscapeLeft/LandscapeRight to it. XcodeGen was
 * innocent — regenerating from project.yml reproduces the committed file byte
 * for byte.
 *
 * SCOPE. Orientation keys only — deliberately narrow rather than a general
 * plist-vs-spec differ, which would need a real plist parser and would still
 * skip the nested structures (UIApplicationSceneManifest, ATS) that a shallow
 * comparison cannot check honestly. A guard that checks one thing exactly beats
 * one that appears to check everything and quietly doesn't. Widen it by adding
 * to GUARDED_KEYS when another flat list of strings turns out to matter.
 *
 * NO YAML DEPENDENCY. js-yaml is only a transitive dep here, and a CI gate that
 * breaks when some unrelated package drops it is worse than no gate. The two
 * values needed are flat lists of scalars under a known key, so they are parsed
 * directly.
 *
 * Order is significant and IS compared: iOS treats the first entry as the
 * preferred orientation, so a reordered array is a real behaviour change.
 */

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const SPEC_RELATIVE = 'ios/TaskWraithApp/project.yml'
const PLIST_RELATIVE = 'ios/TaskWraithApp/Generated/Info.plist'

const GUARDED_KEYS = ['UISupportedInterfaceOrientations', 'UISupportedInterfaceOrientations~ipad']

/**
 * Read a flat `key:` → `- item` list out of the YAML spec.
 *
 * Indentation-scoped on purpose: items belong to the key only while they are
 * indented deeper than it, so the parser stops at the next sibling key instead
 * of running on into the rest of the file. Returns null when the key is absent.
 */
function specStringList(source, key) {
  const lines = source.split('\n')
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keyPattern = new RegExp(`^(\\s*)${escaped}:\\s*(.*)$`)

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyPattern)
    if (!match) continue
    // `key: [a, b]` inline form is not used in this spec; treat a non-empty
    // trailing value as "not the block list we expect" rather than guessing.
    if (match[2].trim() && !match[2].trim().startsWith('#')) return null

    const keyIndent = match[1].length
    const items = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (!line.trim() || line.trim().startsWith('#')) continue
      const indent = line.length - line.trimStart().length
      if (indent <= keyIndent) break
      const item = line.trim()
      if (!item.startsWith('- ')) break
      items.push(
        item
          .slice(2)
          .trim()
          .replace(/^["']|["']$/g, '')
      )
    }
    return items
  }
  return null
}

/** Read a `<key>NAME</key><array><string>…</string></array>` block. */
function plistStringList(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`<key>${escaped}</key>\\s*<array>([\\s\\S]*?)</array>`))
  if (!match) return null
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1])
}

/** Pure comparison — returns a list of human-readable mismatches. */
function evaluatePlistDrift(specSource, plistSource, keys = GUARDED_KEYS) {
  const failures = []
  for (const key of keys) {
    const expected = specStringList(specSource, key)
    if (expected === null) {
      failures.push(`${key}: not declared as a list in project.yml`)
      continue
    }
    const actual = plistStringList(plistSource, key)
    if (actual === null) {
      failures.push(`${key}: absent from Generated/Info.plist`)
      continue
    }
    if (actual.length !== expected.length || actual.some((v, i) => v !== expected[i])) {
      failures.push(
        `${key}:\n      project.yml  → ${JSON.stringify(expected)}\n` +
          `      Info.plist   → ${JSON.stringify(actual)}`
      )
    }
  }
  return failures
}

function main(repoRoot = join(__dirname, '..')) {
  const specSource = readFileSync(join(repoRoot, SPEC_RELATIVE), 'utf8')
  const plistSource = readFileSync(join(repoRoot, PLIST_RELATIVE), 'utf8')
  const failures = evaluatePlistDrift(specSource, plistSource)

  if (failures.length) {
    console.error('[ios-plist-guard] FAIL — Generated/Info.plist has drifted from project.yml:\n')
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      '\n  Generated/Info.plist is XcodeGen OUTPUT — do not hand-edit it, and do not' +
        '\n  accept an Xcode-authored diff to it. Either regenerate:' +
        '\n' +
        '\n      cd ios/TaskWraithApp && xcodegen generate' +
        '\n' +
        '\n  or, if the change IS intended, make it in project.yml first and regenerate.\n'
    )
    process.exitCode = 1
    return
  }

  const iphone = specStringList(specSource, GUARDED_KEYS[0]) || []
  const ipad = specStringList(specSource, GUARDED_KEYS[1]) || []
  console.log(
    `[ios-plist-guard] ok — orientation keys match project.yml` +
      ` (iPhone: ${iphone.join(', ')}; iPad: ${ipad.length} orientations).`
  )
}

module.exports = { GUARDED_KEYS, evaluatePlistDrift, plistStringList, specStringList, main }

if (require.main === module) main()
