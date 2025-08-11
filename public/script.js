document.addEventListener('DOMContentLoaded', function() {
    const subredditInput = document.getElementById('subredditInput');
    const timeframeSelect = document.getElementById('timeframeSelect');
    const searchBtn = document.getElementById('searchBtn');
    const loading = document.getElementById('loading');
    const results = document.getElementById('results');
    
    const emailInput = document.getElementById('emailInput');
    const subscribeBtn = document.getElementById('subscribeBtn');
    const subscribeMessage = document.getElementById('subscribeMessage');

    searchBtn.addEventListener('click', fetchTrendingPosts);
    subscribeBtn.addEventListener('click', subscribeToUpdates);
    
    subredditInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            fetchTrendingPosts();
        }
    });

    // Load default subreddit on page load
    fetchTrendingPosts();

    async function fetchTrendingPosts() {
        const subreddit = subredditInput.value.trim();
        const timeframe = timeframeSelect.value;

        if (!subreddit) {
            alert('Please enter a subreddit name');
            return;
        }

        loading.style.display = 'block';
        results.innerHTML = '';
        searchBtn.disabled = true;
        searchBtn.textContent = 'Loading...';

        try {
            const response = await fetch(`/api/trending/${subreddit}?timeframe=${timeframe}`);
            const posts = await response.json();

            if (!response.ok) {
                throw new Error(posts.error || 'Failed to fetch posts');
            }

            displayPosts(posts);
        } catch (error) {
            results.innerHTML = `<div style="color: white; text-align: center; padding: 20px;">
                Error: ${error.message}
            </div>`;
        } finally {
            loading.style.display = 'none';
            searchBtn.disabled = false;
            searchBtn.textContent = 'Get Trending Posts';
        }
    }

    async function subscribeToUpdates() {
        const email = emailInput.value.trim();
        const subreddit = subredditInput.value.trim();
        const timeframe = timeframeSelect.value;

        if (!email) {
            showSubscribeMessage('Please enter your email address', 'error');
            return;
        }

        if (!subreddit) {
            showSubscribeMessage('Please enter a subreddit name first', 'error');
            return;
        }

        subscribeBtn.disabled = true;
        subscribeBtn.textContent = 'Subscribing...';

        try {
            const response = await fetch('/api/subscribe', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    email: email,
                    subreddit: subreddit,
                    timeframe: timeframe
                })
            });

            const result = await response.json();

            if (!response.ok) {
                throw new Error(result.error || 'Failed to subscribe');
            }

            showSubscribeMessage(`Successfully subscribed to r/${subreddit}!`, 'success');
            emailInput.value = '';
        } catch (error) {
            showSubscribeMessage(`Error: ${error.message}`, 'error');
        } finally {
            subscribeBtn.disabled = false;
            subscribeBtn.textContent = 'Subscribe';
        }
    }

    function showSubscribeMessage(message, type) {
        subscribeMessage.textContent = message;
        subscribeMessage.className = `subscribe-message ${type}`;
        subscribeMessage.style.display = 'block';
        
        setTimeout(() => {
            subscribeMessage.style.display = 'none';
        }, 5000);
    }

    function displayPosts(posts) {
        if (posts.length === 0) {
            results.innerHTML = '<div style="color: white; text-align: center;">No posts found</div>';
            return;
        }

        results.innerHTML = posts.map(post => `
            <div class="post">
                <a href="${post.permalink}" target="_blank" class="post-title">
                    ${post.title}
                </a>
                <div class="post-meta">
                    <span class="score">↑ ${post.score}</span>
                    <span>💬 ${post.num_comments} comments</span>
                    <span>👤 u/${post.author}</span>
                    <span>🕒 ${formatTime(post.created)}</span>
                </div>
            </div>
        `).join('');
    }

    function formatTime(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        
        if (days === 0) return 'Today';
        if (days === 1) return '1 day ago';
        return `${days} days ago`;
    }
});
