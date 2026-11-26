# FocusGuard self-hosted server (HW SH)

Runs the same backend code as the Cloudflare Worker (`backend/src/index.ts`,
esbuild bundle `index.js`) on a plain Linux box: **Node 24 + node:sqlite**,
no npm dependencies. The web console is static files served by nginx.

## Layout on the server

```
/opt/fcm/
  server.mjs        # HTTP shim + D1-compatible wrapper over node:sqlite
  index.js          # Worker bundle (built from backend/src/index.ts)
  focusguard.db     # SQLite database (built from the D1 dump)
  package.json
/opt/node24/        # Node 24 tarball install
/etc/nginx/sites-enabled/fcm-api   # api-fcm.lyrnox.com -> 127.0.0.1:18080
/etc/nginx/sites-enabled/fcm-web   # fcm.lyrnox.com -> /var/www/fcm
/etc/nginx/certs/fcm/              # fullchain.pem + privkey.pem (Let's Encrypt, DNS-01)
/etc/systemd/system/focusguard.service
```

## Ports

Mainland-China VPS rule: no web service on 443 or 80 unless specially
required. fcm IS the special case: the user wants a bare domain with a
direct connection, which needs 443. So both domains serve HTTPS on **443**
(primary) and **8443** (fallback, in case 443 is reset on some exit).
There is no port-80 listener at all. Bare-domain clients use
`https://api-fcm.lyrnox.com` / `https://fcm.lyrnox.com`; the `:8443`
variants work identically. Cert renewal is DNS-01, so it needs no HTTP
port.

## First install

1. Node 24: unpack the linux-x64 tarball to `/opt/node24`
   (mirror: https://npmmirror.com/mirrors/node/v24.x/).
2. Copy `server/*` to `/opt/fcm/`, copy the esbuild bundle to
   `/opt/fcm/index.js` (`npx esbuild backend/src/index.ts --bundle
   --format=esm --outfile=index.js`).
3. Build the database from a D1 dump:
   `python3 build-db.py fcm-dump.json.gz ../backend/migrations /opt/fcm/focusguard.db`
4. `systemctl enable --now focusguard`, add the nginx sites, `nginx -t && systemctl reload nginx`.
5. Point DNS at the box and install the certs (see below).

## Updating the backend

Rebuild `index.js` from `backend/`, copy it to `/opt/fcm/`, then
`systemctl restart focusguard`. Migrations: apply new
`backend/migrations/*.sql` files to `focusguard.db` with sqlite3
(`sqlite3 /opt/fcm/focusguard.db < file.sql`) before restarting.

## Updating the web console

Take the `FocusGuard-Web-<version>.zip` from the GitHub Release,
unzip it into `/var/www/fcm/` (it contains `index.html` + `_astro/`).

## Backups

The whole state is one file: copy `/opt/fcm/focusguard.db` (plus
`-wal` if present) while the service is stopped, or use SQLite's
`.backup`. No D1 daily quota applies here — but the Android client
currently re-uploads its full usage history every sync; fixing that
to incremental sync is still worthwhile.

## Certificates

Issued on the admin VM with certbot DNS-01 (Cloudflare DNS API) and
pushed to `/etc/nginx/certs/fcm/` on HW SH; renewed by the weekly
cert job. Both `api-fcm.lyrnox.com` and `fcm.lyrnox.com` share one cert.
