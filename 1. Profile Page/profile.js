// profile.js

const AUTH_API_BASE = APP_API_BASE + '/api/auth';
const ACTIVITY_API_BASE = APP_API_BASE + '/api/activity';
const PROGRESS_API_BASE = APP_API_BASE + '/api/progress';
const TOKEN_KEY = 'csci1100_auth_token';

// 圆环进度条的周长（跟 profile.css 里 stroke-dasharray 的数值要对上：2 * π * 34 ≈ 213.6）
const PROGRESS_RING_CIRCUMFERENCE = 213.6;

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

        profileContent.style.display = 'block';
        startHeartbeat();
        loadPracticeProgress(token);
        loadDailySummary(token);
    } catch (error) {
        console.error('Failed to load profile:', error);
        notLoggedInState.style.display = 'block';
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

        const ring = document.getElementById('practice-progress-ring');
        const percentText = document.getElementById('practice-progress-percent');
        const hintText = document.querySelector('.stat-cell-ring-text .stat-cell-hint');

        if (ring) {
            const offset = PROGRESS_RING_CIRCUMFERENCE * (1 - percent / 100);
            ring.style.strokeDashoffset = offset;
        }
        if (percentText) percentText.textContent = `${percent}%`;
        if (hintText) hintText.textContent = `${completed} of ${total} tests \u2014 ${completed === 0 ? 'start practicing!' : 'keep it up!'}`;
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