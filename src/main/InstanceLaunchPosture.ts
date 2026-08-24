/**
 * Compatibility export for Electron-main launch consumers.
 *
 * Profile posture resolution is deliberately argv/path-only and is shared by
 * clients that launch a Host outside Electron.
 */
export * from '../host-shared/InstanceLaunchPosture'
