import * as fs from 'fs'
import * as path from 'path'
import { INSTRUCTION_LAYER_MAX_BYTES } from '../../shared/instructions/InstructionTypes'

const INSTRUCTIONS_DIR = 'instructions'
const GLOBAL_FILE = 'GLOBAL.md'

export interface InstructionStoreDeps {
  userDataPath: string
  now?: () => Date
}

export interface GlobalInstructionsDocument {
  content: string
  /** ISO timestamp of the last write; null when the document has never existed. */
  updatedAt: string | null
  sizeBytes: number
}

function realpathNative(input: string): string {
  return typeof fs.realpathSync.native === 'function'
    ? fs.realpathSync.native(input)
    : fs.realpathSync(input)
}

/**
 * Main-owned store for the user's GLOBAL custom-instructions document.
 *
 * A standalone markdown file under userData rather than a field in the
 * settings JSON: `updateSettings` does a synchronous full settings rewrite,
 * and an arbitrarily large prompt document does not belong in that hot path.
 * Follows the SkillsStore layout conventions (0o700 directory, symlink
 * refusal before any write).
 */
export class InstructionStore {
  private readonly now: () => Date

  constructor(private readonly deps: InstructionStoreDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  instructionsRoot(): string {
    return path.resolve(this.deps.userDataPath, INSTRUCTIONS_DIR)
  }

  globalDocumentPath(): string {
    return path.join(this.instructionsRoot(), GLOBAL_FILE)
  }

  readGlobalDocument(): GlobalInstructionsDocument {
    const filePath = this.globalDocumentPath()
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(filePath)
    } catch {
      return { content: '', updatedAt: null, sizeBytes: 0 }
    }
    // A symlinked global document is refused the same way the workspace
    // resolver refuses one: the store only ever writes a regular file, so a
    // link here is tampering, not configuration.
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { content: '', updatedAt: null, sizeBytes: 0 }
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return {
        content,
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size
      }
    } catch {
      return { content: '', updatedAt: null, sizeBytes: 0 }
    }
  }

  /**
   * Persist the global document. Rejects oversized content outright (the
   * resolver would skip it anyway — failing the write keeps the editor
   * honest instead of storing something that will never apply). Character
   * safety (bidi/C0) is deliberately NOT enforced here: the resolver reports
   * it as a visible skipped-layer status, which the settings UI surfaces,
   * rather than the store silently rewriting user text.
   */
  writeGlobalDocument(content: string): GlobalInstructionsDocument {
    if (typeof content !== 'string') {
      throw new Error('Instruction content must be a string.')
    }
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > INSTRUCTION_LAYER_MAX_BYTES) {
      throw new Error(
        `Custom instructions are ${bytes} bytes; the limit is ${INSTRUCTION_LAYER_MAX_BYTES}.`
      )
    }
    const root = this.instructionsRoot()
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    const realRoot = realpathNative(root)
    const filePath = path.join(realRoot, GLOBAL_FILE)
    let existing: fs.Stats | null = null
    try {
      existing = fs.lstatSync(filePath)
    } catch {
      existing = null
    }
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error('Refusing to write custom instructions over a non-regular file.')
    }
    fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
    return {
      content,
      updatedAt: this.now().toISOString(),
      sizeBytes: bytes
    }
  }
}
