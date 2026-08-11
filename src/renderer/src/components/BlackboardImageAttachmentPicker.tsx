import type { ReactElement } from 'react'
import { BLACKBOARD_MAX_IMAGE_ATTACHMENTS } from '../../../shared/blackboardMedia'
import { getImageName } from '../lib/imageAttachments'
import { ComposerImageThumb } from './ComposerImageThumb'

const SUPPORTED_BLACKBOARD_IMAGE_PATH = /\.(?:png|jpe?g|webp|gif|bmp)$/i

export function mergeBlackboardImagePaths(
  current: readonly string[],
  selected: readonly string[]
): { paths: string[]; rejected: number; overflowed: boolean } {
  const supported = selected.filter((path) => SUPPORTED_BLACKBOARD_IMAGE_PATH.test(path.trim()))
  const merged = [...new Set([...current, ...supported].map((path) => path.trim()).filter(Boolean))]
  return {
    paths: merged.slice(0, BLACKBOARD_MAX_IMAGE_ATTACHMENTS),
    rejected: selected.length - supported.length,
    overflowed: merged.length > BLACKBOARD_MAX_IMAGE_ATTACHMENTS
  }
}

export function BlackboardImageAttachmentPicker({
  paths,
  disabled,
  onChange,
  onError
}: {
  paths: string[]
  disabled?: boolean
  onChange: (paths: string[]) => void
  onError: (message: string | null) => void
}): ReactElement {
  const pickImages = async (): Promise<void> => {
    if (disabled) return
    try {
      const selected = await window.api.selectImageFiles()
      const merged = mergeBlackboardImagePaths(paths, selected || [])
      onChange(merged.paths)
      if (merged.rejected > 0) {
        onError('Blackboard supports PNG, JPEG, WebP, GIF, and BMP images.')
      } else if (merged.overflowed) {
        onError(`A Blackboard entry can attach at most ${BLACKBOARD_MAX_IMAGE_ATTACHMENTS} images.`)
      } else {
        onError(null)
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="blackboard-image-picker">
      <button
        type="button"
        className="blackboard-image-picker-button"
        onClick={() => void pickImages()}
        disabled={disabled || paths.length >= BLACKBOARD_MAX_IMAGE_ATTACHMENTS}
      >
        Attach image
      </button>
      {paths.length > 0 && (
        <div className="blackboard-image-picker-list" aria-label="Blackboard image attachments">
          {paths.map((path) => {
            const name = getImageName(path) || 'Image'
            return (
              <div className="blackboard-image-picker-item" key={path}>
                <ComposerImageThumb path={path} name={name} />
                <span title={name}>{name}</span>
                <button
                  type="button"
                  onClick={() => onChange(paths.filter((candidate) => candidate !== path))}
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  title={`Remove ${name}`}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
