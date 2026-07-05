// rename-athlete-slug.js — bulk-rename Cloudinary public IDs for one athlete.
// Moves every asset under dp_progress/<OLD>/** to dp_progress/<NEW>/**,
// rewriting the slug in BOTH the folder path and the filename portion.
//
// Usage:
//   node rename-athlete-slug.js            # DRY RUN — prints planned moves, changes nothing
//   node rename-athlete-slug.js --commit   # actually renames
//
// Requires Cloudinary creds in env — either CLOUDINARY_URL, or the three
// CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET vars.
// (Same env this project's api/progress-photos.js already reads.)

const OLD_SLUG = 'thomas_trinh';
const NEW_SLUG = 'thomas';
const ROOT = 'dp_progress';

const COMMIT = process.argv.includes('--commit');

function creds() {
  const raw = process.env.CLOUDINARY_URL;
  if (raw) {
    const u = new URL(raw);
    return {
      cloudName: u.hostname,
      apiKey: decodeURIComponent(u.username),
      apiSecret: decodeURIComponent(u.password),
    };
  }
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  };
}

const { cloudName, apiKey, apiSecret } = creds();
if (!cloudName || !apiKey || !apiSecret) {
  console.error('Missing Cloudinary credentials in env. Set CLOUDINARY_URL or the three CLOUDINARY_* vars.');
  process.exit(1);
}
const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
const base = `https://api.cloudinary.com/v1_1/${cloudName}`;

// List every image under dp_progress/<OLD_SLUG>/, paging through results.
async function listAssets() {
  const found = [];
  let cursor = null;
  do {
    const body = {
      expression: `public_id:${ROOT}/${OLD_SLUG}/*`,
      max_results: 100,
      ...(cursor ? { next_cursor: cursor } : {}),
    };
    const r = await fetch(`${base}/resources/search`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error?.message || `search ${r.status}`);
    for (const a of data.resources || []) found.push(a.public_id);
    cursor = data.next_cursor || null;
  } while (cursor);
  return found;
}

// Rename one asset. Cloudinary rename is per resource_type; these are images.
async function rename(from, to) {
  const params = new URLSearchParams({
    from_public_id: from,
    to_public_id: to,
    overwrite: 'false',
    invalidate: 'true', // purge old CDN URLs
  });
  const r = await fetch(`${base}/image/upload/rename`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `rename ${r.status}`);
  return data.public_id;
}

(async () => {
  console.log(`Cloud: ${cloudName}`);
  console.log(`Rewrite: "${OLD_SLUG}" -> "${NEW_SLUG}"  (under ${ROOT}/)`);
  console.log(COMMIT ? '\n*** COMMIT MODE — assets will be renamed ***\n' : '\n--- DRY RUN — nothing will change (add --commit to apply) ---\n');

  const ids = await listAssets();
  if (!ids.length) {
    console.log(`No assets found under ${ROOT}/${OLD_SLUG}/. Nothing to do.`);
    return;
  }

  // Build move list: replace every occurrence of the old slug in the public_id.
  const moves = ids
    .map(from => ({ from, to: from.split(OLD_SLUG).join(NEW_SLUG) }))
    .filter(m => m.from !== m.to);

  console.log(`${moves.length} asset(s) to rename:\n`);
  for (const m of moves) console.log(`  ${m.from}\n    -> ${m.to}\n`);

  if (!COMMIT) {
    console.log('Dry run complete. Re-run with --commit to apply.');
    return;
  }

  let ok = 0, fail = 0;
  for (const m of moves) {
    try {
      const result = await rename(m.from, m.to);
      console.log(`renamed: ${result}`);
      ok++;
    } catch (e) {
      console.error(`FAILED: ${m.from} -> ${m.to} :: ${e.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} renamed, ${fail} failed.`);
})().catch(e => { console.error(e.message); process.exit(1); });
