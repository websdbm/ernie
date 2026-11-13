/** Exclude external-library assistant responses from automatic facts and session summaries.
 * Mastra may persist the tool call and final answer as separate assistant messages.
 * Subsequent answers may paraphrase the library without another tool call, so only direct user
 * messages remain eligible afterwards. Explicit brain_write is a separate user-requested write.
 */
export function withoutExternalLibraryResponses(messages: readonly unknown[]): unknown[] {
  let external = false;
  const out: unknown[] = [];
  const hasRaindrop = (value: unknown, depth = 0): boolean => {
    if (!value || typeof value !== 'object' || depth > 8) return false;
    if (Array.isArray(value)) return value.some((v) => hasRaindrop(v, depth + 1));
    const v = value as Record<string, unknown>;
    if (typeof v.toolName === 'string' && v.toolName.startsWith('raindrop_')) return true;
    if (typeof v.type === 'string' && v.type.startsWith('tool-raindrop_')) return true;
    return ['content', 'parts', 'toolInvocation', 'toolInvocations', 'toolCalls'].some((k) =>
      hasRaindrop(v[k], depth + 1),
    );
  };
  for (const m of messages) {
    const role = m && typeof m === 'object' ? (m as { role?: unknown }).role : null;
    if (hasRaindrop(m)) external = true;
    if (!external || role === 'user') out.push(m);
  }
  return out;
}
