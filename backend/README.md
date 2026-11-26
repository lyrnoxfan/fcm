# FocusGuard Workers API

Cloudflare Worker REST API backed by D1. The public API is available under `/api/*`; `/v1/*` is retained as a compatibility alias. `GET /health` is unauthenticated. All other user routes use short-lived bearer sessions created by registration/login; the legacy shared `AUTH_TOKEN` is no longer used.

## Setup

```sh
cd backend
npm install
npx wrangler d1 create focusguard
# replace database_id in wrangler.toml with the returned ID
npm run db:migrate:local
npm run dev
```

Apply production migrations with `npm run db:migrate:remote`, then deploy with `npm run deploy`.

## Authentication

`POST /api/auth/register` and `POST /api/auth/login` accept `{email,password,display_name?}` and return `{token,expires_in,user}`. Passwords are PBKDF2-SHA-256 hashes with random salts; only token hashes are stored in D1. Send the returned token as `Authorization: Bearer <token>`. `POST /api/auth/logout` revokes the current session and `GET /api/me` returns the authenticated user.

## Devices and automatic registration

Android calls `POST /api/v1/devices/register` with `{device_id,token,name,platform,app_version?}`. The ID and token are generated and stored by the device. The server uses `PRIMARY_USER_ID` when set; otherwise exactly one user must exist. Retries with the same credentials are idempotent and revoked identities cannot enroll again. Device requests use `X-Device-Token` (or `Authorization: Device <token>`); heartbeat is `POST /api/v1/devices/:id/heartbeat`. Enrollment is unauthenticated: restrict API network access. HTTP exposes credentials and allows interception and modification.

## Policies, commands, and usage

Policies are device-scoped and versioned: `GET /api/policies?device_id=...` and `POST /api/policies` with `{device_id,name,version,rules_json,enabled?}`. Commands are created by the owner with `POST /api/commands`; `Idempotency-Key` makes retries safe. Commands include `pending`, `delivered`, `executed`, `failed`, and `expired` states plus `expires_at`. A device pulls pending commands from `GET /api/devices/:id/commands` and acknowledges with `POST /api/devices/:id/commands/:command_id/ack` and `{status:"executed"|"failed"|"delivered",error_message?}`. Owners can inspect commands with `GET /api/commands?device_id=...`. Usage is owner-scoped at `POST /api/usage` and `GET /api/usage?device_id=...`.

All list/detail operations constrain records through the authenticated user or the hashed device token; passwords and bearer tokens are never returned by API responses.

## Verification

```sh
npm run typecheck
npm test
npm run db:migrate:local
```
