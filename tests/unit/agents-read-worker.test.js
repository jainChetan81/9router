import { describe, expect, it, vi } from "vitest";

globalThis.__agentsReadWorkers = [];

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWorker extends EventEmitter {
    static instances = globalThis.__agentsReadWorkers;

    constructor() {
      super();
      this.messages = [];
      this.terminated = false;
      MockWorker.instances.push(this);
      const failOpen = globalThis.__agentsReadWorkerFailAll === true || globalThis.__agentsReadWorkerFailOpen === true;
      globalThis.__agentsReadWorkerFailOpen = false;
      queueMicrotask(() => this.emit("message", failOpen
        ? { ready: false, error: { message: "database open failed" } }
        : { ready: true }));
    }

    postMessage(message) { this.messages.push(message); }

    terminate() {
      this.terminated = true;
      queueMicrotask(() => this.emit("exit", 1));
      return Promise.resolve(1);
    }
  }

  return { Worker: MockWorker };
});

const db = { driver: "node:sqlite" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function drainWorkerMessages(worker) {
  let handled = 0;
  while (handled < worker.messages.length) {
    const { id } = worker.messages[handled++];
    worker.emit("message", { id, result: { sessions: [], nextCursor: null, total: 0, truncated: false } });
  }
}

describe("agents read worker pool", () => {
  it("coalesces identical reads, bounds the queue, and settles clean exits", async () => {
    const queries = await import("@/lib/agents/queries.js");
    const first = queries.listSessionsPage(db, "from", "to", { limit: 10 });
    const duplicate = queries.listSessionsPage(db, "from", "to", { limit: 10 });
    expect(duplicate).toBe(first);

    const accepted = [first];
    for (let index = 1; index < 22; index += 1) {
      accepted.push(queries.listSessionsPage(db, `from-${index}`, "to", { limit: 10 }));
    }
    await expect(queries.listSessionsPage(db, "overflow", "to", { limit: 10 }))
      .rejects.toMatchObject({ code: "busy", status: 503 });
    await tick();
    expect(globalThis.__agentsReadWorkers).toHaveLength(2);
    await Promise.all(globalThis.__agentsReadWorkers.map(drainWorkerMessages));
    await expect(Promise.all(accepted)).resolves.toHaveLength(22);

    const cleanExit = queries.getSessionDetail(db, "exit-case");
    await tick();
    const active = globalThis.__agentsReadWorkers.find((worker) => worker.messages.at(-1)?.method === "getSessionDetail");
    active.emit("exit", 0);
    await expect(cleanExit).rejects.toThrow("exited");
  });

  it("times out a read, terminates its worker, and allows replacement", async () => {
    const queries = await import("@/lib/agents/queries.js");
    const result = queries.getAnalytics(db, "timeout-from", "timeout-to");
    await expect(result).rejects.toThrow("timed out");
    expect(globalThis.__agentsReadWorkers.some((worker) => worker.terminated)).toBe(true);
    await tick();
    expect(globalThis.__agentsReadWorkers.length).toBeGreaterThanOrEqual(2);
  }, 7000);

  it("retires a worker that reports a database open failure and retries the read", async () => {
    globalThis.__agentsReadWorkerFailOpen = true;
    const queries = await import("@/lib/agents/queries.js");
    const result = queries.listSessionsPage(db, "open-failure-from", "open-failure-to", { limit: 10 });
    await tick();
    await tick();
    const failed = globalThis.__agentsReadWorkers.find((worker) => worker.terminated);
    expect(failed).toBeDefined();
    await Promise.all(globalThis.__agentsReadWorkers.filter((worker) => !worker.terminated).map(drainWorkerMessages));
    await expect(result).resolves.toMatchObject({ sessions: [], total: 0 });
  });
  it("fails the read after one retry when every worker cannot open the database", async () => {
    for (const worker of globalThis.__agentsReadWorkers) if (!worker.terminated) worker.emit("exit", 0);
    await tick();
    globalThis.__agentsReadWorkerFailAll = true;
    const before = globalThis.__agentsReadWorkers.length;
    const queries = await import("@/lib/agents/queries.js");
    const result = queries.listSessionsPage(db, "all-fail-from", "all-fail-to", { limit: 10 });
    await expect(result).rejects.toThrow("database open failed");
    for (let i = 0; i < 5; i += 1) await tick();
    globalThis.__agentsReadWorkerFailAll = false;
    expect(globalThis.__agentsReadWorkers.length - before).toBeLessThanOrEqual(2);
  });
});
