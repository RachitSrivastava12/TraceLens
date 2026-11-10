import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import "./style.css";

const API_KEY = "tl_dev_local_key";

type Span = {
  id: string;
  parent_span_id: string | null;
  name: string;
  type: string;
  status: string;
  duration_ms: string | number | null;
  input: unknown;
  output: unknown;
  error: { name: string; message: string; stack?: string } | null;
};

type Trace = {
  id: string;
  name: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: string | number | null;
  metadata: Record<string, unknown>;
};

type TraceDetail = {
  trace: Trace;
  spans: Span[];
  events: unknown[];
};

const headers = { "x-api-key": API_KEY };

async function fetchTraces(): Promise<Trace[]> {
  const response = await fetch("/v1/traces", { headers });
  if (!response.ok) throw new Error("Could not load traces");
  const data = await response.json();
  return data.traces;
}

async function fetchDetail(id: string): Promise<TraceDetail> {
  const response = await fetch(`/v1/traces/${id}`, { headers });
  if (!response.ok) throw new Error("Could not load trace details");
  return response.json();
}

function duration(value: unknown) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function timeAgo(value: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(value).toLocaleDateString();
}

function Status({ value }: { value: string }) {
  return <span className={`status ${value}`}><i />{value}</span>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
    traces: <><path d="M4 5h16M4 12h16M4 19h16"/><circle cx="8" cy="5" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="10" cy="19" r="1.5"/></>,
    activity: <><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></>,
    arrow: <><path d="M7 17 17 7M7 7h10v10"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></>,
    moon: <><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2Z"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></>,
    chevron: <path d="m7 10 5 5 5-5"/>,
    back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h12"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    bolt: <path d="m13 2-3 9h7l-6 11 2-9H6l7-11Z"/>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.activity}</svg>;
}

function Metric({ label, value, note, icon, tone = "teal" }: {
  label: string; value: string; note: string; icon: string; tone?: string;
}) {
  return <article className="metric-card">
    <div className="metric-head"><span>{label}</span><span className={`metric-icon ${tone}`}><Icon name={icon}/></span></div>
    <div className="metric-value">{value}</div>
    <div className="metric-note">{note}</div>
  </article>;
}

function ActivityChart({ traces }: { traces: Trace[] }) {
  const points = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date();
      date.setDate(date.getDate() - (6 - index));
      date.setHours(0, 0, 0, 0);
      const next = new Date(date);
      next.setDate(next.getDate() + 1);
      const dayTraces = traces.filter(t => {
        const time = new Date(t.started_at).getTime();
        return time >= date.getTime() && time < next.getTime();
      });
      return {
        label: date.toLocaleDateString(undefined, { weekday: "short" }),
        total: dayTraces.length,
        failed: dayTraces.filter(t => t.status === "error").length,
      };
    });
    return days;
  }, [traces]);

  const max = Math.max(1, ...points.map(p => p.total));
  const coords = points.map((p, i) => ({
    x: 30 + i * 53,
    y: 125 - (p.total / max) * 94,
    failedY: 125 - (p.failed / max) * 94,
  }));
  const line = coords.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const area = `${line} L ${coords[coords.length - 1].x} 132 L ${coords[0].x} 132 Z`;

  return <div className="chart-wrap">
    <div className="chart-summary"><div><strong>{traces.length}</strong><span> executions loaded</span></div><span className="chart-legend"><i/> Traces <i className="legend-error"/> Failed</span></div>
    <svg className="activity-chart" viewBox="0 0 370 165" role="img" aria-label="Trace activity over the last seven days">
      {[35, 65, 95, 125].map(y => <line key={y} x1="20" y1={y} x2="350" y2={y} className="grid-line"/>)}
      <defs><linearGradient id="traceArea" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#36c9bb" stopOpacity=".32"/><stop offset="100%" stopColor="#36c9bb" stopOpacity="0"/></linearGradient></defs>
      <path d={area} fill="url(#traceArea)"/>
      <path d={line} className="chart-line"/>
      {coords.map((p, i) => <g key={i}><circle cx={p.x} cy={p.y} r="3.5" className="chart-point"/><text x={p.x} y="153" textAnchor="middle" className="axis-label">{points[i].label}</text></g>)}
    </svg>
    <p className="chart-footnote">Daily activity · Last 7 days · Based on loaded traces</p>
  </div>;
}

function Distribution({ traces }: { traces: Trace[] }) {
  const success = traces.filter(t => t.status === "success").length;
  const failed = traces.filter(t => t.status === "error").length;
  const running = traces.filter(t => t.status === "running").length;
  const total = traces.length || 1;
  const items = [
    { label: "Successful", count: success, color: "success" },
    { label: "Failed", count: failed, color: "failed" },
    { label: "Running", count: running, color: "running" },
  ];
  return <div className="distribution">
    <div className="distribution-total"><strong>{traces.length}</strong><span>Total executions</span></div>
    <div className="distribution-bars">{items.map(item => <div key={item.label} className="distribution-row"><div className="distribution-label"><span><i className={item.color}/>{item.label}</span><b>{item.count}</b></div><div className="bar-track"><div className={`bar-fill ${item.color}`} style={{ width: `${item.count / total * 100}%` }}/></div></div>)}</div>
  </div>;
}

