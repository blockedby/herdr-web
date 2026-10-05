import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createPreviewRegistry, parseLocalApp } from "./preview-registry.mjs";
import { createPreviewBroker } from "./preview-broker.mjs";
import {
  parseArguments,
  requestPreview,
} from "../skills/herdr-preview/scripts/herdr-preview.mjs";

const secret = "synthetic-preview-tunnel-secret-not-for-production-123";
async function listen(server, endpoint = 0) {
  server.listen(endpoint, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

test("localhost target validation rejects remote targets, credentials and reserved services", () => {
  assert.deepEqual(parseLocalApp("http://localhost:5173/settings?tab=a"), {
    hostname: "localhost",
    port: 5173,
    path: "/settings?tab=a",
  });
  assert.equal(parseLocalApp("http://[::1]:3000").hostname, "::1");
  for (const raw of [
    "https://localhost:5173",
    "http://evil.example:5173",
    "http://localhost.evil.example:5173",
    "http://192.168.1.1:3000",
    "http://user:password@localhost:5173",
    "http://localhost:4000",
    "http://localhost:9222",
    "http://localhost",
    "http://localhost:5173//evil.example",
    "http://localhost:9229",
    "file:///etc/passwd",
  ])
    assert.throws(() => parseLocalApp(raw));
});

test("registry deduplicates per workspace, persists atomic state and closes idempotently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-preview-registry-"));
  try {
    const file = join(dir, "registry.json");
    const registry = await createPreviewRegistry({
      file,
      maxEntries: 2,
      checkAvailability: async () => false,
    });
    const first = await registry.open({
      url: "http://localhost:5173",
      workspaceId: "w1",
      name: "Notes",
    });
    const revision = (await registry.list()).revision;
    const again = await registry.open({
      url: "http://localhost:5173/settings",
      workspaceId: "w1",
      name: "Renamed",
    });
    assert.equal(first.id, again.id);
    assert.equal(registry.get(first.id).path, "/settings");
    assert.ok((await registry.list()).lastOpen.revision > revision);
    const other = await registry.open({
      url: "http://localhost:5173",
      workspaceId: "w2",
    });
    assert.notEqual(other.id, first.id);
    await assert.rejects(
      registry.open({ url: "http://localhost:3000", workspaceId: "w1" }),
    );
    const restored = await createPreviewRegistry({ file });
    assert.equal(restored.get(first.id).name, "Renamed");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    JSON.parse(await readFile(file, "utf8"));
    const removed = [];
    registry.onClose((id) => removed.push(id));
    assert.equal((await registry.close(first.id)).closed, true);
    assert.equal((await registry.close(first.id)).closed, false);
    assert.deepEqual(removed, [first.id]);
    assert.equal(registry.get(other.id).workspaceId, "w2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill CLI requires Herdr context and never accepts a remote control endpoint", () => {
  assert.throws(() => parseArguments(["open", "http://localhost:5173"], {}));
  const options = parseArguments(
    ["open", "http://localhost:5173", "--name", "Notes"],
    {
      HERDR_WORKSPACE_ID: "w1",
      HERDR_PANE_ID: "w1:p2",
      XDG_RUNTIME_DIR: "/tmp/test-runtime",
    },
  );
  assert.equal(options.body.workspaceId, "w1");
  assert.equal(options.body.paneId, "w1:p2");
  assert.equal(
    options.socketPath,
    "/tmp/test-runtime/herdr-preview/control.sock",
  );
  for (const args of [
    ["open", "https://remote.example:5173", "--workspace", "w1"],
    ["list", "--socket", "https://remote.example"],
    ["close", "../../etc/passwd"],
    ["list", "--name", "x"],
    ["open", "http://localhost:5173", "--workspace", "w1", "--name"],
  ])
    assert.throws(() => parseArguments(args, {}));
});

test("broker exposes no unauthenticated data and skill commands register/close without stopping app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "herdr-preview-broker-"));
  const app = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      JSON.stringify({
        path: req.url,
        host: req.headers.host,
        authorization: req.headers.authorization ?? null,
      }),
    );
  });
  const appUrl = await listen(app),
    registry = await createPreviewRegistry();
  const broker = createPreviewBroker(registry, { secret }),
    dataUrl = await listen(broker.data);
  const socket = join(dir, "control.sock");
  broker.local.listen(socket);
  await once(broker.local, "listening");
  try {
    assert.equal((await fetch(dataUrl + "/previews")).status, 403);
    const entry = await requestPreview(
      parseArguments(
        ["open", appUrl + "/initial", "--name", "Test", "--socket", socket],
        { HERDR_WORKSPACE_ID: "w1" },
      ),
    );
    const listed = await requestPreview(
      parseArguments(["list", "--socket", socket], {}),
    );
    assert.equal(listed.previews[0].available, true);
    assert.equal(listed.lastOpen.id, entry.id);
    const linkedHelper = join(dir, "installed-helper.mjs");
    await symlink(
      fileURLToPath(
        new URL(
          "../skills/herdr-preview/scripts/herdr-preview.mjs",
          import.meta.url,
        ),
      ),
      linkedHelper,
    );
    const executed = await promisify(execFile)(
      process.execPath,
      [linkedHelper, "list", "--socket", socket],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(JSON.parse(executed.stdout).previews[0].id, entry.id);
    const headers = { authorization: `Bearer ${secret}` };
    assert.equal(
      (await fetch(dataUrl + "/open", { method: "POST", headers, body: "{}" }))
        .status,
      404,
    );
    const proxied = await fetch(dataUrl + `/proxy/${entry.id}/deep/route?x=1`, {
      headers,
    });
    assert.equal(proxied.status, 200);
    assert.deepEqual(await proxied.json(), {
      path: "/deep/route?x=1",
      host: new URL(appUrl).host,
      authorization: null,
    });
    await requestPreview(
      parseArguments(["close", entry.id, "--socket", socket], {}),
    );
    assert.equal(
      (await fetch(dataUrl + `/proxy/${entry.id}/`, { headers })).status,
      404,
    );
    assert.equal((await fetch(appUrl)).status, 200);
  } finally {
    await close(broker.local);
    await close(broker.data);
    await close(app);
    await rm(dir, { recursive: true, force: true });
  }
});

