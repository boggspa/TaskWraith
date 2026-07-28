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
    expect(snapshot.appDrive).toEqual({
      available: false,
      reason: 'AppDrive requires macOS 15.2 or newer for exact picker window identity.'
    })
  })

  it('reports structural AppDrive availability at the exact macOS 15.2 boundary', () => {
    const snapshot = getNativeCapabilitySnapshot({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.2.0',
      macosVersion: '15.2',
      binaryPath: '/tmp/TaskWraithBridgeDaemon',
      binaryExists: true,
      binaryArchs: ['arm64']
    })

    // Accessibility trust is runtime state: this static snapshot must not claim it.
    expect(snapshot.appDrive).toEqual({ available: true })
  })

  it('fails AppDrive closed below macOS 15.2 while preserving bridge-backed observation', () => {
    const snapshot = getNativeCapabilitySnapshot({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.1.0',
      macosVersion: '15.1.9',
      binaryPath: '/tmp/TaskWraithBridgeDaemon',
      binaryExists: true,
      binaryArchs: ['arm64']
    })

    expect(snapshot.bridge.available).toBe(true)
    expect(snapshot.screenWatch.available).toBe(true)
    expect(snapshot.appwatch.available).toBe(true)
    expect(snapshot.appDrive).toEqual({
      available: false,
      reason:
        'AppDrive requires macOS 15.2 or newer for exact picker window identity; this Mac is running macOS 15.1.9.'
    })
  })

  it.each(['unknown', '15.2-beta', '15..2'])(
    'fails AppDrive closed when the injected macOS version is malformed (%s)',
    (macosVersion) => {
      const snapshot = getNativeCapabilitySnapshot({
        platform: 'darwin',
        arch: 'arm64',
        osRelease: '24.2.0',
        macosVersion,
        binaryPath: '/tmp/TaskWraithBridgeDaemon',
        binaryExists: true,
        binaryArchs: ['arm64']
      })

      expect(snapshot.appDrive).toEqual({
        available: false,
        reason:
          "AppDrive could not verify this Mac's OS version. Exact picker window identity requires macOS 15.2 or newer."
      })
    }
  )

  it('requires the native bridge even on a supported macOS version', () => {
    const snapshot = getNativeCapabilitySnapshot({
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '24.2.0',
      macosVersion: '15.2',
      binaryPath: '/tmp/missing-TaskWraithBridgeDaemon',
      binaryExists: false,
      binaryArchs: ['arm64']
    })

    expect(snapshot.appDrive).toEqual({
      available: false,
      reason:
        'AppDrive requires the TaskWraith native bridge. TaskWraithBridgeDaemon binary was not found.'
    })
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
