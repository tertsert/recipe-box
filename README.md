# Recipe Box

Paste a recipe link → get just the ingredients and instructions. Saved recipes are shared, so anyone with the site link can browse them.

```
docs/      the website (GitHub Pages serves this folder)
worker/    the API (a Cloudflare Worker + KV storage)
```

**How it cleans recipes:** almost every recipe site embeds the recipe as structured data (schema.org JSON-LD) for Google. The worker reads that instead of the page itself, so ads, life stories and pop-ups never come through.

**Sites that block servers:** some big publishers (Allrecipes, Serious Eats, Simply Recipes, and sites behind Cloudflare's bot check) refuse requests that don't come from a real browser. For those, the site offers a **"Save to Recipe Box" bookmark button**: tapped on the recipe page, it reads the recipe data in your own browser and sends it over.

---

## Setup (about 15 minutes, all free tiers)

### 1. Put the code on GitHub
1. Create a new repository, e.g. `recipe-box` (public is required for free GitHub Pages).
2. Push this folder to it.

### 2. Deploy the Cloudflare Worker

**Option A — Dashboard (no tools needed)**
1. Cloudflare dashboard → **Storage & Databases → KV** → **Create** a namespace called `RECIPES`.
2. **Workers & Pages → Create → Worker** → name it `recipe-box-api` → Deploy → **Edit code**, replace everything with `worker/worker.js`, Deploy.
3. Worker → **Settings → Bindings → Add → KV namespace**: variable name `RECIPES`, namespace `RECIPES`.
4. Worker → **Settings → Variables and Secrets**, add:
   - `SITE_URL` (text) = `https://tertsert.github.io/recipe-box`
   - `ALLOWED_ORIGIN` (text) = `https://tertsert.github.io`
   - `SUBMIT_PASSCODE` (secret, optional but recommended) = a word you'll share with your friend
5. Note the worker URL, e.g. `https://recipe-box-api.YOUR-SUBDOMAIN.workers.dev`.

**Option B — Command line** (needs Node.js)
```bash
cd worker
npx wrangler login
npx wrangler kv namespace create RECIPES     # paste the id into wrangler.toml
# edit SITE_URL / ALLOWED_ORIGIN in wrangler.toml
npx wrangler secret put SUBMIT_PASSCODE      # optional
npx wrangler deploy
```

### 3. Point the site at the worker
Edit `docs/config.js` and set `window.RECIPE_API` to the worker URL from step 2. Commit and push.

### 4. Turn on GitHub Pages
Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch `main`, folder **`/docs`** → Save.
After a minute the site is live at `https://tertsert.github.io/recipe-box/`.

### 5. Share it
Send your friend the link (and the passcode, if you set one). The first time she saves a recipe the site asks for the passcode and remembers it on that device. She should do that *before* setting up the bookmark button, so the button carries the passcode too.

---

## Notes
- **Passcode:** without one, anyone who finds the site could add or delete recipes. Viewing is always open.
- **Costs:** Workers free tier is 100k requests/day; KV free tier is 1k writes/day. A personal recipe box won't come close.
- **Custom domain:** optional. If you add one in GitHub Pages, update `SITE_URL` and `ALLOWED_ORIGIN` to match.
