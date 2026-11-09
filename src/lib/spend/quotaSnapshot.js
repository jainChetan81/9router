// One refresh per connection at a time. The lock is released when the
// refresh settles, or after lockMs if it stalls, so a hung OAuth call
// cannot block quota reads for that connection forever.
export function createRefreshDeduper({ lockMs = 30000 } = {}) {
  const pending = new Map();
  return (id, start) => {
    if (pending.has(id)) return pending.get(id);
    const promise = Promise.resolve().then(start);
    pending.set(id, promise);
    const release = () => { clearTimeout(timer); if (pending.get(id) === promise) pending.delete(id); };
    const timer = setTimeout(release, lockMs);
    promise.then(release, release);
    return promise;
  };
}

export function quotaUsageRows({ usage, connection, now, normalize }) {
  const quotas = usage?.quotas;
  if (!quotas || Object.keys(quotas).length === 0) throw new Error(usage?.message || "Provider returned no quota data");
  return Object.entries(quotas || {}).map(([key, quota]) => ({
    ...normalize({ provider: connection.provider, name: connection.name || connection.provider, quota: { ...quota, name: quota.displayName ? `${key} (${quota.displayName})` : key }, now }),
  }));
}