test("preview WebSockets support HMR protocols/binary and terminate when preview is closed", async () => {
  const app = http.createServer(),
    appUrl = await listen(app);
  const upstreamWss = new WebSocketServer({ server: app });
  upstreamWss.on("connection", (ws) =>
    ws.on("message", (message, binary) => ws.send(message, { binary })),
  );
  const registry = await createPreviewRegistry(),
    entry = await registry.open({ url: appUrl, workspaceId: "w1" });
  const broker = createPreviewBroker(registry, { secret }),
    base = (await listen(broker.data)).replace("http:", "ws:");
  const ws = new WebSocket(base + `/proxy/${entry.id}/?token=dev`, "vite-hmr", {
    headers: { authorization: `Bearer ${secret}` },
    handshakeTimeout: 3000,
  });
  ws.on("error", () => {});
  try {
    await once(ws, "open");
    assert.equal(ws.protocol, "vite-hmr");
    const message = once(ws, "message");
    ws.send(Buffer.from([1, 2, 3]));
    const [data, binary] = await message;
    assert.equal(binary, true);
    assert.deepEqual(data, Buffer.from([1, 2, 3]));
    const ended = once(ws, "close");
    await registry.close(entry.id);
    await ended;
  } finally {
    ws.terminate();
    for (const client of upstreamWss.clients) client.terminate();
    upstreamWss.close();
    await close(broker.data);
    await close(app);
  }
});

for (const host of ["127.0.0.1", "::1"])
  test(`localhost publication supports pinned ${host} without probing the registered query`, async (context) => {
    const seen = [];
    const app = http.createServer((req, res) => {
      seen.push([req.method, req.url]);
      res.statusCode = req.method === "HEAD" ? 500 : 200;
      res.end("ok");
    });
    try {
      app.listen(0, host);
      await once(app, "listening");
    } catch (error) {
      if (
        host === "::1" &&
        ["EADDRNOTAVAIL", "EAFNOSUPPORT"].includes(error.code)
      ) {
        context.skip("IPv6 loopback unavailable");
        return;
      }
      throw error;
    }
    const registry = await createPreviewRegistry(),
      broker = createPreviewBroker(registry, { secret }),
      base = await listen(broker.data);
    try {
      const entry = await registry.open({
        url: `http://localhost:${app.address().port}/action?mutate=1`,
        workspaceId: "w1",
      });
      assert.equal((await registry.list()).previews[0].available, true);
      assert.deepEqual(seen, [["HEAD", "/"]]);
      assert.equal(
        (
          await fetch(base + `/proxy/${entry.id}/assets`, {
            headers: { authorization: `Bearer ${secret}` },
          })
        ).status,
        200,
      );
      assert.deepEqual(seen[1], ["GET", "/assets"]);
    } finally {
      await close(broker.data);
      await close(app);
    }
  });
