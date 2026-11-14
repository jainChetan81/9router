// Generic read-pool worker. Opens the database read-only, then answers
// { id, method, args } messages by calling methods exported by the target
// module's default export ({ methods }).
import { parentPort, workerData } from "node:worker_threads";

const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === "warning" && data?.code === "MODULE_TYPELESS_PACKAGE_JSON") return false;
  return emit.call(process, name, data, ...rest);
};

function wrap(raw, driver) {
  return {
    driver,
    all(sql, params = []) { return raw.prepare(sql).all(...params); },
    get(sql, params = []) { return raw.prepare(sql).get(...params); },
    close() { raw.close(); },
  };
}

async function openReadOnlyAdapter(file, driver) {
  if (driver === "node:sqlite") {
    const { DatabaseSync } = await import("node:sqlite");
    return wrap(new DatabaseSync(file, { readOnly: true }), "worker-readonly");
  }
  if (driver === "better-sqlite3") {
    const { default: Database } = await import("better-sqlite3");
    return wrap(new Database(file, { readonly: true, fileMustExist: true }), "worker-readonly");
  }
  if (driver === "bun:sqlite") {
    const { Database } = await import("bun:sqlite");
    return wrap(new Database(file, { readonly: true, create: false }), "worker-readonly");
  }
  throw new Error(`Unsupported read pool driver: ${driver}`);
}

let db;
let methods;
try {
  db = await openReadOnlyAdapter(workerData.file, workerData.driver);
  methods = (await import(workerData.module)).default.methods;
  if (!methods) throw new Error("read pool module must default-export { methods }");
  parentPort.postMessage({ ready: true, driver: workerData.driver });
} catch (error) {
  parentPort.postMessage({ ready: false, error: { message: error?.message || String(error), stack: error?.stack } });
  parentPort.close();
}

if (db && methods) {
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => parentPort.close(), 60_000);
    idleTimer.unref?.();
  };
  parentPort.on("message", async ({ id, method, args }) => {
    clearTimeout(idleTimer);
    try {
      const fn = methods[method];
      if (typeof fn !== "function") throw new Error(`Unknown read pool method: ${method}`);
      const result = await fn(db, args);
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: { message: error?.message || String(error), stack: error?.stack } });
    } finally {
      resetIdleTimer();
    }
  });
  resetIdleTimer();
}
