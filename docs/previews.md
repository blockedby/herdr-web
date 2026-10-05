# Localhost previews inside Herdr

The optional preview broker lets an agent open a locally running application inside the existing private Telegram Mini App. Preview rows live alongside agents/tabs in the sidebar; selecting one replaces the terminal surface. The compact header offers return, refresh and close. Closing a preview revokes access and removes its iframe, **without stopping its dev server or agent**.

This feature uses the [private Telegram gateway](telegram.md). Standalone/LAN/Android terminal access is unchanged. It does not expose a general-purpose unauthenticated localhost tunnel.

## Agent commands and skill

Install the skill from the fork:

```sh
npx skills add blockedby/herdr-web --skill herdr-preview
```

For Pipi's shared global skill discovery, use `npx skills add blockedby/herdr-web --skill herdr-preview --agent universal --global`. The Pi-specific CLI target is the standard `~/.pi` location, not a customized `~/.pipi` runtime.

For a local checkout, `npx skills add /absolute/path/to/herdr-web --skill herdr-preview` discovers the same bundled skill. Choose the agent/location supported by your Skills CLI. Installing a skill alone does not install the broker or networking.

Use its bundled Node.js 22+ client, or an owner-installed `herdr-preview` symlink:

```sh
herdr-preview open http://localhost:5173 --name "Notes"
herdr-preview list
herdr-preview close PREVIEW_ID
```

The standalone equivalent is `node /path/to/herdr-web/skills/herdr-preview/scripts/herdr-preview.mjs ...`. `open` requires `HERDR_WORKSPACE_ID` (normally inherited in a Herdr pane) or explicit `--workspace WORKSPACE_ID`; optional `HERDR_PANE_ID` records its source. No command guesses the current workspace from another client's selection. `--socket /absolute/path` overrides the default private Unix socket.

Commands return JSON. Reopening the same origin in the same workspace updates/selects its existing row; a changed path requests navigation. Connected clients observe open/close requests on their next short poll. There is no automatic terminal focus command or terminal input injection.

## Computer-side installation

Keep this checkout and private configuration under your Herdr environment directory. Install gateway dependencies with `npm ci --prefix gateway` and use Node.js 22+. Append these settings to the environment directory's Git-excluded, mode-0600 `.env`; use a newly generated random secret, not the examples:

```dotenv
HERDR_PREVIEW_SECRET=REPLACE_WITH_A_RANDOM_SECRET_OF_AT_LEAST_43_CHARACTERS
HERDR_PREVIEW_PORT=8790
```

A safe secret generator is `node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'`; write its output directly into private configuration rather than chat or source. The same secret is needed on the VPS, independently of the Telegram session secret.

Copy `gateway/herdr-preview.service` into the user's systemd configuration, adapt its checkout/Node paths, then enable `herdr-preview.service`. Its socket is `$XDG_RUNTIME_DIR/herdr-preview/control.sock`, mode 0600; state is persisted as `preview-registry.json`, mode 0600. **Git-ignore that state file** in your environment directory: it can contain private app paths/workspace metadata. Without persistence, a broker restart clears registrations.

The broker listens only on `127.0.0.1:8790`. Registration is permitted only through its Unix socket; the authenticated TCP service allows listing, closing and proxying, not remote registration. Reserve additional administrative ports with `HERDR_PREVIEW_BLOCKED_PORTS=PORT,PORT`; Herdr, browser/Node debugging and the broker's own ports are blocked by default.

Optionally create a symlink from `~/.local/bin/herdr-preview` to the executable bundled client. Preserve any existing user-owned wrapper instead of overwriting it.

## SSH, DNS and gateway

Add a second **loopback-only** remote forwarding to the existing supervised tunnel:

```text
-R 127.0.0.1:28789:127.0.0.1:8790
```

The restricted SSH public key must permit this exact additional remote listener, while retaining the existing terminal forwarding and restrictions. Never expose either VPS forwarding port publicly. Restarting the tunnel/gateway disconnects transport briefly; it does not stop Herdr agents/dev servers.

On the VPS, append:

