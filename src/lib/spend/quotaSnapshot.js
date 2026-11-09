export function createRefreshDeduper() {
  const pending = new Map();
  return (id, start) => {
    if (pending.has(id)) return pending.get(id);
    const promise = Promise.resolve().then(start);
    pending.set(id, promise);
    promise.finally(() => { if (pending.get(id) === promise) pending.delete(id); }).catch(() => {});
    return promise;
  };
}

export function quotaUsageRows({ usage, connection, now, normalize }) {
  const quotas = usage?.quotas;
  if (usage?.message && (!quotas || Object.keys(quotas).length === 0)) throw new Error(usage.message);
  return Object.entries(quotas || {}).map(([key, quota]) => ({
    ...normalize({ provider: connection.provider, name: connection.name || connection.provider, quota: { ...quota, name: key }, now }),
    window: quota.displayName ? `${key} (${quota.displayName})` : key,
  }));
}
