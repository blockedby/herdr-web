import http from "node:http";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  createSession,
  readConfig,
  verifyInitData,
  verifySession,
} from "./auth.mjs";

const MAX_BODY = 25 * 1024 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const WS_PATHS = new Set([
  "/ws/events",
  "/ws/activity",
  "/ws/ui-events",
  "/ws/terminal",
]);
const COOKIE_EXPIRED =
  "__Host-herdr_session=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0";

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function route(raw) {
  // Reject encoded paths: all Herdr API path components are simple identifiers.
  const pathname = raw?.split("?")[0];
  if (
    !pathname ||
    !/^\/(?:api|ws|auth)\/[a-zA-Z0-9_/-]+$/.test(pathname) ||
    pathname.includes("//") ||
    pathname.includes("..")
  )
    return null;
  return pathname;
}

async function loginBody(req) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 20000) throw new Error("Authorization payload too large");
    parts.push(part);
  }
  const body = JSON.parse(Buffer.concat(parts).toString());
  if (!body || typeof body.initData !== "string")
    throw new Error("Invalid authorization payload");
  return body.initData;
}

export function createGateway(config) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  const peers = new Set();
  const loginAttempts = new Map();
  const host = new URL(config.publicOrigin).host;
  const bridgeHost = new URL(config.bridgeOrigin).host;
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    if (req.headers.host !== host)
      return json(res, 403, { error: "Invalid host" });
    if (req.url === "/healthz" && req.method === "GET")
      return json(res, 200, { ok: true });
    const path = route(req.url);
    if (!path) return json(res, 404, { error: "Not found" });
    if (req.headers.origin !== config.frontendOrigin)
      return json(res, 403, { error: "Invalid origin" });
    res.setHeader("access-control-allow-origin", config.frontendOrigin);
    res.setHeader("access-control-allow-credentials", "true");
    res.setHeader("vary", "Origin");
    if (req.method === "OPTIONS") {
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("access-control-allow-headers", "Content-Type");
      res.writeHead(204);
      return res.end();
    }
    if (path === "/auth/login" && req.method === "POST") {
      const now = Date.now();
      // Caddy must overwrite this header with {remote_host}; the service is loopback-only.
      const address = req.headers["x-herdr-client-ip"];
      const client =
        typeof address === "string" && address.length <= 64
          ? address
          : req.socket.remoteAddress;
      for (const [key, attempt] of loginAttempts)
        if (now - attempt.start >= 60000) loginAttempts.delete(key);
      let attempt = loginAttempts.get(client);
      if (!attempt) {
        if (loginAttempts.size >= 1024)
          return json(res, 429, { error: "Try again shortly" });
        attempt = { start: now, count: 0 };
        loginAttempts.set(client, attempt);
      }
      if (++attempt.count > 30)
        return json(res, 429, { error: "Try again shortly" });
      if (req.headers["content-type"]?.split(";")[0] !== "application/json")
        return json(res, 415, { error: "Expected JSON" });
      try {
        const userId = verifyInitData(await loginBody(req), config);
        const session = createSession(userId, config);
        res.setHeader("set-cookie", session.cookie);
        return json(res, 200, { expiresAt: session.expiresAt });
      } catch {
        return json(res, 401, {
          error:
            "Access denied or Telegram authorization expired. Reopen the Mini App.",
        });
      }
    }
    const session = verifySession(req.headers.cookie, config);
    if (!session) {
      res.setHeader("set-cookie", COOKIE_EXPIRED);
      return json(res, 401, { error: "Authentication required" });
    }
    if (!path.startsWith("/api/") || !["GET", "POST"].includes(req.method))
      return json(res, 404, { error: "Not found" });
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY)
      return json(res, 413, { error: "Payload too large" });
    const headers = { host: bridgeHost, origin: config.bridgeOrigin };
    for (const name of ["content-type", "content-length", "accept"])
      if (req.headers[name]) headers[name] = req.headers[name];
    // Never forward cookies, credentials, proxy headers or client-selected destinations.
    const upstream = http.request(
      config.upstream + req.url,
      { method: req.method, headers, timeout: 15000 },
      (response) => {
        const out = {};
        for (const name of [
          "content-type",
          "content-length",
          "content-encoding",
        ])
          if (response.headers[name]) out[name] = response.headers[name];
        res.writeHead(response.statusCode ?? 502, out);
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent)
        json(res, 502, { error: "Home computer is unavailable" });
      else res.destroy();
    });
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(
          size > MAX_BODY ? new Error("Payload too large") : null,
          size > MAX_BODY ? undefined : chunk,
        );
      },
    });
    limiter.on("error", () => {
      upstream.destroy();
      if (!res.headersSent) json(res, 413, { error: "Payload too large" });
      else res.destroy();
    });
    req.on("error", () => {
      limiter.destroy();
      upstream.destroy();
    });
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(limiter).pipe(upstream);
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.on("upgrade", (req, socket, head) => {
    const path = route(req.url);
    const session = verifySession(req.headers.cookie, config);
    if (
      req.headers.host !== host ||
      req.headers.origin !== config.frontendOrigin ||
      !session ||
      !WS_PATHS.has(path)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = new WebSocket(
      config.upstream.replace("http:", "ws:") + req.url,
      {
        headers: { host: bridgeHost, origin: config.bridgeOrigin },
        handshakeTimeout: 5000,
        maxPayload: MAX_BUFFER,
        perMessageDeflate: false,
      },
    );
    socket.on("error", () => upstream.terminate());
    const abandon = () => upstream.terminate();
    socket.once("close", abandon);
    upstream.once("error", () => {
      if (!socket.destroyed)
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.once("open", () => {
      if (socket.destroyed || !verifySession(req.headers.cookie, config)) {
        upstream.terminate();
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        socket.removeListener("close", abandon);
        peers.add(upstream);
        peers.add(client);
        const expiry = setTimeout(
          () => {
            client.close(4401, "Session expired");
            upstream.terminate();
          },
          Math.max(1, session.expiresAt * 1000 - Date.now()),
        );
        expiry.unref();
        const forward = (destination, data, binary) => {
          if (destination.readyState !== WebSocket.OPEN) return;
          if (destination.bufferedAmount + data.length > MAX_BUFFER) {
            client.close(1013, "Slow connection");
            upstream.terminate();
            return;
          }
          destination.send(data, { binary }, (error) => {
            if (error) {
              client.terminate();
              upstream.terminate();
            }
          });
        };
        client.on("message", (data, binary) => forward(upstream, data, binary));
        upstream.on("message", (data, binary) => forward(client, data, binary));
        client.on("error", () => upstream.terminate());
        upstream.on("error", () => client.terminate());
        client.on("close", () => {
          clearTimeout(expiry);
          peers.delete(client);
          peers.delete(upstream);
          upstream.terminate();
        });
        upstream.on("close", () => {
          clearTimeout(expiry);
          peers.delete(upstream);
          client.close(1012, "Bridge disconnected");
        });
      });
    });
  });
  server.on("close", () => {
    for (const peer of peers) peer.terminate();
    wss.close();
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const config = readConfig(process.env);
    const server = createGateway(config);
    server.listen(config.port, "127.0.0.1", () =>
      console.log("Herdr gateway listening on loopback"),
    );
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => {
        server.close();
        server.closeAllConnections();
        setTimeout(() => process.exit(0), 1000).unref();
      });
  } catch {
    console.error("Herdr gateway configuration invalid; refusing startup");
    process.exitCode = 1;
  }
}
