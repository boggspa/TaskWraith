#!/usr/bin/env node

/**
 * Provider-intent guard — mechanical enforcement of AGENTS.md "Capability
 * governance — the user decides (non-negotiable)".
 *
 * The live-selectable provider set is a product decision reserved to the
 * user. scripts/provider-intent.json records the user-approved intent, and
 * this guard rejects drift between that intent and the two code copies:
 *
 *   1. LIVE_SELECTABLE_PROVIDER_IDS in src/shared/retiredProviders.ts must
 *      equal the intent list exactly — removals are capability narrowing,
 *      additions (e.g. a retired provider creeping back) are capability
 *      changes; both require a user-approved edit to the intent file in the
 *      same commit. Precedent: 2026-07-19, an autonomous session silently
 *      removed Cursor from the live set.
 *   2. TWTheme.liveSelectableProviderIds in
 *      ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift is a hand-mirrored
 *      copy with no shared source of truth and must equal the TS set exactly.
 *      Precedent: iOS build 81 shipped a Cursor lockout from exactly this
 *      drift. ComposerView.swift derives its fallback roster from TWTheme, so
 *      Theme.swift is the only Swift declaration this guard needs to read.
 *
 * As a consistency backstop, no provider may be simultaneously live-selectable
 * and in RETIRED_PROVIDER_IDS (gemini has been deliberately retired since
 * 2026-06-18).
 *
 * Schema 2 adds `conditionallyOfferedProviderIds`: providers the user has
 * approved as product capabilities that are deliberately NOT in the static
 * live set because they are offered only behind a consent/credential wall
 * (today: antigravity). This records the approval — so their absence from the
 * live set reads as the approved design rather than drift — and inverts the
 * check for them: a conditionally-offered provider appearing in either live
 * set is a FAILURE, because every gate is written
 * `isLiveSelectableProvider(p) || (p === 'antigravity' && <condition>)` and
 * promoting it short-circuits the condition, silently deleting the wall.
 * AGENTS.md rule 5, "doctrine is executable": this makes the code-comment
 * convention a mechanically enforced invariant.
 *
 * Both parsers fail loudly when a declaration cannot be found or is no longer
 * a plain literal — a parse miss must never pass vacuously. Scope is
 * deliberately tight: set comparisons over three tracked files, no doctrine
 * grep, no runtime checks.
 */

const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const REPO_ROOT = path.join(__dirname, '..')
const INTENT_PATH = path.join(__dirname, 'provider-intent.json')
const INTENT_REPO_PATH = 'scripts/provider-intent.json'
const TS_SOURCE_REPO_PATH = 'src/shared/retiredProviders.ts'
const SWIFT_SOURCE_REPO_PATH = 'ios/TaskWraithKit/Sources/TaskWraithUI/Theme.swift'

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const SCHEMA_VERSION = 2

function assertProviderIdList(ids, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(ids) || (ids.length === 0 && !allowEmpty)) {
    throw new Error(`${label} must be a non-empty array of provider ids`)
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id)) {
      throw new Error(
        `${label} contains a non-canonical provider id ${JSON.stringify(id)}; ids are lowercase slugs`
      )
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicate provider ids: ${ids.join(', ')}`)
  }
}

function validateIntent(intent) {
  if (!intent || intent.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${INTENT_REPO_PATH} must have schemaVersion: ${SCHEMA_VERSION}`)
  }
  assertProviderIdList(
    intent.liveSelectableProviderIds,
    `${INTENT_REPO_PATH} liveSelectableProviderIds`
  )

  // May be empty (no conditionally-offered providers), but must be declared:
  // an omitted field would let a wall-gated provider go unrecorded.
  const conditional = intent.conditionallyOfferedProviderIds
  assertProviderIdList(conditional, `${INTENT_REPO_PATH} conditionallyOfferedProviderIds`, {
    allowEmpty: true
  })

  const live = new Set(intent.liveSelectableProviderIds)
  const bothLists = conditional.filter((id) => live.has(id)).sort()
  if (bothLists.length > 0) {
    throw new Error(
      `${INTENT_REPO_PATH} lists ${bothLists.join(', ')} as BOTH live-selectable and conditionally offered; a provider is either statically live or gated behind a wall, never both.`
    )
  }

  const notes = intent.conditionalOfferNotes
  if (notes !== undefined) {
    if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
      throw new Error(`${INTENT_REPO_PATH} conditionalOfferNotes must be an object when present`)
    }
    const conditionalSet = new Set(conditional)
    for (const [id, note] of Object.entries(notes)) {
      if (!conditionalSet.has(id)) {
        throw new Error(
          `${INTENT_REPO_PATH} conditionalOfferNotes documents ${JSON.stringify(id)}, which is not in conditionallyOfferedProviderIds`
        )
      }
      if (typeof note !== 'string' || note.trim().length === 0) {
        throw new Error(
          `${INTENT_REPO_PATH} conditionalOfferNotes.${id} must be a non-empty string explaining the gate`
        )
      }
    }
  }
}

