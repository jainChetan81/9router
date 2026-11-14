// Writer thread of the masked prompt store: every SQLite call of the gateway's prompt store runs here, so
// the thread that streams /v1 never waits on the disk. Messages are { id, method, file, args }; replies
// are { id, result } or { id, error }.
import { parentPort } from "node:worker_threads";
import { READS, closeDb, digestsFor, openDb, sweep, textBytes, usedBytes, writeOps } from "./promptDb.mjs";

const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data?.code === "MODULE_TYPELESS_PACKAGE_JSON") return false;
  return emit.call(process, name, data, ...rest);
};

const HOUR = 36e5, SWEEP_AFTER_BYTES = 8 * 1024 * 1024, SLICE_MS = 100;
let handle = null, failedFile = null, sinceSweep = 0, sweeping = false;

function open(file) {
  if (handle && handle.file !== file) { closeDb(handle); handle = null; }
  if (handle || failedFile === file) return handle;
  // The gateway is the only writer; a short wait covers a dashboard read on another connection.
  handle = openDb(file, { busyTimeout: 2000 });
  if (!handle) failedFile = file;
  else { failedFile = null; startSweep(); }
  return handle;
}

// Retention in slices: between two slices the thread answers queued writes and reads.
function startSweep(now) {
  if (sweeping || !handle) return;
  sweeping = true; sinceSweep = 0;
  const step = () => {
    let more = false;
    try { more = !!handle && sweep(handle, now ?? Date.now(), { budgetMs: SLICE_MS, vacuumPages: 1024 }).more; } catch {}
    if (more) setImmediate(step); else sweeping = false;
  };
  setImmediate(step);
}
setInterval(() => startSweep(), HOUR).unref();

const methods = {
  write({ file, args }) {
    const h = open(file);
    if (!h) throw new Error("prompt store unavailable");
    const result = writeOps(h, args.ops);
    sinceSweep += result.bytes;
    if (sinceSweep >= SWEEP_AFTER_BYTES) startSweep();
    return result;
  },
  seed({ file, args }) {
    const h = open(file);
    return h ? digestsFor(h, args.sessionId) : [];
  },
  // Runs to the end in one call: used by tests and by a manual sweep, not by the timers above.
  sweep({ file, args }) {
    const h = open(file);
    return h ? sweep(h, args.now ?? Date.now(), { capBytes: args.capBytes }).removed : 0;
  },
  size({ file }) {
    const h = open(file);
    return h ? { textBytes: textBytes(h), usedBytes: usedBytes(h) } : null;
  },
  close() { closeDb(handle); handle = null; failedFile = null; return true; },
};
for (const [name, read] of Object.entries(READS)) methods[name] = ({ file, args }) => read(open(file), args);

parentPort.on("message", (message) => {
  const { id, method } = message || {};
  try {
    if (!Object.hasOwn(methods, method)) throw new Error("unknown method");
    parentPort.postMessage({ id, result: methods[method](message) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
