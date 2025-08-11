// server.js - web service with robust Reddit fetch (JSON -> RSS -> HTML), Postgres subscriptions, Gmail SMTP
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- ENV ----------
const {
  DATABASE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
  BASE_URL
} = process.env;

const PUBLIC_BASE = BASE_URL || `http://localhost:${PORT}`;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// avoid noisy favicon 404s
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- DB (Postgres) ----------
if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL is missing. Set it in Render & locally (.env).');
}
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : undefined
});

async function migrate() {
  await pool.query(`
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
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_sub ON subscriptions (email, subreddit, timeframe);
  `);
}
migrate().then(() => console.log('✅ DB migrated')).catch(err => {
  console.error('DB migration failed:', err);
  process.exit(1);
});

// ---------- Email (SMTP via nodemailer) ----------
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS && FROM_EMAIL) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log('✅ Email transporter ready (SMTP)');
} else {
  console.warn('⚠️  SMTP settings missing or incomplete. Emails will be logged, not sent.');
}

async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`\n[EMAIL LOG] To: ${to}\nSubject: ${subject}\n${text || html}\n`);
    return { ok: true, logged: true };
  }
  await transporter.sendMail({ from: FROM_EMAIL, to, subject, html, text });
  return { ok: true };
}

// ---------- Root ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- Reddit helpers ----------
const REDDIT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 RedditTrends/1.0',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8'
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: REDDIT_HEADERS });
  let json = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { json = await res.json(); } catch (_) {}
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

  // Try API first
  let a = await fetchJson(`https://api.reddit.com/r/${raw}/about`);
  if (a.status === 200 && a.json?.data) {
    const d = a.json.data;
    return { exists: true, canonical: d.display_name, url: `https://www.reddit.com${d.url}`, type: d.subreddit_type || 'public', httpStatus: 200, source: 'api.about' };
  }

  // Try www JSON if not clearly blocked
  if (a.status !== 403) {
    a = await fetchJson(`https://www.reddit.com/r/${raw}/about.json`);
    if (a.status === 200 && a.json?.data) {
      const d = a.json.data;
      return { exists: true, canonical: d.display_name, url: `https://www.reddit.com${d.url}`, type: d.subreddit_type || 'public', httpStatus: 200, source: 'www.about' };
    }
  }

  // HTML: learn canonical & whether the page shows a protected modal
  const h1 = await fetchText(`https://www.reddit.com/r/${raw}/`);
  const h2 = await fetchText(`https://old.reddit.com/r/${raw}/`);
  if (h1.status === 404 && h2.status === 404) {
    return { exists: false, reason: 'not_found', httpStatus: 404 };
  }
  const html = (h1.status === 200 ? h1.text : '') + '\n' + (h2.status === 200 ? h2.text : '');
  const canonical = parseCanonicalFromHtml(html || '', raw);
  const gated = htmlLooksProtected(html || '');
  return { exists: true, canonical, url: `https://www.reddit.com/r/${canonical}/`, type: gated ? 'maybe_gated' : 'unknown', httpStatus: gated ? 403 : 200, source: 'html' };
}

// ---------- Fetch posts: JSON -> RSS -> HTML (old.reddit.com) ----------
function stripTags(s) {
  return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function parseTopFromOldRedditHTML(html, max = 10) {
  // Each post on old.reddit.com lives in a .thing with data-permalink
  const items = [];
  const thingRe = /<div[^>]+class="[^"]*\bthing\b[^"]*"[^>]*data-permalink="([^"]+)"[\s\S]*?<a[^>]+class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = thingRe.exec(html)) && items.length < max) {
    const permalink = m[1]; // e.g. /r/programming/comments/abcd123/...
    const titleHtml = m[2];
    items.push({
      title: stripTags(titleHtml),
      url: `https://old.reddit.com${permalink}`,
      permalink: `https://old.reddit.com${permalink}`
    });
  }
  return items;
}