function readIntent(intentPath = INTENT_PATH) {
  let intent
  try {
    intent = JSON.parse(fs.readFileSync(intentPath, 'utf8'))
  } catch (error) {
    throw new Error(
      `Unable to read ${INTENT_REPO_PATH}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  validateIntent(intent)
  return intent
}

function parseTsSource(filePath, source) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const diagnostics = sourceFile.parseDiagnostics || []
  if (diagnostics.length > 0) {
    throw new Error(
      `${filePath}: ${diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('; ')}`
    )
  }
  return sourceFile
}

function unwrapExpression(node) {
  let current = node
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(current)))
  ) {
    current = current.expression
  }
  return current
}

function stringLiteralElements(arrayLiteral, declarationName, filePath) {
  const ids = []
  for (const element of arrayLiteral.elements) {
    if (!ts.isStringLiteralLike(element)) {
      throw new Error(
        `${filePath}: ${declarationName} contains a non-literal element (${element.getText().slice(0, 80)}). The provider-intent guard can only verify plain string-literal sets; keep the declaration literal or update the guard in the same change.`
      )
    }
    ids.push(element.text)
  }
  return ids
}

/**
 * Extract LIVE_SELECTABLE_PROVIDER_IDS (array literal, `as const`) and
 * RETIRED_PROVIDER_IDS (`new Set([...])`) from retiredProviders.ts via the
 * TypeScript AST. Throws — never returns partial data — when either
 * declaration is missing, duplicated, or not a plain literal.
 */
function parseTsProviderSets(source, filePath = TS_SOURCE_REPO_PATH) {
  const sourceFile = parseTsSource(filePath, source)
  let live = null
  let retired = null

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue
      const name = declaration.name.text
      if (name === 'LIVE_SELECTABLE_PROVIDER_IDS') {
        if (live)
          throw new Error(`${filePath}: LIVE_SELECTABLE_PROVIDER_IDS is declared more than once`)
        const initializer = unwrapExpression(declaration.initializer)
        if (!initializer || !ts.isArrayLiteralExpression(initializer)) {
          throw new Error(
            `${filePath}: LIVE_SELECTABLE_PROVIDER_IDS is not a plain array literal; the guard cannot verify it and refuses to pass vacuously.`
          )
        }
        live = stringLiteralElements(initializer, 'LIVE_SELECTABLE_PROVIDER_IDS', filePath)
      } else if (name === 'RETIRED_PROVIDER_IDS') {
        if (retired) throw new Error(`${filePath}: RETIRED_PROVIDER_IDS is declared more than once`)
        const initializer = unwrapExpression(declaration.initializer)
        if (
          !initializer ||
          !ts.isNewExpression(initializer) ||
          !ts.isIdentifier(initializer.expression) ||
          initializer.expression.text !== 'Set'
        ) {
          throw new Error(
            `${filePath}: RETIRED_PROVIDER_IDS is not a plain \`new Set([...])\` literal; the guard cannot verify it and refuses to pass vacuously.`
          )
        }
        const argument = unwrapExpression((initializer.arguments || [])[0])
        if (argument === undefined) {
          retired = []
        } else if (ts.isArrayLiteralExpression(argument)) {
          retired = stringLiteralElements(argument, 'RETIRED_PROVIDER_IDS', filePath)
        } else {
          throw new Error(
            `${filePath}: RETIRED_PROVIDER_IDS is not seeded from a plain array literal; the guard cannot verify it and refuses to pass vacuously.`
          )
        }
      }
    }
  }

  if (!live) {
    throw new Error(
      `${filePath}: LIVE_SELECTABLE_PROVIDER_IDS declaration not found — refusing to pass vacuously. If the declaration moved or was renamed, update provider-intent-guard.cjs in the same change.`
    )
  }
  if (!retired) {
    throw new Error(
      `${filePath}: RETIRED_PROVIDER_IDS declaration not found — refusing to pass vacuously. If the declaration moved or was renamed, update provider-intent-guard.cjs in the same change.`
    )
  }
  assertProviderIdList(live, `${filePath} LIVE_SELECTABLE_PROVIDER_IDS`)
  return { live, retired }
}

