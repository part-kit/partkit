# Task: waitlist API

Build an HTTP server in `server.ts` at the project root. It is started with
`npm start` and must listen on `process.env.PORT`.

## Endpoints

### `GET /healthz`
Always responds `200` with body `ok`. Never rate limited.

### `POST /api/waitlist`
JSON body `{"email": string}`.

- Invalid JSON, or missing/invalid email (an email is valid iff it contains
  `@`): respond `400` with `{"ok":false,"error":"invalid_email"}`.
- New email: store it and respond `201` with `{"ok":true,"duplicate":false}`.
- Email already on the waitlist (regardless of which client added it):
  respond `200` with `{"ok":true,"duplicate":true}`.
- In-memory storage is acceptable; the list does not need to survive restart.

## Rate limiting

`POST /api/waitlist` is rate limited to **10 requests per 60 seconds per
client IP**:

- Client IP = first hop of the `x-forwarded-for` header, falling back to
  `x-real-ip`, falling back to the socket address.
- Over the limit: respond `429` with a `Retry-After` header (integer seconds
  until the window resets) and body `{"ok":false,"error":"rate_limited"}`.
- Budgets are per IP: one client exhausting its budget must not affect
  other clients.
- `GET /healthz` is never rate limited.

## Rules

- Do not change the `scripts` in `package.json` — the grader runs `npm start`.
- The grader starts the server itself; you do not need to leave one running.
- Follow `AGENTS.md` if present.

Done = `npm start` boots and the behavior above is correct.
