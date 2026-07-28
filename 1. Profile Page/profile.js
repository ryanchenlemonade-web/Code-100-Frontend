// profile.js

const AUTH_API_BASE = APP_API_BASE + '/api/auth';
const ACTIVITY_API_BASE = APP_API_BASE + '/api/activity';
const PROGRESS_API_BASE = APP_API_BASE + '/api/progress';
const TOKEN_KEY = 'csci1100_auth_token';

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}
function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

function formatOnlineTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

function formatMemberSince(isoString) {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const notLoggedInState = document.getElementById('not-logged-in-state');
const profileContent = document.getElementById('profile-content');

// ---------- Badges：解锁条件全部来自已经在拉的三份真实数据，不用额外接口 ----------
// completedTests/totalTests 来自 loadPracticeProgress，streak 来自 loadDailySummary，
// rank 来自 loadLeaderboardRank——三个各自拉完数据后更新这个对象，再统一判断解锁状态
const badgeState = {
    completedTests: null,
    totalTests: null,
    streak: null,
    rank: null,
    totalOnlineSeconds: null
};

// 每个徽章的解锁条件写成一个函数，方便统计"一共解锁了几个"，以后加新徽章也只用往这个数组里加一项
const BADGE_DEFINITIONS = [
    { id: 'badge-first-steps', isUnlocked: () => badgeState.completedTests !== null && badgeState.completedTests >= 1 },
    { id: 'badge-on-fire', isUnlocked: () => badgeState.streak !== null && badgeState.streak >= 3 },
    { id: 'badge-test-ace', isUnlocked: () => badgeState.completedTests !== null && badgeState.totalTests !== null
        && badgeState.totalTests > 0 && badgeState.completedTests === badgeState.totalTests },
    { id: 'badge-top-10', isUnlocked: () => badgeState.rank !== null && badgeState.rank <= 10 },
    { id: 'badge-podium', isUnlocked: () => badgeState.rank !== null && badgeState.rank <= 3 },
    { id: 'badge-week-warrior', isUnlocked: () => badgeState.streak !== null && badgeState.streak >= 7 },
    { id: 'badge-marathon', isUnlocked: () => badgeState.totalOnlineSeconds !== null && badgeState.totalOnlineSeconds >= 36000 }
];

function updateBadges() {
    let earnedCount = 0;
    BADGE_DEFINITIONS.forEach(badge => {
        const unlocked = badge.isUnlocked();
        setBadgeUnlocked(badge.id, unlocked);
        if (unlocked) earnedCount++;
    });

    const countEl = document.getElementById('badges-count');
    if (countEl) countEl.textContent = `${earnedCount} out of ${BADGE_DEFINITIONS.length}`;
}

function setBadgeUnlocked(elementId, unlocked) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.classList.toggle('badge-locked', !unlocked);
    el.classList.toggle('badge-unlocked', unlocked);
}

// ---------- 徽章展馆左右滑动 ----------
const badgesRow = document.getElementById('badges-row');
const badgesNavLeft = document.getElementById('badges-nav-left');
const badgesNavRight = document.getElementById('badges-nav-right');

if (badgesRow && badgesNavLeft && badgesNavRight) {
    const SCROLL_AMOUNT = 300;
    badgesNavLeft.addEventListener('click', () => {
        badgesRow.scrollBy({ left: -SCROLL_AMOUNT, behavior: 'smooth' });
    });
    badgesNavRight.addEventListener('click', () => {
        badgesRow.scrollBy({ left: SCROLL_AMOUNT, behavior: 'smooth' });
    });
}

async function loadProfile() {
    const token = getToken();

    if (!token) {
        notLoggedInState.style.display = 'block';
        return;
    }

    try {
        const response = await fetch(`${AUTH_API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            clearToken();
            notLoggedInState.style.display = 'block';
            return;
        }

        const data = await response.json();

        document.getElementById('avatar-initial').textContent = data.username.charAt(0).toUpperCase();
        document.getElementById('profile-username').textContent = data.username;
        document.getElementById('profile-member-since').textContent = `Member since ${formatMemberSince(data.memberSince)}`;
        document.getElementById('online-time-value').textContent = formatOnlineTime(data.totalOnlineSeconds || 0);

        badgeState.totalOnlineSeconds = data.totalOnlineSeconds || 0;
        updateBadges();

        profileContent.style.display = 'block';
        startHeartbeat();
        loadPracticeProgress(token);
        loadDailySummary(token);
        loadLeaderboardRank(token);
    } catch (error) {
        console.error('Failed to load profile:', error);
        notLoggedInState.style.display = 'block';
    }
}

// ---------- Leaderboard Rank：真实排名，来自 /api/leaderboard 接口里算好的 "you" ----------
async function loadLeaderboardRank(token) {
    try {
        const response = await fetch(`${APP_API_BASE}/api/leaderboard`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return;

        const data = await response.json();
        const you = data.you;
        if (!you) return;

        const valueEl = document.getElementById('leaderboard-rank-value');
        const hintEl = document.getElementById('leaderboard-rank-hint');
        if (valueEl) {
            valueEl.textContent = `#${you.rank}`;
            valueEl.classList.remove('stat-cell-value-muted', 'rank-color-gold', 'rank-color-silver', 'rank-color-bronze');

            // 前三名各自专属颜色（金/银/铜），4名开外用默认的深色数字
            if (you.rank === 1) valueEl.classList.add('rank-color-gold');
            else if (you.rank === 2) valueEl.classList.add('rank-color-silver');
            else if (you.rank === 3) valueEl.classList.add('rank-color-bronze');
        }
        if (hintEl) hintEl.textContent = 'View full leaderboard \u2192';

        badgeState.rank = you.rank;
        updateBadges();
    } catch (error) {
        console.error('Failed to load leaderboard rank:', error);
    }
}

