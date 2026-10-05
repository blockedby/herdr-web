import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import http from "node:http";

export const PREVIEW_ID = /^[a-f0-9]{32}$/;
const IDENTIFIER = /^[a-zA-Z0-9_:.-]{1,128}$/;
export const DEFAULT_BLOCKED_PORTS = [
  4000, 8787, 8788, 8790, 9222, 9223, 9229, 9230,
];
// Never resolve localhost through mutable DNS/hosts; support IPv6-only and IPv4 dev servers.
export function loopbackLookup(_hostname, options, callback) {
  if (options.all)
    return callback(null, [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ]);
  return options.family === 4
    ? callback(null, "127.0.0.1", 4)
    : callback(null, "::1", 6);
}

export function parseLocalApp(raw, blockedPorts = DEFAULT_BLOCKED_PORTS) {
  if (typeof raw !== "string" || raw.length > 2048)
    throw new Error("Invalid localhost URL");
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname.startsWith("//")
  ) {
    throw new Error("Only HTTP localhost applications are supported");
  }
  const port = Number(url.port);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    blockedPorts.includes(port)
  ) {
    throw new Error(
      "Port is reserved or invalid; use a separate dev-server port",
    );
  }
  return {
    port,
    hostname: url.hostname === "[::1]" ? "::1" : url.hostname,
    path: url.pathname + url.search,
  };
}

function metadata(value, optional = false) {
  if (optional && (value === undefined || value === null || value === ""))
    return null;
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error("Invalid Herdr workspace/pane identity");
  return value;
}

export function validateRegistration(
  body,
  blockedPorts = DEFAULT_BLOCKED_PORTS,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Invalid preview registration");
  const app = parseLocalApp(body.url, blockedPorts);
  const name = body.name ?? `localhost:${app.port}`;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name.length > 80 ||
    /[\x00-\x1f\x7f]/u.test(name)
  )
    throw new Error("Invalid preview name");
  return {
    ...app,
    name: name.trim(),
    workspaceId: metadata(body.workspaceId),
    paneId: metadata(body.paneId, true),
  };
}

function probe(entry) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: entry.hostname,
        port: entry.port,
        path: "/",
        method: "HEAD",
        lookup: loopbackLookup,
        autoSelectFamily: true,
        timeout: 1200,
      },
      (res) => {
        // A dev error page (or unsupported HEAD) is still an available server.
        const available = typeof res.statusCode === "number";
        res.destroy();
        req.destroy();
        resolve(available);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}

export async function createPreviewRegistry({
  file,
  blockedPorts = DEFAULT_BLOCKED_PORTS,
  maxEntries = 8,
  checkAvailability = probe,
} = {}) {
  let state = {
    schemaVersion: 1,
    epoch: randomBytes(16).toString("hex"),
    revision: 0,
    lastOpen: null,
    previews: [],
  };
  if (file) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8"));
      if (
        saved.schemaVersion !== 1 ||
        typeof saved.epoch !== "string" ||
        !PREVIEW_ID.test(saved.epoch) ||
        !Number.isSafeInteger(saved.revision) ||
        saved.revision < 0 ||
        !Array.isArray(saved.previews) ||
        saved.previews.length > maxEntries
      )
        throw new Error("Invalid preview registry");
      const ids = new Set();
      for (const entry of saved.previews) {
        const host = entry.hostname === "::1" ? "[::1]" : entry.hostname;
        const validated = validateRegistration(
          { ...entry, url: `http://${host}:${entry.port}${entry.path}` },
          blockedPorts,
        );
        if (
          !PREVIEW_ID.test(entry.id) ||
          ids.has(entry.id) ||
          entry.hostname !== validated.hostname ||
          entry.path !== validated.path
        )
          throw new Error("Invalid preview registry");
        ids.add(entry.id);
      }
      if (
        saved.lastOpen !== null &&
        (!saved.lastOpen ||
          !Number.isSafeInteger(saved.lastOpen.revision) ||
          saved.lastOpen.revision > saved.revision ||
          saved.lastOpen.revision < 1 ||
          !ids.has(saved.lastOpen.id))
      )
        throw new Error("Invalid preview open request");
      state = saved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  let serial = Promise.resolve();
  const health = new Map();
  const closeListeners = new Set();
  function transaction(change) {
    const run = serial.then(async () => {
      const next = structuredClone(state);
      const result = change(next);
      next.revision = Math.max(Date.now(), state.revision + 1);
      if (next.lastOpen?.revision === -1)
        next.lastOpen.revision = next.revision;
      if (file) {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file + ".tmp", JSON.stringify(next), { mode: 0o600 });
        await rename(file + ".tmp", file);
      }
      state = next;
      return result;
    });
    serial = run.catch(() => {});
    return run;
  }
  return {
    get(id) {
      return state.previews.find((entry) => entry.id === id) ?? null;
    },
    async list() {
      const snapshot = structuredClone(state);
      snapshot.previews = await Promise.all(
        snapshot.previews.map(async (entry) => {
          let cached = health.get(entry.id);
          if (!cached || cached.until < Date.now()) {
            cached = {
              available: await checkAvailability(entry),
              until: Date.now() + 3000,
            };
            health.set(entry.id, cached);
          }
          return { ...entry, available: cached.available };
        }),
      );
      return snapshot;
    },
    async open(body) {
      const validated = validateRegistration(body, blockedPorts);
      return transaction((next) => {
        let entry = next.previews.find(
          (item) =>
            item.port === validated.port &&
            item.hostname === validated.hostname &&
            item.workspaceId === validated.workspaceId,
        );
        if (!entry) {
          if (next.previews.length >= maxEntries)
            throw new Error("Too many previews; close an existing page first");
          entry = { ...validated, id: randomBytes(16).toString("hex") };
          next.previews.push(entry);
        } else Object.assign(entry, validated);
        next.lastOpen = { id: entry.id, revision: -1 };
        health.delete(entry.id);
        return { ...entry };
      });
    },
    async close(id) {
      if (typeof id !== "string" || !PREVIEW_ID.test(id))
        throw new Error("Invalid preview ID");
      let removed = false;
      await transaction((next) => {
        removed = next.previews.some((entry) => entry.id === id);
        next.previews = next.previews.filter((entry) => entry.id !== id);
        if (next.lastOpen?.id === id) next.lastOpen = null;
      });
      health.delete(id);
      if (removed) for (const listener of closeListeners) listener(id);
      return {
        id,
        closed: removed,
        revision: state.revision,
        epoch: state.epoch,
      };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}
