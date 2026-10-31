/**
 * xterm.js answers OSC 10/11/12 (fg/bg/cursor color) queries and Primary
 * Device Attributes (DA) by emitting the report through onData. Forwarding
 * those to PTY stdin lands as garbage in the Codex/Cursor prompt
 * (e.g. `]10;rgb:ffff/ffff/ffff`, `[?1;2c`) and can interrupt an in-flight
 * room_listen turn when a popout attaches / seat switch resets the terminal.
 */

/** True when `data` is (or is dominated by) an OSC 10/11/12 color report. */
export function isOscColorReport(data: string): boolean {
  if (!data) return false;
  // Full OSC with ESC: ESC ] 10 ; … BEL/ST
  if (/\x1b\](10|11|12);/i.test(data)) return true;
  // xterm sometimes strips ESC; leftover `]10;rgb:…` / `10;rgb:…`
  if (/^\]?\s*(10|11|12);rgb:/i.test(data)) return true;
  // Multi-report blobs glued together (common after scrollback replay)
  if (/\](10|11|12);rgb:/i.test(data) && /rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+/i.test(data)) return true;
  // BEL/ST-terminated rgb reports without a leading bracket (partial chunk)
  if (/(^|[^0-9])(10|11|12);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+/i.test(data)) return true;
  return false;
}

/**
 * True when `data` is a CSI Primary Device Attributes reply (DA).
 * Full: ESC [ ? 1 ; 2 c   Fragments after ESC is stripped: [?1;2c / -> [?1;2c
 * Seat switch / resize makes xterm re-answer; without this filter it piles up
 * in the Cursor/Codex input line.
 */
export function isCsiDeviceAttributes(data: string): boolean {
  if (!data) return false;
  if (/\x1b\[\?\d*(?:;\d*)*c/i.test(data)) return true;
  // ESC eaten / partial chunk seen in seat logs: "[?1;2c" or "-> [?1;2c"
  if (/(?:^|[\x00-\x1f]|->\s*)\[\?\d*(?:;\d*)*c\s*$/i.test(data.trim())) return true;
  if (/^\[\?\d*(?:;\d*)*c$/i.test(data.trim())) return true;
  return false;
}

/**
 * Drop stdin that must never reach the CLI: OSC color reports, CSI DA replies,
 * and the raw Ctrl+V byte (0x16) Codex treats as image-paste.
 */
export function shouldDropPtyStdin(data: string): boolean {
  if (!data) return true;
  if (data === '\x16') return true;
  if (isOscColorReport(data)) return true;
  return isCsiDeviceAttributes(data);
}

/**
 * Strip OSC 10/11/12 sequences (queries and reports) from scrollback so a late
 * xterm attach does not re-answer historical color queries into stdin.
 */
export function stripOscColorSequences(data: string): string {
  if (!data) return data;
  // ESC ] 10|11|12 ; … BEL  or  ESC ]
  let out = data.replace(/\x1b\](10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/gi, '');
  // Orphan reports without ESC (already answered / partial)
  out = out.replace(/\]?(10|11|12);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+[^\x07\x1b\r\n]*(?:\x07|\x1b\\)?/gi, '');
  return out;
}
