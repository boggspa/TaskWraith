import { describe, expect, it } from 'vitest'
import {
  classifyWindowsUpdateArtifact,
  classifyMacUpdateArtifact,
  evaluateUpdateArchitectureCompatibility,
  selectedMacUpdateArtifact,
  selectedWindowsUpdateArtifact,
  windowsUpdateChannelForHost
} from './UpdateArchitecture'

describe('UpdateArchitecture', () => {
  it('classifies explicit mac update artifact architecture tokens', () => {
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73-universal-mac.zip')).toBe('universal')
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73-arm64-mac.zip')).toBe('arm64')
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73-x64-mac.zip')).toBe('x64')
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73-x86_64-mac.zip')).toBe('x64')
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73.dmg')).toBe('unknown')
  })

  it('treats conventional shared mac zip names as universal at runtime', () => {
    expect(classifyMacUpdateArtifact('TaskWraith-1.0.73-mac.zip')).toBe('universal')
  })

  it('prefers the top-level updater path over secondary files', () => {
    expect(
      selectedMacUpdateArtifact({
        path: 'TaskWraith-1.0.73-universal-mac.zip',
        files: [{ url: 'TaskWraith-1.0.73.dmg' }]
      })
    ).toBe('TaskWraith-1.0.73-universal-mac.zip')
  })

  it('accepts universal mac artifacts on Intel and Apple Silicon hosts', () => {
    const info = { path: 'TaskWraith-1.0.73-universal-mac.zip' }
    expect(
      evaluateUpdateArchitectureCompatibility(info, { platform: 'darwin', arch: 'x64' })
        .compatible
    ).toBe(true)
    expect(
      evaluateUpdateArchitectureCompatibility(info, { platform: 'darwin', arch: 'arm64' })
        .compatible
    ).toBe(true)
  })

  it('rejects arm64 mac artifacts on Intel hosts', () => {
    expect(
      evaluateUpdateArchitectureCompatibility(
        { path: 'TaskWraith-1.0.73-arm64-mac.zip' },
        { platform: 'darwin', arch: 'x64' }
      )
    ).toMatchObject({
      artifactArch: 'arm64',
      compatible: false,
      reason: 'Incompatible update artifact: host=darwin-x64 artifact=arm64'
    })
  })

  it('rejects x64 mac artifacts on Apple Silicon hosts', () => {
    expect(
      evaluateUpdateArchitectureCompatibility(
        { path: 'TaskWraith-1.0.73-x64-mac.zip' },
        { platform: 'darwin', arch: 'arm64' }
      )
    ).toMatchObject({
      artifactArch: 'x64',
      compatible: false,
      reason: 'Incompatible update artifact: host=darwin-arm64 artifact=x64'
    })
  })

  it('classifies explicit Windows update artifact architecture tokens', () => {
    expect(classifyWindowsUpdateArtifact('TaskWraith-1.0.73-win-x64-setup.exe')).toBe('x64')
    expect(classifyWindowsUpdateArtifact('TaskWraith-1.0.73-win-arm64-setup.exe')).toBe('arm64')
    expect(classifyWindowsUpdateArtifact('TaskWraith-1.0.73-setup.exe')).toBe('unknown')
  })

  it('prefers Windows setup executables from update files', () => {
    expect(
      selectedWindowsUpdateArtifact({
        files: [
          { url: 'TaskWraith-1.0.73-win-x64-setup.exe.blockmap' },
          { url: 'TaskWraith-1.0.73-win-x64-setup.exe' }
        ]
      })
    ).toBe('TaskWraith-1.0.73-win-x64-setup.exe')
  })

  it('uses arch-specific Windows update channels', () => {
    expect(windowsUpdateChannelForHost('stable', 'x64')).toBe('latest-win-x64')
    expect(windowsUpdateChannelForHost('nightly', 'arm64')).toBe('beta-win-arm64')
    expect(windowsUpdateChannelForHost('stable', 'arm64', 'release')).toBe(
      'release-win-arm64'
    )
  })

  it('rejects arm64 Windows artifacts on x64 hosts', () => {
    expect(
      evaluateUpdateArchitectureCompatibility(
        { path: 'TaskWraith-1.0.73-win-arm64-setup.exe' },
        { platform: 'win32', arch: 'x64' }
      )
    ).toMatchObject({
      artifactArch: 'arm64',
      compatible: false,
      reason: 'Incompatible update artifact: host=win32-x64 artifact=arm64'
    })
  })

  it('rejects ambiguous Windows artifacts before download', () => {
    expect(
      evaluateUpdateArchitectureCompatibility(
        { path: 'TaskWraith-1.0.73-setup.exe' },
        { platform: 'win32', arch: 'arm64' }
      )
    ).toMatchObject({
      artifactArch: 'unknown',
      compatible: false,
      reason: 'Unknown Windows update artifact architecture: TaskWraith-1.0.73-setup.exe'
    })
  })
})
