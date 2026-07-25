// auth.js

const AUTH_API_BASE = 'http://localhost:8080/api/auth';
const ACTIVITY_API_BASE = 'http://localhost:8080/api/activity';
const TOKEN_KEY = 'csci1100_auth_token';

let heartbeatInterval = null;
let currentUsername = null;
let isLoggedIn = false;

// ---------- token 存取 ----------
function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
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

// ---------- 欢迎提示：登录成功那一刻弹出，几秒后自动消失 ----------
function showWelcomeToast(username) {
    const toast = document.createElement('div');
    toast.className = 'welcome-toast';
    toast.textContent = `Welcome back, ${username}!`;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('welcome-toast-hide');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 2800);
}

// ---------- 登录邀请横幅：未登录时显示，点按钮打开登录框；登录后隐藏 ----------
const ctaBanner = document.getElementById('cta-banner');
const ctaLoginBtn = document.getElementById('cta-login-btn');

if (ctaLoginBtn) {
    ctaLoginBtn.addEventListener('click', () => openAuthModal('login'));
}

function updateCtaBannerVisibility() {
    if (!ctaBanner) return;
    ctaBanner.classList.toggle('hidden', isLoggedIn);
}

// ---------- Profile 导航链接：未登录点了弹登录框，登录了点了跳转 Profile 页 ----------
const profileNavLink = document.getElementById('profile-nav-link');

if (profileNavLink) {
    profileNavLink.addEventListener('click', (e) => {
        e.preventDefault();
        if (isLoggedIn) {
            window.location.href = '../1. Profile Page/profile.html';
        } else {
            openAuthModal('login');
        }
    });
}

// ---------- 登录状态检查（页面加载时跑一次，只更新内部状态，不弹欢迎提示） ----------
async function checkAuthStatus() {
    const token = getToken();
    if (!token) {
        isLoggedIn = false;
        updateCtaBannerVisibility();
        return;
    }

    try {
        const response = await fetch(`${AUTH_API_BASE}/me`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error('Invalid session');

        const data = await response.json();
        isLoggedIn = true;
        currentUsername = data.username;
        startHeartbeat();
        updateCtaBannerVisibility();
    } catch (error) {
        clearToken();
        isLoggedIn = false;
        updateCtaBannerVisibility();
    }
}

// ---------- 在线时长心跳：每 30 秒发一次，只在登录 + 页面在前台时发 ----------
function startHeartbeat() {
    stopHeartbeat();
    heartbeatInterval = setInterval(() => {
        if (document.visibilityState !== 'visible') return;

        const token = getToken();
        if (!token) return;

        fetch(`${ACTIVITY_API_BASE}/heartbeat`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        })
            .then(async res => {
                if (!res.ok) {
                    console.error('Heartbeat rejected, stopping.');
                    stopHeartbeat();
                    clearToken();
                    isLoggedIn = false;
                    return;
                }
                // 这个页面没有常驻的在线时长展示，静默记录就行（Profile 页面自己会去拉最新数据）
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

// ---------- 弹窗控制 ----------
const modalOverlay = document.getElementById('auth-modal-overlay');

function openAuthModal(view) {
    modalOverlay.classList.add('show');
    switchAuthView(view);
}

function closeAuthModal() {
    modalOverlay.classList.remove('show');
}

function switchAuthView(view) {
    document.querySelectorAll('.auth-view').forEach(el => el.classList.remove('active'));
    document.getElementById(`auth-view-${view}`).classList.add('active');
    document.querySelectorAll('.auth-message').forEach(el => el.remove());
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
}

document.getElementById('auth-modal-close').addEventListener('click', closeAuthModal);
modalOverlay.addEventListener('click', (e) => {
    if (e.target === modalOverlay) closeAuthModal();
});

document.querySelectorAll('[data-switch-view]').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        switchAuthView(link.dataset.switchView);
    });
});

function showAuthMessage(viewId, message, isError) {
    const view = document.getElementById(viewId);
    const existing = view.querySelector('.auth-message');
    if (existing) existing.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'auth-message ' + (isError ? 'error' : 'success');
    msgEl.textContent = message;
    view.insertBefore(msgEl, view.firstChild);
}

// 校验一组必填字段：没填的直接描红，不弹浏览器原生提示。返回 true/false 表示是否通过
function validateRequired(fields) {
    let isValid = true;
    fields.forEach(field => {
        if (!field.value.trim()) {
            field.classList.add('input-error');
            isValid = false;
        } else {
            field.classList.remove('input-error');
        }
    });
    return isValid;
}

// 输入时自动清除描红
['login-identifier', 'login-password', 'register-username', 'register-email',
 'register-password', 'register-confirm-password', 'forgot-email'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', () => el.classList.remove('input-error'));
});

