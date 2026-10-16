// MIME allow-list and storage content-type rules for /api/upload.
// Split out of api/upload.ts so the route file keeps only the handler.

export const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Types that are byte-for-byte text but whose MIME name doesn't start with
// `text/`. Anything with a `+json`/`+xml` suffix counts too.
export const TEXTUAL_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'image/svg+xml',
]);

// Drop the parameters a client may append ('text/plain; charset=utf-8') so
// the allow-list is matched on the base type alone.
export function baseMime(raw: string): string {
  return raw.split(';')[0]!.trim().toLowerCase();
}

// R2 serves objects with the stored ContentType verbatim, and a `text/*`
// response without a charset makes browsers fall back to a locale default —
// UTF-8 Chinese then renders as mojibake straight from the r2.dev URL.
export function storageContentType(mime: string): string {
  if (/;\s*charset\s*=/i.test(mime)) return mime;
  const base = baseMime(mime);
  const textual = base.startsWith('text/') || TEXTUAL_MIMES.has(base) || /\+(json|xml)$/.test(base);
  return textual ? `${mime}; charset=utf-8` : mime;
}
