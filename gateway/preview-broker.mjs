import http from "node:http";
import { realpathSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import {
  createPreviewRegistry,
  PREVIEW_ID,
  DEFAULT_BLOCKED_PORTS,
  loopbackLookup,
} from "./preview-registry.mjs";

export function defaultPreviewSocket(env = process.env) {
  return (
    env.HERDR_PREVIEW_SOCKET ||
    join(
      env.XDG_RUNTIME_DIR || join(homedir(), ".cache"),
      "herdr-preview",
      "control.sock",
    )
  );
}
export function brokerAuthorized(header, secret) {
  if (typeof header !== "string" || typeof secret !== "string") return false;
  const a = Buffer.from(header),
    b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function sendJson(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let length = 0;
  const parts = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 8192) throw new Error("Payload too large");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
function appRoute(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || /[\x00-\x20]/u.test(raw))
    return null;
  const match = /^\/proxy\/([a-f0-9]{32})(\/.*)?$/.exec(raw);
  return match ? { id: match[1], path: match[2] || "/" } : null;
}
function appHeaders(req, entry) {
  const headers = { ...req.headers };
  const appAuthorization = headers["x-herdr-preview-authorization"];
  delete headers["x-herdr-preview-authorization"];
  for (const key of [
    "authorization",
    "proxy-authorization",
    "x-herdr-client-ip",
    "x-forwarded-host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "forwarded",
    "connection",
    "upgrade",
    "host",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
  ])
    delete headers[key];
  if (appAuthorization) headers.authorization = appAuthorization;
  const host = entry.hostname === "::1" ? "[::1]" : entry.hostname;
  headers.host = `${host}:${entry.port}`;
  if (headers.origin) headers.origin = `http://${headers.host}`;
  return headers;
}

export function createPreviewBroker(registry, { secret } = {}) {
  if (typeof secret !== "string" || secret.length < 43)
    throw new Error("Preview tunnel secret is required");
  const active = new Map();
  function track(id, connection) {
    let set = active.get(id);
    if (!set) active.set(id, (set = new Set()));
    set.add(connection);
    connection.once("close", () => {
      set.delete(connection);
      if (!set.size) active.delete(id);
    });
  }
  const release = registry.onClose((id) => {
    for (const connection of active.get(id) ?? []) {
      if (connection instanceof WebSocket) connection.terminate();
      else connection.destroy();
    }
    active.delete(id);
  });
  async function control(req, res, local) {
    try {
      if (req.url === "/previews" && req.method === "GET")
        return sendJson(res, 200, await registry.list());
      const get = /^\/previews\/([a-f0-9]{32})$/.exec(req.url ?? "");
      if (get && req.method === "GET") {
        const entry = registry.get(get[1]);
        return sendJson(
          res,
          entry ? 200 : 404,
          entry ?? { error: "Preview is closed" },
        );
      }
      if (req.url === "/open" && req.method === "POST" && local)
        return sendJson(res, 200, await registry.open(await body(req)));
      if (req.url === "/close" && req.method === "POST") {
        const data = await body(req);
        return sendJson(res, 200, await registry.close(data.id));
      }
      return sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      return sendJson(res, 400, {
        error: local ? error.message : "Invalid preview request",
      });
    }
  }
  const local = http.createServer((req, res) => void control(req, res, true));
  const data = http.createServer((req, res) => {
    if (!brokerAuthorized(req.headers.authorization, secret))
      return sendJson(res, 403, { error: "Forbidden" });
    const route = appRoute(req.url);
    if (!route) return void control(req, res, false);
    const entry = registry.get(route.id);
    if (!entry) return sendJson(res, 404, { error: "Preview is closed" });
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        req.method,
      )
    )
      return sendJson(res, 405, { error: "Method not allowed" });
    const upstream = http.request(
      {
        hostname: entry.hostname,
        port: entry.port,
        path: route.path,
        method: req.method,
        headers: appHeaders(req, entry),
        lookup: loopbackLookup,
        autoSelectFamily: true,
        timeout: 15000,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    track(entry.id, upstream);
    track(entry.id, res);
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent)
        sendJson(res, 502, { error: "Dev server is unavailable" });
      else res.destroy();
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  const selectedProtocols = new WeakMap();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (_protocols, req) => selectedProtocols.get(req) || false,
  });
  data.on("upgrade", (req, socket, head) => {
    const route = appRoute(req.url);
    const entry = route && registry.get(route.id);
    if (
      !brokerAuthorized(req.headers.authorization, secret) ||
      !entry ||
      !PREVIEW_ID.test(entry.id)
    )
      return socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    const host = entry.hostname === "::1" ? "[::1]" : entry.hostname;
    const protocols = req.headers["sec-websocket-protocol"]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      protocols &&
      (protocols.length > 16 ||
        new Set(protocols).size !== protocols.length ||
        protocols.some(
          (protocol) =>
            protocol.length > 128 ||
            !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(protocol),
        ))
    )
      return socket.destroy();
    const upstream = new WebSocket(
      `ws://${host}:${entry.port}${route.path}`,
      protocols,
      {
        headers: appHeaders(req, entry),
        lookup: loopbackLookup,
        autoSelectFamily: true,
        handshakeTimeout: 5000,
        maxPayload: 8 * 1024 * 1024,
        perMessageDeflate: false,
      },
    );
    track(entry.id, upstream);
    const abandon = () => upstream.terminate();
    socket.once("close", abandon);
    socket.on("error", abandon);
    upstream.once("error", () => {
      if (!socket.destroyed)
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.once("open", () => {
      if (socket.destroyed || !registry.get(entry.id)) {
        upstream.terminate();
        socket.destroy();
        return;
      }
      selectedProtocols.set(req, upstream.protocol);
      wss.handleUpgrade(req, socket, head, (client) => {
        socket.removeListener("close", abandon);
        track(entry.id, client);
        for (const [source, destination] of [
          [client, upstream],
          [upstream, client],
        ]) {
          source.on("message", (chunk, binary) => {
            if (destination.readyState !== WebSocket.OPEN) return;
            if (destination.bufferedAmount + chunk.length > 8 * 1024 * 1024) {
              client.terminate();
              upstream.terminate();
              return;
            }
            destination.send(chunk, { binary }, (error) => {
              if (error) {
                client.terminate();
                upstream.terminate();
              }
            });
          });
          source.on("error", () => destination.terminate());
          source.on("close", () => destination.close());
        }
      });
    });
  });
  for (const server of [local, data]) {
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
  }
  data.once("close", () => {
    release();
    for (const set of active.values())
      for (const connection of set) {
        if (connection instanceof WebSocket) connection.terminate();
        else connection.destroy();
      }
    wss.close();
  });
  return { local, data };
}

const isMain = (() => {
  try {
    return Boolean(
      process.argv[1] &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url)),
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  try {
    const port = Number(process.env.HERDR_PREVIEW_PORT ?? 8790);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Invalid broker port");
    const extra = (process.env.HERDR_PREVIEW_BLOCKED_PORTS ?? "")
      .split(",")
      .filter(Boolean)
      .map(Number);
    if (
      extra.some(
        (value) => !Number.isInteger(value) || value < 1 || value > 65535,
      )
    )
      throw new Error("Invalid blocked ports");
    const registry = await createPreviewRegistry({
      file: process.env.HERDR_PREVIEW_STATE,
      blockedPorts: [...DEFAULT_BLOCKED_PORTS, port, ...extra],
    });
    const servers = createPreviewBroker(registry, {
      secret: process.env.HERDR_PREVIEW_SECRET,
    });
    const socket = defaultPreviewSocket();
    await mkdir(dirname(socket), { recursive: true, mode: 0o700 });
    // A supervised single instance owns this socket; refuse to unlink a possibly active service.
    servers.local.once("error", () => {
      console.error("Preview control socket unavailable; refusing startup");
      process.exitCode = 1;
      servers.data.close();
    });
    servers.local.listen(socket, async () => {
      await chmod(socket, 0o600);
      servers.data.listen(port, "127.0.0.1", () =>
        console.log("Herdr preview broker listening privately"),
      );
    });
    for (const signal of ["SIGTERM", "SIGINT"])
      process.on(signal, () => {
        servers.local.close();
        servers.data.close();
        servers.local.closeAllConnections();
        servers.data.closeAllConnections();
        void unlink(socket).catch(() => {});
        setTimeout(() => process.exit(0), 1000).unref();
      });
  } catch {
    console.error("Preview broker configuration invalid; refusing startup");
    process.exitCode = 1;
  }
}
