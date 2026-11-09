export default function PageHeader({ title, subtitle, icon, status }) {
  return (
    <div className="r9-page-titleblock">
      <div className="r9-header-row">
        {icon && <span className="material-symbols-outlined" style={{ fontSize: 24, color: "var(--acc)" }} aria-hidden="true">{icon}</span>}
        <h1 className="r9-header-title">{title}</h1>
        {status && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, height: 22, padding: "0 9px", borderRadius: 11, background: "var(--greenbg)", color: "var(--green)", fontSize: 11, fontWeight: 600 }}>{status}</span>}
      </div>
      <p className="r9-header-subtitle">{subtitle}</p>
    </div>
  );
}
