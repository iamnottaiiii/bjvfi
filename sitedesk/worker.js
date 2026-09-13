// ════════════════════════════════════════════════════════════════════════════
//  SiteDesk — Cloudflare Worker (Turso edition — NO D1, NO R2)
//  ───────────────────────────────────────────────────────────────────────────
//  This is your original sitedesk.js with three patches prepended:
//
//   1. LIVE GITHUB CATALOG — every fetch(.../sites.json) is redirected to
//      https://raw.githubusercontent.com/iamnottaiiii/bjvfi/main/sites.json
//      so leads always come from your GitHub repo in real time, regardless
//      of what SITE_ORIGIN is set to.
//
//   2. TURSO INSTEAD OF D1 — a small HTTP shim provides c.env.DB with the
//      exact D1 API (prepare().bind().first()/.all()/.run() + .batch()),
//      backed by Turso (libSQL) over HTTPS. NO D1 binding required.
//      All 12 tables + an `assets` table are AUTO-CREATED on first request.
//
//   3. TURSO BLOB STORAGE INSTEAD OF R2 — c.env.ASSETS is provided with an
//      R2-compatible API (put/get/delete) backed by the Turso `assets` table.
//      NO R2 bucket required.
//
//  The worker's default export is wrapped so env.DB / env.ASSETS are
//  auto-injected per request IF (and only if) no native D1/R2 binding exists
//  (so this same file also runs fine on a real D1/R2 setup).
//
//  TURSO URL is BAKED IN below (https://sitedesk-notai.aws-ap-northeast-1.turso.io).
//  You only need to set ONE env var/secret: TURSO_TOKEN (from `turso db tokens create sitedesk`).
//  ───────────────────────────────────────────────────────────────────────────

;(function liveGitHubCatalogPatch() {
  var GITHUB_RAW =
    "https://raw.githubusercontent.com/iamnottaiiii/bjvfi/main/sites.json";
  if (typeof globalThis.fetch !== "function") return;
  var origFetch = globalThis.fetch;
  globalThis.fetch = function patchFetch(input, init) {
    try {
      var url =
        typeof input === "string"
          ? input
          : input && input.url
          ? input.url
          : String(input);
      if (typeof url === "string" && /\/sites\.json(\?.*)?$/.test(url)) {
        return origFetch.call(this, GITHUB_RAW, init);
      }
    } catch (e) {}
    return origFetch.call(this, input, init);
  };
})();

// ── Turso HTTP pipeline client + D1-compatible shim ─────────────────────────
var TURSO_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS users (\n  id                 TEXT PRIMARY KEY,\n  email              TEXT NOT NULL UNIQUE,\n  name               TEXT NOT NULL,\n  phone              TEXT,\n  password_hash      TEXT NOT NULL,\n  role               TEXT NOT NULL DEFAULT 'caller',\n  status             TEXT NOT NULL DEFAULT 'pending',\n  phone_confirmed    INTEGER NOT NULL DEFAULT 0,\n  email_confirmed    INTEGER NOT NULL DEFAULT 0,\n  phone_confirmed_at TEXT,\n  email_confirmed_at TEXT,\n  admin_notes        TEXT,\n  payout_method      TEXT,\n  payout_details     TEXT,\n  created_at         TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, status);",
  "CREATE INDEX IF NOT EXISTS idx_users_status      ON users(status);",
  "CREATE TABLE IF NOT EXISTS sessions (\n  token      TEXT PRIMARY KEY,\n  user_id    TEXT NOT NULL,\n  expires_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);",
  "CREATE TABLE IF NOT EXISTS leads (\n  id                TEXT PRIMARY KEY,\n  slug              TEXT NOT NULL,\n  business_name     TEXT NOT NULL,\n  phone             TEXT,\n  category          TEXT,\n  address           TEXT,\n  site_url          TEXT,\n  status            TEXT NOT NULL DEFAULT 'open',\n  claimed_by        TEXT,\n  claimed_at        TEXT,\n  claim_expires_at  TEXT,\n  last_outcome      TEXT,\n  last_note         TEXT,\n  business_email    TEXT,\n  updated_at        TEXT NOT NULL,\n  created_at        TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);",
  "CREATE INDEX IF NOT EXISTS idx_leads_claimed_by ON leads(claimed_by);",
  "CREATE INDEX IF NOT EXISTS idx_leads_slug       ON leads(slug);",
  "CREATE INDEX IF NOT EXISTS idx_leads_category   ON leads(category);",
  "CREATE TABLE IF NOT EXISTS lead_events (\n  id         TEXT PRIMARY KEY,\n  lead_id    TEXT NOT NULL,\n  user_id    TEXT,\n  kind       TEXT NOT NULL,\n  note       TEXT,\n  created_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id   ON lead_events(lead_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_events_user_id   ON lead_events(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_events_kind      ON lead_events(kind);",
  "CREATE INDEX IF NOT EXISTS idx_lead_events_created   ON lead_events(created_at);",
  "CREATE TABLE IF NOT EXISTS intakes (\n  id              TEXT PRIMARY KEY,\n  lead_id         TEXT NOT NULL,\n  user_id         TEXT NOT NULL,\n  wants           TEXT NOT NULL,\n  brand_colors    TEXT NOT NULL,\n  logo_images     TEXT NOT NULL,\n  design_style    TEXT NOT NULL,\n  contact_confirm TEXT NOT NULL,\n  business_email  TEXT,\n  extras          TEXT,\n  status          TEXT NOT NULL DEFAULT 'submitted',\n  payout_status   TEXT,\n  assigned_to     TEXT,\n  created_at      TEXT NOT NULL,\n  updated_at      TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_intakes_lead_id      ON intakes(lead_id);",
  "CREATE INDEX IF NOT EXISTS idx_intakes_user_id      ON intakes(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_intakes_assigned_to  ON intakes(assigned_to);",
  "CREATE INDEX IF NOT EXISTS idx_intakes_status       ON intakes(status);",
  "CREATE INDEX IF NOT EXISTS idx_intakes_payout_status ON intakes(payout_status);",
  "CREATE TABLE IF NOT EXISTS intake_messages (\n  id         TEXT PRIMARY KEY,\n  intake_id  TEXT NOT NULL,\n  user_id    TEXT NOT NULL,\n  body       TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_intake_messages_intake_id ON intake_messages(intake_id);",
  "CREATE INDEX IF NOT EXISTS idx_intake_messages_user_id   ON intake_messages(user_id);",
  "CREATE TABLE IF NOT EXISTS lead_reports (\n  id          TEXT PRIMARY KEY,\n  lead_id     TEXT NOT NULL,\n  user_id     TEXT NOT NULL,\n  reason      TEXT NOT NULL,\n  note        TEXT,\n  status      TEXT NOT NULL DEFAULT 'open',\n  resolved_at TEXT,\n  resolved_by TEXT,\n  created_at  TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_lead_reports_lead_id ON lead_reports(lead_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_reports_user_id ON lead_reports(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_lead_reports_status  ON lead_reports(status);",
  "CREATE TABLE IF NOT EXISTS draft_templates (\n  id         TEXT PRIMARY KEY,\n  kind       TEXT NOT NULL,\n  category   TEXT,\n  body       TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  updated_by TEXT\n);",
  "CREATE INDEX IF NOT EXISTS idx_draft_templates_kind_category ON draft_templates(kind, category);",
  "CREATE TABLE IF NOT EXISTS notifications (\n  id         TEXT PRIMARY KEY,\n  user_id    TEXT NOT NULL,\n  title      TEXT NOT NULL,\n  body       TEXT,\n  link       TEXT,\n  read_at    TEXT,\n  created_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_notifications_read_at ON notifications(read_at);",
  "CREATE TABLE IF NOT EXISTS push_subscriptions (\n  endpoint   TEXT PRIMARY KEY,\n  p256dh     TEXT NOT NULL,\n  auth       TEXT NOT NULL,\n  user_id    TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);",
  "CREATE TABLE IF NOT EXISTS verification_codes (\n  id         TEXT PRIMARY KEY,\n  user_id    TEXT NOT NULL,\n  channel    TEXT NOT NULL,\n  code_hash  TEXT NOT NULL,\n  expires_at TEXT NOT NULL,\n  attempts   INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL\n);",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_verification_codes_user_channel ON verification_codes(user_id, channel);",
  "CREATE TABLE IF NOT EXISTS payouts (\n  id         TEXT PRIMARY KEY,\n  user_id    TEXT NOT NULL,\n  intake_id  TEXT NOT NULL,\n  amount     REAL NOT NULL DEFAULT 0,\n  status     TEXT NOT NULL DEFAULT 'owed',\n  paid_at    TEXT,\n  paid_by    TEXT,\n  created_at TEXT NOT NULL\n);",
  "CREATE INDEX IF NOT EXISTS idx_payouts_user_id   ON payouts(user_id);",
  "CREATE INDEX IF NOT EXISTS idx_payouts_intake_id ON payouts(intake_id);",
  "CREATE INDEX IF NOT EXISTS idx_payouts_status    ON payouts(status);",
  "CREATE TABLE IF NOT EXISTS assets (key TEXT PRIMARY KEY, content_type TEXT, data BLOB, uploaded_by TEXT, created_at TEXT NOT NULL)"
];

function tursoArg(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: v }
      : { type: "float", value: v };
  }
  if (typeof v === "boolean") return { type: "integer", value: v ? 1 : 0 };
  if (v instanceof ArrayBuffer) {
    var bytes = new Uint8Array(v);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { type: "blob", base64: btoa(s) };
  }
  if (v && v instanceof Uint8Array) {
    var s2 = "";
    for (var i = 0; i < v.length; i++) s2 += String.fromCharCode(v[i]);
    return { type: "blob", base64: btoa(s2) };
  }
  return { type: "text", value: String(v) };
}

function tursoValue(cell) {
  if (!cell || cell.type === "null") return null;
  if (cell.type === "blob") {
    var bin = atob(cell.base64 || "");
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return cell.value;
}

async function tursoPipeline(url, token, statements) {
  var body = {
    requests: statements.map(function (s) {
      return {
        type: "execute",
        stmt: {
          sql: s.sql,
          args: (s.args || []).map(tursoArg),
          want_rows: s.want_rows !== false,
        },
      };
    }),
  };
  var res = await fetch(url + "/v3/pipeline", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    var txt = await res.text().catch(function () { return ""; });
    throw new Error("Turso HTTP " + res.status + ": " + txt.slice(0, 300));
  }
  var data = await res.json();
  if (!data.results || !Array.isArray(data.results)) {
    throw new Error("Turso: malformed response (no results array)");
  }
  return data.results.map(function (r) {
    if (r.type === "error") {
      return { error: (r.error && r.error.message) || "Turso execute error" };
    }
    var result = (r.response && r.response.result) || {};
    var cols = (result.cols || []).map(function (c) { return c.name; });
    var rows = (result.rows || []).map(function (row) {
      var obj = {};
      for (var i = 0; i < cols.length; i++) {
        obj[cols[i]] = tursoValue(row[i]);
      }
      return obj;
    });
    return {
      rows: rows,
      cols: cols,
      changes: result.affected_row_count != null ? result.affected_row_count : (result.changes || 0),
      lastInsertRowid: result.last_insert_rowid != null ? result.last_insert_rowid : null,
    };
  });
}

function TursoStatement(url, token, sql, args) {
  this._url = url; this._token = token; this.sql = sql; this.args = args || [];
}
TursoStatement.prototype.bind = function () {
  var a = Array.prototype.slice.call(arguments);
  return new TursoStatement(this._url, this._token, this.sql, a);
};
TursoStatement.prototype.first = async function () {
  var r = (await tursoPipeline(this._url, this._token, [
    { sql: this.sql, args: this.args, want_rows: true },
  ]))[0];
  if (r.error) throw new Error(r.error);
  return r.rows[0] || null;
};
TursoStatement.prototype.all = async function () {
  var r = (await tursoPipeline(this._url, this._token, [
    { sql: this.sql, args: this.args, want_rows: true },
  ]))[0];
  if (r.error) throw new Error(r.error);
  return { results: r.rows, success: true, meta: { changes: r.changes } };
};
TursoStatement.prototype.run = async function () {
  var r = (await tursoPipeline(this._url, this._token, [
    { sql: this.sql, args: this.args, want_rows: false },
  ]))[0];
  if (r.error) throw new Error(r.error);
  return {
    success: true,
    meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid },
  };
};

function TursoDB(url, token) { this._url = url; this._token = token; }
TursoDB.prototype.prepare = function (sql) {
  return new TursoStatement(this._url, this._token, sql, []);
};
TursoDB.prototype.batch = async function (stmts) {
  var reqs = stmts.map(function (s) {
    return { sql: s.sql, args: s.args, want_rows: false };
  });
  var results = await tursoPipeline(this._url, this._token, reqs);
  return results.map(function (r) {
    return r.error
      ? { success: false, meta: { changes: 0 } }
      : {
          success: true,
          meta: { changes: r.changes, lastInsertRowid: r.lastInsertRowid },
        };
  });
};

// ── ASSETS shim: Turso BLOB storage (replaces R2) ───────────────────────────
function TursoAssets(url, token) { this._url = url; this._token = token; }
TursoAssets.prototype.put = async function (key, body, opts) {
  var buf;
  if (body instanceof ArrayBuffer) buf = new Uint8Array(body);
  else if (body instanceof Uint8Array) buf = body;
  else if (body && typeof body.arrayBuffer === "function")
    buf = new Uint8Array(await body.arrayBuffer());
  else buf = new TextEncoder().encode(String(body));
  var ct =
    (opts && opts.httpMetadata && opts.httpMetadata.contentType) ||
    "application/octet-stream";
  var by = (opts && opts.customMetadata && opts.customMetadata.uploaded_by) || null;
  var now = new Date().toISOString();
  await tursoPipeline(this._url, this._token, [
    {
      sql:
        "INSERT INTO assets (key, content_type, data, uploaded_by, created_at) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET " +
        "content_type=excluded.content_type, data=excluded.data, uploaded_by=excluded.uploaded_by",
      args: [key, ct, buf, by, now],
      want_rows: false,
    },
  ]);
};
TursoAssets.prototype.get = async function (key) {
  var r = (await tursoPipeline(this._url, this._token, [
    { sql: "SELECT data, content_type FROM assets WHERE key=?", args: [key], want_rows: true },
  ]))[0];
  if (r.error || !r.rows[0]) return null;
  var row = r.rows[0];
  var data = row.data || new Uint8Array(0);
  var ct = row.content_type || "application/octet-stream";
  return {
    body: new Response(data, { headers: { "Content-Type": ct } }).body,
    httpEtag: '"asset-' + (data ? data.length : 0) + '"',
    writeHttpMetadata: function (headers) { headers.set("Content-Type", ct); },
    size: data ? data.length : 0,
  };
};
TursoAssets.prototype.delete = async function (key) {
  await tursoPipeline(this._url, this._token, [
    { sql: "DELETE FROM assets WHERE key=?", args: [key], want_rows: false },
  ]);
};

// ── Schema init (idempotent; runs once per isolate, then never again) ───────
var _tursoSchemaReady = false;
function isAuthError(e) {
  var m = String((e && e.message) || e || "").toLowerCase();
  // Turso/SQLite reports bad tokens as "JWT error: InvalidToken" (HTTP 400),
  // or "Unauthorized" (HTTP 401). Catch both phrasings.
  return (
    m.indexOf("unauthorized") !== -1 ||
    m.indexOf("401") !== -1 ||
    m.indexOf("jwt") !== -1 ||
    m.indexOf("invalidtoken") !== -1 ||
    m.indexOf("invalid token") !== -1 ||
    (m.indexOf("auth") !== -1 && m.indexOf("table") === -1)
  );
}
function isAlreadyExistsError(e) {
  var m = String((e && e.message) || e || "").toLowerCase();
  return m.indexOf("already exists") !== -1 || m.indexOf("duplicate") !== -1;
}
async function ensureTursoSchema(url, token) {
  if (_tursoSchemaReady) return;
  var reqs = TURSO_SCHEMA_STATEMENTS.map(function (sql) {
    return { sql: sql, args: [], want_rows: false };
  });
  // Try the whole schema in one batch first (fast path).
  try {
    await tursoPipeline(url, token, reqs);
    _tursoSchemaReady = true;
    return;
  } catch (e) {
    // Auth errors must surface — the user has a bad/missing token.
    if (isAuthError(e)) {
      throw new Error(
        "Turso auth failed (check TURSO_TOKEN): " + (e && e.message || e)
      );
    }
    // Otherwise fall back to one-at-a-time so a single failing statement
    // (e.g. an index that already exists) doesn't block the rest.
  }
  for (var i = 0; i < reqs.length; i++) {
    try {
      await tursoPipeline(url, token, [reqs[i]]);
    } catch (e2) {
      if (isAuthError(e2)) {
        throw new Error(
          "Turso auth failed (check TURSO_TOKEN): " + (e2 && e2.message || e2)
        );
      }
      // "already exists" is fine (idempotent); other errors we log but continue.
      if (!isAlreadyExistsError(e2)) {
        console.error("Turso schema stmt failed (continuing):", (e2 && e2.message) || e2);
      }
    }
  }
  _tursoSchemaReady = true;
}

// ── Baked-in Turso URL (your database) ─────────────────────────────────────
var TURSO_DEFAULT_URL = "https://sitedesk-notai.aws-ap-northeast-1.turso.io";

// ── Per-request env injection (called by the wrapped default export) ───────
async function ensureTursoEnv(env) {
  var url = env.TURSO_URL || TURSO_DEFAULT_URL;
  var token = env.TURSO_TOKEN;
  if (!token) {
    throw new Error(
      "TURSO_TOKEN not set. Run: turso db tokens create sitedesk  then " +
      "npx wrangler secret put TURSO_TOKEN  (paste the token). " +
      "The Turso URL is already baked in: " + url
    );
  }
  await ensureTursoSchema(url, token);
  if (!env.DB) env.DB = new TursoDB(url, token);
  if (!env.ASSETS) env.ASSETS = new TursoAssets(url, token);
}

// ════════════════════════════════════════════════════════════════════════════
//  Below: your original bundled worker.js — UNCHANGED except the final
//  default export is wrapped so env.DB / env.ASSETS get auto-injected.
//  (If you later add real D1/R2 bindings, those take precedence and the
//  Turso shim becomes a no-op.)
// ════════════════════════════════════════════════════════════════════════════

var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/hono/dist/compose.js
var compose = /* @__PURE__ */ __name((middleware, onError, onNotFound) => {
  return (context, next) => {
    let index = -1;
    return dispatch(0);
    async function dispatch(i) {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;
      let res;
      let isError = false;
      let handler;
      if (middleware[i]) {
        handler = middleware[i][0][0];
        context.req.routeIndex = i;
      } else {
        handler = i === middleware.length && next || void 0;
      }
      if (handler) {
        try {
          res = await handler(context, () => dispatch(i + 1));
        } catch (err) {
          if (err instanceof Error && onError) {
            context.error = err;
            res = await onError(err, context);
            isError = true;
          } else {
            throw err;
          }
        }
      } else {
        if (context.finalized === false && onNotFound) {
          res = await onNotFound(context);
        }
      }
      if (res && (context.finalized === false || isError)) {
        context.res = res;
      }
      return context;
    }
    __name(dispatch, "dispatch");
  };
}, "compose");

// node_modules/hono/dist/request/constants.js
var GET_MATCH_RESULT = /* @__PURE__ */ Symbol();

// node_modules/hono/dist/utils/buffer.js
var bufferToFormData = /* @__PURE__ */ __name((arrayBuffer, contentType) => {
  const response = new Response(arrayBuffer, {
    headers: {
      // Normalize the media type (case-insensitive) while keeping parameters like the boundary
      "Content-Type": contentType.replace(/^[^;]+/, (mediaType) => mediaType.toLowerCase())
    }
  });
  return response.formData();
}, "bufferToFormData");

// node_modules/hono/dist/utils/body.js
var MAX_NESTING_DEPTH = 32;
var MAX_NESTED_OBJECTS = 1e4;
var isRawRequest = /* @__PURE__ */ __name((request) => "headers" in request, "isRawRequest");
var parseBody = /* @__PURE__ */ __name(async (request, options = /* @__PURE__ */ Object.create(null)) => {
  const { all = false, dot = false } = options;
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const contentType = headers.get("Content-Type");
  const mediaType = contentType?.split(";")[0].trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return parseFormData(request, { all, dot });
  }
  return {};
}, "parseBody");
async function parseFormData(request, options) {
  if (!isRawRequest(request) && request.bodyCache.formData) {
    return convertFormDataToBodyData(
      await request.bodyCache.formData,
      options
    );
  }
  const headers = isRawRequest(request) ? request.headers : request.raw.headers;
  const arrayBuffer = await request.arrayBuffer();
  const formDataPromise = bufferToFormData(arrayBuffer, headers.get("Content-Type") || "");
  if (!isRawRequest(request)) {
    request.bodyCache.formData = formDataPromise;
  }
  const formData = await formDataPromise;
  if (formData) {
    return convertFormDataToBodyData(formData, options);
  }
  return {};
}
__name(parseFormData, "parseFormData");
function convertFormDataToBodyData(formData, options) {
  const form = /* @__PURE__ */ Object.create(null);
  const nestingState = { count: 0 };
  formData.forEach((value, key) => {
    const shouldParseAllValues = options.all || key.endsWith("[]");
    if (!shouldParseAllValues) {
      form[key] = value;
    } else {
      handleParsingAllValues(form, key, value);
    }
  });
  if (options.dot) {
    Object.entries(form).forEach(([key, value]) => {
      const shouldParseDotValues = key.includes(".");
      if (shouldParseDotValues) {
        handleParsingNestedValues(form, key, value, nestingState);
        delete form[key];
      }
    });
  }
  return form;
}
__name(convertFormDataToBodyData, "convertFormDataToBodyData");
var handleParsingAllValues = /* @__PURE__ */ __name((form, key, value) => {
  if (form[key] !== void 0) {
    if (Array.isArray(form[key])) {
      ;
      form[key].push(value);
    } else {
      form[key] = [form[key], value];
    }
  } else {
    if (!key.endsWith("[]")) {
      form[key] = value;
    } else {
      form[key] = [value];
    }
  }
}, "handleParsingAllValues");
var handleParsingNestedValues = /* @__PURE__ */ __name((form, key, value, state) => {
  if (/(?:^|\.)__proto__\./.test(key)) {
    return;
  }
  let nestedForm = form;
  const keys = key.split(".", MAX_NESTING_DEPTH + 2);
  if (keys.length > MAX_NESTING_DEPTH + 1) {
    throwNestingLimitExceeded();
  }
  keys.forEach((key2, index) => {
    if (index === keys.length - 1) {
      nestedForm[key2] = value;
    } else {
      if (!nestedForm[key2] || typeof nestedForm[key2] !== "object" || Array.isArray(nestedForm[key2]) || nestedForm[key2] instanceof File) {
        if (state.count++ >= MAX_NESTED_OBJECTS) {
          throwNestingLimitExceeded();
        }
        nestedForm[key2] = /* @__PURE__ */ Object.create(null);
      }
      nestedForm = nestedForm[key2];
    }
  });
}, "handleParsingNestedValues");
var throwNestingLimitExceeded = /* @__PURE__ */ __name(() => {
  throw new Error("Nesting limit exceeded");
}, "throwNestingLimitExceeded");

// node_modules/hono/dist/utils/url.js
var splitPath = /* @__PURE__ */ __name((path) => {
  const paths = path.split("/");
  if (paths[0] === "") {
    paths.shift();
  }
  return paths;
}, "splitPath");
var splitRoutingPath = /* @__PURE__ */ __name((routePath) => {
  const { groups, path } = extractGroupsFromPath(routePath);
  const paths = splitPath(path);
  return replaceGroupMarks(paths, groups);
}, "splitRoutingPath");
var extractGroupsFromPath = /* @__PURE__ */ __name((path) => {
  const groups = [];
  path = path.replace(/\{[^}]+\}/g, (match2, index) => {
    const mark = `@${index}`;
    groups.push([mark, match2]);
    return mark;
  });
  return { groups, path };
}, "extractGroupsFromPath");
var replaceGroupMarks = /* @__PURE__ */ __name((paths, groups) => {
  for (let i = groups.length - 1; i >= 0; i--) {
    const [mark] = groups[i];
    for (let j = paths.length - 1; j >= 0; j--) {
      if (paths[j].includes(mark)) {
        paths[j] = paths[j].replace(mark, groups[i][1]);
        break;
      }
    }
  }
  return paths;
}, "replaceGroupMarks");
var patternCache = {};
var getPattern = /* @__PURE__ */ __name((label, next) => {
  if (label === "*") {
    return "*";
  }
  const match2 = label.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
  if (match2) {
    const cacheKey = `${label}#${next}`;
    if (!patternCache[cacheKey]) {
      if (match2[2]) {
        patternCache[cacheKey] = next && next[0] !== ":" && next[0] !== "*" ? [cacheKey, match2[1], new RegExp(`^${match2[2]}(?=/${next})`)] : [label, match2[1], new RegExp(`^${match2[2]}$`)];
      } else {
        patternCache[cacheKey] = [label, match2[1], true];
      }
    }
    return patternCache[cacheKey];
  }
  return null;
}, "getPattern");
var tryDecode = /* @__PURE__ */ __name((str, decoder) => {
  try {
    return decoder(str);
  } catch {
    return str.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match2) => {
      try {
        return decoder(match2);
      } catch {
        return match2;
      }
    });
  }
}, "tryDecode");
var tryDecodeURI = /* @__PURE__ */ __name((str) => tryDecode(str, decodeURI), "tryDecodeURI");
var getPath = /* @__PURE__ */ __name((request) => {
  const url = request.url;
  const start = url.indexOf("/", url.indexOf(":") + 4);
  let i = start;
  for (; i < url.length; i++) {
    const charCode = url.charCodeAt(i);
    if (charCode === 37) {
      const queryIndex = url.indexOf("?", i);
      const hashIndex = url.indexOf("#", i);
      const end = queryIndex === -1 ? hashIndex === -1 ? void 0 : hashIndex : hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex);
      const path = url.slice(start, end);
      return tryDecodeURI(path.includes("%25") ? path.replace(/%25/g, "%2525") : path);
    } else if (charCode === 63 || charCode === 35) {
      break;
    }
  }
  return url.slice(start, i);
}, "getPath");
var getPathNoStrict = /* @__PURE__ */ __name((request) => {
  const result = getPath(request);
  return result.length > 1 && result.at(-1) === "/" ? result.slice(0, -1) : result;
}, "getPathNoStrict");
var mergePath = /* @__PURE__ */ __name((base, sub, ...rest) => {
  if (rest.length) {
    sub = mergePath(sub, ...rest);
  }
  return `${base?.[0] === "/" ? "" : "/"}${base}${sub === "/" ? "" : `${base?.at(-1) === "/" ? "" : "/"}${sub?.[0] === "/" ? sub.slice(1) : sub}`}`;
}, "mergePath");
var checkOptionalParameter = /* @__PURE__ */ __name((path) => {
  if (path.charCodeAt(path.length - 1) !== 63 || !path.includes(":")) {
    return null;
  }
  const segments = path.split("/");
  const results = [];
  let basePath = "";
  segments.forEach((segment) => {
    if (segment !== "" && !/\:/.test(segment)) {
      basePath += "/" + segment;
    } else if (/\:/.test(segment)) {
      if (segment.charCodeAt(segment.length - 1) === 63) {
        if (results.length === 0 && basePath === "") {
          results.push("/");
        } else {
          results.push(basePath);
        }
        const optionalSegment = segment.slice(0, -1);
        basePath += "/" + optionalSegment;
        results.push(basePath);
      } else {
        basePath += "/" + segment;
      }
    }
  });
  return results.filter((v, i, a) => a.indexOf(v) === i);
}, "checkOptionalParameter");
var tryDecodeURIComponent = /* @__PURE__ */ __name((str) => str.indexOf("%") !== -1 ? tryDecode(str, decodeURIComponent_) : str, "tryDecodeURIComponent");
var _decodeURI = /* @__PURE__ */ __name((value) => {
  if (value.indexOf("+") !== -1) {
    value = value.replace(/\+/g, " ");
  }
  return tryDecodeURIComponent(value);
}, "_decodeURI");
var _getQueryParam = /* @__PURE__ */ __name((url, key, multiple) => {
  const hashIndex = url.indexOf("#", 8);
  if (hashIndex !== -1) {
    url = url.slice(0, hashIndex);
  }
  let encoded;
  if (!multiple && key && key.indexOf("%") === -1 && key.indexOf("+") === -1) {
    let keyIndex2 = url.indexOf("?", 8);
    if (keyIndex2 === -1) {
      return void 0;
    }
    if (!url.startsWith(key, keyIndex2 + 1)) {
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    while (keyIndex2 !== -1) {
      const trailingKeyCode = url.charCodeAt(keyIndex2 + key.length + 1);
      if (trailingKeyCode === 61) {
        const valueIndex = keyIndex2 + key.length + 2;
        const endIndex = url.indexOf("&", valueIndex);
        return _decodeURI(url.slice(valueIndex, endIndex === -1 ? void 0 : endIndex));
      } else if (trailingKeyCode == 38 || isNaN(trailingKeyCode)) {
        return "";
      }
      keyIndex2 = url.indexOf(`&${key}`, keyIndex2 + 1);
    }
    encoded = /[%+]/.test(url);
    if (!encoded) {
      return void 0;
    }
  }
  const results = /* @__PURE__ */ Object.create(null);
  encoded ??= /[%+]/.test(url);
  let keyIndex = url.indexOf("?", 8);
  while (keyIndex !== -1) {
    const nextKeyIndex = url.indexOf("&", keyIndex + 1);
    let valueIndex = url.indexOf("=", keyIndex);
    if (valueIndex > nextKeyIndex && nextKeyIndex !== -1) {
      valueIndex = -1;
    }
    let name = url.slice(
      keyIndex + 1,
      valueIndex === -1 ? nextKeyIndex === -1 ? void 0 : nextKeyIndex : valueIndex
    );
    if (encoded) {
      name = _decodeURI(name);
    }
    keyIndex = nextKeyIndex;
    if (name === "") {
      continue;
    }
    let value;
    if (valueIndex === -1) {
      value = "";
    } else {
      value = url.slice(valueIndex + 1, nextKeyIndex === -1 ? void 0 : nextKeyIndex);
      if (encoded) {
        value = _decodeURI(value);
      }
    }
    if (multiple) {
      if (!(results[name] && Array.isArray(results[name]))) {
        results[name] = [];
      }
      ;
      results[name].push(value);
    } else {
      results[name] ??= value;
    }
  }
  return key ? results[key] : results;
}, "_getQueryParam");
var getQueryParam = _getQueryParam;
var getQueryParams = /* @__PURE__ */ __name((url, key) => {
  return _getQueryParam(url, key, true);
}, "getQueryParams");
var decodeURIComponent_ = decodeURIComponent;

// node_modules/hono/dist/request.js
var HonoRequest = /* @__PURE__ */ __name(class {
  /**
   * `.raw` can get the raw Request object.
   *
   * @see {@link https://hono.dev/docs/api/request#raw}
   *
   * @example
   * ```ts
   * // For Cloudflare Workers
   * app.post('/', async (c) => {
   *   const metadata = c.req.raw.cf?.hostMetadata?
   *   ...
   * })
   * ```
   */
  raw;
  #validatedData;
  // Short name of validatedData
  #matchResult;
  routeIndex = 0;
  /**
   * `.path` can get the pathname of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#path}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const pathname = c.req.path // `/about/me`
   * })
   * ```
   */
  path;
  bodyCache = {};
  constructor(request, path = "/", matchResult = [[]]) {
    this.raw = request;
    this.path = path;
    this.#matchResult = matchResult;
  }
  param(key) {
    return key ? this.#getDecodedParam(key) : this.#getAllDecodedParams();
  }
  #getDecodedParam(key) {
    const paramKey = this.#matchResult[0][this.routeIndex]?.[1][key];
    const param = this.#getParamValue(paramKey);
    return param && tryDecodeURIComponent(param);
  }
  #getAllDecodedParams() {
    const decoded = {};
    const keys = Object.keys(this.#matchResult[0][this.routeIndex]?.[1] ?? {});
    for (const key of keys) {
      const value = this.#getParamValue(this.#matchResult[0][this.routeIndex][1][key]);
      if (value !== void 0) {
        decoded[key] = tryDecodeURIComponent(value);
      }
    }
    return decoded;
  }
  #getParamValue(paramKey) {
    return this.#matchResult[1] ? this.#matchResult[1][paramKey] : paramKey;
  }
  query(key) {
    return getQueryParam(this.url, key);
  }
  queries(key) {
    return getQueryParams(this.url, key);
  }
  header(name) {
    if (name) {
      return this.raw.headers.get(name) ?? void 0;
    }
    const headerData = /* @__PURE__ */ Object.create(null);
    this.raw.headers.forEach((value, key) => {
      headerData[key] = value;
    });
    return headerData;
  }
  async parseBody(options) {
    return parseBody(this, options);
  }
  #cachedBody = (key) => {
    const { bodyCache, raw: raw2 } = this;
    const cachedBody = bodyCache[key];
    if (cachedBody) {
      return cachedBody;
    }
    for (const anyCachedKey in bodyCache) {
      return bodyCache[anyCachedKey].then((body) => {
        if (anyCachedKey === "json") {
          body = JSON.stringify(body);
        }
        return new Response(body)[key]();
      });
    }
    return bodyCache[key] = raw2[key]();
  };
  /**
   * `.json()` can parse Request body of type `application/json`
   *
   * @see {@link https://hono.dev/docs/api/request#json}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.json()
   * })
   * ```
   */
  json() {
    return this.#cachedBody("text").then((text) => JSON.parse(text));
  }
  /**
   * `.text()` can parse Request body of type `text/plain`
   *
   * @see {@link https://hono.dev/docs/api/request#text}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.text()
   * })
   * ```
   */
  text() {
    return this.#cachedBody("text");
  }
  /**
   * `.arrayBuffer()` parse Request body as an `ArrayBuffer`
   *
   * @see {@link https://hono.dev/docs/api/request#arraybuffer}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.arrayBuffer()
   * })
   * ```
   */
  arrayBuffer() {
    return this.#cachedBody("arrayBuffer");
  }
  /**
   * `.bytes()` parses the request body as a `Uint8Array`.
   *
   * @see {@link https://hono.dev/docs/api/request#bytes}
   *
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.bytes()
   * })
   * ```
   */
  bytes() {
    return this.#cachedBody("arrayBuffer").then((buffer) => new Uint8Array(buffer));
  }
  /**
   * Parses the request body as a `Blob`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.blob();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#blob
   */
  blob() {
    return this.#cachedBody("blob");
  }
  /**
   * Parses the request body as `FormData`.
   * @example
   * ```ts
   * app.post('/entry', async (c) => {
   *   const body = await c.req.formData();
   * });
   * ```
   * @see https://hono.dev/docs/api/request#formdata
   */
  formData() {
    return this.#cachedBody("formData");
  }
  /**
   * Adds validated data to the request.
   *
   * @param target - The target of the validation.
   * @param data - The validated data to add.
   */
  addValidatedData(target, data) {
    ;
    (this.#validatedData ??= {})[target] = data;
  }
  valid(target) {
    return this.#validatedData?.[target];
  }
  /**
   * `.url()` can get the request url strings.
   *
   * @see {@link https://hono.dev/docs/api/request#url}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const url = c.req.url // `http://localhost:8787/about/me`
   *   ...
   * })
   * ```
   */
  get url() {
    return this.raw.url;
  }
  /**
   * `.method()` can get the method name of the request.
   *
   * @see {@link https://hono.dev/docs/api/request#method}
   *
   * @example
   * ```ts
   * app.get('/about/me', (c) => {
   *   const method = c.req.method // `GET`
   * })
   * ```
   */
  get method() {
    return this.raw.method;
  }
  get [GET_MATCH_RESULT]() {
    return this.#matchResult;
  }
  /**
   * `.matchedRoutes()` can return a matched route in the handler
   *
   * @deprecated
   *
   * Use matchedRoutes helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#matchedroutes}
   *
   * @example
   * ```ts
   * app.use('*', async function logger(c, next) {
   *   await next()
   *   c.req.matchedRoutes.forEach(({ handler, method, path }, i) => {
   *     const name = handler.name || (handler.length < 2 ? '[handler]' : '[middleware]')
   *     console.log(
   *       method,
   *       ' ',
   *       path,
   *       ' '.repeat(Math.max(10 - path.length, 0)),
   *       name,
   *       i === c.req.routeIndex ? '<- respond from here' : ''
   *     )
   *   })
   * })
   * ```
   */
  get matchedRoutes() {
    return this.#matchResult[0].map(([[, route]]) => route);
  }
  /**
   * `routePath()` can retrieve the path registered within the handler
   *
   * @deprecated
   *
   * Use routePath helper defined in "hono/route" instead.
   *
   * @see {@link https://hono.dev/docs/api/request#routepath}
   *
   * @example
   * ```ts
   * app.get('/posts/:id', (c) => {
   *   return c.json({ path: c.req.routePath })
   * })
   * ```
   */
  get routePath() {
    return this.#matchResult[0].map(([[, route]]) => route)[this.routeIndex].path;
  }
}, "HonoRequest");

// node_modules/hono/dist/utils/html.js
var HtmlEscapedCallbackPhase = {
  Stringify: 1,
  BeforeStream: 2,
  Stream: 3
};
var raw = /* @__PURE__ */ __name((value, callbacks) => {
  const escapedString = new String(value);
  escapedString.isEscaped = true;
  escapedString.callbacks = callbacks;
  return escapedString;
}, "raw");
var resolveCallback = /* @__PURE__ */ __name(async (str, phase, preserveCallbacks, context, buffer) => {
  if (typeof str === "object" && !(str instanceof String)) {
    if (!(str instanceof Promise)) {
      str = str.toString();
    }
    if (str instanceof Promise) {
      str = await str;
    }
  }
  const callbacks = str.callbacks;
  if (!callbacks?.length) {
    return Promise.resolve(str);
  }
  if (buffer) {
    buffer[0] += str;
  } else {
    buffer = [str];
  }
  const resStr = Promise.all(callbacks.map((c) => c({ phase, buffer, context }))).then(
    (res) => Promise.all(
      res.filter(Boolean).map((str2) => resolveCallback(str2, phase, false, context, buffer))
    ).then(() => buffer[0])
  );
  if (preserveCallbacks) {
    return raw(await resStr, callbacks);
  } else {
    return resStr;
  }
}, "resolveCallback");

