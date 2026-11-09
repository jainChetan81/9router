export default {
  version: 2,
  name: "usage-history-session",
  up(db) {
    const tableColumns = db.all("PRAGMA table_info(usageHistory)");
    // Some partial legacy databases omit usageHistory. The following additive
    // schema sync creates it with this column and index from TABLES.
    if (tableColumns.length === 0) return;
    const columns = new Set(tableColumns.map((column) => column.name));
    if (!columns.has("session")) {
      db.exec("ALTER TABLE usageHistory ADD COLUMN session TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_uh_session ON usageHistory(session, timestamp)");
  },
};
