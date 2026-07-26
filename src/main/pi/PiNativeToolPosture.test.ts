import { describe, expect, it } from 'vitest'
import { resolvePiNativeToolPosture } from './PiNativeToolPosture'

describe('resolvePiNativeToolPosture', () => {
  it('keeps the exact default-mode baseline write-capable when no signed field narrows it', () => {
    expect(resolvePiNativeToolPosture({ approvalMode: 'default' })).toEqual({
      writeCapable: true,
      effectiveMode: 'default'
    })
    expect(
      resolvePiNativeToolPosture({
        approvalMode: 'default',
        effectivePermissions: {
          readOnly: false,
          agenticServices: {
            shellCommands: 'ask',
            fileChanges: 'workspace'
          }
        }
      })
    ).toEqual({
      writeCapable: true,
      effectiveMode: 'default'
    })
  })

  it.each([
    [
      'a read-only posture',
      {
        readOnly: true,
        agenticServices: { shellCommands: 'allow' as const, fileChanges: 'allow' as const }
      }
    ],
    [
      'a shell-command deny',
      {
        readOnly: false,
        agenticServices: { shellCommands: 'deny' as const, fileChanges: 'allow' as const }
      }
    ],
    [
      'a file-change deny',
      {
        readOnly: false,
        agenticServices: { shellCommands: 'allow' as const, fileChanges: 'deny' as const }
      }
    ]
  ])('downgrades default mode for %s', (_label, effectivePermissions) => {
    expect(
      resolvePiNativeToolPosture({
        approvalMode: 'default',
        effectivePermissions
      })
    ).toEqual({
      writeCapable: false,
      effectiveMode: 'plan'
    })
  })

  it.each(['plan', 'acceptEdits', 'auto_edit', 'default ', '', undefined, null])(
    'never widens non-default approval mode %s',
    (approvalMode) => {
      expect(
        resolvePiNativeToolPosture({
          approvalMode,
          effectivePermissions: {
            readOnly: false,
            agenticServices: {
              shellCommands: 'allow',
              fileChanges: 'allow'
            }
          }
        })
      ).toEqual({
        writeCapable: false,
        effectiveMode: 'plan'
      })
    }
  )

  it('returns an immutable decision', () => {
    expect(Object.isFrozen(resolvePiNativeToolPosture({ approvalMode: 'default' }))).toBe(true)
  })
})
