import { Worker } from "node:worker_threads";
import { DATA_FILE } from "./paths.js";

// Generic bounded pool of read-only SQLite worker threads. Same protocol and
// tuning as the Agents read worker (src/lib/agents/readWorker.mjs), but the
// worker module is a parameter, so other features (Spend) can reuse the
// pattern without touching src/lib/agents. The worker module must default-
// export { methods: { name: (db, args) => result } } and receive workerData
// { file, driver }.
const FILE_BACKED_DRIVERS = new Set(["better-sqlite3", "node:sqlite", "bun:sqlite"]);

const READ_WORKER_LIMIT = 1;
const READ_QUEUE_LIMIT = 20;
const READ_JOB_TIMEOUT_MS = 30_000;
const READ_WORKER_IDLE_MS = 60_000;

export class ReadPoolBusyError extends Error {
  constructor(poolName) {
    super(`${poolName} read queue is busy`);
    this.name = "ReadPoolBusyError";
    this.code = "busy";
    this.status = 503;
  }
}

export function createReadPool({
  name,
  workerModuleUrl,
  workerLimit = READ_WORKER_LIMIT,
  queueLimit = READ_QUEUE_LIMIT,
  jobTimeoutMs = READ_JOB_TIMEOUT_MS,
  idleMs = READ_WORKER_IDLE_MS,
} = {}) {
  const workers = [];
  const pending = [];
  const inFlight = new Map();
  let nextJobId = 1;
  let driver = null;
  let keyPrefix = null;

  function jobKey(key) {
    // One pool per worker module; the module decides what makes jobs equal.
    return JSON.stringify([keyPrefix, driver, key]);
  }

  function settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timeout);
    inFlight.delete(job.key);
    if (error) job.reject(error);
    else job.resolve(result);
  }

  function retire(slot, error = null) {
    if (slot.removed) return;
    slot.removed = true;
    slot.retired = true;
    clearTimeout(slot.idleTimer);
    clearTimeout(slot.job?.timeout);
    if (slot.job) {
      settle(slot.job, error || new Error(`${name} read worker exited`));
      slot.job = null;
    }
    const index = workers.indexOf(slot);
    if (index !== -1) workers.splice(index, 1);
    drain();
  }

  function armIdle(slot) {
    clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
      if (slot.job || slot.retired) return;
      slot.worker.terminate().catch(() => {});
    }, idleMs);
    slot.idleTimer.unref?.();
  }

  function createWorker() {
    const worker = new Worker(new URL("./poolWorker.mjs", import.meta.url), {
      workerData: { module: workerModuleUrl, keyPrefix: name, file: DATA_FILE, driver },
    });
    const slot = { worker, ready: false, retired: false, job: null, idleTimer: null };
    workers.push(slot);
    worker.on("message", (message) => {
      if (message?.driver) {
        // The worker echoes the driver it opened, so jobs from another
        // driver (DATA_DIR changed under tests) are not sent to it.
        slot.driver = message.driver;
      }
      if (message?.ready === false) {
        const error = new Error(message.error?.message || `${name} read worker failed to open the database`);
        const job = slot.job;
        if (job && !job.settled && !job.openRetried) {
          clearTimeout(job.timeout);
          job.openRetried = true;
          slot.job = null;
          pending.unshift(job);
        }
        retire(slot, error);
        slot.worker.terminate().catch(() => {});
        return;
      }
      if (message?.ready) {
        slot.ready = true;
        armIdle(slot);
        drain();
        return;
      }
      const job = slot.job;
      if (!job || message?.id !== job.id) return;
      slot.job = null;
      clearTimeout(job.timeout);
      if (message?.error) {
        const error = new Error(message.error.message || `${name} read job failed`);
        if (message.error.stack) error.stack = message.error.stack;
        settle(job, error);
      } else settle(job, null, message?.result);
      armIdle(slot);
      drain();
    });
    worker.on("error", (error) => retire(slot, error));
    worker.on("exit", (code) => retire(slot, code === 0 ? new Error(`${name} read worker exited`) : new Error(`${name} read worker exited with code ${code}`)));
    return slot;
  }

  function dispatch(slot, job) {
    clearTimeout(slot.idleTimer);
    slot.job = job;
    job.timeout = setTimeout(() => {
      if (slot.job !== job) return;
      slot.job = null;
      settle(job, new Error(`${name} read job timed out`));
      slot.retired = true;
      slot.worker.terminate().catch(() => {}).finally(drain);
    }, jobTimeoutMs);
    job.timeout.unref?.();
    slot.worker.postMessage({ id: job.id, method: job.method, args: job.args });
  }

  function drain() {
    while (pending.length) {
      let slot = workers.find((c) => c.ready && !c.job && !c.retired && (!driver || !c.driver || c.driver === driver));
      if (!slot) {
        if (workers.length >= workerLimit) return;
        try { slot = createWorker(); }
        catch (error) {
          settle(pending.shift(), error);
          continue;
        }
      }
      dispatch(slot, pending.shift());
    }
  }

  function run(db, method, args, { key } = {}) {
    // Non-file-backed adapters (sql.js in-memory) cannot be opened read-only
    // in a worker; callers fall back to running the method inline.
    if (!FILE_BACKED_DRIVERS.has(db?.driver)) return Promise.reject(new Error("read pool needs a file-backed driver"));
    driver = db.driver;
    keyPrefix = name;
    const jobKeyStr = jobKey(key ?? JSON.stringify(args));
    const current = inFlight.get(jobKeyStr);
    if (current) return current.promise;
    if (pending.length >= queueLimit) return Promise.reject(new ReadPoolBusyError(name));
    const job = { id: nextJobId++, method, args, key: jobKeyStr, settled: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    inFlight.set(jobKeyStr, job);
    pending.push(job);
    drain();
    return job.promise;
  }

  function busy() {
    return workers.filter((c) => c.ready && !c.retired).length > 0;
  }

  return { run, busy };
}
