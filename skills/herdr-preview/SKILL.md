---
name: herdr-preview
description: Open, list, and close localhost application previews inside Herdr. Use when the user asks to open or share a locally running app in Herdr/Telegram, test a dev-server page from their phone, or close a preview. Requires the private Herdr preview broker on the same computer.
license: MIT
---

# Herdr localhost previews

Use the bundled Node.js client at `scripts/herdr-preview.mjs`, resolved relative to this skill's directory. It talks only to the local private broker socket; no bot token or gateway credential belongs in this skill, a project, or command output. Node.js 22+ is required.

## Commands

```sh
node /path/to/herdr-preview/scripts/herdr-preview.mjs open http://localhost:5173 --name "Notes"
node /path/to/herdr-preview/scripts/herdr-preview.mjs list
node /path/to/herdr-preview/scripts/herdr-preview.mjs close PREVIEW_ID
```

All commands return JSON. Use the installed `herdr-preview` wrapper instead if available.

`open` registers the page in the current Herdr workspace and requests that connected Herdr web clients open it. Reopening the same origin in the same workspace updates the existing preview rather than duplicating it. A path such as `http://localhost:5173/settings` is allowed.

`close` removes the preview and revokes its proxy access. It **does not stop the dev server, terminate an agent, or close a terminal**. The interface's close button has the same effect. Use an ID returned by `open` or `list`; do not guess IDs or close unrelated previews.

## Workflow

1. Inspect the project's declared dev command and reuse an existing dev server where appropriate. If the user asked you to build/run an app, launch it using the host's background-terminal facilities. Do not kill unrelated servers or expose a listener publicly.
2. Verify the actual localhost URL and port. Use only HTTP loopback application origins, not LAN/public URLs, databases, administrative/debug services, or Herdr's own bridge.
3. Run `open` when the user asks to open the page. `HERDR_WORKSPACE_ID` and optional `HERDR_PANE_ID` normally identify your current Space and pane. Outside Herdr, supply `--workspace WORKSPACE_ID` explicitly; never infer it from whichever terminal the user currently selected.
4. Report the returned preview ID and Herdr URL, when provided. Registration/open-request success is not proof that the phone rendered the application. A stopped server leaves an unavailable preview; ask the user to reopen the bot's Mini App when Telegram authorization has expired.
5. Close the specified preview when requested. Only stop its dev process when the user separately asks to stop that server.

Pages run in an isolated frame inside Herdr, not in a separate app. Relative same-origin assets, routes and WebSockets are proxied. Hard-coded `http://localhost:OTHER_PORT` browser API URLs are not automatically rewritten; configure the app's own same-origin dev proxy instead.

## Missing setup

If the client reports that the preview broker is unavailable, do not fabricate a working link or silently fall back to an unauthenticated tunnel. Explain that the computer-side broker, authenticated gateway, preview DNS/TLS and SSH forwarding need installation by the owner. `--socket /absolute/path` or `HERDR_PREVIEW_SOCKET` can select an explicitly configured local broker.
