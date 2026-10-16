// The shape of an MCP tool result, and the one place that builds one.
//
// Leaf module on purpose: it imports nothing from the rest of the MCP surface,
// so the listen implementation, the tool definitions and the dispatcher can all
// depend on it without an import cycle.

export type McpTextContent = { type: 'text'; text: string };
export type McpImageContent = { type: 'image'; data: string; mimeType: string };
export type McpContent = McpTextContent | McpImageContent;
export type McpToolResult = {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * The same value the text content carries, as the object `structuredContent`
 * has to be — or undefined when there is no honest way to make one.
 *
 * A plain object is handed back as-is: structuredContent must BE the payload,
 * not a re-rendering of it, or the two halves of the result can disagree.
 *
 * A string result is wrapped as `{ message }`. The text stays the bare string
 * (that is the published output), and clients that only read structured output
 * get the same sentence under a stable key instead of nothing. `message` is
 * chosen because it is what the string has always been — a human-readable line
 * — and because no tool here has a top-level `message` field of its own, so
 * the wrapper can never collide with a real payload key.
 *
 * Arrays, null and primitives return undefined: an object schema cannot
 * describe them, and inventing a wrapper key would be inventing payload.
 */
export function structuredContentFor(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') return { message: value };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function ok(value: unknown, extra: McpContent[] = [], includeStructuredContent = false): McpToolResult {
  const structuredContent = includeStructuredContent ? structuredContentFor(value) : undefined;
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ...extra,
    ],
    ...(structuredContent ? { structuredContent } : {}),
  };
}
