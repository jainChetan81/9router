import { Worker } from "node:worker_threads";
import { createReadPool } from "../db/readPool.js";

// One bounded read pool for Spend. `new Worker(new URL(...))` must stay
// literal and next to the entry file so webpack emits the worker chunk.
export const spendPool = createReadPool({
  name: "spend",
  spawnWorker: (workerData) => new Worker(new URL("./spendWorker.mjs", import.meta.url), { workerData }),
});
