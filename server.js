const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== DB (leave as-is but safe) ==========
const db = new sqlite3.Database('subscriptions.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    subreddit TEXT,
    timeframe TEXT DEFAULT 'week',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`ALTER TABLE subscriptions ADD COLUMN confirmed BOOLEAN DEFAULT 0`, () => {});
  db.run(`ALTER TABLE subscriptions ADD COLUMN confirmation_token TEXT`, () => {});
});

// Serve a root index if you have one
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ========== Reddit request helpers ==========
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

// ========== HTML parsing (canonical + gating) ==========
function parseCanonicalFromHtml(html, fallback) {
  // 1) og:url
  const og = html.match(/property=["']og:url["'][^>]*content=["']https:\/\/(?:www|old)\.reddit\.com\/r\/([^\/"']+)\//i);
  if (og?.[1]) return og[1];

  // 2) <link rel="canonical">
  const link = html.match(/<link\s+rel=["']canonical["'][^>]*href=["']https:\/\/(?:www|old)\.reddit\.com\/r\/([^\/"']+)\//i);
  if (link?.[1]) return link[1];

  // 3) protected-community-modal (your snippet)
  const desc = html.match(/(?:subreddit-description|subredditDescription)=["']r\/([^"']+)["']/i);
  if (desc?.[1]) return desc[1];

  // 4) <title> r/Name
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

// ========== Resolver (HTML-first canonical; no premature "private") ==========
async function resolveSubreddit(input) {
  const raw = input.trim().replace(/^r\//i, '');

  // Try API first (often less strict than www)
  let a = await fetchJson(`https://api.reddit.com/r/${raw}/about`);
  if (a.status === 200 && a.json?.data) {
    const d = a.json.data;
    return {
      exists: true,
      canonical: d.display_name,
      url: `https://www.reddit.com${d.url}`,
      type: d.subreddit_type || 'public',
      httpStatus: 200,
      source: 'api.about'
    };
  }

  // Try www JSON if API didn’t give 403
  if (a.status !== 403) {
    a = await fetchJson(`https://www.reddit.com/r/${raw}/about.json`);
    if (a.status === 200 && a.json?.data) {
      const d = a.json.data;
      return {
        exists: true,
        canonical: d.display_name,
        url: `https://www.reddit.com${d.url}`,
        type: d.subreddit_type || 'public',
        httpStatus: 200,
        source: 'www.about'
      };
    }
  }

  // HTML on www and old → learn canonical & whether page shows a protected modal
  const h1 = await fetchText(`https://www.reddit.com/r/${raw}/`);
  const h2 = await fetchText(`https://old.reddit.com/r/${raw}/`);
  if (h1.status === 404 && h2.status === 404) {
    return { exists: false, reason: 'not_found', httpStatus: 404 };
  }
  const html = (h1.status === 200 ? h1.text : '') + '\n' + (h2.status === 200 ? h2.text : '');
  const canonical = parseCanonicalFromHtml(html || '', raw);
  const gated = htmlLooksProtected(html || '');

  // Do NOT conclude "private" here; we’ll try feeds first.
  return {
    exists: true,
    canonical,
    url: `https://www.reddit.com/r/${canonical}/`,
    type: gated ? 'maybe_gated' : 'unknown',
    httpStatus: gated ? 403 : 200,
    source: 'html'
  };
}

// ========== Fetch posts with multiple fallbacks ==========
function parseRedditAtom(xml) {
  const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)];
  return entries.map(e => {
    const block = e[0];
    const title = (block.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [,''])[1].trim();
    const link = (block.match(/<link[^>]*href="([^"]+)"/i) || [,''])[1];
    const updated = (block.match(/<updated>([^<]+)<\/updated>/i) || [,''])[1];
    const id = (block.match(/<id>([^<]+)<\/id>/i) || [,''])[1];
    const permalink = /\/comments\//.test(id) ? id : ( /\/comments\//.test(link) ? link : null );
    return {
      title,
      score: null,
      author: null,
      url: link || permalink || null,
      permalink,
      created: updated || null,
      num_comments: null
    };
  });
}

async function fetchPosts(canonical, timeframe) {
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
          num_comments: p.data.num_comments
        })),
        used: url
      };
    }
    // continue on 403/429/empty
  }

  // RSS last resort (works even when JSON is gated)
  const rssUrl = `https://www.reddit.com/r/${canonical}/top/.rss?t=${encodeURIComponent(timeframe)}`;
  const rssRes = await fetchText(rssUrl);
  if (rssRes.status === 200 && /<(entry|item)\b/i.test(rssRes.text)) {
    const posts = parseRedditAtom(rssRes.text);
    if (posts.length) return { ok: true, posts, used: rssUrl };
  }

  return { ok: false };
}

// ========== API: resolve first (good for the UI) ==========
app.get('/api/resolve/:subreddit', async (req, res) => {
  const info = await resolveSubreddit(req.params.subreddit);
  console.log('RESOLVE', req.params.subreddit, '→', info);
  if (!info.exists) return res.status(404).json(info);
  res.json(info);
});

// ========== API: trending with auto-canonicalization + fallbacks ==========
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
        error: `r/${info.canonical} is not readable via JSON from this server (blocked).`,
        canonical: info.canonical,
        hint: 'Client-side fetch or RSS/HTML scraping may still work.'
      });
    }

    console.log(`✅ Fetched ${fetched.posts.length} posts from r/${info.canonical} via ${fetched.used}`);
    res.json(fetched.posts);
  } catch (err) {
    console.log('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========== Subscriptions (unchanged) ==========
app.post('/api/subscribe', (req, res) => {
  const { email, subreddit, timeframe } = req.body;
  if (!email || !subreddit) return res.status(400).json({ error: 'Email and subreddit are required' });

  const confirmationToken = crypto.randomBytes(32).toString('hex');
  db.run(
    'INSERT OR REPLACE INTO subscriptions (email, subreddit, timeframe, confirmed, confirmation_token) VALUES (?, ?, ?, 0, ?)',
    [email, subreddit, timeframe || 'week', confirmationToken],
    function (err) {
      if (err) {
        console.log('Database error:', err);
        res.status(500).json({ error: 'Failed to subscribe' });
      } else {
        const confirmUrl = `http://localhost:${PORT}/api/confirm/${confirmationToken}`;
        console.log(`Confirmation link for ${email}: ${confirmUrl}`);
        res.json({ message: 'Please check your email to confirm subscription!', demoLink: confirmUrl });
      }
    }
  );
});

app.get('/api/confirm/:token', (req, res) => {
  const token = req.params.token;
  db.get('SELECT * FROM subscriptions WHERE confirmation_token = ?', [token], (err, row) => {
    if (err || !row) return res.send('<h1>Invalid confirmation link</h1>');
    db.run('UPDATE subscriptions SET confirmed = 1 WHERE confirmation_token = ?', [token], function (err2) {
      if (err2) return res.send('<h1>Error confirming subscription</h1>');
      res.send(`
        <h1>✅ Subscription Confirmed!</h1>
        <p>You will now receive daily updates with top posts from r/${row.subreddit}.</p>
        <p><a href="http://localhost:${PORT}">← Back to Reddit Trends</a></p>
      `);
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
