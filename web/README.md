# FocusGuard Web Console

Astro + React + TypeScript + Tailwind CSS v4 control console.

## Run

```sh
npm install
npm run dev
```

Open the URL printed by Astro (usually `http://localhost:4321`). `pnpm install && pnpm dev` is also supported. Run `npm run typecheck` and `npm run build` before deployment.

## API contract

Configure the API Base URL in the sign-in screen. The console automatically targets `/api/v1`; an origin, `/api`, `/v1`, or `/api/v1` base is accepted. Requests are made directly from the browser, so the Worker must return CORS headers for the console origin.

- `POST /api/v1/auth/login` and `/api/v1/auth/register` with `{ "email", "password" }`; response includes `token` and `user`.
- `GET /api/v1/auth/session` validates the stored session.
- `GET /api/v1/devices` reads only the authenticated user’s devices.
- `DELETE /api/v1/devices/{id}` unbinds an owned device after confirmation; its token is revoked while retained history is not physically deleted.
- Android registers automatically via `POST /api/v1/devices/register`; the account is selected by `PRIMARY_USER_ID` or, if exactly one exists, automatically.
- `POST /api/v1/devices/{id}/commands` queues `sync`, `lock`, or `unlock`; `GET /api/v1/devices/{id}/commands/{commandId}` reads execution state.
- `GET/POST /api/v1/policies` and `PATCH /api/v1/policies/{id}` manage versioned policies; `POST /api/v1/policies/{id}/assign` binds one to a device.
- `GET /api/v1/usage?device_id=...` reads usage rows available to the authenticated owner.

Authenticated requests send `Authorization: Bearer <session>`. HTTP, network/CORS, expired-session, and response-format errors are shown in the console; no sample device or policy records are used.
