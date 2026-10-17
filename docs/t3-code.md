# T3 Code alongside Herdr in Telegram

The optional T3 companion makes the running T3 Code desktop environment available
as a preview in the existing private Herdr Telegram Mini App. It uses the same
projects, threads, providers and sessions as the desktop app. Keep T3 Code running
on the computer; the companion does not start a second T3 server.

Install the [private Telegram gateway](telegram.md) and
[localhost preview broker](previews.md) first. Node.js 22+ and T3's desktop-installed
`~/.t3/bin/t3` CLI are required. This integration was verified with CachyOS's
`t3code-nightly-bin`, version `0.1.1-nightly.20261017.3238`. It depends on T3's
`userdata/server-runtime.json` discovery file and `auth pairing create --json`
command; other builds must provide those interfaces.

## Install on the computer

Copy `gateway/herdr-t3-preview.service` into `~/.config/systemd/user/`, adapting
its checkout path. Enable the service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now herdr-t3-preview.service
```

The service binds **127.0.0.1:8791 only** and discovers T3's current loopback server
address for each request, so desktop restarts and port changes can recover without
changing the preview registration. `T3CODE_HOME` selects the T3 data directory,
`T3CODE_CLI_PATH` selects its CLI, and `HERDR_T3_PREVIEW_PORT` overrides port 8791.
The included service sets the standard desktop home and CLI paths explicitly.

Register the companion in the intended Herdr Space, using its actual workspace ID:

```sh
herdr-preview open http://127.0.0.1:8791/__herdr_t3 \
  --name 'T3 Code Nightly' --workspace WORKSPACE_ID
```

Use the bundled preview client if the `herdr-preview` wrapper is not installed;
see [preview commands](previews.md#agent-commands-and-skill). Open the Telegram
Mini App and select **T3 Code Nightly** in that Space. Closing the preview revokes
its remote access without stopping T3; registering it again restores access.
The existing gateway, wildcard DNS and SSH forwarding need no changes.

## Browser pairing and access

Opening `/__herdr_t3` checks the browser's T3 session. If needed, the companion
issues a one-minute pairing credential using the local T3 CLI, immediately
exchanges it for a browser session, forwards the HttpOnly cookie, and redirects
to the app. Credentials are never put into preview URLs, the registry, command
arguments, or companion logs. Each browser has a separate revocable T3 session
labelled **Herdr Telegram**. A valid session is reused when reopening the preview.

**The companion trusts the existing owner-authenticated preview gateway. Never
publish its port directly or put it behind an unauthenticated tunnel.** Its
bootstrap endpoint intentionally grants access to the owner's T3 environment.
Local processes under the same account are trusted, as with the local T3 CLI.
Host, Origin and browser fetch metadata checks reject unrelated browser requests;
they do not replace gateway authentication. The listener remains on loopback.

The companion forwards HTTP and WebSocket traffic to the discovered loopback
server. It rejects remote targets and authentication redirects, removes forwarded
proxy identity, and leaves T3's normal authorization in place. A missing desktop
server or failed pairing returns an unavailable response without exposing error
details or secrets. Refresh the preview after opening T3 on the computer.

## Verification and removal

`npm run gateway:check` includes tests for pairing/cookie forwarding, valid-session
reuse, rejected browser requests, redirect rejection, unavailable-server recovery,
HTTP forwarding and binary WebSocket/subprotocol forwarding. The deployed setup
was also verified through the production HTTPS gateway in Herdr's sandboxed
iframe at phone width. Actual Telegram device keyboard/input behavior still needs
checking on the phone.

To disable this integration, close its preview and run:

```sh
systemctl --user disable --now herdr-t3-preview.service
```

Revoke unwanted **Herdr Telegram** sessions in T3's connection settings. Existing
Herdr terminals, agents, previews and the T3 desktop app can continue running.
