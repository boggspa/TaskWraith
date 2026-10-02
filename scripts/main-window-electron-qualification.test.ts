import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { mainSource, execute } = require('./main-window-electron-qualification.cjs')

it('uses the existing bounded executor and only pure isolated native measurement modules', () => {
  expect(execute).toBe(require('./main-durability-electron-qualification.cjs').execute)
  const source = mainSource()
  expect(() => new Function(source)).not.toThrow()
  expect(source).toContain("powerSaveBlocker.start('prevent-app-suspension')")
  expect(source).toContain('powerSaveBlocker.isStarted(id)')
  expect(source).toContain('powerSaveBlocker.stop(id)')
  expect(source).toContain("id: 'error_window'")
  expect(source).toContain('privateResidualsAligned: false')
  expect(source).not.toMatch(/BrowserWindow|AppStore|Studio|auth|Host-stop/)
})