// node_modules/hono/dist/context.js
var TEXT_PLAIN = "text/plain; charset=UTF-8";
var setDefaultContentType = /* @__PURE__ */ __name((contentType, headers) => {
  return {
    "Content-Type": contentType,
    ...headers
  };
}, "setDefaultContentType");
var createResponseInstance = /* @__PURE__ */ __name((body, init) => new Response(body, init), "createResponseInstance");
var Context = /* @__PURE__ */ __name(class {
  #rawRequest;
  #req;
  /**
   * `.env` can get bindings (environment variables, secrets, KV namespaces, D1 database, R2 bucket etc.) in Cloudflare Workers.
   *
   * @see {@link https://hono.dev/docs/api/context#env}
   *
   * @example
   * ```ts
   * // Environment object for Cloudflare Workers
   * app.get('*', async c => {
   *   const counter = c.env.COUNTER
   * })
   * ```
   */
  env = {};
  #var;
  finalized = false;
  /**
   * `.error` can get the error object from the middleware if the Handler throws an error.
   *
   * @see {@link https://hono.dev/docs/api/context#error}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   await next()
   *   if (c.error) {
   *     // do something...
   *   }
   * })
   * ```
   */
  error;
  #status;
  #executionCtx;
  #res;
  #layout;
  #renderer;
  #notFoundHandler;
  #preparedHeaders;
  #matchResult;
  #path;
  /**
   * Creates an instance of the Context class.
   *
   * @param req - The Request object.
   * @param options - Optional configuration options for the context.
   */
  constructor(req, options) {
    this.#rawRequest = req;
    if (options) {
      this.#executionCtx = options.executionCtx;
      this.env = options.env;
      this.#notFoundHandler = options.notFoundHandler;
      this.#path = options.path;
      this.#matchResult = options.matchResult;
    }
  }
  /**
   * `.req` is the instance of {@link HonoRequest}.
   */
  get req() {
    this.#req ??= new HonoRequest(this.#rawRequest, this.#path, this.#matchResult);
    return this.#req;
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#event}
   * The FetchEvent associated with the current request.
   *
   * @throws Will throw an error if the context does not have a FetchEvent.
   */
  get event() {
    if (this.#executionCtx && "respondWith" in this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no FetchEvent");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#executionctx}
   * The ExecutionContext associated with the current request.
   *
   * @throws Will throw an error if the context does not have an ExecutionContext.
   */
  get executionCtx() {
    if (this.#executionCtx) {
      return this.#executionCtx;
    } else {
      throw Error("This context has no ExecutionContext");
    }
  }
  /**
   * @see {@link https://hono.dev/docs/api/context#res}
   * The Response object for the current request.
   */
  get res() {
    return this.#res ||= createResponseInstance(null, {
      headers: this.#preparedHeaders ??= new Headers()
    });
  }
  /**
   * Sets the Response object for the current request.
   *
   * @param _res - The Response object to set.
   */
  set res(_res) {
    if (this.#res && _res) {
      _res = createResponseInstance(_res.body, _res);
      for (const [k, v] of this.#res.headers.entries()) {
        if (k === "content-type") {
          continue;
        }
        if (k === "set-cookie") {
          const cookies = this.#res.headers.getSetCookie();
          _res.headers.delete("set-cookie");
          for (const cookie of cookies) {
            _res.headers.append("set-cookie", cookie);
          }
        } else {
          _res.headers.set(k, v);
        }
      }
    }
    this.#res = _res;
    this.finalized = true;
  }
  /**
   * `.render()` can create a response within a layout.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   return c.render('Hello!')
   * })
   * ```
   */
  render = (...args) => {
    this.#renderer ??= (content) => this.html(content);
    return this.#renderer(...args);
  };
  /**
   * Sets the layout for the response.
   *
   * @param layout - The layout to set.
   * @returns The layout function.
   */
  setLayout = (layout) => this.#layout = layout;
  /**
   * Gets the current layout for the response.
   *
   * @returns The current layout function.
   */
  getLayout = () => this.#layout;
  /**
   * `.setRenderer()` can set the layout in the custom middleware.
   *
   * @see {@link https://hono.dev/docs/api/context#render-setrenderer}
   *
   * @example
   * ```tsx
   * app.use('*', async (c, next) => {
   *   c.setRenderer((content) => {
   *     return c.html(
   *       <html>
   *         <body>
   *           <p>{content}</p>
   *         </body>
   *       </html>
   *     )
   *   })
   *   await next()
   * })
   * ```
   */
  setRenderer = (renderer) => {
    this.#renderer = renderer;
  };
  /**
   * `.header()` can set headers.
   *
   * @see {@link https://hono.dev/docs/api/context#header}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *
   *   // Append multiple headers using the append option (e.g. Vary)
   *   c.header('Vary', 'Accept-Encoding', { append: true })
   *   c.header('Vary', 'User-Agent', { append: true })
   *
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  header = (name, value, options) => {
    if (this.finalized) {
      this.#res = createResponseInstance(this.#res.body, this.#res);
    }
    const headers = this.#res ? this.#res.headers : this.#preparedHeaders ??= new Headers();
    if (value === void 0) {
      headers.delete(name);
    } else if (options?.append) {
      headers.append(name, value);
    } else {
      headers.set(name, value);
    }
  };
  status = (status) => {
    this.#status = status;
  };
  /**
   * `.set()` can set the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.use('*', async (c, next) => {
   *   c.set('message', 'Hono is hot!!')
   *   await next()
   * })
   * ```
   */
  set = (key, value) => {
    this.#var ??= /* @__PURE__ */ new Map();
    this.#var.set(key, value);
  };
  /**
   * `.get()` can use the value specified by the key.
   *
   * @see {@link https://hono.dev/docs/api/context#set-get}
   *
   * @example
   * ```ts
   * app.get('/', (c) => {
   *   const message = c.get('message')
   *   return c.text(`The message is "${message}"`)
   * })
   * ```
   */
  get = (key) => {
    return this.#var ? this.#var.get(key) : void 0;
  };
  /**
   * `.var` can access the value of a variable.
   *
   * @see {@link https://hono.dev/docs/api/context#var}
   *
   * @example
   * ```ts
   * const result = c.var.client.oneMethod()
   * ```
   */
  // c.var.propName is a read-only
  get var() {
    if (!this.#var) {
      return {};
    }
    return Object.fromEntries(this.#var);
  }
  #newResponse(data, arg, headers) {
    let responseHeaders = this.#res ? new Headers(this.#res.headers) : this.#preparedHeaders;
    if (typeof arg === "object" && arg.headers) {
      responseHeaders ??= new Headers();
      for (const [key, value] of new Headers(arg.headers)) {
        if (key === "set-cookie") {
          responseHeaders.append(key, value);
        } else {
          responseHeaders.set(key, value);
        }
      }
    }
    if (headers) {
      if (!responseHeaders) {
        let count = 0;
        for (const k in headers) {
          if (++count > 1 || typeof headers[k] !== "string") {
            responseHeaders = new Headers();
            break;
          }
        }
      }
      if (responseHeaders) {
        for (const k in headers) {
          const v = headers[k];
          if (typeof v === "string") {
            responseHeaders.set(k, v);
          } else {
            responseHeaders.delete(k);
            for (const v2 of v) {
              responseHeaders.append(k, v2);
            }
          }
        }
      }
    }
    const status = typeof arg === "number" ? arg : arg?.status ?? this.#status;
    return createResponseInstance(data, {
      status,
      headers: responseHeaders ?? headers
    });
  }
  newResponse = (...args) => this.#newResponse(...args);
  /**
   * `.body()` can return the HTTP response.
   * You can set headers with `.header()` and set HTTP status code with `.status`.
   * This can also be set in `.text()`, `.json()` and so on.
   *
   * @see {@link https://hono.dev/docs/api/context#body}
   *
   * @example
   * ```ts
   * app.get('/welcome', (c) => {
   *   // Set headers
   *   c.header('X-Message', 'Hello!')
   *   c.header('Content-Type', 'text/plain')
   *   // Set HTTP status code
   *   c.status(201)
   *
   *   // Return the response body
   *   return c.body('Thank you for coming')
   * })
   * ```
   */
  body = (data, arg, headers) => this.#newResponse(data, arg, headers);
  /**
   * `.text()` can render text as `Content-Type:text/plain`.
   *
   * @see {@link https://hono.dev/docs/api/context#text}
   *
   * @example
   * ```ts
   * app.get('/say', (c) => {
   *   return c.text('Hello!')
   * })
   * ```
   */
  text = (text, arg, headers) => {
    return !this.#preparedHeaders && !this.#status && !arg && !headers && !this.finalized ? new Response(text) : this.#newResponse(
      text,
      arg,
      setDefaultContentType(TEXT_PLAIN, headers)
    );
  };
  /**
   * `.json()` can render JSON as `Content-Type:application/json`.
   *
   * @see {@link https://hono.dev/docs/api/context#json}
   *
   * @example
   * ```ts
   * app.get('/api', (c) => {
   *   return c.json({ message: 'Hello!' })
   * })
   * ```
   */
  json = (object, arg, headers) => {
    return this.#newResponse(
      JSON.stringify(object),
      arg,
      setDefaultContentType("application/json", headers)
    );
  };
  html = (html, arg, headers) => {
    const res = /* @__PURE__ */ __name((html2) => this.#newResponse(html2, arg, setDefaultContentType("text/html; charset=UTF-8", headers)), "res");
    return typeof html === "object" ? resolveCallback(html, HtmlEscapedCallbackPhase.Stringify, false, {}).then(res) : res(html);
  };
  /**
   * `.redirect()` can Redirect, default status code is 302.
   *
   * @see {@link https://hono.dev/docs/api/context#redirect}
   *
   * @example
   * ```ts
   * app.get('/redirect', (c) => {
   *   return c.redirect('/')
   * })
   * app.get('/redirect-permanently', (c) => {
   *   return c.redirect('/', 301)
   * })
   * ```
   */
  redirect = (location, status) => {
    const locationString = String(location);
    this.header(
      "Location",
      // Multibyes should be encoded
      // eslint-disable-next-line no-control-regex
      !/[^\x00-\xFF]/.test(locationString) ? locationString : encodeURI(locationString)
    );
    return this.newResponse(null, status ?? 302);
  };
  /**
   * `.notFound()` can return the Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/context#notfound}
   *
   * @example
   * ```ts
   * app.get('/notfound', (c) => {
   *   return c.notFound()
   * })
   * ```
   */
  notFound = () => {
    this.#notFoundHandler ??= () => createResponseInstance();
    return this.#notFoundHandler(this);
  };
}, "Context");

// node_modules/hono/dist/router.js
var METHOD_NAME_ALL = "ALL";
var METHOD_NAME_ALL_LOWERCASE = "all";
var METHODS = ["get", "post", "put", "delete", "options", "patch", "query"];
var MESSAGE_MATCHER_IS_ALREADY_BUILT = "Can not add a route since the matcher is already built.";
var UnsupportedPathError = /* @__PURE__ */ __name(class extends Error {
}, "UnsupportedPathError");

// node_modules/hono/dist/utils/constants.js
var COMPOSED_HANDLER = "__COMPOSED_HANDLER";

// node_modules/hono/dist/hono-base.js
var notFoundHandler = /* @__PURE__ */ __name((c) => {
  return c.text("404 Not Found", 404);
}, "notFoundHandler");
var errorHandler = /* @__PURE__ */ __name((err, c) => {
  if ("getResponse" in err) {
    const res = err.getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
}, "errorHandler");
var Hono = /* @__PURE__ */ __name(class _Hono {
  get;
  post;
  put;
  delete;
  options;
  patch;
  query;
  all;
  on;
  use;
  /*
    This class is like an abstract class and does not have a router.
    To use it, inherit the class and implement router in the constructor.
  */
  router;
  getPath;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  _basePath = "/";
  #path = "/";
  routes = [];
  constructor(options = {}) {
    const allMethods = [...METHODS, METHOD_NAME_ALL_LOWERCASE];
    allMethods.forEach((method) => {
      this[method] = (args1, ...args) => {
        const methodName = method.toUpperCase();
        if (typeof args1 === "string") {
          this.#path = args1;
        } else {
          this.#addRoute(methodName, this.#path, args1);
        }
        args.forEach((handler) => {
          this.#addRoute(methodName, this.#path, handler);
        });
        return this;
      };
    });
    this.on = (method, path, ...handlers) => {
      for (const p of [path].flat()) {
        this.#path = p;
        for (const m of [method].flat()) {
          const methodName = m.toUpperCase();
          for (const handler of handlers) {
            this.#addRoute(methodName, this.#path, handler);
          }
        }
      }
      return this;
    };
    this.use = (arg1, ...handlers) => {
      if (typeof arg1 === "string") {
        this.#path = arg1;
      } else {
        this.#path = "*";
        handlers.unshift(arg1);
      }
      handlers.forEach((handler) => {
        this.#addRoute(METHOD_NAME_ALL, this.#path, handler);
      });
      return this;
    };
    const { strict, ...optionsWithoutStrict } = options;
    Object.assign(this, optionsWithoutStrict);
    this.getPath = strict ?? true ? options.getPath ?? getPath : getPathNoStrict;
  }
  #clone() {
    const clone = new _Hono({
      router: this.router,
      getPath: this.getPath
    });
    clone.errorHandler = this.errorHandler;
    clone.#notFoundHandler = this.#notFoundHandler;
    clone.routes = this.routes;
    return clone;
  }
  #notFoundHandler = notFoundHandler;
  // Cannot use `#` because it requires visibility at JavaScript runtime.
  errorHandler = errorHandler;
  /**
   * `.route()` allows grouping other Hono instance in routes.
   *
   * @see {@link https://hono.dev/docs/api/routing#grouping}
   *
   * @param {string} path - base Path
   * @param {Hono} app - other Hono instance
   * @returns {Hono} routed Hono instance
   *
   * @example
   * ```ts
   * const app = new Hono()
   * const app2 = new Hono()
   *
   * app2.get("/user", (c) => c.text("user"))
   * app.route("/api", app2) // GET /api/user
   * ```
   */
  route(path, app2) {
    const subApp = this.basePath(path);
    app2.routes.map((r) => {
      let handler;
      if (app2.errorHandler === errorHandler) {
        handler = r.handler;
      } else {
        handler = /* @__PURE__ */ __name(async (c, next) => (await compose([], app2.errorHandler)(c, () => r.handler(c, next))).res, "handler");
        handler[COMPOSED_HANDLER] = r.handler;
      }
      subApp.#addRoute(r.method, r.path, handler, r.basePath);
    });
    return this;
  }
  /**
   * `.basePath()` allows base paths to be specified.
   *
   * @see {@link https://hono.dev/docs/api/routing#base-path}
   *
   * @param {string} path - base Path
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * const api = new Hono().basePath('/api')
   * ```
   */
  basePath(path) {
    const subApp = this.#clone();
    subApp._basePath = mergePath(this._basePath, path);
    return subApp;
  }
  /**
   * `.onError()` handles an error and returns a customized Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#error-handling}
   *
   * @param {ErrorHandler} handler - request Handler for error
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.onError((err, c) => {
   *   console.error(`${err}`)
   *   return c.text('Custom Error Message', 500)
   * })
   * ```
   */
  onError = (handler) => {
    this.errorHandler = handler;
    return this;
  };
  /**
   * `.notFound()` allows you to customize a Not Found Response.
   *
   * @see {@link https://hono.dev/docs/api/hono#not-found}
   *
   * @param {NotFoundHandler} handler - request handler for not-found
   * @returns {Hono} changed Hono instance
   *
   * @example
   * ```ts
   * app.notFound((c) => {
   *   return c.text('Custom 404 Message', 404)
   * })
   * ```
   */
  notFound = (handler) => {
    this.#notFoundHandler = handler;
    return this;
  };
  /**
   * `.mount()` allows you to mount applications built with other frameworks into your Hono application.
   *
   * @see {@link https://hono.dev/docs/api/hono#mount}
   *
   * @param {string} path - base Path
   * @param {Function} applicationHandler - other Request Handler
   * @param {MountOptions} [options] - options of `.mount()`
   * @returns {Hono} mounted Hono instance
   *
   * @example
   * ```ts
   * import { Router as IttyRouter } from 'itty-router'
   * import { Hono } from 'hono'
   * // Create itty-router application
   * const ittyRouter = IttyRouter()
   * // GET /itty-router/hello
   * ittyRouter.get('/hello', () => new Response('Hello from itty-router'))
   *
   * const app = new Hono()
   * app.mount('/itty-router', ittyRouter.handle)
   * ```
   *
   * @example
   * ```ts
   * const app = new Hono()
   * // Send the request to another application without modification.
   * app.mount('/app', anotherApp, {
   *   replaceRequest: (req) => req,
   * })
   * ```
   */
  mount(path, applicationHandler, options) {
    let replaceRequest;
    let optionHandler;
    if (options) {
      if (typeof options === "function") {
        optionHandler = options;
      } else {
        optionHandler = options.optionHandler;
        if (options.replaceRequest === false) {
          replaceRequest = /* @__PURE__ */ __name((request) => request, "replaceRequest");
        } else {
          replaceRequest = options.replaceRequest;
        }
      }
    }
    const getOptions = optionHandler ? (c) => {
      const options2 = optionHandler(c);
      return Array.isArray(options2) ? options2 : [options2];
    } : (c) => {
      let executionContext = void 0;
      try {
        executionContext = c.executionCtx;
      } catch {
      }
      return [c.env, executionContext];
    };
    replaceRequest ||= (() => {
      const mergedPath = mergePath(this._basePath, path);
      const pathPrefixLength = mergedPath === "/" ? 0 : mergedPath.length;
      return (request) => {
        const url = new URL(request.url);
        url.pathname = this.getPath(request).slice(pathPrefixLength) || "/";
        return new Request(url, request);
      };
    })();
    const handler = /* @__PURE__ */ __name(async (c, next) => {
      const res = await applicationHandler(replaceRequest(c.req.raw), ...getOptions(c));
      if (res) {
        return res;
      }
      await next();
    }, "handler");
    this.#addRoute(METHOD_NAME_ALL, mergePath(path, "*"), handler);
    return this;
  }
  #addRoute(method, path, handler, baseRoutePath) {
    path = mergePath(this._basePath, path);
    const r = {
      basePath: baseRoutePath !== void 0 ? mergePath(this._basePath, baseRoutePath) : this._basePath,
      path,
      method,
      handler
    };
    this.router.add(method, path, [handler, r]);
    this.routes.push(r);
  }
  #handleError(err, c) {
    if (err instanceof Error) {
      return this.errorHandler(err, c);
    }
    throw err;
  }
  #dispatch(request, executionCtx, env, method) {
    if (method === "HEAD") {
      return (async () => new Response(null, await this.#dispatch(request, executionCtx, env, "GET")))();
    }
    const path = this.getPath(request, { env });
    const matchResult = this.router.match(method, path);
    const c = new Context(request, {
      path,
      matchResult,
      env,
      executionCtx,
      notFoundHandler: this.#notFoundHandler
    });
    if (matchResult[0].length === 1) {
      let res;
      try {
        res = matchResult[0][0][0][0](c, async () => {
          c.res = await this.#notFoundHandler(c);
        });
      } catch (err) {
        return this.#handleError(err, c);
      }
      return res instanceof Promise ? res.then(
        (resolved) => resolved || (c.finalized ? c.res : this.#notFoundHandler(c))
      ).catch((err) => this.#handleError(err, c)) : res ?? this.#notFoundHandler(c);
    }
    const composed = compose(matchResult[0], this.errorHandler, this.#notFoundHandler);
    return (async () => {
      try {
        const context = await composed(c);
        if (!context.finalized) {
          throw new Error(
            "Context is not finalized. Did you forget to return a Response object or `await next()`?"
          );
        }
        return context.res;
      } catch (err) {
        return this.#handleError(err, c);
      }
    })();
  }
  /**
   * `.fetch()` will be entry point of your app.
   *
   * @see {@link https://hono.dev/docs/api/hono#fetch}
   *
   * @param {Request} request - request Object of request
   * @param {Env} env - env Object
   * @param {ExecutionContext} executionCtx - context of execution
   * @returns {Response | Promise<Response>} response of request
   *
   */
  fetch = (request, ...rest) => {
    return this.#dispatch(request, rest[1], rest[0], request.method);
  };
  /**
   * `.request()` is a useful method for testing.
   * You can pass a URL or pathname to send a GET request.
   * app will return a Response object.
   * ```ts
   * test('GET /hello is ok', async () => {
   *   const res = await app.request('/hello')
   *   expect(res.status).toBe(200)
   * })
   * ```
   * @see https://hono.dev/docs/api/hono#request
   */
  request = (input, requestInit, Env, executionCtx) => {
    if (input instanceof Request) {
      return this.fetch(requestInit ? new Request(input, requestInit) : input, Env, executionCtx);
    }
    input = input.toString();
    return this.fetch(
      new Request(
        /^https?:\/\//.test(input) ? input : `http://localhost${mergePath("/", input)}`,
        requestInit
      ),
      Env,
      executionCtx
    );
  };
  /**
   * `.fire()` automatically adds a global fetch event listener.
   * This can be useful for environments that adhere to the Service Worker API, such as non-ES module Cloudflare Workers.
   * @deprecated
   * Use `fire` from `hono/service-worker` instead.
   * ```ts
   * import { Hono } from 'hono'
   * import { fire } from 'hono/service-worker'
   *
   * const app = new Hono()
   * // ...
   * fire(app)
   * ```
   * @see https://hono.dev/docs/api/hono#fire
   * @see https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
   * @see https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/
   */
  fire = () => {
    addEventListener("fetch", (event) => {
      event.respondWith(this.#dispatch(event.request, event, void 0, event.request.method));
    });
  };
}, "_Hono");

// node_modules/hono/dist/router/utils.js
var createNullObject = /* @__PURE__ */ __name(() => /* @__PURE__ */ Object.create(null), "createNullObject");

// node_modules/hono/dist/router/reg-exp-router/matcher.js
var emptyParam = [];
function match(method, path) {
  const matchers = this.buildAllMatchers();
  const match2 = /* @__PURE__ */ __name((method2, path2) => {
    const matcher = matchers[method2] || matchers[METHOD_NAME_ALL];
    const staticMatch = matcher[2][path2];
    if (staticMatch) {
      return staticMatch;
    }
    const match3 = path2.match(matcher[0]);
    if (!match3) {
      return [[], emptyParam];
    }
    const index = match3.indexOf("", 1);
    return [matcher[1][index], match3];
  }, "match2");
  this.match = match2;
  return match2(method, path);
}
__name(match, "match");

// node_modules/hono/dist/router/reg-exp-router/node.js
var LABEL_REG_EXP_STR = "[^/]+";
var ONLY_WILDCARD_REG_EXP_STR = ".*";
var TAIL_WILDCARD_REG_EXP_STR = "(?:|/.*)";
var PATH_ERROR = /* @__PURE__ */ Symbol();
var regExpMetaChars = new Set(".\\+*[^]$()");
function compareKey(a, b) {
  if (a.length === 1) {
    return b.length === 1 ? a < b ? -1 : 1 : -1;
  }
  if (b.length === 1) {
    return 1;
  }
  if (a === ONLY_WILDCARD_REG_EXP_STR || a === TAIL_WILDCARD_REG_EXP_STR) {
    return b === TAIL_WILDCARD_REG_EXP_STR ? -1 : 1;
  } else if (b === ONLY_WILDCARD_REG_EXP_STR || b === TAIL_WILDCARD_REG_EXP_STR) {
    return -1;
  }
  if (a === LABEL_REG_EXP_STR) {
    return 1;
  } else if (b === LABEL_REG_EXP_STR) {
    return -1;
  }
  return a.length === b.length ? a < b ? -1 : 1 : b.length - a.length;
}
__name(compareKey, "compareKey");
var Node = /* @__PURE__ */ __name(class _Node {
  // handler index of a dynamic path, or -1 for a static path terminal
  #index;
  #varIndex;
  #children = createNullObject();
  insert(tokens, index, paramMap, context, isStatic) {
    let node = this;
    for (let i = 0, len = tokens.length; i < len; i++) {
      const token = tokens[i];
      const pattern = token.length === 1 ? token === "*" ? i === len - 1 ? ["", "", ONLY_WILDCARD_REG_EXP_STR] : ["", "", LABEL_REG_EXP_STR] : null : token === "/*" ? ["", "", TAIL_WILDCARD_REG_EXP_STR] : token.match(/^\:([^\{\}]+)(?:\{(.+)\})?$/);
      let nextNode;
      if (pattern) {
        const name = pattern[1];
        let regexpStr = pattern[2] || LABEL_REG_EXP_STR;
        if (name && pattern[2]) {
          if (regexpStr === ".*") {
            throw PATH_ERROR;
          }
          regexpStr = regexpStr.replace(/^\((?!\?:)(?=[^)]+\)$)/, "(?:");
          if (/\((?!\?:)/.test(regexpStr)) {
            throw PATH_ERROR;
          }
          if (regexpStr.length === 1 && regExpMetaChars.has(regexpStr)) {
            throw PATH_ERROR;
          }
        }
        nextNode = node.#children[regexpStr];
        if (!nextNode) {
          if (regexpStr !== ONLY_WILDCARD_REG_EXP_STR && regexpStr !== TAIL_WILDCARD_REG_EXP_STR) {
            for (const k in node.#children) {
              if (
                // a single-char pattern coexists with single-char literals as a literal does
                (regexpStr.length > 1 || k.length > 1) && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR
              ) {
                throw PATH_ERROR;
              }
            }
          }
          nextNode = node.#children[regexpStr] = new _Node();
        }
        if (name !== "") {
          nextNode.#varIndex ??= context.varIndex++;
          paramMap.push([name, nextNode.#varIndex]);
        }
      } else {
        nextNode = node.#children[token];
        if (!nextNode) {
          for (const k in node.#children) {
            if (k.length > 1 && k !== ONLY_WILDCARD_REG_EXP_STR && k !== TAIL_WILDCARD_REG_EXP_STR) {
              throw PATH_ERROR;
            }
          }
          nextNode = node.#children[token] = new _Node();
        }
      }
      node = nextNode;
    }
    if (node.#index !== void 0) {
      throw PATH_ERROR;
    }
    node.#index = isStatic ? -1 : index;
  }
  buildRegExpStr() {
    const childKeys = Object.keys(this.#children).sort(compareKey);
    const strList = childKeys.map((k) => {
      const c = this.#children[k];
      const childStr = c.buildRegExpStr();
      return childStr === "" ? "" : (typeof c.#varIndex === "number" ? `(${k})@${c.#varIndex}` : regExpMetaChars.has(k) ? `\\${k}` : k) + childStr;
    }).filter(Boolean);
    if (typeof this.#index === "number" && this.#index !== -1) {
      strList.unshift(`#${this.#index}`);
    }
    if (strList.length === 0) {
      return "";
    }
    if (strList.length === 1) {
      return strList[0];
    }
    return "(?:" + strList.join("|") + ")";
  }
}, "_Node");

// node_modules/hono/dist/router/reg-exp-router/trie.js
var Trie = /* @__PURE__ */ __name(class {
  #context = { varIndex: 0 };
  #root = new Node();
  #index = 0;
  // dynamic path -> [handler index, param assoc]; static paths are not registered
  paths = createNullObject();
  insert(path, isStatic) {
    if (isStatic) {
      this.#root.insert(path.split(""), 0, [], this.#context, true);
      return;
    }
    const paramAssoc = [];
    const groups = [];
    let markedPath = path;
    for (let i = 0; ; ) {
      let replaced = false;
      markedPath = markedPath.replace(/\{[^}]+\}/g, (m) => {
        const mark = `@\\${i}`;
        groups[i] = [mark, m];
        i++;
        replaced = true;
        return mark;
      });
      if (!replaced) {
        break;
      }
    }
    const tokens = markedPath.match(/(?::[^\/]+)|(?:\/\*$)|./g) || [];
    for (let i = groups.length - 1; i >= 0; i--) {
      const [mark] = groups[i];
      for (let j = tokens.length - 1; j >= 0; j--) {
        if (tokens[j].indexOf(mark) !== -1) {
          tokens[j] = tokens[j].replace(mark, groups[i][1]);
          break;
        }
      }
    }
    this.#root.insert(tokens, this.#index, paramAssoc, this.#context, false);
    this.paths[path] = [this.#index++, paramAssoc];
  }
  buildRegExp() {
    let regexp = this.#root.buildRegExpStr();
    if (regexp === "") {
      return [/^$/, [], []];
    }
    let captureIndex = 0;
    const indexReplacementMap = [];
    const paramReplacementMap = [];
    regexp = regexp.replace(/#(\d+)|@(\d+)|\.\*\$/g, (_, handlerIndex, paramIndex) => {
      if (handlerIndex !== void 0) {
        indexReplacementMap[++captureIndex] = Number(handlerIndex);
        return "$()";
      }
      if (paramIndex !== void 0) {
        paramReplacementMap[Number(paramIndex)] = ++captureIndex;
        return "";
      }
      return "";
    });
    return [new RegExp(`^${regexp}`), indexReplacementMap, paramReplacementMap];
  }
}, "Trie");

// node_modules/hono/dist/router/reg-exp-router/router.js
var wildcardRegExpCache = createNullObject();
function buildWildcardRegExp(path) {
  return wildcardRegExpCache[path] ??= new RegExp(
    `^${path.replace(
      /\/:[^/{}]+(?:\{\[\^\/]\+})?(?=[/{]|$)|\/?\*$|([.\\+*[^\]$()?{}|])/g,
      (match2, metaChar) => metaChar ? `\\${metaChar}` : match2 === "/*" ? TAIL_WILDCARD_REG_EXP_STR : match2 === "*" ? ONLY_WILDCARD_REG_EXP_STR : `/:${LABEL_REG_EXP_STR}`
    )}$`
  );
}
__name(buildWildcardRegExp, "buildWildcardRegExp");
function findMiddleware(middleware, path) {
  for (const k of Object.keys(middleware).sort((a, b) => b.length - a.length)) {
    if (buildWildcardRegExp(k).test(path)) {
      return [...middleware[k]];
    }
  }
  return void 0;
}
__name(findMiddleware, "findMiddleware");
var RegExpRouter = /* @__PURE__ */ __name(class {
  name = "RegExpRouter";
  #middleware;
  #routes;
  #tries;
  constructor() {
    this.#middleware = { [METHOD_NAME_ALL]: createNullObject() };
    this.#routes = { [METHOD_NAME_ALL]: createNullObject() };
    this.#tries = { [METHOD_NAME_ALL]: new Trie() };
  }
  #insertPath(method, path) {
    try {
      this.#tries[method].insert(path, !/\*|\/:/.test(path));
    } catch (e) {
      throw e === PATH_ERROR ? new UnsupportedPathError(path) : e;
    }
  }
  add(method, path, handler) {
    const middleware = this.#middleware;
    const routes = this.#routes;
    if (!middleware) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    if (!middleware[method]) {
      this.#tries[method] = new Trie();
      for (const handlerMap of [middleware, routes]) {
        handlerMap[method] = createNullObject();
        for (const p in handlerMap[METHOD_NAME_ALL]) {
          handlerMap[method][p] = [...handlerMap[METHOD_NAME_ALL][p]];
          this.#insertPath(method, p);
        }
      }
    }
    if (path === "/*") {
      path = "*";
    }
    const methods = method === METHOD_NAME_ALL ? Object.keys(middleware) : [method];
    if (/\*$/.test(path)) {
      const re = buildWildcardRegExp(path);
      for (const m of methods) {
        if (!middleware[m][path]) {
          this.#insertPath(m, path);
          middleware[m][path] = findMiddleware(middleware[m], path) || findMiddleware(middleware[METHOD_NAME_ALL], path) || [];
        }
      }
      for (const handlerMap of [middleware, routes]) {
        for (const m of methods) {
          for (const p in handlerMap[m]) {
            re.test(p) && handlerMap[m][p].push([handler, path]);
          }
        }
      }
      return;
    }
    const paths = checkOptionalParameter(path) || [path];
    for (const path2 of paths) {
      for (const m of methods) {
        if (!routes[m][path2]) {
          this.#insertPath(m, path2);
          routes[m][path2] = findMiddleware(middleware[m], path2) || findMiddleware(middleware[METHOD_NAME_ALL], path2) || [];
        }
        routes[m][path2].push([handler, path2]);
      }
    }
  }
  match = match;
  buildAllMatchers() {
    const matchers = createNullObject();
    for (const method of Object.keys(this.#routes)) {
      matchers[method] = this.#buildMatcher(method);
    }
    this.#middleware = this.#routes = this.#tries = void 0;
    wildcardRegExpCache = createNullObject();
    return matchers;
  }
  #buildMatcher(method) {
    const middleware = this.#middleware[method];
    const routes = this.#routes[method];
    const trie = this.#tries[method];
    const staticMap = createNullObject();
    const handlerData = [];
    const [regexp, indexReplacementMap, paramReplacementMap] = trie.buildRegExp();
    for (const r of [middleware, routes]) {
      for (const path in r) {
        const handlers = r[path];
        const pathData = trie.paths[path];
        if (!pathData) {
          staticMap[path] = [handlers.map(([h]) => [h, createNullObject()]), emptyParam];
          continue;
        }
        handlerData[pathData[0]] = handlers.map(([h, handlerPath]) => [
          h,
          trie.paths[handlerPath][1].reduceRight((map, [key], i) => {
            map[key] = paramReplacementMap[pathData[1][i][1]];
            return map;
          }, createNullObject())
        ]);
      }
    }
    return [regexp, indexReplacementMap.map((i) => handlerData[i]), staticMap];
  }
}, "RegExpRouter");

// node_modules/hono/dist/router/smart-router/router.js
var SmartRouter = /* @__PURE__ */ __name(class {
  name = "SmartRouter";
  #routers = [];
  #routes = [];
  constructor(init) {
    this.#routers = init.routers;
  }
  add(method, path, handler) {
    if (!this.#routes) {
      throw new Error(MESSAGE_MATCHER_IS_ALREADY_BUILT);
    }
    this.#routes.push([method, path, handler]);
  }
  match(method, path) {
    if (!this.#routes) {
      throw new Error("Fatal error");
    }
    const routers = this.#routers;
    const routes = this.#routes;
    const len = routers.length;
    let i = 0;
    let res;
    for (; i < len; i++) {
      const router = routers[i];
      try {
        for (let i2 = 0, len2 = routes.length; i2 < len2; i2++) {
          router.add(...routes[i2]);
        }
        res = router.match(method, path);
      } catch (e) {
        if (e instanceof UnsupportedPathError) {
          continue;
        }
        throw e;
      }
      this.match = router.match.bind(router);
      this.#routers = [router];
      this.#routes = void 0;
      break;
    }
    if (i === len) {
      throw new Error("Fatal error");
    }
    this.name = `SmartRouter + ${this.activeRouter.name}`;
    return res;
  }
  get activeRouter() {
    if (this.#routes || this.#routers.length !== 1) {
      throw new Error("No active router has been determined yet.");
    }
    return this.#routers[0];
  }
}, "SmartRouter");

// node_modules/hono/dist/router/trie-router/node.js
var emptyParams = createNullObject();
var order = 0;
var Node2 = /* @__PURE__ */ __name(class _Node2 {
  #methods = [];
  #children = createNullObject();
  #patterns = [];
  #pattern;
  #params = emptyParams;
  insert(method, path, handler) {
    let curNode = this;
    const parts = splitRoutingPath(path);
    const possibleKeys = /* @__PURE__ */ new Set();
    let i = 0;
    for (const p of parts) {
      const nextP = parts[++i];
      const pattern = getPattern(p, nextP) || (nextP === void 0 && p && p.indexOf("*") === p.length - 1 ? p : null);
      const isParam = Array.isArray(pattern);
      const key = isParam ? pattern[0] : pattern || p;
      const child = curNode.#children[key] ||= new _Node2();
      if (pattern && !child.#pattern) {
        child.#pattern = pattern;
        curNode.#patterns.push(child);
      }
      curNode = child;
      if (isParam) {
        possibleKeys.add(pattern[1]);
      }
    }
    curNode.#methods.push({
      [method]: {
        handler,
        possibleKeys: [...possibleKeys],
        score: ++order
      }
    });
  }
  #pushHandlerSets(handlerSets, node, method, nodeParams, params) {
    for (let i = 0, len = node.#methods.length; i < len; i++) {
      const m = node.#methods[i];
      const handlerSet = m[method] || m[METHOD_NAME_ALL];
      if (handlerSet) {
        handlerSet.params = createNullObject();
        handlerSets.push(handlerSet);
        for (let i2 = 0, len2 = handlerSet.possibleKeys.length; i2 < len2; i2++) {
          const key = handlerSet.possibleKeys[i2];
          handlerSet.params[key] = params?.[key] && !i2 ? params[key] : nodeParams[key] ?? params?.[key];
        }
      }
    }
  }
  search(method, path) {
    const handlerSets = [];
    this.#params = emptyParams;
    const curNode = this;
    let curNodes = [curNode];
    const parts = splitPath(path);
    const curNodesQueue = [];
    const len = parts.length;
    let partOffsets = null;
    for (let i = 0; i < len; i++) {
      const part = parts[i];
      const isLast = i === len - 1;
      const tempNodes = [];
      for (let j = 0, len2 = curNodes.length; j < len2; j++) {
        const node = curNodes[j];
        const nextNode = node.#children[part];
        if (nextNode) {
          nextNode.#params = node.#params;
          if (isLast) {
            if (nextNode.#children["*"]) {
              this.#pushHandlerSets(handlerSets, nextNode.#children["*"], method, node.#params);
            }
            this.#pushHandlerSets(handlerSets, nextNode, method, node.#params);
          } else {
            tempNodes.push(nextNode);
          }
        }
        for (const child of node.#patterns) {
          const pattern = child.#pattern;
          const params = node.#params === emptyParams ? {} : { ...node.#params };
          if (typeof pattern === "string") {
            if (pattern === "*" || part.startsWith(pattern.slice(0, -1))) {
              this.#pushHandlerSets(handlerSets, child, method, node.#params);
              if (pattern === "*") {
                child.#params = params;
                tempNodes.push(child);
              }
            }
            continue;
          }
          const [, name, matcher] = pattern;
          if (!part && matcher === true) {
            continue;
          }
          if (matcher !== true) {
            if (!partOffsets) {
              partOffsets = [];
              let offset = path[0] === "/" ? 1 : 0;
              for (let p = 0; p < len; p++) {
                partOffsets[p] = offset;
                offset += parts[p].length + 1;
              }
            }
            const restPathString = path.slice(partOffsets[i]);
            const m = matcher.exec(restPathString);
            if (m) {
              params[name] = m[0];
              this.#pushHandlerSets(handlerSets, child, method, node.#params, params);
              if (m[0].length === restPathString.length && child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  node.#params,
                  params
                );
              }
              for (const _ in child.#children) {
                child.#params = params;
                const componentCount = m[0].match(/\//g)?.length ?? 0;
                const targetCurNodes = curNodesQueue[componentCount] ||= [];
                targetCurNodes.push(child);
                break;
              }
              continue;
            }
          }
          if (matcher === true || matcher.test(part)) {
            params[name] = part;
            if (isLast) {
              this.#pushHandlerSets(handlerSets, child, method, params, node.#params);
              if (child.#children["*"]) {
                this.#pushHandlerSets(
                  handlerSets,
                  child.#children["*"],
                  method,
                  params,
                  node.#params
                );
              }
            } else {
              child.#params = params;
              tempNodes.push(child);
            }
          }
        }
      }
      const shifted = curNodesQueue.shift();
      curNodes = shifted ? tempNodes.concat(shifted) : tempNodes;
    }
    if (handlerSets[1]) {
      handlerSets.sort((a, b) => {
        return a.score - b.score;
      });
    }
    return [handlerSets.map(({ handler, params }) => [handler, params])];
  }
}, "_Node");

// node_modules/hono/dist/router/trie-router/router.js
var TrieRouter = /* @__PURE__ */ __name(class {
  name = "TrieRouter";
  #node = new Node2();
  add(method, path, handler) {
    for (const result of checkOptionalParameter(path) || [path]) {
      this.#node.insert(method, result, handler);
    }
  }
  match(method, path) {
    return this.#node.search(method, path);
  }
}, "TrieRouter");

// node_modules/hono/dist/hono.js
var Hono2 = /* @__PURE__ */ __name(class extends Hono {
  /**
   * Creates an instance of the Hono class.
   *
   * @param options - Optional configuration options for the Hono instance.
   */
  constructor(options = {}) {
    super(options);
    this.router = options.router ?? new SmartRouter({
      routers: [new RegExpRouter(), new TrieRouter()]
    });
  }
}, "Hono");

// node_modules/hono/dist/utils/cookie.js
var validCookieNameRegEx = /^[\w!#$%&'*.^`|~+-]+$/;
var relaxedCookieNameRegEx = /^[!#-:<>-[\]-~]+$/;
var validCookieValueRegEx = /^[ !#-:<-[\]-~]*$/;
var trimCookieWhitespace = /* @__PURE__ */ __name((value) => {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const charCode = value.charCodeAt(start);
    if (charCode !== 32 && charCode !== 9) {
      break;
    }
    start++;
  }
  while (end > start) {
    const charCode = value.charCodeAt(end - 1);
    if (charCode !== 32 && charCode !== 9) {
      break;
    }
    end--;
  }
  return start === 0 && end === value.length ? value : value.slice(start, end);
}, "trimCookieWhitespace");
var parse = /* @__PURE__ */ __name((cookie, name) => {
  if (name && cookie.indexOf(name) === -1) {
    return {};
  }
  const pairs = cookie.split(";");
  const parsedCookie = /* @__PURE__ */ Object.create(null);
  for (const pairStr of pairs) {
    const valueStartPos = pairStr.indexOf("=");
    if (valueStartPos === -1) {
      continue;
    }
    const cookieName = trimCookieWhitespace(pairStr.substring(0, valueStartPos));
    if (name && name !== cookieName || !relaxedCookieNameRegEx.test(cookieName) || cookieName in parsedCookie) {
      continue;
    }
    let cookieValue = trimCookieWhitespace(pairStr.substring(valueStartPos + 1));
    if (cookieValue.startsWith('"') && cookieValue.endsWith('"')) {
      cookieValue = cookieValue.slice(1, -1);
    }
    if (validCookieValueRegEx.test(cookieValue)) {
      parsedCookie[cookieName] = tryDecodeURIComponent(cookieValue);
      if (name) {
        break;
      }
    }
  }
  return parsedCookie;
}, "parse");
var _serialize = /* @__PURE__ */ __name((name, value, opt = {}) => {
  if (!validCookieNameRegEx.test(name)) {
    throw new Error("Invalid cookie name");
  }
  let cookie = `${name}=${value}`;
  if (name.startsWith("__Secure-") && !opt.secure) {
    throw new Error("__Secure- Cookie must have Secure attributes");
  }
  if (name.startsWith("__Host-")) {
    if (!opt.secure) {
      throw new Error("__Host- Cookie must have Secure attributes");
    }
    if (opt.path !== "/") {
      throw new Error('__Host- Cookie must have Path attributes with "/"');
    }
    if (opt.domain) {
      throw new Error("__Host- Cookie must not have Domain attributes");
    }
  }
  for (const key of ["domain", "path", "sameSite", "priority"]) {
    if (opt[key] && /[;\r\n]/.test(opt[key])) {
      throw new Error(`${key} must not contain ";", "\\r", or "\\n"`);
    }
  }
  if (opt && typeof opt.maxAge === "number" && opt.maxAge >= 0) {
    if (opt.maxAge > 3456e4) {
      throw new Error(
        "Cookies Max-Age SHOULD NOT be greater than 400 days (34560000 seconds) in duration."
      );
    }
    cookie += `; Max-Age=${opt.maxAge | 0}`;
  }
  if (opt.domain && opt.prefix !== "host") {
    cookie += `; Domain=${opt.domain}`;
  }
  if (opt.path) {
    cookie += `; Path=${opt.path}`;
  }
  if (opt.expires) {
    if (opt.expires.getTime() - Date.now() > 3456e7) {
      throw new Error(
        "Cookies Expires SHOULD NOT be greater than 400 days (34560000 seconds) in the future."
      );
    }
    cookie += `; Expires=${opt.expires.toUTCString()}`;
  }
  if (opt.httpOnly) {
    cookie += "; HttpOnly";
  }
  if (opt.secure) {
    cookie += "; Secure";
  }
  if (opt.sameSite) {
    cookie += `; SameSite=${opt.sameSite.charAt(0).toUpperCase() + opt.sameSite.slice(1)}`;
  }
  if (opt.priority) {
    cookie += `; Priority=${opt.priority.charAt(0).toUpperCase() + opt.priority.slice(1)}`;
  }
  if (opt.partitioned) {
    if (!opt.secure) {
      throw new Error("Partitioned Cookie must have Secure attributes");
    }
    cookie += "; Partitioned";
  }
  return cookie;
}, "_serialize");
var serialize = /* @__PURE__ */ __name((name, value, opt) => {
  value = encodeURIComponent(value);
  return _serialize(name, value, opt);
}, "serialize");

// node_modules/hono/dist/helper/cookie/index.js
var getCookie = /* @__PURE__ */ __name((c, key, prefix) => {
  const cookie = c.req.raw.headers.get("Cookie");
  if (typeof key === "string") {
    if (!cookie) {
      return void 0;
    }
    let finalKey = key;
    if (prefix === "secure") {
      finalKey = "__Secure-" + key;
    } else if (prefix === "host") {
      finalKey = "__Host-" + key;
    }
    const obj2 = parse(cookie, finalKey);
    return obj2[finalKey];
  }
  if (!cookie) {
    return {};
  }
  const obj = parse(cookie);
  return obj;
}, "getCookie");
var generateCookie = /* @__PURE__ */ __name((name, value, opt) => {
  let cookie;
  if (opt?.prefix === "secure") {
    cookie = serialize("__Secure-" + name, value, { path: "/", ...opt, secure: true });
  } else if (opt?.prefix === "host") {
    cookie = serialize("__Host-" + name, value, {
      ...opt,
      path: "/",
      secure: true,
      domain: void 0
    });
  } else {
    cookie = serialize(name, value, { path: "/", ...opt });
  }
  return cookie;
}, "generateCookie");
var setCookie = /* @__PURE__ */ __name((c, name, value, opt) => {
  const cookie = generateCookie(name, value, opt);
  c.header("Set-Cookie", cookie, { append: true });
}, "setCookie");
var deleteCookie = /* @__PURE__ */ __name((c, name, opt) => {
  const deletedCookie = getCookie(c, name, opt?.prefix);
  setCookie(c, name, "", { ...opt, maxAge: 0 });
  return deletedCookie;
}, "deleteCookie");

// src/auth.js
var ITERATIONS = 1e5;
var SESSION_DAYS = 30;
var COOKIE = "sitedesk_session";
function b64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
__name(b64, "b64");
function fromB64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(fromB64, "fromB64");
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${b64(salt)}:${b64(bits)}`;
}
__name(hashPassword, "hashPassword");
async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = (stored || "").split(":");
  if (!saltB64 || !hashB64)
    return false;
  const salt = fromB64(saltB64);
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const a = fromB64(hashB64);
  const b = new Uint8Array(bits);
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
__name(verifyPassword, "verifyPassword");
function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(newToken, "newToken");
function newId() {
  return crypto.randomUUID();
}
__name(newId, "newId");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function sessionExpiry() {
  const d = /* @__PURE__ */ new Date();
  d.setDate(d.getDate() + SESSION_DAYS);
  return d.toISOString();
}
__name(sessionExpiry, "sessionExpiry");
function claimExpiry(minutes = 45) {
  return new Date(Date.now() + minutes * 6e4).toISOString();
}
__name(claimExpiry, "claimExpiry");

// src/db.js
var STATUSES = ["pending", "approved", "rejected", "disabled"];
var MAX_ACTIVE_LEADS = 5;
function maxActiveLeads(env) {
  const n = parseInt(env?.MAX_ACTIVE_LEADS || String(MAX_ACTIVE_LEADS), 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_ACTIVE_LEADS;
}
__name(maxActiveLeads, "maxActiveLeads");
function isHeadEmail(env, email) {
  const head = (env.HEAD_EMAIL || env.ADMIN_EMAIL || "iamnottaiii@gmail.com").toLowerCase().trim();
  return (email || "").toLowerCase().trim() === head;
}
__name(isHeadEmail, "isHeadEmail");
function canManageUsers(user) {
  return user && ["head", "admin"].includes(user.role) && user.status === "approved";
}
__name(canManageUsers, "canManageUsers");
function canSeeInbox(user) {
  return user && ["head", "admin", "builder"].includes(user.role) && user.status === "approved";
}
__name(canSeeInbox, "canSeeInbox");
function canClaimLeads(user) {
  return user && ["head", "admin", "caller"].includes(user.role) && user.status === "approved";
}
__name(canClaimLeads, "canClaimLeads");
function canCreateAdmin(actor) {
  return actor && actor.role === "head" && actor.status === "approved";
}
__name(canCreateAdmin, "canCreateAdmin");
async function getUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email = ?").bind(email.toLowerCase().trim()).first();
}
__name(getUserByEmail, "getUserByEmail");
async function getUserById(db, id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
}
__name(getUserById, "getUserById");
async function getSessionUser(db, token) {
  if (!token)
    return null;
  const row = await db.prepare(
    `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
  ).bind(token, nowIso()).first();
  return row || null;
}
__name(getSessionUser, "getSessionUser");
async function createSession(db, token, userId, expiresAt) {
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expiresAt).run();
}
__name(createSession, "createSession");
async function deleteSession(db, token) {
  if (!token)
    return;
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}
__name(deleteSession, "deleteSession");
async function deleteUserSessions(db, userId) {
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}
__name(deleteUserSessions, "deleteUserSessions");
async function releaseExpiredClaims(db) {
  const now = nowIso();
  await db.prepare(
    `UPDATE leads
       SET status = 'open', claimed_by = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ?
       WHERE status = 'claimed'
         AND claim_expires_at IS NOT NULL
         AND claim_expires_at < ?`
  ).bind(now, now).run();
}
__name(releaseExpiredClaims, "releaseExpiredClaims");
async function countActiveLeads(db, userId) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM leads
       WHERE claimed_by=? AND status IN ('claimed','interested')`
  ).bind(userId).first();
  return Number(row?.n || 0);
}
__name(countActiveLeads, "countActiveLeads");
async function pickLeastLoadedBuilder(db) {
  const row = await db.prepare(
    `SELECT u.id, u.name, u.email, u.role,
              (SELECT COUNT(*) FROM intakes i
               WHERE i.assigned_to = u.id
                 AND i.status IN ('submitted','building','payment_sent')) AS open_n
       FROM users u
       WHERE u.status='approved' AND u.role='builder'
       ORDER BY open_n ASC, u.name ASC
       LIMIT 1`
  ).first();
  return row || null;
}
__name(pickLeastLoadedBuilder, "pickLeastLoadedBuilder");
function publicUser(u) {
  if (!u)
    return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone || null,
    role: u.role,
    status: u.status,
    phone_confirmed: !!u.phone_confirmed,
    email_confirmed: !!u.email_confirmed,
    phone_confirmed_at: u.phone_confirmed_at || null,
    email_confirmed_at: u.email_confirmed_at || null,
    payout_method: u.payout_method || null,
    payout_details: u.payout_details || null,
    created_at: u.created_at
  };
}
__name(publicUser, "publicUser");
function isValidEmail(email) {
  const e = String(email || "").trim();
  if (!e || e.length > 254)
    return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
__name(isValidEmail, "isValidEmail");
function leadSiteUrl(slug, siteOrigin) {
  const host = (siteOrigin || "https://bjvfi.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${slug}.${host}`;
}
__name(leadSiteUrl, "leadSiteUrl");
var DEFAULT_CALL_TEMPLATE = `Hey, is this {business}? Hi, I'm {caller} \u2014 I work with bjvfi. I put a site together for you at {link}. Building it is free \u2014 hosting is \${price}/mo if you like it. Got 30 seconds? I can walk you through it or text the link.`;
var DEFAULT_SMS_TEMPLATE = `Hi, I'm {caller} \u{1F601} I work with bjvfi \u2014 I put websites together for businesses and I put one together for {business} \u2014 {link}. I used information I could find on google, and could add things you want to it, to make it as you want. The building is free, and we'll manage and host them for \${price}/monthly. Thanks for your time!`;
function applyTemplate(body, { caller, business, link, price }) {
  return String(body || "").replaceAll("{caller}", caller || "a SiteDesk caller").replaceAll("{business}", business || "your business").replaceAll("{link}", link || "").replaceAll("{price}", String(price || "27")).replaceAll("{name}", caller || "a SiteDesk caller");
}
__name(applyTemplate, "applyTemplate");
function callScript(callerName, businessName, link, price, templateBody) {
  const body = templateBody || DEFAULT_CALL_TEMPLATE;
  return applyTemplate(body, { caller: callerName, business: businessName, link, price });
}
__name(callScript, "callScript");
function outreachDraft(callerName, businessName, link, price, templateBody) {
  const body = templateBody || DEFAULT_SMS_TEMPLATE;
  return applyTemplate(body, { caller: callerName, business: businessName, link, price });
}
__name(outreachDraft, "outreachDraft");
async function getDraftTemplate(db, kind, category) {
  if (category) {
    const row = await db.prepare(
      `SELECT * FROM draft_templates WHERE kind=? AND category=? LIMIT 1`
    ).bind(kind, category).first();
    if (row)
      return row;
  }
  return db.prepare(
    `SELECT * FROM draft_templates WHERE kind=? AND (category IS NULL OR category='') LIMIT 1`
  ).bind(kind).first();
}
__name(getDraftTemplate, "getDraftTemplate");
async function ensureDefaultDraftTemplates(db) {
  const now = nowIso();
  const call = await db.prepare(`SELECT id FROM draft_templates WHERE kind='call' AND (category IS NULL OR category='') LIMIT 1`).first();
  if (!call) {
    await db.prepare(
      `INSERT INTO draft_templates (id, kind, category, body, updated_at, updated_by)
         VALUES (?, 'call', NULL, ?, ?, NULL)`
    ).bind(crypto.randomUUID(), DEFAULT_CALL_TEMPLATE, now).run();
  }
  const sms = await db.prepare(`SELECT id FROM draft_templates WHERE kind='sms' AND (category IS NULL OR category='') LIMIT 1`).first();
  if (!sms) {
    await db.prepare(
      `INSERT INTO draft_templates (id, kind, category, body, updated_at, updated_by)
         VALUES (?, 'sms', NULL, ?, ?, NULL)`
    ).bind(crypto.randomUUID(), DEFAULT_SMS_TEMPLATE, now).run();
  }
}
__name(ensureDefaultDraftTemplates, "ensureDefaultDraftTemplates");
async function enrichLead(lead, callerName, env, db) {
  if (!lead)
    return null;
  const site_url = lead.site_url || leadSiteUrl(lead.slug, env.SITE_ORIGIN);
  const name = callerName || "a SiteDesk caller";
  let callTpl = null;
  let smsTpl = null;
  if (db) {
    try {
      callTpl = await getDraftTemplate(db, "call", null);
      smsTpl = await getDraftTemplate(db, "sms", null);
    } catch {
    }
  }
  return {
    ...lead,
    site_url,
    outreach_draft: outreachDraft(name, lead.business_name, site_url, env.MONTHLY_PRICE, smsTpl?.body),
    call_script: callScript(name, lead.business_name, site_url, env.MONTHLY_PRICE, callTpl?.body),
    has_phone: !!(lead.phone && String(lead.phone).trim() && !["\u2014", "-", "n/a", "na"].includes(String(lead.phone).trim().toLowerCase()))
  };
}
__name(enrichLead, "enrichLead");

