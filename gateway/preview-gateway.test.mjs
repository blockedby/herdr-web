import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { config as authConfig, env } from "./fixtures.mjs";
import { createSession } from "./auth.mjs";
import { createGateway } from "./server.mjs";
import { readPreviewConfig } from "./preview-gateway.mjs";
import { createPreviewRegistry } from "./preview-registry.mjs";
import { createPreviewBroker } from "./preview-broker.mjs";

const secret = "synthetic-preview-tunnel-secret-not-production-1234";
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
async function request(
  base,
  path,
  { method = "GET", headers = {}, body } = {},
) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      const parts = [];
      res.on("data", (chunk) => parts.push(chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(parts).toString(),
          json() {
            return JSON.parse(this.text);
          },
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function fixture() {
  let seen;
  const app = http.createServer((req, res) => {
    seen = req.headers;
    if (req.url === "/redirect") {
      res.writeHead(302, {
        location: `http://localhost:${app.address().port}/deep?tab=1`,
      });
      res.end();
      return;
    }
    res.setHeader("set-cookie", [
      "app=value; Domain=.example.test; Path=/",
      "__Host-herdr_preview=forged; Path=/; Secure",
    ]);
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'self'",
    );
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("clear-site-data", '"cookies"');
    res.end(req.url);
  });
  const appUrl = await listen(app),
    registry = await createPreviewRegistry();
  const entry = await registry.open({
    url: appUrl + "/initial",
    workspaceId: "w1",
    name: "Fixture",
  });
  const broker = createPreviewBroker(registry, { secret }),
    dataUrl = await listen(broker.data);
  const config = {
    ...authConfig,
    preview: readPreviewConfig(
      {
        ...env,
        HERDR_PREVIEW_DOMAIN: "preview.example.test",
        HERDR_PREVIEW_SECRET: secret,
        HERDR_PREVIEW_UPSTREAM: dataUrl,
      },
      authConfig,
    ),
  };
  const gateway = createGateway(config),
    base = await listen(gateway);
  const owner = {
    host: "gateway.example.test",
    origin: "https://app.example.test",
    cookie: createSession("42", config).cookie.split(";")[0],
  };
  const host = `p-${entry.id}.preview.example.test`;
  async function launch() {
    const response = await request(base, `/api/previews/${entry.id}/launch`, {
      method: "POST",
      headers: owner,
    });
    assert.equal(response.status, 200);
    const url = new URL(response.json().url);
    const boot = await request(base, url.pathname + url.search, {
      headers: { host },
    });
    assert.equal(boot.status, 303);
    return { url, cookie: boot.headers["set-cookie"][0].split(";")[0], boot };
  }
  return {
    base,
    appUrl,
    app,
    registry,
    broker,
    gateway,
    entry,
    owner,
    host,
    launch,
    seen: () => seen,
    async cleanup() {
      await close(gateway);
      await close(broker.data);
      await close(app);
    },
  };
}

test("preview configuration is optional, fixed-loopback and separate same-site", () => {
  assert.equal(readPreviewConfig({}, authConfig), null);
  for (const domain of [
    "evil.test",
    "app.example.test",
    "gateway.example.test",
    "preview.example.test:443",
    "preview.example.test/evil",
  ])
    assert.throws(() =>
      readPreviewConfig(
        { HERDR_PREVIEW_DOMAIN: domain, HERDR_PREVIEW_SECRET: secret },
        authConfig,
      ),
    );
  for (const upstream of [
    "http://localhost:8790",
    "https://127.0.0.1:8790",
    "http://127.0.0.1:8790/path",
    "http://user@127.0.0.1:8790",
  ])
    assert.throws(() =>
      readPreviewConfig(
        {
          HERDR_PREVIEW_DOMAIN: "preview.example.test",
          HERDR_PREVIEW_SECRET: secret,
          HERDR_PREVIEW_UPSTREAM: upstream,
        },
        authConfig,
      ),
    );
});

test("only owner can discover/launch; scoped ticket is single-use and never grants terminal access", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await request(f.base, "/api/previews", {
          headers: { host: f.owner.host, origin: f.owner.origin },
        })
      ).status,
      401,
    );
    const snapshot = await request(f.base, "/api/previews", {
      headers: f.owner,
    });
    assert.equal(snapshot.json().previews[0].id, f.entry.id);
    assert.equal(snapshot.json().domain, "preview.example.test");
    assert.equal(
      (
        await request(f.base, `/api/previews/${f.entry.id}/launch`, {
          method: "POST",
          headers: { ...f.owner, origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.base, "/initial", {
          headers: { host: f.host, cookie: f.owner.cookie },
        })
      ).status,
      403,
    );
    const { url, cookie, boot } = await f.launch();
    assert.equal(boot.headers.location, "/initial");
    assert.ok(boot.headers["set-cookie"][0].includes("HttpOnly"));
    assert.ok(boot.headers["set-cookie"][0].includes("SameSite=Strict"));
    assert.ok(!boot.headers["set-cookie"][0].includes("Domain="));
    assert.equal(
      (
        await request(f.base, url.pathname + url.search, {
          headers: { host: f.host },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.base, "/api/previews", {
          headers: { ...f.owner, cookie },
        })
      ).status,
      401,
    );
    const another = await f.registry.open({ url: f.appUrl, workspaceId: "w2" });
    assert.equal(
      (
        await request(f.base, "/initial", {
          headers: { host: `p-${another.id}.preview.example.test`, cookie },
        })
      ).status,
      403,
    );
  } finally {
    await f.cleanup();
  }
});

