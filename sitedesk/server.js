import http from "node:http";
import { URL } from "node:url";
import worker from "./worker.js";

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

function toWebRequest(req, body) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `${HOST}:${PORT}`;
  const url = `${protocol}://${host}${req.url}`;
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = toWebRequest(req, body);
    const response = await worker.fetch(request, { env: process.env, waitUntil() {} }, {});

    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const responseBody = Buffer.from(await response.arrayBuffer());
    res.end(responseBody);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SiteDesk running on http://${HOST}:${PORT}`);
});

const syncMinutes = Number(process.env.SYNC_INTERVAL_MINUTES || 360);
if (process.env.DISABLE_SYNC !== "1" && syncMinutes > 0) {
  setInterval(async () => {
    try {
      if (typeof worker.scheduled === "function") {
        await worker.scheduled({}, { env: process.env, waitUntil() {} }, {});
      }
    } catch (error) {
      console.error("Scheduled sync failed:", error);
    }
  }, syncMinutes * 60 * 1000);
}
