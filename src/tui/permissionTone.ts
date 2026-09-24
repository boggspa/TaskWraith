import type { TuiPermissionTone } from './palette'

export type TuiPermissionToneName = keyof TuiPermissionTone

/** One semantic vocabulary shared by setup rows and current-permission display. */
export function permissionTone(postureId: string | undefined): TuiPermissionToneName {
  switch (String(postureId ?? '').toLowerCase()) {
    case 'plan':
    case 'read_only':
      return 'info'
    case 'workspace_write':
      return 'warning'
    case 'full_access':
      return 'error'
    case 'default':
    default:
      return 'primary'
  }
}

export function permissionToneHex(postureId: string | undefined, tones: TuiPermissionTone): string {
  return tones[permissionTone(postureId)]
}
