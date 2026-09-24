import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APP_TRANSLOCATION_PATH_MARKER,
  appTranslocationRemedyMessage,
  pathIsAppTranslocated
} from './AppTranslocation'

// The exact shape macOS produced on a tester's machine, where every Mistral
// turn reported the TaskWraith MCP server failing with [Errno 2].
const TRANSLOCATED =
  '/private/var/folders/sq/ws16r6yx30b2b1gk6b8ktctw0000gn/T/AppTranslocation/' +
  '2ED9A6C4-627C-4A7B-B634-6345C2B439A0/d/TaskWraith.app/Contents/MacOS/TaskWraith'

describe('pathIsAppTranslocated', () => {
  it('recognises a real Gatekeeper translocation path', () => {
    expect(pathIsAppTranslocated(TRANSLOCATED)).toBe(true)
    expect(APP_TRANSLOCATION_PATH_MARKER).toBe('/AppTranslocation/')
  })

  it('recognises it wherever the bundle sits inside the mount', () => {
    // The reported failure named the mount root rather than the executable
    // inside the bundle, so the test must not depend on the tail.
    expect(
      pathIsAppTranslocated('/private/var/folders/x/y/T/AppTranslocation/UUID/d/TaskWraith')
    ).toBe(true)
  })

  it('leaves a normally installed app alone', () => {
    expect(pathIsAppTranslocated('/Applications/TaskWraith.app/Contents/MacOS/TaskWraith')).toBe(
      false
    )
    expect(
      pathIsAppTranslocated('/Users/me/Applications/TaskWraith.app/Contents/MacOS/TaskWraith')
    ).toBe(false)
    // A dev run out of the repo, and the Linux/Windows equivalents.
    expect(pathIsAppTranslocated('/Users/me/AGBench/node_modules/electron/dist/Electron')).toBe(
      false
    )
    expect(pathIsAppTranslocated('C:\\Program Files\\TaskWraith\\TaskWraith.exe')).toBe(false)
  })

  it('does not fire on an ordinary temp path or a lookalike name', () => {
    // The marker is a path SEGMENT; a file merely mentioning it is not a mount.
    expect(pathIsAppTranslocated('/private/var/folders/x/y/T/taskwraith-muse-home-ab12/bin')).toBe(
      false
    )
    expect(pathIsAppTranslocated('/Users/me/notes/AppTranslocation-explained.md')).toBe(false)
  })

  it('treats an absent path as not translocated', () => {
    expect(pathIsAppTranslocated(null)).toBe(false)
    expect(pathIsAppTranslocated(undefined)).toBe(false)
    expect(pathIsAppTranslocated('')).toBe(false)
  })
})

describe('appTranslocationRemedyMessage', () => {
  it('names the remedy, not just the mechanism', () => {
    const message = appTranslocationRemedyMessage()
    // What the user sees otherwise is a provider reporting a missing file,
    // which says nothing about the app running from the wrong place.
    expect(message).toContain('/Applications')
    expect(message).toContain('com.apple.quarantine')
    expect(message).toMatch(/quit/i)
  })
})

describe('taskwraithMcpBridgeCommandStatus wiring', () => {
  const source = readFileSync(join(__dirname, 'index.ts'), 'utf8')
  const fn = source.slice(
    source.indexOf('function taskwraithMcpBridgeCommandStatus('),
    source.indexOf('function taskwraithMcpBridgeUnavailableMessage(')
  )

  it('refuses a translocated command instead of reporting it available', () => {
    expect(fn).toContain('pathIsAppTranslocated(command)')
    expect(fn).toContain('appTranslocationRemedyMessage()')
    expect(source).toContain("from './AppTranslocation'")
  })

  it('checks translocation BEFORE the executable-access check', () => {
    // A translocated path passes access(X_OK) in this process — the mount is
    // live here and dies with it. Checking after would report `available` and
    // hand every provider a command that fails in the child.
    const translocationAt = fn.indexOf('pathIsAppTranslocated(command)')
    const accessAt = fn.indexOf('accessSync(command')
    expect(translocationAt).toBeGreaterThan(-1)
    expect(accessAt).toBeGreaterThan(-1)
    expect(translocationAt).toBeLessThan(accessAt)
  })

  it('marks it unavailable, which is what every consumer gates on', () => {
    // Cursor/Gemini/agy PERSIST this command to a config file, so `available`
    // is also what stops a dead path outliving the launch that produced it.
    const refusal = fn.slice(fn.indexOf('pathIsAppTranslocated(command)'))
    expect(refusal.slice(0, 260)).toContain('available: false')
  })
})
