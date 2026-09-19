import type { OcrRead } from '../core/contracts';
import { normalizeTokens, priceTagReason } from '../indoor/ocrMatcher';

/** Filter facts sent to vision; preserve the raw OCR stream for map matching.
 * A solitary digit is useful store signage, but not evidence about a kitchen.
 */
export function ocrFactTokens(reads: readonly OcrRead[], storeContext: boolean, knownSigns: readonly string[] = []): string[] {
  const known = new Set(knownSigns.flatMap(normalizeTokens));
  const tokens = new Set<string>();
  for (const read of reads) {
    if (!Number.isFinite(read.confidence) || read.confidence < 0.7 || priceTagReason(read.text)) continue;
    for (const token of normalizeTokens(read.text)) {
      if (/^\d+$/.test(token)) {
        if (storeContext && read.confidence >= 0.85 && token.length <= 3) tokens.add(token);
      } else if (known.has(token) || (token.length >= 3 && /[AEIOUY]/.test(token) && /[A-Z]{2}/.test(token))) {
        tokens.add(token);
      }
    }
  }
  return [...tokens].slice(0, 24);
}
