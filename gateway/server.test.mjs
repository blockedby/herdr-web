import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createGateway } from "./server.mjs";
import { config, signedData } from "./fixtures.mjs";
import { createSession } from "./auth.mjs";

async function setup(t) {
  let hits = 0;
  const mock = http.createServer((req, res) => {
    hits++;
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.origin, bridgeConfig.bridgeOrigin);
    assert.equal(req.headers.host, new URL(bridgeConfig.bridgeOrigin).host);
    res.setHeader("set-cookie", "upstream-cookie=must-not-leak");
    const parts = [];
    req.on("data", (chunk) => parts.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          bytes: Buffer.concat(parts).length,
        }),
      );
    });
  });
  const echo = new WebSocketServer({ server: mock });
  echo.on("connection", (socket) =>
    socket.on("message", (data, binary) => socket.send(data, { binary })),
  );
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const bridgeConfig = { ...config, upstream, bridgeOrigin: upstream };
  const gateway = createGateway(bridgeConfig);
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const port = gateway.address().port;
  const headers = {
    host: new URL(config.publicOrigin).host,
    origin: config.frontendOrigin,
  };
  const request = (path, { method = "GET", extra = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: { ...headers, ...extra },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  t.after(() => {
    gateway.close();
    gateway.closeAllConnections();
    for (const socket of echo.clients) socket.terminate();
    echo.close();
    mock.close();
    mock.closeAllConnections();
  });
  return {
    request,
    wsUrl: `ws://127.0.0.1:${port}/ws/terminal?terminal_id=test`,
    headers,
    mock,
    hits: () => hits,
  };
}

async function login(request, data = signedData()) {
  const result = await request("/auth/login", {
    method: "POST",
    extra: { "content-type": "application/json" },
    body: JSON.stringify({ initData: data }),
  });
  assert.equal(result.status, 200);
  assert.equal(
    result.headers["access-control-allow-origin"],
    config.frontendOrigin,
  );
  return result.headers["set-cookie"][0].split(";")[0];
}

test("anonymous API denied; authorized HTTP and uploads forwarded without credentials", async (t) => {
  const { request, hits } = await setup(t);
  assert.equal((await request("/api/snapshot")).status, 401);
  assert.equal(hits(), 0);
  const cookie = await login(request);
  const result = await request("/api/uploads?name=image.png", {
    method: "POST",
    extra: {
      cookie,
      authorization: "must-not-forward",
      "content-type": "image/png",
    },
    body: Buffer.from([1, 2, 3]),
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse(result.body).bytes, 3);
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(hits(), 1);
});

test("wrong identity/origin/host/malformed paths denied before upstream", async (t) => {
  const { request, hits } = await setup(t);
  const denied = await request("/auth/login", {
    method: "POST",
    extra: { "content-type": "application/json" },
    body: JSON.stringify({ initData: signedData({ id: 43 }) }),
  });
  assert.equal(denied.status, 401);
  const cookie = await login(request);
  for (const origin of ["https://evil.example.test", "null", ""])
    assert.equal(
      (
        await request("/api/command", {
          method: "POST",
          extra: { cookie, origin },
        })
      ).status,
      403,
    );
  assert.equal(
    (
      await request("/api/snapshot", {
        extra: { cookie, host: "evil.example.test" },
      })
    ).status,
    403,
  );
  for (const path of [
    "/api/../healthz",
    "/api/%2e%2e/private",
    "//api/snapshot",
    "/api/a//b",
  ])
    assert.equal((await request(path, { extra: { cookie } })).status, 404);
  assert.equal(hits(), 0);
});

test("authenticated WebSocket preserves text and binary; anonymous/wrong origin rejected", async (t) => {
  const { request, wsUrl, headers } = await setup(t);
  const cookie = await login(request);
  for (const extra of [{}, { cookie, origin: "https://evil.example.test" }]) {
    const ws = new WebSocket(wsUrl, { headers: { ...headers, ...extra } });
    const denied = new Promise((resolve) =>
      ws.on("unexpected-response", (_req, res) => {
        const status = res.statusCode;
        res.destroy();
        ws.terminate();
        resolve(status);
      }),
    );
    ws.on("error", () => {});
    assert.equal(await denied, 403);
  }
  const ws = new WebSocket(wsUrl, { headers: { ...headers, cookie } });
  ws.on("error", () => {});
  await once(ws, "open");
  let response = once(ws, "message");
  ws.send("hello");
  let [data, binary] = await response;
  assert.equal(data.toString(), "hello");
  assert.equal(binary, false);
  response = once(ws, "message");
  ws.send(Buffer.from([0, 1, 255]));
  [data, binary] = await response;
  assert.deepEqual(data, Buffer.from([0, 1, 255]));
  assert.equal(binary, true);
  ws.close();
  await once(ws, "close");
});

test("WebSocket closes when authenticated session expires", async (t) => {
  const { wsUrl, headers } = await setup(t);
  const cookie = createSession(
    config.allowedUserId,
    config,
    Math.floor(Date.now() / 1000) - 3598,
  ).cookie.split(";")[0];
  const ws = new WebSocket(wsUrl, { headers: { ...headers, cookie } });
  ws.on("error", () => {});
  await once(ws, "open");
  const [code] = await once(ws, "close");
  assert.equal(code, 4401);
});

test("login rate limiting does not block a different client address", async (t) => {
  const { request } = await setup(t);
  const extra = {
    "content-type": "application/json",
    "x-herdr-client-ip": "192.0.2.1",
  };
  for (let i = 0; i < 30; i++) {
    assert.equal(
      (
        await request("/auth/login", {
          method: "POST",
          extra,
          body: JSON.stringify({ initData: "invalid" }),
        })
      ).status,
      401,
    );
  }
  assert.equal(
    (
      await request("/auth/login", {
        method: "POST",
        extra,
        body: JSON.stringify({ initData: signedData() }),
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await request("/auth/login", {
        method: "POST",
        extra: { ...extra, "x-herdr-client-ip": "192.0.2.2" },
        body: JSON.stringify({ initData: signedData() }),
      })
    ).status,
    200,
  );
});

test("missing home tunnel returns sanitized 502", async (t) => {
  const { request, mock } = await setup(t);
  const cookie = await login(request);
  await new Promise((resolve) => mock.close(resolve));
  const result = await request("/api/snapshot", { extra: { cookie } });
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body), {
    error: "Home computer is unavailable",
  });
});
