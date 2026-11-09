import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const root = process.env.AGENTS_BENCH_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
register(pathToFileURL(path.join(root, 'scripts/agents-bench/loader.mjs')), pathToFileURL(`${root}/`));
const N = Number(process.env.BENCH_N || 100_000);
const dbSource = path.join(os.homedir(), '.9router/db/data.sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '9router-agents-bench-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
if (!fs.existsSync(dbSource)) throw new Error(`DB copy source is missing: ${dbSource}`);
fs.copyFileSync(dbSource, path.join(dataDir, 'db/data.sqlite'));
process.env.DATA_DIR = dataDir;
process.env.AGENTS_BENCH_ROOT = root;
const loader = pathToFileURL(path.join(root, 'scripts/agents-bench/loader.mjs')).href;
const measurements = [];

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] || 0;
  return { p50: pick(.5), p95: pick(.95), p99: pick(.99), mean: samples.reduce((a, b) => a + b, 0) / samples.length };
}
function measure(name, fn, { iterations = N, batch = 1000 } = {}) {
  for (let i = 0; i < Math.min(5000, iterations); i++) fn(i);
  const samples = [];
  for (let base = 0; base < iterations; base += batch) {
    const count = Math.min(batch, iterations - base);
    const start = performance.now();
    for (let i = 0; i < count; i++) fn(base + i);
    samples.push((performance.now() - start) / count);
  }
  measurements.push({ name, iterations, unit: 'ms/op', ...stats(samples) });
}
function timeOnce(name, fn) {
  const start = performance.now();
  return Promise.resolve(fn()).then((value) => {
    measurements.push({ name, iterations: 1, unit: 'ms', p50: performance.now() - start, p95: performance.now() - start, p99: performance.now() - start });
    return value;
  });
}

