/**
 * Stima dei token per testo italiano con il tokenizer Claude: ~2,4 caratteri per token,
 * misurato nello spike M2.1 (13.688 caratteri → 5.781 token). Conservativa per il budget del Soul.
 */
export const CHARS_PER_TOKEN_IT = 2.4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_IT);
}

export const CORE_SOUL_TOKEN_BUDGET = 600;
