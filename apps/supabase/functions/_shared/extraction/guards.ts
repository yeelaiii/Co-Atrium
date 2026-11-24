// Anti-invention checks applied to every LLM-extracted item, whatever the provider:
//   * page_no must be one of the pages that were sent;
//   * source_excerpt must be 25 words or fewer and must appear (whitespace / punctuation /
//     case-insensitive, small OCR slips tolerated) in that page's text.
// An item that fails is dropped to not_found and logged as a suspected invention. Pure.

export const MAX_EXCERPT_WORDS = 25;

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** Lower case, unified quotes and dashes, punctuation removed, single spaces. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}$%.\s]/gu, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * True when `excerpt` appears in `pageText`. Exact match after normalisation, else a window
 * of the page whose tokens match at least `minRatio` of the excerpt's tokens in order.
 */
export function excerptAppears(excerpt: string, pageText: string, minRatio = 0.85): boolean {
  const e = normalizeForMatch(excerpt);
  if (!e) return false;
  const page = normalizeForMatch(pageText);
  if (page.includes(e)) return true;
  const et = e.split(' ');
  const pt = page.split(' ');
  if (et.length < 4) return false; // short excerpts must match exactly
  const need = Math.ceil(et.length * minRatio);
  const span = et.length + Math.ceil(et.length * 0.3);
  for (let start = 0; start + need <= pt.length; start++) {
    if (pt[start] !== et[0] && pt[start] !== et[1]) continue;
    // in-order matches within the window (greedy)
    let j = 0;
    let hits = 0;
    for (let i = start; i < Math.min(pt.length, start + span) && j < et.length; i++) {
      if (pt[i] === et[j]) {
        hits++;
        j++;
      } else if (j + 1 < et.length && pt[i] === et[j + 1]) {
        hits++;
        j += 2;
      }
    }
    if (hits >= need) return true;
  }
  return false;
}

export type GuardFailure = 'page_not_sent' | 'excerpt_missing' | 'excerpt_too_long' | 'excerpt_not_in_source';

/** Checks one cited item; returns null when it passes. */
export function checkCitation(
  item: { page_no: number | null; source_excerpt: string | null },
  pages: ReadonlyMap<number, string>,
): GuardFailure | null {
  if (item.page_no === null || !pages.has(item.page_no)) return 'page_not_sent';
  if (!item.source_excerpt || !item.source_excerpt.trim()) return 'excerpt_missing';
  if (wordCount(item.source_excerpt) > MAX_EXCERPT_WORDS) return 'excerpt_too_long';
  if (!excerptAppears(item.source_excerpt, pages.get(item.page_no)!)) return 'excerpt_not_in_source';
  return null;
}