try {
  const reqDetail = await import(pathToFileURL(path.join(root, 'open-sse/handlers/chatCore/requestDetail.js')));
  const usageRepo = await import(pathToFileURL(path.join(root, 'src/lib/db/repos/usageRepo.js')));
  const live = await import(pathToFileURL(path.join(root, 'src/lib/agents/liveRegistry.js')));
  const override = await import(pathToFileURL(path.join(root, 'src/lib/agents/overrideStore.js')));
  const queries = await import(pathToFileURL(path.join(root, 'src/lib/agents/queries.js')));
  const stream = await import(pathToFileURL(path.join(root, 'open-sse/utils/stream.js')));

  const raw = { headers: { 'user-agent': 'Claude-Code/1.0 (Linux; x64)' }, session: 'realistic-bench-session', combo: 'implementer', reqId: 'bench-request', effort: { clientEffort: 'high', sentEffort: 'high', effortSource: 'model-setting' } };
  measure('spendMeta', (i) => reqDetail.spendMeta({ ...raw, reqId: `bench-${i}` }, { cost: 0.001234 }, { status: 'ok', latency: { ttftMs: 310, totalMs: 1850, stream: true } }));
  // The repository INSERT path is exercised sequentially to isolate SQLite transaction/write cost.
  const db = await queries.getDb();
  const writeTimes = [];
  const writes = Math.min(1500, Math.max(200, Math.floor(N / 50)));
  for (let i = 0; i < writes; i++) {
    const entry = { provider: 'openai', model: 'gpt-4.1-mini', tokens: { prompt_tokens: 700, completion_tokens: 180 }, timestamp: new Date(Date.now() + i).toISOString(), endpoint: '/v1/chat/completions', status: 'ok', cost: 0, meta: { ...reqDetail.spendMeta({ ...raw, session: `bench-session-${i}`, reqId: `bench-${i}` }, { cost: .001 }), reqId: `bench-${i}` } };
    const start = performance.now();
    await usageRepo.saveRequestUsage(entry);
    writeTimes.push(performance.now() - start);
  }
  measurements.push({ name: 'saveRequestUsage', iterations: writes, unit: 'ms/op', ...stats(writeTimes) });

  measure('live register/markFirstToken/unregister', (i) => { const id = `bench-live-${i}`; live.register(id, { session: '123456789abc', combo: 'implementer', model: 'claude-sonnet-4-5', provider: 'anthropic', startedAt: performance.now() }); live.markFirstToken(id); live.unregister(id, 'ok'); });

  const resolveCases = [];
  for (const count of [0, 10, 2000]) {
    const session = `s${String(count).padStart(11, '0')}`.slice(-12);
    if (count) {
      for (let i = 0; i < count; i++) {
        const sid = i === 0 ? session : `${String(i).padStart(12, '0')}`;
        override.__benchSeed?.(sid, 'implementer');
      }
    }
    const key = count ? session : '000000000000';
    measure(`override resolve/get (${count} cached)`, (i) => { override.resolveSessionOverride({ rawSession: key, combo: 'implementer', comboMembers: ['claude-sonnet-4-5', 'claude-haiku-4-5'] }); override.getOverride(key, 'implementer'); });
  }

  const checker = stream.hasSemanticToken || stream.isSemanticToken || stream.hasMeaningfulContent;
  if (typeof checker === 'function') {
    const chunks = [
      { event: 'content_block_start', data: { type: 'content_block_start', content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello, this is a realistic response.' } } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
      { event: 'choices', data: { choices: [{ delta: { content: ' streamed response' } }] } },
    ];
    measure('semantic TTFT check (Claude/OpenAI SSE chunks)', (i) => checker(chunks[i % chunks.length]), { iterations: N * chunks.length });
  } else {
    measurements.push({ name: 'semantic TTFT check', skipped: 'No recognizable exported semantic-token predicate in stream.js' });
  }

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const from30 = iso(now - 30 * 86400000);
  const from7 = iso(now - 7 * 86400000);
  const to = iso(now + 60000);
  const sessions = await queries.listSessions(db, from30, to);
  const busiest = sessions.reduce((best, s) => !best || s.requests > best.requests ? s : best, null);
  const readCases = [
    ['getLive', () => queries.getLive(db, now)],
    ['listSessions 30D', () => queries.listSessions(db, from30, to)],
    ['getAnalytics 7D', () => queries.getAnalytics(db, from7, to)],
    ['getAnalytics 30D', () => queries.getAnalytics(db, from30, to)],
    ['getSessionDetail busiest', () => busiest ? queries.getSessionDetail(db, busiest.session) : Promise.resolve(null)],
  ];
  const hasWorker = fs.existsSync(path.join(root, 'src/lib/agents/readWorker.mjs'));
  for (const [name, fn] of readCases) {
    const samples = [];
    let blocking = [];
    for (let i = 0; i < 15; i++) {
      const delay = hasWorker ? monitorEventLoopDelay({ resolution: 1 }) : null;
      delay?.enable();
      const start = performance.now();
      await fn();
      samples.push(performance.now() - start);
      if (delay) { delay.disable(); blocking.push(delay.max / 1e6); }
    }
    measurements.push({ name, iterations: 15, unit: 'ms', ...stats(samples), ...(hasWorker ? { mainThreadBlocking: stats(blocking) } : { mainThreadBlocking: 'inline query; wall time is blocking time' }) });
  }
  const target = await timeOnce('getSessionDetail busiest (single)', () => busiest ? queries.getSessionDetail(db, busiest.session) : null);
  void target;

  let gitMaster = null;
  try { gitMaster = execFileSync('git', ['-C', process.env.AGENTS_BENCH_MASTER_REPO || process.cwd(), 'rev-parse', 'origin/master'], { encoding: 'utf8' }).trim(); } catch {}
  const report = { generatedAt: new Date().toISOString(), branch: execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), masterRef: gitMaster, dbCopyBytes: fs.statSync(path.join(dataDir, 'db/data.sqlite')).size, readWorker: hasWorker, measurements };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