const SWIFT_DECLARATION_PATTERN =
  /static\s+let\s+liveSelectableProviderIds\s*:\s*Set<String>\s*=\s*\[/g

/**
 * Extract TWTheme.liveSelectableProviderIds from Theme.swift. Regex over the
 * set literal by design (no Swift parser available), but defensive: exactly
 * one declaration in the expected `static let ...: Set<String> = [...]` shape,
 * and after removing string literals, line comments, commas, and whitespace
 * from the bracket body, nothing may remain. Any anomaly throws — a silent
 * parse miss must not vacuously pass.
 */
function parseSwiftLiveSet(source, filePath = SWIFT_SOURCE_REPO_PATH) {
  const matches = [...source.matchAll(SWIFT_DECLARATION_PATTERN)]
  if (matches.length === 0) {
    if (source.includes('liveSelectableProviderIds')) {
      throw new Error(
        `${filePath}: liveSelectableProviderIds is referenced but no \`static let liveSelectableProviderIds: Set<String> = [...]\` declaration parses — refusing to pass vacuously. Keep the declaration a plain literal or update provider-intent-guard.cjs in the same change.`
      )
    }
    throw new Error(
      `${filePath}: liveSelectableProviderIds declaration not found — refusing to pass vacuously. If the iOS live-provider set moved, update provider-intent-guard.cjs in the same change.`
    )
  }
  if (matches.length > 1) {
    throw new Error(
      `${filePath}: liveSelectableProviderIds is declared ${matches.length} times; the guard cannot tell which is authoritative.`
    )
  }

  const start = matches[0].index + matches[0][0].length
  const end = source.indexOf(']', start)
  if (end < 0) {
    throw new Error(`${filePath}: liveSelectableProviderIds set literal is unterminated`)
  }
  const body = source.slice(start, end).replace(/\/\/[^\n]*/g, '')
  const ids = []
  const remainder = body.replace(/"([^"\\]*)"/g, (_match, id) => {
    ids.push(id)
    return ''
  })
  if (/[^\s,]/.test(remainder)) {
    throw new Error(
      `${filePath}: liveSelectableProviderIds contains non-literal content (${remainder.trim().slice(0, 80)}); the guard can only verify a plain string-literal set.`
    )
  }
  if (ids.length === 0) {
    throw new Error(
      `${filePath}: liveSelectableProviderIds parsed as empty — refusing to treat an unparsed or emptied set as passing.`
    )
  }
  assertProviderIdList(ids, `${filePath} liveSelectableProviderIds`)
  return ids
}

function setDiff(expected, actual) {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  return {
    missing: [...expectedSet].filter((id) => !actualSet.has(id)).sort(),
    unexpected: [...actualSet].filter((id) => !expectedSet.has(id)).sort()
  }
}

