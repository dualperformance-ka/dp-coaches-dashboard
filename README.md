# Dual Performance — Coaches Dashboard

Live per-athlete summary dashboard pulling from 4 Notion databases in real time.

## Stack

- **Frontend** — single HTML file, zero dependencies, zero build step
- **Backend** — one Vercel serverless function that proxies the Notion API (keeps your token server-side)
- **Hosting** — Vercel (free hobby tier is more than enough)

---

## Setup — 3 steps

### 1. Create a Notion Integration

1. Go to **https://www.notion.so/my-integrations**
2. Click **+ New integration**
3. Name it (e.g. "DP Coaches Dashboard"), select your workspace, leave defaults
4. Copy the **Internal Integration Token** — it starts with `secret_`

### 2. Share your databases with the integration

Open each of the 4 databases in Notion, click the **…** menu (top right) → **Connections** → find your integration and add it. Do this for all four:

| Database | Notion URL |
|---|---|
| Weekly Check-in | `notion.so/33e5a96c…` |
| Athlete Session Tracker | `notion.so/1c55a96c…` |
| Daily Body Check-in | `notion.so/3405a96c-c70b-80a4…` |
| Daily Nutrition Check-in | `notion.so/3405a96c-c70b-804b…` |

### 3. Deploy to Vercel

```bash
# 1. Push this folder to a GitHub repo (public or private)

# 2. Install Vercel CLI if you haven't
npm i -g vercel

# 3. Deploy
vercel

# 4. Add your secret (do this once, in the Vercel dashboard or CLI)
vercel env add NOTION_TOKEN
# paste your secret_xxx token when prompted

# 5. Redeploy so the env var takes effect
vercel --prod
```

Your dashboard will be live at `https://your-project.vercel.app` — share that URL with coaches.

---

## Local development

```bash
cp .env.example .env
# fill in NOTION_TOKEN in .env

npm install
npm run dev
# opens at http://localhost:3000
```

---

## Project structure

```
dp-coaches-dashboard/
├── api/
│   └── notion.js       ← serverless proxy (Notion token lives here, server-side only)
├── public/
│   └── index.html      ← the dashboard UI
├── .env.example        ← copy → .env, fill in token
├── .gitignore
├── package.json
├── vercel.json
└── README.md
```

## How it works

1. Browser loads `index.html` and calls `/api/notion?db=<database-id>` for each of the 4 databases
2. The Vercel serverless function in `api/notion.js` calls the Notion REST API using `NOTION_TOKEN` (never exposed to the browser), handles pagination, and returns a flat JSON array
3. The frontend builds per-athlete cards, flags niggles/stress/missed sessions, and sorts by urgency

The token is **never** in the frontend code — only the database IDs (which are already in the Notion URLs you shared, so not sensitive).

---

## Updating database IDs

If you ever swap out a database, edit the `DB` object at the top of `public/index.html`:

```js
const DB = {
  weekly:    '33e5a96c-c70b-8049-b696-d22e5920e0ee',
  sessions:  '1c55a96c-c70b-825b-9bdf-819abea4ef7c',
  body:      '3405a96c-c70b-80a4-b1b9-cf5b9c236f18',
  nutrition: '3405a96c-c70b-804b-aa9c-f165f2d2e0e9',
};
```
