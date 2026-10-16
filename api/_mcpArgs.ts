// The required-field check the action-style tools share.
//
// Leaf module on purpose: room_task moved to _mcpTaskTool.ts while room_webhook
// stayed in the dispatcher, and both answer "did this action arrive with the
// fields it needs" with the same sentence. Keeping the check here is what lets
// those two live apart without one importing the other.

/**
 * The bad_request hint for an action missing required fields, or null when
 * nothing is missing. Empty string counts as missing: an action called with
 * `id: ""` has no id, and the server would refuse it a round trip later.
 */
export function requireFields(a: Record<string, any>, fields: string[]): string | null {
  const missing = fields.filter(f => a[f] === undefined || a[f] === null || a[f] === '');
  return missing.length > 0 ? `Missing required field(s) for this action: ${missing.join(', ')}.` : null;
}
