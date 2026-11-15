import initializeApp from "./initializeApp.js";

// Skip during Next.js build/prerender — bootstrap would download cloudflared, init DNS, etc.
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build"
  || process.env.NEXT_PHASE === "phase-export"
  || process.env.NEXT_PHASE === "phase-static";

// Server-only singleton: guard via global so HMR / re-imports don't double-init
if (typeof window === "undefined" && !isBuildPhase && !global.__appBootstrapped) {
  global.__appBootstrapped = true;
  // Re-aggregate usageHistory rows a crash lost from usageDaily (runs once,
  // after the adapter's migrations, and reads only the tail past the marker).
  import("@/lib/db/repos/usageRepo.js")
    .then((m) => m.reconcileUsageDaily())
    .catch((e) => console.error("[Bootstrap] usage reconcile failed:", e.message));
  initializeApp().catch((e) => console.error("[Bootstrap] init failed:", e.message));
}
