import { useRef, useState, type DragEvent, type ReactElement } from 'react'
import { BLACKBOARD_MAX_IMAGE_ATTACHMENTS } from '../../../shared/blackboardMedia'
import {
  collectDroppedAttachmentPaths,
  dataTransferHasFiles,
  getImageName
} from '../lib/imageAttachments'
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

/**
 * Merge dropped image paths into the current tray and derive the single user
 * facing error message, mirroring the picker button's semantics so drops and
 * clicks behave identically. Shared by the click flow and the drop zone hook.
 */
export function applyDroppedBlackboardImages(
  current: readonly string[],
  dropped: readonly string[]
): { paths: string[]; error: string | null } {
  const merged = mergeBlackboardImagePaths(current, dropped)
  if (merged.rejected > 0) {
    return {
      paths: merged.paths,
      error: 'Blackboard supports PNG, JPEG, WebP, GIF, and BMP images.'
    }
  }
  if (merged.overflowed) {
    return {
      paths: merged.paths,
      error: `A Blackboard entry can attach at most ${BLACKBOARD_MAX_IMAGE_ATTACHMENTS} images.`
    }
  }
  return { paths: merged.paths, error: null }
}

export interface BlackboardImageDropZoneParams {
  paths: string[]
  disabled?: boolean
  onChange: (paths: string[]) => void
  onError: (message: string | null) => void
}

/**
 * Drag-and-drop zone state for the blackboard entry areas. Attach the returned
 * `dropHandlers` to a form (or container) so users can drop image files
 * anywhere in the compose area instead of clicking "Attach image". The depth
 * counter keeps child elements (textarea, buttons, thumbnails) from flickering
 * the highlight off — same pattern as the composer's imageDragCounterRef.
 */
export function useBlackboardImageDropZone(params: BlackboardImageDropZoneParams): {
  isDragOver: boolean
  dropHandlers: {
    onDragEnter: (event: DragEvent<HTMLElement>) => void
    onDragOver: (event: DragEvent<HTMLElement>) => void
    onDragLeave: (event: DragEvent<HTMLElement>) => void
    onDrop: (event: DragEvent<HTMLElement>) => void
  }
} {
  const [isDragOver, setIsDragOver] = useState(false)
  const dragDepthRef = useRef(0)
  const blocked =
    Boolean(params.disabled) || params.paths.length >= BLACKBOARD_MAX_IMAGE_ATTACHMENTS

  const handleDragEnter = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    dragDepthRef.current += 1
    if (!blocked && dataTransferHasFiles(event.dataTransfer)) setIsDragOver(true)
  }

  const handleDragOver = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    if (!blocked && event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  }

  const handleDragLeave = (): void => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDragOver(false)
  }

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragOver(false)
    if (blocked) return
    const dropped = collectDroppedAttachmentPaths(event.dataTransfer)
    if (dropped.length === 0) return
    const applied = applyDroppedBlackboardImages(params.paths, dropped)
    params.onChange(applied.paths)
    params.onError(applied.error)
  }

  return {
    isDragOver,
    dropHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop
    }
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
      const applied = applyDroppedBlackboardImages(paths, selected || [])
      onChange(applied.paths)
      onError(applied.error)
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
