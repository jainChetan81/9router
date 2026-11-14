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

const sameRoute = (route, raw, key) => (route && (key !== "combo" || Object.hasOwn(route, "combo")) ? route[key] : raw);
const label = (v) => (typeof v === "string" && v ? v.slice(0, 80) : null);
const ROUTES_SOFT = 20_000, ROUTES_HARD = 50_000, ROUTES_KEEP = 10_000;

/** Folds events into a summary one at a time, so a caller can stream a log and keep only this state.
 *  `add(event, ts)` takes events in file order; `route(event)` takes routing records (the last one for a
 *  request wins, and it may arrive after its event); `finish()` projects the state and can be called again
 *  after more events. `open: true` takes events with any later timestamp: `finish({ until })` then sets
 *  the range end. step/origin: bucket hits into a trend (ms per bucket, start of bucket 0). */
export function createSummarizer({ since, until, now = Date.now(), step, origin, open = false } = {}) {
  const sinceMs = Number.isFinite(since) ? since : now - DAY;
  const untilMs = open ? Infinity : Number.isFinite(until) ? until : now;
  const groups = new Map(), routes = new Map();
  const ruleHits = Object.create(null), ruleStuck = Object.create(null), ruleHashes = Object.create(null), ruleSources = Object.create(null), bySource = Object.create(null);
  const leaked = new Set(), blocked = new Set(), unique = new Set();
  let errors24h = 0;
  let requests = 0;
  const actionHits = Object.create(null), ruleTurns = Object.create(null);
  const buckets = new Map();
  const ocrStatus = { scanned: 0, partial: 0, empty: 0, failed: 0, skipped: 0 };
  let cacheHit = 0, cacheMiss = 0, cacheCoalesced = 0, cacheNone = 0;
  const missOcrMs = [];
  let imagesWithHits = 0;
  let totalOcrEvents = 0;
  let recentOcr = [];
  const reasons = Object.create(null);

  // Routing records are kept for the requests the summary still shows, plus the most recent ones.
  function prune() {
    const used = new Set();
    for (const g of groups.values()) if (g.routeId) used.add(g.routeId);
    for (const o of recentOcr) if (o.entry.requestId) used.add(o.entry.requestId);
    for (const id of routes.keys()) {
      if (routes.size <= ROUTES_KEEP) break;
      if (!used.has(id)) routes.delete(id);
    }
  }
  function route(event) {
    if (event?.kind !== "routing" || typeof event.requestId !== "string") return;
    const fields = {};
    for (const key of ["provider", "account", "resolvedModel"]) fields[key] = typeof event[key] === "string" ? event[key] : null;
    if (typeof event.combo === "string") fields.combo = event.combo;
    routes.delete(event.requestId); // newest last
    routes.set(event.requestId, fields);
    if (routes.size > ROUTES_HARD) prune();
  }

  function add(rawEvent, ts = Date.parse(rawEvent?.ts)) {
    if (!rawEvent || rawEvent.kind === "routing") return;
    if (rawEvent.type === "test" || rawEvent.test === true) return;
    if (!Number.isFinite(ts) || ts < sinceMs || ts > untilMs) return;
    if (rawEvent.type === "error") { errors24h += Number.isInteger(rawEvent.count) && rawEvent.count > 0 ? rawEvent.count : 1; return; }
    if (rawEvent.type === "stats") return;
    const routeId = typeof rawEvent.requestId === "string" ? rawEvent.requestId : undefined;

    if (rawEvent.type === "ocr") {
      totalOcrEvents++;
      if (rawEvent.reason) reasons[rawEvent.reason] = (reasons[rawEvent.reason] || 0) + 1;
      // Provider and combo are resolved in finish(): the routing record may not have been read yet.
      recentOcr.push({ provider: rawEvent.provider, combo: rawEvent.combo, routeId, entry: { ts: rawEvent.ts, requestId: rawEvent.requestId, model: rawEvent.model, endpoint: rawEvent.endpoint, imageIndex: rawEvent.imageIndex, status: rawEvent.status, ...(rawEvent.reason && { reason: rawEvent.reason }), cache: rawEvent.cache, ocrMs: rawEvent.ocrMs, mode: rawEvent.mode, rules: [...new Set((Array.isArray(rawEvent.hits) ? rawEvent.hits : []).filter(hit => hit && hit.action !== "ignored").map(hit => hit.name || hit.rule).filter(Boolean))] } });
      // Keep only the newest 20; trim in batches so a long range never holds every OCR event.
      if (recentOcr.length > 200) { recentOcr.sort((a, b) => Date.parse(b.entry.ts) - Date.parse(a.entry.ts)); recentOcr.length = 20; }
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
      if (step > 0) {
        const at = Math.floor((ts - origin) / step);
        if (at >= 0 && at < 400) {
          let bucket = buckets.get(at);
          if (!bucket) buckets.set(at, bucket = { hits: 0, leaks: 0 });
          bucket.hits++; if (action === "leaked") bucket.leaks++;
        }
      }
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
        group.rawProvider = rawEvent.provider; group.rawCombo = rawEvent.combo; group.routeId = routeId;
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

  function finish({ until: end, ignore = [], routing = routes } = {}) {
    const toMs = open ? (Number.isFinite(end) ? end : now) : untilMs;
    const nTrend = step > 0 ? Math.min(400, Math.ceil(((open ? toMs : Number.isFinite(until) ? until : now) - origin) / step)) : 0;
    const trend = Array.from({ length: Math.max(0, nTrend) }, (_, i) => ({ hits: buckets.get(i)?.hits || 0, leaks: buckets.get(i)?.leaks || 0 }));
    const resolve = (id, raw, key) => sameRoute(id === undefined ? undefined : routing.get(id), raw, key);
    const ignored = new Set(Array.isArray(ignore) ? ignore : []);
    const outputGroups = [...groups.values()]
      .sort((a, b) => b.lastMs - a.lastMs)
      .map(({ actionTs, firstMs, lastMs, rawProvider, rawCombo, routeId, ...group }) => ({
        ...group,
        provider: label(resolve(routeId, rawProvider, "provider")),
        combo: label(resolve(routeId, rawCombo, "combo")),
        turns: group.turns.size,
        ignored: ignored.has(group.hash),
        sources: [...group.sources].sort(),
        actions: [...group.actions].sort(),
        leakedWhere: [...group.leakedWhere],
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
    const sortedMs = missOcrMs.slice().sort((a, b) => a - b);
    const p95OcrMs = sortedMs.length ? sortedMs[Math.ceil(sortedMs.length * 0.95) - 1] : 0;
    const recent = recentOcr.slice().sort((a, b) => Date.parse(b.entry.ts) - Date.parse(a.entry.ts)).slice(0, 20).map((o) => {
      const provider = resolve(o.routeId, o.provider, "provider"), combo = resolve(o.routeId, o.combo, "combo");
      return { ...o.entry, ...(typeof provider === "string" && provider && { provider }), ...(typeof combo === "string" && combo && { combo }) };
    });
    if (routing === routes && routes.size > ROUTES_SOFT) prune();

    const ocr = {
      status: { ...ocrStatus },
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
      recent,
      reasons: { ...reasons },
    };

    return {
      requests,
      unique24h: unique.size,
      byRule: Object.fromEntries(Object.entries(ruleHits).map(([rule, hits]) => [rule, { unique: ruleHashes[rule]?.size || 0, hits }])),
      bySource: { ...bySource }, leaked24h: leaked.size, blocked24h: blocked.size, errors24h,
      groups: outputGroups, ruleWarnings, actionHits: { ...actionHits }, trend, byAction: breakdown(outputGroups, ruleTurns),
      range: { from: sinceMs, to: toMs },
      ocr,
    };
  }
  return { add, route, finish };
}

export function summarize(events, { since, until, now = Date.now(), ignore = [], step, origin, routing: preRouting, times: preTimes, startIndex = 0 } = {}) {
  events = Array.isArray(events) ? events : [];
  const routing = preRouting || routingByRequest(events);
  const summarizer = createSummarizer({ since, until, now, step, origin });
  for (let idx = Math.max(0, startIndex); idx < events.length; idx++) {
    const event = events[idx];
    if (event) summarizer.add(event, preTimes ? preTimes[idx] : Date.parse(event.ts));
  }
  return summarizer.finish({ ignore, routing });
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
