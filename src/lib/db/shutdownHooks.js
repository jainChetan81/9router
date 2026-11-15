// One ordered list of synchronous "flush before the database closes" hooks.
//
// The adapters own the SIGINT/SIGTERM handler that closes the database and
// exits. A buffer that registered its own signal listener would run after
// that handler whenever the adapter loaded first, against a closed database.
// Instead each buffer registers here, and every adapter runs the list right
// before it closes. The list also runs on "exit", which covers a
// process.exit() from any other signal handler while the database is open.
//
// Hooks must be synchronous, must not throw for a closed database, and must
// be safe to run more than once (an empty buffer is a no-op).

// Global so HMR re-imports and bundler copies share one list.
const state = (globalThis.__nineRouterDbShutdownHooks ||= { hooks: new Map(), exitBound: false });

/**
 * Register a hook that flushes buffered writes before the database closes.
 * A later registration under the same name replaces the earlier one, so a
 * re-imported module never stacks hooks.
 *
 * @param {string} name
 * @param {() => void} fn synchronous flush
 */
export function onBeforeDbClose(name, fn) {
  state.hooks.set(name, fn);
  if (!state.exitBound) {
    state.exitBound = true;
    process.on("exit", runBeforeDbClose);
  }
}

/** Run every hook in registration order. One failing hook never stops the rest. */
export function runBeforeDbClose() {
  for (const [name, fn] of state.hooks) {
    try { fn(); } catch (e) { console.error(`[DB] shutdown hook ${name} failed:`, e?.message || e); }
  }
}
