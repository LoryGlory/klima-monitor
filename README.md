# klima-monitor

A polite, self-hosted stock monitor for the Midea PortaSplit (or any product) across
German retailers. Built to run headless on a Raspberry Pi alongside other always-on jobs.

It polls each retailer using the cheapest reliable method (internal JSON API → JSON-LD
in the page → Playwright render as last resort), detects the `OutOfStock → InStock`
transition, and pushes you a Telegram or ntfy alert the moment something flips.

## Why this design

Manually refreshing shop pages is the thing we're replacing. The robust way to read
stock is **not** to scrape rendered HTML — it's to hit the same internal JSON endpoints
the shop's own frontend uses. They return clean structured data, change less often than
markup, and cost a fraction of the bandwidth. Browser automation (Playwright) is the
fallback for sites behind Cloudflare or that only render availability client-side.

## Good-citizen rules (read before running)

This reads **public** availability data for **personal** use. Keep it that way:

- Respect `robots.txt`. If a path is disallowed, don't poll it.
- Poll slowly. Default is every 3 minutes with jitter. Don't go below ~60s.
- Identify yourself: the User-Agent includes a contact line. Don't spoof a browser
  unless a site genuinely requires JS rendering (then Playwright is honest about it).
- Back off on `429`/`403`. The fetcher does this automatically; don't disable it.
- One alert for you. Don't turn this into a scalper bot — the whole German AC market
  is already suffering from automated grabbers. Be the opposite of that.

## Setup

```bash
npm install
cp .env.example .env        # fill in TELEGRAM_* or NTFY_TOPIC
npx playwright install chromium   # only needed if you use the 'render' method
npm run build
npm start                   # or install the systemd unit below
```

## Finding a retailer's stock endpoint (the 5-minute method)

1. Open the product page in Chrome, DevTools → Network → filter **Fetch/XHR**.
2. Reload. Watch for a request that returns availability — often a URL containing
   `availability`, `stock`, `inventory`, `marketAvailability`, or a GraphQL `/graphql`.
3. Copy that request as cURL ("Copy → Copy as cURL"), see what params it needs
   (article id, store/branch id, postal code).
4. Add it to `src/targets.ts` as a `method: 'api'` target with a small `parse` fn that
   pulls the availability flag out of the JSON.

If you can't find one (e.g. MediaMarkt/Saturn hide it behind Cloudflare), use
`method: 'render'` and a CSS selector / text match instead.

## Deploy as a systemd service on the Pi

`/etc/systemd/system/klima-monitor.service`:

```ini
[Unit]
Description=Klima stock monitor
After=network-online.target

[Service]
WorkingDirectory=/home/pi/klima-monitor
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=30
EnvironmentFile=/home/pi/klima-monitor/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now klima-monitor
journalctl -u klima-monitor -f
```
