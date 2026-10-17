import { urlKey } from '../core/urlkey.js';

// An avatar URL can change bytes between bundles. Within one profile observation,
// successful captures and restored pending work must share the same deduplication key.
export function avatarQueueKey(url, parentCaptureId) {
  return `${urlKey(url)}#account-avatar:${parentCaptureId}`;
}