```dotenv
HERDR_PREVIEW_SECRET=THE_SAME_PRIVATE_BROKER_SECRET
HERDR_PREVIEW_UPSTREAM=http://127.0.0.1:28789
HERDR_PREVIEW_DOMAIN=preview.example.com
```

The preview domain must be a **separate same-site sibling** of the frontend/gateway, so Secure/SameSite cookies work in Telegram without third-party-cookie exceptions. Each registration gets its own `p-RANDOM_ID.preview.example.com` origin. Add a wildcard DNS record `*.preview.example.com` pointing directly to the VPS; no wildcard DNS credential is required by the application.

Caddy can issue individual certificates on demand. Add its local authorization endpoint to the global options:

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:28788/internal/preview-tls-ask
  }
}
```

Add a catch-all HTTPS site (keep existing exact sites unchanged):

```caddyfile
https:// {
  tls {
    on_demand
  }
  reverse_proxy 127.0.0.1:28788 {
    header_up X-Herdr-Client-IP {remote_host}
  }
}
```

The ask endpoint authorizes only active cryptographic preview names and fails closed when the home broker is unavailable. **Every public route into the gateway, including this catch-all, must overwrite `X-Herdr-Client-IP`**; public calls to the ask endpoint are then denied. Do not proxy gateway routes elsewhere without this overwrite. Invalid/closed names cannot request new certificates. HTTPS/ACME ports must reach Caddy normally.

Add only `frame-src https://*.preview.example.com` to the frontend deployment CSP. Do not add preview origins to the parent's `connect-src`, permit arbitrary frames, or enable JavaScript `unsafe-eval`. This fork's `web/vercel.json` contains the configured `preview.peacedata.company` example. Redeploy the frontend and gateway after checking configuration; the gateway Docker image must include all `preview-*.mjs` runtime modules.

## Isolation and behavior

- Owner Telegram authorization is required to discover previews, issue a short-lived single-use launch ticket or close a page. A launch sets an id-scoped, host-only Secure/HttpOnly/SameSite=Strict preview cookie and redirects to the app path. It cannot authorize the terminal API or another app origin.
- Iframes use `allow-scripts allow-same-origin allow-forms` **only on the separate per-preview origin**. Parent DOM/terminal credentials remain cross-origin; top navigation, popups and privileged device access are not enabled. Do not move these frames onto the frontend/gateway origin.
- Broker/session credentials and forwarded client identity are not sent to dev apps. Application cookies and application Authorization headers work independently; cookie domains are narrowed to the preview host. App CSP is retained except its frame-ancestor directive, which is replaced with the configured Herdr frontend.
- Relative assets, root routes, query strings, forms/uploads and WebSocket/HMR traffic use the app's origin. Loopback redirects for the same app port are rewritten. Hard-coded localhost/other-port browser API URLs and absolute URLs inside response bodies are **not** rewritten; configure a same-origin dev proxy. Service workers/dev caches are isolated per app origin; responses from the proxy are not cached by it.
- At most eight registrations are allowed. Visited iframe documents stay mounted until explicitly closed, logout, registry replacement or app reload; switching to an agent does not discard their forms. Hidden app JavaScript/HMR can continue running: hiding is not suspension of an embedded app. Close unwanted pages to release their browser resources. The terminal's view-owned effects pause while a preview replaces it; command drafts live under the existing app owner.
- Availability uses bounded cached `HEAD /` probes, not repeated requests to a user-provided query/path. Initial unavailable previews recover automatically when the dev server starts; an already-loaded page keeps its content and can be refreshed explicitly. Closing revokes HTTP access and terminates its proxy WebSockets, but never signals the app process.
- Direct preview URLs are not public share links. Open the bot's Mini App to authorize the owner; an expired Telegram session requires reopening it. Installing the skill cannot bypass missing DNS/TLS/tunnel/broker setup.

## Verification

Run the repository's `npm run check` with its working Rust toolchain. Preview tests exercise loopback validation, private control access, persistence, CLI outcomes, HTTP/header/cookie isolation, owner authorization, one-use/scoped launch tickets, certificate authorization, HMR protocol/binary forwarding and close revocation. Frontend tests exercise schemas, stale/replacement state, compact close contracts and retained frame identity; actual mobile rendering, keyboard and embedded app behavior still require device/browser verification.
