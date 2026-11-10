const DAY = 24 * 60 * 60 * 1000;
const RANK = { leaked: 0, block: 1, redact: 2, observe: 3, ignored: 4 };

// Input is file order; the last routing record replaces the previous attempt.
export function routingByRequest(events) {
  const routing = new Map();
  for (const event of events) {
    if (event?.kind !== "routing" || typeof event.requestId !== "string") continue;
    const fields = {};
    for (const key of ["provider", "account", "resolvedModel"]) fields[key] = typeof event[key] === "string" ? event[key] : null;
    if (typeof event.combo === "string") fields.combo = event.combo;
    routing.set(event.requestId, fields);
  }
  return routing;
}

// Applies config.ignore onto an already-aggregated summary without re-scanning events.
export function applyIgnoreToSummary(summary, ignore = []) {
  if (!summary) return summary;
  const ignored = new Set(Array.isArray(ignore) ? ignore : []);
  const groups = (summary.groups || []).map((g) => {
    const nextIgnored = ignored.has(g.hash);
    return g.ignored === nextIgnored ? g : { ...g, ignored: nextIgnored };
  });
  const nextByAction = Object.create(null);
  for (const [key, entry] of Object.entries(summary.byAction || {})) {
    nextByAction[key] = { values: Object.create(null), requests: { ...(entry?.requests || {}) } };
  }
  const row = (key) => (nextByAction[key] ||= { values: Object.create(null), requests: Object.create(null) });
  for (const g of groups) {
    const action = g.ignored ? "allowed" : g.actions.includes("leaked") ? "leaked" : g.action;
    for (const key of [g.rule, "all"]) row(key).values[action] = (row(key).values[action] || 0) + 1;
  }
  return { ...summary, groups, byAction: nextByAction };
}