function evaluateProviderIntent({
  intentIds,
  tsLive,
  tsRetired,
  swiftLive,
  conditionalIds = []
}) {
  const failures = []

  const intentDrift = setDiff(intentIds, tsLive)
  if (intentDrift.missing.length > 0 || intentDrift.unexpected.length > 0) {
    const lines = [
      `LIVE_SELECTABLE_PROVIDER_IDS in ${TS_SOURCE_REPO_PATH} does not equal the user-approved intent list in ${INTENT_REPO_PATH}:`
    ]
    if (intentDrift.missing.length > 0) {
      lines.push(
        `    removed from the live set (capability narrowing): ${intentDrift.missing.join(', ')}`
      )
    }
    if (intentDrift.unexpected.length > 0) {
      lines.push(
        `    added to the live set without user approval: ${intentDrift.unexpected.join(', ')}`
      )
    }
    lines.push(
      `    AGENTS.md, "Capability governance — the user decides (non-negotiable)": "The live-provider set is a product decision, not an engineering lever." Capability narrowing requires explicit user approval in-session — "Do not land code, config, CI, or doctrine that narrows user-facing capability without the user approving that exact narrowing in the current session." A provider may only enter or leave this set via a user-approved edit to ${INTENT_REPO_PATH} in the same commit (precedent: 2026-07-19, an autonomous session silently removed Cursor).`
    )
    failures.push(lines.join('\n'))
  }

  const retiredSet = new Set(tsRetired)
  const retiredOverlap = [...new Set([...intentIds, ...tsLive, ...conditionalIds])]
    .filter((id) => retiredSet.has(id))
    .sort()
  if (retiredOverlap.length > 0) {
    failures.push(
      `Retired provider${retiredOverlap.length === 1 ? '' : 's'} may not be live-selectable or conditionally offered: ${retiredOverlap.join(', ')} appear${retiredOverlap.length === 1 ? 's' : ''} in RETIRED_PROVIDER_IDS and in the live set, intent list, or conditional-offer list. Retirement keeps a provider decodable for history only (gemini has been deliberately retired since 2026-06-18); un-retiring is a user decision and must remove the id from RETIRED_PROVIDER_IDS in the same commit.`
    )
  }

  // Inverted check: a conditionally-offered provider must stay OUT of both
  // static live sets. Promotion is a capability change reserved to the user AND
  // a silent teardown of the provider's consent wall.
  const conditionalPromoted = [...new Set(conditionalIds)]
    .filter((id) => tsLive.includes(id) || swiftLive.includes(id))
    .sort()
  if (conditionalPromoted.length > 0) {
    const surfaces = conditionalPromoted.map((id) => {
      const where = [
        tsLive.includes(id) ? TS_SOURCE_REPO_PATH : null,
        swiftLive.includes(id) ? SWIFT_SOURCE_REPO_PATH : null
      ].filter(Boolean)
      return `${id} (in ${where.join(' and ')})`
    })
    failures.push(
      [
        `Conditionally-offered provider${conditionalPromoted.length === 1 ? '' : 's'} promoted into the static live set: ${surfaces.join('; ')}.`,
        `    ${INTENT_REPO_PATH} records ${conditionalPromoted.join(', ')} as approved but deliberately NOT live-selectable — offered only behind a consent/credential wall.`,
        `    Every gate is written \`isLiveSelectableProvider(p) || (p === '<id>' && <condition>)\`, so making the left side true short-circuits the condition and deletes the wall (an unconfigured provider becomes offerable and dispatchable with no consent recorded).`,
        `    If promotion is genuinely intended, the user must move the id from conditionallyOfferedProviderIds to liveSelectableProviderIds in ${INTENT_REPO_PATH} in the same commit, and the now-dead conditions must be removed deliberately rather than left as no-ops.`
      ].join('\n')
    )
  }

  const swiftDrift = setDiff(tsLive, swiftLive)
  if (swiftDrift.missing.length > 0 || swiftDrift.unexpected.length > 0) {
    const lines = [
      `liveSelectableProviderIds in ${SWIFT_SOURCE_REPO_PATH} has drifted from ${TS_SOURCE_REPO_PATH}:`
    ]
    if (swiftDrift.missing.length > 0) {
      lines.push(`    missing on iOS: ${swiftDrift.missing.join(', ')}`)
    }
    if (swiftDrift.unexpected.length > 0) {
      lines.push(`    present on iOS but not live on desktop: ${swiftDrift.unexpected.join(', ')}`)
    }
    lines.push(
      `    The iOS set is a hand-mirrored copy with no shared source of truth; mirror the desktop change in Theme.swift in the same commit (iOS build 81 shipped a Cursor lockout from exactly this drift).`
    )
    failures.push(lines.join('\n'))
  }

  return failures
}

function collectProviderSets(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT
  const intent = readIntent(options.intentPath || INTENT_PATH)
  const tsSource = fs.readFileSync(path.join(repoRoot, TS_SOURCE_REPO_PATH), 'utf8')
  const { live: tsLive, retired: tsRetired } = parseTsProviderSets(tsSource)
  const swiftSource = fs.readFileSync(path.join(repoRoot, SWIFT_SOURCE_REPO_PATH), 'utf8')
  const swiftLive = parseSwiftLiveSet(swiftSource)
  return {
    intentIds: intent.liveSelectableProviderIds,
    conditionalIds: intent.conditionallyOfferedProviderIds,
    tsLive,
    tsRetired,
    swiftLive
  }
}

function main() {
  try {
    const sets = collectProviderSets()
    const failures = evaluateProviderIntent(sets)
    if (failures.length > 0) {
      console.error(
        '[provider-intent-guard] FAILED — live-provider set drifted from user-approved intent:'
      )
      for (const failure of failures) console.error(`  ✗ ${failure}`)
      process.exitCode = 1
      return
    }
    const conditional = [...(sets.conditionalIds || [])].sort()
    console.log(
      `[provider-intent-guard] ok — live set [${[...sets.intentIds].sort().join(', ')}] matches ${TS_SOURCE_REPO_PATH} and the iOS mirror; retired [${[...sets.tsRetired].sort().join(', ')}] stays out; wall-gated [${conditional.join(', ') || 'none'}] approved and correctly out of the static live set`
    )
  } catch (error) {
    console.error(
      `[provider-intent-guard] FAILED — ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  collectProviderSets,
  evaluateProviderIntent,
  parseSwiftLiveSet,
  parseTsProviderSets,
  readIntent,
  validateIntent
}

if (require.main === module) main()
