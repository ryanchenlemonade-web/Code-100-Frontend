// auth.js
//
// 现在是全站共用的登录/注册逻辑文件，放在 "0. Shared/" 下面，跟 config.js 一样任何页面都能引用。
// 想让某个页面（现有的或者以后新加的）拥有登录/注册功能，只需要三步：
//   1. <link> 引入 auth.css（也在 0. Shared/ 下面）
//   2. <script> 引入这个文件（放在 config.js 之后）
//   3. 页面里放一个 <div id="auth-modal-container"></div>，然后在页面自己的 JS 里
//      fetch 一下 0. Shared/auth-modal.html 塞进这个 div，塞完之后调用 window.initAuthModal()
//      （具体写法可以照抄 cs1_index.js 里 footer 那段 fetch 的写法）
// 首页 home_page.html 是唯一例外：弹窗内容直接写死在 HTML 里，脚本加载时就已经存在于 DOM，
// 所以下面会自动检测到、立刻初始化，不需要走 fetch 那一步。
//
// 没有登录的时候，首页会显示那个大横幅（cta-banner，写死在 home_page.html 里）；
// 其他所有页面（比如 CS1 页面）没有这个大横幅，auth.js 会自动在右上角插入一个缩小版的提示条。

const AUTH_API_BASE = APP_API_BASE + '/api/auth';
const ACTIVITY_API_BASE = APP_API_BASE + '/api/activity';
const TOKEN_KEY = 'csci1100_auth_token';

let heartbeatInterval = null;
let currentUsername = null;
let isLoggedIn = false;
let modalInitialized = false;

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

// ---------- 通用小提示条：显示一段文字，几秒后自动消失 ----------
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'welcome-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('welcome-toast-hide');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 2800);
}

// ---------- 欢迎提示：登录成功那一刻弹出，几秒后自动消失 ----------
function showWelcomeToast(username) {
    showToast(`Welcome back, ${username}!`);
}

// ---------- 登录邀请横幅（首页专用的大版本）----------
const ctaBanner = document.getElementById('cta-banner');
const ctaLoginBtn = document.getElementById('cta-login-btn');

if (ctaLoginBtn) {
    ctaLoginBtn.addEventListener('click', () => openAuthModal('login'));
}

// ---------- 右上角迷你登录提示条（首页以外的所有页面自动出现，缩小版）----------
let miniAuthBanner = null;

function renderMiniAuthBanner() {
    // 首页已经有那个大横幅了（ctaBanner 存在），不需要再叠加一个迷你版，直接跳过
    if (ctaBanner) return;

    if (!miniAuthBanner) {
        miniAuthBanner = document.createElement('div');
        miniAuthBanner.id = 'mini-auth-banner';
        miniAuthBanner.innerHTML =
            '<span class="mini-auth-text">New here?</span>' +
            '<button type="button" class="mini-auth-btn">Log In / Sign Up</button>';
        miniAuthBanner.querySelector('.mini-auth-btn').addEventListener('click', () => openAuthModal('login'));
        document.body.appendChild(miniAuthBanner);
    }

    miniAuthBanner.classList.toggle('hidden', isLoggedIn);
}

function updateCtaBannerVisibility() {
    if (ctaBanner) {
        ctaBanner.classList.toggle('hidden', isLoggedIn);
    }
    renderMiniAuthBanner();
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
// 注意：modalOverlay 不再是顶层 const 缓存起来，而是每次用的时候现查 DOM——
// 因为在首页以外的页面，modal 内容是异步 fetch 进来的，auth.js 这个脚本本身
// 执行的时候，modal 可能还没被塞进页面里，缓存下来的话会一直是 null。
function openAuthModal(view) {
    const modalOverlay = document.getElementById('auth-modal-overlay');
    if (!modalOverlay) return;
    modalOverlay.classList.add('show');
    switchAuthView(view);
}

function closeAuthModal() {
    const modalOverlay = document.getElementById('auth-modal-overlay');
    if (modalOverlay) modalOverlay.classList.remove('show');
}

function switchAuthView(view) {
    document.querySelectorAll('.auth-view').forEach(el => el.classList.remove('active'));
    const target = document.getElementById(`auth-view-${view}`);
    if (target) target.classList.add('active');
    document.querySelectorAll('.auth-message').forEach(el => el.remove());
    document.querySelectorAll('.input-error').forEach(el => el.classList.remove('input-error'));
}

function showAuthMessage(viewId, message, isError) {
    const view = document.getElementById(viewId);
    if (!view) return;
    const existing = view.querySelector('.auth-message');
    if (existing) existing.remove();

    const msgEl = document.createElement('div');
    msgEl.className = 'auth-message ' + (isError ? 'error' : 'success');
    msgEl.textContent = message;
    view.insertBefore(msgEl, view.firstChild);
}

// 给表单的提交按钮设置"加载中"状态：禁用按钮 + 换文案，避免用户以为卡住了。
// 返回一个 restore() 函数，请求结束（不管成功/失败）后调用它恢复按钮原状。
function setFormLoading(form, loadingText) {
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) return () => {};
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = loadingText;
    return () => {
        btn.disabled = false;
        btn.textContent = originalText;
    };
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

// ---------- 密码显示/隐藏切换 ----------
function setupPasswordToggle(inputId, toggleBtnId) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(toggleBtnId);
    if (!input || !btn) return;

    const icon = btn.querySelector('i');

    btn.addEventListener('click', () => {
        const isHidden = input.type === 'password';
        input.type = isHidden ? 'text' : 'password';
        if (icon) {
            icon.classList.toggle('fa-eye', !isHidden);
            icon.classList.toggle('fa-eye-slash', isHidden);
        }
        btn.setAttribute('aria-label', isHidden ? 'Hide password' : 'Show password');
    });
}

