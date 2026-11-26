// FocusGuard API — self-hosted server (HW SH).
//
// Runs the Cloudflare Worker bundle (backend/src/index.ts, esbuild output
// index.js) on Node 24 + node:sqlite, with a minimal D1-compatible wrapper
// for env.DB. No npm dependencies: node:sqlite is built into Node 24.
//
//   PORT=18080 DB_PATH=/opt/fcm/focusguard.db node server.mjs
// The Worker code only uses env.DB.prepare().bind().first()/all()/run()
// and env.DB.batch([...]); those are the only methods implemented here.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import worker from "./index.js";

const PORT = Number(process.env.PORT || 18080);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || "./focusguard.db";

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const cleanParams = (params) => params.map((p) => (p === undefined ? null : p));

class BoundStatement {
  constructor(sql, params) {
    this.sql = sql;
    this.params = cleanParams(params);
  }
  async first() {
    const row = db.prepare(this.sql).get(...this.params);
    return row === undefined ? null : row;
  }
  async all() {
    return { results: db.prepare(this.sql).all(...this.params), success: true, meta: {} };
  }
  async run() {
    const info = db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 },
    };
  }
}

function execOne(s) {
  const st = db.prepare(s.sql);
  // Statements that return rows: SELECTs and anything with RETURNING.
  if (/^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(s.sql) || /\bRETURNING\b/i.test(s.sql)) {
    return { results: st.all(...s.params), success: true, meta: {} };
  }
  const info = st.run(...s.params);
  return {
    results: [],
    success: true,
    meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
  };
}

const D1 = {
  prepare(sql) {
    return { bind: (...params) => new BoundStatement(sql, params) };
  },
  // D1 batch is atomic; mirror that with an explicit transaction.
  async batch(statements) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = statements.map(execOne);
      db.exec("COMMIT");
      return out;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  },
};

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = `http://${req.headers.host || "localhost"}${req.url}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
      duplex: "half",
    });
    const response = await worker.fetch(request, { DB: D1, PRIMARY_USER_ID: process.env.PRIMARY_USER_ID });
    const buf = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(buf);
    console.log(`${req.method} ${req.url} -> ${response.status} ${Date.now() - started}ms`);
  } catch (e) {
    console.error("request failed:", e);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "internal_error", message: "Request could not be completed" } }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`focusguard-api listening on ${HOST}:${PORT} db=${DB_PATH}`);
});

process.on("SIGTERM", () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
});
