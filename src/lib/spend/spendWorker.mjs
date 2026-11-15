// Worker entry for the Spend read pool. Static imports let webpack bundle the
// aggregate into this worker chunk; the gateway main thread only awaits.
import { startPoolWorker } from "../db/poolWorker.mjs";
import { aggregateSpend } from "./aggregate.js";

startPoolWorker({ aggregate: (db, args) => aggregateSpend(db, args) });
