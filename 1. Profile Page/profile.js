// profile.js

const AUTH_API_BASE = 'http://localhost:8080/api/auth';
const ACTIVITY_API_BASE = 'http://localhost:8080/api/activity';
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
    } catch (error) {
        console.error('Failed to load profile:', error);
        notLoggedInState.style.display = 'block';
    }
}

document.getElementById('logout-btn').addEventListener('click', () => {
    clearToken();
    window.location.href = '../1. Home Page/home_page.html';
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