async function fetchPosts(canonical, timeframe) {
  // 1) JSON endpoints
  const endpoints = [
    `https://api.reddit.com/r/${canonical}/top?t=${encodeURIComponent(timeframe)}&limit=25&raw_json=1`,
    `https://www.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=25&raw_json=1`,
    `https://old.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=25`
  ];

  for (const url of endpoints) {
    const { status, json } = await fetchJson(url);
    if (status === 200 && json?.data?.children?.length) {
      return {
        ok: true,
        posts: json.data.children.map(p => ({
          title: p.data.title,
          score: p.data.score,
          author: p.data.author,
          url: p.data.url,
          permalink: `https://reddit.com${p.data.permalink}`,
          created: p.data.created_utc,
          num_comments: p.data.num_comments,
          source: 'json'
        })),
        used: url
      };
    }
  }

  // 2) RSS (top)
  const rssUrl = `https://www.reddit.com/r/${canonical}/top/.rss?t=${encodeURIComponent(timeframe)}`;
  const rssRes = await fetchText(rssUrl);
  if (rssRes.status === 200 && /<(entry|item)\b/i.test(rssRes.text)) {
    // Parse Atom
    const entries = [...rssRes.text.matchAll(/<entry>[\s\S]*?<\/entry>/g)];
    const posts = entries.slice(0, 25).map(e => {
      const b = e[0];
      const title = (b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [,''])[1].trim();
      const link = (b.match(/<link[^>]*href="([^"]+)"/i) || [,''])[1];
      const id = (b.match(/<id>([^<]+)<\/id>/i) || [,''])[1];
      const permalink = /\/comments\//.test(id) ? id : ( /\/comments\//.test(link) ? link : null );
      return {
        title,
        score: null,
        author: null,
        url: permalink || link || null,
        permalink: permalink || link || null,
        created: null,
        num_comments: null,
        source: 'rss'
      };
    });
    if (posts.length) {
      return { ok: true, posts, used: rssUrl };
    }
  }

  // 3) HTML scrape (old.reddit.com top)
  const htmlUrl = `https://old.reddit.com/r/${canonical}/top/?t=${encodeURIComponent(timeframe)}`;
  const htmlRes = await fetchText(htmlUrl);
  if (htmlRes.status === 200) {
    const posts = parseTopFromOldRedditHTML(htmlRes.text, 25);
    if (posts.length) {
      return { ok: true, posts: posts.map(p => ({ ...p, source: 'html' })), used: htmlUrl };
    }
  }

  return { ok: false };
}

// ---------- API: resolve ----------
app.get('/api/resolve/:subreddit', async (req, res) => {
  const info = await resolveSubreddit(req.params.subreddit);
  console.log('RESOLVE', req.params.subreddit, '→', info);
  if (!info.exists) return res.status(404).json(info);
  res.json(info);
});

// ---------- API: trending ----------
app.get('/api/trending/:subreddit', async (req, res) => {
  const inputSubreddit = req.params.subreddit;
  const timeframe = req.query.timeframe || 'week';

  try {
    const info = await resolveSubreddit(inputSubreddit);
    if (!info.exists) {
      return res.status(404).json({ error: `Subreddit "${inputSubreddit}" not found`, ...info });
    }

    if (inputSubreddit.toLowerCase() !== info.canonical.toLowerCase()) {
      console.log(`Auto-canonicalizing ${inputSubreddit} → ${info.canonical}`);
    }

    const fetched = await fetchPosts(info.canonical, timeframe);
    if (!fetched.ok) {
      return res.status(403).json({
        error: `r/${info.canonical} is not readable from this server (blocked across JSON/RSS/HTML).`,
        canonical: info.canonical,
        hint: 'Try a client-side fetch from a real browser session or add a rotating proxy.'
      });
    }

    console.log(`✅ Fetched ${fetched.posts.length} posts from r/${info.canonical} via ${fetched.used}`);
    res.json(fetched.posts);
  } catch (err) {
    console.log('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Subscriptions ----------
app.post('/api/subscribe', async (req, res) => {
  const { email, subreddit, timeframe } = req.body || {};
  if (!email || !subreddit) return res.status(400).json({ error: 'Email and subreddit are required' });

  const token = crypto.randomBytes(32).toString('hex');
  try {
    await pool.query(
      `INSERT INTO subscriptions (email, subreddit, timeframe, confirmed, confirmation_token)
       VALUES ($1,$2,COALESCE($3,'week'), FALSE, $4)
       ON CONFLICT (email, subreddit, timeframe)
       DO UPDATE SET confirmed = FALSE, confirmation_token = EXCLUDED.confirmation_token`,
      [email, subreddit, timeframe || 'week', token]
    );

    const confirmUrl = `${PUBLIC_BASE}/api/confirm/${token}`;
    const subject = `Confirm your subscription to r/${subreddit} (${timeframe || 'week'})`;
    const text = `Click to confirm: ${confirmUrl}`;
    const html = `<p>Confirm your subscription to <b>r/${subreddit}</b> (${timeframe || 'week'}).</p><p><a href="${confirmUrl}">Confirm subscription</a></p>`;

    await sendEmail({ to: email, subject, html, text });
    res.json({ message: 'Please check your email to confirm subscription!' });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

app.get('/api/confirm/:token', async (req, res) => {
  const token = req.params.token;
  try {
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE confirmation_token = $1', [token]);
    const sub = rows?.[0];
    if (!sub) return res.send('<h1>Invalid confirmation link</h1>');

    await pool.query('UPDATE subscriptions SET confirmed = TRUE, confirmation_token = NULL WHERE id = $1', [sub.id]);

    res.send(`
      <h1>✅ Subscription Confirmed!</h1>
      <p>You will now receive updates for r/${sub.subreddit} (${sub.timeframe}).</p>
      <p><a href="${PUBLIC_BASE}">← Back to Reddit Trends</a></p>
    `);
  } catch (err) {
    console.error('Confirm error:', err);
    res.send('<h1>Error confirming subscription</h1>');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PUBLIC_BASE}`);
});
