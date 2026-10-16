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

export function ok(value: unknown, extra: McpContent[] = [], includeStructuredContent = false): McpToolResult {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ...extra,
    ],
    ...(includeStructuredContent && value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {}),
  };
}
