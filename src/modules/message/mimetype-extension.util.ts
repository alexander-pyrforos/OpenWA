/**
 * Map a mimetype to a file extension for the media storage key + Content-Disposition filename.
 * Covers only the types WhatsApp sends; unknown types fall back to `bin`. Kept tiny and dependency-free –
 * this is a storage-key hint, not an authoritative mime registry.
 *
 * Shared by MessageService (on-demand history media cache) and SessionService (inbound media offload)
 * so BOTH sides derive the SAME extension for one mimetype – the offload writes `${sessionId}/${waMessageId}.${ext}`
 * and the on-demand read probes exactly that key, so a mismatch here would silently split the two paths.
 */
export function mimetypeExtension(mimetype: string): string {
  const m = (mimetype ?? '').toLowerCase().split(';')[0].trim();
  switch (m) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'video/mp4':
      return 'mp4';
    case 'video/3gpp':
      return '3gp';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'application/pdf':
      return 'pdf';
    case 'application/octet-stream':
      return 'bin';
    default:
      // A vendor/unknown type (e.g. `application/vnd.openxmlformats…`): fall back to `bin` so the
      // storage key stays a single safe extension, and the dashboard re-derives the display name from
      // the stored mimetype.
      return 'bin';
  }
}
