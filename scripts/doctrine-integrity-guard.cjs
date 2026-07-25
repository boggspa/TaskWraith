#!/usr/bin/env node
/*
 * Fails CI if any agent-read file contains invisible or direction-overriding
 * characters.
 *
 * WHY: this repo's markdown is executable doctrine — AGENTS.md is injected into
 * agent sessions and its assertions are obeyed. That makes it an instruction
 * channel, and the repo is public, so a PR can carry text that a human reviewer
 * cannot see in a diff. Two published classes matter here:
 *
 *   - Invisible codepoints (zero-width, word joiners, soft hyphen, and the
 *     U+E0000 tag block) can hide an entire instruction inside innocuous prose.
 *   - Bidirectional overrides (Trojan Source, CVE-2021-42574) make rendered text
 *     read differently from the bytes an agent actually consumes.
 *
 * Prose asking agents to be careful cannot detect either one. This can.
 *
 * Baseline at introduction (2026-07-25): zero hits across 146 tracked markdown
 * files, so the guard starts green and any hit is new. Variation selectors
 * (U+FE00–FE0F) are included because none are currently present; if legitimate
 * emoji ever land, narrow that range rather than deleting the check.
 */

const { execFileSync } = require('child_process')
const { readFileSync } = require('fs')

/** [start, end, name] — inclusive codepoint ranges that must not appear. */
const FORBIDDEN_RANGES = [
  [0x00ad, 0x00ad, 'SOFT HYPHEN'],
  [0x180e, 0x180e, 'MONGOLIAN VOWEL SEPARATOR'],
  [0x200b, 0x200d, 'ZERO WIDTH SPACE/NON-JOINER/JOINER'],
  [0x200e, 0x200f, 'LEFT/RIGHT-TO-LEFT MARK'],
  [0x202a, 0x202e, 'BIDI EMBEDDING/OVERRIDE (Trojan Source)'],
  [0x2060, 0x2064, 'WORD JOINER / INVISIBLE OPERATOR'],
  [0x2066, 0x2069, 'BIDI ISOLATE (Trojan Source)'],
  [0xfe00, 0xfe0f, 'VARIATION SELECTOR'],
  [0xfeff, 0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
  [0xe0000, 0xe007f, 'UNICODE TAG CHARACTER (invisible instruction channel)']
]

function forbiddenName(codePoint) {
  for (const [start, end, name] of FORBIDDEN_RANGES) {
    if (codePoint >= start && codePoint <= end) return name
  }
  return null
}

function trackedFiles() {
  const out = execFileSync(
    'git',
    ['ls-files', '*.md', 'scripts/provider-intent.json', '.claude/**'],
    { encoding: 'utf8' }
  )
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const files = trackedFiles()
const findings = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  let line = 1
  let column = 1
  // Iterate by code point, not UTF-16 unit, so astral tag characters are seen.
  for (const character of text) {
    if (character === '\n') {
      line += 1
      column = 1
      continue
    }
    const codePoint = character.codePointAt(0)
    const name = forbiddenName(codePoint)
    if (name) {
      findings.push(
        `${file}:${line}:${column}  U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}  ${name}`
      )
    }
    column += 1
  }
}

if (findings.length > 0) {
  console.error(
    `[doctrine-integrity-guard] FAILED — ${findings.length} invisible/bidi character(s) in agent-read files:`
  )
  for (const finding of findings.slice(0, 50)) console.error(`  ${finding}`)
  if (findings.length > 50) console.error(`  …and ${findings.length - 50} more`)
  console.error(
    '\nThese are invisible in a rendered diff. AGENTS.md and the docs are injected\n' +
      'into agent sessions as doctrine, so hidden text there is an instruction\n' +
      'channel. Remove the characters; do not add them to an allowlist without\n' +
      'establishing why a doctrine file needs an invisible codepoint.'
  )
  process.exit(1)
}

console.log(
  `[doctrine-integrity-guard] ok — ${files.length} agent-read files, no invisible/bidi characters`
)
