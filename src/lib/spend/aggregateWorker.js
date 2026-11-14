// Worker entry for the Spend read pool (src/lib/db/readPool.js). Exposes the
// aggregate as a method so the gateway main thread only awaits.
import { aggregateSpend } from "./aggregate.js";

const methods = { aggregate: (db, args) => aggregateSpend(db, args) };
export default { methods };
