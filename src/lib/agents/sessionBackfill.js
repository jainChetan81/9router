// Drives migration 003's session backfill in the background: one small batch,
// a pause, the next batch. Started lazily by the Agents API routes; a restart
// resumes from the id saved in _meta. Each batch is a short write on the main
// adapter, so the gateway event loop is never held for long.
import { backfillSessionBatch } from "../db/migrations/003-usage-history-session-backfill.js";

const STATE_KEY = Symbol.for("9router.agents.sessionBackfill");
const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = { running: false, done: false });

export const BACKFILL_BATCH_ROWS = 1000;
export const BACKFILL_GAP_MS = 250;

export function scheduleSessionBackfill(db, { batch = BACKFILL_BATCH_ROWS, gapMs = BACKFILL_GAP_MS } = {}) {
  if (state.done || state.running) return false;
  if (typeof db?.run !== "function" || typeof db?.transaction !== "function" || typeof db?.get !== "function") return false;
  state.running = true;
  const arm = () => { const timer = setTimeout(step, gapMs); timer.unref?.(); };
  const step = () => {
    try {
      if (backfillSessionBatch(db, batch).done) {
        state.done = true;
        state.running = false;
        return;
      }
    } catch {
      // Busy or closed database: stop now, the next Agents request retries.
      state.running = false;
      return;
    }
    arm();
  };
  arm();
  return true;
}

/** Reset scheduler state (tests). */
export function resetSessionBackfillState() { state.running = false; state.done = false; }
