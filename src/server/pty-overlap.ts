const PREFILL_OVERLAP_LIMIT = 32 * 1024;

function bufferStartsWithPrefillSuffix(prefillTail: Buffer, attachPrefix: Buffer, overlap: number): boolean {
  const prefillStart = prefillTail.length - overlap;
  for (let i = 0; i < overlap; i++) {
    if (prefillTail[prefillStart + i] !== attachPrefix[i]) return false;
  }
  return true;
}

export function stripInitialPtyOverlap(
  prefill: Buffer,
  attachPrefix: Buffer,
): { awaitingMore: boolean; data: Buffer } {
  if (!prefill.length || !attachPrefix.length) {
    return { awaitingMore: false, data: attachPrefix };
  }

  const prefillTail = prefill.subarray(Math.max(0, prefill.length - PREFILL_OVERLAP_LIMIT));
  const maxOverlap = Math.min(prefillTail.length, attachPrefix.length);

  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (!bufferStartsWithPrefillSuffix(prefillTail, attachPrefix, overlap)) continue;
    if (overlap === attachPrefix.length) {
      return { awaitingMore: true, data: Buffer.alloc(0) };
    }
    return {
      awaitingMore: false,
      data: attachPrefix.subarray(overlap),
    };
  }

  return { awaitingMore: false, data: attachPrefix };
}
