# FocusGuard Web Console

Astro + React + TypeScript + Tailwind CSS v4 control console.

## Run

```sh
npm install
npm run dev
```

Open the URL printed by Astro (usually `http://localhost:4321`). `pnpm install && pnpm dev` is also supported. Run `npm run typecheck` and `npm run build` before deployment.

## API contract

Configure the API Base URL in the sign-in screen. Requests are made directly from the browser, so the API must allow the console origin through CORS. The current console expects:

- `POST /api/auth/login` and `POST /api/auth/register` with `{ "email", "password" }`; response includes `token` or `access_token`, optionally `user.name` / `user.email`.
- `GET /api/devices` returning an array or an object with `items`, `data`, `results`, or `devices` array. Device objects use `id`, `name`, `status`, and optional `lastSeen`, `platform`, `policyId`.
- `POST /api/devices/{id}/commands` with `{ "command": "sync" | "lock" | "unlock" }`.
- `GET /api/policies` returning an array or an object with `items`, `data`, `results`, or `policies` array. Policy objects use `id`, `name`, optional `description`, `enabled`, and `deviceCount`.
- `POST /api/policies` with `{ "name", "description" }`, `PATCH /api/policies/{id}` with `{ "enabled": boolean }`, and `POST /api/policies/{id}/assign` with `{ "deviceId" }`.

Authenticated requests send `Authorization: Bearer <token>`. API contract mismatches, HTTP errors, and network/CORS failures are shown in the console; no sample device or policy records are used.