function App() {
  const [traces, setTraces] = useState<Trace[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [view, setView] = useState("overview");
  const [theme, setTheme] = useState(() => localStorage.getItem("tracelens-theme") || "light");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("tracelens-theme", theme);
  }, [theme]);

  const load = useCallback(async () => {
    try {
      const data = await fetchTraces();
      setTraces(data);
      setError("");
    } catch {
      setError("Unable to connect to TraceLens API. Check that your API server is running.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const openTrace = async (id: string) => {
    setSelected(id);
    setDetail(null);
    setDetailLoading(true);
    setView("detail");
    try {
      setDetail(await fetchDetail(id));
      setError("");
    } catch {
      setError("Unable to load trace details.");
    } finally {
      setDetailLoading(false);
    }
  };

  const filtered = traces.filter(trace => {
    const matchesSearch = `${trace.name} ${trace.id}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (filter === "all" || trace.status === filter);
  });

  const failed = traces.filter(t => t.status === "error").length;
  const successful = traces.filter(t => t.status === "success").length;
  const avg = traces.length ? traces.reduce((sum, t) => sum + Number(t.duration_ms || 0), 0) / traces.length : 0;
  const successRate = traces.length ? Math.round(successful / traces.length * 100) : 0;
  const pageTitle = view === "detail" ? "Trace inspection" : view === "traces" ? "Trace explorer" : "Overview";

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="activity"/></div><div><b>TraceLens</b><small>AGENT OBSERVABILITY</small></div></div>
      <div className="workspace"><div className="workspace-icon">T</div><div><b>TraceLens Local</b><small>Development project</small></div><Icon name="chevron"/></div>
      <div className="nav-label">WORKSPACE</div>
      <button className={`nav-item ${view === "overview" ? "active" : ""}`} onClick={() => setView("overview")}><Icon name="overview"/>Overview</button>
      <button className={`nav-item ${view === "traces" || view === "detail" ? "active" : ""}`} onClick={() => setView("traces")}><Icon name="traces"/>Traces<span className="nav-count">{traces.length}</span></button>
      <div className="nav-label nav-spaced">MONITORING</div>
      <button className="nav-item" onClick={() => setView("overview")}><Icon name="activity"/>Activity</button>
      <div className="sidebar-bottom">
        <div className="connection"><i/> API connected</div>
        <div className="user"><div className="avatar">R</div><div><b>Local Developer</b><small>Development workspace</small></div><span className="user-menu">···</span></div>
        <div className="sidebar-version">TRACELENS <span>v0.1.0 · LOCAL</span></div>
      </div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="breadcrumbs"><span>Workspace</span><span>/</span><b>{pageTitle}</b></div>
        <div className="top-actions"><span className="live-indicator"><i/> LIVE DATA</span><button className="theme-toggle" onClick={() => setTheme(theme === "light" ? "dark" : "light")} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}><Icon name={theme === "light" ? "moon" : "sun"}/><span>{theme === "light" ? "Dark mode" : "Light mode"}</span></button><button className="refresh-button" onClick={load}><Icon name="refresh"/> Refresh</button><div className="top-avatar">R</div></div>
      </header>

      <div className="content">
        {error && <div className="error-banner">{error}</div>}

        {view !== "detail" ? <>
          <section className="page-heading"><div><div className="eyebrow"><span/> AGENT OBSERVABILITY</div><h1>{view === "traces" ? "Trace explorer" : "Good morning, developer"}</h1><p>{view === "traces" ? "Search, filter and inspect every recorded execution." : "Here's what's happening across your AI agent executions."}</p></div><div className="heading-date">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div></section>

          <section className="metrics">
            <Metric label="Total executions" value={traces.length.toString()} note="Stored traces" icon="layers"/>
            <Metric label="Successful runs" value={successful.toString()} note={`${successRate}% success rate`} icon="check" tone="green"/>
            <Metric label="Failed executions" value={failed.toString()} note={failed ? "Require attention" : "No failures recorded"} icon="alert" tone="orange"/>
            <Metric label="Average latency" value={duration(avg)} note="Across loaded executions" icon="clock" tone="blue"/>
          </section>

          {view === "overview" && <section className="analytics-grid">
            <article className="panel activity-panel"><div className="panel-heading"><div><h2>Execution activity</h2><p>Trace volume over the past seven days</p></div><span className="panel-badge">LAST 7 DAYS</span></div><ActivityChart traces={traces}/></article>
            <article className="panel distribution-panel"><div className="panel-heading"><div><h2>Execution health</h2><p>Breakdown by current status</p></div><span className="panel-icon"><Icon name="activity"/></span></div><Distribution traces={traces}/></article>
          </section>}

          <section className="panel trace-panel">
            <div className="panel-heading"><div><h2>{view === "traces" ? "All traces" : "Recent executions"}</h2><p>Inspect individual agent runs and their recorded spans.</p></div><span className="record-count">{filtered.length} RECORDS</span></div>
            <div className="toolbar"><div className="search-box"><Icon name="search"/><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by trace name or ID..."/><kbd>⌘ K</kbd></div><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option><option value="success">Success</option><option value="error">Error</option><option value="running">Running</option></select></div>
            <div className="table-wrap"><table><thead><tr><th>EXECUTION</th><th>STATUS</th><th>DURATION</th><th>ENVIRONMENT</th><th>STARTED</th><th/></tr></thead><tbody>
              {loading ? <tr><td colSpan={6} className="empty">Loading traces...</td></tr> : filtered.length === 0 ? <tr><td colSpan={6} className="empty">No traces found. Run your example agent to generate one.</td></tr> : filtered.map(trace => <tr key={trace.id} onClick={() => openTrace(trace.id)} className="trace-row"><td><div className="trace-name"><span className="trace-symbol"><Icon name="bolt"/></span><div><b>{trace.name}</b><small>{trace.id.slice(0, 20)}...</small></div></div></td><td><Status value={trace.status}/></td><td className="duration-cell">{duration(trace.duration_ms)}</td><td><span className="env-tag">{String(trace.metadata?.environment ?? "—")}</span></td><td className="muted">{timeAgo(trace.started_at)}</td><td className="arrow"><Icon name="arrow"/></td></tr>)}
            </tbody></table></div>
            <div className="panel-footer"><span>Showing latest {traces.length} traces</span><span>Auto-refreshes every 10 seconds <i/></span></div>
          </section>
        </> : <section className="detail-page">
          <button className="back-button" onClick={() => setView("traces")}><Icon name="back"/> Back to traces</button>
          {detailLoading ? <div className="panel empty">Loading trace details...</div> : detail && <>
            <div className="detail-heading"><div><div className="eyebrow"><span/> TRACE INSPECTION</div><h1>{detail.trace.name}</h1><p className="trace-id">{detail.trace.id}</p></div><Status value={detail.trace.status}/></div>
            <div className="metrics detail-metrics"><Metric label="Total duration" value={duration(detail.trace.duration_ms)} note="End-to-end execution" icon="clock"/><Metric label="Total spans" value={detail.spans.length.toString()} note="Recorded operations" icon="layers"/><Metric label="Failed spans" value={detail.spans.filter(s => s.status === "error").length.toString()} note="Errors captured" icon="alert" tone="orange"/></div>
            <div className="panel"><div className="panel-heading"><div><h2>Execution timeline</h2><p>Agent operations and recorded spans</p></div><span className="record-count">{detail.spans.length} SPANS</span></div><div className="timeline">
              {detail.spans.map(span => <div className="timeline-item" key={span.id}><div className={`timeline-marker ${span.status}`}><Icon name={span.type === "agent" ? "activity" : span.type === "tool" ? "bolt" : "layers"}/></div><div className="timeline-content"><button className="span-card" onClick={() => setExpanded(expanded === span.id ? null : span.id)}><div className="span-main"><div className="span-title"><b>{span.name}</b><span className={`type-tag ${span.type}`}>{span.type}</span></div><small>{span.id.slice(0, 20)}...</small></div><div className="span-right"><Status value={span.status}/><b>{duration(span.duration_ms)}</b><Icon name="chevron"/></div></button>
                {expanded === span.id && <div className="span-expanded">{span.input != null && <CodePanel title="INPUT" value={span.input}/ >}{span.output != null && <CodePanel title="OUTPUT" value={span.output}/ >}{span.error && <div className="error-detail"><div className="code-label">ERROR · {span.error.name}</div><p>{span.error.message}</p>{span.error.stack && <pre>{span.error.stack}</pre>}</div>}</div>}
              </div></div>)}
              {detail.spans.length === 0 && <p className="empty">No spans recorded.</p>}
            </div></div>
            <div className="panel metadata-panel"><div className="panel-heading"><div><h2>Trace metadata</h2><p>Execution context and attributes</p></div></div><pre>{JSON.stringify(detail.trace.metadata, null, 2)}</pre></div>
          </>}
        </section>}
        <footer>TraceLens <span>·</span> AI agent observability <span>·</span> Built for reliable agents</footer>
      </div>
    </main>
  </div>;
}

function CodePanel({ title, value }: { title: string; value: unknown }) {
  return <div className="code-panel"><div className="code-label">{title}</div><pre>{JSON.stringify(value, null, 2)}</pre></div>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
