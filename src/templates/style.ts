/** 莫奈现代风格 — 柔和自然色调 */
export const STYLE = `
:root {
  --bg:        #f5f3ef;
  --card:      #fafaf8;
  --text:      #3d3a35;
  --text2:     #8c8880;
  --accent:    #7d8c7d;
  --accent-hv: #6b7a6b;
  --warm:      #c4a882;
  --warm-hv:   #b0956e;
  --danger:    #c0392b;
  --border:    #e8e4df;
  --border-focus: #b8b0a4;
  --radius:    6px;
}

*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

.container {
  max-width: 460px;
  margin: 0 auto;
  padding: 40px 16px 64px;
}

.card {
  background: var(--card);
  border-radius: var(--radius);
  padding: 28px 24px;
  border: 1px solid var(--border);
}

/* ---- header ---- */
.header {
  text-align: center;
  margin-bottom: 28px;
  padding-top: 8px;
}
.header h1 {
  font-size: 22px;
  font-weight: 500;
  color: var(--accent);
  letter-spacing: -0.3px;
}
.header p {
  font-size: 13px;
  color: var(--text2);
  margin-top: 4px;
}

/* ---- nav ---- */
.nav {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-bottom: 20px;
}
.nav a {
  font-size: 13px;
  color: var(--text2);
  text-decoration: none;
  padding: 6px 12px;
  border-radius: var(--radius);
  transition: background 0.15s;
}
.nav a:hover {
  background: var(--border);
  color: var(--text);
}

/* ---- buttons ---- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 18px;
  border: none;
  border-radius: var(--radius);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  text-decoration: none;
  line-height: 1;
}

.btn-primary {
  background: var(--accent);
  color: #fff;
  width: 100%;
}
.btn-primary:hover { background: var(--accent-hv); }
.btn-primary:active { background: var(--accent-hv); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-secondary {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  width: 100%;
}
.btn-secondary:hover { background: var(--border); }

.btn-warm {
  background: var(--warm);
  color: #fff;
  width: 100%;
}
.btn-warm:hover { background: var(--warm-hv); }

.btn-sm {
  padding: 6px 14px;
  font-size: 13px;
  width: auto;
}

.btn-danger {
  color: var(--danger);
  font-size: 13px;
  text-decoration: none;
  padding: 4px 8px;
  border-radius: var(--radius);
}
.btn-danger:hover { background: #fdf0ef; }

/* ---- inputs ---- */
.input {
  width: 100%;
  padding: 9px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 15px;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s;
  background: #fff;
  color: var(--text);
}
.input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 2px rgba(125,140,125,0.12);
}

.input-group {
  margin-bottom: 14px;
}
.input-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text2);
  margin-bottom: 5px;
}

/* ---- dividers ---- */
.section-divider {
  height: 1px;
  background: var(--border);
  margin: 24px 0;
}

/* ---- code display ---- */
.code-box {
  text-align: center;
  padding: 16px 0;
}
.code-display {
  font-size: 44px;
  font-weight: 500;
  letter-spacing: 10px;
  color: var(--text);
  font-family: "SF Mono", "JetBrains Mono", "Courier New", monospace;
  background: #f0ede8;
  display: inline-block;
  padding: 8px 24px;
  border-radius: var(--radius);
  margin: 12px 0;
}
.copy-text-btn {
  cursor: pointer;
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  background: none;
  border: none;
  padding: 4px 8px;
  border-radius: var(--radius);
  transition: background 0.15s;
}
.copy-text-btn:hover { background: #eae7e1; }

/* ---- info tags ---- */
.info-row {
  display: flex;
  justify-content: center;
  gap: 16px;
  font-size: 13px;
  color: var(--text2);
  margin: 12px 0;
  flex-wrap: wrap;
}
.info-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  background: var(--bg);
  border-radius: 20px;
  font-size: 12px;
  border: 1px solid var(--border);
}

/* ---- file icon ---- */
.file-icon {
  width: 56px;
  height: 56px;
  background: var(--accent);
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
}

/* ---- file list ---- */
.file-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg);
  border-radius: var(--radius);
  margin-bottom: 6px;
  transition: background 0.15s;
  gap: 8px;
}
.file-list-item:hover { background: var(--border); }
.file-list-item .fname {
  font-size: 13px;
  font-weight: 500;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-list-item .fmeta {
  font-size: 12px;
  color: var(--text2);
  white-space: nowrap;
}
.expired { opacity: 0.4; }

/* ---- badges ---- */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
}
.badge-danger { background: #fdf0ef; color: var(--danger); }
.badge-success { background: #edf2ed; color: var(--accent); }

/* ---- stats ---- */
.stats-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}
.stats-row .btn { flex: 1; }

/* ---- responsive ---- */
@media (max-width: 420px) {
  .container { padding: 24px 12px 48px; }
  .card { padding: 20px 16px; }
  .code-display { font-size: 36px; letter-spacing: 8px; }
}
`;
