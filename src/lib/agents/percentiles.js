export function percentile(sortedAsc, p) {
  if (!sortedAsc || !sortedAsc.length) return null;
  const arr = sortedAsc.slice().sort((a,b)=>a-b);
  const idx = Math.ceil((p/100) * arr.length) - 1;
  const i = Math.max(0, Math.min(arr.length - 1, idx));
  return arr[i];
}

export function p50(arr) { return percentile(arr, 50); }
export function p95(arr) { return percentile(arr, 95); }

export function median(arr) { return p50(arr); }