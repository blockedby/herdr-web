import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createT3Preview, validateT3Target } from "./t3-preview.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler, options = {}) {
  const upstream = http.createServer(handler);
  const upstreamUrl = await listen(upstream);
  const companion = createT3Preview({
    resolveTarget: () => upstreamUrl,
    ...options,
  });
  const url = await listen(companion);
  t.after(async () => {
    for (const server of [companion, upstream]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  return { upstream, upstreamUrl, companion, url };
}

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

test("T3 discovery accepts only loopback HTTP roots and rejects a proxy loop", () => {
  for (const host of ["127.0.0.1", "localhost", "[::1]"])
    assert.equal(validateT3Target(`http://${host}:3773`, 8791).port, "3773");
  for (const url of [
    "https://127.0.0.1:3773",
    "http://remote.example:3773",
    "http://192.168.0.1:3773",
    "http://localhost.evil.example:3773",
    "http://user:pass@127.0.0.1:3773",
    "http://127.0.0.1:3773/path",
    "http://127.0.0.1:3773/?query=1",
    "http://127.0.0.1:3773/#fragment",
    "http://127.0.0.1:8791",
  ])
    assert.throws(() => validateT3Target(url, 8791));
});

test("bootstrap consumes a transient pairing credential and returns only the browser cookie", async (t) => {
  let issued = 0;
  const requests = [];
  const { url } = await fixture(
    t,
    async (req, res) => {
      requests.push(req.url);
      if (req.url === "/api/auth/session")
        return json(res, { authenticated: false });
      assert.equal(req.url, "/api/auth/browser-session");
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), {
        credential: "synthetic-one-time-credential",
      });
      res.setHeader(
        "set-cookie",
        "t3_session=synthetic-cookie; Path=/; HttpOnly; SameSite=Lax",
      );
      json(res, { authenticated: true });
    },
    {
      issuePairing: async () => {
        issued++;
        return "synthetic-one-time-credential";
      },
    },
  );
  const response = await fetch(url + "/__herdr_t3", {
    redirect: "manual",
    headers: { "sec-fetch-site": "same-site", "sec-fetch-dest": "iframe" },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/");
  assert.match(
    response.headers.get("set-cookie"),
    /t3_session=synthetic-cookie.*HttpOnly/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "");
  assert.equal(issued, 1);
  assert.deepEqual(requests, [
    "/api/auth/session",
    "/api/auth/browser-session",
  ]);
});

test("a valid cookie is reused and availability probes never pair", async (t) => {
  const { url } = await fixture(
    t,
    (req, res) => {
      if (req.url === "/api/auth/session") {
        assert.equal(req.headers.cookie, "t3_session=existing");
        return json(res, { authenticated: true });
      }
      res.end("T3 app");
    },
    {
      issuePairing: async () => {
        throw new Error("Must not pair");
      },
    },
  );
  const response = await fetch(url + "/__herdr_t3", {
    redirect: "manual",
    headers: { cookie: "t3_session=existing" },
  });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await fetch(url, { method: "HEAD" })).status, 200);
});

test("untrusted browser requests cannot trigger automatic pairing", async (t) => {
  let calls = 0;
  const { url } = await fixture(t, (_req, res) => {
    calls++;
    res.end();
  });
  for (const headers of [
    { host: "evil.example" },
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" },
    { "sec-fetch-site": "same-site", "sec-fetch-dest": "empty" },
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = http.get(url + "/__herdr_t3", { headers }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
    });
    assert.equal(status, 403);
  }
  assert.equal(calls, 0);
});

test("bootstrap fails closed on redirects and credential errors without exposing secrets", async (t) => {
  let issued = 0;
  const { url } = await fixture(
    t,
    (_req, res) => {
      res.writeHead(307, { location: "http://remote.example/collect" });
      res.end();
    },
    {
      issuePairing: async () => {
        issued++;
        throw new Error("synthetic-secret");
      },
    },
  );
  const redirect = await fetch(url + "/__herdr_t3");
  assert.equal(redirect.status, 503);
  assert.equal(issued, 0);
  const broken = await fixture(
    t,
    (_req, res) => json(res, { authenticated: false }),
    {
      issuePairing: async () => {
        throw new Error("synthetic-secret");
      },
    },
  );
  const failure = await fetch(broken.url + "/__herdr_t3");
  assert.equal(failure.status, 503);
  assert.doesNotMatch(await failure.text(), /synthetic-secret/);
});

test("HTTP forwarding preserves bodies and cookies, normalizes origin and strips proxy identity", async (t) => {
  let upstreamUrl;
  const fixtureResult = await fixture(t, async (req, res) => {
    assert.equal(req.headers.host, new URL(upstreamUrl).host);
    assert.equal(req.headers.origin, upstreamUrl);
    assert.equal(req.headers.cookie, "t3_session=existing");
    assert.equal(req.headers.authorization, "Bearer synthetic-app-token");
    assert.equal(req.headers["x-forwarded-host"], undefined);
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.equal(body, "message body");
    res.writeHead(302, {
      location: upstreamUrl + "/destination?x=1",
      "set-cookie": "app=value; HttpOnly",
    });
    res.end();
  });
  upstreamUrl = fixtureResult.upstreamUrl;
  const response = await fetch(fixtureResult.url + "/api/example", {
    method: "POST",
    body: "message body",
    redirect: "manual",
    headers: {
      origin: fixtureResult.url,
      cookie: "t3_session=existing",
      authorization: "Bearer synthetic-app-token",
      "x-forwarded-host": "evil.example",
    },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/destination?x=1");
  assert.equal(response.headers.get("set-cookie"), "app=value; HttpOnly");
});

test("target discovery is refreshed per request and missing T3 recovers", async (t) => {
  let target;
  const result = await fixture(t, (_req, res) => res.end("recovered"), {
    resolveTarget: () => {
      if (!target) throw new Error("Not running");
      return target;
    },
  });
  assert.equal((await fetch(result.url)).status, 503);
  target = result.upstreamUrl;
  assert.equal(await (await fetch(result.url)).text(), "recovered");
  target = "http://remote.example";
  assert.equal((await fetch(result.url)).status, 503);
});

test("WebSocket forwarding retains app authentication, subprotocols, and binary traffic", async (t) => {
  const { upstream, url, upstreamUrl } = await fixture(t, (_req, res) =>
    res.end(),
  );
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => wss.close());
  upstream.on("upgrade", (req, socket, head) => {
    assert.equal(req.headers.origin, upstreamUrl);
    assert.equal(req.headers.cookie, "t3_session=existing");
    wss.handleUpgrade(req, socket, head, (peer) => {
      peer.on("message", (data, binary) => peer.send(data, { binary }));
    });
  });
  const client = new WebSocket(
    url.replace("http:", "ws:") + "/ws?ticket=synthetic",
    "t3-test",
    {
      origin: url,
      headers: { cookie: "t3_session=existing" },
    },
  );
  t.after(() => client.terminate());
  await once(client, "open");
  assert.equal(client.protocol, "t3-test");
  client.send(Buffer.from([0, 255, 42]));
  const [data, binary] = await once(client, "message");
  assert.equal(binary, true);
  assert.deepEqual(data, Buffer.from([0, 255, 42]));
  client.close();
  await once(client, "close");
});
