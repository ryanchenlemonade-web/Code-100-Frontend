// leaderboard.js

const AUTH_API_BASE = APP_API_BASE + '/api/auth';
const PROGRESS_API_BASE = APP_API_BASE + '/api/progress';
const LEADERBOARD_API_BASE = APP_API_BASE + '/api/leaderboard';
const TOKEN_KEY = 'csci1100_auth_token';

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function formatOnlineTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function initials(username) {
    return (username || '?').charAt(0).toUpperCase();
}

// ---------- 个人统计卡：登录了才有真实数据 ----------
async function loadPersonalStats() {
    const token = getToken();
    const statsGrid = document.getElementById('personal-stats');
    const loginPrompt = document.getElementById('login-prompt-card');

    if (!token) {
        statsGrid.style.display = 'none';
        loginPrompt.style.display = 'block';
        return null;
    }

    statsGrid.style.display = 'grid';
    loginPrompt.style.display = 'none';

    try {
        const meResponse = await fetch(`${AUTH_API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!meResponse.ok) {
            statsGrid.style.display = 'none';
            loginPrompt.style.display = 'block';
            return null;
        }
        const me = await meResponse.json();
        document.getElementById('stat-time-value').textContent = formatOnlineTime(me.totalOnlineSeconds || 0);

        // Streak 复用 Profile 页面同一个接口
        fetch(`${PROGRESS_API_BASE}/daily-summary`, {
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                if (data) document.getElementById('stat-streak-value').textContent = data.streak || 0;
            })
            .catch(() => {});

        return me.username;
    } catch (error) {
        console.error('Failed to load personal stats:', error);
        statsGrid.style.display = 'none';
        loginPrompt.style.display = 'block';
        return null;
    }
}

// ---------- 榜单本身：任何人都能看，登录了会额外算出"你自己的真实排名" ----------
async function loadLeaderboard(myUsername) {
    const token = getToken();
    const skeleton = document.getElementById('hub-skeleton');
    const podiumEl = document.getElementById('podium');
    const listCardEl = document.getElementById('leaderboard-list-card');
    const listEl = document.getElementById('leaderboard-list');
    const pinnedEl = document.getElementById('your-rank-pinned');
    const emptyEl = document.getElementById('hub-empty-state');
    const rankValueEl = document.getElementById('stat-rank-value');

    try {
        const headers = {};
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const response = await fetch(LEADERBOARD_API_BASE, { headers });
        if (!response.ok) throw new Error('Failed to load leaderboard');

        const data = await response.json();
        const entries = data.entries || [];
        const you = data.you || null;

        skeleton.style.display = 'none';

        if (you && rankValueEl) {
            rankValueEl.textContent = `#${you.rank}`;
        }

        if (entries.length === 0) {
            emptyEl.style.display = 'block';
            return;
        }

        const top3 = entries.slice(0, 3);
        const rest = entries.slice(3);

        // ---------- Top 3 领奖台 ----------
        podiumEl.style.display = 'flex';
        podiumEl.innerHTML = '';
        // 视觉顺序：第2名在左、第1名在中间最高、第3名在右，经典领奖台布局
        const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);
        podiumOrder.forEach(entry => {
            const isMe = myUsername && entry.username === myUsername;
            const tierClass = entry.rank === 1 ? 'podium-gold' : entry.rank === 2 ? 'podium-silver' : 'podium-bronze';
            const col = document.createElement('div');
            col.className = `podium-col ${tierClass}${isMe ? ' podium-col-me' : ''}`;
            col.innerHTML = `
                <div class="podium-rank-badge">${entry.rank}</div>
                <div class="podium-avatar">${initials(entry.username)}</div>
                <p class="podium-username">${entry.username}${isMe ? ' <span class="you-tag">You</span>' : ''}</p>
                <p class="podium-value">${formatOnlineTime(entry.totalOnlineSeconds)}</p>
            `;
            podiumEl.appendChild(col);
        });

        // ---------- 剩下的列表 ----------
        if (rest.length > 0) {
            listCardEl.style.display = 'block';
            listEl.innerHTML = '';
            rest.forEach(entry => {
                listEl.appendChild(buildListRow(entry, myUsername));
            });
        }

        // ---------- 如果你不在榜单可见范围内（前 50），单独钉一行显示真实排名 ----------
        const visibleUsernames = new Set(entries.map(e => e.username));
        if (you && !visibleUsernames.has(you.username)) {
            pinnedEl.style.display = 'block';
            pinnedEl.innerHTML = '';
            const pinnedRow = buildListRow(you, myUsername);
            pinnedRow.classList.add('pinned-row');
            pinnedEl.appendChild(pinnedRow);
        }
    } catch (error) {
        console.error('Failed to load leaderboard:', error);
        skeleton.style.display = 'none';
        emptyEl.style.display = 'block';
        document.querySelector('.hub-empty-title').textContent = 'Couldn\u2019t load the leaderboard';
        document.querySelector('.hub-empty-subtext').textContent = 'Please try refreshing the page.';
    }
}

function buildListRow(entry, myUsername) {
    const isMe = myUsername && entry.username === myUsername;
    const row = document.createElement('div');
    row.className = `leaderboard-row${isMe ? ' leaderboard-row-me' : ''}`;
    row.innerHTML = `
        <span class="row-rank">#${entry.rank}</span>
        <span class="row-avatar">${initials(entry.username)}</span>
        <span class="row-username">${entry.username}${isMe ? ' <span class="you-tag">You</span>' : ''}</span>
        <span class="row-value">${formatOnlineTime(entry.totalOnlineSeconds)}</span>
    `;
    return row;
}

(async function init() {
    const myUsername = await loadPersonalStats();
    loadLeaderboard(myUsername);
})();

// footer
fetch('../0.%20Footer/footer.html')
    .then(res => res.text())
    .then(html => {
        document.getElementById('footer-container').innerHTML = html;
    });

// 登录/注册/忘记密码 弹窗（共用片段，见 0. Shared/auth-modal.html）
fetch('../0.%20Shared/auth-modal.html')
    .then(res => res.text())
    .then(html => {
        document.getElementById('auth-modal-container').innerHTML = html;
        if (window.initAuthModal) window.initAuthModal();
    });