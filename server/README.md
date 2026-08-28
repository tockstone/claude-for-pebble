# Claude proxy for Pebble

A small HTTP service that answers Anthropic Messages API requests by running the `claude` CLI on the host. It lets the Pebble app talk to a machine that is logged into Claude instead of using an Anthropic API key.

## Endpoints

- `POST /v1/messages` takes `model`, `system`, and `messages` and returns a Messages-shaped response with a single text block, produced by `claude --print`.
- `GET /v1/models` returns the model list. The settings page uses it to check the secret and fill the model dropdown.
- `GET /healthz` answers `ok` without authentication.

Replies are truncated to the request's `max_tokens` at about four bytes per token, capped at 3500 bytes, so they always fit the watch's 4 KB AppMessage inbox. At most `MAX_CONCURRENT` CLI runs execute at once and further requests get a 429.

Every request except `/healthz` and CORS preflight must carry the shared secret, either as `x-api-key` or as `Authorization: Bearer`. The CLI runs with all tools disabled, no MCP servers, no skills, and no session persistence, so the service only generates text. The `web_search` and `mcp_servers` app settings are ignored when talking to the proxy.

## Requirements

- Node.js 20 or newer
- The `claude` CLI installed and logged in as the user running the service
- `cloudflared` for exposing the service through a Cloudflare tunnel

## Setup

```sh
git clone https://github.com/tockstone/claude-for-pebble.git
cd claude-for-pebble/server
cp .env.example .env
```

Generate a secret and put it in `.env` as `SHARED_SECRET`:

```sh
openssl rand -hex 32
```

Then start the service:

```sh
node index.js
```

`.env` is gitignored. Keep the secret, hostnames, and anything else personal there or in the gitignored `cloudflared/config.yml`, never in committed files.

## Cloudflare tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create claude-pebble
cloudflared tunnel route dns claude-pebble claude.example.com
cp cloudflared/config.example.yml cloudflared/config.yml
```

Fill `cloudflared/config.yml` (gitignored) with the tunnel ID printed by `create`, the credentials file path, and your hostname. Then run it:

```sh
cloudflared tunnel --config cloudflared/config.yml run
```

## Run as a service

systemd unit for the proxy, adjust paths and user:

```ini
[Unit]
Description=Claude proxy for Pebble
Wants=network-online.target
After=network-online.target

[Service]
User=USERNAME
WorkingDirectory=/opt/claude-for-pebble/server
ExecStart=/usr/bin/node index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

For the tunnel, `cloudflared service install` installs its own unit, or point a second unit at the `cloudflared tunnel --config ... run` command above.

## Updating

```sh
git pull
```

Then restart the service. There are no dependencies to install.

## Pointing the watchapp at it

In the watchapp settings on the phone:

- Set Base URL to `https://claude.example.com/v1/messages` with your hostname.
- Paste the shared secret into the API key field.

The settings page checks the secret against the server live and loads the model dropdown from `GET /v1/models`. The page is served over https, so the live check only works against an https proxy URL, which the Cloudflare tunnel provides.
