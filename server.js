// server.js — respectful Reddit fetcher (OAuth+throttle+cache), Postgres subs, SMTP mailer

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
  BASE_URL,
  REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET
} = process.env;

const PUBLIC_BASE = BASE_URL || `http://localhost:${PORT}`;

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json());

// serve static assets at / and /public (matches your current HTML)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/public', express.static(path.join(__dirname, 'public')));

// avoid noisy favicon 404s
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- DB (Postgres) ----------
if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL missing. Set it in Render & locally (.env).');
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
  console.warn('⚠️  SMTP not fully configured. Emails will be logged only.');
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
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 RedditTrends/1.0',
  'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8'
};

// polite throttle (~1 req/sec)
const MIN_DELAY_MS = 1200;
let lastRedditCall = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function redditThrottle() {
  const wait = lastRedditCall + MIN_DELAY_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRedditCall = Date.now();
}

// generic timeout wrapper
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  return await Promise.race([
    fetch(url, options),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
  ]);
}

// small in-memory cache per (sub,timeframe)
const CACHE = new Map();   // key -> { data, exp }
const PENDING = new Map(); // key -> in-flight Promise
const cacheKey = (canonical, tf) => `${canonical.toLowerCase()}:${tf}`;
const ttlFor = (tf) => (tf === 'day' ? 5 * 60 * 1000 : 60 * 60 * 1000); // 5m day, 60m week
const getCached = (k) => {
  const e = CACHE.get(k);
  return e && Date.now() < e.exp ? e.data : null;
};
const setCached = (k, data, tf) => CACHE.set(k, { data, exp: Date.now() + ttlFor(tf) });

// JSON / Text fetchers (throttled + timeout + retry-after parsing)
async function fetchJson(url) {
  await redditThrottle();
  const res = await fetchWithTimeout(url, { headers: REDDIT_HEADERS }, 10000);
  const ct = res.headers.get('content-type') || '';
  const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) || null;
  let json = null;
  if (ct.includes('application/json')) {
    try { json = await res.json(); } catch (_) {}
  }
  return { status: res.status, json, url: res.url, retryAfter };
}
async function fetchText(url) {
  await redditThrottle();
  const res = await fetchWithTimeout(url, { headers: REDDIT_HEADERS }, 10000);
  const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) || null;
  const text = await res.text();
  return { status: res.status, text, url: res.url, retryAfter };
}

// --- OAuth (optional but recommended) ---
let redditToken = null, redditTokenExp = 0;
async function getRedditToken() {
  if (redditToken && Date.now() < redditTokenExp) return redditToken;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) throw new Error('Missing Reddit creds');
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const res = await fetchWithTimeout('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_HEADERS['User-Agent']
    },
    body: 'grant_type=client_credentials&scope=read'
  }, 10000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`OAuth token error ${res.status}`);
  redditToken = j.access_token;
  redditTokenExp = Date.now() + Math.max(60, (j.expires_in || 3600) - 60) * 1000;
  return redditToken;
}
async function fetchOAuthJson(url) {
  const token = await getRedditToken();
  await redditThrottle();
  const res = await fetchWithTimeout(url, { headers: { ...REDDIT_HEADERS, Authorization: `Bearer ${token}` } }, 10000);
  const ct = res.headers.get('content-type') || '';
  const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10) || null;
  let json = null;
  if (ct.includes('application/json')) {
    try { json = await res.json(); } catch {}
  }
  return { status: res.status, json, retryAfter };
}

// ---------- Canonical resolution from HTML (works even when JSON gated) ----------
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

  // Try API first (often fine)
  let a = await fetchJson(`https://api.reddit.com/r/${raw}/about`);
  if (a.status === 200 && a.json?.data) {
    const d = a.json.data;
    return { exists: true, canonical: d.display_name, url: `https://www.reddit.com${d.url}`, type: d.subreddit_type || 'public', httpStatus: 200, source: 'api.about' };
  }

  if (a.status !== 403) {
    a = await fetchJson(`https://www.reddit.com/r/${raw}/about.json`);
    if (a.status === 200 && a.json?.data) {
      const d = a.json.data;
      return { exists: true, canonical: d.display_name, url: `https://www.reddit.com${d.url}`, type: d.subreddit_type || 'public', httpStatus: 200, source: 'www.about' };
    }
  }

  // HTML path
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

// ---------- Parsers ----------
function stripTags(s){ return (s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

function parseTopFromOldRedditHTML(html, max = 5) {
  const items = [];
  const re = /<div[^>]+class="[^"]*\bthing\b[^"]*"[^>]*data-permalink="([^"]+)"[\s\S]*?class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="score[^"]*"[^>]*>([^<]*)<\/div>[\s\S]*?class="comments"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && items.length < max) {
    const permalink = m[1];
    const titleHtml = m[2];
    const scoreTxt = (m[3] || '').replace(/[^0-9]/g, '');
    const commentsTxt = (m[4] || '').replace(/[^0-9]/g, '');
    items.push({
      title: stripTags(titleHtml),
      url: `https://old.reddit.com${permalink}`,
      permalink: `https://old.reddit.com${permalink}`,
      score: scoreTxt ? Number(scoreTxt) : null,
      num_comments: commentsTxt ? Number(commentsTxt) : null,
      source: 'html'
    });
  }
  return items;
}

