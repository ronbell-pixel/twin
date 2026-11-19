# Twin Chimneys announcements API

A small Cloudflare Worker that stores the home-page announcements (in Workers KV) and
checks the admin password. The website (GitHub Pages) reads and edits announcements
through it — see `announcements.js` in the site root.

## One-time setup

```bash
cd announcements-api
npm install
npx wrangler kv namespace create ANNOUNCEMENTS   # paste the printed id into wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD           # the password board members will use
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
npx wrangler deploy                              # prints the https://…workers.dev URL
```

Put the deployed URL in `index.html` on the `<section id="announcements" data-api="…">` attribute.

## Everyday use

- On the home page, click **Admin login** in the Announcements section and enter the password.
- Add a title, message, optional links (web addresses, email addresses or phone numbers),
  and an optional **Show until** date — the post hides itself after that date.
- Edit or delete posts from the **Posted** list. Sign-ins last 8 hours.

## Changing the password

```bash
npx wrangler secret put ADMIN_PASSWORD
```

Changing it signs everyone out immediately. After 8 wrong attempts from one network,
login is paused for 15 minutes.

## Local testing

Create `announcements-api/.dev.vars` (git-ignored):

```
ADMIN_PASSWORD=any-local-test-password
SESSION_SECRET=any-long-random-string
```

Run `npx wrangler dev --port 8787` here, and serve the site root on localhost
(for example `python3 -m http.server 5173`). On localhost the page talks to port 8787 automatically.
