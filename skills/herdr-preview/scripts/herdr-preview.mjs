#!/usr/bin/env node
import http from "node:http";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export function parseArguments(args, env = process.env) {
  const [command, ...rest] = args;
  if (["--help", "-h", "help"].includes(command) || !command)
    return { help: true };
  if (!["open", "close", "list"].includes(command))
    throw new Error("Expected open, close or list");
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      if (
        !["--name", "--workspace", "--pane", "--socket"].includes(arg) ||
        options[arg] !== undefined ||
        !rest[index + 1] ||
        rest[index + 1].startsWith("--")
      )
        throw new Error(`Invalid option: ${arg}`);
      options[arg] = rest[++index];
    } else positional.push(arg);
  }
  const socketPath =
    options["--socket"] ||
    env.HERDR_PREVIEW_SOCKET ||
    join(
      env.XDG_RUNTIME_DIR || join(homedir(), ".cache"),
      "herdr-preview",
      "control.sock",
    );
  if (!isAbsolute(socketPath))
    throw new Error("Control socket must be an absolute local path");
  if (command === "list") {
    if (
      positional.length ||
      Object.keys(options).some((key) => key !== "--socket")
    )
      throw new Error("list takes no preview arguments");
    return { command, socketPath, path: "/previews", method: "GET" };
  }
  if (positional.length !== 1)
    throw new Error(
      `${command} requires ${command === "open" ? "a localhost URL" : "a preview ID"}`,
    );
  if (command === "close") {
    if (
      !/^[a-f0-9]{32}$/.test(positional[0]) ||
      Object.keys(options).some((key) => key !== "--socket")
    )
      throw new Error("close requires a preview ID from list");
    return {
      command,
      socketPath,
      path: "/close",
      method: "POST",
      body: { id: positional[0] },
    };
  }
  const url = new URL(positional[0]);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.port
  )
    throw new Error("Use an HTTP localhost URL with an explicit port");
  const workspaceId = options["--workspace"] || env.HERDR_WORKSPACE_ID;
  if (!workspaceId)
    throw new Error(
      "Run inside a Herdr agent pane or provide --workspace <workspace-id>; refusing to guess the active Space",
    );
  return {
    command,
    socketPath,
    path: "/open",
    method: "POST",
    body: {
      url: url.href,
      name: options["--name"],
      workspaceId,
      paneId: options["--pane"] || env.HERDR_PANE_ID || null,
    },
  };
}

export function requestPreview(options) {
  return new Promise((resolve, reject) => {
    const payload = options.body ? JSON.stringify(options.body) : null;
    const req = http.request(
      {
        socketPath: options.socketPath,
        path: options.path,
        method: options.method,
        timeout: 5000,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let length = 0;
        const parts = [];
        res.on("data", (chunk) => {
          length += chunk.length;
          if (length > 262144) {
            res.destroy();
            reject(new Error("Preview service response too large"));
          } else parts.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(parts).toString());
            if (res.statusCode !== 200)
              reject(
                new Error(
                  typeof value.error === "string"
                    ? value.error
                    : "Preview request failed",
                ),
              );
            else resolve(value);
          } catch {
            reject(new Error("Invalid preview service response"));
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error("Preview service timed out")),
    );
    req.on("error", (error) =>
      reject(
        new Error(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? "Herdr preview broker is not running on this computer"
            : error.message,
        ),
      ),
    );
    req.end(payload);
  });
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
    const options = parseArguments(process.argv.slice(2));
    if (options.help)
      console.log(
        "Usage: herdr-preview open http://localhost:PORT [--name NAME] [--workspace ID] [--pane ID]\n       herdr-preview close ID\n       herdr-preview list\nOptional --socket PATH selects a private local broker. JSON output; close never stops the dev server.",
      );
    else console.log(JSON.stringify(await requestPreview(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
