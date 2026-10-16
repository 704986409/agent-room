// Attachment filename rule, shared by the web composer's preflight and
// /api/upload's validation so a name the browser accepts is never rejected
// by the server (or the other way round).
//
// The budget is in UTF-8 bytes, not characters: the R2 object key is
// `rooms/{code}/{uuid}/{filename}` with the filename's raw UTF-8 bytes and
// R2 caps a key at 1024 bytes, so 40 Chinese characters already cost 120
// bytes where 40 ascii ones cost 40. 120 bytes keeps every key far under
// the R2 limit and is longer than any filename a human types.
export const MAX_FILENAME_BYTES = 120;

export function isFilenameTooLong(name: string): boolean {
  return new TextEncoder().encode(name).length > MAX_FILENAME_BYTES;
}
