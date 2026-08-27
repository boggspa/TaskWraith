import type { ImageAttachment, ImageAttachmentThumbnail } from './imageAttachments'

/**
 * Keep every successfully resolved thumbnail without making one unreadable
 * attachment erase the metadata for the rest of the submitted image array.
 */
export function compactResolvedImageThumbnailMetadata(
  images: readonly ImageAttachment[],
  thumbnails: readonly (ImageAttachmentThumbnail | undefined)[]
): { imagePaths: string[]; imageThumbnails: ImageAttachmentThumbnail[] } {
  const imagePaths: string[] = []
  const imageThumbnails: ImageAttachmentThumbnail[] = []
  for (let index = 0; index < images.length; index += 1) {
    const thumbnail = thumbnails[index]
    if (!thumbnail) continue
    imagePaths.push(images[index].path)
    imageThumbnails.push(thumbnail)
  }
  return { imagePaths, imageThumbnails }
}