// src/webpush.js
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const b642 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b642);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++)
    out[i] = bin.charCodeAt(i);
  return out;
}
__name(b64urlToBytes, "b64urlToBytes");
function bytesToB64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = "";
  for (let i = 0; i < bytes.length; i++)
    s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
__name(bytesToB64url, "bytesToB64url");
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
__name(concat, "concat");
async function importVapidKeyPair(publicB64, privateD) {
  const pubRaw = b64urlToBytes(publicB64);
  if (pubRaw.length !== 65 || pubRaw[0] !== 4)
    throw new Error("bad_vapid_public");
  const x = bytesToB64url(pubRaw.slice(1, 33));
  const y = bytesToB64url(pubRaw.slice(33, 65));
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: privateD, x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return { privateKey, publicB64, x, y };
}
__name(importVapidKeyPair, "importVapidKeyPair");
function utf8(s) {
  return new TextEncoder().encode(s);
}
__name(utf8, "utf8");
async function signJwt(privateKey, audience, subject, publicB64) {
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1e3) + 12 * 3600;
  const payload = bytesToB64url(utf8(JSON.stringify({ aud: audience, exp, sub: subject })));
  const data = utf8(`${header}.${payload}`);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data));
  return `${header}.${payload}.${bytesToB64url(sig)}`;
}
__name(signJwt, "signJwt");
async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info },
    key,
    len * 8
  );
  return new Uint8Array(bits);
}
__name(hkdf, "hkdf");
async function encryptPayload(payloadStr, p256dhB64, authB64) {
  const clientPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, serverKeys.privateKey, 256)
  );
  const prk = await hkdf(sharedSecret, authSecret, concat(new TextEncoder().encode("WebPush: info\0"), clientPublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(prk, salt, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(prk, salt, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const plaintext = concat(new TextEncoder().encode(payloadStr), new Uint8Array([2]));
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext)
  );
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concat(salt, rs, new Uint8Array([serverPublic.length]), serverPublic);
  return concat(header, encrypted);
}
__name(encryptPayload, "encryptPayload");
function vapidConfigured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}
__name(vapidConfigured, "vapidConfigured");
async function sendWebPush(env, subscription, payload) {
  if (!vapidConfigured(env))
    return { ok: false, reason: "vapid_not_configured" };
  try {
    const { privateKey, publicB64 } = await importVapidKeyPair(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const endpoint = subscription.endpoint;
    const url = new URL(endpoint);
    const audience = `${url.protocol}//${url.host}`;
    const subject = env.VAPID_SUBJECT || "mailto:iamnottaiii@gmail.com";
    const jwt = await signJwt(privateKey, audience, subject, publicB64);
    const body = await encryptPayload(
      typeof payload === "string" ? payload : JSON.stringify(payload),
      subscription.p256dh,
      subscription.auth
    );
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${publicB64}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal"
      },
      body
    });
    if (res.status === 201 || res.status === 200)
      return { ok: true };
    if (res.status === 404 || res.status === 410)
      return { ok: false, reason: "gone", status: res.status };
    const t = await res.text().catch(() => "");
    console.error("webpush failed", res.status, t);
    return { ok: false, reason: "push_" + res.status };
  } catch (e) {
    console.error("webpush error", e);
    return { ok: false, reason: e.message || "error" };
  }
}
__name(sendWebPush, "sendWebPush");
async function pushToUserIds(db, env, userIds, payload) {
  if (!vapidConfigured(env))
    return;
  const uniq = [...new Set((userIds || []).filter(Boolean))];
  if (!uniq.length)
    return;
  for (const uid of uniq) {
    const { results } = await db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=?").bind(uid).all();
    for (const sub of results || []) {
      const r = await sendWebPush(env, sub, payload);
      if (r.reason === "gone") {
        await db.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(sub.endpoint).run();
      }
    }
  }
}
__name(pushToUserIds, "pushToUserIds");

