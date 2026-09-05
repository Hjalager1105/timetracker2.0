# Team time tracker

A small self-contained web app for clocking employees in/out and reviewing
timesheets. No database server required — data is stored in a `data.json`
file next to the server.

## Set up the database (Postgres)

The app now stores data in Postgres instead of a JSON file, so it can
support real statistics and date-range queries.

### On Railway
1. In your Railway project, click **+ New** → **Database** → **Add PostgreSQL**.
2. Click on your app service (the timetracker one) → **Variables**.
3. Click **New Variable** → **Add Reference** → pick the Postgres service's
   `DATABASE_URL`. This wires the two services together without you typing
   any connection string by hand.
4. Redeploy — the app creates its own tables automatically on startup
   (see `initDb()` in `server.js`), so there's no separate schema step.

### Migrating your existing data.json
If you already have employees/entries in the old `data.json` file:
1. Download `data.json` from your Railway volume (Railway → your service →
   the volume browser, or via `railway ssh` if you have the CLI — ask if
   you'd like help with either).
2. Put it in the same folder as `migrate.js`.
3. Run it once, pointed at your production database:
   ```bash
   DATABASE_URL="<paste the Postgres connection string from Railway>" node migrate.js
   ```
   (Get the connection string from Railway → Postgres service → Variables
   → `DATABASE_URL`, the public one, not the `.railway.internal` one, since
   you're running this from your own computer.)
4. It's safe to run more than once — it skips anything already migrated.

**Note:** any employee who doesn't have a password set yet (added before
the password feature) gets skipped by the migration — add them again
through the Admin tab instead.

### Running locally
You'll need a Postgres database reachable from your computer — either a
local install, Docker (`docker run -e POSTGRES_PASSWORD=devpass -p 5432:5432 postgres`),
or you can just point at your Railway database's public connection string
for local testing too. Either way:
```bash
DATABASE_URL="postgres://user:pass@host:5432/dbname" npm start
```

## Set the admin password

Before running the app, set an admin password — this is what gates the
Admin tab (adding/removing employees, editing timesheets). Employees each
get their own password too, set individually by the admin when adding them;
that password is what they type in to clock in or out.

- **Locally:** create a file called `.env` isn't wired up by default here to
  keep things dependency-free — instead just set the environment variable
  before starting, e.g. on Mac/Linux: `ADMIN_PASSWORD=yourpassword npm start`
- **On Railway:** go to your service → Variables → New Variable → name
  `ADMIN_PASSWORD`, value whatever you want. Redeploy after adding it.

If you don't set it, the app falls back to `changeme` — fine for testing,
but change it before real use.

## Run it locally

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd time-tracker-app
npm install
npm start
```

Then open http://localhost:3000 in your browser. That's it — the "Clock
in / out" tab is for employees, "Admin" is for adding/removing people and
reviewing/correcting timesheets.

## Put it on a real website

Because several people need to see the same clock-in state, this needs a
tiny bit of server hosting (not just a static file host like GitHub Pages).
Cheapest, easiest options:

### Option A — Railway or Render (free/cheap, ~5 minutes, no server admin)
1. Push this folder to a GitHub repo.
2. Create a new project on [railway.app](https://railway.app) or
   [render.com](https://render.com), pick "Deploy from GitHub repo".
3. Both auto-detect Node apps — they'll run `npm install` then `npm start`.
4. Once deployed you'll get a URL like `your-app.up.railway.app` — share
   that with your team.
5. **Important:** enable a "persistent volume/disk" (Railway: Volumes;
   Render: Disks) mounted at the project folder, so `data.json` survives
   restarts and redeploys. Without it, your data resets on every deploy.

### Option B — Your own VPS (DigitalOcean, Linode, a home server, etc.)
1. Copy the folder to the server (`scp` or `git clone`).
2. `npm install && npm start` — or better, keep it running with
   [pm2](https://pm2.keymetrics.io/): `npx pm2 start server.js --name time-tracker`
3. Put it behind a domain with a reverse proxy (nginx or Caddy) so it's
   reachable at `https://time.yourcompany.com` instead of `:3000`.
   Caddy is the simplest — a Caddyfile of just:
   ```
   time.yourcompany.com {
     reverse_proxy localhost:3000
   }
   ```
   gives you automatic HTTPS.

### Option C — Fly.io (free tier, good if you want it always-on globally)
1. Install the `flyctl` CLI and run `fly launch` in this folder — it
   detects the Node app automatically.
2. Add a small persistent volume for `data.json` (`fly volumes create`)
   and mount it in `fly.toml`.

## If you're updating an existing deployment

Employees added before this password feature don't have a password set,
so they won't be able to clock in until you set one. As admin, remove and
re-add anyone who was added before, or use the "reset password" API
endpoint (`POST /api/employees/:id/password`) if you'd rather not lose
their history — ask if you'd like a small admin-UI button added for this
instead of doing it via the API directly.

## Notes on what's here vs. a production app

- **Password protection, not full accounts.** Admin actions require the
  shared `ADMIN_PASSWORD`, and each employee has their own password to
  clock in/out — passwords are hashed (scrypt) before being stored, never
  kept in plain text. This is lightweight protection suitable for a small
  trusted team on a shared device, not enterprise-grade auth (there's no
  per-user login session, rate limiting, or password reset flow — the
  admin resets a forgotten password by adding it again for that employee).
- **Storage is a JSON file**, which is simple and fine for a small team,
  but won't scale well past a few thousand entries or handle simultaneous
  writes under heavy load. If you outgrow it, swapping in a real database
  (Postgres via an ORM like Prisma) is a contained change — only
  `server.js` would need to change, not the frontend.
- **No CSV/payroll export yet** — easy to add if you want it.

Want help with any of these next steps — PIN-based login, CSV export for
payroll, or setting up the actual deploy? Just ask.
