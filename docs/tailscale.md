# Setting up the public HTTPS tunnel (Tailscale Serve, and alternatives)

The phone needs a way to reach `https://<something>/<id>?t=<token>` and
have that URL route to `127.0.0.1:7461` (the broker's listen address)
over TLS with a public-CA cert. The phone is on your tailnet or the
public internet; the broker is bound to loopback only.

`mobile-approve` does not require any specific tunnel. Tailscale Serve
is the default because it's easy and tailnet-only, but any
HTTPS-to-loopback tunnel works.

## Tailscale Serve (default)

Tailscale's Serve feature auto-provisions a Let's Encrypt cert for your
MagicDNS hostname (`<laptop>.<tailnet>.ts.net`) and lets you path-route
incoming HTTPS traffic to loopback services.

### What you need

- Tailscale installed and signed in on the laptop: `tailscale up`
- MagicDNS enabled in the [Tailscale admin console](https://login.tailscale.com/admin/dns)
- HTTPS certificates enabled in the admin console (one-time per tailnet)

### One-time setup

From the `mobile-approve` repo, run:

```sh
./bin/setup-serve.sh
```

This script writes three Tailscale Serve rules (persisted by
`tailscaled`, survive reboots):

| Public path (HTTPS, port 443) | Loopback upstream |
|-------------------------------|-------------------|
| `/<id>` (and `/review/<id>`)   | `http://127.0.0.1:7461/review` (and `/review/<id>`) |
| `/decide/<id>`                | `http://127.0.0.1:7461/decide` |
| `/` (catch-all)               | `http://127.0.0.1:8090` (ntfy) |

The phone hits `https://<host>.tailnet.ts.net/<id>?t=<token>` for the
review page; the broker listens on `127.0.0.1:7461` and Tailscale
forwards the request to it. Tailscale Serve strips the `/review` and
`/decide` prefixes from the URL (its `Proxy` handler does this by
default) — the broker's HTTP server is configured to accept both the
prefixed and post-strip forms.

To verify:

```sh
sudo tailscale serve status
curl -s -w "  HTTP %{http_code}\n" --max-time 5 https://<host>.tailnet.ts.net/review/anything?t=anything
# (expected: 410 unknown/expired nonce)
```

### Reset

```sh
sudo tailscale serve reset
```

## Alternatives to Tailscale Serve

The plugin only needs a public HTTPS URL → `127.0.0.1:7461`. Anything
that does that works. If you don't want to use Tailscale, or if your
phone isn't on the same tailnet, pick one of these.

### Cloudflare Tunnel (`cloudflared`)

- Free, doesn't require a Tailscale account
- Public hostname like `https://<your-name>.trycloudflare.com`
  (or your own domain via Cloudflare)
- Install `cloudflared`, run `cloudflared tunnel login` once, then
  `cloudflared tunnel create mobile-approve`, then
  `cloudflared tunnel route dns mobile-approve <your-host>`. Finally
  point it at the broker:
  ```sh
  cloudflared tunnel --url http://127.0.0.1:7461 mobile-approve
  ```
- The catch-all path routing isn't a Cloudflare Tunnel feature; you'd
  add a Cloudflare Worker (or page rule) to route `/<id>` to the
  tunnel and `/` to a separate ntfy tunnel.

### ngrok

- Free for personal use (random hostnames), $8/mo for reserved
- Easy: `ngrok http 127.0.0.1:7461` and use the printed URL
- The catch-all ntfy path would need a second tunnel or a paid plan

### Caddy + your own VPS + real domain

- Buy a domain (or use a free subdomain service)
- Run Caddy on a small VPS with automatic Let's Encrypt certs
- Reverse-proxy `/{path}` to `http://127.0.0.1:7461` on the laptop
  (via WireGuard or Tailscale, or expose 7461 directly if your laptop
  has a static public IP)
- Route ntfy on a separate subdomain (e.g. `ntfy.example.com`) with
  its own Caddy vhost

### Direct port forward (least recommended)

- Forward port 443 on your router to your laptop
- Have a domain pointing at your public IP
- Run Caddy / Nginx on the laptop with Let's Encrypt via DNS-01
  challenge (e.g. acme-dns)
- Path-route the same way

This is the most "raw" option and exposes your laptop directly to
the internet, so only do this if you know what you're doing.

## What doesn't work (and why)

- **Self-signed certs**: the phone's browser will show a scary
  warning. Tailscale / Cloudflare / Let's Encrypt all give you a
  public-CA cert that the phone trusts.
- **Plain HTTP (no TLS)**: ntfy links in notifications would be `http://`.
  Some apps / phones refuse to open them. Tailscale / Cloudflare
  give you HTTPS by default.
- **Forwarding only `/review` but not `/decide`**: the phone submits
  the decision to `/<id>` POST (post-strip). Both `/review` and
  `/decide` need to point at the broker.

## Updating the plugin's public URL

If you switch tunnels (e.g. Tailscale → Cloudflare), the plugin's
`ntfy.baseUrl` and `tunnel.publicBaseUrl` need to update. Either:

- Re-run `bin/setup-broker.sh` (it reads from `opencode.json` and
  rewrites `broker.env`).
- Or edit `~/.config/opencode/opencode.json` by hand and restart
  opencode + the broker.

The phone's ntfy subscription topic doesn't change — only the URLs in
the notification change. The phone just opens the new URL on the next
notification.
