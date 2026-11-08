export function mergeSavedModelOverride(currentOverrides, key, responseOverrides) {
  const next = { ...(currentOverrides || {}) };
  if (typeof key !== "string" || !key) return next;

  if (Object.hasOwn(responseOverrides || {}, key)) {
    next[key] = responseOverrides[key];
  } else {
    delete next[key];
  }
  return next;
}
