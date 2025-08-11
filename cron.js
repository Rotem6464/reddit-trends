// cron.js — send daily/weekly digests to confirmed subscribers
const fetch = require('node-fetch');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');

const {
  DATABASE_URL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  FROM_EMAIL,
  BASE_URL
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL missing');
if (!BASE_URL) throw new Error('BASE_URL missing (needed to call /api/trending)');

// ----- DB -----
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('render.com') ? { rejectUnauthorized: false } : undefined
});

// ----- Mailer -----
let transporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS && FROM_EMAIL) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn('⚠️ SMTP not fully configured. Emails will be logged only.');
}
async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`\n[EMAIL LOG] To: ${to}\nSubject: ${subject}\n${text || html}\n`);
    return;
  }
  await transporter.sendMail({ from: FROM_EMAIL, to, subject, html, text });
}

// ----- Helpers -----
function escapeHtml(s) {
  return (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function nowUtc() { return new Date(); }
function hoursSince(d) { return (nowUtc() - new Date(d)) / 36e5; }
function isWeeklySendWindow() {
  // Send weekly on Monday 08:00 Asia/Jerusalem (UTC+3 in summer, +2 in winter).
  // The cron schedule will trigger at the right UTC; this is a guard if run off-schedule.
  const d = new Date();
  const day = d.getUTCDay(); // 1 = Monday
  return day === 1;
}

// Per-run cache so multiple subscribers to the same sub/timeframe don’t refetch
const runCache = new Map(); // key -> posts[]
async function getTopPosts(subreddit, timeframe) {
  const key = `${subreddit.toLowerCase()}:${timeframe}`;
  if (runCache.has(key)) return runCache.get(key);

  const url = `${BASE_URL.replace(/\/$/,'')}/api/trending/${encodeURIComponent(subreddit)}?timeframe=${encodeURIComponent(timeframe)}`;
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });

  if (res.status === 429) {
    const j = await res.json().catch(()=> ({}));
    throw new Error(`rate_limited: wait ~${j.retryAfter || 30}s`);
  }
  if (res.status === 504) throw new Error('timeout');
  if (!res.ok) {
    const j = await res.json().catch(()=> ({}));
    throw new Error(j?.error || `unavailable (${res.status})`);
  }

  const posts = await res.json();
  runCache.set(key, posts);
  return posts;
}

(async () => {
  console.log('Cron started…');
  const client = await pool.connect();
  try {
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

    const { rows } = await client.query(`
      SELECT id, email, subreddit, timeframe, last_sent
      FROM subscriptions
      WHERE confirmed = TRUE
    `);

    if (!rows.length) {
      console.log('No confirmed subscribers. Exiting.');
      return;
    }

    // Decide who is due
    const due = rows.filter(r => {
      if (r.timeframe === 'day') {
        return !r.last_sent || hoursSince(r.last_sent) >= 20; // be conservative
      }
      if (r.timeframe === 'week') {
        return isWeeklySendWindow() && (!r.last_sent || hoursSince(r.last_sent) >= 6.5 * 24);
      }
      return !r.last_sent || hoursSince(r.last_sent) >= 20;
    });

    if (!due.length) {
      console.log('Nobody due right now. Exiting.');
      return;
    }

    // Fetch posts per unique (sub,timeframe)
    const uniqueKeys = [...new Set(due.map(r => `${r.subreddit.toLowerCase()}:${r.timeframe}`))];
    const postsByKey = {};
    for (const key of uniqueKeys) {
      const [subreddit, timeframe] = key.split(':');
      try {
        const posts = await getTopPosts(subreddit, timeframe);
        postsByKey[key] = posts;
        console.log(`Fetched ${posts?.length || 0} for r/${subreddit} (${timeframe})`);
      } catch (e) {
        console.log(`Skip r/${subreddit} (${timeframe}) — ${e.message}`);
        postsByKey[key] = [];
      }
    }

    // Send emails
    for (const sub of due) {
      const key = `${sub.subreddit.toLowerCase()}:${sub.timeframe}`;
      const posts = postsByKey[key] || [];

      const top = (Array.isArray(posts) ? posts.slice(0,5) : []);
      const listHtml = top.length
        ? `<ol>${top.map(p => `<li><a href="${p.permalink || p.url}">${escapeHtml(p.title)}</a></li>`).join('')}</ol>`
        : `<p>No top posts found in the last ${sub.timeframe}.</p>`;

      const subject = `Top ${top.length || ''} from r/${sub.subreddit} (${sub.timeframe})`;
      const text = top.length
        ? top.map((p,i)=> `${i+1}. ${p.title}\n${p.permalink || p.url}`).join('\n\n')
        : `No top posts found in the last ${sub.timeframe}.`;

      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">
          <h2>r/${escapeHtml(sub.subreddit)} — ${escapeHtml(sub.timeframe)} digest</h2>
          ${listHtml}
          <p style="font-size:12px;color:#666">
            You’re receiving this because you subscribed to r/${escapeHtml(sub.subreddit)}.
            To change timeframe, resubscribe with a different option.
          </p>
        </div>`;

      try {
        await sendEmail({ to: sub.email, subject, html, text });
        await client.query('UPDATE subscriptions SET last_sent = NOW() WHERE id = $1', [sub.id]);
        console.log(`✔ Sent to ${sub.email} for r/${sub.subreddit} (${sub.timeframe})`);
      } catch (e) {
        console.error(`✖ Email failed to ${sub.email}: ${e.message}`);
      }
    }

    console.log('Cron done.');
  } catch (e) {
    console.error('Cron error:', e);
  } finally {
    client.release();
    await pool.end().catch(()=>{});
  }
})();
