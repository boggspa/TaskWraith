import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  validateNodeRuntimeLicense
}: {
  validateNodeRuntimeLicense: (runtimeDir: string) => string[]
} = require('./node-runtime-license.cjs')

function writeRuntime(root: string) {
  const license = `Node.js is licensed for use as follows:\n${'notice '.repeat(
    150
  )}\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n`
  fs.writeFileSync(path.join(root, 'LICENSE'), license)
  fs.writeFileSync(
    path.join(root, 'NODE.json'),
    JSON.stringify({
      source: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.gz',
      license: 'LICENSE',
      licenseSource: 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.gz#LICENSE',
      licenseSha256: crypto.createHash('sha256').update(license).digest('hex')
    })
  )
}

describe('packaged Node runtime license', () => {
  it('accepts an official archive-bound license and detects tampering', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-runtime-license-'))
    try {
      writeRuntime(root)
      expect(validateNodeRuntimeLicense(root)).toEqual([])
      fs.appendFileSync(path.join(root, 'LICENSE'), 'tampered')
      expect(validateNodeRuntimeLicense(root)).toEqual([
        expect.stringContaining('licenseSha256 mismatch')
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails when the license or its archive-bound metadata is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-runtime-license-'))
    try {
      expect(validateNodeRuntimeLicense(root)).toEqual([
        expect.stringContaining('missing Node distribution LICENSE')
      ])
      fs.writeFileSync(
        path.join(root, 'LICENSE'),
        `Node.js is licensed for use as follows:\n${'notice '.repeat(
          150
        )}\nPermission is hereby granted, free of charge.\n`
      )
      expect(validateNodeRuntimeLicense(root)).toEqual([
        expect.stringContaining('missing Node runtime license metadata')
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