// ---------- Fetch posts (cache + OAuth + fallbacks) ----------
async function fetchPosts(canonical, timeframe) {
  const key = cacheKey(canonical, timeframe);
  const cached = getCached(key);
  if (cached) return { ok: true, posts: cached, used: 'cache' };
  if (PENDING.has(key)) return await PENDING.get(key);

  const run = (async () => {
    // 0) OAuth first (if creds provided)
    if (REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
      try {
        const oauthUrl = `https://oauth.reddit.com/r/${canonical}/top?t=${encodeURIComponent(timeframe)}&limit=25&raw_json=1`;
        const { status, json, retryAfter } = await fetchOAuthJson(oauthUrl);
        if (status === 429) return { ok: false, rateLimited: true, retryAfter: retryAfter || 30 };
        if (status === 200 && json?.data?.children?.length) {
          const posts = json.data.children.slice(0, 5).map(p => ({
            title: p.data.title,
            score: p.data.score,
            author: p.data.author,
            url: p.data.url,
            permalink: `https://reddit.com${p.data.permalink}`,
            created: p.data.created_utc,
            num_comments: p.data.num_comments,
            source: 'oauth'
          }));
          setCached(key, posts, timeframe);
          return { ok: true, posts, used: oauthUrl };
        }
      } catch (e) {
        if (String(e.message).includes('timeout')) return { ok: false, timeout: true };
        // continue to fallbacks
      }
    }

    // 1) JSON endpoints (non-OAuth)
    const jsonEndpoints = [
      `https://api.reddit.com/r/${canonical}/top?t=${encodeURIComponent(timeframe)}&limit=25&raw_json=1`,
      `https://www.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=25&raw_json=1`,
      `https://old.reddit.com/r/${canonical}/top.json?t=${encodeURIComponent(timeframe)}&limit=25`
    ];
    for (const url of jsonEndpoints) {
      try {
        const { status, json, retryAfter } = await fetchJson(url);
        if (status === 429) return { ok: false, rateLimited: true, retryAfter: retryAfter || 30 };
        if (status === 200 && json?.data?.children?.length) {
          const posts = json.data.children.slice(0, 5).map(p => ({
            title: p.data.title,
            score: p.data.score,
            author: p.data.author,
            url: p.data.url,
            permalink: `https://reddit.com${p.data.permalink}`,
            created: p.data.created_utc,
            num_comments: p.data.num_comments,
            source: 'json'
          }));
          setCached(key, posts, timeframe);
          return { ok: true, posts, used: url };
        }
      } catch (e) {
        if (String(e.message).includes('timeout')) return { ok: false, timeout: true };
      }
    }

    // 2) RSS fallback
    try {
      const rssUrl = `https://www.reddit.com/r/${canonical}/top/.rss?t=${encodeURIComponent(timeframe)}`;
      const rssRes = await fetchText(rssUrl);
      if (rssRes.status === 429) return { ok: false, rateLimited: true, retryAfter: rssRes.retryAfter || 30 };
      if (rssRes.status === 200 && /<(entry|item)\b/i.test(rssRes.text)) {
        const entries = [...rssRes.text.matchAll(/<entry>[\s\S]*?<\/entry>/g)].slice(0, 5);
        const posts = entries.map(e => {
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
        setCached(key, posts, timeframe);
        return { ok: true, posts, used: rssUrl };
      }
    } catch (e) {
      if (String(e.message).includes('timeout')) return { ok: false, timeout: true };
    }

    // 3) HTML (old.reddit.com) fallback
    try {
      const htmlUrl = `https://old.reddit.com/r/${canonical}/top/?t=${encodeURIComponent(timeframe)}`;
      const htmlRes = await fetchText(htmlUrl);
      if (htmlRes.status === 429) return { ok: false, rateLimited: true, retryAfter: htmlRes.retryAfter || 30 };
      if (htmlRes.status === 200) {
        const posts = parseTopFromOldRedditHTML(htmlRes.text, 5);
        if (posts.length) {
          setCached(key, posts, timeframe);
          return { ok: true, posts, used: htmlUrl };
        }
      }
    } catch (e) {
      if (String(e.message).includes('timeout')) return { ok: false, timeout: true };
    }

    return { ok: false };
  })();

  PENDING.set(key, run);
  try {
    const out = await run;
    if (out.ok && out.posts) setCached(key, out.posts, timeframe);
    return out;
  } finally {
    PENDING.delete(key);
  }
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
    const fetched = await fetchPosts(info.canonical, timeframe);

    if (!fetched.ok) {
      if (fetched.rateLimited) {
        return res.status(429).json({
          error: 'Reddit is rate limiting us right now.',
          canonical: info.canonical,
          retryAfter: fetched.retryAfter || 30,
          code: 'RATE_LIMIT'
        });
      }
      if (fetched.timeout) {
        return res.status(504).json({
          error: 'Request to Reddit timed out.',
          canonical: info.canonical,
          retryAfter: 20,
          code: 'TIMEOUT'
        });
      }
      return res.status(503).json({
        error: `r/${info.canonical} is not readable from this server right now.`,
        canonical: info.canonical,
        code: 'UNAVAILABLE'
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