test("root assets/deep links proxy with cookie/header isolation, frame policy and loopback redirects", async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.launch();
    const response = await request(f.base, "/assets/app.js?hmr=1", {
      headers: {
        host: f.host,
        cookie: `${cookie}; app=session`,
        origin: `https://${f.host}`,
        authorization: "Bearer synthetic-application-token",
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.text, "/assets/app.js?hmr=1");
    assert.equal(f.seen().authorization, "Bearer synthetic-application-token");
    assert.equal(f.seen()["x-herdr-preview-authorization"], undefined);
    assert.equal(f.seen().cookie, "app=session");
    assert.equal(f.seen().origin, f.appUrl);
    assert.deepEqual(response.headers["set-cookie"], ["app=value; Path=/"]);
    assert.equal(response.headers["x-frame-options"], undefined);
    assert.equal(response.headers["clear-site-data"], undefined);
    assert.equal(
      response.headers["content-security-policy"],
      "default-src 'self'; frame-ancestors https://app.example.test",
    );
    assert.equal(
      (
        await request(f.base, "/assets/app.js", {
          headers: {
            host: f.host,
            cookie,
            "sec-fetch-site": "same-site",
            "sec-fetch-dest": "script",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.base, "/assets/app.js", {
          headers: {
            host: f.host,
            cookie,
            "sec-fetch-site": "same-origin",
            "sec-fetch-dest": "script",
          },
        })
      ).status,
      200,
    );
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(
      (
        await request(f.base, "/redirect", {
          headers: { host: f.host, cookie },
        })
      ).headers.location,
      `https://${f.host}/deep?tab=1`,
    );
    assert.equal(
      (
        await request(f.base, "/initial", {
          headers: { host: f.host, cookie, origin: "null" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.base, "/initial", {
          headers: { host: f.host, cookie, origin: "https://evil.test" },
        })
      ).status,
      403,
    );
  } finally {
    await f.cleanup();
  }
});

test("certificate ask is local-only and approves only an active cryptographic preview hostname", async () => {
  const f = await fixture();
  try {
    const path = `/internal/preview-tls-ask?domain=${f.host}`;
    assert.equal(
      (await request(f.base, path, { headers: { host: "localhost" } })).status,
      200,
    );
    assert.equal(
      (
        await request(f.base, path, {
          headers: { host: "localhost", "x-herdr-client-ip": "127.0.0.1" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request(f.base, "/internal/preview-tls-ask?domain=evil.test", {
          headers: { host: "localhost" },
        })
      ).status,
      403,
    );
    await f.registry.close(f.entry.id);
    assert.equal(
      (await request(f.base, path, { headers: { host: "localhost" } })).status,
      403,
    );
  } finally {
    await f.cleanup();
  }
});

test("owner UI close revokes HTTP/HMR without stopping localhost app; protocol selection remains exact", async () => {
  const f = await fixture();
  const appWss = new WebSocketServer({
    server: f.app,
    handleProtocols: (protocols) =>
      protocols.has("second") ? "second" : false,
  });
  appWss.on("connection", (ws) =>
    ws.on("message", (data, binary) => ws.send(data, { binary })),
  );
  let ws;
  try {
    const { cookie } = await f.launch();
    ws = new WebSocket(
      f.base.replace("http:", "ws:") + "/hmr?x=1",
      ["first", "second"],
      {
        headers: { host: f.host, origin: `https://${f.host}`, cookie },
        handshakeTimeout: 3000,
      },
    );
    ws.on("error", () => {});
    await once(ws, "open");
    assert.equal(ws.protocol, "second");
    const received = once(ws, "message");
    ws.send(Buffer.from([4, 5, 6]));
    const [data, binary] = await received;
    assert.deepEqual(data, Buffer.from([4, 5, 6]));
    assert.equal(binary, true);
    const closed = once(ws, "close");
    const response = await request(f.base, "/api/previews/close", {
      method: "POST",
      headers: { ...f.owner, "content-type": "application/json" },
      body: JSON.stringify({ id: f.entry.id }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json().closed, true);
    await closed;
    assert.equal(
      (await request(f.base, "/initial", { headers: { host: f.host, cookie } }))
        .status,
      404,
    );
    assert.equal((await fetch(f.appUrl)).status, 200);
  } finally {
    ws?.terminate();
    for (const client of appWss.clients) client.terminate();
    appWss.close();
    await f.cleanup();
  }
});

test("anonymous preview traffic never reaches home broker; concurrent ticket replay admits one request", async () => {
  const f = await fixture();
  let calls = 0;
  f.broker.data.on("request", () => calls++);
  try {
    for (const path of [
      "/",
      "/assets/app.js",
      "/__herdr_launch?ticket=invalid",
    ])
      assert.equal(
        (await request(f.base, path, { headers: { host: f.host } })).status,
        403,
      );
    assert.equal(calls, 0);
    const response = await request(
      f.base,
      `/api/previews/${f.entry.id}/launch`,
      { method: "POST", headers: f.owner },
    );
    const url = new URL(response.json().url);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        request(f.base, url.pathname + url.search, {
          headers: { host: f.host },
        }),
      ),
    );
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      [303, 403, 403],
    );
  } finally {
    await f.cleanup();
  }
});
