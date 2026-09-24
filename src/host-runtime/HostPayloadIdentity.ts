/** Deterministic identity for the static pure-Node Host payload. */

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, parse, relative, resolve, sep } from 'node:path'

const HOST_PAYLOAD_MAX_FILES = 20_000
const HOST_PAYLOAD_MAX_BYTES = 512 * 1024 * 1024
const HOST_PAYLOAD_VERSION_PATTERN = /^sha256:[a-f0-9]{64}$/

export function isHostPayloadVersion(value: unknown): value is string {
  return typeof value === 'string' && HOST_PAYLOAD_VERSION_PATTERN.test(value)
}

function payloadFiles(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name.endsWith('.map')) continue
      const path = resolve(directory, entry.name)
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('Host payload must not contain symbolic links')
      if (stat.isDirectory()) {
        visit(path)
        continue
      }
      if (!stat.isFile()) throw new Error('Host payload contains an unsupported entry')
      files.push(path)
      if (files.length > HOST_PAYLOAD_MAX_FILES) {
        throw new Error('Host payload file count exceeds the identity bound')
      }
    }
  }
  visit(root)
  return files
}

/**
 * Hash relative names and bytes in canonical order. Source maps are excluded
 * because packaging deliberately removes them; the executable JavaScript and
 * other shipped resources therefore identify the same payload before and
 * after electron-builder copies it.
 */
export function resolveHostPayloadVersion(rootPath: string): string {
  if (
    typeof rootPath !== 'string' ||
    rootPath.trim() !== rootPath ||
    !isAbsolute(rootPath) ||
    resolve(rootPath) === parse(resolve(rootPath)).root
  ) {
    throw new Error('Host payload identity requires an absolute non-root directory')
  }
  const root = realpathSync(resolve(rootPath))
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Host payload identity requires a canonical directory')
  }
  const files = payloadFiles(root)
  if (files.length === 0) throw new Error('Host payload identity requires shipped files')

  const hash = createHash('sha256')
  let bytes = 0
  for (const path of files) {
    const body = readFileSync(path)
    bytes += body.byteLength
    if (bytes > HOST_PAYLOAD_MAX_BYTES) {
      throw new Error('Host payload bytes exceed the identity bound')
    }
    const name = relative(root, path).split(sep).join('/')
    hash.update(`${Buffer.byteLength(name, 'utf8')}:`)
    hash.update(name, 'utf8')
    hash.update(`${body.byteLength}:`)
    hash.update(body)
  }
  return `sha256:${hash.digest('hex')}`
}
