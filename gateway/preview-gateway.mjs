import http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { sendJson } from "./preview-broker.mjs";
import { PREVIEW_ID } from "./preview-registry.mjs";

const COOKIE = "__Host-herdr_preview";
const MAX_BODY = 25 * 1024 * 1024;
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function signature(secret, purpose, payload) {
  return createHmac("sha256", secret)
    .update(purpose + ":" + payload)
    .digest();
}
function encode(secret, purpose, value) {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    payload + "." + signature(secret, purpose, payload).toString("base64url")
  );
}
function decode(secret, purpose, token) {
  if (typeof token !== "string" || token.length > 4096) return null;
  const parts = token.split(".");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return null;
  const a = signature(secret, purpose, parts[0]),
    b = Buffer.from(parts[1], "base64url");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(parts[0], "base64url").toString());
  } catch {
    return null;
  }
}
export function readPreviewConfig(env, auth) {
  if (
    !env.HERDR_PREVIEW_DOMAIN &&
    !env.HERDR_PREVIEW_SECRET &&
    !env.HERDR_PREVIEW_UPSTREAM
  )
    return null;
  const domain = env.HERDR_PREVIEW_DOMAIN;
  const parent = new URL(auth.frontendOrigin).hostname
    .split(".")
    .slice(1)
    .join(".");
  if (
    typeof domain !== "string" ||
    domain.length > 190 ||
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(domain) ||
    !parent ||
    !domain.endsWith("." + parent) ||
    domain === new URL(auth.frontendOrigin).hostname ||
    domain === new URL(auth.publicOrigin).hostname
  )
    throw new Error("Preview domain must be a separate sibling HTTPS domain");
  const secret = env.HERDR_PREVIEW_SECRET;
  if (typeof secret !== "string" || secret.length < 43)
    throw new Error("Preview tunnel secret is required");
  const url = new URL(env.HERDR_PREVIEW_UPSTREAM ?? "http://127.0.0.1:28789");
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.href !== url.origin + "/"
  )
    throw new Error("Preview broker must be a fixed loopback HTTP origin");
  return { domain, secret, upstream: url.origin };
}
function requestHeaders(req, secret) {
  const headers = {};
  const extraHop = String(req.headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      !HOP_HEADERS.has(key) &&
      !extraHop.includes(key) &&
      ![
        "host",
        "authorization",
        "cookie",
        "forwarded",
        "x-herdr-client-ip",
        "x-forwarded-host",
        "x-forwarded-for",
        "x-forwarded-proto",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
        "x-herdr-preview-authorization",
      ].includes(key)
    )
      headers[key] = value;
  }
  const cookies = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .filter((part) => !part.startsWith("__Host-herdr_"));
  if (cookies?.length) headers.cookie = cookies.join("; ");
  if (req.headers.authorization)
    headers["x-herdr-preview-authorization"] = req.headers.authorization;
  headers.authorization = `Bearer ${secret}`;
  return headers;
}
export function createPreviewGateway(config) {
  const preview = config.preview;
  const issued = new Map(),
    peers = new Set();
  const selectedProtocols = new WeakMap();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (_protocols, req) => selectedProtocols.get(req) || false,
  });
  function hostId(host) {
    if (typeof host !== "string") return null;
    const suffix = "." + preview.domain;
    if (!host.endsWith(suffix)) return null;
    const label = host.slice(0, -suffix.length);
    return label.startsWith("p-") && PREVIEW_ID.test(label.slice(2))
      ? label.slice(2)
      : null;
  }
  async function broker(path) {
    const response = await fetch(preview.upstream + path, {
      headers: { authorization: `Bearer ${preview.secret}` },
      signal: AbortSignal.timeout(2500),
      redirect: "error",
    });
    if (!response.ok) return null;
    const raw = await response.text();
    if (raw.length > 262144) throw new Error("Invalid broker response");
    return JSON.parse(raw);
  }
  function previewSession(cookie, id) {
    if (typeof cookie !== "string" || cookie.length > 8192) return null;
    const tokens = cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(COOKIE + "="));
    if (tokens.length !== 1) return null;
    const value = decode(
      config.sessionSecret,
      "preview-cookie",
      tokens[0].slice(COOKIE.length + 1),
    );
    if (
      !value ||
      value.id !== id ||
      value.userId !== config.allowedUserId ||
      !Number.isInteger(value.expiresAt) ||
      value.expiresAt <= Date.now() / 1000 ||
      value.expiresAt > Date.now() / 1000 + 3600
    )
      return null;
    return value;
  }
  function responseHeaders(headers, id, entry) {
    const out = {};
    for (const [key, value] of Object.entries(headers))
      if (
        !HOP_HEADERS.has(key) &&
        ![
          "set-cookie",
          "content-security-policy",
          "x-frame-options",
          "cache-control",
          "referrer-policy",
          "clear-site-data",
        ].includes(key)
      )
        out[key] = value;
    const csp =
      typeof headers["content-security-policy"] === "string"
        ? headers["content-security-policy"]
            .split(";")
            .filter((part) => !/^\s*frame-ancestors(?:\s|$)/.test(part))
            .join(";")
        : "";
    out["content-security-policy"] =
      `${csp}${csp ? "; " : ""}frame-ancestors ${config.frontendOrigin}`;
    out["cache-control"] = "no-store";
    out["referrer-policy"] = "no-referrer";
    const cookies = headers["set-cookie"]
      ?.filter((cookie) => !/^\s*__Host-herdr_/i.test(cookie))
      .map((cookie) =>
        cookie
          .split(";")
          .filter((part) => !/^\s*domain\s*=/i.test(part))
          .join(";"),
      );
    if (cookies?.length) out["set-cookie"] = cookies;
    if (typeof headers.location === "string") {
      try {
        const target = new URL(
          headers.location,
          `http://${entry.hostname === "::1" ? "[::1]" : entry.hostname}:${entry.port}`,
        );
        if (
          ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
          Number(target.port) === entry.port
        )
          out.location = `https://p-${id}.${preview.domain}${target.pathname}${target.search}${target.hash}`;
      } catch {
        delete out.location;
      }
    }
    return out;
  }
  function proxy(req, res, path, id, entry) {
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY)
      return sendJson(res, 413, { error: "Payload too large" });
    const upstream = http.request(
      preview.upstream + path,
      {
        method: req.method,
        headers: requestHeaders(req, preview.secret),
        timeout: 15000,
      },
      (response) => {
        res.writeHead(
          response.statusCode ?? 502,
          id
            ? responseHeaders(response.headers, id, entry)
            : {
                "content-type": "application/json",
                "cache-control": "no-store",
              },
        );
        response.on("error", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy());
    upstream.on("error", () => {
      if (!res.headersSent)
        sendJson(res, 502, { error: "Local preview is unavailable" });
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
      if (!res.headersSent) sendJson(res, 413, { error: "Payload too large" });
      else res.destroy();
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(limiter).pipe(upstream);
  }
  return {
    hostId,
    async handle(req, res) {
      if (req.url?.startsWith("/internal/preview-tls-ask?")) {
        // Caddy's local certificate ask has no proxy/client-IP header. Public routes must set it.
        if (
          !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
            req.socket.remoteAddress,
          ) ||
          req.headers["x-herdr-client-ip"] ||
          req.method !== "GET"
        ) {
          sendJson(res, 403, { error: "Forbidden" });
          return true;
        }
        const id = hostId(
          new URL(req.url, "http://localhost").searchParams.get("domain"),
        );
        try {
          const entry = id && (await broker(`/previews/${id}`));
          sendJson(res, entry ? 200 : 403, { ok: Boolean(entry) });
        } catch {
          sendJson(res, 503, { error: "Preview unavailable" });
        }
        return true;
      }
      const id = hostId(req.headers.host);
      if (!id) return false;
      const origin = `https://p-${id}.${preview.domain}`;
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("cache-control", "no-store");
      if (
        req.headers.origin &&
        ![origin, config.frontendOrigin].includes(req.headers.origin)
      ) {
        sendJson(res, 403, { error: "Invalid origin" });
        return true;
      }
      if (
        typeof req.url !== "string" ||
        !req.url.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.length > 8192
      ) {
        sendJson(res, 400, { error: "Invalid path" });
        return true;
      }
      const fetchSite = req.headers["sec-fetch-site"];
      const destination = req.headers["sec-fetch-dest"];
      // Same-site app origins still differ: forbid credentialed cross-app subresources.
      if (
        fetchSite &&
        !["same-origin", "none"].includes(fetchSite) &&
        !["iframe", "document"].includes(destination)
      ) {
        sendJson(res, 403, {
          error: "Cross-origin preview resources are forbidden",
        });
        return true;
      }
      const launch = new URL(req.url, origin);
      let ticket = null;
      if (launch.pathname === "/__herdr_launch" && req.method === "GET") {
        ticket = decode(
          config.sessionSecret,
          "preview-launch",
          launch.searchParams.get("ticket"),
        );
        const record = ticket && issued.get(ticket.nonce);
        if (
          !record ||
          ticket.id !== id ||
          record.id !== id ||
          record.until < Date.now() ||
          ticket.userId !== config.allowedUserId ||
          ticket.expiresAt <= Date.now() / 1000
        ) {
          sendJson(res, 403, { error: "Reopen this preview from Herdr" });
          return true;
        }
        // Consume before awaiting IO: concurrent replays must not share a launch grant.
        issued.delete(ticket.nonce);
      } else if (!previewSession(req.headers.cookie, id)) {
        sendJson(res, 403, { error: "Open this private preview from Herdr" });
        return true;
      }
      try {
        const entry = await broker(`/previews/${id}`);
        if (!entry || entry.id !== id) {
          sendJson(res, 404, { error: "Preview is closed" });
          return true;
        }
        if (ticket) {
          const token = encode(config.sessionSecret, "preview-cookie", {
            id,
            userId: ticket.userId,
            expiresAt: ticket.expiresAt,
          });
          res.writeHead(303, {
            location: entry.path,
            "set-cookie": `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(ticket.expiresAt - Date.now() / 1000))}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          });
          res.end();
          return true;
        }
        proxy(req, res, `/proxy/${id}${req.url}`, id, entry);
      } catch {
        sendJson(res, 502, { error: "Home computer is unavailable" });
      }
      return true;
    },
    async api(req, res, session) {
      const path = req.url?.split("?")[0];
      if (path === "/api/previews" && req.method === "GET") {
        try {
          const snapshot = await broker("/previews");
          if (!snapshot) throw new Error();
          sendJson(res, 200, { ...snapshot, domain: preview.domain });
        } catch {
          sendJson(res, 502, { error: "Preview broker is unavailable" });
        }
        return true;
      }
      if (path === "/api/previews/close" && req.method === "POST") {
        proxy(req, res, "/close", null, null);
        return true;
      }
      const match = /^\/api\/previews\/([a-f0-9]{32})\/launch$/.exec(
        path ?? "",
      );
      if (!match || req.method !== "POST") return false;
      try {
        const entry = await broker(`/previews/${match[1]}`);
        if (!entry) {
          sendJson(res, 404, { error: "Preview is closed" });
          return true;
        }
        for (const [nonce, value] of issued)
          if (value.until < Date.now()) issued.delete(nonce);
        if (issued.size >= 256) {
          sendJson(res, 429, { error: "Too many pending preview launches" });
          return true;
        }
        const nonce = randomBytes(16).toString("hex"),
          id = match[1];
        issued.set(nonce, { id, until: Date.now() + 30000 });
        const token = encode(config.sessionSecret, "preview-launch", {
          id,
          nonce,
          userId: session.userId,
          expiresAt: session.expiresAt,
        });
        sendJson(res, 200, {
          url: `https://p-${id}.${preview.domain}/__herdr_launch?ticket=${token}`,
          expiresAt: session.expiresAt,
        });
      } catch {
        sendJson(res, 502, { error: "Preview broker is unavailable" });
      }
      return true;
    },
    async upgrade(req, socket, head) {
      const id = hostId(req.headers.host);
      if (!id) return false;
      const origin = `https://p-${id}.${preview.domain}`,
        session = previewSession(req.headers.cookie, id);
      if (
        !session ||
        req.headers.origin !== origin ||
        !req.url?.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.length > 8192
      ) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      let entry;
      try {
        entry = await broker(`/previews/${id}`);
      } catch {
        entry = null;
      }
      if (!entry || socket.destroyed) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      const protocols = req.headers["sec-websocket-protocol"]
        ?.split(",")
        .map((part) => part.trim())
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
      ) {
        socket.destroy();
        return true;
      }
      const upstream = new WebSocket(
        preview.upstream.replace("http:", "ws:") + `/proxy/${id}${req.url}`,
        protocols,
        {
          headers: requestHeaders(req, preview.secret),
          handshakeTimeout: 5000,
          maxPayload: 8 * 1024 * 1024,
          perMessageDeflate: false,
        },
      );
      const abandon = () => upstream.terminate();
      socket.once("close", abandon);
      socket.on("error", abandon);
      upstream.once("error", () => {
        if (!socket.destroyed)
          socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      upstream.once("open", () => {
        if (socket.destroyed) {
          upstream.terminate();
          return;
        }
        selectedProtocols.set(req, upstream.protocol);
        wss.handleUpgrade(req, socket, head, (client) => {
          socket.removeListener("close", abandon);
          peers.add(client);
          peers.add(upstream);
          const timer = setTimeout(
            () => {
              client.close(4401, "Preview session expired");
              upstream.terminate();
            },
            Math.max(1, session.expiresAt * 1000 - Date.now()),
          );
          timer.unref();
          for (const [source, target] of [
            [client, upstream],
            [upstream, client],
          ]) {
            source.on("message", (data, binary) => {
              if (target.readyState !== WebSocket.OPEN) return;
              if (target.bufferedAmount + data.length > 8 * 1024 * 1024) {
                client.terminate();
                upstream.terminate();
                return;
              }
              target.send(data, { binary }, (error) => {
                if (error) {
                  client.terminate();
                  upstream.terminate();
                }
              });
            });
            source.on("error", () => target.terminate());
            source.on("close", () => {
              clearTimeout(timer);
              peers.delete(source);
              target.close();
            });
          }
        });
      });
      return true;
    },
    close() {
      for (const peer of peers) peer.terminate();
      issued.clear();
      wss.close();
    },
  };
}
