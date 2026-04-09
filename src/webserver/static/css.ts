import { NOTIFICATION_CSS } from "../../notifications/client-css.ts";

const BASE_CSS: string = `
/* ===== Reset & Base ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
	--bg: #0a0a0f;
	--bg-card: rgba(255,255,255,0.04);
	--bg-card-hover: rgba(255,255,255,0.07);
	--border: rgba(255,255,255,0.08);
	--border-bright: rgba(255,255,255,0.15);
	--text: #e2e8f0;
	--text-secondary: #94a3b8;
	--text-muted: #64748b;

	--blue: #60a5fa;
	--green: #34d399;
	--amber: #fbbf24;
	--red: #f87171;
	--purple: #a78bfa;
	--cyan: #22d3ee;

	--blue-bg: rgba(96,165,250,0.12);
	--green-bg: rgba(52,211,153,0.12);
	--amber-bg: rgba(251,191,36,0.12);
	--red-bg: rgba(248,113,113,0.12);
	--purple-bg: rgba(167,139,250,0.12);
	--cyan-bg: rgba(34,211,238,0.12);
	--muted-bg: rgba(148,163,184,0.10);

	--font: "SF Mono","Cascadia Code","JetBrains Mono","Fira Code",Consolas,monospace;
	--radius: 8px;
	--radius-sm: 4px;
}

html, body {
	background: var(--bg);
	color: var(--text);
	font-family: var(--font);
	font-size: 13px;
	line-height: 1.6;
	min-height: 100vh;
}

a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }

/* ===== Layout ===== */
header, .header {
	padding: 16px 24px;
	border-bottom: 1px solid var(--border);
	display: flex;
	align-items: center;
	gap: 24px;
}

header h1 {
	font-size: 16px;
	font-weight: 600;
	color: var(--text);
	white-space: nowrap;
}

main {
	padding: 24px;
	max-width: 1200px;
	margin: 0 auto;
}

/* ===== Nav ===== */
nav, .nav {
	display: flex;
	flex-direction: row;
	gap: 4px;
	align-items: center;
}

.nav-item {
	display: inline-block;
	padding: 6px 12px;
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	transition: background 0.15s, color 0.15s;
}

.nav-item:hover {
	background: var(--bg-card-hover);
	color: var(--text);
	text-decoration: none;
}

.nav-active {
	color: var(--blue);
	background: var(--blue-bg);
}

/* ===== Card ===== */
.card {
	background: var(--bg-card);
	-webkit-backdrop-filter: blur(12px);
	backdrop-filter: blur(12px);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 20px;
}

.card:hover {
	border-color: var(--border-bright);
}

/* ===== Grid ===== */
.grid {
	display: grid;
	gap: 16px;
}

.grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
.grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }

@media (max-width: 900px) {
	.grid-3 { grid-template-columns: repeat(2, 1fr); }
	.grid-4 { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 600px) {
	.grid-2, .grid-3, .grid-4 { grid-template-columns: 1fr; }
}

/* ===== Table ===== */
.table {
	width: 100%;
	border-collapse: collapse;
}

.table th {
	text-transform: uppercase;
	font-size: 11px;
	letter-spacing: 0.06em;
	color: var(--text-secondary);
	padding: 8px 12px;
	text-align: left;
	border-bottom: 1px solid var(--border);
	font-weight: 600;
}

.table td {
	padding: 10px 12px;
	border-bottom: 1px solid var(--border);
	color: var(--text);
}

.table tr:nth-child(even) td {
	background: rgba(255,255,255,0.02);
}

.table tr:hover td {
	background: rgba(255,255,255,0.05);
}

/* ===== Badge ===== */
.badge {
	display: inline-block;
	border-radius: 999px;
	padding: 2px 8px;
	font-size: 11px;
	font-weight: 600;
	text-transform: uppercase;
	letter-spacing: 0.04em;
	line-height: 1.4;
}

.badge-active, .badge-running {
	color: var(--green);
	background: var(--green-bg);
}

.badge-completed, .badge-done {
	color: var(--blue);
	background: var(--blue-bg);
}

.badge-stalled, .badge-warning {
	color: var(--amber);
	background: var(--amber-bg);
}

.badge-error, .badge-failed, .badge-zombie {
	color: var(--red);
	background: var(--red-bg);
}

.badge-pending, .badge-queued {
	color: var(--text-muted);
	background: var(--muted-bg);
}

.badge-frozen {
	color: var(--cyan);
	background: var(--cyan-bg);
}

.badge-rate_limited {
	color: var(--purple);
	background: var(--purple-bg);
}

/* ===== Status Dot ===== */
.status-dot {
	display: inline-block;
	width: 8px;
	height: 8px;
	border-radius: 50%;
	flex-shrink: 0;
}

.status-active, .status-running {
	background: var(--green);
	box-shadow: 0 0 6px var(--green);
}

.status-completed, .status-done {
	background: var(--blue);
	box-shadow: 0 0 6px var(--blue);
}

.status-stalled, .status-warning {
	background: var(--amber);
	box-shadow: 0 0 6px var(--amber);
}

.status-error, .status-failed, .status-zombie {
	background: var(--red);
	box-shadow: 0 0 6px var(--red);
}

.status-pending, .status-queued {
	background: var(--text-muted);
}

.status-frozen {
	background: var(--cyan);
	box-shadow: 0 0 6px var(--cyan);
}

.status-rate_limited {
	background: var(--purple);
	box-shadow: 0 0 6px var(--purple);
}

/* ===== Metric ===== */
.metric {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.metric-value {
	font-size: 24px;
	font-weight: 700;
	line-height: 1.2;
}

.metric-label {
	font-size: 11px;
	text-transform: uppercase;
	letter-spacing: 0.06em;
	color: var(--text-secondary);
}

.metric-subtitle {
	font-size: 10px;
	color: var(--text-muted);
	margin-top: 2px;
}

/* ===== Code ===== */
.code {
	font-family: var(--font);
	font-size: 11px;
	background: rgba(34,211,238,0.06);
	color: var(--cyan);
	padding: 2px 6px;
	border-radius: var(--radius-sm);
	border: 1px solid rgba(34,211,238,0.15);
}

/* ===== Timestamp ===== */
.timestamp {
	color: var(--text-muted);
	font-size: 11px;
}

/* ===== Empty State ===== */
.empty-state {
	text-align: center;
	color: var(--text-muted);
	padding: 48px 24px;
}

/* ===== Copy Button ===== */
.copy-btn {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	background: var(--muted-bg);
	border: 1px solid var(--border);
	border-radius: var(--radius-sm);
	color: var(--text-secondary);
	cursor: pointer;
	font-family: var(--font);
	font-size: 11px;
	transition: background 0.15s, color 0.15s;
}

.copy-btn:hover {
	background: var(--bg-card-hover);
	color: var(--text);
}

/* ===== Sections & Headings ===== */
section {
	margin-top: 24px;
}

section h2 {
	font-size: 14px;
	font-weight: 600;
	color: var(--text);
	text-transform: uppercase;
	letter-spacing: 0.05em;
	margin-bottom: 12px;
	padding-bottom: 8px;
	border-bottom: 1px solid var(--border);
}

/* ===== Metrics Row ===== */
.metrics-row {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
	gap: 16px;
}

.metrics-row .metric {
	background: var(--bg-card);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 16px;
}

/* ===== Project Cards (Home) ===== */
.project-list {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
	gap: 16px;
}

.project-card {
	background: var(--bg-card);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 20px;
	transition: border-color 0.15s, background 0.15s;
}

.project-card:hover {
	border-color: var(--border-bright);
	background: var(--bg-card-hover);
}

.project-card h2 {
	font-size: 15px;
	font-weight: 600;
	margin-bottom: 12px;
}

.project-card h2 a {
	color: var(--blue);
}

.project-card h2 a:hover {
	text-decoration: underline;
}

.project-card dl {
	display: grid;
	grid-template-columns: 80px 1fr;
	gap: 4px 12px;
	font-size: 12px;
}

.project-card dt {
	color: var(--text-muted);
	text-transform: uppercase;
	font-size: 10px;
	letter-spacing: 0.05em;
}

.project-card dd {
	color: var(--text-secondary);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
`;

export const CSS: string = `${BASE_CSS}\n${NOTIFICATION_CSS}`;
