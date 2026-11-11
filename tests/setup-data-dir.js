// Every test run gets a throwaway data folder. Without this, a test that
// reaches the usage logger writes rows into the live ~/.9router database
// (they showed as "invalid" model requests on the Spend page).
// Tests that need their own folder still set process.env.DATA_DIR themselves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-"));
}
