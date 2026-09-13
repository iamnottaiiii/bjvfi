// SiteDesk — plain Node.js server (no Cloudflare)
// Runs the exact same worker.js (Hono + Turso) on a standard Node HTTP server.
// The worker's `fetch(request, env, ctx)` is the only entry point; we feed it
// real Web Request objects and write the Web Response back to Node's http.

import http from "node:http";
import { Readable } from "node:stream";
import worker from "./worker.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// Build the env/bindings object from process.env (same keys the worker reads).
function buildEnv() {
  const env = { ...process.env };
  // The worker auto-injects env.DB / env.ASSETS (Turso shim) on first request.
  return env;
}

// Convert a Node IncomingMessage into a Web Request.
function toWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const headers = new Headers();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
  }
  const init = { method: req.method, headers };
  // Pass the body through as a stream (works for JSON, form-data, uploads).
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

// Write a Web Response back to a Node ServerResponse.
async function writeResponse(res, webRes) {
  res.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      // set-cookie may be multi-valued
      const all = webRes.headers.getSetCookie ? webRes.headers.getSetCookie() : [value];
      for (const c of all) res.appendHeader("Set-Cookie", c);
    } else {
      res.setHeader(key, value);
    }
  });
  if (webRes.body) {
    const nodeStream = Readable.fromWeb(webRes.body);
    nodeStream.pipe(res);
  } else {
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const request = toWebRequest(req);
    const env = buildEnv();
    const ctx = { waitUntil: () => {} };
    const webRes = await worker.fetch(request, env, ctx);
    await writeResponse(res, webRes);
  } catch (err) {
    console.error("request error:", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Server error: " + (err && err.message) }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SiteDesk running on http://${HOST}:${PORT} (Node, no Cloudflare)`);
});

// Scheduled lead sync — replaces the Cloudflare `scheduled` handler.
// Runs every 6 hours by default (override with SYNC_INTERVAL_MINUTES).
const SYNC_MIN = Number(process.env.SYNC_INTERVAL_MINUTES || 360);
async function runScheduledSync() {
  try {
    const env = buildEnv();
    const ctx = { waitUntil: () => {} };
    // The worker's scheduled handler calls runScheduledLeadSync(env).
    await worker.scheduled({}, env, ctx);
    console.log("scheduled lead sync done", new Date().toISOString());
  } catch (e) {
    console.error("scheduled lead sync failed:", e);
  }
}
if (process.env.DISABLE_SYNC !== "1") {
  runScheduledSync(); // run once at startup
  setInterval(runScheduledSync, SYNC_MIN * 60 * 1000);
  console.log(`lead sync scheduled every ${SYNC_MIN} min`);
}
