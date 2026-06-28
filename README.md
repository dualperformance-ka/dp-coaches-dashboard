# Dual Performance Dashboard Redesign

This package redesigns the existing coaches dashboard **without replacing or rewriting its Notion, Strava, applications, programming, nutrition, modal, or write-back logic**.

## What changes

- Cleaner unified header and primary navigation
- Filters moved into the content flow instead of stacking as a third sticky bar
- New coach greeting and clearer page hierarchy
- Priority-action styling for the command centre
- More readable summary metrics
- Cleaner athlete cards and table view
- Better spacing, typography, contrast and status hierarchy
- Improved planning, nutrition and modal styling
- Responsive tablet and mobile layouts
- Pride animation removed so alert colours remain meaningful
- Existing light/dark theme behaviour retained

## Install automatically

From this package folder:

```bash
python3 apply-redesign.py /path/to/dp-coaches-dashboard
```

The script:

1. Copies both redesign assets into `public/`
2. Adds the stylesheet before `</head>`
3. Adds the script before `</body>`
4. Creates `public/index.html.before-redesign` as a backup

Then review and push:

```bash
cd /path/to/dp-coaches-dashboard
git status
git add public/index.html public/dashboard-redesign.css public/dashboard-redesign.js
git commit -m "Redesign coaches dashboard UI"
git push
```

## Install manually

Copy these into the repo's `public/` folder:

- `public/dashboard-redesign.css`
- `public/dashboard-redesign.js`

Add this immediately before `</head>` in `public/index.html`:

```html
<link rel="stylesheet" href="/dashboard-redesign.css">
```

Add this immediately before `</body>`:

```html
<script src="/dashboard-redesign.js" defer></script>
```

## Roll back

Remove the two added tags and delete the two redesign files, or restore:

```bash
cp public/index.html.before-redesign public/index.html
```