// ---------- 登录 ----------
document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const identifierInput = document.getElementById('login-identifier');
    const passwordInput = document.getElementById('login-password');
    if (!validateRequired([identifierInput, passwordInput])) return;

    const usernameOrEmail = identifierInput.value.trim();
    const password = passwordInput.value;

    try {
        const response = await fetch(`${AUTH_API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usernameOrEmail, password })
        });
        const data = await response.json();

        if (!response.ok) {
            showAuthMessage('auth-view-login', data.error || 'Login failed.', true);

            if (response.status === 403) {
                const view = document.getElementById('auth-view-login');
                const resendBtn = document.createElement('button');
                resendBtn.type = 'button';
                resendBtn.textContent = 'Resend verification email';
                resendBtn.style.cssText = 'width:100%; margin-top:8px; padding:9px; border:1px solid var(--divider-color); border-radius:8px; background:#fff; cursor:pointer; font-size:0.85rem;';
                resendBtn.addEventListener('click', async () => {
                    resendBtn.disabled = true;
                    resendBtn.textContent = 'Sending...';
                    try {
                        const resendResponse = await fetch(`${AUTH_API_BASE}/resend-verification`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ email: usernameOrEmail })
                        });
                        const resendData = await resendResponse.json();
                        showAuthMessage('auth-view-login', resendData.message || resendData.error, !resendResponse.ok);
                    } catch (err) {
                        showAuthMessage('auth-view-login', 'Failed to resend. Please try again.', true);
                    }
                    resendBtn.remove();
                });
                view.querySelector('.auth-message').insertAdjacentElement('afterend', resendBtn);
            }
            return;
        }

        setToken(data.token);
        closeAuthModal();
        isLoggedIn = true;
        currentUsername = data.username;
        startHeartbeat();
        updateCtaBannerVisibility();
        showWelcomeToast(data.username);
        document.getElementById('login-form').reset();
    } catch (error) {
        showAuthMessage('auth-view-login', 'Something went wrong. Please try again.', true);
    }
});

// ---------- 注册 ----------
document.getElementById('register-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const usernameInput = document.getElementById('register-username');
    const emailInput = document.getElementById('register-email');
    const passwordInput = document.getElementById('register-password');
    const confirmPasswordInput = document.getElementById('register-confirm-password');
    if (!validateRequired([usernameInput, emailInput, passwordInput, confirmPasswordInput])) return;

    const username = usernameInput.value.trim();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (password !== confirmPassword) {
        confirmPasswordInput.classList.add('input-error');
        showAuthMessage('auth-view-register', 'Passwords do not match.', true);
        return;
    }
    confirmPasswordInput.classList.remove('input-error');

    try {
        const response = await fetch(`${AUTH_API_BASE}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        const data = await response.json();

        if (!response.ok) {
            showAuthMessage('auth-view-register', data.error || 'Registration failed.', true);
            return;
        }

        showAuthMessage('auth-view-register', data.message, false);
        document.getElementById('register-form').reset();
    } catch (error) {
        showAuthMessage('auth-view-register', 'Something went wrong. Please try again.', true);
    }
});

// ---------- 忘记密码 ----------
document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const emailInput = document.getElementById('forgot-email');
    if (!validateRequired([emailInput])) return;

    const email = emailInput.value.trim();

    try {
        const response = await fetch(`${AUTH_API_BASE}/forgot-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await response.json();
        showAuthMessage('auth-view-forgot', data.message || 'If that email is registered, a reset link has been sent.', false);
        document.getElementById('forgot-password-form').reset();
    } catch (error) {
        showAuthMessage('auth-view-forgot', 'Something went wrong. Please try again.', true);
    }
});

// ---------- 初始化 ----------
checkAuthStatus();

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getToken()) {
        checkAuthStatus();
    }
});