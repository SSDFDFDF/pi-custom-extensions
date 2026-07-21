/** Deterministic token estimate. No tokenizer available; chars/4 like Hypa's fallback. */
export function approxTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
