// Local deployment companion: Telegram authorization stays in Herdr's preview gateway.
import http from "node:http";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export function validateT3Target(origin, ownPort) {
  const url = new URL(origin);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    Number(url.port || 80) === ownPort
  ) {
    throw new Error("Expected a loopback T3 server");
  }
  return url;
}

export function createT3Preview({
  home = process.env.T3CODE_HOME || join(homedir(), ".t3"),
  cli = process.env.T3CODE_CLI_PATH || join(home, "bin/t3"),
  resolveTarget = async () =>
    JSON.parse(
      await readFile(join(home, "userdata/server-runtime.json"), "utf8"),
    ).origin,
  issuePairing = async () => {
    const { stdout } = await run(
      cli,
      [
        "auth",
        "pairing",
        "create",
        "--base-dir",
        home,
        "--ttl",
        "1m",
        "--label",
        "Herdr Telegram",
        "--json",
      ],
      { timeout: 15000, maxBuffer: 65536 },
    );
    return JSON.parse(stdout).credential;
  },
} = {}) {
  const authority = () => `127.0.0.1:${server.address().port}`;
  const target = async () =>
    validateT3Target(await resolveTarget(), server.address().port);

  function allowed(req) {
    if (req.headers.host !== authority()) return false;
    if (req.headers.origin && req.headers.origin !== `http://${authority()}`)
      return false;
    const site = req.headers["sec-fetch-site"];
    return (
      site !== "cross-site" &&
      (site !== "same-site" ||
        ["iframe", "document"].includes(req.headers["sec-fetch-dest"]))
    );
  }

  function headers(req, url) {
    const result = { ...req.headers, host: url.host };
    if (result.origin) result.origin = url.origin;
    for (const name of [
      "forwarded",
      "x-forwarded-host",
      "x-forwarded-for",
      "x-forwarded-proto",
      "proxy-authorization",
    ])
      delete result[name];
    return result;
  }

  function unavailable(res) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(503, {
      "content-type": "text/plain",
      "cache-control": "no-store",
    });
    res.end(
      "T3 Code is unavailable. Open T3 Code Nightly on the PC, then refresh this preview.",
    );
  }

  let pairingCount = 0;
  async function bootstrap(req, res, url) {
    const state = await fetch(new URL("/api/auth/session", url), {
      headers: req.headers.cookie ? { cookie: req.headers.cookie } : {},
      signal: AbortSignal.timeout(5000),
      redirect: "manual",
    });
    if (!state.ok) throw new Error("T3 session probe failed");
    if (!(await state.json()).authenticated) {
      if (pairingCount >= 4) throw new Error("Pairing is busy");
      pairingCount++;
      try {
        // Credentials are short-lived, consumed immediately, and never logged or persisted here.
        const credential = await issuePairing();
        if (typeof credential !== "string" || !credential)
          throw new Error("Missing pairing credential");
        const session = await fetch(new URL("/api/auth/browser-session", url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential }),
          signal: AbortSignal.timeout(5000),
          redirect: "manual",
        });
        if (!session.ok || !(await session.json()).authenticated)
          throw new Error("Pairing failed");
        const cookies = session.headers.getSetCookie();
        if (!cookies.length) throw new Error("Missing session cookie");
        res.setHeader("set-cookie", cookies);
      } finally {
        pairingCount--;
      }
    }
    res.writeHead(303, {
      location: "/",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    res.end();
  }

  const server = http.createServer(async (req, res) => {
    if (!allowed(req)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    try {
      const url = await target();
      if (req.method === "GET" && req.url === "/__herdr_t3") {
        await bootstrap(req, res, url);
        return;
      }
      const upstream = http.request(
        {
          hostname: url.hostname.replace(/^\[|\]$/g, ""),
          port: url.port,
          path: req.url,
          method: req.method,
          headers: headers(req, url),
          timeout: 15000,
        },
        (response) => {
          const outgoing = { ...response.headers };
          if (outgoing.location?.startsWith(url.origin + "/"))
            outgoing.location = outgoing.location.slice(url.origin.length);
          res.writeHead(response.statusCode, outgoing);
          response.on("error", () => res.destroy());
          response.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => unavailable(res));
      req.on("error", () => upstream.destroy());
      res.on("close", () => {
        if (!res.writableFinished) upstream.destroy();
      });
      req.pipe(upstream);
    } catch {
      unavailable(res);
    }
  });

  server.on("upgrade", async (req, socket, head) => {
    if (!allowed(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const url = await target();
      const upstream = http.request({
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port,
        path: req.url,
        headers: headers(req, url),
        timeout: 10000,
      });
      upstream.on("upgrade", (response, peer, upstreamHead) => {
        upstream.setTimeout(0);
        socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`);
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          socket.write(
            `${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`,
          );
        socket.write("\r\n");
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) peer.write(head);
        peer.on("error", () => socket.destroy());
        socket.on("error", () => peer.destroy());
        socket.on("close", () => peer.destroy());
        peer.on("close", () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      });
      upstream.on("response", (response) => {
        socket.end(
          `HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
        );
        response.resume();
      });
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.end();
    } catch {
      socket.destroy();
    }
  });

  return server;
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
) {
  const port = Number(process.env.HERDR_T3_PREVIEW_PORT || 8791);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid HERDR_T3_PREVIEW_PORT");
  createT3Preview().listen(port, "127.0.0.1", () =>
    console.log(`Herdr T3 companion listening on http://127.0.0.1:${port}`),
  );
}
