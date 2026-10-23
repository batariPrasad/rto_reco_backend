# RTO Reco backend

Express + PostgreSQL API for the RTO POD reconciliation app (scans, POD rows, reconciliation results, users, Gemini proxy).
The React app lives in a separate repo / Netlify site and talks to this API.

```
server/   Express API, migrations, tests
shared/   reconciliation engine (also copied into the frontend)
render.yaml   Render Blueprint: this API + a PostgreSQL database
```

## Run locally (Node 20+)

```bash
npm --prefix server install
npm --prefix server run dev:db          # terminal 1: local PostgreSQL, no install or Docker needed
```
Create `server/.env` from `.env.example` (local database: `DATABASE_URL=postgres://postgres:postgres@localhost:5433/rto`), then:

```bash
npm start                               # terminal 2: http://localhost:4000/api/health
npm test                                # real throwaway PostgreSQL, ~1.5 minutes the first time
```
Tables are created automatically on start. The first admin comes from `ADMIN_USERNAME` / `ADMIN_PASSWORD` (only when the users table is empty).

## Deploy on Render

1. Render → **New → Blueprint** → pick this repo. It reads `render.yaml` (web service `rto-reco-api` + database `rto-db`).
2. Fill in when asked:

| Variable | Value |
|---|---|
| `CORS_ORIGIN` | the Netlify address of the app, e.g. `https://pokonutrto.netlify.app` (no trailing slash; several allowed, comma separated) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first admin |
| `GEMINI_API_KEY` | only for photographed PODs |

3. Check `https://<service>.onrender.com/api/health` → `{"ok":true}`.

Free Render web services sleep after 15 minutes idle; free Render databases are deleted after 30 days. For real use change `plan:` in `render.yaml`, or point `DATABASE_URL` at Supabase/Neon with `PGSSL=true`.

## API (all under `/api`, JSON, `Authorization: Bearer <token>` after `POST /auth/login`)

`auth/login · auth/me · settings · users · dispatches (list/create/get/patch/delete) · dispatches/:id/scans (POST batch, DELETE one) · dispatches/:id/pod (PUT) · dispatches/:id/reconcile · awb/:awb · gemini/generate`

Commands: `npm --prefix server run create-user -- <username> <password> [admin|scanner]`, `npm --prefix server run migrate`.