// step/origin: bucket hits into a trend (ms per bucket, start of bucket 0). Off when step is not set.
export function summarize(events, { since, until, now = Date.now(), ignore = [], step, origin, routing: preRouting, times: preTimes, startIndex = 0 } = {}) {
  events = Array.isArray(events) ? events : [];
  const routing = preRouting || routingByRequest(events);
  const sinceMs = Number.isFinite(since) ? since : now - DAY;
  const untilMs = Number.isFinite(until) ? until : now;
  const groups = new Map();
  const ruleHits = Object.create(null), ruleStuck = Object.create(null), ruleHashes = Object.create(null), ruleSources = Object.create(null), bySource = Object.create(null);
  const leaked = new Set(), blocked = new Set(), unique = new Set();
  let errors24h = 0;
  let requests = 0;
  const actionHits = Object.create(null), ruleTurns = Object.create(null);
  const nTrend = step > 0 ? Math.min(400, Math.ceil(((Number.isFinite(until) ? until : now) - origin) / step)) : 0;
  const trend = Array.from({ length: Math.max(0, nTrend) }, () => ({ hits: 0, leaks: 0 }));

  const ocrStatus = { scanned: 0, partial: 0, empty: 0, failed: 0, skipped: 0 };
  let cacheHit = 0, cacheMiss = 0, cacheCoalesced = 0, cacheNone = 0;
  const missOcrMs = [];
  let imagesWithHits = 0;
  let totalOcrEvents = 0;
  const recentOcr = [], reasons = Object.create(null);

  for (let idx = Math.max(0, startIndex); idx < events.length; idx++) {
    const rawEvent = events[idx];
    if (!rawEvent || rawEvent.kind === "routing") continue;
    if (rawEvent.type === "test" || rawEvent.test === true) continue;
    const ts = preTimes ? preTimes[idx] : Date.parse(rawEvent.ts);
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) continue;
    if (rawEvent.type === "error") { errors24h += Number.isInteger(rawEvent.count) && rawEvent.count > 0 ? rawEvent.count : 1; continue; }
    if (rawEvent.type === "stats") continue;

    const route = typeof rawEvent.requestId === "string" ? routing.get(rawEvent.requestId) : undefined;
    const evProvider = route ? route.provider : rawEvent.provider;
    const evCombo = route && Object.hasOwn(route, "combo") ? route.combo : rawEvent.combo;

    if (rawEvent.type === "ocr") {
      totalOcrEvents++;
      if (rawEvent.reason) reasons[rawEvent.reason] = (reasons[rawEvent.reason] || 0) + 1;
      recentOcr.push({ ts: rawEvent.ts, requestId: rawEvent.requestId, model: rawEvent.model, endpoint: rawEvent.endpoint, imageIndex: rawEvent.imageIndex, status: rawEvent.status, ...(rawEvent.reason && { reason: rawEvent.reason }), cache: rawEvent.cache, ocrMs: rawEvent.ocrMs, mode: rawEvent.mode, ...(typeof evProvider === "string" && evProvider && { provider: evProvider }), ...(typeof evCombo === "string" && evCombo && { combo: evCombo }), rules: [...new Set((Array.isArray(rawEvent.hits) ? rawEvent.hits : []).filter(hit => hit && hit.action !== "ignored").map(hit => hit.name || hit.rule).filter(Boolean))] });
      // Keep only the newest 20; trim in batches so a long range never holds every OCR event.
      if (recentOcr.length > 200) { recentOcr.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)); recentOcr.length = 20; }
      if (Object.hasOwn(ocrStatus, rawEvent.status)) {
        ocrStatus[rawEvent.status]++;
      }
      if (rawEvent.cache === "hit") cacheHit++;
      else if (rawEvent.cache === "miss") {
        cacheMiss++;
        if (typeof rawEvent.ocrMs === "number") missOcrMs.push(rawEvent.ocrMs);
      } else if (rawEvent.cache === "coalesced") cacheCoalesced++;
      else if (rawEvent.cache === "none") cacheNone++;

      if (Array.isArray(rawEvent.hits) && rawEvent.hits.length > 0) {
        imagesWithHits++;
      }
    } else {
      requests++;
    }

    const raw = Array.isArray(rawEvent.hits) ? rawEvent.hits : Array.isArray(rawEvent.new) ? rawEvent.new : [];
    const distinct = new Set();
    for (const hit of raw) {
      if (!hit || typeof hit.hash !== "string" || typeof hit.rule !== "string") continue;
      const key = `${hit.hash}\0${hit.rule}`;
      unique.add(hit.hash);
      const source = typeof hit.source === "string" ? hit.source : "-/-";
      const action = typeof hit.action === "string" ? hit.action : "observe";
      ruleHits[hit.rule] = (ruleHits[hit.rule] || 0) + 1;
      actionHits[action] = (actionHits[action] || 0) + 1;
      const bucket = trend[Math.floor((ts - origin) / step)];
      if (bucket) { bucket.hits++; if (action === "leaked") bucket.leaks++; }
      bySource[source] = (bySource[source] || 0) + 1;
      // Warnings count only places Redact cannot rewrite (hit.where is set for those).
      if (typeof hit.where === "string") {
        ruleStuck[hit.rule] = (ruleStuck[hit.rule] || 0) + 1;
        ruleSources[hit.rule] ||= Object.create(null);
        ruleSources[hit.rule][hit.where] = (ruleSources[hit.rule][hit.where] || 0) + 1;
      }
      const newTurn = !distinct.has(key);
      if (newTurn) {
        (ruleHashes[hit.rule] ||= new Set()).add(key);
        distinct.add(key);
      }
      let group = groups.get(key);
      if (!group) {
        group = { hash: hit.hash, rule: hit.rule, name: hit.name, kind: hit.kind, sources: [], actions: [], action, actionTs: ts, leakedWhere: [], firstSeen: rawEvent.ts, lastSeen: rawEvent.ts, firstMs: ts, lastMs: ts, turns: new Set(), ignored: false };
        groups.set(key, group);
      }
      const isLatest = ts >= group.lastMs;
      if (isLatest) {
        if (typeof rawEvent.ua === "string") group.ua = rawEvent.ua.slice(0, 80);
        if (typeof rawEvent.model === "string") group.model = rawEvent.model.slice(0, 80); // Latest event wins, even absent: a mixed session clears a stale provider/combo.
        group.provider = typeof evProvider === "string" && evProvider ? evProvider.slice(0, 80) : null;
        group.combo = typeof evCombo === "string" && evCombo ? evCombo.slice(0, 80) : null;
      }
      if (!group.name && hit.name) group.name = hit.name;
      if (!group.kind && hit.kind) group.kind = hit.kind;
      if (!group.sources.includes(source)) group.sources.push(source);
      if (!group.actions.includes(action)) group.actions.push(action);
      if (ts > group.actionTs || (ts === group.actionTs && RANK[action] < RANK[group.action])) { group.action = action; group.actionTs = ts; }
      if (action === "leaked" && typeof hit.where === "string" && !group.leakedWhere.includes(hit.where)) group.leakedWhere.push(hit.where);
      if (ts < group.firstMs) { group.firstMs = ts; group.firstSeen = rawEvent.ts; }
      if (ts > group.lastMs) { group.lastMs = ts; group.lastSeen = rawEvent.ts; }
      const turnKey = rawEvent.requestId || (rawEvent.type === "ocr" ? null : rawEvent.ts);
      if (turnKey) {
        group.turns.add(turnKey);
      } else if (group.turns.size === 0) {
        group.turns.add(rawEvent.ts);
      }
      if (action === "leaked") leaked.add(hit.hash);
      // Only a hit that was itself blocked counts; event.blocked lists rule names, not values.
      if (action === "block") blocked.add(hit.hash);
      if (turnKey) for (const k of [hit.rule, "all"]) ((ruleTurns[k] ||= Object.create(null))[action] ||= new Set()).add(turnKey);
      if (typeof hit.preview === "string") { group.preview = hit.preview; if (typeof hit.context === "string") group.context = hit.context; }
      if (rawEvent.requestId && isLatest) { group.requestId = rawEvent.requestId; if (typeof rawEvent.sessionId === "string") group.sessionId = rawEvent.sessionId.slice(0, 200); }
      if (rawEvent.type === "ocr" && typeof rawEvent.sha256Prefix === "string" && isLatest) { group.image = rawEvent.sha256Prefix; group.imageIndex = rawEvent.imageIndex; }
    }
  }

  const ignored = new Set(Array.isArray(ignore) ? ignore : []);
  const outputGroups = [...groups.values()]
    .sort((a, b) => b.lastMs - a.lastMs)
    .map(({ actionTs, firstMs, lastMs, ...group }) => ({
      ...group,
      turns: group.turns.size,
      ignored: ignored.has(group.hash),
      sources: group.sources.sort(),
      actions: group.actions.sort(),
    }));
  const ruleWarnings = Object.create(null);
  for (const [rule, hits] of Object.entries(ruleHits)) {
    const share = hits ? (ruleStuck[rule] || 0) / hits : 0;
    if (share >= 0.5) {
      const out = Object.entries(ruleSources[rule]).sort((a, b) => b[1] - a[1]);
      ruleWarnings[rule] = { topSource: out[0][0], share };
    }
  }

  const cacheTotal = cacheHit + cacheMiss;
  const cacheHitRate = cacheTotal > 0 ? cacheHit / cacheTotal : 0;
  missOcrMs.sort((a, b) => a - b);
  const p95OcrMs = missOcrMs.length ? missOcrMs[Math.ceil(missOcrMs.length * 0.95) - 1] : 0;

  const ocr = {
    status: ocrStatus,
    cache: {
      hit: cacheHit,
      miss: cacheMiss,
      coalesced: cacheCoalesced,
      none: cacheNone,
      rate: cacheHitRate,
    },
    cacheHitRate,
    coalesced: cacheCoalesced,
    p95OcrMs,
    imagesWithHits,
    totalImages: totalOcrEvents,
    recent: recentOcr.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, 20),
    reasons,
  };

  return {
    requests,
    unique24h: unique.size,
    byRule: Object.fromEntries(Object.entries(ruleHits).map(([rule, hits]) => [rule, { unique: ruleHashes[rule]?.size || 0, hits }])),
    bySource, leaked24h: leaked.size, blocked24h: blocked.size, errors24h,
    groups: outputGroups, ruleWarnings, actionHits, trend, byAction: breakdown(outputGroups, ruleTurns),
    range: { from: sinceMs, to: untilMs },
    ocr,
  };
}


// One unit: a value (hash + rule) counts once: Allowed, else Leaked if it leaked, else its latest action. So the
// parts sum to the total. requests: distinct turns where a hit of that rule had that action.
function breakdown(groups, ruleTurns) {
  const out = Object.create(null);
  const row = key => out[key] ||= { values: Object.create(null), requests: Object.create(null) };
  for (const g of groups) {
    // A value that leaked in the range counts as Leaked, matching the Leaks card.
    const action = g.ignored ? "allowed" : g.actions.includes("leaked") ? "leaked" : g.action;
    for (const key of [g.rule, "all"]) row(key).values[action] = (row(key).values[action] || 0) + 1;
  }
  for (const [key, byAction] of Object.entries(ruleTurns)) for (const [action, turns] of Object.entries(byAction)) row(key).requests[action] = turns.size;
  return out;
}
