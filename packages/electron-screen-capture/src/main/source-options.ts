import type { SourcesOptions } from 'electron'

function sourceTypeFromId(sourceId: string | undefined): SourcesOptions['types'][number] | undefined {
  if (sourceId?.startsWith('screen:'))
    return 'screen'
  if (sourceId?.startsWith('window:'))
    return 'window'
  return undefined
}

/**
 * Normalizes desktop-capturer options for a single source lookup.
 *
 * Before:
 * - `{ types: ['screen', 'window'], thumbnailSize: { width: 1920, height: 1080 } }`
 *
 * After:
 * - Stream lookup for `window:*`: `{ types: ['window'], thumbnailSize: { width: 0, height: 0 } }`
 * - Still lookup for `screen:*`: `{ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }`
 *
 * Use when:
 * - Looking up one persisted Electron desktop-capture source
 * - Avoiding thumbnail generation while preparing a media stream
 *
 * Expects:
 * - Electron source IDs use the `screen:*` or `window:*` prefix
 *
 * Returns:
 * - Options narrowed to the selected native source type
 */
export function sourceLookupOptions(
  options: SourcesOptions,
  sourceId: string | undefined,
  includeThumbnail: boolean,
): SourcesOptions {
  const sourceType = sourceTypeFromId(sourceId)
  const requestedThumbnailSize = options.thumbnailSize
  const hasRequestedThumbnail = Boolean(requestedThumbnailSize?.width && requestedThumbnailSize?.height)

  return {
    ...options,
    types: sourceType ? [sourceType] : ['screen'],
    thumbnailSize: includeThumbnail
      ? (hasRequestedThumbnail ? requestedThumbnailSize : { width: 1920, height: 1080 })
      : { width: 0, height: 0 },
  }
}
