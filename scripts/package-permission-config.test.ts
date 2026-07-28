import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { load } = require('js-yaml') as { load: (source: string) => unknown }

const REQUIRED_NATIVE_PERMISSION_KEYS = [
  'NSScreenCaptureUsageDescription',
  'NSAppleEventsUsageDescription'
] as const

type BuilderConfig = {
  mac?: {
    extendInfo?: unknown
    x64ArchFiles?: unknown
  }
}

function readBuilderConfig(fileName: string): BuilderConfig {
  const source = readFileSync(join(process.cwd(), fileName), 'utf8')
  return (load(source) as BuilderConfig | null) ?? {}
}

function readBuilderExtendInfo(fileName: string): Record<string, unknown> {
  const parsed = readBuilderConfig(fileName)
  const extendInfo = parsed?.mac?.extendInfo
  if (!extendInfo || typeof extendInfo !== 'object' || Array.isArray(extendInfo)) {
    throw new Error(`${fileName} mac.extendInfo must be a flat mapping.`)
  }
  return extendInfo as Record<string, unknown>
}

describe('macOS package permission metadata', () => {
  const releaseConfig = readBuilderConfig('electron-builder.yml')
  const releaseExtendInfo = readBuilderExtendInfo('electron-builder.yml')
  const debugExtendInfo = readBuilderExtendInfo('electron-builder.debug.yml')

  it('keeps release and debug extendInfo keys in exact parity', () => {
    expect(Object.keys(debugExtendInfo).sort()).toEqual(Object.keys(releaseExtendInfo).sort())
  })

  it.each([
    ['release', releaseExtendInfo],
    ['debug', debugExtendInfo]
  ])('keeps required native permission keys flat in the %s config', (_label, extendInfo) => {
    for (const key of REQUIRED_NATIVE_PERMISSION_KEYS) {
      expect(extendInfo).toHaveProperty(key)
      expect(extendInfo[key]).toEqual(expect.any(String))
      expect((extendInfo[key] as string).trim().length).toBeGreaterThan(0)
    }
  })

  it.each([
    ['release', releaseExtendInfo],
    ['debug', debugExtendInfo]
  ])(
    'discloses live Screen Watch capture and hosted-provider frame egress in %s',
    (_label, extendInfo) => {
      const disclosure = String(extendInfo.NSScreenCaptureUsageDescription)
      expect(disclosure).toMatch(/live .*Screen Watch stream/i)
      expect(disclosure).toMatch(/frames may leave your Mac/i)
      expect(disclosure).toMatch(/hosted AI provider/i)
      expect(disclosure).not.toMatch(/one frame at a time/i)
    }
  )

  it.each([
    ['release', releaseExtendInfo],
    ['debug', debugExtendInfo]
  ])('does not invent an unsupported Accessibility plist key in %s', (_label, extendInfo) => {
    expect(extendInfo).not.toHaveProperty('NSAccessibilityUsageDescription')
  })

  it('preserves both architecture-specific TUI runtimes as universal resources', () => {
    expect(releaseConfig.mac?.x64ArchFiles).toEqual(expect.any(String))
    expect(releaseConfig.mac?.x64ArchFiles).toMatch(/\*\*\/tui-runtime\/darwin-\*\/node/)
  })
})
