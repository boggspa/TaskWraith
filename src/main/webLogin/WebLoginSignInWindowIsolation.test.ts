import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Design section 6a, applied to the sign-in window.
 *
 * The user types a password into this window. The invariant is that no canvas
 * driver can observe or actuate it, and 6a is explicit that the invariant must
 * be STRUCTURAL - "no canvas driver can resolve that webContents" - rather than
 * a refusal list inside a driver, because a refusal list is only as good as its
 * next edit.
 *
 * Structural here means the import edge does not exist. A canvas module that
 * cannot name the sign-in window cannot be handed its handle, and the handle is
 * the only way to reach that webContents: the controller keeps it in a private
 * map and returns a value-only outcome.
 *
 * The Tier 4 native-window path is covered elsewhere and by a different
 * mechanism - `verifyNativeWindowProcessAncestry` refuses protected host PIDs
 * at the leaf, and the sign-in window belongs to the TaskWraith process itself.
 * This test does not restate that; it pins the edge this feature owns.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SIGN_IN_MODULES = ['WebLoginSignInWindow', 'WebLoginSignInWindowElectron']

function sourceFilesUnder(relativeDir: string): string[] {
  const root = path.join(REPO_ROOT, relativeDir)
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      if (entry.name.includes('.test.')) continue
      out.push(full)
    }
  }
  walk(root)
  return out
}

describe('sign-in window isolation (design 6a)', () => {
  it('no canvas module can name the sign-in window', () => {
    const offenders: string[] = []
    for (const file of sourceFilesUnder('src/main/canvas')) {
      const source = fs.readFileSync(file, 'utf-8')
      for (const moduleName of SIGN_IN_MODULES) {
        if (source.includes(moduleName)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} references ${moduleName}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('no canvas TOOL executor can name the sign-in window either', () => {
    const offenders: string[] = []
    for (const file of sourceFilesUnder('src/main/mcp')) {
      const source = fs.readFileSync(file, 'utf-8')
      for (const moduleName of SIGN_IN_MODULES) {
        if (source.includes(moduleName)) {
          offenders.push(`${path.relative(REPO_ROOT, file)} references ${moduleName}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the sign-in window reaches into no canvas module', () => {
    // The other direction matters too: importing a canvas surface here would
    // let a future edit hand the window to a driver without any canvas file
    // changing, so the test above would stay green while the edge appeared.
    for (const moduleName of SIGN_IN_MODULES) {
      const source = fs.readFileSync(path.join(__dirname, `${moduleName}.ts`), 'utf-8')
      expect(source).not.toMatch(/from '\.\.\/canvas\//)
      expect(source).not.toMatch(/from '\.\/.*Canvas/)
    }
  })

  it('the controller never returns the window handle to a caller', () => {
    // The handle is the only route to that webContents. It is created inside
    // signIn(), held in a private map, and never appears in the resolved value.
    const source = fs.readFileSync(path.join(__dirname, 'WebLoginSignInWindow.ts'), 'utf-8')
    expect(source).toContain('private readonly open = new Map<string, SignInWindowHandle>()')
    // The outcome union is value-only: ok/siteId/suggestedOrigins/reason.
    expect(source).not.toMatch(/handle:\s*SignInWindowHandle\s*\}/)
    expect(source).not.toMatch(/window:\s*SignInWindowHandle/)
  })

  it('the Electron adapter is the ONLY module that constructs a sign-in window', () => {
    const offenders: string[] = []
    for (const file of sourceFilesUnder('src/main/webLogin')) {
      if (path.basename(file) === 'WebLoginSignInWindowElectron.ts') continue
      const source = fs.readFileSync(file, 'utf-8')
      if (source.includes('new BrowserWindow')) {
        offenders.push(path.relative(REPO_ROOT, file))
      }
    }
    expect(offenders).toEqual([])
  })
})
