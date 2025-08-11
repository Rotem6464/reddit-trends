// public/script.js
const form = document.getElementById('search-form');
const input = document.getElementById('subreddit-input');
const timeframeSel = document.getElementById('timeframe');
const results = document.getElementById('results');
const statusEl = document.getElementById('status');

function setStatus(msg) {
  statusEl.textContent = msg || '';
}
function renderPosts(items) {
  results.innerHTML = '';
  if (!items || !items.length) {
    results.innerHTML = '<li>No posts found.</li>';
    return;
  }
  // cap to top 5 for the UI
  const top = items.slice(0, 5);
  for (const p of top) {
    const li = document.createElement('li');

    const a = document.createElement('a');
    a.href = p.permalink || p.url || '#';
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = p.title || '(no title)';
    li.appendChild(a);

    const metaBits = [];
    if (p.author) metaBits.push(`u/${p.author}`);
    if (Number.isFinite(p.score)) metaBits.push(`score ${p.score}`);
    if (Number.isFinite(p.num_comments)) metaBits.push(`${p.num_comments} comments`);

    if (metaBits.length) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = metaBits.join(' • ');
      li.appendChild(meta);
    }

    results.appendChild(li);
  }
}

async function resolveCanonical(name) {
  const res = await fetch(`/api/resolve/${encodeURIComponent(name)}`, { credentials: 'omit' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.reason || `resolve failed: ${res.status}`);
  }
  return res.json();
}

async function fetchTrending(canonical, timeframe) {
  const res = await fetch(`/api/trending/${encodeURIComponent(canonical)}?timeframe=${encodeURIComponent(timeframe)}`, { credentials: 'omit' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const errMsg = j?.error || `trending failed: ${res.status}`;
    throw new Error(errMsg);
  }
  return res.json();
}

// IMPORTANT: no auto-load on page open.
// Only run when user submits the form.
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('');
  results.innerHTML = '';

  const raw = input.value.trim().replace(/^r\//i, '');
  const timeframe = timeframeSel?.value || 'day';
  if (!raw) return;

  try {
    setStatus('Resolving subreddit…');
    const info = await resolveCanonical(raw);

    // Show users the canonical casing for clarity
    input.value = info.canonical;

    setStatus(`Fetching ${timeframe} posts from r/${info.canonical}…`);
    const posts = await fetchTrending(info.canonical, timeframe);

    renderPosts(posts);
    setStatus(`Showing top 5 from r/${info.canonical}`);
  } catch (err) {
    setStatus(err.message);
    results.innerHTML = `<li class="error">${err.message}</li>`;
  }
});
