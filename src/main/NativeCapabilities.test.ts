import { describe, expect, it } from 'vitest'
import { getNativeCapabilitySnapshot } from './NativeCapabilities'

describe('NativeCapabilities', () => {
  it('keeps the bridge available on Intel macOS 15.5 when the binary has x86_64', () => {
    expect(
      getNativeCapabilitySnapshot({
        platform: 'darwin',
        arch: 'x64',
        osRelease: '24.5.0',
        macosVersion: '15.5',
        binaryPath: '/tmp/TaskWraithBridgeDaemon',
        binaryExists: true,
        binaryArchs: ['arm64', 'x86_64']
      }).bridge
    ).toMatchObject({
      available: true,
      requiredArch: 'x86_64'
    })
  })

  it('disables the bridge below macOS 14', () => {
    expect(
      getNativeCapabilitySnapshot({
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '22.6.0',
        macosVersion: '13.6',
        binaryPath: '/tmp/TaskWraithBridgeDaemon',
        binaryExists: true,
        binaryArchs: ['arm64']
      }).bridge
    ).toMatchObject({
      available: false,
      reason: 'Native bridge features require macOS 14.0 or newer.'
    })
  })

  it('rejects bridge binaries missing the current CPU slice', () => {
    expect(
      getNativeCapabilitySnapshot({
        platform: 'darwin',
        arch: 'x64',
        osRelease: '24.5.0',
        macosVersion: '15.5',
        binaryPath: '/tmp/TaskWraithBridgeDaemon',
        binaryExists: true,
        binaryArchs: ['arm64']
      }).bridge
    ).toMatchObject({
      available: false,
      requiredArch: 'x86_64',
      reason: 'TaskWraithBridgeDaemon does not contain the current CPU architecture (x86_64).'
    })
  })

  it('gates Appwatch/AppDrive/Appshots on Windows v1', () => {
    const snapshot = getNativeCapabilitySnapshot({
      platform: 'win32',
      arch: 'x64',
      osRelease: '10.0.26100'
    })

    expect(snapshot.bridge).toMatchObject({
      available: false,
      reason: 'Native bridge features are available on macOS only.'
    })
    expect(snapshot.appwatch).toMatchObject({
      available: false,
      reason: 'Appwatch, AppDrive, and Appshots are not available on Windows in v1.'
    })
    expect(snapshot.screenWatch).toMatchObject(snapshot.appwatch)
    expect(snapshot.ocr).toMatchObject(snapshot.appwatch)
  })

  it('includes renderer-safe runtime feature gates', () => {
    const snapshot = getNativeCapabilitySnapshot({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.5.0',
      macosVersion: '15.5',
      binaryPath: '/tmp/TaskWraithBridgeDaemon',
      binaryExists: true,
      binaryArchs: ['arm64']
    })
    expect(snapshot.featureGates).toMatchObject({
      concurrentLanes: true,
      concurrentWriteLanes: true
    })
  })
})
