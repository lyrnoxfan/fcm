# FocusGuard Workers API

Cloudflare Worker REST API backed by D1. It currently uses one shared bearer token as an explicit authentication placeholder; it does not identify individual users or enforce per-user authorization. Requests fail with `503 auth_not_configured` until `AUTH_TOKEN` is configured and with `401` when the bearer token is absent or invalid.

## Setup

```sh
cd backend
npm install
# Create the D1 database, then replace database_id in wrangler.toml with its ID.
npx wrangler d1 create focusguard
npx wrangler secret put AUTH_TOKEN
npm run db:migrate:local
npm run dev
```

Set the production secret before deploying. Apply production migrations with `npm run db:migrate:remote`.

## Routes

All `/v1/*` routes require `Authorization: Bearer $AUTH_TOKEN`; `GET /health` is an unauthenticated liveness route.

| Resource | Routes |
| --- | --- |
| users, devices, policies, commands | `GET/POST /v1/{resource}`, `GET/PATCH/DELETE /v1/{resource}/{id}` |
| usage | `POST /v1/usage`, `GET /v1/usage?device_id=...` |
| heartbeat | `POST /v1/devices/{id}/heartbeat` |

JSON fields: users (`email`, `display_name`); devices (`user_id`, `name`, `platform`, `app_version`); policies (`user_id`, `name`, `enabled`, `rules_json`); commands (`device_id`, `kind`, `payload_json`, `status`); usage (`device_id`, `app_id`, `usage_date`, `duration_seconds`). JSON-valued fields are JSON-encoded strings. Foreign keys and uniqueness constraints are enforced by D1.

## Verification

```sh
npm run typecheck
npm test
```