// ---------- Practice Progress：完成了几张卷子 / 系统里总共有多少张卷子 ----------
async function loadPracticeProgress(token) {
    try {
        const response = await fetch(`${PROGRESS_API_BASE}/summary`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return;

        const data = await response.json();
        const completed = data.completedTests || 0;
        const total = data.totalTests || 0;
        const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

        const fillEl = document.getElementById('practice-progress-fill');
        const percentText = document.getElementById('practice-progress-percent');
        const hintText = document.getElementById('practice-progress-hint');

        if (fillEl) fillEl.style.width = `${percent}%`;
        if (percentText) percentText.textContent = `${percent}%`;
        if (hintText) hintText.textContent = `${completed} of ${total} tests \u2014 ${completed === 0 ? 'start practicing!' : 'keep it up!'}`;

        badgeState.completedTests = completed;
        badgeState.totalTests = total;
        updateBadges();
    } catch (error) {
        console.error('Failed to load practice progress:', error);
    }
}

// ---------- Day Streak + Weekly Activity：都是靠按天记录的数据算出来的 ----------
async function loadDailySummary(token) {
    try {
        const response = await fetch(`${PROGRESS_API_BASE}/daily-summary`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) return;

        const data = await response.json();

        const streakEl = document.getElementById('streak-value');
        if (streakEl) streakEl.textContent = data.streak || 0;

        badgeState.streak = data.streak || 0;
        updateBadges();

        const streakHintEl = document.querySelector('.stat-icon-streak').closest('.stat-cell').querySelector('.stat-cell-hint');
        if (streakHintEl) {
            streakHintEl.textContent = (data.streak || 0) > 0
                ? 'Keep it going \u2014 practice today to continue your streak'
                : 'Practice today to start your streak';
        }

        const weekly = data.weekly || [];
        const maxSeconds = Math.max(...weekly.map(day => day.seconds), 60); // 至少按1分钟算，避免全是0时除0
        const totalWeeklySeconds = weekly.reduce((sum, day) => sum + (day.seconds || 0), 0);
        const chartEl = document.querySelector('.weekly-chart');
        const messageEl = document.getElementById('weekly-message');
        const weekdayClasses = ['weekly-bar-monday', 'weekly-bar-tuesday', 'weekly-bar-wednesday',
            'weekly-bar-thursday', 'weekly-bar-friday', 'weekly-bar-saturday', 'weekly-bar-sunday'];

        if (chartEl && weekly.length > 0) {
            const TRACK_HEIGHT_PX = 72; // 要跟 profile.css 里 .weekly-bar-track 的 height 保持一致
            const cols = chartEl.querySelectorAll('.weekly-bar-col');
            weekly.forEach((day, index) => {
                const col = cols[index];
                if (!col) return;
                const bar = col.querySelector('.weekly-bar');
                const heightPx = day.seconds > 0
                    ? Math.max((day.seconds / maxSeconds) * TRACK_HEIGHT_PX, 8)
                    : 0;

                // 每天固定一个颜色（周一到周日），后端 daily-summary 固定返回本周一到周日，
                // 所以 index 0 一定对应周一
                bar.className = `weekly-bar ${weekdayClasses[index] || ''}`;
                bar.style.height = `${heightPx}px`;
                bar.title = formatOnlineTime(day.seconds);

                const valueLabel = col.querySelector('.weekly-bar-value');
                if (valueLabel) valueLabel.textContent = day.seconds > 0 ? formatOnlineTime(day.seconds) : '';
            });
        }

        // 底部文案：根据这周真实学习总时长给一句话，不是死板的固定文案
        if (messageEl) {
            messageEl.textContent = totalWeeklySeconds > 0
                ? `You've studied ${formatOnlineTime(totalWeeklySeconds)} this week \u2014 keep the momentum going!`
                : 'No activity yet this week \u2014 jump into Practice to get started.';
        }
    } catch (error) {
        console.error('Failed to load daily summary:', error);
    }
}

document.getElementById('logout-btn').addEventListener('click', () => {
    clearToken();
    window.location.href = '../1. Home Page/home_page.html';
});

// ---------- 小提示条：Edit Profile 目前后端还没有对应的接口，先给个诚实的提示，
// 不能什么反应都没有让用户以为按钮坏了 ----------
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'profile-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('profile-toast-hide');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 2600);
}

document.getElementById('edit-profile-btn').addEventListener('click', () => {
    showToast('Profile editing is coming soon!');
});

// ---------- 在线时长心跳：Profile 页面自己也记录时间，并且每次心跳成功后实时刷新页面上显示的数字 ----------
let heartbeatInterval = null;

function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (document.visibilityState !== 'visible') return;

        const token = getToken();
        if (!token) {
            stopHeartbeat();
            return;
        }

        fetch(`${ACTIVITY_API_BASE}/heartbeat`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(async res => {
                if (!res.ok) {
                    stopHeartbeat();
                    clearToken();
                    return;
                }
                const data = await res.json();
                document.getElementById('online-time-value').textContent = formatOnlineTime(data.totalOnlineSeconds);
            })
            .catch(error => console.error('Heartbeat failed:', error));
    }, 30000);
}

function stopHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

loadProfile();

// footer
fetch('../0. Footer/footer.html')
    .then(res => res.text())
    .then(html => {
        const footerEl = document.getElementById('footer-container');
        footerEl.innerHTML = html;
    });