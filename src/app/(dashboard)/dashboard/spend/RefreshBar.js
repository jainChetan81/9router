// Thin animated bar shown while data refreshes in the background.
export default function RefreshBar({ on, label = "Refreshing data" }) {
  if (!on) return <div className="r9-refresh-bar" aria-hidden="true" style={{ visibility: "hidden" }} />;
  return <div className="r9-refresh-bar" role="status" aria-label={label} />;
}
