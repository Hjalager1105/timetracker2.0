# Team time tracker

A small self-contained web app for clocking employees in/out and reviewing
timesheets. No database server required — data is stored in a `data.json`
file next to the server.

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

## Notes on what's here vs. a production app

- **No login/authentication.** Anyone with the link can clock in as
  anyone. Fine for a small trusted team; if you need real accounts, that's
  the next thing to add (e.g. a PIN per employee, or a proper auth
  provider).
- **Storage is a JSON file**, which is simple and fine for a small team,
  but won't scale well past a few thousand entries or handle simultaneous
  writes under heavy load. If you outgrow it, swapping in a real database
  (Postgres via an ORM like Prisma) is a contained change — only
  `server.js` would need to change, not the frontend.
- **No CSV/payroll export yet** — easy to add if you want it.

Want help with any of these next steps — PIN-based login, CSV export for
payroll, or setting up the actual deploy? Just ask.
