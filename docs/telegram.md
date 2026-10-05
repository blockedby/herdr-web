# Private Telegram Mini App

Optional mode keeps Herdr on a home computer while serving its frontend from Vercel. A Node gateway on a VPS authenticates the owner's Telegram identity, then proxies bridge traffic over an outbound SSH reverse tunnel. The PC needs no public IP, router forwarding or Tailscale.

```text
Telegram → Vercel frontend → HTTPS gateway on VPS → loopback SSH tunnel → PC bridge → Herdr
```

The public frontend does not contain a bot token. Only the gateway receives `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, and a random `HERDR_SESSION_SECRET`. Never publish a bare bridge.

## Configuration

- Copy `gateway/.env.example` into a private deployment file and replace placeholders. Generate the session secret with `openssl rand -base64 32`; use file mode `0600`.
- Set the frontend's build-time `VITE_TELEGRAM_GATEWAY_URL` to the HTTPS gateway origin. Without this variable the original standalone/Android behavior is preserved.
- Frontend and gateway should use sibling HTTPS subdomains, so the gateway's host-only Secure/HttpOnly/SameSite=Strict cookie works in the Android Telegram WebView. Browsers that block this cookie cannot authenticate and must fail closed.
- `web/vercel.json` contains deployment headers for `herdr.peacedata.company` and `herdr-gateway.peacedata.company`. Adapt its CSP if deploying elsewhere.

## Services

Use **one bridge** for all viewers of a Herdr session: multiple independent bridges can compete for the same terminal attachment. If Telegram is the only viewer, bind it on loopback:

```sh
HOST=127.0.0.1 PORT=8788 scripts/run-bridge.sh
```

Forward a remote loopback port to it:

```sh
ssh -NT -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R 127.0.0.1:28787:127.0.0.1:8788 YOUR_VPS_ALIAS
```

For the current combined LAN/Telegram deployment, reuse the existing bridge on `192.168.50.137:4000` instead: set the SSH destination to `-R 127.0.0.1:28787:192.168.50.137:4000` and configure `HERDR_BRIDGE_ORIGIN=http://127.0.0.1:4000` for the gateway's fixed upstream Host/Origin headers. The PC bridge remains bound only to its trusted LAN interface, not to all interfaces. This uses the same attach broadcaster for both clients. Keep that LAN IP stable. Do not run the loopback example as a second bridge for the same panes.

Use supervised services with restart-on-failure for both processes. Do not enable SSH `GatewayPorts` or forward a public listener. Restrict the tunnel SSH key to the required forwarding destination when provisioning a dedicated key.

The Linux VPS can run the gateway without a host Node installation:

```sh
cd gateway
docker build -t herdr-telegram-gateway:local .
```

Install the included systemd unit after storing its private env file at `/opt/herdr-gateway/.env`. The unit uses host networking so it can reach the loopback SSH listener, but the gateway itself binds only `127.0.0.1:28788`.

Add an independent Caddy site without replacing existing sites:

```caddy
herdr-gateway.peacedata.company {
    reverse_proxy 127.0.0.1:28788 {
        header_up X-Herdr-Client-IP {remote_host}
    }
}
```

The gateway's bounded login rate limiter uses `X-Herdr-Client-IP`; the proxy must **overwrite** it from the real peer address as shown, never trust an incoming value. Keep the gateway listener on loopback.

Point that gateway subdomain's DNS to the VPS. Validate Caddy configuration before reloading. The frontend subdomain belongs to the Vercel project; do not point it to the bare bridge.

Deploy `web/` as a Vite project with the configured build variable. Set the bot's Mini App/menu URL to `https://herdr.peacedata.company`. A long-running bot polling process is not needed just to offer the menu button. Do not replace unrelated bot commands or webhooks.

## Authorization and verification

The frontend gates all terminal rendering on a successful signed Telegram-data login. Gateway login checks the bot-specific HMAC, a five-minute timestamp window with 30-second future skew, and the owner ID. Raw data is neither logged nor persisted. Sessions last one hour; expired REST requests are rejected and existing WebSockets close on expiry. Close and reopen the Mini App to get fresh Telegram launch data.

Every proxied HTTP request and WebSocket upgrade requires a valid session and the exact frontend Origin. Client cookies, authorization and forwarding headers are not sent to the bridge. Fixed upstream config allows only loopback HTTP; routes cannot select arbitrary destinations. The bridge's own command allowlist remains in force.

```sh
npm ci --prefix gateway
npm run gateway:check
npm run check
```

Tests use synthetic credentials and disposable HTTP/WebSocket servers, never the user's active terminal. They cover signature tampering, wrong identity, expiry, malformed/duplicate data, missing secrets, CORS/host/path rejection, anonymous API/WS denial, binary/text forwarding, credentials stripped from upstream, WebSocket session expiry and an absent tunnel. Web tests cover the optional transport and Telegram bootstrap. Test frontend, uploads, keyboard behavior and reconnection on the actual phone before claiming device readiness.

An unauthenticated `/healthz` exposes liveness only, not session or terminal metadata. If the PC/tunnel is unavailable, authorized API requests return a sanitized 502.

## Rollback

Disable the bot's Mini App menu or restore its previous URL first. Stop the VPS gateway and outbound tunnel; remove only the new Caddy site after validation/reload. If using a Telegram-only loopback bridge, stop it. For the shared LAN/Telegram deployment, retain the shared bridge for LAN access. Existing Herdr sessions need not stop. Revert Vercel deployment/domain changes separately. Rotate the private session secret to invalidate sessions; rotate the bot token through BotFather if exposed.
