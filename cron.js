// cron.js — sends daily/weekly digests to confirmed subscribers on Render Cron
const fetch = require('node-fetch');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

// ---------- ENV ----------
const {
  DATABASE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL missing');
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !FROM_EMAIL) {
  console.warn('⚠️ SMTP settings incomplete — emails will fail.');
}

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined
});

// ---------- Email ----------
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});
async function sendEmail({ to, subject, html, text }) {
  return transporter.sendMail({ from: FROM_EMAIL, to, subject, html, text });
}

// ---------- Reddit helpers (same logic as server.js) ----------
const REDDIT_HEADERS = {
  'User-Agent': 'Reddit-Trends Cron/1.0 (+https://render.com)',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8'
};
async function fetchJson(url) {
  const res = await fetch(url, { headers: REDDIT_HEADERS });
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { json = await res.json(); } catch {}
  }
  return { status: res.status, json, url: res.url };
}
async function fetchText(url) {
  const res = await fetch(url, { headers: REDDIT_HEADERS });
  const text = await res.text();
  return { status: res.status, text, url: res.url };
}
function parseCanonicalFromHtml(html, fallback) {
  const og = html.match(/property=["']og:url["'][^>]*content=["']https:\/\/(?:www|old)\.reddit\.com\/r\/([^\/"']+)\//i);
  if (og?.[1]) return og[1];
  const link = html.match(/<link\s+rel=["']canonical["'][^>]*href=["']https:\/\/(?:www|old)\.reddit\.com\/r\/([^\/"']+)\//i);
  if (link?.[1]) return link[1];
  const desc = html.match(/(?:subreddit-description|subredditDescription)=["']r\/([^"']+)["']/i);
  if (desc?.[1]) return desc[1];
  const title = html.match(/<title>\s*r\/([A-Za-z0-9_]+)\b/i);
  if (title?.[1]) return title[1];
  return fallback;
}
function htmlLooksProtected(html) {
  if (/<protected-community-modal/i.test(html)) return true;
  if (/This community is private/i.test(html)) return true;
  if (/You must be invited to visit this community/i.test(html)) return true;
  return false;
}
async function resolveSubreddit(input) {
  const raw = input.trim().replace(/^r\//i, '');
  let a = await fetchJson(`https://api.reddit.com/r/${raw}/about`);
  if (a.status === 200 && a.json?.data) {
    const d = a.json.data;
    return { exists: true, canonical: d.display_name, type: d.subreddit_type || 'public' };
  }
  if (a.status !== 403) {
    a = await fetchJson(`https://www.reddit.com/r/${raw}/about.json`);
    if (a.status === 200 && a.json?.data) {
      const d = a.json.data;
      return { exists: true, canonical: d.display_name, type: d.subreddit_type || 'public' };
    }
  }
  const h1 = await fetchText(`https://www.reddit.com/r/${raw}/`);
  const h2 = await fetchText(`https://old.reddit.com/r/${raw}/`);
  if (h1.status === 404 && h2.status === 404) return { exists: false };
  const html = (h1.status === 200 ? h1.text : '') + '\n' + (h2.status === 200 ? h2.text : '');
  const canonical = parseCanonicalFromHtml(html || '', raw);
  const gated = htmlLooksProtected(html || '');
  return { exists: true, canonical, type: gated ? 'maybe_gated' : 'unknown' };
}
function parseRedditAtom(xml) {
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)];
  return entries.map(e => {
    const b = e[0];
    const title = (b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [,''])[1].trim();
    const link = (b.match(/<link[^>]*href="([^"]+)"/i) || [,''])[1];
    const id = (b.match(/<id>([^<]+)<\/id>/i) || [,''])[1];
    const permalink = /\/comments\//.test(id) ? id : ( /\/comments\//.test(link) ? link : null );
    return { title, url: link || permalink || null, permalink };
  });
}
async function fetchPosts(canonical, timeframe) {
  const endpoints = [
    `https://api.reddit.com/r/${canonical}/top?t=${encodeURIComponent(timeframe)}&limit=10&raw_json=1`,
    `https://www.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=10&raw_json=1`,
    `https://old.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=10`
  ];
  for (const url of endpoints) {
    const { status, json } = await fetchJson(url);
    if (status === 200 && json?.data?.children?.length) {
      return json.data.children.map(p => ({
        title: p.data.title,
        url: `https://reddit.com${p.data.permalink}`
      }));
    }
  }
  const rssUrl = `https://www.reddit.com/r/${canonical}/top/.rss?t=${encodeURIComponent(timeframe)}`;
  const rssRes = await fetchText(rssUrl);
  if (rssRes.status === 200 && /<(entry|item)\b/i.test(rssRes.text)) {
    return parseRedditAtom(rssRes.text).map(p => ({
      title: p.title,
      url: p.permalink || p.url
    }));
  }
  return [];
}

// ---------- Scheduling helpers ----------
function isDue(sub) {
  const now = new Date();
  const last = sub.last_sent ? new Date(sub.last_sent) : null;
  if (sub.timeframe === 'day') {
    if (!last) return true;
    return (now - last) >= 20 * 60 * 60 * 1000; // 20h
  }
  if (sub.timeframe === 'week') {
    // send on Mondays (UTC) or if never sent
    const monday = now.getUTCDay() === 1;
    if (!last) return monday;
    const days = (now - last) / (1000 * 60 * 60 * 24);
    return monday && days >= 6.5;
  }
  // default: treat as day
  if (!last) return true;
  return (now - last) >= 20 * 60 * 60 * 1000;
}

// ---------- Main ----------
(async () => {
  console.log('Cron start…');
  const client = await pool.connect();
  try {
    // ensure table exists (idempotent)
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        subreddit TEXT NOT NULL,
        timeframe TEXT NOT NULL DEFAULT 'week',
        confirmed BOOLEAN NOT NULL DEFAULT FALSE,
        confirmation_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_sent TIMESTAMPTZ
      );
    `);

    const { rows } = await client.query(
      `SELECT id, email, subreddit, timeframe, last_sent
       FROM subscriptions
       WHERE confirmed = TRUE`
    );

    if (!rows.length) {
      console.log('No confirmed subscribers. Exiting.');
      process.exit(0);
    }

    for (const sub of rows) {
      if (!isDue(sub)) continue;

      try {
        const info = await resolveSubreddit(sub.subreddit);
        if (!info.exists) {
          console.log(`Skip ${sub.email} — subreddit not found: ${sub.subreddit}`);
          continue;
        }
        const posts = await fetchPosts(info.canonical, sub.timeframe === 'day' ? 'day' : 'week');
        const top = posts.slice(0, 5);
        const listHtml = top.length
          ? `<ol>${top.map(p => `<li><a href="${p.url}">${escapeHtml(p.title)}</a></li>`).join('')}</ol>`
          : `<p>No top posts found today (may be gated or empty).</p>`;

        const subject = `Top posts from r/${info.canonical} (${sub.timeframe})`;
        const html = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
            <h2>r/${info.canonical} — ${sub.timeframe} digest</h2>
            ${listHtml}
            <p style="font-size:12px;color:#666">You’re receiving this because you subscribed to r/${sub.subreddit}.
            <br/>Change timeframe by re-subscribing with a different option.</p>
          </div>`;
        const text = `Top posts from r/${info.canonical} (${sub.timeframe}):\n` +
                     (top.length ? top.map((p,i)=>`${i+1}. ${p.title}\n${p.url}`).join('\n') : 'No posts found.');

        await sendEmail({ to: sub.email, subject, html, text });
        await client.query(`UPDATE subscriptions SET last_sent = NOW(), subreddit = $2 WHERE id = $1`, [sub.id, info.canonical]);
        console.log(`✔ Sent to ${sub.email} for r/${info.canonical}`);
      } catch (e) {
        console.error(`✖ Failed ${sub.email} / ${sub.subreddit}:`, e.message);
      }
    }
    console.log('Cron done.');
  } finally {
    client.release();
    await pool.end().catch(()=>{});
  }
})();

function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