// src/notify.js
async function createNotification(db, { userId, title, body, link }) {
  if (!userId)
    return null;
  const id = newId();
  const created_at = nowIso();
  await db.prepare(
    `INSERT INTO notifications (id, user_id, title, body, link, read_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
  ).bind(id, userId, title, body || null, link || null, created_at).run();
  return { id, user_id: userId, title, body, link, created_at };
}
__name(createNotification, "createNotification");
async function notifyUsers(db, userIds, payload) {
  const uniq = [...new Set((userIds || []).filter(Boolean))];
  const out = [];
  for (const uid of uniq) {
    out.push(await createNotification(db, { userId: uid, ...payload }));
  }
  return out;
}
__name(notifyUsers, "notifyUsers");
async function usersByRoles(db, roles) {
  if (!roles?.length)
    return [];
  const placeholders = roles.map(() => "?").join(",");
  const { results } = await db.prepare(
    `SELECT id, email, name, role FROM users
       WHERE role IN (${placeholders}) AND status = 'approved'`
  ).bind(...roles).all();
  return results || [];
}
__name(usersByRoles, "usersByRoles");
async function sendEmail(env, { to, subject, text, html }) {
  if (!to)
    return { ok: false, reason: "no_to" };
  const from = env.MAIL_FROM || "SiteDesk <noreply@bjvfi.com>";
  try {
    if (env.RESEND_API_KEY) {
      const res2 = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          text,
          html: html || `<pre style="font-family:monospace">${text}</pre>`
        })
      });
      if (!res2.ok) {
        const t = await res2.text().catch(() => "");
        console.error("resend failed", res2.status, t);
        return { ok: false, reason: "resend_" + res2.status };
      }
      return { ok: true, via: "resend" };
    }
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: parseFrom(from),
        subject,
        content: [
          { type: "text/plain", value: text },
          { type: "text/html", value: html || `<pre>${escapeHtml(text)}</pre>` }
        ]
      })
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("mailchannels failed", res.status, t);
      return { ok: false, reason: "mailchannels_" + res.status };
    }
    return { ok: true, via: "mailchannels" };
  } catch (e) {
    console.error("sendEmail error", e);
    return { ok: false, reason: e.message || "error" };
  }
}
__name(sendEmail, "sendEmail");
async function sendSms(env, { to, body }) {
  if (!to)
    return { ok: false, reason: "no_to" };
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_FROM;
  if (!sid || !token || !from)
    return { ok: false, reason: "twilio_not_configured" };
  try {
    const auth = btoa(`${sid}:${token}`);
    const params = new URLSearchParams({ To: to, From: from, Body: body });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params.toString()
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("twilio failed", res.status, t);
      return { ok: false, reason: "twilio_" + res.status };
    }
    return { ok: true, via: "sms" };
  } catch (e) {
    console.error("sendSms error", e);
    return { ok: false, reason: e.message || "error" };
  }
}
__name(sendSms, "sendSms");
function parseFrom(from) {
  const m = String(from).match(/^(.*)<([^>]+)>$/);
  if (m)
    return { name: m[1].trim().replace(/^"|"$/g, ""), email: m[2].trim() };
  return { email: from.trim(), name: "SiteDesk" };
}
__name(parseFrom, "parseFrom");
function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escapeHtml, "escapeHtml");
async function notifyInAppAndEmail(db, env, users, { title, body, link }) {
  const list = Array.isArray(users) ? users : users ? [users] : [];
  const ids = list.map((u) => u.id || u).filter(Boolean);
  await notifyUsers(db, ids, { title, body, link });
  const appUrl = (env.APP_PUBLIC_URL || "https://sitedesk.iamnottaiii.workers.dev").replace(/\/$/, "");
  const fullLink = link ? link.startsWith("http") ? link : appUrl + link : appUrl;
  for (const u of list) {
    const email = u.email;
    if (!email)
      continue;
    const text = `${title}

${body || ""}

Open: ${fullLink}
`;
    await sendEmail(env, { to: email, subject: `[SiteDesk] ${title}`, text });
  }
  try {
    await pushToUserIds(db, env, ids, { title, body: body || "", url: fullLink });
  } catch (e) {
    console.error("push notify failed", e);
  }
}
__name(notifyInAppAndEmail, "notifyInAppAndEmail");
async function notifyRolesInAppAndEmail(db, env, roles, payload) {
  const users = await usersByRoles(db, roles);
  await notifyInAppAndEmail(db, env, users, payload);
  return users;
}
__name(notifyRolesInAppAndEmail, "notifyRolesInAppAndEmail");

// src/brand-assets.js
var LOGO_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAABGsAAAF6CAYAAACum9UEAACIkElEQVR4nO3dd7wVxf3/8ddt9F5EmkiRYgGlqQgIoiKiaOwdK2qCRr9qEk2Mmqixxp9GjRWjsWtEBbGhoGAFUQQFpV167+X2O78/lqv3Hm45s2f27Cnv5+MxD72Xs7ufndk7uzNndgZERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERCSRZIQdgIiIiIgkpBbACcCJQHegDdDE8TG2A6uARcA7wFvASsfHEBHxqy1wEjAS6IxXDzZ0fIwtePXgfGDC7rTR8TFERERERCTJNQHuBvIAE+dUDDyB1yASEQlLG7y6qJj414N5wF247xwXEREREZEkdTiwmvg3TiLTNrwRPSIi8TYKrw4Kux5cDRwW8LmKiIiIiEiCOwXIJ/wGSlkqAa4K9IxFRCq6Cq/uCbv+K0v5eHWziIiIiIikoX6E89pTNB02GmEjIvEwisTqqClLu4C+AZ63iIiIiIgkoHrAcsJvkFSVtqE5bEQkWG3wJjwPu76rKi3Dq6tFRERERCRN/IXwGyI1pScCO3sREXiK8Ou5mtJNgZ29JCQt3S2SWGoB/YFDgUOAfYF9gEb82pu+E+9bxuXAEuA74AtgJlAY12hFRCTZ1QHWAI3DDqQGJUAHtKy3iLjXDsgFskKOoyZbgVZAQdiBiIiki0y8d2RfJraZ57cALwDDUUesiIhE5wTC/7Y42vTbgPJARNLbWMKv36JNxweUByIiUk5t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hktx6qwB6IHPqSMaNmxo5s2b5/S8I23evNl07tw5lmvxcp/5Ig59gGXBnX766YFeWBs3bjTnnHNO6BVldSk7O9vcdNNNpqCgIJA82L59u593rbcDdWO8HiaFnbeukjprKk3vVF/8oXkei/No1aqVKSwsdFq+5U2cONE0atQo7LJylVwuxTjSTwzdunUzO3fuDKy8yps/f745/PDDw87zStPIkSPNwoULAzv3++67z09csUxInwUstj3mcccdF1gelNmyZYu55JJLQivrjIwMc9lll8Xtuo/kI2YXVD+ofihP7QsfKcXaF1bHcSmOnTXg44uLstSjRw+zfft2p+ceac6cOaZ+/fp+r8kC4PAY8kYcGIWPwps6dWqgF5YxxkyZMsX06dMn9IozMg0ZMsR89913gZ773Xff7Se25xxcDz+Hnb+ukjprKk3zqy/+0JyO5bm88MILTss30vz5881hhx0Wdnn9knJycky/fv3MsGHDbLed46qQdnvPT/xjxowJtLzKKy0tNS+//LLZb7/9Qi83wPTr18+88847gZ7zrFmz/AxrN3iTgcbiKj958txzzwWaH2U+/PBDc8ABB8S1vHv37m0+/fTTuJxfVXzE7YrqB9UPZdS+sEwp2L6wOo5Lce6sAbjP9nzLUtCdlMYY88orr8Ryba7EWwVSQpKBNwmlVcF16NAhsGU4yystLTVvvvmmOfLII0OtQDMyMszw4cPj8gC2YsUKv0uuDXdwPST9KlBlSZ01laZt1Rd/aBoA+Vicy2GHHea0fCtTUlJinnjiCdOhQ4e4llNGRobp2rWrOfvss839999vpk+fbvLy8owxxsycOdN2f8XEPuKuvP3xlna0Pq9x48YFXmblFRUVmSeeeMJ079497n9rWVlZ5oQTTjDvv/9+4Oe5fv16v9focgfXQ218jK5p0qSJWb58eeB5Y4z3HDF+/HjTt2/fQMt88ODBZvz48XE5p5r4iN8V1Q+qH8qofRFFSvH2hdVxXAqhsyYbmGp7zmXpvvvuc3r+lbnhhhtiuVan43/1SHHgEnwUXDx6AsubM2eOufHGG02nTp3iVokecMAB5vbbbzdLly6N23n+5je/8RPrQry5P2IVWsUq/vi4VhKV9St4M2bMiEseFxUVmVdeecWcfPLJTicvzcjIMG3atDGDBg0yY8aMMQ8//LD59NNPzbZt26qMpaCgwOTk5Nge6zDHZWW13HpZysnJMR988EFcyizSp59+as4777zAJ5/t06ePueuuu8yyZcvicl6FhYVmyJAhfuN9xNH1cKaf4x9zzDGmtLQ0LvlU5uuvvzY33nij6dGjh5O/30MOOcTcdtttgc87YMvH+bik+kH1Qxm1L6pIadK+sDqWSyF01gC0whuFYp3P2dnZgY8qKy4ujnWydVfPDKHLCDsAH7KA74ADbTd8/PHHGTNmjPOAavLzzz8zdepUpk+fznfffcf8+fMpKiqKaZ916tShR48eHHzwwQwZMoSjjz6aNm3aOIo4Om+99RYnn3yyn02vBf6fgxCM1YeN1cclABkZ1lVOotZRFwNP22wwcuRIJk6cGFA4lSssLGTGjBl89dVX/PDDDyxcuJBVq1axYcMGdu3aRVFRETk5OdSuXZu6devSpEkTWrZsyV577UWbNm3o3LnzL6lTp07UrWs/6KV37958++23NpuMxe1NthkwF2htu2GjRo2YNm0aPXv2dBhO9PLy8pg2bRoffvghkydPZs6cOZSUlPjaV3Z2Nj169KBfv34MGTKEYcOGxfWeUVpayrnnnsvLL7/sZ/MSvJXYXC3v/gU+OgX/9a9/MXbsWEch2FmyZAmzZs1i7ty5zJ07l8WLF7N161a2b9/Otm3bKCwspFatWtStW5cWLVqw9957s++++9K9e3cOPvhgBgwYQJMmTUKJvSYh3xdUP6D6YTe1L0jr9kVobYrc3Fw6duxos8lSYF8Hhx6AN8LGehRKq1atmDVrVqDXxsaNG+nbty+5ubl+d3Ex8Iy7iMKRqA2hmgzHe9fYSk5ODm+//TbHHXdcACFFr7CwkMWLF7NkyRKWLl3K2rVr2bBhA1u3bqWgoICioiKys7OpU6cOderUoV69erRq1Yq9996b1q1b07FjR7p06UJWVlZo57B48WL69u3L5s2bbTfdCHTEe4UpVuqsSTIp1FlTD1gBNLXZ6KOPPuKoo2KZAzH5XHrppTz9tFW/1ji8bzhdOhbvnmF9PbVt25Yvv/ySdu3aOQ7JXmFhIQsXLmT+/PksWLCAjRs3smPHDrZv386uXbvIysqiVq1aNGjQgBYtWtCyZUs6dOhA586d2W+//ahTp05osf/ud7/j0Ucf9bu562vicOBz241q167N1KlTOeww14O/0lsC3BdUP6h+KKP2Rfq2L9Kxswa8udz8LHXOgAEDmDp1Kjk5wb1x9O2333LEEUeQl5fnZ/N8YBAw021UEi1fE8PVr1/ffPnll4EO3Up1O3fuND179vQ7LO2PDq+B0IYsij8+rpdEZj1BW+/eveP+KkXYHnnkEdsy/y6g8nrAtrzKUteuXeM6/DuVlJaWmiuvvDKWocyrgRYBXA+v+omnVatWuhYc81EOQVD9EIIErR/UvghJyO0Lq+O5FNJrUOVZrXJaPo0dO9ZpXlTmv//9byx1xDKgpeP8kigdgDcZpXXBNW/e3MyZMyfwiysVlZSUmNNPP93vH8wKoL7DayC0ilX88XHNJLJ98YZfW53TI488EnYxxNWXX35pW+aFeBPBulYbmG1bXmWpXbt2CTfXR6IrLi42F154YSwPWQYYEcC1ALAPsNVPTD179gx8+dJEVlJSYlavXu1sfz7KIAiqH+IsgesHtS9CkADtC6tjupQAnTX1gO9t86AsPf/8807zozK///3vY6knpuBNqiwhuB2fBdekSRPzySefBH5xpZKSkhJz/vnnx/LHcorj8g+tYhV/fFwzie5NLM+pbt26afVQn5eXZ7Kzs23LvW9A5XUAkGdbZmWpRYsWZubMmWFnaVLYtm2bGTFiRCz3CwP8K6DroMyFfmM78cQTTXFxcdjZHIoxY8aYCRMmONufj/wPiuqHOEmC+kHtizhKkPaF1TFdSoDOGoAuwBbbfABMvXr1zPfff+80TyIVFRXFuhraAwHkmUQhG2+iQF8FV7t2bfPqq68GenGlipKSEnPBBRfE8kcyIYDyD61iFX98XDeJ7gh8/D307t3bFBQUhF0ccXPQQQfZ5tHlAZbZFX7KrCw1atTIfPjhh2FnaUJbunRpLEPZy9JnQK0Ar4My4/3GeOqpp6bV37Exxtx0000GSNXOGlD9ELgkqR/UvoiTBGpfWB3XpQTprAEYBZTa5gVgunTpYrZs2eI0XyKtXbvWtGvXLpZr5ZyA8k1q0BGfQ5kBk5mZae644460m0fCxvbt280pp5wSyx/HDqBDAGUfWsUq/vi4dpLB//Dxd3HxxReHXRxxM3r0aNv8eTzgMvunnzIrS5mZmeaWW24xJSUlYWdtwnnvvfdM8+bNY7lfGLzlRK1X5/FpL2Cd31iPP/54k5eXF3a2x8WDDz74y3mncGcNqH4ITJLVD2pfBCzB2hdWx3YpgTprAO6wzYuyNGrUqMCv96+//trUrl3b7/WyCzg4wLyTapxNbBW/GTFihFm/fn2gF1gyWrhwoTnwwANjvbFeE1C5h1axij8+rp1k0AVvnhXr87vxxhvDLpK4eOihh2zzJuiZ+zOA1/yUWfk0dOhQp3N3JLOioiJz8803m8zMzFjvFzuB/gGXf6STY4n5qKOOMjt27Ai7CAL1t7/9rcI5p3hnjeoHx5K4flD7IiAJ2L6wOrZLCdZZkwl8YJsfZen22293mjeVefrpp2O5ZhYDzQLMP6nGg8RYobZr185MmzYt8IssWbz55pumWbNmsVakrwdY5qFVrOKPj+snWTyAz7+R+++/P+xiCdz06dNt8yUfCG4tSE8dYLrfcitLrVq1Mu+//37YWRyqn376yfTv3z/We4XB6/QMa+3bR6KMsdJ0yCGHmEWLFoVdFM4VFRWZiy++eI/zTfHOGlD94EwK1A9qXziWoO0Lq+O7lGCdNQDN8ZYHty6XzMxM88EHHzjNn8pcccUVsVw77wacf1KFTOAVYqxQMzMzzeWXX242btwY+IWWqNavX2/OPvtsFzfWH4EGAZZ5aBWr+OPjGkoWzYAN+PxbSfURNjt27PDzjepBcSi35sBPfsutfDrrrLPMihUrws7quCouLjYPPPCAqVevnov7RSlwXrDFXa0cYmycN2nSxLz55pthF4szW7ZsMccee2yl55oGnTWg+iEmKVQ/qH3hSIK3L6xicCkBO2vAW+gh3zZfwFsVLTc312keRSosLDQDBgyI5Ro6LQ55KJWoBUzGwY21RYsW5umnn06rd01LS0vNf//7X9OyZUsXFelWoGuwxR1exSr++LiOksmpxPA3c/7555vCwsKwiygwPXr0sM2TE+NUbp2A5X7LrXxq0KCBueeee1K6HMt88803pk+fPi7uFQYoAS4OtJSj0xpvCVjf55KRkWFuuOEGU1RUFHYRxeSjjz4y7du3r/I806SzBlQ/+JKC9YPaFzFIkvaFVRwuJWhnDcAY23wpS3379jX5+flO8ynSqlWrTOvWrf1eR7lA3XhkouypITALNzcI07t3b/Pmm2+mfKU6ceJE06tXL1c31kJgZJCFvFtoFav44+NaSjZPEcPfTp8+fVJ2WW8fy7SOjlOZgdcg8zXkt7LUvXt388Ybb6TkBKOrVq0yY8aMMVlZWa7uF8WEO6ImUk9imFS0LB188MHm888/D7u4rO3atctcffXVJiMjo9rzS6POGlD9ELUUrx/UvvAhidoXVrG4lMCdNQBPW8b2S7r00kud5lNlPvvsM5OTk+P3erouPlkolWkBfImjChUwvXr1Mq+99lpKVaolJSXmnXfeiXUYWWQqAk4JrmgrCK1iFX98XE/Jpj4xDpuvW7euefDBB1OmrpkyZYo54ogj/OTFmXEpsV91ABb5iLPK1L17d/P000+nxPLOmzZtMjfffLOpX7++y/tFPok5FHkYUECM55eRkWEuvPBCs27durCLLypvvPGG2W+//aI6tzTrrAHVD9VKo/pB7YsoJGn7wioelxK8s6YO8I1lfL+kp556ymleVebRRx/1e019FJcclCrVAybgsEIFzH777Wfuuusus2bNmsAvvqBs3LjR3HvvvaZTp05O8wavIj01qAKtRGgVq/hjW2ZxvJZc6oPP93zLp4MPPti8++67YReZLzt27DDPPPOM6devXyx5MCj4otrDXsAMn/FWmdq2bWvuu+8+s2XLlrCLxtrChQvN2LFjXTfCDN4cT0cEVZAOnIJ3T4v5XJs0aWLuv/9+s3PnzrCLs1KTJ0+2/ltNw84aUP2whzStH9S+qEKSty+sYnIpwTtrAPYFNlrGaABTp04dM3PmTKf5VZnKJsKPIuUBteOSg1KlLOAJHFeogMnOzjYnn3yymTBhQlJ8K7J9+3bz0ksvmdNOO83UqVPHeX7gVaSnB1OMVQqtYhV/bMssjteSa6fgvWcf89/WkUceaSZNmpTwQ+bXrl1rnnvuOXPGGWe4mFCyFGgUcBlVpT4BPIiDN2rq3HPPNZMnTzbFxcVhF1mVtm/fbp577jkzfPhwF0vtVpYWAPsFU3xOnYajDhvA7LXXXubOO+9MiGV88/PzzSuvvGKGDBni61zStLMGVD+ofvCofbFbCrUvrOJyKQk6a8Bbic3Xc22HDh3Mhg0bnOZZpPz8fL9fEA6MU/5JDW7CUcOpstSgQQNz8sknmyeffNKsXLky0IvRxk8//WSeeOIJM2rUqKAq0LK0CTgmgHKrSWgVq/hjW2ZxvJaC4HtitspS+/btzS233GIWLFgQdjEaY4xZuXKlGT9+vPnjH/9o+vTpU+McF5bpkyALJgqZwB14nUaB1JstWrQwF198sXnrrbfM1q1bwy5Os3LlSvPMM8+46myrLr0NNHFeYsE5Ge/bN2d5ULt2bXPOOeeYSZMmxX2y2VmzZpmrrroq5mVz07izBlQ/qH74ldoXqdO+sIrNpSTprAH4a5Tx7ZGGDx8e+JeOy5cvN3vttZdtbMfGK/P8ygg7gDg6BngBaBn0gQ466CD69+9P79696d27N7169aJu3WAnnN64cSM//PAD33//PdOmTePTTz9lzZo1gR5zt7l4D7OL4nGwCNsJdmlwCdd2whtd4cqfgdtd77Rr166MGDGC4cOH079/f5o3b+76EL8oKSlh4cKFzJkzhzlz5vD9998zc+ZMVqxYEdgxgQuBZ4M8QJROAZ4h4OswOzub/v37M2jQIPr370///v1p165dYMcrKSlh3rx5zJgxgxkzZjB9+nTmzJkT2PF2K8V70LsT7wEpmQzGa0Q2dr3jZs2aMWLECI455hiOOuoo2rdv73T/CxcuZOrUqUydOpUpU6awatUqp/sPQSLdF1Q/uJPM9YPaF8GId/simdoUc/Amw4+3DLyRhfFYRCZehhD+F4TVSqfOGoA2wMvEeS6ErKwsunXrRseOHWnXrh3t2rWjffv2tGvXjhYtWlC3bt0KqU6dOhhjyM/P/yUVFBSwadMmVq9ezZo1a1i9ejWrVq1iwYIF/PDDD6xbty6ep1RmPHABsCOMgwM/k/hDZcW/n4DuYQfhwG14D6GB2WeffejduzcHHHAA++yzD+3bt6d9+/Y0adKEunXrUq9ePerUqUNxcTFFRUUUFhZSWFhIXl4emzdvZtOmTb/8d/Xq1SxdupSlS5eybNkyli1bRkFBQZDhR/oCb66CRHlg7wg8DwyI50GbNm1Kjx496NGjBx06dPjlntG8eXOaNm1K48aNqV27Njk5OWRnZ/9SrgUFBRQUFLB582bWr1//S1qyZAkLFy5kwYIFLFq0iPz8/HiezjK8e0VCPxDV4AC8DptOQR6kVatW9O3bl/33358uXbrQsWNHWrVqRcuWLWnQoAG1a9cmOzub/Px8du7c+Uvavn07y5YtY+HChb+kn3/+mbVr1wYZbhgS7b6g+iF2qVA/qH3hVhjti2RqU7yP91pSGJrgTTgc6L0wjg7HmzRcEkg28A+85QCDHLqXymkncA3hd/ZNIvy8UAouvUPquAzVOdGkQuAgn3kcpCy8DrdCws+jZEv/JYARKSFpBkwm/DxN55SI9wXVD/5TKtUPal/EnsJsXyRTm+KRgPIgWr2AXYSfD7GmIqCp47wRhw7G8fJ7aZKmkDi9qWMJPz+Ugku/JbUcj/ctUdj5msjpRt+5Gx8H4o38CTufkiGtIr6rA8ZLFt6rjYHNU6FUbUrk+4Lqh+hTqtYPoPaF3zSFcNsXydSmOD6gPLBxAeHnQ6zpQ+e5Is5lAJfjczmyNEtbgSsIfzRNee3RNxipmoqBtqSePsBCws/fREtFeBMyJ4NMvAbjBsLPt0RMpcC/SZ1vy6tyJLCc8PM7nVIy3BdUP1Sf0qV+UPsi+pQo7YtkaVNsIXGWm36U8PMjlnSl+yyRoLQEHkdDWCtLBcCDxGHiNJ+eIvw8UnKfniB1NQCeJPw8TpS0hXBWk4tVE+CfeHVk2HmYKOkrvPe/00Vj4DECXBVIqUJKpvtCE1Q/RKZ0qx9A7YvqUiK2L5KhTXFTYGdvrxbJO4psHRDc6hwSmA54lapurt4Q7//szpNE1hZvBvew80vJXdqGN1lfqjsRWEv4+R1WKsVbSaV1rBkZsn3xHvDS+WF8IXBmjPmYzAYC3xN+OaRyStb7wr6ofkj3+gHUviifErl9kehtimVAvcDO3p92eB0fYeeNbTotiMyQ+GmPN7Qrn/AvpninXXgPFj1izsX4GYW+2UyVVLK7PNNFc+AB0quuKcFbNeNAB/mXSDrijbJIhUn3ok2Lgd8BOQ7yL9ll4b3Kl84dsEGlVLgvqH4QUPsiGdoXidqmyAP6BnjesRhMctVtLweTDRKGvYA/APMJ/8IKOi0Crid5Z8W+isSsXJWiTyW7yzEddQCeJbUnLd0A3EviTFAelOZ4w5RXEH6eB5W+AE7H66CQihrilf96wi+nVEipdl9Q/SCg9kWiS7Q2RT6JPyH3MXgdSmHnVU3pbbzpCCQFDQaeI7l6DmtKW/CWTTweb1K8ZDeKxB6+qFR12k7yf3PqwoHAOFJn1ahtwEt4ZVvLYT4lgyxgJPA/UmPo+wa8iUEPdZlJKaw+cC3JNaH4DrxXNQ7EGwkyN+R4Uvm+oPpByqh9kZgSpU2xhuSZ62kIsITw86yqdB/Jez2KhUZ4794+R3J+c7YJ713RkaRm46kt3jDLZJjRXckrp6dIzrkIgtQIb3WEbwi/jGzT98DdeDdtDX/3NAcuBt4huRpm24BXgZNQWfqVAQwH3iBxX334HO91lcYRsdcGriP+K9qk231B9YOA2heJKMw2RR5wD95k5cmkPl6nyE7CvybL0mTg2CBPOkhhL5OW7DKB/ngV0wigF5AdakR72gZ8BnwKfALMwKt0Ul17vAeI44EueJOYathb+HYAq/G+bZ4EvIk3HFyq1hM4Aa+OOZzEGlq+FZiJt8rH13irAqwNNaLE1wgYBhy9O3UNN5wKSoHvgPeB9/Aa8elwv4iXRsDJeBMbHoX3UBuGQmAaXh38BpBbw+cb4NU/o/Cec9oAzXD3DKn7wq9UPwiofZFo4tGm2IpXD84HJuC9rrPB8THiqQFwCt49rzNeHsbjVbhCvNE9C/Hy8jm8LxGTljpr3KqDV6H2Bvrs/u+BxO8bh/XAj8APeMOXv8a7sZbE6fgiEqwmeA/wA/DqmIPxHu6DVog3WeRcYE65tAjvWwvxb2+8Vwf6A/3w7hnxWCGrBK+R/i3eQ/YMvJFc2+JwbPGeCwbgNcwPw5s4MqgH2Y145fz57vQZXgeJJD7VDwJqX4ikLXXWBC8Hrzex3e7/lk8t8JZgqxuR6uA1gPIjUh5eL+vq3WnN7v8uB+bhVaYikj4ygP3wHtr22Z3K6pem/Fq/1MOrV0rwOl7KUgHeO9mbItJqvCUilwFL8eoadcrETxO8FTM68WuZtsUbzdB0d6qPd3+phTfaqhivPMvKdRdeI3397rQOWInXwbYA75unojidj0SnE16574f37W07vIlIW+JdE7V3pxx+/VuO/Btew69/twvxGler43gOErwmqH4QtS9ERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERCSpZIQdgIiIiEiSagIMAYYC/YCWQAugAbAT2AYsAxYAPwBfAzOBXfEPVURERERERERstQVeAFYCJiKVAD8CtwK1QopPfrUf8DiQz55lVVMqAl4Husc9ahEREUkaGlkjIiISvnbAd0DzKD77ITAcr+GfCDoAA/E6mwBWAJ/u/m+qqQXcC4wFMmPc13rgCLxRNzb2AQbhXTOG1M5vERERERERkdC8iN3ojLPDCbOCjsDbQCmVjwR6A2gfWnTu7QN8hf1ImurSfy2OX5bfJZXspwQYvztGERERSQEaWSMiIhK+VUBri88/AVweUCzR6Au8DzSr4XMbgKOB2YFHFKxmePPNdI78h27dujFq1CiGDh1K165dad68OQ0aNGD79u1s3ryZhQsX8vPPPzNz5ky+/PJLfvrpp/Kbr8QbIVOTPsDHQKMaPrcJb/6c76M6KxERERERERGpUoWREpEmTJgQOZJiYoixNqLyeXWqSkuB+qFE6kYOMIWI8+ratat54403TGlp6R7lVZVVq1ZF5s26KI7fAK8zzya/6zk8fxEREQlBdtgBiIiISFK5CmhT/hd9+vRh4MCBlJSUMG3aNGbPrjCQZh/gd8A9cYzRpT/grfj0i1NPPZVnnnmGhg0bWu1owYI9pqdZGsVmY4kYddW7d28GDhyIMYZPP/20svweS/Lmt4iIiIiIiEhCSKaRNTPKxzJ27NgKo0tKSkrMmDFjIuOdEWK8sWgCbKbcuRxzzDGmuLi4ytEzW7duNYsXLzZLliwxmzdvrvBvTz75ZGS+vBBFDHvkd3mlpaXmyiuvTJX8FhEREREREUkYydRZs718LKtXr94j3pUrV0bGuy3EeGNxG+XOo2XLlnt0wBhjzOrVq831119vOnXqtMdrSU2bNjVHHXWUue2228xZZ50V+e+3RhHDtvLbrFy5co/jL1u2LHK/W91mg4iIiIiIiEj6SabOmp3lY1mzZk2lnRcR8W4PMd5Y5FLuPO677749zvWbb74xe+21l9/VoEZFEUOF/F63bt0eMaxZsyZyvztcZYCIiIiIiIhIukqmzprvysdy3XXXVYi1tLTUXHXVVZHx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yM8d4zMmEREREREREZG0lIm3UpRVR82YMWP26KiZN29eZa9i1Yv3CYmIiIiIiIiIJLMjsOikyc7ONtddd50pKirao7Pm/PPPj/z8xyGcj4iIiEhS05w1IiIi0q/8D0cffTSHHnooK1euJC/Pm7ImOzubJk2acOCBB3LiiSfStu2ec9R+/PHHvPjii5G/fiqooEVEREREREREUtWdlBsNc9ttt+0xYqYmP/74o2nevHnkqJqf0BdDIiIiItYiVzUQERGR9LNX+R9atWpltfHrr7/OoYceysaNG8v/2uBNelwcc3QiIiIiIiIiImnmTcqNiHnjjTdqHEmTl5dnJkyYYAYOHFjV3DZ3hnUyIiIiIskuI+wAREREJHTPA+eW/dChQwd69epFhw4daNiwITk5OQBs376djRs3snjxYr7++msKCgqq2t/DeKNqRERERERERETEh6uwXLa7ipQHXBjf0EVEREREREREUk9tYC7+O2lKgNeBA+IduIiIiIiIiIhIqmoKPAvsIPpOmvnAv4DuIcQrIiIikrI0Z42IiIiUVwfoAXQG2gL1gZzd/7YN2AisB2YDq8IIUERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERERCSe/j+OtUjX3oKIRwAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
var FAVICON_PNG = Uint8Array.from(atob("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"), (c) => c.charCodeAt(0));

// src/ui.js
var ui_default = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>SiteDesk</title>
<link rel="icon" type="image/png" href="/favicon.png" />
<link rel="apple-touch-icon" href="/logo.png" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#000000" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="sitedesk" />
<meta name="mobile-web-app-capable" content="yes" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
:root {
  --bg:#000; --bg2:rgba(255,255,255,.03); --bg3:rgba(255,255,255,.04); --surface:rgba(255,255,255,.035);
  --border:transparent; --border2:transparent;
  --ink:#F2F2F5; --muted:#6B7080; --muted2:#888;
  --amber:#c9a227; --red:#c07070; --blue:#8a9bb5;
  --btn-bg:#F2F2F5; --btn-fg:#000;
  --toast-bg:#F2F2F5; --toast-fg:#000;
  --modal:rgba(8,8,8,.78);
  --radius:16px;
  --font:"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --safe-b: env(safe-area-inset-bottom, 0px);
  --tab-h: 64px;
  --void-on:1;
  --soft-bleed: 0 0 28px 14px rgba(255,255,255,.028), 0 18px 48px -22px rgba(0,0,0,.55);
  --soft-bleed-sm: 0 0 18px 8px rgba(255,255,255,.022), 0 10px 28px -16px rgba(0,0,0,.4);
  --soft-inset: inset 0 0 40px 8px rgba(255,255,255,.012);
  --fade-edge: radial-gradient(ellipse 92% 88% at 50% 42%, var(--surface) 0%, color-mix(in srgb, var(--surface) 55%, transparent) 58%, transparent 78%);
  --fade-well: radial-gradient(ellipse 95% 90% at 50% 40%, var(--bg3) 0%, color-mix(in srgb, var(--bg3) 50%, transparent) 62%, transparent 82%);
  --sep: linear-gradient(90deg, transparent, color-mix(in srgb, var(--ink) 10%, transparent) 18%, color-mix(in srgb, var(--ink) 10%, transparent) 82%, transparent);
}

*{box-sizing:border-box;margin:0;padding:0;}
html{color-scheme:dark;} html,body{min-height:100dvh;background:var(--bg);color:var(--ink);}
html{scrollbar-width:none;} html::-webkit-scrollbar{display:none;}
body{font-family:var(--font);line-height:1.5;font-size:14px;-webkit-font-smoothing:antialiased;overflow-x:hidden;background:var(--bg);}
a{color:var(--ink);text-decoration:underline;text-underline-offset:3px;}
button,input,textarea,select{font-family:inherit;font-size:14px;}
.void-shell{min-height:100dvh;position:relative;background:transparent;color:var(--ink);}
.void-shell::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:repeating-conic-gradient(from 0deg at 50% 50%,rgba(255,255,255,.012) 0deg 1deg,transparent 1deg 2deg),
  repeating-radial-gradient(circle at 50% 50%,rgba(255,255,255,.01) 0 1px,transparent 1px 4px),
  radial-gradient(circle at 50% 40%,#000 0%,#050505 18%,#161616 36%,#262626 62%,#0d0d0d 92%,#030303 100%);}
.void-shell::after{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background:radial-gradient(circle at 50% 40%,transparent 40%,rgba(0,0,0,.35) 75%,rgba(0,0,0,.95) 100%);}
.void-shell>*{position:relative;z-index:1;}
.app{min-height:100dvh;display:flex;flex-direction:column;}
.top{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 16px;background:transparent;border:0;outline:none;position:sticky;top:0;z-index:20;
  -webkit-mask-image:linear-gradient(to bottom,#000 70%,transparent);
  mask-image:linear-gradient(to bottom,#000 70%,transparent);}
.brand{font-weight:500;letter-spacing:-.04em;font-size:15px;line-height:1.15;display:flex;flex-direction:column;gap:2px;}
.brand-logo{height:88px;width:auto;display:block;}
.brand-logo.lg{height:128px;}
.brand-logo.home{height:180px;margin:0 auto 20px;}
.home-mark-logo{display:flex;justify-content:center;margin:24px 0 8px;}
.brand-sub{font-size:10px;font-weight:400;letter-spacing:.14em;text-transform:lowercase;color:var(--muted);opacity:.72;line-height:1;}
.home-brand-sub{margin:-10px 0 18px;font-size:12px;letter-spacing:.18em;opacity:.65;}
.nav-desktop{display:none;gap:6px;flex-wrap:wrap;align-items:center;}
.nav-desktop button.tab{background:transparent;border:0;outline:none;color:var(--muted);padding:10px 14px;border-radius:999px;cursor:pointer;min-height:44px;box-shadow:none;}
.nav-desktop button.tab.active{color:var(--btn-fg);background:var(--btn-bg);box-shadow:var(--soft-bleed-sm);}
.main{flex:1;padding:20px 16px calc(var(--tab-h) + var(--safe-b) + 24px);max-width:720px;width:100%;margin:0 auto;}
.main.auth-main{padding-bottom:48px;max-width:420px;}
.card{
  background:var(--fade-edge);
  border:0;outline:none;border-radius:var(--radius);padding:20px 18px;margin-bottom:16px;
  box-shadow:var(--soft-bleed), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 72%, rgba(0,0,0,.75) 90%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 72%, rgba(0,0,0,.75) 90%, transparent 100%);
}
.card h2{font-size:15px;margin-bottom:12px;font-weight:600;letter-spacing:-.02em;}
.card h3{font-size:11px;color:var(--muted);margin-bottom:8px;font-weight:500;text-transform:uppercase;letter-spacing:.08em;}
.grid2{display:grid;grid-template-columns:1fr;gap:14px;}
@media(min-width:640px){.grid2{grid-template-columns:1fr 1fr;}}
label{display:block;font-size:11px;color:var(--muted);margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase;}
.field{margin-bottom:14px;}
.pick{display:flex;flex-wrap:wrap;gap:8px;background:var(--fade-well);padding:6px;border-radius:16px;box-shadow:var(--soft-bleed-sm), var(--soft-inset);}
.pick button{flex:1;min-width:calc(50% - 8px);border:0;outline:none;background:transparent;color:var(--muted);border-radius:12px;padding:12px 10px;min-height:44px;cursor:pointer;font-weight:500;font-size:13px;box-shadow:none;}
.pick button.on{background:var(--btn-bg);color:var(--btn-fg);box-shadow:var(--soft-bleed-sm);}
.pick button:disabled{opacity:.4;cursor:not-allowed;}
.pick.compact button{min-width:auto;flex:0 1 auto;padding:10px 14px;}
select, option{background:#111;color:var(--ink);}
select option{background:#111;color:#F2F2F5;}

input,textarea,select{
  width:100%;background:var(--fade-well);border:0;outline:none;color:var(--ink);
  border-radius:14px;padding:14px;min-height:48px;
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
}
input:focus,textarea:focus,select:focus{
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
  background:radial-gradient(ellipse 95% 90% at 50% 40%, color-mix(in srgb, var(--bg3) 70%, var(--ink) 6%) 0%, transparent 82%);
}
textarea{min-height:100px;resize:vertical;}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--btn-bg);color:var(--btn-fg);border:0;outline:none;border-radius:12px;padding:14px 18px;font-weight:600;cursor:pointer;min-height:48px;text-decoration:none;box-shadow:var(--soft-bleed-sm);}
.btn:disabled{opacity:.35;cursor:not-allowed;}
.btn.ghost{background:var(--fade-well);color:var(--ink);box-shadow:var(--soft-bleed-sm), var(--soft-inset);}
.btn.danger{background:transparent;color:var(--red);box-shadow:none;}
.btn.sm{padding:10px 14px;font-size:13px;min-height:42px;}
.btn.block{width:100%;}
.btn.call{font-size:16px;min-height:56px;}
.btn.sms{background:var(--fade-well);color:var(--ink);box-shadow:var(--soft-bleed-sm), var(--soft-inset);font-size:15px;min-height:52px;}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
.muted{color:var(--muted);} .muted2{color:var(--muted2);}
.err{color:var(--red);font-size:13px;margin-top:8px;}
.okmsg{font-size:13px;margin-top:8px;opacity:.85;}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;background:color-mix(in srgb, var(--ink) 6%, transparent);color:var(--muted);box-shadow:none;border:0;}
.badge.open,.badge.intake_submitted,.badge.building,.badge.payment_sent{color:var(--blue);}
.badge.claimed,.badge.interested{color:var(--amber);}
.badge.paid,.badge.sold,.badge.approved,.badge.head{color:var(--ink);background:color-mix(in srgb, var(--ink) 10%, transparent);}
.badge.pending,.badge.rejected,.badge.closed,.badge.disabled{color:var(--red);}
.home-void{min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px;text-align:center;}
.home-mark{font-size:clamp(2.4rem,11vw,4.2rem);letter-spacing:-.09em;font-weight:400;line-height:1;margin-bottom:8px;}
.home-sub{color:var(--muted);max-width:360px;margin:0 auto 28px;font-size:13px;}
.home-actions{display:flex;flex-direction:column;gap:10px;width:min(320px,100%);}
.home-top{position:absolute;top:0;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:16px 18px;z-index:2;background:transparent;border:0;}
.lead-title{font-size:18px;font-weight:600;margin-bottom:6px;letter-spacing:-.02em;}
.mono{word-break:break-all;}
.copybox{
  background:var(--fade-well);border:0;outline:none;border-radius:14px;padding:14px;
  white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.65;max-height:220px;overflow-y:auto;
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;
  -webkit-mask-image:linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent);
  mask-image:linear-gradient(90deg, transparent, #000 12px, #000 calc(100% - 12px), transparent);}
.table{width:100%;border-collapse:collapse;font-size:12px;min-width:420px;border:0;}
.table th,.table td{text-align:left;padding:12px 8px;border:0;border-bottom:0;vertical-align:top;
  background-image:var(--sep);background-size:100% 1px;background-repeat:no-repeat;background-position:bottom;}
.table th{color:var(--muted);font-weight:500;text-transform:uppercase;letter-spacing:.05em;font-size:10px;}
.empty{padding:28px 16px;text-align:center;color:var(--muted);}
.empty .btn{margin-top:14px;}
.toast{position:fixed;left:50%;bottom:calc(var(--tab-h) + var(--safe-b) + 16px);transform:translateX(-50%) translateY(8px);background:var(--toast-bg);color:var(--toast-fg);padding:12px 16px;border-radius:14px;font-size:12px;font-weight:600;opacity:0;transition:.2s;z-index:60;pointer-events:none;max-width:calc(100% - 32px);border:0;outline:none;box-shadow:var(--soft-bleed);}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
.statrow{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;}
.stat{
  flex:1;min-width:100px;background:var(--fade-well);border:0;outline:none;border-radius:14px;padding:14px;
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
}
.stat .n{font-size:22px;font-weight:700;letter-spacing:-.03em;}
.stat .l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;}
.bottom-nav{
  position:fixed;left:0;right:0;bottom:0;z-index:30;display:flex;justify-content:space-around;
  background:linear-gradient(to top, color-mix(in srgb, var(--bg) 88%, transparent) 40%, transparent);
  border:0;outline:none;padding:6px 4px calc(6px + var(--safe-b));
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
  -webkit-mask-image:linear-gradient(to top, #000 55%, transparent);
  mask-image:linear-gradient(to top, #000 55%, transparent);
  box-shadow:none;
}
.bottom-nav button{flex:1;background:transparent;border:0;outline:none;color:var(--muted);padding:8px 4px;cursor:pointer;font-size:10px;letter-spacing:.04em;text-transform:uppercase;display:flex;flex-direction:column;align-items:center;gap:4px;min-height:52px;font-weight:500;box-shadow:none;}
.bottom-nav button .ico{font-size:18px;line-height:1;}
.bottom-nav button.active{color:var(--ink);}
.thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
.thumb{width:72px;height:72px;border-radius:12px;object-fit:cover;background:var(--fade-well);border:0;box-shadow:var(--soft-bleed-sm);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);}
.thumb-wrap{position:relative;}
.thumb-wrap button.rm{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;background:var(--bg);color:var(--ink);border:0;outline:none;font-size:12px;cursor:pointer;padding:0;min-height:0;box-shadow:var(--soft-bleed-sm);}
.upload-zone{
  border:0;outline:none;border-radius:14px;padding:18px;text-align:center;color:var(--muted);cursor:pointer;display:block;
  background:var(--fade-well);box-shadow:var(--soft-bleed-sm), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
}
.upload-zone input{display:none;}
.upload-zone strong{color:var(--ink);display:block;margin-bottom:4px;}
.checkline{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:12px;color:var(--muted2);min-height:36px;}
.checkline input{width:20px;height:20px;min-height:0;accent-color:var(--ink);box-shadow:none;}
.profile-dl{display:grid;gap:12px;}
.profile-dl div{display:flex;flex-direction:column;gap:2px;}
.profile-dl dt{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;}
.profile-dl dd{font-size:15px;}
.timer{
  font-size:13px;padding:10px 12px;border-radius:14px;border:0;outline:none;
  background:var(--fade-well);margin:10px 0 14px;color:var(--muted2);
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
}
.timer.urgent{color:var(--red);}
.timeline{list-style:none;margin-top:8px;}
.timeline li{padding:10px 0;border:0;border-bottom:0;font-size:12px;
  background-image:var(--sep);background-size:100% 1px;background-repeat:no-repeat;background-position:bottom;}
.timeline .k{font-weight:600;}
.timeline .t{color:var(--muted);font-size:11px;margin-top:2px;}
.filters{display:grid;gap:10px;margin-bottom:14px;}
.chiprow{display:flex;gap:8px;flex-wrap:wrap;}
.chiprow.scroll{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:4px;scrollbar-width:none;}
.chiprow.scroll::-webkit-scrollbar{display:none;}
.chiprow.scroll .chip{flex:0 0 auto;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.chip{background:var(--fade-well);border:0;outline:none;color:var(--muted);border-radius:999px;padding:10px 14px;min-height:40px;cursor:pointer;font-size:12px;box-shadow:var(--soft-bleed-sm), var(--soft-inset);}
.chip.on{background:var(--btn-bg);color:var(--btn-fg);box-shadow:var(--soft-bleed-sm);}
.bell{position:relative;background:transparent;border:0;outline:none;color:var(--muted);font-size:12px;font-weight:600;letter-spacing:.04em;cursor:pointer;min-height:44px;min-width:44px;padding:0 10px;border-radius:999px;box-shadow:none;text-transform:uppercase;}
.bell.has-unread{color:var(--amber);}
.bell .dot{position:absolute;top:8px;right:8px;width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 10px 2px color-mix(in srgb, var(--amber) 45%, transparent);display:none;}
.bell.has-unread .dot{display:block;}
.modal-back{position:fixed;inset:0;background:radial-gradient(circle at 50% 70%, rgba(0,0,0,.35), rgba(0,0,0,.62));z-index:80;display:flex;align-items:flex-end;justify-content:center;padding:16px;}
@media(min-width:640px){.modal-back{align-items:center;}}
.modal{
  background:var(--fade-edge), var(--modal);color:var(--ink);border:0;outline:none;border-radius:20px;padding:22px;
  width:min(440px,100%);max-height:85vh;overflow:auto;
  box-shadow:var(--soft-bleed), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
}
.modal h2{margin-bottom:12px;}
.review-note{padding:2px 0 16px;font-size:13px;line-height:1.6;color:var(--ink);opacity:.88;}
.review-note strong{font-weight:600;}
.lead-row{
  display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px;
  padding:14px 12px;margin-bottom:10px;background:var(--fade-well);border:0;outline:none;border-radius:16px;
  box-shadow:var(--soft-bleed-sm), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
}
.lead-row-name{font-weight:600;letter-spacing:-.02em;}
.board-actions{margin-top:12px;}










/* Alert amber ONLY when there are unread notifications */
.bell{color:var(--muted);}
.bell.has-unread{color:var(--amber);}
.bell .dot{background:var(--amber);box-shadow:0 0 10px 2px color-mix(in srgb, var(--amber) 45%, transparent);}
.bottom-nav button.unread-alert,
.nav-desktop button.tab.unread-alert{color:var(--amber);}
.bottom-nav button.unread-alert.active,
.nav-desktop button.tab.unread-alert.active{color:var(--amber);}
.badge.unread-new{color:var(--amber);background:color-mix(in srgb, var(--amber) 14%, transparent);}
.copybox.tall{max-height:none;min-height:140px;font-size:13px;line-height:1.7;}
.msg-card h2,.script-card h2{margin-bottom:8px;}
.helper-warn{font-size:12px;line-height:1.55;color:var(--amber);margin:0 0 10px;}
.helper-strong{font-size:12px;line-height:1.55;color:var(--ink);opacity:.88;margin:0 0 10px;}
.install-gate{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(circle at 50% 40%, rgba(0,0,0,.55), rgba(0,0,0,.92));}
.install-gate .panel{
  width:min(420px,100%);padding:28px 22px;border-radius:20px;border:0;outline:none;
  background:var(--fade-edge), rgba(8,8,8,.88);
  box-shadow:var(--soft-bleed), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  text-align:left;}
.install-gate h2{font-size:18px;letter-spacing:-.03em;margin-bottom:10px;}
.install-gate ol{margin:12px 0 0 18px;color:var(--muted2);font-size:13px;line-height:1.65;}
.install-gate li{margin-bottom:6px;}
.checklist-ol{margin:0 0 0 18px;padding:0;color:var(--muted2);font-size:13px;line-height:1.65;}
.checklist-ol li{margin-bottom:10px;color:var(--text);}
.checklist-ol strong{color:var(--text);}
.notif-gate{position:fixed;inset:0;z-index:99;display:flex;align-items:center;justify-content:center;padding:20px;
  background:radial-gradient(circle at 50% 40%, rgba(0,0,0,.55), rgba(0,0,0,.92));}
.notif-gate .panel{
  width:min(420px,100%);padding:28px 22px;border-radius:20px;border:0;outline:none;
  background:var(--fade-edge), rgba(8,8,8,.88);
  box-shadow:var(--soft-bleed), var(--soft-inset);
  -webkit-mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  mask-image:radial-gradient(ellipse 100% 100% at 50% 50%, #000 78%, rgba(0,0,0,.8) 92%, transparent 100%);
  text-align:left;}
.notif-gate h2{font-size:18px;letter-spacing:-.03em;margin-bottom:10px;}
.notif-banner{position:sticky;top:0;z-index:40;margin:0 0 12px;padding:12px 14px;border-radius:14px;
  background:rgba(255,196,60,.12);box-shadow:var(--soft-inset);}
.notif-banner .row{gap:10px;align-items:center;flex-wrap:wrap;}

.badge.owed{color:var(--amber);}
.badge.paid_out,.badge.paid{color:var(--ink);background:color-mix(in srgb, var(--ink) 10%, transparent);}
.phone-line{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}
.phone-line .num{font-size:15px;font-weight:600;letter-spacing:-.02em;}

@media(min-width:860px){
  .nav-desktop{display:flex;}
  .bottom-nav{display:none;}
  .main{padding:28px 24px 48px;max-width:920px;}
  .toast{bottom:24px;right:24px;left:auto;transform:translateY(8px);}
  .toast.show{transform:none;}
}
</style>
</head>
<body>
<div id="app" class="app void-shell"></div>
<div id="toast" class="toast"></div>
<div id="modal-root"></div>
<script>
document.documentElement.setAttribute('data-theme','dark');
try{ localStorage.removeItem('sitedesk_theme'); }catch{}

const state={
  user:null, view:'home', tab:'queue',
  meLead:null, myLeads:[], meLeadId:null, queue:[], users:[], inbox:[], reports:[],
  categories:[], uncategorized:0, stats:null, events:[], notifications:[], unread:0, claims:[],
  intakeImages:[], meIntake:null, messages:[], msgDraft:'', q:'', category:'', hasPhone:false,
  userQ:'', userStatus:'', editUser:null, builders:[], inboxScope:null, buildFilter:null,
  showNotifs:false, showReport:null, showRelease:null, showEdit:null, showGrabReview:null, showCallChecklist:null, grabReviewClicked:false, openInboxMsg:null, inboxMsgCache:{},
  err:'', timerId:null,
  adminSection:'users',
  payouts:[], payoutCallers:[], payoutTotals:null, payoutFilter:'ready',
  activity:[], drafts:[],
  mineStatus:'all', mineQ:'',
  leadSlots:null, myPayouts:null,
  pushStatus:null, pushEndpoint:null, notifGateDismissed:false,
  _userQTimer:null, _mineQTimer:null,
  deferredInstallPrompt:null, pwaInstalled:false,
};

async function api(path, opts={}){
  const headers={...(opts.headers||{})};
  let body=opts.body;
  if(body!=null && !(body instanceof FormData)){ headers['Content-Type']='application/json'; body=JSON.stringify(body); }
  const res=await fetch('/api'+path,{credentials:'same-origin',headers,method:opts.method||'GET',body});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||res.statusText||'Request failed');
  return data;
}
function toast(t){ const el=document.getElementById('toast'); el.textContent=t; el.classList.add('show'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('show'),2200); }
function badge(s){ return \`<span class="badge \${s||''}">\${s||'\u2014'}</span>\`; }

function isPwaInstalled(){
  try{
    if(window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    if(window.navigator.standalone === true) return true;
    if(document.referrer && document.referrer.startsWith('android-app://')) return true;
  }catch{}
  return false;
}
function refreshPwaFlag(){
  state.pwaInstalled = isPwaInstalled();
  if(state.pwaInstalled){
    try{ localStorage.setItem('sitedesk_pwa_installed','1'); }catch{}
  }
  // Never use localStorage to skip the gate \u2014 browser tab must still be gated
  return state.pwaInstalled;
}
function payoutMethodLabel(m){
  const map={cash_app:'Cash App',venmo:'Venmo',zelle:'Zelle',paypal:'PayPal',other:'Other'};
  return map[m]||m||'\u2014';
}
function eventKindLabel(k){
  if(k==='commission') return 'payout';
  if(k==='work_done') return 'work done';
  if(k==='paid_to_caller') return 'paid to caller';
  return k||'\u2014';
}
function validEmail(e){ return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(String(e||'').trim()); }
function payStatusBadge(ps){
  if(!ps || ps==='ready_to_pay' || ps==='owed') return '<span class="badge owed">Ready to pay</span>';
  if(ps==='paid_to_caller' || ps==='paid_out' || ps==='paid') return '<span class="badge paid_out">Paid to caller</span>';
  return badge(ps);
}

function pickHtml(id, options, selected, disabled){
  const dis=disabled?'disabled':'';
  return \`<div class="pick" data-pick="\${id}" \${disabled?'data-disabled="1"':''}>
    <input type="hidden" id="\${id}" value="\${esc(selected)}"/>
    \${options.map(([val,label])=>\`<button type="button" class="\${selected===val?'on':''}" data-pick-val="\${esc(val)}" \${dis}>\${esc(label)}</button>\`).join('')}
  </div>\`;
}
function bindPicks(root){
  (root||document).querySelectorAll('[data-pick]').forEach(wrap=>{
    if(wrap.dataset.disabled==='1') return;
    const hid=wrap.querySelector('input[type=hidden]');
    wrap.querySelectorAll('[data-pick-val]').forEach(btn=>{
      btn.onclick=()=>{
        wrap.querySelectorAll('[data-pick-val]').forEach(b=>b.classList.remove('on'));
        btn.classList.add('on');
        if(hid) hid.value=btn.getAttribute('data-pick-val');
      };
    });
  });
}

function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function telHref(p){ const d=String(p||'').replace(/[^\\d+]/g,''); return d?\`tel:\${d}\`:null; }
function smsHref(p,b){ const d=String(p||'').replace(/[^\\d+]/g,''); return d?\`sms:\${d}?&body=\${encodeURIComponent(b||'')}\`:null; }
function hasPhone(p){ const s=String(p||'').trim(); return !!(s && !['\u2014','-','n/a','na','none'].includes(s.toLowerCase())); }
function fmtLeft(iso){ if(!iso) return null; const ms=new Date(iso)-Date.now(); if(ms<=0) return {text:'Expired',urgent:true,ms}; const m=Math.floor(ms/60000), s=Math.floor((ms%60000)/1000); return {text:\`\${m}m \${String(s).padStart(2,'0')}s left\`,urgent:m<5,ms}; }
function isManager(u){ return u && ['head','admin'].includes(u.role); }
function canInbox(u){ return u && ['head','admin','builder'].includes(u.role); }
function canClaim(u){ return u && ['head','admin','caller'].includes(u.role); }


function urlBase64ToUint8Array(base64String){
  const padding='='.repeat((4-base64String.length%4)%4);
  const base64=(base64String+padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw=atob(base64); const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
  return out;
}
async function togglePush(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push not supported in this browser');
  const st=await api('/push/status');
  if(!st.configured) throw new Error('Push not configured');
  if(st.subscribed){
    const reg=await navigator.serviceWorker.getRegistration();
    const sub=await reg?.pushManager?.getSubscription();
    if(sub){
      await api('/push/subscribe',{method:'DELETE',body:{endpoint:sub.endpoint}});
      await sub.unsubscribe();
    } else {
      await api('/push/subscribe',{method:'DELETE',body:{}});
    }
    toast('Push disabled');
    return;
  }
  const perm=await Notification.requestPermission();
  if(perm!=='granted') throw new Error('Notification permission denied');
  const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'});
  await navigator.serviceWorker.ready;
  const keyRes=await api('/push/vapid-public-key');
  if(!keyRes.publicKey) throw new Error('Missing VAPID public key');
  const sub=await reg.pushManager.subscribe({
    userVisibleOnly:true,
    applicationServerKey:urlBase64ToUint8Array(keyRes.publicKey),
  });
  const json=sub.toJSON();
  await api('/push/subscribe',{method:'POST',body:{endpoint:json.endpoint, keys:json.keys}});
  toast('Push enabled');
}

async function boot(){
  try{
    const me=await api('/me');
    state.user=me.user;
    if(state.user){ state.view='app';
      if(!['queue','mine','admin','inbox','reports','profile','notifs'].includes(state.tab)){
        state.tab = state.user.role==='builder' ? 'inbox' : (isManager(state.user)?'admin':'queue');
      }
      if(state.inboxScope==null) state.inboxScope = state.user.role==='builder' ? 'mine' : 'all';
      await refreshApp();
    } else {
      state.view = location.pathname==='/signup'?'signup':location.pathname==='/login'?'login':'home';
    }
  }catch{ state.view='home'; }
  render();
}

async function refreshApp(){
  if(!state.user || state.user.status!=='approved') return;
  try{
    const jobs=[];
    jobs.push(api('/notifications'));
    if(canClaim(state.user)){
      const qs=new URLSearchParams({limit:'10'});
      if(state.q) qs.set('q',state.q);
      if(state.hasPhone) qs.set('has_phone','1');
      const mqs=new URLSearchParams();
      if(state.meLeadId) mqs.set('id', state.meLeadId);
      if(state.mineStatus && state.mineStatus!=='all') mqs.set('status', state.mineStatus);
      if(state.mineQ) mqs.set('q', state.mineQ);
      jobs.push(api('/leads/mine?'+mqs), api('/leads/queue?'+qs), api('/stats/me'), Promise.resolve({categories:[],uncategorized:0}));
      jobs.push(api('/me/payouts').catch(()=>({payouts:[],owed_amt:0,paid_amt:0})));
    } else {
      jobs.push(Promise.resolve({lead:null,leads:[]}), Promise.resolve({leads:[]}), Promise.resolve({stats:null}), Promise.resolve({categories:[]}));
      jobs.push(Promise.resolve({payouts:[],owed_amt:0,paid_amt:0}));
    }
    if(isManager(state.user)){
      const uq=new URLSearchParams();
      if(state.userQ) uq.set('q',state.userQ);
      if(state.userStatus) uq.set('status',state.userStatus);
      const pqs=new URLSearchParams();
      if(state.payoutFilter && state.payoutFilter!=='all') pqs.set('status', state.payoutFilter);
      else pqs.set('status', 'all');
      jobs.push(api('/admin/users?'+uq), api('/admin/reports?status=open'), api('/admin/claims'));
      jobs.push(api('/admin/payouts?'+pqs).catch(()=>({payouts:[],callers:[],totals:{}})));
      jobs.push(api('/admin/activity').catch(()=>({items:[]})));
      jobs.push(api('/drafts').catch(()=>({templates:[]})));
    } else {
      jobs.push(Promise.resolve({users:[]}), Promise.resolve({reports:[]}), Promise.resolve({claims:[]}));
      jobs.push(Promise.resolve({payouts:[],callers:[],totals:{}}));
      jobs.push(Promise.resolve({items:[]}));
      jobs.push(Promise.resolve({templates:[]}));
    }
    if(canInbox(state.user)){
      const scope=state.inboxScope || (state.user.role==='builder'?'mine':'all');
      jobs.push(api('/admin/inbox?scope='+encodeURIComponent(scope)));
    } else jobs.push(Promise.resolve({intakes:[],builders:[]}));
    jobs.push(api('/push/status').catch(()=>({subscribed:false,configured:false})));

    const [notifs, mine, queue, stats, cats, myPay, users, reports, claims, payouts, activity, drafts, inbox, push]=await Promise.all(jobs);
    state.notifications=notifs.notifications||[]; state.unread=notifs.unread||0;
    state.myLeads=mine.leads||(mine.lead?[mine.lead]:[]);
    if(state.meLeadId && state.myLeads.some(l=>l.id===state.meLeadId)){
      state.meLead=state.myLeads.find(l=>l.id===state.meLeadId);
    } else {
      state.meLead=mine.lead||state.myLeads[0]||null;
      state.meLeadId=state.meLead?.id||null;
    }
    state.meIntake=mine.intake||null; state.queue=queue.leads||[]; state.stats=stats.stats;
    state.leadSlots=queue.lead_slots||mine.lead_slots||(stats.stats?{active:stats.stats.active_leads,max:stats.stats.max_active_leads,remaining:stats.stats.remaining_slots}:null);
    state.categories=cats.categories||[]; state.uncategorized=cats.uncategorized||0; state.myPayouts=myPay;
    state.users=users.users||[]; state.reports=reports.reports||[]; state.claims=claims.claims||[];
    state.payouts=payouts.items||payouts.payouts||[]; state.payoutCallers=payouts.callers||[]; state.payoutTotals=payouts.totals||null;
    state.activity=activity.items||[]; state.drafts=drafts.templates||[];
    state.inbox=inbox.intakes||[]; state.builders=inbox.builders||[];
    if(inbox.scope) state.inboxScope=inbox.scope;
    state.pushStatus=push;
    if(state.meLead){
      try{ state.events=(await api('/leads/'+state.meLead.id+'/events')).events||[]; }catch{ state.events=[]; }
    } else state.events=[];
    if(state.meIntake){
      try{ state.messages=(await api('/intakes/'+state.meIntake.id+'/messages')).messages||[]; }catch{ state.messages=[]; }
    } else if(state.tab!=='inbox'){ state.messages=[]; }
  }catch(e){ toast(e.message); }
}

function tabDefs(){
  const u=state.user;
  if(!u||u.status!=='approved') return [['profile','Profile','\u25CE']];
  const tabs=[];
  if(canClaim(u)){ tabs.push(['queue','Queue','\u2630'],['mine','My leads','\u25CF']); }
  if(canInbox(u)) tabs.push(['inbox', u.role==='builder'?'Open builds':'Inbox','\u25A3']);
  if(isManager(u)){ tabs.push(['admin','Admin','\u25C6']); tabs.push(['reports','Reports','\u2691']); }
  tabs.push(['notifs','Alerts', state.unread?String(state.unread):'\xB7']);
  tabs.push(['profile','Profile','\u25CE']);
  return tabs;
}

function shell(content){
  const tabs=tabDefs();
  return \`<header class="top">
    <div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div>
    <div class="row">
      <button class="bell\${state.unread?' has-unread':''}" id="btn-bell" type="button" aria-label="Notifications">\${state.unread?\`<span class="dot"></span>\`:''}\${state.unread?state.unread:'Alerts'}</button>
      <div class="nav-desktop">\${tabs.filter(t=>t[0]!=='notifs').map(([id,label])=>\`<button class="tab \${state.tab===id?'active':''}\${id==='notifs'&&state.unread?' unread-alert':''}" data-tab="\${id}">\${label}</button>\`).join('')}</div>
    </div>
  </header>
  <main class="main">\${notifBannerHtml()}\${content}</main>
  <nav class="bottom-nav">\${tabs.map(([id,label,ico])=>\`<button class="\${state.tab===id?'active':''}\${id==='notifs'&&state.unread?' unread-alert':''}" data-tab="\${id}" type="button"><span class="ico">\${ico}</span><span>\${label}</span></button>\`).join('')}</nav>\`;
}


function renderHome(){
  document.getElementById('app').innerHTML=\`<div class="home-void">
    <div class="home-top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div>
      <div class="row"><button class="btn ghost sm" data-go="login">Login</button></div></div>
    <h1 class="home-mark">sitedesk</h1>
    <div class="brand-sub home-brand-sub">bjvfi</div>
    <div class="home-actions">
      <button class="btn block" data-go="signup">Create account</button>
      <button class="btn ghost block" data-go="login">I have an account</button>
    </div></div>\`;
  bindNav();
}

function renderAuth(mode){
  const title=mode==='signup'?'Create account':'Login';
  document.getElementById('app').innerHTML=\`<header class="top"><div class="brand">sitedesk<div class="brand-sub">bjvfi</div></div>
    <div class="row"><button class="btn ghost sm" data-go="home">Home</button></div></header>
  <div class="main auth-main"><div class="card"><h2>\${title}</h2>
    <p class="muted" style="margin-bottom:16px;font-size:12px">\${mode==='signup'?'Choose caller or builder. An admin confirms your email & phone, then approves you.':'Welcome back.'}</p>
    \${mode==='signup'?\`<div class="field"><label>Name</label><input id="name" autocomplete="name"/></div>\`:''}
    <div class="field"><label>Email</label><input id="email" type="email" autocomplete="email" inputmode="email"/></div>
    \${mode==='signup'?\`<div class="field"><label>Phone</label><input id="phone" type="tel" autocomplete="tel" inputmode="tel"/></div>\`:''}
    \${mode==='signup'?\`<div class="field"><label>I want to join as</label>
      <div class="chiprow" id="signup-role" role="radiogroup" aria-label="Role">
        <button type="button" class="chip on" data-role="caller" aria-pressed="true">Caller</button>
        <button type="button" class="chip" data-role="builder" aria-pressed="false">Builder</button>
      </div>
      <p class="muted" style="font-size:11px;margin-top:8px;line-height:1.5">Callers work leads. Builders handle intakes & sites. Admin/head are assigned later.</p>
    </div>\`:''}
    <div class="field"><label>Password</label><input id="password" type="password"/></div>
    <button class="btn block" id="auth-submit">\${title}</button>
    <div class="err" id="auth-err"></div>
    <p class="muted" style="margin-top:14px;font-size:12px">\${mode==='signup'?\`Have an account? <a href="#" data-go="login">Login</a>\`:\`New here? <a href="#" data-go="signup">Sign up</a>\`}</p>
  </div></div>\`;
  bindNav();
  if(mode==='signup'){
    document.querySelectorAll('#signup-role [data-role]').forEach(btn=>{
      btn.onclick=()=>{
        document.querySelectorAll('#signup-role [data-role]').forEach(b=>{
          b.classList.toggle('on', b===btn);
          b.setAttribute('aria-pressed', b===btn?'true':'false');
        });
      };
    });
  }
  document.getElementById('auth-submit').onclick=async()=>{
    const err=document.getElementById('auth-err'); err.textContent='';
    const emailEl=document.getElementById('email');
    const passwordEl=document.getElementById('password');
    const nameEl=document.getElementById('name');
    const phoneEl=document.getElementById('phone');
    try{
      if(mode==='signup'){
        const roleBtn=document.querySelector('#signup-role .chip.on');
        const role=roleBtn?.getAttribute('data-role')||'caller';
        await api('/auth/signup',{method:'POST',body:{
          email:(emailEl?.value||'').trim(),
          password:passwordEl?.value||'',
          name:(nameEl?.value||'').trim(),
          phone:(phoneEl?.value||'').trim(),
          role,
        }});
        toast('Account created');
      } else {
        await api('/auth/login',{method:'POST',body:{
          email:(emailEl?.value||'').trim(),
          password:passwordEl?.value||'',
        }});
        toast('Logged in');
      }
      await boot();
    }catch(e){ err.textContent=e.message; }
  };
}


function profileCard(){
  const u=state.user;
  const pay=state.myPayouts||{};
  const push=state.pushStatus||{};
  const method=u.payout_method||'';
  const details=u.payout_details||'';
  const methodMissing=!method||!details;
  const items=pay.items||pay.payouts||[];
  return \`<div class="card"><h2>Profile</h2>
    <p class="muted" style="font-size:12px;margin-bottom:12px">Email &amp; phone are confirmed by an admin when they approve you.</p>
    <dl class="profile-dl">
      <div><dt>Name</dt><dd>\${esc(u.name)}</dd></div>
      <div><dt>Email</dt><dd>\${esc(u.email)} \${u.email_confirmed?badge('approved'):badge('pending')}</dd></div>
      <div><dt>Phone</dt><dd>\${esc(u.phone||'\u2014')} \${u.phone?(u.phone_confirmed?badge('approved'):badge('pending')):''}</dd></div>
      <div><dt>Role</dt><dd>\${badge(u.role)}</dd></div>
      <div><dt>Status</dt><dd>\${badge(u.status)}</dd></div>
    </dl>
  </div>
  \${u.status==='approved'?\`<div class="card"><h2>How you get paid</h2>
    <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">Admin pays you outside the app after work is done. Set Cash App / Venmo / Zelle / PayPal so they know where to send it.</p>
    \${methodMissing?\`<p class="helper-warn">Add a payment method so admins can pay you.</p>\`:''}
    <div class="field"><label>Method</label>
      \${pickHtml('payout-method',[
        ['cash_app','Cash App'],['venmo','Venmo'],['zelle','Zelle'],['paypal','PayPal'],['other','Other']
      ], method||'cash_app', false)}
    </div>
    <div class="field"><label>Details</label>
      <input id="payout-details" value="\${esc(details)}" placeholder="Cash App $tag \xB7 Venmo @user \xB7 Zelle phone/email \xB7 PayPal email"/>
    </div>
    <button class="btn block" id="btn-save-payout-method" type="button">Save payment method</button>
    <div class="err" id="payout-method-err"></div>
  </div>
  <div class="card"><h2>Completed work</h2>
    <p class="muted" style="font-size:12px;margin-bottom:12px">When a business pays and the site is done, it shows here. Admin pays you using the method above.</p>
    \${!items.length?\`<p class="muted" style="font-size:12px">Nothing completed yet.</p>\`:
      \`<ul class="timeline">\${items.slice(0,12).map(x=>{
        const label=(!x.payout_status||x.payout_status==='ready_to_pay'||x.payout_status==='owed'||x.status_label==='ready_to_pay')?'Ready to pay':'Paid to you';
        return \`<li><div class="k">\${esc(x.business_name||'')} \xB7 \${esc(label)}</div><div class="t">\${esc(new Date(x.updated_at||x.created_at).toLocaleString())}</div></li>\`;
      }).join('')}</ul>\`}
  </div>
  <div class="card"><h2>Push notifications</h2>
    <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">\${!push.configured?'Push is not configured on the server yet.':push.subscribed?'Alerts are on for this device.':'Turn on alerts for signups, intakes, reports, and payouts.'}</p>
    <div class="row">
      <button class="btn \${push.subscribed?'ghost':''}" id="btn-push-toggle" type="button" \${push.configured?'':'disabled'}>\${push.subscribed?'Disable push':'Enable notifications'}</button>
    </div>
    <p class="muted" style="font-size:11px;margin-top:10px">\${refreshPwaFlag()?(push.subscribed?'You can turn these off anytime.':'Tap Enable \u2014 your phone will ask for permission.'):'Install SiteDesk as an app first (Home Screen), then enable notifications.'}</p>
  </div>\`:''}
  <div class="card"><button class="btn danger block" id="btn-logout">Log out</button></div>\`;
}

function statsRow(){
  const s=state.stats||{claimed_today:0,interested:0,intakes_submitted:0,outcomes_logged:0};
  return \`<div class="statrow">
    <div class="stat"><div class="n">\${s.claimed_today}</div><div class="l">Claimed today</div></div>
    <div class="stat"><div class="n">\${s.interested}</div><div class="l">Interested</div></div>
    <div class="stat"><div class="n">\${s.intakes_submitted}</div><div class="l">Intakes</div></div>
    <div class="stat"><div class="n">\${s.outcomes_logged}</div><div class="l">Outcomes</div></div>
  </div>\`;
}

function claimTimerHtml(lead){
  if(!lead?.claim_expires_at||lead.status!=='claimed') return '';
  const left=fmtLeft(lead.claim_expires_at); if(!left) return '';
  return \`<div class="timer \${left.urgent?'urgent':''}" id="claim-timer" data-expires="\${esc(lead.claim_expires_at)}">\u23F1 \${esc(left.text)}</div>\`;
}

function timelineHtml(){
  if(!state.events.length) return \`<p class="muted" style="font-size:12px">No events yet.</p>\`;
  return \`<ul class="timeline">\${state.events.map(e=>\`<li><div class="k">\${esc(eventKindLabel(e.kind))}\${e.actor_name?' \xB7 '+esc(e.actor_name):''}</div>\${e.note?\`<div>\${esc(e.note)}</div>\`:''}<div class="t">\${esc(new Date(e.created_at).toLocaleString())}</div></li>\`).join('')}</ul>\`;
}


function messageThreadHtml(intakeId, msgs){
  if(!intakeId) return '';
  const list = (msgs||[]).map(m=>\`<div style="padding:10px 0;border-bottom:1px solid var(--border)">
    <div style="font-weight:600;font-size:12px">\${esc(m.author_name)} <span class="badge">\${esc(m.author_role)}</span></div>
    <div style="margin-top:4px;white-space:pre-wrap">\${esc(m.body)}</div>
    <div class="muted" style="font-size:11px;margin-top:4px">\${esc(new Date(m.created_at).toLocaleString())}</div>
  </div>\`).join('') || \`<p class="muted" style="font-size:12px">No messages yet.</p>\`;
  return \`<div>
    <div id="msg-list-\${esc(intakeId)}">\${list}</div>
    <div class="field" style="margin-top:10px"><label>Message</label>
      <textarea id="msg-body-\${esc(intakeId)}" placeholder="Update the team\u2026" rows="3"></textarea></div>
    <button class="btn block" type="button" data-send-msg="\${esc(intakeId)}">Send message</button>
  </div>\`;
}

function leadCard(lead, opts={}){
  if(!lead) return \`<div class="empty">No lead.<br/><button class="btn" data-tab="queue">Go to Queue</button></div>\`;
  const phoneOk=hasPhone(lead.phone)||lead.has_phone;
  const call=phoneOk?telHref(lead.phone):null;
  const sms=phoneOk?smsHref(lead.phone, lead.outreach_draft):null;
  const canRelease=['claimed','interested'].includes(lead.status);
  const preCall=lead.status==='claimed';
  const postInterest=['interested','intake_submitted','sold'].includes(lead.status);
  const cat=(lead.category||'').trim();
  const addr=(lead.address||'').trim();
  return \`
  <div class="lead-title">\${esc(lead.business_name)}</div>
  <div class="row" style="margin:8px 0 10px">\${badge(lead.status)}</div>
  \${claimTimerHtml(lead)}

  \${preCall?\`<p class="review-note"><strong>Before you call or text</strong> \u2014 open their site and learn who they are. Tap the checklist so you know what to ask for on the call.</p>
  <button class="btn block" id="btn-call-checklist" type="button" style="margin:10px 0 4px">What to get on the call</button>\`:''}
  \${postInterest?\`<p class="review-note">They\u2019re interested \u2014 outreach tools are done. Capture build details for the builder.</p>\`:''}

  <div class="card" style="margin:14px 0">
    <h2>\${preCall?'Know them first':'Business'}</h2>
    <p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">\${preCall?'Everything you need before the call.':'Quick reference.'}</p>
    \${cat?\`<div style="font-size:13px;margin-bottom:6px"><strong>Category:</strong> \${esc(cat)}</div>\`:''}
    \${addr?\`<div style="font-size:13px;margin-bottom:6px"><strong>Address:</strong> \${esc(addr)}</div>\`:''}
    <div class="row" style="margin:8px 0">
      <a class="btn \${preCall?'':'ghost'} sm" href="\${esc(lead.site_url)}" target="_blank" rel="noopener">Open site \u2197</a>
      <button class="btn ghost sm" id="btn-copy-link" type="button">Copy site link</button>
    </div>
    <h3 style="margin-top:14px">Business phone</h3>
    <div class="phone-line">
      <span class="num">\${phoneOk?esc(lead.phone):'No phone on file'}</span>
      \${phoneOk?\`<button class="btn ghost sm" id="btn-copy-phone" type="button">Copy phone</button>\`:''}
      \${preCall&&call?\`<a class="btn call sm" href="\${esc(call)}">Call</a>\`:''}
    </div>
  </div>

  \${preCall?\`<div class="card msg-card" style="margin:14px 0">
    <h2>Text / SMS</h2>
    <p class="muted" style="font-size:12px;margin-bottom:10px;line-height:1.55">Guide only \u2014 adapt in your own words.</p>
    <div class="copybox tall" id="draft-text">\${esc(lead.outreach_draft||'')}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn" id="btn-copy-draft" type="button">Copy message</button>
      \${sms?\`<a class="btn sms" href="\${esc(sms)}">Open SMS</a>\`:''}
    </div>
  </div>
  <div class="card script-card" style="margin:14px 0">
    <h2>Call script</h2>
    <p class="muted" style="font-size:12px;margin-bottom:8px;line-height:1.55">Guide only \u2014 don\u2019t read it rigidly.</p>
    <div class="copybox" id="call-script-text">\${esc(lead.call_script||'')}</div>
    <div class="row" style="margin-top:8px">
      <button class="btn ghost sm" id="btn-copy-script" type="button">Copy call script</button>
    </div>
  </div>\`:''}

  <div class="row" style="margin-top:8px">
    \${lead.status==='claimed'?\`<button class="btn ghost sm" id="btn-skip" type="button">Skip lead</button>\`:''}
    \${canRelease?\`<button class="btn danger sm" id="btn-release" type="button">Release lead</button>\`:''}
    <button class="btn ghost sm" id="btn-report" type="button">Report</button>
  </div>
  \${opts.showOutcome && lead.status==='claimed'?outcomeForm():''}
  \${lead.status==='interested' && !state.meIntake?intakeForm():''}
  \${lead.status==='interested' && state.meIntake?\`<div class="card" style="margin:18px 0"><h2>Build details submitted</h2><p class="muted" style="font-size:12px;line-height:1.55">Builders have this intake. Chat below if they need more.</p></div>\`:''}
  \${lead.status==='intake_submitted'?\`<div class="card" style="margin:18px 0"><h2>Build details submitted</h2><p class="muted" style="font-size:12px">Waiting on builders / payment.</p></div>\`:''}
  <div style="margin:20px 0;height:1px;background:var(--sep)"></div>
  <h3>History</h3>\${timelineHtml()}
  \${state.meIntake ? \`<div class="card" style="margin-top:14px"><h2>Build messages</h2>
    <p class="muted" style="font-size:12px;margin-bottom:10px">Coordinate with builders/admins here \u2014 including payment details.</p>
    \${messageThreadHtml(state.meIntake.id, state.messages)}
  </div>\` : ''}\`;
}

function outcomeForm(){
  return \`<div class="card" style="margin:18px 0">
  <h2>Log outcome</h2>
  <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">When they\u2019re <strong>interested</strong>, save that \u2014 then you\u2019ll get the <strong>Add build details</strong> form.</p>
  <div class="field"><label>Outcome</label>
    \${pickHtml('outcome',[
      ['sent_message','sent message'],['called_no_answer','no answer'],
      ['spoke_interested','interested'],['spoke_not_interested','not interested'],
      ['bad_lead','bad lead'],['sold','sold'],
    ],'spoke_interested',false)}
  </div>
  <div class="field"><label>Note</label><textarea id="outcome-note"></textarea></div>
  <button class="btn block" id="btn-outcome">Save outcome</button><div class="err" id="outcome-err"></div>
</div>\`;
}

function intakeForm(){
  const thumbs=state.intakeImages.map((img,i)=>\`<div class="thumb-wrap"><img class="thumb" src="\${esc(img.preview||img.url)}" alt=""/><button type="button" class="rm" data-rm-img="\${i}">\xD7</button></div>\`).join('');
  return \`<div class="card" id="intake-panel" style="margin:18px 0">
  <h2>Add build details</h2>
  <p class="muted" style="font-size:12px;margin-bottom:14px;line-height:1.55">They\u2019re interested \u2014 capture everything the builder needs. Required before the build starts.</p>
  <div class="field"><label>What they want *</label><textarea id="wants" placeholder="Pages, features, vibe, must-haves\u2026"></textarea></div>
  <div class="grid2"><div class="field"><label>Brand colors *</label><input id="brand_colors" placeholder="e.g. black + gold"/></div>
  <div class="field"><label>Design style *</label><input id="design_style" placeholder="e.g. clean, bold, photo-heavy"/></div></div>
  <div class="field"><label>Logo / images *</label>
    <label class="upload-zone" for="intake-files"><strong>Add photos</strong><span class="muted2" style="font-size:12px">Camera or gallery</span>
    <input id="intake-files" type="file" accept="image/*" capture="environment" multiple/></label>
    <div class="thumbs">\${thumbs}</div></div>
  <div class="field"><label>Business email *</label>
    <p class="helper-strong">Get their real business email \u2014 used for the site/payment link.</p>
    <input id="business_email" type="email" inputmode="email" autocomplete="email" placeholder="owner@business.com" required/>
  </div>
  <div class="field"><label>Contact confirm *</label><textarea id="contact_confirm" placeholder="Who you spoke with, confirmed phone, best time\u2026"></textarea></div>
  <div class="field"><label>Extras</label><textarea id="extras" placeholder="Anything else for the builder"></textarea></div>
  <button class="btn block" id="btn-intake">Submit to builders</button><div class="err" id="intake-err"></div>
</div>\`;
}

function parseLogo(raw){ try{const p=JSON.parse(raw); if(Array.isArray(p)) return p;}catch{} return null; }
function assignPickerHtml(i){
  const name=i.assignee_name || 'Unassigned';
  if(!isManager(state.user)){
    return \`<div class="muted" style="font-size:12px;margin-top:10px">Assigned \xB7 \${esc(name)}</div>\`;
  }
  const builders=state.builders||[];
  return \`<div class="field" style="margin-top:12px"><label>Assign builder</label>
    <div class="chiprow">
      <button type="button" class="chip \${!i.assigned_to?'on':''}" data-assign="\${esc(i.id)}">Unassigned</button>
      \${builders.map(b=>\`<button type="button" class="chip \${i.assigned_to===b.id?'on':''}" data-assign="\${esc(i.id)}" data-assign-user="\${esc(b.id)}">\${esc(b.name)}\${b.role!=='builder'?' \xB7 '+esc(b.role):''}</button>\`).join('')}
    </div>
  </div>\`;
}
function inboxImages(i){
  const list=i.logo_image_list||parseLogo(i.logo_images);
  if(list&&list.length) return \`<div class="thumbs">\${list.map(f=>{const src=typeof f==='string'?f:(f.url||'#'); return \`<a href="\${esc(src)}" target="_blank"><img class="thumb" src="\${esc(src)}" alt=""/></a>\`;}).join('')}</div>\`;
  return \`<p>\${esc(i.logo_images)}</p>\`;
}


function callChecklistHtml(lead){
  const name=esc(lead?.business_name||'this business');
  return \`<div class="modal-back" id="modal-back"><div class="modal">
    <h2>Get these on the call</h2>
    <p class="muted" style="margin-bottom:12px;font-size:13px;line-height:1.55">Before you hang up with <strong>\${name}</strong>, lock in the details builders need. You\u2019ll enter them after you mark <strong>interested</strong>.</p>
    <ol class="checklist-ol">
      <li><strong>Business email</strong> \u2014 real inbox that can get the site / payment link</li>
      <li><strong>What they want</strong> \u2014 pages, features, must-haves</li>
      <li><strong>Brand colors</strong> \u2014 and any logo / photos they\u2019ll send</li>
      <li><strong>Design vibe</strong> \u2014 clean, bold, photo-heavy, etc.</li>
      <li><strong>Contact confirm</strong> \u2014 who you spoke with + best phone</li>
      <li><strong>Extras</strong> \u2014 deadlines, competitors, anything odd</li>
    </ol>
    <p class="muted" style="font-size:12px;margin:12px 0 16px;line-height:1.55">Tip: open their site first, then call. Script and text are guides only.</p>
    <button class="btn block" id="dismiss-call-checklist" type="button">Got it \u2014 start the call</button>
  </div></div>\`;
}

function renderModals(){
  const root=document.getElementById('modal-root');
  if(state.showCallChecklist){
    root.innerHTML=callChecklistHtml(state.showCallChecklist);
  } else if(state.showRelease){
    root.innerHTML=\`<div class="modal-back" id="modal-back"><div class="modal">
      <h2>Release lead?</h2>
      <p class="muted" style="margin-bottom:16px;font-size:13px">Removes this lead from you and returns it to the open queue. You will not auto-grab the next lead.</p>
      <div class="row"><button class="btn danger" id="confirm-release" style="flex:1">Yes, release</button>
      <button class="btn ghost" id="cancel-modal" style="flex:1">Cancel</button></div>
    </div></div>\`;
  } else if(state.showReport){
    const lead=state.showReport;
    root.innerHTML=\`<div class="modal-back" id="modal-back"><div class="modal">
      <h2>Report lead</h2>
      <p class="muted" style="margin-bottom:12px;font-size:12px">\${esc(lead.business_name)}</p>
            <div class="field"><label>Reason</label>
        \${pickHtml('report-reason',[
          ['wrong_number','Wrong number'],['business_closed','Business closed'],
          ['already_has_site','Already has site'],['duplicate','Duplicate'],
          ['abusive_other','Other'],
        ],'wrong_number',false)}
      </div>
      <div class="field"><label>Note (optional)</label><textarea id="report-note"></textarea></div>
      <div class="checkline"><input type="checkbox" id="report-release" checked/> Also release my claim</div>
      <div class="row" style="margin-top:12px"><button class="btn" id="confirm-report" style="flex:1">Submit report</button>
      <button class="btn ghost" id="cancel-modal" style="flex:1">Cancel</button></div>
    </div></div>\`;
  } else if(state.showEdit){
    const u=state.showEdit;
    const isHead=u.role==='head';
    const actor=state.user;
    root.innerHTML=\`<div class="modal-back" id="modal-back"><div class="modal">
      <h2>Edit user</h2>
      <div class="field"><label>Name</label><input id="edit-name" value="\${esc(u.name)}"/></div>
      <div class="field"><label>Phone</label><input id="edit-phone" value="\${esc(u.phone||'')}"/></div>
      <div class="field"><label>Status</label>
        \${pickHtml('edit-status',[['pending','pending'],['approved','approved'],['rejected','rejected'],['disabled','disabled']], u.status, isHead)}
      </div>
      <div class="field"><label>Role</label>
        \${pickHtml('edit-role', [
          ['caller','caller'],['builder','builder'],
          ...(actor.role==='head'?[['admin','admin']]:[]),
          ...(isHead?[['head','head']]:[]),
        ], u.role, isHead)}
      </div>
      <div class="checkline"><input type="checkbox" id="edit-email-c" \${u.email_confirmed?'checked':''}/> Email confirmed</div>
      <div class="checkline"><input type="checkbox" id="edit-phone-c" \${u.phone_confirmed?'checked':''}/> Phone confirmed</div>
      <div class="field"><label>Admin notes (private)</label><textarea id="edit-notes" placeholder="Internal notes \u2014 only head/admin see this">\${esc(u.admin_notes||'')}</textarea></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="confirm-edit" style="flex:1">Save</button>
      <button class="btn ghost" id="cancel-modal" style="flex:1">Cancel</button></div>
      \${!isHead?\`<button class="btn danger block" id="confirm-remove" style="margin-top:12px">Remove user (disable)</button>\`:''}
    </div></div>\`;
  } else if(state.showGrabReview){
    const lead=state.showGrabReview;
    const clicked=!!state.grabReviewClicked;
    root.innerHTML=\`<div class="modal-back" id="modal-back"><div class="modal">
      <h2>Review first</h2>
      <p class="review-note" style="margin-bottom:12px">Before you claim <strong>\${esc(lead.business_name||'this lead')}</strong>, learn them first \u2014 open the site, note what they do and how they sound \u2014 so the call/text lands naturally.</p>
      \${(lead.category||'').trim()?\`<p class="muted" style="font-size:12px;margin-bottom:6px"><strong>Category:</strong> \${esc(lead.category)}</p>\`:''}
      \${(lead.address||'').trim()?\`<p class="muted" style="font-size:12px;margin-bottom:10px"><strong>Address:</strong> \${esc(lead.address)}</p>\`:''}
      <a class="btn block" id="grab-review-site" href="\${esc(lead.site_url||'#')}" target="_blank" rel="noopener" style="margin-bottom:12px">Open business site \u2197</a>
      <p class="muted" style="margin-bottom:14px;font-size:12px;line-height:1.55">\${clicked?'Site opened \u2014 when you\u2019re ready, confirm to claim.':'Tap the site link above to unlock Grab.'}</p>
      <p class="muted" style="margin-bottom:16px;font-size:12px;line-height:1.55">The call / text script is <strong>just a guide</strong> \u2014 don\u2019t stick rigidly to it. Use your own words and adapt.</p>
      <div class="row"><button class="btn" id="confirm-grab" style="flex:1" \${clicked?'':'disabled'}>Confirm \xB7 Grab</button>
      <button class="btn ghost" id="cancel-modal" style="flex:1">Cancel</button></div>
    </div></div>\`;
  } else if(state.showNotifs){
    root.innerHTML=\`<div class="modal-back" id="modal-back"><div class="modal">
      <h2>Notifications</h2>
      \${!state.notifications.length?\`<div class="empty">No notifications yet.</div>\`:
        state.notifications.map(n=>\`<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div style="font-weight:600">\${esc(n.title)} \${n.read_at?'':'<span class="badge unread-new">new</span>'}</div>
          <div class="muted" style="font-size:12px">\${esc(n.body||'')}</div>
          <div class="muted" style="font-size:11px;margin-top:4px">\${esc(new Date(n.created_at).toLocaleString())}</div>
        </div>\`).join('')}
      <div class="row" style="margin-top:14px"><button class="btn ghost" id="mark-read" style="flex:1">Mark all read</button>
      <button class="btn" id="cancel-modal" style="flex:1">Close</button></div>
    </div></div>\`;
  } else root.innerHTML='';
  bindModals();
}

function renderApp(){
  if(state.user.status!=='approved' && state.tab!=='profile'){
    document.getElementById('app').innerHTML=shell(\`<div class="card"><h2>Pending approval</h2>
      <p class="muted">Hi \${esc(state.user.name)} \u2014 status <strong>\${esc(state.user.status)}</strong>.</p></div>\${profileCard()}\`);
    bindApp(); renderModals(); return;
  }
  // Builders never use the caller queue / my-leads desk
  if(state.user.role==='builder' && (state.tab==='queue' || state.tab==='mine')) state.tab='inbox';
  let body='';
  if(state.tab==='profile') body=profileCard();
  else if(state.tab==='notifs'){
    body=\`<div class="card"><h2>Alerts</h2>
      \${!state.notifications.length?\`<div class="empty">No notifications.<br/><span class="muted" style="font-size:12px">Approvals, intakes, and reports show up here.</span></div>\`:
      state.notifications.map(n=>\`<div style="padding:12px 0;border-bottom:1px solid var(--border)">
        <div style="font-weight:600">\${esc(n.title)} \${n.read_at?'':'<span class="badge unread-new">new</span>'}</div><div class="muted" style="font-size:12px">\${esc(n.body||'')}</div>
        <div class="muted" style="font-size:11px">\${esc(new Date(n.created_at).toLocaleString())}</div></div>\`).join('')}
      <button class="btn ghost block" id="mark-read" style="margin-top:12px">Mark all read</button></div>\`;
  } else if(state.tab==='queue'){
    const slots=state.leadSlots||{};
    const rem=slots.remaining!=null?slots.remaining:null;
    const atCap=rem===0;
    body=\`\${statsRow()}
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <div><h2 style="font-size:18px">Open leads</h2><p class="muted" style="font-size:12px">Unclaimed only \xB7 scattered \xB7 45 min claim\${rem!=null?\` \xB7 <strong>\${rem}</strong> slot\${rem===1?'':'s'} left\`:''}</p></div>
      <button class="btn sm" id="btn-grab" \${atCap?'disabled':''}>Grab random</button></div>
    \${atCap?\`<p class="err" style="margin-bottom:12px">Lead cap reached (\${slots.active}/\${slots.max}). Release or finish an active lead first.</p>\`:''}
    <p class="review-note"><strong>Review first.</strong> Open the business page and understand who they are \u2014 what they do, how they sound \u2014 before you call or send a message.</p>
    <div class="card"><h2>Board</h2>
      <div class="filters">
        <input id="queue-q" value="\${esc(state.q)}" placeholder="Name, slug, phone"/>
        <div class="chiprow">
          <button type="button" class="chip \${state.hasPhone?'on':''}" id="chip-phone">Has phone</button>
          <button type="button" class="btn sm" id="btn-filter">Apply</button>
        </div>
      </div>
      \${state.queue.length?\`<div class="open-board">
        \${state.queue.map(l=>\`<div class="lead-row">
          <div>
            <div class="lead-row-name">\${esc(l.business_name)}</div>
            <div class="muted" style="font-size:12px">\${hasPhone(l.phone)?esc(l.phone):'\u2014'}</div>
          </div>
          <div class="row">
            <a class="btn ghost sm" href="\${esc(l.site_url)}" target="_blank" rel="noopener">site</a>
            <button class="btn sm" data-grab-id="\${esc(l.id)}" type="button" \${atCap?'disabled':''}>Grab</button>
          </div>
        </div>\`).join('')}
      </div>
      <div class="board-actions"><button class="btn ghost block" id="btn-next-batch" type="button">Next \xB7 scatter more</button></div>\`
      :\`<div class="empty">No open leads.\${false?'':\`<br/><button class="btn" id="btn-grab-empty">Grab random</button>\`}</div>\`}
    </div>\`;
  } else if(state.tab==='mine'){
    const list=state.myLeads||[];
    body=\`\${statsRow()}
    <div class="card"><h2>My leads \${list.length?\`\xB7 \${list.length}\`:''}</h2>
      <div class="filters">
        <input id="mine-q" value="\${esc(state.mineQ)}" placeholder="Search business or phone"/>
        <div class="chiprow">
          \${[['all','All'],['claimed','Claimed'],['interested','Interested'],['intake_submitted','Intake'],['sold','Sold']].map(([v,l])=>
            \`<button type="button" class="chip \${state.mineStatus===v?'on':''}" data-mine-status="\${v}">\${l}</button>\`).join('')}
        </div>
      </div>
      \${!list.length?\`<div class="empty">No leads match.<br/><button class="btn" data-tab="queue">Grab from queue</button></div>\`:
        \`<div class="pick compact" style="margin-bottom:14px">\${list.map(l=>\`<button type="button" class="\${state.meLeadId===l.id?'on':''}" data-open-mine="\${l.id}">\${esc(l.business_name)} <span class="muted" style="font-size:10px">\${esc(l.status)}</span></button>\`).join('')}</div>
         \${state.meLead?leadCard(state.meLead,{showOutcome:true}):''}\`}</div>\`;
  } else if(state.tab==='admin'){
    const sec=state.adminSection||'users';
    const secNav=\`<div class="chiprow" style="margin-bottom:14px">
      \${[['users','Users'],['payouts','Pay callers'],['activity','Activity'],['drafts','Drafts'],['tools','Tools']].map(([v,l])=>
        \`<button type="button" class="chip \${sec===v?'on':''}" data-admin-sec="\${v}">\${l}</button>\`).join('')}
    </div>\`;
    if(sec==='users'){
      body=\`<div class="card"><h2>Users</h2>\${secNav}
      <div class="filters"><input id="user-q" value="\${esc(state.userQ)}" placeholder="Search name, email, phone"/>
      <div class="chiprow">
        \${[['','All'],['pending','Pending'],['approved','Approved'],['rejected','Rejected'],['disabled','Disabled']].map(([v,l])=>
          \`<button type="button" class="chip \${state.userStatus===v?'on':''}" data-ustatus="\${v}">\${l}</button>\`).join('')}
      </div></div>
      <p class="muted" style="font-size:11px;margin-bottom:10px">\${state.users.length} shown \xB7 chips &amp; search refine live</p>
      \${!state.users.length?\`<div class="empty">No users match.</div>\`:state.users.map(u=>\`
        <div class="card" style="background:var(--bg3);margin-bottom:10px;padding:14px">
          <div class="row" style="justify-content:space-between;margin-bottom:8px">
            <div><div style="font-weight:600">\${esc(u.name)}</div>
              <div class="muted" style="font-size:12px">\${esc(u.email)}</div>
              <div class="muted" style="font-size:12px">\${esc(u.phone||'no phone')}</div>
              \${u.payout_method?\`<div class="muted" style="font-size:12px">Pay: \${esc(payoutMethodLabel(u.payout_method))}\${u.payout_details?' \xB7 '+esc(u.payout_details):''}</div>\`:''}
            </div>
            \${badge(u.status)}
          </div>
          <div class="row" style="margin-bottom:8px">\${badge(u.role)}
            <span class="badge \${u.email_confirmed?'approved':'pending'}">email \${u.email_confirmed?'\u2713':'\u2014'}</span>
            <span class="badge \${u.phone_confirmed?'approved':'pending'}">phone \${u.phone_confirmed?'\u2713':'\u2014'}</span>
          </div>
          \${u.admin_notes?\`<p class="muted" style="font-size:12px;margin-bottom:8px">Notes: \${esc(u.admin_notes).slice(0,120)}</p>\`:''}
          \${u.status==='pending'?\`
            <div class="checkline"><input type="checkbox" id="ce-\${u.id}" \${u.email_confirmed?'checked':''}/> Confirm email</div>
            <div class="checkline"><input type="checkbox" id="cp-\${u.id}" \${u.phone_confirmed?'checked':''}/> Confirm phone</div>
            <div class="row" style="margin-top:10px">
              <button class="btn sm" data-approve="\${u.id}">Approve</button>
              <button class="btn ghost sm" data-reject="\${u.id}">Reject</button>
            </div>\`:''}
          <div class="row" style="margin-top:8px">
            <button class="btn ghost sm" data-edit-user="\${u.id}">Edit</button>
            \${state.user.role==='head'&&u.role!=='admin'&&u.role!=='head'&&u.status==='approved'?\`<button class="btn ghost sm" data-make-admin="\${u.id}">Make admin</button>\`:''}
          </div>
        </div>\`).join('')}
    </div>
    <div class="card"><h2>Active claims</h2>
      <p class="muted" style="font-size:12px;margin-bottom:12px">Unlock puts a lead back in the open queue.</p>
      \${!(state.claims||[]).length?\`<div class="empty">No claimed leads right now.</div>\`:
        (state.claims||[]).map(c=>\`<div class="lead-row" style="margin-bottom:10px">
          <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
            <div style="min-width:0">
              <div class="lead-title">\${esc(c.business_name)}</div>
              <div class="muted" style="font-size:12px">\${badge(c.status)} \xB7 \${esc(c.caller_name||'Unknown')} \xB7 \${esc(c.phone||'no phone')}</div>
              <div class="muted" style="font-size:11px;margin-top:4px">Claimed \${c.claimed_at?esc(new Date(c.claimed_at).toLocaleString()):'\u2014'}\${c.claim_expires_at?' \xB7 expires '+esc(new Date(c.claim_expires_at).toLocaleString()):''}</div>
            </div>
            <div class="row">
              <a class="btn ghost sm" href="\${esc(c.site_url)}" target="_blank" rel="noopener">Site</a>
              <button class="btn ghost sm" data-unlock="\${c.id}" type="button">Unlock</button>
            </div>
          </div>
        </div>\`).join('')}
      <div class="err" id="unlock-err"></div></div>\`;
    } else if(sec==='payouts'){
      const t=state.payoutTotals||{};
      const items=state.payouts||[];
      body=\`<div class="card"><h2>Pay callers</h2>\${secNav}
        <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">When an intake is business-paid and work is done, it lands here. Pay the caller yourself (Cash App / Venmo / etc), then mark paid to caller. Use build messages to coordinate.</p>
        <div class="statrow">
          <div class="stat"><div class="n">\${Number(t.ready_n||t.owed_n||0)}</div><div class="l">Ready to pay</div></div>
          <div class="stat"><div class="n">\${Number(t.paid_n||0)}</div><div class="l">Paid to caller</div></div>
        </div>
        <div class="chiprow" style="margin-bottom:14px">
          \${[['ready','Ready to pay'],['paid_to_caller','Paid to caller'],['all','All']].map(([v,l])=>
            \`<button type="button" class="chip \${state.payoutFilter===v?'on':''}" data-payout-filter="\${v}">\${l}</button>\`).join('')}
        </div>
        \${!items.length?\`<div class="empty">No completed work in this filter.</div>\`:
          items.map(x=>\`<div class="lead-row" style="align-items:flex-start">
            <div style="min-width:0;flex:1">
              <div class="lead-row-name">\${esc(x.business_name||'')}</div>
              <div class="muted" style="font-size:12px;margin-top:4px">\${esc(x.caller_name||'')} \xB7 \${payStatusBadge(x.payout_status||x.status_label)}</div>
              <div class="muted" style="font-size:12px;margin-top:4px">Pay via: <strong>\${esc(payoutMethodLabel(x.caller_payout_method))}</strong>\${x.caller_payout_details?' \xB7 '+esc(x.caller_payout_details):' \xB7 <span style="color:var(--amber)">no method on file</span>'}</div>
              \${x.business_email?\`<div class="muted" style="font-size:12px;margin-top:4px">Business email: \${esc(x.business_email)}</div>\`:''}
              <div class="muted" style="font-size:11px;margin-top:4px">\${esc(new Date(x.updated_at||x.created_at).toLocaleString())}</div>
            </div>
            <div class="row">
              \${(x.payout_status==='ready_to_pay'||x.payout_status==='owed'||!x.payout_status||x.status_label==='ready_to_pay')?\`<button class="btn sm" data-mark-paid-caller="\${x.id}" type="button">Mark paid to caller</button>\`:''}
              <button class="btn ghost sm" data-open-msgs="\${x.id}" type="button">Messages</button>
            </div>
            \${state.openInboxMsg===x.id?\`<div style="width:100%;margin-top:10px" class="card">\${messageThreadHtml(x.id, state.inboxMsgCache[x.id]||[])}</div>\`:''}
          </div>\`).join('')}
      </div>\`;
    } else if(sec==='activity'){
      body=\`<div class="card"><h2>Activity</h2>\${secNav}
        <p class="muted" style="font-size:12px;margin-bottom:12px">Recent lead events, signups, and reports.</p>
        \${!(state.activity||[]).length?\`<div class="empty">Nothing yet.</div>\`:
          \`<ul class="timeline">\${(state.activity||[]).map(a=>\`<li>
            <div class="k">\${esc(a.title)} <span class="badge">\${esc(a.source)}</span></div>
            <div>\${esc(a.body||'')}</div>
            <div class="t">\${esc(new Date(a.at).toLocaleString())}</div>
          </li>\`).join('')}</ul>\`}
      </div>\`;
    } else if(sec==='drafts'){
      const globals=(state.drafts||[]).filter(t=>!t.category);
      body=\`<div class="card"><h2>Draft templates</h2>\${secNav}
        <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">Global call &amp; SMS only. Placeholders: {caller} {business} {link} {price}.</p>
        \${!globals.length?\`<div class="empty">No templates \u2014 will seed on next load.</div>\`:
          globals.map(t=>\`<div class="card" style="background:var(--bg3);margin-bottom:12px">
            <div class="row" style="justify-content:space-between;margin-bottom:8px">
              <div>\${badge(t.kind)} <span class="badge">global</span></div>
              <span class="muted" style="font-size:11px">\${t.updated_at?esc(new Date(t.updated_at).toLocaleString()):''}</span>
            </div>
            <div class="field"><label>Body</label><textarea id="draft-body-\${esc(t.id)}" rows="5">\${esc(t.body)}</textarea></div>
            <button class="btn sm" type="button" data-save-draft="\${esc(t.id)}">Save template</button>
          </div>\`).join('')}
      </div>\`;

    } else {
      body=\`<div class="card"><h2>Tools</h2>\${secNav}
        <p class="muted" style="font-size:12px;margin-bottom:12px;line-height:1.55">Pull new slugs from the live sites catalog. Existing leads stay; only empty phones or stale names update.</p>
        <button class="btn" type="button" id="btn-sync-leads">Sync leads from catalog</button>
        <hr style="border:none;margin:20px 0;background:var(--sep);height:1px"/>
        <h3>CSV export</h3>
        <div class="row" style="margin-top:10px">
          <a class="btn ghost sm" href="/api/admin/export/intakes.csv">Export intakes.csv</a>
          <a class="btn ghost sm" href="/api/admin/export/payouts.csv">Export pay-status.csv</a>
        </div>
      </div>\`;
    }
  } else if(state.tab==='reports'){
    body=\`<div class="card"><h2>Reports inbox</h2>
      \${!state.reports.length?\`<div class="empty">No open reports.</div>\`:state.reports.map(r=>\`
        <div class="card" style="background:var(--bg3)">
          <div class="lead-title">\${esc(r.business_name)}</div>
          <div class="muted" style="font-size:12px">\${esc(r.reporter_name)} \xB7 \${esc(r.reason)} \xB7 \${esc(r.phone||'no phone')}</div>
          \${r.note?\`<p style="margin-top:8px">\${esc(r.note)}</p>\`:''}
          <div class="row" style="margin-top:10px">
            <a class="btn ghost sm" href="\${esc(r.site_url)}" target="_blank">Site</a>
            <button class="btn ghost sm" data-resolve="\${r.id}:dismiss">Dismiss</button>
            <button class="btn danger sm" data-resolve="\${r.id}:close_lead">Close as bad lead</button>
          </div>
        </div>\`).join('')}
    </div>\`;
  } else if(state.tab==='inbox'){
    const scope=state.inboxScope || (state.user.role==='builder'?'mine':'all');
    const isBuilder=state.user.role==='builder';
    const buildFilter=state.buildFilter || (isBuilder?'active':'all');
    const activeStatuses=new Set(['submitted','building','payment_sent']);
    const list=(state.inbox||[]).filter(i=>{
      if(buildFilter==='active') return activeStatuses.has(i.status);
      if(buildFilter==='done') return i.status==='paid';
      return true;
    });
    const title=isBuilder?'Open builds':'Inbox';
    const emptyMsg=isBuilder
      ? 'No open builds yet.<br/><span class="muted" style="font-size:12px">When a caller marks interested and submits the packet, it lands here for you to build.</span>'
      : 'No intakes yet.';
    body=\`<div class="card"><h2>\${title}</h2>
      <p class="review-note" style="margin-bottom:12px">\${isBuilder
        ?'<strong>Review the packet.</strong> Read what the caller captured, understand the business context, then build the site.'
        :'Submitted intakes for builders.'}</p>
      \${isBuilder?'':\`<div class="chiprow" style="margin-bottom:10px">
        <button type="button" class="chip \${scope==='mine'?'on':''}" data-inbox-scope="mine">Mine</button>
        <button type="button" class="chip \${scope==='all'?'on':''}" data-inbox-scope="all">All</button>
      </div>\`}
      <div class="chiprow" style="margin-bottom:14px">
        \${isBuilder?\`<button type="button" class="chip \${scope==='mine'?'on':''}" data-inbox-scope="mine">Assigned to me</button>
        <button type="button" class="chip \${scope==='all'?'on':''}" data-inbox-scope="all">Unassigned + mine</button>\`:''}
        <button type="button" class="chip \${buildFilter==='active'?'on':''}" data-build-filter="active">\${isBuilder?'Ready to build':'Need build'}</button>
        <button type="button" class="chip \${buildFilter==='done'?'on':''}" data-build-filter="done">Done</button>
        \${isBuilder?'':\`<button type="button" class="chip \${buildFilter==='all'?'on':''}" data-build-filter="all">Everything</button>\`}
      </div>
      \${!list.length?\`<div class="empty">\${emptyMsg}</div>\`:list.map(i=>\`
        <div class="card" style="background:var(--bg3);margin-bottom:12px">
          <div class="row" style="justify-content:space-between;align-items:flex-start"><div style="flex:1">
            <div class="lead-title">\${esc(i.business_name)}</div>
            <div class="muted" style="font-size:12px;margin-top:4px">Caller \${esc(i.caller_name)} \xB7 \${esc(i.phone||'\u2014')} \xB7 <a href="\${esc(i.site_url)}" target="_blank" rel="noopener">Open site \u2197</a></div>
            \${i.business_email?\`<div style="font-size:13px;margin-top:6px"><strong>Business email:</strong> \${esc(i.business_email)}</div>\`:\`<div class="helper-warn" style="margin-top:6px">No business email on intake</div>\`}
          </div><div class="row" style="flex-wrap:wrap;justify-content:flex-end">\${badge(i.status)}\${i.status==='paid'?payStatusBadge(i.payout_status):''}\${i.assignee_name?\`<span class="badge">\${esc(i.assignee_name)}</span>\`:\`<span class="badge">unassigned</span>\`}</div></div>
          \${assignPickerHtml(i)}
          <div class="grid2" style="margin-top:14px">
            <div><h3>What they want</h3><p style="white-space:pre-wrap">\${esc(i.wants)}</p></div>
            <div><h3>Design</h3><p><strong>Style:</strong> \${esc(i.design_style)}<br/><strong>Colors:</strong> \${esc(i.brand_colors)}</p></div>
            <div><h3>Images / logo</h3>\${inboxImages(i)}</div>
            <div><h3>Contact confirm</h3><p style="white-space:pre-wrap">\${esc(i.contact_confirm)}</p></div>
          </div>
          \${i.extras?\`<div style="margin-top:12px"><h3>Extras</h3><p style="white-space:pre-wrap">\${esc(i.extras)}</p></div>\`:''}
          \${i.status==='paid'?\`<div class="card" style="margin-top:12px;background:var(--bg3)"><h3>Caller payment</h3>
            <p style="font-size:13px">\${esc(payoutMethodLabel(i.caller_payout_method))}\${i.caller_payout_details?' \xB7 '+esc(i.caller_payout_details):' \xB7 <span class="helper-warn">no method on file</span>'}</p>
            \${(!i.payout_status||i.payout_status==='ready_to_pay'||i.payout_status==='owed')&&isManager(state.user)?\`<button class="btn sm" style="margin-top:10px" data-mark-paid-caller="\${i.id}" type="button">Mark paid to caller</button>\`:''}
          </div>\`:''}
          <div class="row" style="margin-top:12px">
            \${i.status==='submitted'?\`<button class="btn sm" data-intake-status="\${i.id}:building">Mark building</button>\`:''}
            \${i.status==='building'?\`<button class="btn sm" data-intake-status="\${i.id}:payment_sent">Payment sent</button>\`:''}
            \${i.status==='payment_sent'?\`<button class="btn sm" data-intake-status="\${i.id}:paid">Mark business paid \xB7 ready to pay</button>\`:''}
            \${i.status==='paid'?\`<span class="okmsg">Business paid \xB7 \${(!i.payout_status||i.payout_status==='ready_to_pay'||i.payout_status==='owed')?'ready to pay caller':'paid to caller'}</span>\`:''}
            <button class="btn \${state.openInboxMsg===i.id?'':'ghost'} sm" data-open-msgs="\${i.id}" type="button">\${state.openInboxMsg===i.id?'Hide messages':'Messages'}</button>
          </div>
          \${state.openInboxMsg===i.id?\`<div class="card" style="margin-top:12px"><h2>Messages</h2><p class="muted" style="font-size:12px;margin-bottom:8px">Coordinate build + payment here.</p>\${messageThreadHtml(i.id, state.inboxMsgCache[i.id]||[])}</div>\`:''}
        </div>\`).join('')}
    </div>\`;
  }
  document.getElementById('app').innerHTML=shell(body);
  bindApp(); renderModals(); startTimerTick();
  if(state._focusField){
    const el=document.getElementById(state._focusField);
    if(el){ el.focus(); try{ const p=state._focusPos??el.value.length; el.setSelectionRange(p,p);}catch{} }
    state._focusField=null;
  }
}

function startTimerTick(){
  if(state.timerId) clearInterval(state.timerId);
  const el=document.getElementById('claim-timer'); if(!el) return;
  state.timerId=setInterval(()=>{
    const iso=el.getAttribute('data-expires'); const left=fmtLeft(iso); if(!left) return;
    el.textContent=\`\u23F1 \${left.text}\`; el.classList.toggle('urgent', left.urgent);
    if(left.ms<=0){ clearInterval(state.timerId); toast('Claim expired'); refreshApp().then(render); }
  },1000);
}

function syncPath(){
  const path = state.view==='home' ? '/' : (state.view==='app' ? '/app' : '/'+state.view);
  if(location.pathname !== path) history.replaceState(null,'',path);
}
function bindNav(){
  document.querySelectorAll('[data-go]').forEach(el=>{
    el.onclick=(e)=>{ e.preventDefault(); state.view=el.getAttribute('data-go'); syncPath(); render(); };
  });
}
function bindModals(){
  const cancel=document.getElementById('cancel-modal');
  if(cancel) cancel.onclick=()=>{ state.showRelease=null; state.showReport=null; state.showEdit=null; state.showGrabReview=null; state.showCallChecklist=null; state.grabReviewClicked=false; state.showNotifs=false; renderModals(); };
  const dcc=document.getElementById('dismiss-call-checklist');
  if(dcc) dcc.onclick=()=>{ state.showCallChecklist=null; renderModals(); };

  const back=document.getElementById('modal-back');
  if(back) back.onclick=(e)=>{ if(e.target===back){ state.showRelease=null; state.showReport=null; state.showEdit=null; state.showGrabReview=null; state.showCallChecklist=null; state.grabReviewClicked=false; state.showNotifs=false; renderModals(); } };
  const cr=document.getElementById('confirm-release');
  if(cr) cr.onclick=async()=>{
    try{ await api('/leads/'+state.meLead.id+'/release',{method:'POST',body:{}}); state.meLead=null; state.showRelease=null; state.intakeImages=[]; toast('Lead released'); await refreshApp(); render(); }
    catch(e){ toast(e.message); }
  };
  const crep=document.getElementById('confirm-report');
  if(crep) crep.onclick=async()=>{
    try{
      const lead=state.showReport;
      await api('/leads/'+lead.id+'/report',{method:'POST',body:{
        reason:document.getElementById('report-reason').value,
        note:document.getElementById('report-note').value,
        release:!!document.getElementById('report-release')?.checked,
      }});
      state.showReport=null; toast('Report submitted'); await refreshApp(); render();
    }catch(e){ toast(e.message); }
  };
  bindPicks(document.getElementById('modal-root'));
  const cedit=document.getElementById('confirm-edit');
  if(cedit) cedit.onclick=async()=>{
    try{
      await api('/admin/users/'+state.showEdit.id,{method:'PATCH',body:{
        name:document.getElementById('edit-name').value.trim(),
        phone:document.getElementById('edit-phone').value.trim(),
        status:document.getElementById('edit-status').value,
        role:document.getElementById('edit-role').value,
        email_confirmed:document.getElementById('edit-email-c').checked,
        phone_confirmed:document.getElementById('edit-phone-c').checked,
        admin_notes:document.getElementById('edit-notes').value,
      }});
      state.showEdit=null; toast('User updated'); await refreshApp(); render();
    }catch(e){ toast(e.message); }
  };
  const crem=document.getElementById('confirm-remove');
  if(crem) crem.onclick=async()=>{
    if(!confirm('Disable this user?')) return;
    try{ await api('/admin/users/'+state.showEdit.id+'/remove',{method:'POST',body:{}}); state.showEdit=null; toast('User disabled'); await refreshApp(); render(); }
    catch(e){ toast(e.message); }
  };
  const siteBtn=document.getElementById('grab-review-site');
  if(siteBtn) siteBtn.addEventListener('click',()=>{
    if(!state.grabReviewClicked){
      state.grabReviewClicked=true;
      const confirmBtn=document.getElementById('confirm-grab');
      if(confirmBtn) confirmBtn.disabled=false;
      const hint=siteBtn.nextElementSibling;
      if(hint) hint.innerHTML='Site opened \u2014 when you\u2019re ready, confirm to claim.';
    }
  });
  const cg=document.getElementById('confirm-grab');
  if(cg) cg.onclick=async()=>{
    if(!state.grabReviewClicked || !state.showGrabReview) return;
    const leadId=state.showGrabReview.id;
    try{
      const r=await api('/leads/grab',{method:'POST',body:leadId?{lead_id:leadId}:{}});
      state.meLead=r.lead; state.meLeadId=r.lead?.id||null; state.tab='mine'; state.intakeImages=[];
      state.showGrabReview=null; state.grabReviewClicked=false;
      toast('Claimed'); await refreshApp(); state.showCallChecklist=r.lead; render();
    }catch(e){ toast(e.message); }
  };
  const mr=document.getElementById('mark-read');
  if(mr) mr.onclick=async()=>{ await api('/notifications/read',{method:'POST',body:{}}); state.showNotifs=false; await refreshApp(); render(); toast('Marked read'); };
}

function bindApp(){
 
  const logout=document.getElementById('btn-logout');
  if(logout) logout.onclick=async()=>{ await api('/auth/logout',{method:'POST',body:{}}); state.user=null; state.view='home'; toast('Logged out'); render(); };

  document.querySelectorAll('[data-tab]').forEach(btn=>{
    btn.onclick=async()=>{ state.tab=btn.getAttribute('data-tab'); await refreshApp(); render(); };
  });
  const bell=document.getElementById('btn-bell');
  if(bell) bell.onclick=()=>{ state.showNotifs=true; renderModals(); };

  const applyFilter=async()=>{ state.q=document.getElementById('queue-q')?.value.trim()||''; await refreshApp(); render(); toast('Filtered'); };
  document.getElementById('btn-filter')&&(document.getElementById('btn-filter').onclick=applyFilter);
  document.getElementById('chip-phone')&&(document.getElementById('chip-phone').onclick=async()=>{ state.hasPhone=!state.hasPhone; await refreshApp(); render(); });
  document.querySelectorAll('[data-ustatus]').forEach(b=>b.onclick=async()=>{
    state.userStatus=b.getAttribute('data-ustatus');
    await refreshApp(); render();
  });
  const userQEl=document.getElementById('user-q');
  if(userQEl){
    userQEl.oninput=()=>{
      clearTimeout(state._userQTimer);
      const val=userQEl.value;
      state._userQTimer=setTimeout(async()=>{
        state.userQ=val.trim();
        state._focusField='user-q';
        state._focusPos=userQEl.selectionStart;
        await refreshApp(); render();
      }, 320);
    };
  }
  document.querySelectorAll('[data-admin-sec]').forEach(b=>b.onclick=async()=>{
    state.adminSection=b.getAttribute('data-admin-sec');
    await refreshApp(); render();
  });
  document.querySelectorAll('[data-payout-filter]').forEach(b=>b.onclick=async()=>{
    state.payoutFilter=b.getAttribute('data-payout-filter');
    await refreshApp(); render();
  });
  document.querySelectorAll('[data-mark-paid-caller]').forEach(b=>b.onclick=async()=>{
    const id=b.getAttribute('data-mark-paid-caller');
    try{
      await api('/admin/intakes/'+id+'/mark-paid-to-caller',{method:'POST',body:{}});
      toast('Marked paid to caller'); await refreshApp(); render();
    }catch(e){
      if(String(e.message||'').toLowerCase().includes('payment method') || String(e.message||'').toLowerCase().includes('payout method')){
        if(confirm(e.message+'\\n\\nMark paid to caller anyway?')){
          try{
            await api('/admin/intakes/'+id+'/mark-paid-to-caller',{method:'POST',body:{force:true}});
            toast('Marked paid to caller'); await refreshApp(); render();
          }catch(e2){ toast(e2.message); }
        }
      } else toast(e.message);
    }
  });
  document.querySelectorAll('[data-mine-status]').forEach(b=>b.onclick=async()=>{
    state.mineStatus=b.getAttribute('data-mine-status');
    await refreshApp(); render();
  });
  const mineQEl=document.getElementById('mine-q');
  if(mineQEl){
    mineQEl.oninput=()=>{
      clearTimeout(state._mineQTimer);
      const val=mineQEl.value;
      state._mineQTimer=setTimeout(async()=>{
        state.mineQ=val.trim();
        state._focusField='mine-q';
        state._focusPos=mineQEl.selectionStart;
        await refreshApp(); render();
      }, 320);
    };
  }
  document.querySelectorAll('[data-save-draft]').forEach(b=>b.onclick=async()=>{
    const id=b.getAttribute('data-save-draft');
    try{
      await api('/admin/drafts/'+id,{method:'PUT',body:{
        body:document.getElementById('draft-body-'+id)?.value||'',
        category:null,
      }});
      toast('Template saved'); await refreshApp(); render();
    }catch(e){ toast(e.message); }
  });
  document.querySelectorAll('[data-new-kind]').forEach(b=>b.onclick=()=>{
    document.querySelectorAll('[data-new-kind]').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    const hv=document.getElementById('new-draft-kind-val');
    if(hv) hv.value=b.getAttribute('data-new-kind');
  });
  document.getElementById('btn-add-draft')&&(document.getElementById('btn-add-draft').onclick=async()=>{
    try{
      await api('/admin/drafts',{method:'POST',body:{
        kind:document.getElementById('new-draft-kind-val')?.value||'sms',
        category:document.getElementById('new-draft-cat')?.value.trim()||null,
        body:document.getElementById('new-draft-body')?.value||'',
      }});
      toast('Template added'); await refreshApp(); render();
    }catch(e){ toast(e.message); }
  });
  document.getElementById('btn-push-toggle')&&(document.getElementById('btn-push-toggle').onclick=async()=>{
    try{ await togglePush(); state.notifGateDismissed=false; await refreshApp(); render(); }catch(e){ toast(e.message); }
  });
  document.getElementById('btn-banner-enable-notifs')&&(document.getElementById('btn-banner-enable-notifs').onclick=async()=>{
    try{ await togglePush(); state.notifGateDismissed=false; await refreshApp(); render(); }catch(e){ toast(e.message); }
  });
  document.getElementById('btn-save-payout-method')&&(document.getElementById('btn-save-payout-method').onclick=async()=>{
    const err=document.getElementById('payout-method-err'); if(err) err.textContent='';
    const method=document.getElementById('payout-method')?.value||'';
    const details=(document.getElementById('payout-details')?.value||'').trim();
    try{
      const r=await api('/me/payout-method',{method:'PATCH',body:{payout_method:method,payout_details:details}});
      state.user=r.user; toast('Payment method saved'); render();
    }catch(e){ if(err) err.textContent=e.message; else toast(e.message); }
  });

  function openGrabReview(lead){
    if(!lead||!lead.id){ toast('No open leads'); return; }
    state.showGrabReview=lead;
    state.grabReviewClicked=false;
    renderModals();
  }
  async function previewRandomLead(){
    const qs=new URLSearchParams({limit:'1'});
    if(state.q) qs.set('q',state.q);
    if(state.hasPhone) qs.set('has_phone','1');
    const r=await api('/leads/queue?'+qs);
    return (r.leads||[])[0]||null;
  }
  async function startGrabRandom(){
    try{
      const lead=await previewRandomLead();
      if(!lead){ toast('No open leads'); return; }
      openGrabReview(lead);
    }catch(e){ toast(e.message); }
  }
  document.querySelectorAll('[data-open-mine]').forEach(b=>b.onclick=async()=>{
    state.meLeadId=b.getAttribute('data-open-mine');
    state.tab='mine';
    state.intakeImages=[];
    await refreshApp(); render();
  });
  document.getElementById('btn-grab')&&(document.getElementById('btn-grab').onclick=()=>startGrabRandom());
  document.getElementById('btn-grab-empty')&&(document.getElementById('btn-grab-empty').onclick=()=>startGrabRandom());
  document.querySelectorAll('[data-grab-id]').forEach(b=>b.onclick=()=>{
    const id=b.getAttribute('data-grab-id');
    const lead=state.queue.find(l=>l.id===id);
    if(lead) openGrabReview(lead);
    else openGrabReview({id, business_name:'Lead', site_url:'#'});
  });
  document.getElementById('btn-next-batch')&&(document.getElementById('btn-next-batch').onclick=async()=>{
    try{
      const qs=new URLSearchParams({limit:'10'});
      if(state.q) qs.set('q',state.q);
        if(state.hasPhone) qs.set('has_phone','1');
      if(state.queue.length) qs.set('exclude', state.queue.map(l=>l.id).join(','));
      const queue=await api('/leads/queue?'+qs);
      state.queue=queue.leads||[];
      render(); toast('New scatter');
    }catch(e){ toast(e.message); }
  });

  const copy=async(t,m)=>{ await navigator.clipboard.writeText(t||''); toast(m); };
  document.getElementById('btn-copy-draft')&&(document.getElementById('btn-copy-draft').onclick=()=>copy(document.getElementById('draft-text')?.innerText,'Draft copied'));
  document.getElementById('btn-copy-script')&&(document.getElementById('btn-copy-script').onclick=()=>copy(document.getElementById('call-script-text')?.innerText,'Script copied'));
  document.getElementById('btn-copy-link')&&(document.getElementById('btn-copy-link').onclick=()=>copy(state.meLead?.site_url,'Link copied'));
  document.getElementById('btn-copy-phone')&&(document.getElementById('btn-copy-phone').onclick=()=>copy(state.meLead?.phone,'Phone copied'));

  document.getElementById('btn-call-checklist')&&(document.getElementById('btn-call-checklist').onclick=()=>{
    if(state.meLead){ state.showCallChecklist=state.meLead; renderModals(); }
  });
  document.getElementById('btn-skip')&&(document.getElementById('btn-skip').onclick=async()=>{
    try{ await api('/leads/'+state.meLead.id+'/skip',{method:'POST',body:{}}); state.meLead=null; state.intakeImages=[]; toast('Skipped'); await refreshApp(); render(); }catch(e){ toast(e.message); }
  });
  document.getElementById('btn-release')&&(document.getElementById('btn-release').onclick=()=>{ state.showRelease=true; renderModals(); });
  document.getElementById('btn-report')&&(document.getElementById('btn-report').onclick=()=>{ state.showReport=state.meLead; renderModals(); });

  bindPicks(document.getElementById('app'));
  document.getElementById('btn-outcome')&&(document.getElementById('btn-outcome').onclick=async()=>{
    const err=document.getElementById('outcome-err'); err.textContent='';
    const outcomeEl=document.getElementById('outcome');
    const outcomeVal=(outcomeEl&&outcomeEl.value)||'';
    try{
      const r=await api('/leads/'+state.meLead.id+'/outcome',{method:'POST',body:{outcome:outcomeVal,note:document.getElementById('outcome-note').value||''}});
      state.meLead=r.lead; state.meLeadId=r.lead?.id||state.meLeadId; state.tab='mine';
      if(r.lead?.status==='interested') toast('Interested \u2014 add build details below');
      else toast('Saved');
      await refreshApp(); render();
      if(r.lead?.status==='interested'){
        setTimeout(()=>{ document.getElementById('intake-panel')?.scrollIntoView({behavior:'smooth',block:'start'}); }, 80);
      }
    }catch(e){ err.textContent=e.message; }
  });

  const fileInput=document.getElementById('intake-files');
  if(fileInput) fileInput.onchange=async()=>{
    const files=Array.from(fileInput.files||[]); if(!files.length) return;
    const err=document.getElementById('intake-err'); err.textContent='';
    try{ const fd=new FormData(); files.forEach(f=>fd.append('files',f)); const r=await api('/upload',{method:'POST',body:fd});
      (r.files||[]).forEach((meta,i)=>state.intakeImages.push({...meta,preview:files[i]?URL.createObjectURL(files[i]):meta.url}));
      toast('Uploaded '+r.files.length); render();
    }catch(e){ err.textContent=e.message; toast(e.message); }
    fileInput.value='';
  };
  document.querySelectorAll('[data-rm-img]').forEach(b=>b.onclick=()=>{ state.intakeImages.splice(+b.getAttribute('data-rm-img'),1); render(); });
  document.getElementById('btn-intake')&&(document.getElementById('btn-intake').onclick=async()=>{
    const err=document.getElementById('intake-err'); err.textContent='';
    if(!state.intakeImages.length){ err.textContent='Add at least one image'; return; }
    const be=(document.getElementById('business_email')?.value||'').trim();
    if(!validEmail(be)){ err.textContent='Valid business email required \u2014 we need it to send the site/payment'; return; }
    try{ const r=await api('/leads/'+state.meLead.id+'/intake',{method:'POST',body:{
      wants:wants.value.trim(), brand_colors:brand_colors.value.trim(),
      logo_images:state.intakeImages.map(({key,url,content_type,name})=>({key,url,content_type,name})),
      design_style:design_style.value.trim(), contact_confirm:contact_confirm.value.trim(),
      business_email:be, extras:extras.value.trim(),
    }}); state.meLead=r.lead; state.intakeImages=[]; toast('Intake submitted'); await refreshApp(); render(); }
    catch(e){ err.textContent=e.message; }
  });

  document.querySelectorAll('[data-approve]').forEach(b=>b.onclick=async()=>{
    const id=b.getAttribute('data-approve');
    try{ await api('/admin/users/'+id+'/approve',{method:'POST',body:{confirm_email:!!document.getElementById('ce-'+id)?.checked,confirm_phone:!!document.getElementById('cp-'+id)?.checked}}); toast('Approved'); await refreshApp(); render(); }
    catch(e){ toast(e.message); }
  });
  document.querySelectorAll('[data-reject]').forEach(b=>b.onclick=async()=>{ await api('/admin/users/'+b.getAttribute('data-reject')+'/reject',{method:'POST',body:{}}); toast('Rejected'); await refreshApp(); render(); });
  document.querySelectorAll('[data-make-admin]').forEach(b=>b.onclick=async()=>{ try{ await api('/admin/users/'+b.getAttribute('data-make-admin')+'/make-admin',{method:'POST',body:{}}); toast('Admin'); await refreshApp(); render(); }catch(e){ toast(e.message); } });
  document.querySelectorAll('[data-edit-user]').forEach(b=>b.onclick=()=>{ state.showEdit=state.users.find(u=>u.id===b.getAttribute('data-edit-user')); renderModals(); });
  document.querySelectorAll('[data-inbox-scope]').forEach(b=>b.onclick=async()=>{
    state.inboxScope=b.getAttribute('data-inbox-scope');
    await refreshApp(); render();
  });
  document.querySelectorAll('[data-build-filter]').forEach(b=>b.onclick=()=>{
    state.buildFilter=b.getAttribute('data-build-filter');
    render();
  });
  document.querySelectorAll('[data-assign]').forEach(b=>b.onclick=async()=>{
    if(!isManager(state.user)) return;
    const id=b.getAttribute('data-assign');
    const user_id=b.hasAttribute('data-assign-user')?b.getAttribute('data-assign-user'):null;
    try{
      await api('/admin/intakes/'+id+'/assign',{method:'PATCH',body:{user_id}});
      toast(user_id?'Assigned':'Unassigned');
      await refreshApp(); render();
    }catch(e){ toast(e.message); }
  });
  document.getElementById('btn-sync-leads')&&(document.getElementById('btn-sync-leads').onclick=async()=>{
    try{
      const r=await api('/admin/sync-leads',{method:'POST',body:{}});
      toast(\`Sync \xB7 +\${r.inserted} new \xB7 \${r.updated} updated \xB7 \${r.total_leads} leads / \${r.total_catalog} catalog\`);
      await refreshApp(); render();
    }catch(e){ toast(e.message); }
  });
  document.querySelectorAll('[data-intake-status]').forEach(b=>b.onclick=async()=>{ const [id,status]=b.getAttribute('data-intake-status').split(':'); await api('/admin/intakes/'+id+'/status',{method:'POST',body:{status}}); toast(status); await refreshApp(); render(); });
  document.querySelectorAll('[data-resolve]').forEach(b=>b.onclick=async()=>{ const [id,action]=b.getAttribute('data-resolve').split(':'); await api('/admin/reports/'+id+'/resolve',{method:'POST',body:{action}}); toast('Resolved'); await refreshApp(); render(); });
  document.querySelectorAll('[data-unlock]').forEach(b=>b.onclick=async()=>{
    const err=document.getElementById('unlock-err'); if(err) err.textContent='';
    const id=b.getAttribute('data-unlock');
    if(!confirm('Unlock this lead back to the open queue?')) return;
    try{
      await api('/admin/leads/'+id+'/unlock',{method:'POST',body:{}});
      toast('Unlocked'); await refreshApp(); render();
    }catch(e){ if(err) err.textContent=e.message; else toast(e.message); }
  });
  document.getElementById('mark-read')&&(document.getElementById('mark-read').onclick=async()=>{ await api('/notifications/read',{method:'POST',body:{}}); await refreshApp(); render(); toast('Marked read'); });

  document.querySelectorAll('[data-send-msg]').forEach(b=>b.onclick=async()=>{
    const id=b.getAttribute('data-send-msg');
    const ta=document.getElementById('msg-body-'+id);
    const body=(ta?.value||'').trim(); if(!body){ toast('Write a message'); return; }
    try{
      await api('/intakes/'+id+'/messages',{method:'POST',body:{body}});
      toast('Message sent');
      const rr=await api('/intakes/'+id+'/messages');
      if(state.meIntake && state.meIntake.id===id) state.messages=rr.messages||[];
      state.inboxMsgCache[id]=rr.messages||[];
      render();
    }catch(e){ toast(e.message); }
  });
  document.querySelectorAll('[data-open-msgs]').forEach(b=>b.onclick=async()=>{
    const id=b.getAttribute('data-open-msgs');
    if(state.openInboxMsg===id){ state.openInboxMsg=null; render(); return; }
    try{
      const r=await api('/intakes/'+id+'/messages');
      state.inboxMsgCache[id]=r.messages||[];
      state.openInboxMsg=id;
      render();
    }catch(e){ toast(e.message); }
  });

}



function notifPerm(){
  try{ return (typeof Notification!=='undefined') ? Notification.permission : 'denied'; }catch{ return 'denied'; }
}
function needsNotifGate(){
  if(needsInstallGate()) return false;
  if(state.view!=='app' || !state.user || state.user.status!=='approved') return false;
  if(state.notifGateDismissed) return false;
  const push=state.pushStatus;
  if(!push || !push.configured) return false;
  if(push.subscribed) return false;
  return true;
}
function notifGateHtml(){
  const denied=notifPerm()==='denied';
  return \`<div class="notif-gate" id="notif-gate" role="dialog" aria-modal="true" aria-labelledby="notif-title">
    <div class="panel">
      <div class="brand" style="margin-bottom:14px">sitedesk<div class="brand-sub">bjvfi</div></div>
      <h2 id="notif-title">Enable notifications</h2>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">Turn on alerts so you catch new leads, intakes, approvals, and payouts \u2014 even when the app is closed.</p>
      \${denied?\`<p class="helper-warn" style="margin:12px 0">Permission is blocked. Open your phone Settings \u2192 SiteDesk \u2192 Notifications \u2192 Allow, then come back and tap Enable.</p>\`:
        \`<p class="muted" style="font-size:12px;line-height:1.55;margin:12px 0">Your phone will ask for permission. Tap <strong>Allow</strong>.</p>\`}
      <button class="btn block" id="btn-enable-notifs" type="button" style="margin-top:8px">Enable notifications</button>
      <button class="btn ghost block" id="btn-notif-later" type="button" style="margin-top:10px">Later</button>
    </div>
  </div>\`;
}
function notifBannerHtml(){
  const push=state.pushStatus||{};
  if(state.view!=='app' || !state.user || state.user.status!=='approved') return '';
  if(needsInstallGate() || needsNotifGate()) return '';
  if(!push.configured || push.subscribed || !state.notifGateDismissed) return '';
  return \`<div class="notif-banner" id="notif-banner">
    <div class="row">
      <div style="flex:1;font-size:13px;line-height:1.45">Notifications are off. Enable them so you don\u2019t miss alerts.</div>
      <button class="btn sm" id="btn-banner-enable-notifs" type="button">Enable</button>
    </div>
  </div>\`;
}
function mountNotifGate(){
  let el=document.getElementById('notif-gate-root');
  if(!el){
    el=document.createElement('div');
    el.id='notif-gate-root';
    document.body.appendChild(el);
  }
  if(needsNotifGate()){
    el.innerHTML=notifGateHtml();
    const enable=document.getElementById('btn-enable-notifs');
    if(enable) enable.onclick=async()=>{
      try{
        await togglePush();
        state.notifGateDismissed=false;
        await refreshApp();
        render();
      }catch(e){ toast(e.message||'Could not enable notifications'); render(); }
    };
    const later=document.getElementById('btn-notif-later');
    if(later) later.onclick=()=>{ state.notifGateDismissed=true; render(); };
  } else {
    el.innerHTML='';
  }
}

function installGateHtml(){

  const canPrompt=!!state.deferredInstallPrompt;
  return \`<div class="install-gate" id="install-gate" role="dialog" aria-modal="true" aria-labelledby="install-title">
    <div class="panel">
      <div class="brand" style="margin-bottom:14px">sitedesk<div class="brand-sub">bjvfi</div></div>
      <h2 id="install-title">Install SiteDesk to continue</h2>
      <p class="muted" style="font-size:13px;line-height:1.6;margin-bottom:8px">Add SiteDesk as a web app (Home Screen) so push alerts work and you stay in the desk. This screen stays until install is detected.</p>
      <h3 style="margin-top:14px">iPhone (Safari)</h3>
      <ol>
        <li>Tap the <strong>Share</strong> button</li>
        <li>Scroll and tap <strong>Add to Home Screen</strong></li>
        <li>Tap <strong>Add</strong>, then open SiteDesk from your Home Screen</li>
      </ol>
      <h3 style="margin-top:14px">Android (Chrome)</h3>
      <ol>
        <li>Tap the menu (\u22EE) \u2192 <strong>Install app</strong> or <strong>Add to Home Screen</strong></li>
        <li>Confirm, then open the installed SiteDesk app</li>
      </ol>
      \${canPrompt?\`<button class="btn block" id="btn-install-pwa" type="button" style="margin-top:18px">Install app</button>\`:
        \`<p class="muted" style="font-size:12px;margin-top:16px;line-height:1.55">Waiting for install\u2026 Open this page from your Home Screen / installed app when done.</p>\`}
      <p class="muted" style="font-size:11px;margin-top:14px;line-height:1.5">Already installed? Open SiteDesk from the app icon (not a regular browser tab).</p>
    </div>
  </div>\`;
}
function needsInstallGate(){
  if(refreshPwaFlag()) return false;
  // Gate only once user is in the app (authenticated). Home/login/signup stay available so they can sign in first.
  if(state.view!=='app' || !state.user) return false;
  return true;
}
function mountInstallGate(){
  let el=document.getElementById('install-gate-root');
  if(!el){
    el=document.createElement('div');
    el.id='install-gate-root';
    document.body.appendChild(el);
  }
  if(needsInstallGate()){
    el.innerHTML=installGateHtml();
    const btn=document.getElementById('btn-install-pwa');
    if(btn){
      btn.onclick=async()=>{
        const ev=state.deferredInstallPrompt;
        if(!ev) return;
        try{
          ev.prompt();
          const choice=await ev.userChoice;
          state.deferredInstallPrompt=null;
          if(choice && choice.outcome==='accepted'){
            // appinstalled / standalone check will clear gate
            toast('Installing\u2026 open from Home Screen when ready');
          }
          render();
        }catch(e){ toast(e.message||'Install failed'); }
      };
    }
  } else {
    el.innerHTML='';
  }
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  state.deferredInstallPrompt=e;
  mountInstallGate();
});
window.addEventListener('appinstalled', ()=>{
  state.deferredInstallPrompt=null;
  state.pwaInstalled=true;
  try{ localStorage.setItem('sitedesk_pwa_installed','1'); }catch{}
  mountInstallGate();
  mountNotifGate();
  toast('SiteDesk installed \u2014 enable notifications next');
});
try{
  window.matchMedia('(display-mode: standalone)').addEventListener('change', ()=>{ refreshPwaFlag(); mountInstallGate(); });
}catch{}
refreshPwaFlag();

function render(){
  syncPath();
  if(state.view==='home'){ renderHome(); mountInstallGate(); mountNotifGate(); return; }
  if(state.view==='login'){ renderAuth('login'); mountInstallGate(); mountNotifGate(); return; }
  if(state.view==='signup'){ renderAuth('signup'); mountInstallGate(); mountNotifGate(); return; }
  if(state.view==='app'&&state.user){ renderApp(); mountInstallGate(); mountNotifGate(); return; }
  return renderHome();
}
boot();
<\/script>
</body>
</html>
`;

// src/index.js
var app = new Hono2();
var OUTCOMES = /* @__PURE__ */ new Set([
  "sent_message",
  "called_no_answer",
  "spoke_interested",
  "spoke_not_interested",
  "bad_lead",
  "sold"
]);
var INTAKE_STATUSES = /* @__PURE__ */ new Set(["submitted", "building", "payment_sent", "paid"]);
var REPORT_REASONS = /* @__PURE__ */ new Set([
  "wrong_number",
  "business_closed",
  "already_has_site",
  "not_interested",
  "duplicate",
  "abusive_other"
]);
var ALLOWED_IMAGE_TYPES = /* @__PURE__ */ new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
]);
function jsonError(c, status, error) {
  return c.json({ error }, status);
}
__name(jsonError, "jsonError");
function normalizePhone(raw2) {
  const s = String(raw2 || "").trim();
  const digits = s.replace(/[^\d+]/g, "");
  if (digits.replace(/\D/g, "").length < 7)
    return null;
  return digits;
}
__name(normalizePhone, "normalizePhone");
function hasPhoneValue(phone) {
  const p = String(phone || "").trim();
  if (!p)
    return false;
  return !["\u2014", "-", "n/a", "na", "none", "null"].includes(p.toLowerCase());
}
__name(hasPhoneValue, "hasPhoneValue");
function catalogOrigin(env) {
  return String(env.SITE_ORIGIN || "https://bjvfi.com").replace(/\/$/, "");
}
__name(catalogOrigin, "catalogOrigin");
function parseCatalogSites(raw2) {
  if (Array.isArray(raw2))
    return raw2;
  if (raw2 && Array.isArray(raw2.sites))
    return raw2.sites;
  if (raw2 && Array.isArray(raw2.catalog))
    return raw2.catalog;
  return null;
}
__name(parseCatalogSites, "parseCatalogSites");
async function listAssignableUsers(db) {
  const { results } = await db.prepare(
    `SELECT id, name, role FROM users
     WHERE status='approved' AND role IN ('builder','head','admin')
     ORDER BY CASE role WHEN 'builder' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, name`
  ).all();
  return results || [];
}
__name(listAssignableUsers, "listAssignableUsers");
async function syncLeadsFromCatalog(env) {
  const origin = catalogOrigin(env);
  const res = await fetch(`${origin}/sites.json`);
  if (!res.ok)
    throw new Error(`Catalog fetch failed (${res.status})`);
  const sites = parseCatalogSites(await res.json());
  if (!sites)
    throw new Error("Catalog is not an array");
  const { results: existing } = await env.DB.prepare(
    `SELECT id, slug, phone, business_name FROM leads`
  ).all();
  const bySlug = new Map((existing || []).map((r) => [r.slug, r]));
  const now = nowIso();
  const inserts = [];
  const updates = [];
  for (const site of sites) {
    const slug = String(site.s || site.slug || "").trim();
    const name = String(site.n || site.business_name || site.name || "").trim();
    if (!slug || !name)
      continue;
    const phone = String(site.p || site.phone || "").trim();
    const category = String(site.c || site.category || "").trim();
    const address = String(site.a || site.address || "").trim();
    const siteUrl = leadSiteUrl(slug, origin);
    const row = bySlug.get(slug);
    if (!row) {
      inserts.push({ slug, name, phone, category, address, siteUrl });
    } else {
      const emptyPhone = !hasPhoneValue(row.phone);
      const staleName = String(row.business_name || "").trim() !== name;
      if (emptyPhone || staleName) {
        updates.push({
          id: row.id,
          phone: emptyPhone ? phone || row.phone || "" : row.phone,
          name: staleName ? name : row.business_name,
          category,
          address,
          siteUrl
        });
      }
    }
  }
  let inserted = 0;
  let updated = 0;
  const CHUNK = 80;
  for (let i = 0; i < inserts.length; i += CHUNK) {
    const chunk = inserts.slice(i, i + CHUNK);
    const stmts = chunk.map(
      (row) => env.DB.prepare(
        `INSERT OR IGNORE INTO leads (id, slug, business_name, phone, category, address, site_url, status, claimed_by, claimed_at, claim_expires_at, last_outcome, last_note, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).bind(newId(), row.slug, row.name, row.phone || null, row.category || null, row.address || null, row.siteUrl, now, now)
    );
    const results = await env.DB.batch(stmts);
    for (const r of results) {
      if (r.success !== false && r.meta?.changes)
        inserted += 1;
    }
  }
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const stmts = chunk.map(
      (row) => env.DB.prepare(
        `UPDATE leads SET phone=?, business_name=?,
           category=CASE WHEN ? != '' THEN ? ELSE category END,
           address=CASE WHEN ? != '' THEN ? ELSE address END,
           site_url=?, updated_at=?
         WHERE id=?`
      ).bind(row.phone, row.name, row.category, row.category, row.address, row.address, row.siteUrl, now, row.id)
    );
    const results = await env.DB.batch(stmts);
    for (const r of results) {
      if (r.success !== false && r.meta?.changes)
        updated += 1;
    }
  }
  const total_leads = Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM leads").first())?.n || 0);
  return { inserted, updated, total_catalog: sites.length, total_leads };
}
__name(syncLeadsFromCatalog, "syncLeadsFromCatalog");
async function requireUser(c) {
  const token = getCookie(c, COOKIE) || null;
  return await getSessionUser(c.env.DB, token) || null;
}
__name(requireUser, "requireUser");
async function requireApproved(c) {
  const user = await requireUser(c);
  if (!user)
    return { error: jsonError(c, 401, "Not authenticated") };
  if (user.status !== "approved")
    return { error: jsonError(c, 403, "Account not approved") };
  if (user.status === "disabled")
    return { error: jsonError(c, 403, "Account disabled") };
  return { user };
}
__name(requireApproved, "requireApproved");
async function requireManager(c) {
  const r = await requireApproved(c);
  if (r.error)
    return r;
  if (!canManageUsers(r.user))
    return { error: jsonError(c, 403, "Admin/head only") };
  return r;
}
__name(requireManager, "requireManager");
async function requireInbox(c) {
  const r = await requireApproved(c);
  if (r.error)
    return r;
  if (!canSeeInbox(r.user))
    return { error: jsonError(c, 403, "Inbox access denied") };
  return r;
}
__name(requireInbox, "requireInbox");
function serveUi(c) {
  c.header("Cache-Control", "no-store, no-cache, must-revalidate");
  return c.html(ui_default);
}
__name(serveUi, "serveUi");
var MANIFEST = {
  name: "SiteDesk",
  short_name: "sitedesk",
  description: "bjvfi caller desk",
  start_url: "/app",
  scope: "/",
  display: "standalone",
  background_color: "#000000",
  theme_color: "#000000",
  icons: [
    { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    { src: "/favicon.png", sizes: "192x192", type: "image/png", purpose: "any" }
  ]
};
app.get(
  "/manifest.webmanifest",
  (c) => c.json(MANIFEST, 200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" })
);
app.get(
  "/manifest.json",
  (c) => c.json(MANIFEST, 200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" })
);
function extForType(type) {
  if (type === "image/png")
    return "png";
  if (type === "image/webp")
    return "webp";
  if (type === "image/gif")
    return "gif";
  if (type === "image/heic" || type === "image/heif")
    return "heic";
  return "jpg";
}
__name(extForType, "extForType");
async function ensureHead(c, user) {
  if (!user)
    return user;
  if (!isHeadEmail(c.env, user.email))
    return user;
  if (user.role === "head" && user.status === "approved")
    return user;
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE users SET role='head', status='approved', name=CASE WHEN name IS NULL OR name='' THEN 'Not Ai' ELSE name END,
     phone_confirmed=1, email_confirmed=1,
     phone_confirmed_at=COALESCE(phone_confirmed_at,?), email_confirmed_at=COALESCE(email_confirmed_at,?)
     WHERE id=?`
  ).bind(now, now, user.id).run();
  return getUserById(c.env.DB, user.id);
}
__name(ensureHead, "ensureHead");
app.get("/logo.png", (c) => new Response(LOGO_PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } }));
app.get("/favicon.png", (c) => new Response(FAVICON_PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } }));
app.get("/favicon.ico", (c) => new Response(FAVICON_PNG, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" } }));
var SW_JS = `self.addEventListener('push', (event) => {
  let data = { title: 'SiteDesk', body: '', url: '/app' };
  try { data = { ...data, ...event.data.json() }; } catch (e) {
    try { data.body = event.data.text(); } catch {}
  }
  event.waitUntil(self.registration.showNotification(data.title || 'SiteDesk', {
    body: data.body || '',
    icon: '/favicon.png',
    badge: '/favicon.png',
    data: { url: data.url || '/app' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if (c.url.includes(self.location.origin) && 'focus' in c) { c.navigate(url); return c.focus(); } }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
`;
app.get("/sw.js", (c) => new Response(SW_JS, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/" } }));
app.get("/api/push/vapid-public-key", (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY || null, configured: vapidConfigured(c.env) }));
app.get("/", serveUi);
app.get("/login", serveUi);
app.get("/signup", serveUi);
app.get("/app", serveUi);
app.get(
  "/api/health",
  (c) => c.json({ ok: true, app: c.env.APP_NAME || "SiteDesk", price: c.env.MONTHLY_PRICE, max_active_leads: maxActiveLeads(c.env), vapid: vapidConfigured(c.env) })
);
app.get("/api/me", async (c) => {
  let user = await requireUser(c);
  if (user)
    user = await ensureHead(c, user);
  return c.json({ user: publicUser(user) });
});
app.patch("/api/me", async (c) => {
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  const body = await c.req.json().catch(() => ({}));
  const name = body.name != null ? String(body.name).trim() : user.name;
  const phone = body.phone != null ? normalizePhone(body.phone) : user.phone;
  if (!name || name.length < 2)
    return jsonError(c, 400, "Name required");
  if (body.phone != null && !phone)
    return jsonError(c, 400, "Valid phone required");
  await c.env.DB.prepare(`UPDATE users SET name=?, phone=? WHERE id=?`).bind(name, phone || null, user.id).run();
  return c.json({ user: publicUser(await getUserById(c.env.DB, user.id)) });
});
var PAYOUT_METHODS = /* @__PURE__ */ new Set(["cash_app", "venmo", "zelle", "paypal", "other"]);
app.patch("/api/me/payout-method", async (c) => {
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  const body = await c.req.json().catch(() => ({}));
  const method = String(body.payout_method || body.method || "").trim().toLowerCase().replace(/\s+/g, "_");
  const details = String(body.payout_details || body.details || "").trim();
  if (!PAYOUT_METHODS.has(method)) {
    return jsonError(c, 400, "Method must be Cash App, Venmo, Zelle, PayPal, or Other");
  }
  if (!details || details.length < 2) {
    return jsonError(c, 400, "Payment details required (tag, phone, or email)");
  }
  if (details.length > 200)
    return jsonError(c, 400, "Details too long");
  await c.env.DB.prepare(
    `UPDATE users SET payout_method=?, payout_details=? WHERE id=?`
  ).bind(method, details, user.id).run();
  return c.json({ user: publicUser(await getUserById(c.env.DB, user.id)) });
});
app.post("/api/auth/signup", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();
  const name = String(body.name || "").trim();
  const phone = normalizePhone(body.phone);
  const password = String(body.password || "");
  if (!email || !email.includes("@"))
    return jsonError(c, 400, "Valid email required");
  if (!phone)
    return jsonError(c, 400, "Valid phone required");
  if (!name || name.length < 2)
    return jsonError(c, 400, "Name required (min 2 chars)");
  if (password.length < 6)
    return jsonError(c, 400, "Password must be at least 6 characters");
  if (await getUserByEmail(c.env.DB, email))
    return jsonError(c, 409, "Email already registered");
  let requestedRole = String(body.role || "caller").toLowerCase().trim();
  if (requestedRole !== "caller" && requestedRole !== "builder") {
    return jsonError(c, 400, "Role must be caller or builder");
  }
  const id = newId();
  const password_hash = await hashPassword(password);
  const created_at = nowIso();
  const head = isHeadEmail(c.env, email);
  const role = head ? "head" : requestedRole;
  const status = head ? "approved" : "pending";
  const conf = head ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO users (id,email,name,phone,password_hash,role,status,phone_confirmed,email_confirmed,phone_confirmed_at,email_confirmed_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    id,
    email,
    head ? name || "Not Ai" : name,
    phone,
    password_hash,
    role,
    status,
    conf,
    conf,
    head ? created_at : null,
    head ? created_at : null,
    created_at
  ).run();
  const token = newToken();
  await createSession(c.env.DB, token, id, sessionExpiry());
  setCookie(c, COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 30 * 86400 });
  if (!head) {
    await notifyRolesInAppAndEmail(c.env.DB, c.env, ["head", "admin"], {
      title: `New ${role} signup`,
      body: `${name} (${email} \xB7 ${phone}) requested ${role} access.`,
      link: "/app"
    });
  }
  return c.json({ user: publicUser(await getUserById(c.env.DB, id)) });
});
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = String(body.email || "").toLowerCase().trim();
  const password = String(body.password || "");
  if (!email || !password)
    return jsonError(c, 400, "Email and password required");
  let user = await getUserByEmail(c.env.DB, email);
  if (!user)
    return jsonError(c, 401, "Invalid email or password");
  if (!await verifyPassword(password, user.password_hash))
    return jsonError(c, 401, "Invalid email or password");
  if (user.status === "disabled")
    return jsonError(c, 403, "Account disabled");
  user = await ensureHead(c, user);
  const token = newToken();
  await createSession(c.env.DB, token, user.id, sessionExpiry());
  setCookie(c, COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: 30 * 86400 });
  return c.json({ user: publicUser(user) });
});
app.post("/api/auth/logout", async (c) => {
  await deleteSession(c.env.DB, getCookie(c, COOKIE));
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ ok: true });
});
app.get("/api/notifications", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50`
  ).bind(auth.user.id).all();
  const unread = (results || []).filter((n) => !n.read_at).length;
  return c.json({ notifications: results || [], unread });
});
app.post("/api/notifications/read", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const now = nowIso();
  if (body.id) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at=? WHERE id=? AND user_id=?`).bind(now, body.id, auth.user.id).run();
  } else {
    await c.env.DB.prepare(`UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL`).bind(now, auth.user.id).run();
  }
  return c.json({ ok: true });
});
app.get("/api/leads/queue", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  if (!canClaimLeads(auth.user)) {
    if (auth.user.role === "builder") {
      return c.json({ leads: [], note: "Builders see submitted builds in Builds, not the caller queue" });
    }
    return c.json({ error: "Forbidden" }, 403);
  }
  await releaseExpiredClaims(c.env.DB);
  const limit = Math.min(parseInt(c.req.query("limit") || "10", 10) || 10, 50);
  const q = String(c.req.query("q") || "").trim().toLowerCase();
  const category = String(c.req.query("category") || "").trim();
  const hasPhone = ["1", "true", "yes"].includes(String(c.req.query("has_phone") || "").toLowerCase());
  const exclude = String(c.req.query("exclude") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 80);
  let sql = `SELECT id, slug, business_name, phone, category, address, site_url, status, created_at
     FROM leads WHERE status='open'`;
  const binds = [];
  if (q) {
    sql += ` AND (lower(business_name) LIKE ? OR lower(slug) LIKE ? OR lower(IFNULL(phone,'')) LIKE ?)`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  if (category === "__none__") {
    sql += ` AND (category IS NULL OR trim(category)='')`;
  } else if (category) {
    sql += ` AND category=?`;
    binds.push(category);
  }
  if (hasPhone) {
    sql += ` AND phone IS NOT NULL AND trim(phone)!='' AND phone!='\u2014' AND phone!='-' AND lower(phone)!='n/a'`;
  }
  if (exclude.length) {
    sql += ` AND id NOT IN (${exclude.map(() => "?").join(",")})`;
    binds.push(...exclude);
  }
  sql += ` ORDER BY RANDOM() LIMIT ?`;
  binds.push(limit);
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const cap = maxActiveLeads(c.env);
  const active = await countActiveLeads(c.env.DB, auth.user.id);
  return c.json({
    leads: (results || []).map((l) => ({
      ...l,
      site_url: l.site_url || leadSiteUrl(l.slug, c.env.SITE_ORIGIN),
      has_phone: hasPhoneValue(l.phone)
    })),
    lead_slots: { active, max: cap, remaining: Math.max(0, cap - active) }
  });
});
app.get("/api/leads/categories", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT category AS name, COUNT(*) AS n FROM leads
     WHERE status='open' AND category IS NOT NULL AND trim(category)!=''
     GROUP BY category ORDER BY n DESC LIMIT 12`
  ).all();
  const empty = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM leads WHERE status='open' AND (category IS NULL OR trim(category)='')`
  ).first();
  return c.json({
    categories: (results || []).map((r) => ({ name: r.name, n: r.n })),
    uncategorized: Number(empty?.n || 0)
  });
});
app.get("/api/stats/me", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const uid = auth.user.id;
  const dayStart = /* @__PURE__ */ new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();
  const claimed_today = Number((await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lead_events WHERE user_id=? AND kind='claimed' AND created_at>=?`
  ).bind(uid, dayIso).first())?.n || 0);
  const interested = Number((await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lead_events WHERE user_id=? AND kind='spoke_interested'`
  ).bind(uid).first())?.n || 0);
  const intakes = Number((await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM intakes WHERE user_id=?`
  ).bind(uid).first())?.n || 0);
  const outcomes = Number((await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM lead_events WHERE user_id=? AND kind NOT IN ('claimed','unlocked','commission','released','skipped','report')`
  ).bind(uid).first())?.n || 0);
  let commissions_owed = 0, commissions_paid = 0, commissions_owed_amt = 0, commissions_paid_amt = 0;
  try {
    const owed = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM payouts WHERE user_id=? AND status='owed'`
    ).bind(uid).first();
    const paid = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amt FROM payouts WHERE user_id=? AND status='paid'`
    ).bind(uid).first();
    commissions_owed = Number(owed?.n || 0);
    commissions_paid = Number(paid?.n || 0);
    commissions_owed_amt = Number(owed?.amt || 0);
    commissions_paid_amt = Number(paid?.amt || 0);
  } catch {
  }
  const cap = maxActiveLeads(c.env);
  const active_leads = await countActiveLeads(c.env.DB, uid);
  return c.json({ stats: {
    claimed_today,
    interested,
    intakes_submitted: intakes,
    outcomes_logged: outcomes,
    commissions_owed,
    commissions_paid,
    commissions_owed_amt,
    commissions_paid_amt,
    payouts_owed: commissions_owed,
    payouts_paid: commissions_paid,
    payouts_owed_amt: commissions_owed_amt,
    payouts_paid_amt: commissions_paid_amt,
    active_leads,
    max_active_leads: cap,
    remaining_slots: Math.max(0, cap - active_leads)
  } });
});
app.get("/api/leads/mine", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  await releaseExpiredClaims(c.env.DB);
  const statusFilter = String(c.req.query("status") || "all").trim().toLowerCase();
  const q = String(c.req.query("q") || "").trim().toLowerCase();
  const allowed = ["claimed", "interested", "intake_submitted", "sold"];
  let sql = `SELECT * FROM leads WHERE claimed_by=? AND status IN ('claimed','interested','intake_submitted','sold')`;
  const binds = [auth.user.id];
  if (statusFilter && statusFilter !== "all" && allowed.includes(statusFilter)) {
    sql += ` AND status=?`;
    binds.push(statusFilter);
  }
  if (q) {
    sql += ` AND (lower(business_name) LIKE ? OR lower(IFNULL(phone,'')) LIKE ? OR lower(slug) LIKE ?)`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += ` ORDER BY updated_at DESC LIMIT 50`;
  const { results } = await c.env.DB.prepare(sql).bind(...binds).all();
  const leads = [];
  for (const row of results || []) {
    leads.push(await enrichLead(row, auth.user.name, c.env, c.env.DB));
  }
  const wantId = String(c.req.query("id") || "");
  const lead = wantId && leads.find((l) => l.id === wantId) || leads[0] || null;
  let intake = null;
  if (lead) {
    intake = await c.env.DB.prepare("SELECT id, status, created_at, payout_status FROM intakes WHERE lead_id=?").bind(lead.id).first();
  }
  const cap = maxActiveLeads(c.env);
  const active = await countActiveLeads(c.env.DB, auth.user.id);
  return c.json({ leads, lead, intake, lead_slots: { active, max: cap, remaining: Math.max(0, cap - active) } });
});
app.post("/api/leads/grab", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  if (!canClaimLeads(auth.user))
    return jsonError(c, 403, "Builders cannot claim sales leads");
  await releaseExpiredClaims(c.env.DB);
  const cap = maxActiveLeads(c.env);
  const active = await countActiveLeads(c.env.DB, auth.user.id);
  if (active >= cap) {
    return jsonError(c, 409, `Lead cap reached \u2014 you already have ${active} active leads (max ${cap}). Release or finish one first.`);
  }
  const body = await c.req.json().catch(() => ({}));
  const leadId = body.lead_id ? String(body.lead_id).trim() : "";
  let candidate;
  if (leadId) {
    candidate = await c.env.DB.prepare(
      `SELECT * FROM leads WHERE id=? AND status='open'`
    ).bind(leadId).first();
    if (!candidate)
      return jsonError(c, 409, "That lead is no longer open \u2014 pick another");
  } else {
    candidate = await c.env.DB.prepare(
      `SELECT * FROM leads WHERE status='open' ORDER BY RANDOM() LIMIT 1`
    ).first();
    if (!candidate)
      return jsonError(c, 404, "No open leads available");
  }
  const now = nowIso();
  const expires = claimExpiry(45);
  const result = await c.env.DB.prepare(
    `UPDATE leads SET status='claimed', claimed_by=?, claimed_at=?, claim_expires_at=?, updated_at=?
     WHERE id=? AND status='open'`
  ).bind(auth.user.id, now, expires, now, candidate.id).run();
  if (!result.meta?.changes)
    return jsonError(c, 409, "Lead was just claimed \u2014 try again");
  await c.env.DB.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'claimed',NULL,?)`
  ).bind(newId(), candidate.id, auth.user.id, now).run();
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(candidate.id).first();
  return c.json({ lead: await enrichLead(lead, auth.user.name, c.env, c.env.DB) });
});
app.get("/api/leads/:id/events", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  if (lead.claimed_by !== auth.user.id && !canManageUsers(auth.user)) {
    return jsonError(c, 403, "Not your lead");
  }
  const { results } = await c.env.DB.prepare(
    `SELECT e.id,e.kind,e.note,e.created_at,u.name AS actor_name FROM lead_events e
     LEFT JOIN users u ON u.id=e.user_id WHERE e.lead_id=? ORDER BY e.created_at DESC LIMIT 50`
  ).bind(id).all();
  return c.json({ events: results || [] });
});
async function releaseLeadToOpen(db, leadId, userId, kind, note) {
  const now = nowIso();
  await db.prepare(
    `UPDATE leads SET status='open', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL, updated_at=? WHERE id=?`
  ).bind(now, leadId).run();
  await db.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(newId(), leadId, userId, kind, note || null, now).run();
  return now;
}
__name(releaseLeadToOpen, "releaseLeadToOpen");
app.post("/api/leads/:id/release", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  if (lead.claimed_by !== auth.user.id && !canManageUsers(auth.user)) {
    return jsonError(c, 403, "Not your lead");
  }
  if (lead.status === "intake_submitted" || lead.status === "sold") {
    if (!canManageUsers(auth.user)) {
      return jsonError(c, 400, "Intake already submitted \u2014 only head/admin can unlock");
    }
  } else if (!["claimed", "interested"].includes(lead.status)) {
    return jsonError(c, 400, "Lead is not releasable");
  }
  await releaseLeadToOpen(c.env.DB, id, auth.user.id, "released", "released claim / remove from me");
  return c.json({ ok: true });
});
app.post("/api/leads/:id/skip", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  if (lead.claimed_by !== auth.user.id)
    return jsonError(c, 403, "Not your lead");
  if (lead.status !== "claimed")
    return jsonError(c, 400, "Only claimed leads can be skipped");
  await releaseLeadToOpen(c.env.DB, id, auth.user.id, "skipped", "skipped \u2014 returned to open");
  return c.json({ ok: true });
});
app.post("/api/leads/:id/report", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body.reason || "");
  const note = String(body.note || "").trim() || null;
  if (!REPORT_REASONS.has(reason))
    return jsonError(c, 400, "Invalid report reason");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  const now = nowIso();
  const reportId = newId();
  await c.env.DB.prepare(
    `INSERT INTO lead_reports (id,lead_id,user_id,reason,note,status,created_at) VALUES (?,?,?,?,?,'open',?)`
  ).bind(reportId, id, auth.user.id, reason, note, now).run();
  await c.env.DB.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'report',?,?)`
  ).bind(newId(), id, auth.user.id, `${reason}${note ? ": " + note : ""}`, now).run();
  if (body.release && lead.claimed_by === auth.user.id && lead.status === "claimed") {
    await releaseLeadToOpen(c.env.DB, id, auth.user.id, "released", "released after report");
  }
  await notifyRolesInAppAndEmail(c.env.DB, c.env, ["head", "admin"], {
    title: "Lead reported",
    body: `${auth.user.name} reported ${lead.business_name}: ${reason}${note ? " \u2014 " + note : ""}`,
    link: "/app"
  });
  return c.json({ ok: true, report_id: reportId });
});
app.post("/api/leads/:id/outcome", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const outcome = String(body.outcome || "");
  const note = String(body.note || "").trim() || null;
  if (!OUTCOMES.has(outcome))
    return jsonError(c, 400, "Invalid outcome");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  if (lead.claimed_by !== auth.user.id && !canManageUsers(auth.user))
    return jsonError(c, 403, "Not your lead");
  if (!["claimed", "interested"].includes(lead.status) && !canManageUsers(auth.user)) {
    return jsonError(c, 400, "Lead is not in an actionable state");
  }
  const now = nowIso();
  let status = lead.status, claimed_by = lead.claimed_by, claimed_at = lead.claimed_at, claim_expires_at = lead.claim_expires_at;
  if (outcome === "spoke_interested") {
    status = "interested";
    claim_expires_at = null;
  } else if (outcome === "sold") {
    status = "sold";
    claim_expires_at = null;
  } else if (outcome === "spoke_not_interested" || outcome === "bad_lead") {
    status = "closed";
    claimed_by = null;
    claimed_at = null;
    claim_expires_at = null;
  } else {
    status = "claimed";
    claim_expires_at = claimExpiry(45);
  }
  await c.env.DB.prepare(
    `UPDATE leads SET status=?, claimed_by=?, claimed_at=?, claim_expires_at=?, last_outcome=?, last_note=?, updated_at=? WHERE id=?`
  ).bind(status, claimed_by, claimed_at, claim_expires_at, outcome, note, now, id).run();
  await c.env.DB.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,?,?,?)`
  ).bind(newId(), id, auth.user.id, outcome, note, now).run();
  const updated = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  return c.json({ lead: await enrichLead(updated, auth.user.name, c.env, c.env.DB) });
});
async function deleteIntakeAssets(env, intake) {
  if (!env.ASSETS || !intake)
    return { deleted: 0, keys: [] };
  let images = [];
  try {
    const parsed = JSON.parse(intake.logo_images || "[]");
    if (Array.isArray(parsed))
      images = parsed;
  } catch {
    return { deleted: 0, keys: [] };
  }
  const keys = [];
  for (const item of images) {
    if (!item)
      continue;
    if (typeof item === "string") {
      const m = item.match(/\/api\/assets\/(.+)$/);
      if (m)
        keys.push(decodeURIComponent(m[1]));
      else if (item.startsWith("intake/"))
        keys.push(item);
    } else if (typeof item === "object") {
      if (item.key)
        keys.push(String(item.key));
      else if (item.url) {
        const m = String(item.url).match(/\/api\/assets\/(.+)$/);
        if (m)
          keys.push(decodeURIComponent(m[1]));
      }
    }
  }
  const uniq = [...new Set(keys.filter(Boolean))];
  let deleted = 0;
  for (const key of uniq) {
    if (key.includes(".."))
      continue;
    try {
      await env.ASSETS.delete(key);
      deleted += 1;
    } catch (e) {
      console.error("R2 delete failed", key, e);
    }
  }
  return { deleted, keys: uniq };
}
__name(deleteIntakeAssets, "deleteIntakeAssets");
app.post("/api/upload", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  if (!c.env.ASSETS)
    return jsonError(c, 503, "R2 assets bucket not configured \u2014 enable R2 in Cloudflare dashboard");
  const form = await c.req.formData();
  const files = form.getAll("files").filter((f) => f && typeof f === "object" && f.arrayBuffer);
  if (!files.length) {
    const single = form.get("file");
    if (single && typeof single === "object" && single.arrayBuffer)
      files.push(single);
  }
  if (!files.length)
    return jsonError(c, 400, "No files uploaded");
  if (files.length > 12)
    return jsonError(c, 400, "Max 12 images");
  const uploaded = [];
  for (const file of files) {
    const type = (file.type || "image/jpeg").toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(type))
      return jsonError(c, 400, `Unsupported type: ${type}`);
    if (file.size > 8 * 1024 * 1024)
      return jsonError(c, 400, "Each image must be under 8MB");
    const key = `intake/${auth.user.id}/${Date.now()}-${newId().slice(0, 8)}.${extForType(type)}`;
    await c.env.ASSETS.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: type },
      customMetadata: { uploaded_by: auth.user.id }
    });
    uploaded.push({ key, url: `/api/assets/${encodeURIComponent(key)}`, content_type: type, size: file.size, name: file.name || key });
  }
  return c.json({ files: uploaded });
});
app.get("/api/assets/*", async (c) => {
  if (!c.env.ASSETS)
    return jsonError(c, 503, "R2 not configured");
  const key = decodeURIComponent(c.req.path.replace(/^\/api\/assets\//, ""));
  if (!key || key.includes(".."))
    return jsonError(c, 400, "Invalid key");
  const obj = await c.env.ASSETS.get(key);
  if (!obj)
    return jsonError(c, 404, "Not found");
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});
app.post("/api/leads/:id/intake", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const body = await c.req.json().catch(() => ({}));
  const wants = String(body.wants || "").trim();
  const brand_colors = String(body.brand_colors || "").trim();
  let logo_images = body.logo_images;
  if (Array.isArray(logo_images))
    logo_images = JSON.stringify(logo_images);
  else
    logo_images = String(logo_images || "").trim();
  const design_style = String(body.design_style || "").trim();
  const contact_confirm = String(body.contact_confirm || "").trim();
  const business_email = String(body.business_email || "").trim().toLowerCase();
  const extras = String(body.extras || "").trim() || null;
  if (!wants || !brand_colors || !logo_images || !design_style || !contact_confirm) {
    return jsonError(c, 400, "Required: wants, brand_colors, logo_images, design_style, contact_confirm");
  }
  if (!isValidEmail(business_email)) {
    return jsonError(c, 400, "Valid business email required \u2014 we need it to send the site/payment");
  }
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  if (lead.claimed_by !== auth.user.id)
    return jsonError(c, 403, "Not your lead");
  if (lead.status !== "interested")
    return jsonError(c, 400, "Intake only after spoke_interested");
  if (await c.env.DB.prepare("SELECT id FROM intakes WHERE lead_id=?").bind(id).first()) {
    return jsonError(c, 409, "Intake already submitted");
  }
  const now = nowIso();
  const intakeId = newId();
  let assigned_to = body.assigned_to ? String(body.assigned_to).trim() : null;
  if (assigned_to) {
    const a = await getUserById(c.env.DB, assigned_to);
    if (!a || a.status !== "approved" || !["builder", "head", "admin"].includes(a.role))
      assigned_to = null;
  }
  if (!assigned_to) {
    const least = await pickLeastLoadedBuilder(c.env.DB);
    assigned_to = least?.id || null;
  }
  try {
    await c.env.DB.prepare(
      `INSERT INTO intakes (id,lead_id,user_id,wants,brand_colors,logo_images,design_style,contact_confirm,business_email,extras,status,assigned_to,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,'submitted',?,?,?)`
    ).bind(intakeId, id, auth.user.id, wants, brand_colors, logo_images, design_style, contact_confirm, business_email, extras, assigned_to, now, now).run();
  } catch (e) {
    await c.env.DB.prepare(
      `INSERT INTO intakes (id,lead_id,user_id,wants,brand_colors,logo_images,design_style,contact_confirm,extras,status,assigned_to,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'submitted',?,?,?)`
    ).bind(intakeId, id, auth.user.id, wants, brand_colors, logo_images, design_style, contact_confirm, extras, assigned_to, now, now).run();
  }
  try {
    await c.env.DB.prepare(
      `UPDATE leads SET status='intake_submitted', claim_expires_at=NULL, business_email=?, updated_at=? WHERE id=?`
    ).bind(business_email, now, id).run();
  } catch {
    await c.env.DB.prepare(
      `UPDATE leads SET status='intake_submitted', claim_expires_at=NULL, updated_at=? WHERE id=?`
    ).bind(now, id).run();
  }
  await c.env.DB.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'intake_submitted',?,?)`
  ).bind(newId(), id, auth.user.id, assigned_to ? `auto-assigned builder` : "unassigned", now).run();
  await notifyRolesInAppAndEmail(c.env.DB, c.env, ["head", "admin", "builder"], {
    title: "New intake submitted",
    body: `${lead.business_name} \u2014 by ${auth.user.name}${assigned_to ? "" : " \xB7 needs builder"}`,
    link: "/app"
  });
  if (assigned_to && assigned_to !== auth.user.id) {
    const assignee = await getUserById(c.env.DB, assigned_to);
    if (assignee) {
      await notifyInAppAndEmail(c.env.DB, c.env, [assignee], {
        title: "Intake assigned to you",
        body: `${lead.business_name} \u2014 submitted by ${auth.user.name}`,
        link: "/app"
      });
    }
  }
  const updated = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  return c.json({ lead: await enrichLead(updated, auth.user.name, c.env, c.env.DB), intake_id: intakeId, assigned_to });
});
app.get("/api/admin/users", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const q = String(c.req.query("q") || "").trim().toLowerCase();
  const status = String(c.req.query("status") || "").trim();
  let sql = `SELECT id,email,name,phone,role,status,phone_confirmed,email_confirmed,phone_confirmed_at,email_confirmed_at,admin_notes,payout_method,payout_details,created_at FROM users WHERE 1=1`;
  const binds = [];
  if (status) {
    sql += ` AND status=?`;
    binds.push(status);
  }
  if (q) {
    sql += ` AND (lower(name) LIKE ? OR lower(email) LIKE ? OR lower(IFNULL(phone,'')) LIKE ?)`;
    const like = `%${q}%`;
    binds.push(like, like, like);
  }
  sql += ` ORDER BY created_at DESC`;
  const { results } = await (binds.length ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql)).all();
  return c.json({ users: (results || []).map((u) => ({
    ...u,
    phone_confirmed: !!u.phone_confirmed,
    email_confirmed: !!u.email_confirmed
  })) });
});
app.patch("/api/admin/users/:id", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const target = await getUserById(c.env.DB, id);
  if (!target)
    return jsonError(c, 404, "User not found");
  if (target.role === "head" && auth.user.role !== "head") {
    return jsonError(c, 403, "Cannot edit head");
  }
  if (isHeadEmail(c.env, target.email) && auth.user.id !== target.id && auth.user.role !== "head") {
    return jsonError(c, 403, "Cannot edit head account");
  }
  const body = await c.req.json().catch(() => ({}));
  const now = nowIso();
  let name = body.name != null ? String(body.name).trim() : target.name;
  let phone = body.phone != null ? body.phone === "" ? null : normalizePhone(body.phone) || target.phone : target.phone;
  let role = body.role != null ? String(body.role) : target.role;
  let status = body.status != null ? String(body.status) : target.status;
  let phone_confirmed = body.phone_confirmed != null ? body.phone_confirmed ? 1 : 0 : target.phone_confirmed ? 1 : 0;
  let email_confirmed = body.email_confirmed != null ? body.email_confirmed ? 1 : 0 : target.email_confirmed ? 1 : 0;
  let admin_notes = body.admin_notes != null ? String(body.admin_notes) : target.admin_notes || null;
  if (!["caller", "builder", "admin", "head"].includes(role))
    return jsonError(c, 400, "Invalid role");
  if (!STATUSES.includes(status))
    return jsonError(c, 400, "Invalid status");
  if (isHeadEmail(c.env, target.email)) {
    role = "head";
    if (status === "disabled" || status === "rejected") {
      return jsonError(c, 400, "Head cannot be disabled/rejected");
    }
  } else if (role === "head") {
    return jsonError(c, 403, "Cannot assign head role");
  } else if (role === "admin" && !canCreateAdmin(auth.user)) {
    return jsonError(c, 403, "Only head can create admins");
  } else if (target.role === "admin" && role !== "admin" && auth.user.role !== "head") {
    return jsonError(c, 403, "Only head can demote admins");
  }
  if (status === "approved" && (!phone_confirmed || !email_confirmed)) {
    if (body.confirm_phone)
      phone_confirmed = 1;
    if (body.confirm_email)
      email_confirmed = 1;
    if (!phone_confirmed || !email_confirmed) {
      return jsonError(c, 400, "Confirm phone and email before approving");
    }
  }
  const phone_confirmed_at = phone_confirmed ? target.phone_confirmed_at || now : null;
  const email_confirmed_at = email_confirmed ? target.email_confirmed_at || now : null;
  const prevRole = target.role;
  const prevStatus = target.status;
  await c.env.DB.prepare(
    `UPDATE users SET name=?, phone=?, role=?, status=?, phone_confirmed=?, email_confirmed=?,
     phone_confirmed_at=?, email_confirmed_at=?, admin_notes=? WHERE id=?`
  ).bind(name, phone, role, status, phone_confirmed, email_confirmed, phone_confirmed_at, email_confirmed_at, admin_notes, id).run();
  if (status === "disabled" || status === "rejected") {
    await deleteUserSessions(c.env.DB, id);
  }
  const updated = await getUserById(c.env.DB, id);
  if (prevStatus !== status && (status === "approved" || status === "rejected")) {
    await notifyInAppAndEmail(c.env.DB, c.env, [updated], {
      title: status === "approved" ? "Account approved" : "Account rejected",
      body: status === "approved" ? "You can now use SiteDesk. Grab leads from the queue." : "Your SiteDesk account was rejected. Contact an admin if this is a mistake.",
      link: "/app"
    });
  }
  if (prevRole !== role && ["builder", "admin"].includes(role)) {
    await notifyInAppAndEmail(c.env.DB, c.env, [updated], {
      title: `Role updated: ${role}`,
      body: `Your SiteDesk role is now ${role}.`,
      link: "/app"
    });
  }
  return c.json({ user: publicUser(updated) });
});
app.post("/api/admin/users/:id/approve", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  c.req.param = ((orig) => (k) => k === "id" ? orig("id") : orig(k))(c.req.param.bind(c.req));
  const id = c.req.param("id");
  const fake = {
    name: void 0,
    role: void 0,
    status: "approved",
    confirm_phone: body.confirm_phone,
    confirm_email: body.confirm_email,
    phone_confirmed: body.confirm_phone || void 0,
    email_confirmed: body.confirm_email || void 0
  };
  const target = await getUserById(c.env.DB, id);
  if (!target)
    return jsonError(c, 404, "User not found");
  if (target.role === "head")
    return c.json({ ok: true });
  const now = nowIso();
  let phone_confirmed = target.phone_confirmed ? 1 : 0;
  let email_confirmed = target.email_confirmed ? 1 : 0;
  if (body.confirm_phone)
    phone_confirmed = 1;
  if (body.confirm_email)
    email_confirmed = 1;
  if (!phone_confirmed || !email_confirmed)
    return jsonError(c, 400, "Confirm both phone and email before approving");
  await c.env.DB.prepare(
    `UPDATE users SET status='approved', phone_confirmed=1, email_confirmed=1,
     phone_confirmed_at=COALESCE(phone_confirmed_at,?), email_confirmed_at=COALESCE(email_confirmed_at,?) WHERE id=?`
  ).bind(now, now, id).run();
  const updated = await getUserById(c.env.DB, id);
  await notifyInAppAndEmail(c.env.DB, c.env, [updated], {
    title: "Account approved",
    body: "You can now use SiteDesk.",
    link: "/app"
  });
  return c.json({ ok: true });
});
app.post("/api/admin/users/:id/reject", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const target = await getUserById(c.env.DB, id);
  if (!target)
    return jsonError(c, 404, "User not found");
  if (target.role === "head" || isHeadEmail(c.env, target.email))
    return jsonError(c, 403, "Cannot reject head");
  await c.env.DB.prepare(`UPDATE users SET status='rejected' WHERE id=?`).bind(id).run();
  await deleteUserSessions(c.env.DB, id);
  const updated = await getUserById(c.env.DB, id);
  await notifyInAppAndEmail(c.env.DB, c.env, [updated], {
    title: "Account rejected",
    body: "Your SiteDesk signup was rejected.",
    link: "/login"
  });
  return c.json({ ok: true });
});
app.post("/api/admin/users/:id/remove", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const target = await getUserById(c.env.DB, id);
  if (!target)
    return jsonError(c, 404, "User not found");
  if (target.role === "head" || isHeadEmail(c.env, target.email))
    return jsonError(c, 403, "Cannot remove head");
  if (target.role === "admin" && auth.user.role !== "head")
    return jsonError(c, 403, "Only head can remove admins");
  await c.env.DB.prepare(`UPDATE users SET status='disabled' WHERE id=?`).bind(id).run();
  await deleteUserSessions(c.env.DB, id);
  return c.json({ ok: true });
});
app.post("/api/admin/users/:id/make-admin", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  if (!canCreateAdmin(auth.user))
    return jsonError(c, 403, "Only head can create admins");
  const id = c.req.param("id");
  const target = await getUserById(c.env.DB, id);
  if (!target)
    return jsonError(c, 404, "User not found");
  if (isHeadEmail(c.env, target.email))
    return jsonError(c, 400, "User is already head");
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE users SET role='admin', status='approved', phone_confirmed=1, email_confirmed=1,
     phone_confirmed_at=COALESCE(phone_confirmed_at,?), email_confirmed_at=COALESCE(email_confirmed_at,?) WHERE id=?`
  ).bind(now, now, id).run();
  const updated = await getUserById(c.env.DB, id);
  await notifyInAppAndEmail(c.env.DB, c.env, [updated], {
    title: "Role updated: admin",
    body: "You are now an admin on SiteDesk.",
    link: "/app"
  });
  return c.json({ ok: true });
});
app.get("/api/admin/claims", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.slug, l.business_name, l.phone, l.category, l.status, l.site_url,
            l.claimed_at, l.claim_expires_at, l.claimed_by,
            u.name AS caller_name, u.email AS caller_email
     FROM leads l
     LEFT JOIN users u ON u.id = l.claimed_by
     WHERE l.status IN ('claimed','interested') AND l.claimed_by IS NOT NULL
     ORDER BY l.claimed_at DESC
     LIMIT 200`
  ).all();
  return c.json({
    claims: (results || []).map((r) => ({
      ...r,
      site_url: r.site_url || leadSiteUrl(r.slug, c.env.SITE_ORIGIN)
    }))
  });
});
app.post("/api/admin/leads/:id/unlock", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const id = c.req.param("id");
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE id=?").bind(id).first();
  if (!lead)
    return jsonError(c, 404, "Lead not found");
  await releaseLeadToOpen(c.env.DB, id, auth.user.id, "unlocked", "admin unlock");
  return c.json({ ok: true });
});
app.get("/api/admin/reports", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const status = String(c.req.query("status") || "open");
  let sql = `SELECT r.*, l.business_name, l.phone, l.slug, l.site_url, l.status AS lead_status, u.name AS reporter_name
    FROM lead_reports r JOIN leads l ON l.id=r.lead_id JOIN users u ON u.id=r.user_id`;
  const binds = [];
  if (status && status !== "all") {
    sql += ` WHERE r.status=?`;
    binds.push(status);
  }
  sql += ` ORDER BY r.created_at DESC LIMIT 100`;
  const { results } = await (binds.length ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql)).all();
  return c.json({ reports: (results || []).map((r) => ({
    ...r,
    site_url: r.site_url || leadSiteUrl(r.slug, c.env.SITE_ORIGIN)
  })) });
});
app.post("/api/admin/reports/:id/resolve", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || "dismiss");
  const report = await c.env.DB.prepare("SELECT * FROM lead_reports WHERE id=?").bind(c.req.param("id")).first();
  if (!report)
    return jsonError(c, 404, "Report not found");
  const now = nowIso();
  const newStatus = action === "close_lead" ? "closed" : "dismissed";
  await c.env.DB.prepare(
    `UPDATE lead_reports SET status=?, resolved_at=?, resolved_by=? WHERE id=?`
  ).bind(newStatus, now, auth.user.id, report.id).run();
  if (action === "close_lead") {
    await c.env.DB.prepare(
      `UPDATE leads SET status='closed', claimed_by=NULL, claimed_at=NULL, claim_expires_at=NULL,
       last_outcome='bad_lead', updated_at=? WHERE id=?`
    ).bind(now, report.lead_id).run();
    await c.env.DB.prepare(
      `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'bad_lead','closed via report',?)`
    ).bind(newId(), report.lead_id, auth.user.id, now).run();
  }
  return c.json({ ok: true, status: newStatus });
});
app.get("/api/admin/inbox", async (c) => {
  const auth = await requireInbox(c);
  if (auth.error)
    return auth.error;
  const scope = String(c.req.query("scope") || "").toLowerCase();
  const builderOnly = auth.user.role === "builder";
  const useMine = scope === "mine" || builderOnly && scope !== "all";
  let sql = `SELECT i.*, l.business_name, l.phone, l.slug, l.site_url,
                    u.name AS caller_name, u.payout_method AS caller_payout_method, u.payout_details AS caller_payout_details,
                    a.name AS assignee_name, a.role AS assignee_role
     FROM intakes i
     JOIN leads l ON l.id=i.lead_id
     JOIN users u ON u.id=i.user_id
     LEFT JOIN users a ON a.id=i.assigned_to`;
  const binds = [];
  if (useMine) {
    sql += ` WHERE i.assigned_to = ? OR i.assigned_to IS NULL`;
    binds.push(auth.user.id);
  }
  sql += ` ORDER BY i.created_at DESC`;
  const { results } = await (binds.length ? c.env.DB.prepare(sql).bind(...binds) : c.env.DB.prepare(sql)).all();
  const intakes = (results || []).map((row) => {
    let images = [];
    try {
      const p = JSON.parse(row.logo_images);
      if (Array.isArray(p))
        images = p;
    } catch {
    }
    return { ...row, site_url: row.site_url || leadSiteUrl(row.slug, c.env.SITE_ORIGIN), logo_image_list: images };
  });
  const builders = await listAssignableUsers(c.env.DB);
  return c.json({ intakes, builders, scope: useMine ? "mine" : "all" });
});
app.patch("/api/admin/intakes/:id/assign", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const raw2 = body.user_id;
  const user_id = raw2 == null || raw2 === "" ? null : String(raw2).trim();
  const intake = await c.env.DB.prepare("SELECT * FROM intakes WHERE id=?").bind(c.req.param("id")).first();
  if (!intake)
    return jsonError(c, 404, "Intake not found");
  let assignee = null;
  if (user_id) {
    assignee = await getUserById(c.env.DB, user_id);
    if (!assignee)
      return jsonError(c, 404, "User not found");
    if (!["builder", "head", "admin"].includes(assignee.role)) {
      return jsonError(c, 400, "Target must be builder (or head/admin)");
    }
    if (assignee.status !== "approved")
      return jsonError(c, 400, "Target must be approved");
  }
  const now = nowIso();
  await c.env.DB.prepare(`UPDATE intakes SET assigned_to=?, updated_at=? WHERE id=?`).bind(user_id, now, intake.id).run();
  if (assignee && assignee.id !== auth.user.id) {
    const lead = await c.env.DB.prepare("SELECT business_name FROM leads WHERE id=?").bind(intake.lead_id).first();
    await notifyInAppAndEmail(c.env.DB, c.env, [assignee], {
      title: "Intake assigned to you",
      body: `${lead?.business_name || "An intake"} \u2014 assigned by ${auth.user.name}`,
      link: "/app"
    });
  }
  return c.json({
    ok: true,
    assigned_to: user_id,
    assignee: assignee ? { id: assignee.id, name: assignee.name, role: assignee.role } : null
  });
});
app.post("/api/admin/sync-leads", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  try {
    const result = await syncLeadsFromCatalog(c.env);
    return c.json(result);
  } catch (e) {
    return jsonError(c, 502, e.message || "Catalog sync failed");
  }
});
app.post("/api/admin/intakes/:id/status", async (c) => {
  const auth = await requireInbox(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const status = String(body.status || "");
  if (!INTAKE_STATUSES.has(status))
    return jsonError(c, 400, "Invalid intake status");
  const intake = await c.env.DB.prepare("SELECT * FROM intakes WHERE id=?").bind(c.req.param("id")).first();
  if (!intake)
    return jsonError(c, 404, "Intake not found");
  const now = nowIso();
  await c.env.DB.prepare(`UPDATE intakes SET status=?, updated_at=? WHERE id=?`).bind(status, now, intake.id).run();
  if (status === "paid") {
    await c.env.DB.prepare(
      `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'work_done',?,?)`
    ).bind(newId(), intake.lead_id, intake.user_id, "Business paid \xB7 ready for admin to pay caller", now).run();
    await c.env.DB.prepare(`UPDATE leads SET status='sold', last_outcome='sold', updated_at=? WHERE id=?`).bind(now, intake.lead_id).run();
    try {
      await c.env.DB.prepare(`UPDATE intakes SET payout_status='ready_to_pay', updated_at=? WHERE id=?`).bind(now, intake.id).run();
    } catch (e) {
      console.error("payout_status update failed", e);
    }
    try {
      const purged = await deleteIntakeAssets(c.env, intake);
      await c.env.DB.prepare(
        `UPDATE intakes SET logo_images=?, extras=CASE WHEN extras IS NULL OR extras='' THEN ? ELSE extras END, updated_at=? WHERE id=?`
      ).bind(
        JSON.stringify([]),
        purged.deleted ? `[assets purged: ${purged.deleted} files]` : "[assets purged]",
        now,
        intake.id
      ).run();
    } catch (e) {
      console.error("intake asset purge failed", intake.id, e);
    }
    try {
      const lead = await c.env.DB.prepare("SELECT business_name FROM leads WHERE id=?").bind(intake.lead_id).first();
      await notifyRolesInAppAndEmail(c.env.DB, c.env, ["head", "admin"], {
        title: "Done \xB7 ready to pay caller",
        body: `${lead?.business_name || "Intake"} is business-paid \u2014 pay the caller when ready.`,
        link: "/app"
      });
    } catch (e) {
      console.error("ready-to-pay notify failed", e);
    }
  }
  const caller = await getUserById(c.env.DB, intake.user_id);
  if (caller) {
    const title = status === "paid" ? "Business paid \xB7 work done" : `Intake \u2192 ${status}`;
    const body2 = status === "paid" ? "The business paid. Admin will send your payout using the method on your profile." : `Your intake was updated to ${status}.`;
    await notifyInAppAndEmail(c.env.DB, c.env, [caller], { title, body: body2, link: "/app" });
  }
  return c.json({ ok: true, status });
});
app.post("/api/admin/intakes/:id/mark-paid-to-caller", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const intake = await c.env.DB.prepare("SELECT * FROM intakes WHERE id=?").bind(c.req.param("id")).first();
  if (!intake)
    return jsonError(c, 404, "Intake not found");
  if (intake.status !== "paid")
    return jsonError(c, 400, "Mark business paid first");
  const caller = await getUserById(c.env.DB, intake.user_id);
  const body = await c.req.json().catch(() => ({}));
  const force = !!body.force;
  if ((!caller?.payout_method || !caller?.payout_details) && !force) {
    return c.json({
      ok: false,
      warn: true,
      missing_payout_method: true,
      error: "Caller has no payment method on file. Ask them to set How you get paid, or retry with force."
    }, 400);
  }
  const now = nowIso();
  await c.env.DB.prepare(`UPDATE intakes SET payout_status='paid_to_caller', updated_at=? WHERE id=?`).bind(now, intake.id).run();
  await c.env.DB.prepare(
    `INSERT INTO lead_events (id,lead_id,user_id,kind,note,created_at) VALUES (?,?,?,'paid_to_caller',?,?)`
  ).bind(newId(), intake.lead_id, auth.user.id, "Admin marked paid to caller", now).run();
  try {
    await c.env.DB.prepare(
      `UPDATE payouts SET status='paid', paid_at=?, paid_by=? WHERE intake_id=? AND status='owed'`
    ).bind(now, auth.user.id, intake.id).run();
  } catch {
  }
  if (caller) {
    await notifyInAppAndEmail(c.env.DB, c.env, [caller], {
      title: "Paid to you",
      body: "Admin marked your payout as sent. Check your Cash App / Venmo / etc.",
      link: "/app"
    });
  }
  return c.json({ ok: true, payout_status: "paid_to_caller", warned_missing_method: !caller?.payout_method });
});
app.get("/api/intakes/:id/messages", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const intake = await c.env.DB.prepare("SELECT * FROM intakes WHERE id=?").bind(c.req.param("id")).first();
  if (!intake)
    return jsonError(c, 404, "Intake not found");
  const allowed = intake.user_id === auth.user.id || canSeeInbox(auth.user) || canManageUsers(auth.user);
  if (!allowed)
    return jsonError(c, 403, "Not allowed");
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.body, m.created_at, m.user_id, u.name AS author_name, u.role AS author_role
     FROM intake_messages m JOIN users u ON u.id = m.user_id
     WHERE m.intake_id = ? ORDER BY m.created_at ASC LIMIT 200`
  ).bind(intake.id).all();
  return c.json({ messages: results || [] });
});
app.post("/api/intakes/:id/messages", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const intake = await c.env.DB.prepare("SELECT * FROM intakes WHERE id=?").bind(c.req.param("id")).first();
  if (!intake)
    return jsonError(c, 404, "Intake not found");
  const allowed = intake.user_id === auth.user.id || canSeeInbox(auth.user) || canManageUsers(auth.user);
  if (!allowed)
    return jsonError(c, 403, "Not allowed");
  const body = await c.req.json().catch(() => ({}));
  const text = String(body.body || "").trim();
  if (!text || text.length > 4e3)
    return jsonError(c, 400, "Message required (max 4000)");
  const now = nowIso();
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO intake_messages (id, intake_id, user_id, body, created_at) VALUES (?,?,?,?,?)`
  ).bind(id, intake.id, auth.user.id, text, now).run();
  const lead = await c.env.DB.prepare("SELECT business_name FROM leads WHERE id=?").bind(intake.lead_id).first();
  const recipients = [];
  const caller = await getUserById(c.env.DB, intake.user_id);
  if (caller && caller.id !== auth.user.id)
    recipients.push(caller);
  if (intake.assigned_to && intake.assigned_to !== auth.user.id) {
    const asg = await getUserById(c.env.DB, intake.assigned_to);
    if (asg && !recipients.find((r) => r.id === asg.id))
      recipients.push(asg);
  }
  const managers = await usersByRoles(c.env.DB, ["head", "admin"]);
  for (const m of managers || []) {
    if (m.id !== auth.user.id && !recipients.find((r) => r.id === m.id))
      recipients.push(m);
  }
  await notifyInAppAndEmail(c.env.DB, c.env, recipients, {
    title: "New build message",
    body: `${auth.user.name} on ${lead?.business_name || "intake"}: ${text.slice(0, 140)}`,
    link: "/app"
  });
  return c.json({
    message: {
      id,
      intake_id: intake.id,
      user_id: auth.user.id,
      body: text,
      created_at: now,
      author_name: auth.user.name,
      author_role: auth.user.role
    }
  });
});
app.get("/api/admin/payouts", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const filter = String(c.req.query("status") || "ready").toLowerCase();
  let where = `i.status='paid'`;
  if (filter === "ready" || filter === "owed" || filter === "ready_to_pay") {
    where += ` AND (i.payout_status='ready_to_pay' OR i.payout_status='owed' OR i.payout_status IS NULL OR i.payout_status='')`;
  } else if (filter === "paid_to_caller" || filter === "paid" || filter === "paid_out") {
    where += ` AND (i.payout_status='paid_to_caller' OR i.payout_status='paid_out' OR i.payout_status='paid')`;
  }
  const sql = `SELECT i.id, i.status, i.payout_status, i.business_email, i.created_at, i.updated_at,
      i.user_id, i.lead_id,
      u.name AS caller_name, u.email AS caller_email,
      u.payout_method AS caller_payout_method, u.payout_details AS caller_payout_details,
      l.business_name, l.slug, l.phone, l.site_url
    FROM intakes i
    JOIN users u ON u.id=i.user_id
    JOIN leads l ON l.id=i.lead_id
    WHERE ${where}
    ORDER BY i.updated_at DESC LIMIT 200`;
  const { results } = await c.env.DB.prepare(sql).all();
  const totals = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status='paid' AND (payout_status='ready_to_pay' OR payout_status='owed' OR payout_status IS NULL OR payout_status='') THEN 1 ELSE 0 END) AS ready_n,
       SUM(CASE WHEN status='paid' AND (payout_status='paid_to_caller' OR payout_status='paid_out' OR payout_status='paid') THEN 1 ELSE 0 END) AS paid_n
     FROM intakes`
  ).first();
  const rows = (results || []).map((r) => {
    const ps = r.payout_status;
    const ready = !ps || ps === "ready_to_pay" || ps === "owed";
    return {
      ...r,
      payout_status: ready ? "ready_to_pay" : "paid_to_caller",
      status_label: ready ? "ready_to_pay" : "paid_to_caller"
    };
  });
  return c.json({
    items: rows,
    payouts: rows,
    // back-compat for older UI keys
    callers: [],
    totals: {
      ready_n: Number(totals?.ready_n || 0),
      paid_n: Number(totals?.paid_n || 0),
      owed_n: Number(totals?.ready_n || 0),
      owed_amt: 0,
      paid_amt: 0
    }
  });
});
app.post("/api/admin/payouts/:id/mark-paid", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const payout = await c.env.DB.prepare("SELECT * FROM payouts WHERE id=?").bind(c.req.param("id")).first();
  if (!payout)
    return jsonError(c, 404, "Payout not found");
  if (payout.status === "paid")
    return c.json({ ok: true, already: true });
  const caller = await getUserById(c.env.DB, payout.user_id);
  const missingMethod = !caller?.payout_method || !caller?.payout_details;
  const force = !!(await c.req.json().catch(() => ({}))).force;
  if (missingMethod && !force) {
    return c.json({
      ok: false,
      warn: true,
      error: "Caller has no payout method on file \u2014 ask them to set How you get paid in Profile, or retry with force.",
      missing_payout_method: true
    }, 400);
  }
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE payouts SET status='paid', paid_at=?, paid_by=? WHERE id=?`
  ).bind(now, auth.user.id, payout.id).run();
  await c.env.DB.prepare(
    `UPDATE intakes SET payout_status='paid_out', updated_at=? WHERE id=?`
  ).bind(now, payout.intake_id).run();
  if (caller) {
    await notifyInAppAndEmail(c.env.DB, c.env, [caller], {
      title: "Paid out",
      body: `$${payout.amount} first-month payout sent to you.`,
      link: "/app"
    });
  }
  return c.json({ ok: true, warned_missing_method: missingMethod });
});
app.get("/api/me/payouts", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.status, i.payout_status, i.updated_at, i.created_at, l.business_name, l.slug
     FROM intakes i JOIN leads l ON l.id=i.lead_id
     WHERE i.user_id=? AND i.status='paid'
     ORDER BY i.updated_at DESC LIMIT 50`
  ).bind(auth.user.id).all();
  const items = (results || []).map((r) => {
    const ready = !r.payout_status || r.payout_status === "ready_to_pay" || r.payout_status === "owed";
    return {
      ...r,
      status_label: ready ? "ready_to_pay" : "paid_to_caller",
      business_name: r.business_name
    };
  });
  return c.json({
    payouts: items,
    items,
    ready_n: items.filter((x) => x.status_label === "ready_to_pay").length,
    paid_n: items.filter((x) => x.status_label === "paid_to_caller").length,
    owed_amt: 0,
    paid_amt: 0
  });
});
app.get("/api/drafts", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  try {
    await ensureDefaultDraftTemplates(c.env.DB);
  } catch {
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.*, u.name AS updated_by_name FROM draft_templates t
     LEFT JOIN users u ON u.id=t.updated_by
     ORDER BY kind, category IS NOT NULL, category`
  ).all();
  return c.json({ templates: results || [], placeholders: ["{caller}", "{business}", "{link}", "{price}"] });
});
app.put("/api/admin/drafts/:id", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const tpl = await c.env.DB.prepare("SELECT * FROM draft_templates WHERE id=?").bind(c.req.param("id")).first();
  if (!tpl)
    return jsonError(c, 404, "Template not found");
  const text = body.body != null ? String(body.body) : tpl.body;
  if (!text.trim())
    return jsonError(c, 400, "Body required");
  const category = body.category !== void 0 ? body.category ? String(body.category).trim() : null : tpl.category;
  const now = nowIso();
  await c.env.DB.prepare(
    `UPDATE draft_templates SET body=?, category=?, updated_at=?, updated_by=? WHERE id=?`
  ).bind(text, category, now, auth.user.id, tpl.id).run();
  const updated = await c.env.DB.prepare("SELECT * FROM draft_templates WHERE id=?").bind(tpl.id).first();
  return c.json({ template: updated });
});
app.post("/api/admin/drafts", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const kind = String(body.kind || "").toLowerCase();
  if (!["call", "sms"].includes(kind))
    return jsonError(c, 400, "kind must be call or sms");
  const text = String(body.body || "").trim();
  if (!text)
    return jsonError(c, 400, "Body required");
  const category = body.category ? String(body.category).trim() : null;
  const now = nowIso();
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO draft_templates (id, kind, category, body, updated_at, updated_by) VALUES (?,?,?,?,?,?)`
  ).bind(id, kind, category, text, now, auth.user.id).run();
  return c.json({ template: await c.env.DB.prepare("SELECT * FROM draft_templates WHERE id=?").bind(id).first() });
});
app.get("/api/admin/activity", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.id, e.kind, e.note, e.created_at, e.lead_id, e.user_id,
            u.name AS actor_name, l.business_name,
            'lead_event' AS source
     FROM lead_events e
     LEFT JOIN users u ON u.id=e.user_id
     LEFT JOIN leads l ON l.id=e.lead_id
     ORDER BY e.created_at DESC LIMIT 80`
  ).all();
  const { results: signups } = await c.env.DB.prepare(
    `SELECT id, name, email, role, status, created_at, 'signup' AS source
     FROM users ORDER BY created_at DESC LIMIT 40`
  ).all();
  const { results: reports } = await c.env.DB.prepare(
    `SELECT r.id, r.reason, r.note, r.status, r.created_at, r.lead_id, r.user_id,
            u.name AS actor_name, l.business_name, 'report' AS source
     FROM lead_reports r
     LEFT JOIN users u ON u.id=r.user_id
     LEFT JOIN leads l ON l.id=r.lead_id
     ORDER BY r.created_at DESC LIMIT 40`
  ).all();
  const items = [];
  for (const e of events || []) {
    items.push({
      id: "ev-" + e.id,
      source: "lead_event",
      at: e.created_at,
      title: e.kind,
      body: `${e.actor_name || "\u2014"} \xB7 ${e.business_name || e.lead_id || ""}${e.note ? " \u2014 " + e.note : ""}`
    });
  }
  for (const u of signups || []) {
    items.push({
      id: "su-" + u.id,
      source: "signup",
      at: u.created_at,
      title: "signup",
      body: `${u.name} (${u.email}) \xB7 ${u.role} \xB7 ${u.status}`
    });
  }
  for (const r of reports || []) {
    items.push({
      id: "rp-" + r.id,
      source: "report",
      at: r.created_at,
      title: "report:" + r.reason,
      body: `${r.actor_name || "\u2014"} \xB7 ${r.business_name || ""}${r.note ? " \u2014 " + r.note : ""} \xB7 ${r.status}`
    });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return c.json({ items: items.slice(0, 100) });
});
function csvEscape(v) {
  const s = String(v ?? "");
  if (/[",\n\r]/.test(s))
    return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
__name(csvEscape, "csvEscape");
app.get("/api/admin/export/intakes.csv", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.status, i.payout_status, i.business_email, i.created_at, i.updated_at, i.assigned_to,
            l.business_name, l.phone, l.slug, l.site_url, l.category,
            u.name AS caller_name, u.email AS caller_email,
            a.name AS assignee_name
     FROM intakes i
     JOIN leads l ON l.id=i.lead_id
     JOIN users u ON u.id=i.user_id
     LEFT JOIN users a ON a.id=i.assigned_to
     ORDER BY i.created_at DESC`
  ).all();
  const headers = ["id", "business_name", "phone", "business_email", "slug", "site_url", "category", "status", "payout_status", "caller_name", "caller_email", "assignee_name", "created_at", "updated_at"];
  const lines = [headers.join(",")];
  for (const r of results || []) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="sitedesk-intakes.csv"'
    }
  });
});
app.get("/api/admin/export/payouts.csv", async (c) => {
  const auth = await requireManager(c);
  if (auth.error)
    return auth.error;
  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.status, i.payout_status, i.business_email, i.created_at, i.updated_at,
            u.name AS caller_name, u.email AS caller_email,
            u.payout_method AS caller_payout_method, u.payout_details AS caller_payout_details,
            l.business_name, l.slug, l.phone
     FROM intakes i
     JOIN users u ON u.id=i.user_id
     JOIN leads l ON l.id=i.lead_id
     WHERE i.status='paid'
     ORDER BY i.updated_at DESC`
  ).all();
  const headers = ["id", "business_name", "slug", "phone", "business_email", "caller_name", "caller_email", "caller_payout_method", "caller_payout_details", "status", "payout_status", "created_at", "updated_at"];
  const lines = [headers.join(",")];
  for (const r of results || []) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="sitedesk-pay-status.csv"'
    }
  });
});
app.post("/api/push/subscribe", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  if (!vapidConfigured(c.env))
    return jsonError(c, 503, "Push not configured");
  const body = await c.req.json().catch(() => ({}));
  const endpoint = String(body.endpoint || "").trim();
  const p256dh = String(body.keys?.p256dh || body.p256dh || "").trim();
  const authK = String(body.keys?.auth || body.auth || "").trim();
  if (!endpoint || !p256dh || !authK)
    return jsonError(c, 400, "endpoint + keys required");
  const now = nowIso();
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, created_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, user_id=excluded.user_id`
  ).bind(endpoint, p256dh, authK, auth.user.id, now).run();
  return c.json({ ok: true });
});
app.delete("/api/push/subscribe", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const body = await c.req.json().catch(() => ({}));
  const endpoint = String(body.endpoint || "").trim();
  if (endpoint) {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?").bind(endpoint, auth.user.id).run();
  } else {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id=?").bind(auth.user.id).run();
  }
  return c.json({ ok: true });
});
app.get("/api/push/status", async (c) => {
  const auth = await requireApproved(c);
  if (auth.error)
    return auth.error;
  const row = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?"
  ).bind(auth.user.id).first();
  return c.json({ subscribed: Number(row?.n || 0) > 0, configured: vapidConfigured(c.env) });
});
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
function generateVerifyCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1e6;
  return String(n).padStart(6, "0");
}
__name(generateVerifyCode, "generateVerifyCode");
async function issueVerificationCode(c, user, channel) {
  const db = c.env.DB;
  const recent = await db.prepare(
    `SELECT created_at FROM verification_codes
       WHERE user_id=? AND channel=?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(user.id, channel).first();
  if (recent?.created_at) {
    const ageMs = Date.now() - new Date(recent.created_at).getTime();
    if (ageMs < 6e4) {
      const wait = Math.ceil((6e4 - ageMs) / 1e3);
      return { error: jsonError(c, 429, `Wait ${wait}s before requesting another code`) };
    }
  }
  await db.prepare(`DELETE FROM verification_codes WHERE user_id=? AND channel=?`).bind(user.id, channel).run();
  const code = generateVerifyCode();
  const code_hash = await sha256Hex(code);
  const id = newId();
  const created_at = nowIso();
  const expires_at = new Date(Date.now() + 15 * 6e4).toISOString();
  await db.prepare(
    `INSERT INTO verification_codes (id, user_id, channel, code_hash, expires_at, attempts, created_at)
       VALUES (?,?,?,?,?,0,?)`
  ).bind(id, user.id, channel, code_hash, expires_at, created_at).run();
  return { code, expires_at };
}
__name(issueVerificationCode, "issueVerificationCode");
async function confirmVerificationCode(c, user, channel, rawCode) {
  const code = String(rawCode || "").trim().replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code))
    return { error: jsonError(c, 400, "Enter the 6-digit code") };
  const db = c.env.DB;
  const row = await db.prepare(
    `SELECT * FROM verification_codes
       WHERE user_id=? AND channel=?
       ORDER BY created_at DESC LIMIT 1`
  ).bind(user.id, channel).first();
  if (!row)
    return { error: jsonError(c, 400, "No code pending \u2014 send a new one") };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.prepare(`DELETE FROM verification_codes WHERE user_id=? AND channel=?`).bind(user.id, channel).run();
    return { error: jsonError(c, 400, "Code expired \u2014 send a new one") };
  }
  if ((row.attempts || 0) >= 8) {
    await db.prepare(`DELETE FROM verification_codes WHERE user_id=? AND channel=?`).bind(user.id, channel).run();
    return { error: jsonError(c, 429, "Too many attempts \u2014 send a new code") };
  }
  const hash = await sha256Hex(code);
  if (hash !== row.code_hash) {
    await db.prepare(`UPDATE verification_codes SET attempts=attempts+1 WHERE id=?`).bind(row.id).run();
    return { error: jsonError(c, 400, "Incorrect code") };
  }
  const now = nowIso();
  if (channel === "email") {
    await db.prepare(
      `UPDATE users SET email_confirmed=1, email_confirmed_at=COALESCE(email_confirmed_at,?) WHERE id=?`
    ).bind(now, user.id).run();
  } else {
    await db.prepare(
      `UPDATE users SET phone_confirmed=1, phone_confirmed_at=COALESCE(phone_confirmed_at,?) WHERE id=?`
    ).bind(now, user.id).run();
  }
  await db.prepare(`DELETE FROM verification_codes WHERE user_id=? AND channel=?`).bind(user.id, channel).run();
  return { ok: true };
}
__name(confirmVerificationCode, "confirmVerificationCode");
app.post("/api/verify/email/send", async (c) => {
  return jsonError(c, 410, "Self-serve codes disabled \u2014 an admin confirms email/phone");
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  if (user.email_confirmed)
    return c.json({ ok: true, already: true, via: "email" });
  if (!user.email)
    return jsonError(c, 400, "No email on account");
  const issued = await issueVerificationCode(c, user, "email");
  if (issued.error)
    return issued.error;
  const sent = await sendEmail(c.env, {
    to: user.email,
    subject: "Your SiteDesk email confirmation code",
    text: `Your SiteDesk email confirmation code is: ${issued.code}

Enter this code in Profile to confirm your email. It expires in 15 minutes.
If you did not request this, you can ignore this message.
`,
    html: `<p>Your SiteDesk email confirmation code is:</p><p style="font-size:28px;letter-spacing:.2em;font-weight:700">${issued.code}</p><p>Enter this code in Profile to confirm your email. It expires in 15 minutes.</p>`
  });
  if (!sent.ok) {
    console.error("verify email send failed", sent.reason);
  }
  return c.json({ ok: true, via: "email", expires_at: issued.expires_at, delivered: !!sent.ok });
});
app.post("/api/verify/email/confirm", async (c) => {
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  if (user.email_confirmed)
    return c.json({ ok: true, user: publicUser(user) });
  const body = await c.req.json().catch(() => ({}));
  const result = await confirmVerificationCode(c, user, "email", body.code);
  if (result.error)
    return result.error;
  return c.json({ ok: true, user: publicUser(await getUserById(c.env.DB, user.id)) });
});
app.post("/api/verify/phone/send", async (c) => {
  return jsonError(c, 410, "Self-serve codes disabled \u2014 an admin confirms email/phone");
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  if (user.phone_confirmed)
    return c.json({ ok: true, already: true, via: "sms" });
  if (!user.phone)
    return jsonError(c, 400, "Add a phone number on your profile first");
  const issued = await issueVerificationCode(c, user, "phone");
  if (issued.error)
    return issued.error;
  const twilioReady = !!(c.env.TWILIO_ACCOUNT_SID && c.env.TWILIO_AUTH_TOKEN && c.env.TWILIO_FROM);
  let via = "email";
  let delivered = false;
  if (twilioReady) {
    const sms = await sendSms(c.env, {
      to: user.phone,
      body: `SiteDesk phone confirmation code: ${issued.code} (expires in 15 min)`
    });
    if (sms.ok) {
      via = "sms";
      delivered = true;
    } else {
      console.error("verify phone sms failed, falling back to email", sms.reason);
    }
  }
  if (!delivered) {
    if (!user.email)
      return jsonError(c, 500, "Could not deliver phone code (no SMS or email)");
    const sent = await sendEmail(c.env, {
      to: user.email,
      subject: "Confirm your SiteDesk phone number \u2014 verification code",
      text: `This code confirms your PHONE NUMBER (${user.phone}) on SiteDesk \u2014 not your email.

Your phone confirmation code is: ${issued.code}

Enter this code in Profile under Confirm phone. It expires in 15 minutes.
(SMS delivery is not configured yet, so we emailed this code instead.)
`,
      html: `<p><strong>This code confirms your phone number</strong> (${escHtml(user.phone)}) on SiteDesk \u2014 not your email.</p><p style="font-size:28px;letter-spacing:.2em;font-weight:700">${issued.code}</p><p>Enter this code in Profile under <em>Confirm phone</em>. It expires in 15 minutes.</p><p style="color:#888;font-size:12px">SMS is not configured yet, so we emailed this code instead.</p>`
    });
    via = "email";
    delivered = !!sent.ok;
    if (!sent.ok)
      console.error("verify phone email fallback failed", sent.reason);
  }
  return c.json({ ok: true, via, expires_at: issued.expires_at, delivered });
});
app.post("/api/verify/phone/confirm", async (c) => {
  const user = await requireUser(c);
  if (!user)
    return jsonError(c, 401, "Not authenticated");
  if (user.phone_confirmed)
    return c.json({ ok: true, user: publicUser(user) });
  const body = await c.req.json().catch(() => ({}));
  const result = await confirmVerificationCode(c, user, "phone", body.code);
  if (result.error)
    return result.error;
  return c.json({ ok: true, user: publicUser(await getUserById(c.env.DB, user.id)) });
});
function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(escHtml, "escHtml");
app.notFound((c) => {
  if (c.req.path.startsWith("/api/"))
    return jsonError(c, 404, "Not found");
  return serveUi(c);
});
app.onError((err, c) => {
  console.error(err);
  return jsonError(c, 500, err.message || "Server error");
});
async function runScheduledLeadSync(env) {
  try {
    const r = await syncLeadsFromCatalog(env);
    console.log("scheduled sync-leads", r);
  } catch (e) {
    console.error("scheduled sync-leads failed", e);
  }
}
__name(runScheduledLeadSync, "runScheduledLeadSync");
var src_default_orig = {
  fetch: (req, env, ctx) => app.fetch(req, env, ctx),
  scheduled: (event, env, ctx) => ctx.waitUntil(runScheduledLeadSync(env))
};
var src_default = {
  fetch: async function (req, env, ctx) {
    try {
      await ensureTursoEnv(env);
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Turso init failed: " + (e && e.message || e) }),
        { status: 500, headers: { "content-type": "application/json" } }
      );
    }
    return src_default_orig.fetch(req, env, ctx);
  },
  scheduled: async function (event, env, ctx) {
    try {
      await ensureTursoEnv(env);
    } catch (e) {
      console.error("Turso init failed (scheduled):", (e && e.message) || e);
      return;
    }
    return src_default_orig.scheduled(event, env, ctx);
  },
};
export {
  src_default as default
};
//# sourceMappingURL=index.js.map