// ---------- 所有依赖"modal HTML 已经真的插入 DOM"的绑定逻辑，都放在这个函数里 ----------
// 首页会在脚本加载时立刻调用（因为 modal 是写死的静态 HTML，早就在 DOM 里了）；
// 其他页面会在 fetch 完 auth-modal.html、把内容塞进容器之后，手动调用 window.initAuthModal()
function initAuthModal() {
    if (modalInitialized) return;
    const modalOverlay = document.getElementById('auth-modal-overlay');
    if (!modalOverlay) return;
    modalInitialized = true;

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

        const restoreBtn = setFormLoading(e.target, 'Logging in...');

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

                    // 先移除已存在的 resend 按钮（无论它是否正在 Sending 中），避免重复插入
                    const existingResendBtn = view.querySelector('.resend-verification-btn');
                    if (existingResendBtn) existingResendBtn.remove();

                    const resendBtn = document.createElement('button');
                    resendBtn.type = 'button';
                    resendBtn.className = 'resend-verification-btn';
                    resendBtn.textContent = 'Resend verification email';
                    resendBtn.style.cssText = 'width:100%; margin-top:-8px; margin-bottom:12px; padding:9px; border:1px solid var(--divider-color); border-radius:8px; background:#fff; cursor:pointer; font-size:0.85rem;';
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
                        } finally {
                            resendBtn.remove();
                        }
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
        } finally {
            restoreBtn();
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

        const restoreBtn = setFormLoading(e.target, 'Signing up...');

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
        } finally {
            restoreBtn();
        }
    });

    // ---------- 忘记密码 ----------
    document.getElementById('forgot-password-form').addEventListener('submit', async (e) => {
        e.preventDefault();

        const emailInput = document.getElementById('forgot-email');
        if (!validateRequired([emailInput])) return;

        const email = emailInput.value.trim();

        const restoreBtn = setFormLoading(e.target, 'Sending...');

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
        } finally {
            restoreBtn();
        }
    });

    setupPasswordToggle('login-password', 'toggle-login-password');
    setupPasswordToggle('register-password', 'toggle-register-password');
    setupPasswordToggle('register-confirm-password', 'toggle-register-confirm-password');
}

// 暴露给别的页面调用：它们 fetch 完 auth-modal.html、塞进容器之后，会调用这个函数完成初始化
window.initAuthModal = initAuthModal;

// 首页的 modal 是写死在 HTML 里的，脚本执行时已经存在于 DOM，这里自动检测、立刻初始化
if (document.getElementById('auth-modal-overlay')) {
    initAuthModal();
}

// ---------- 跨标签页通知：另一个标签页（邮件里点开的验证页）验证成功后，
// 会往 localStorage 写一个信号，这个页面（原来注册/登录的那个标签页）监听到之后，
// 自动弹提示、并把登录框切到"登录"视图，不需要用户自己切回来手动操作。 ----------
window.addEventListener('storage', (e) => {
    if (e.key !== 'email_verified_signal' || !e.newValue) return;

    showToast('Email verified! You can now log in.');

    // 如果登录框这时候是打开的（比如用户刚提交完注册、正开着等邮件），
    // 顺手帮它切到登录视图，省得用户自己点
    const modalOverlay = document.getElementById('auth-modal-overlay');
    if (modalOverlay && modalOverlay.classList.contains('show')) {
        switchAuthView('login');
    }
});

// ---------- 初始化 ----------
checkAuthStatus();

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getToken()) {
        checkAuthStatus();
    }
});