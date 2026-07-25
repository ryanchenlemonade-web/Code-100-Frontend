// heartbeat.js
// 精简版：这个页面不显示登录/注册 UI（那些都在主页 home_page.html），
// 这里只负责：如果本地已经登录（localStorage 里有 token），就悄悄按心跳记录在线时长。
// 登录状态是跨页面共享的（同一个域名/端口下 localStorage 通用），
// 所以只要用户在主页登录过，来到这个页面就会自动开始计时，不需要重新登录。

const TOKEN_KEY = 'csci1100_auth_token';
const ACTIVITY_API_BASE = 'http://localhost:8080/api/activity';

let heartbeatInterval = null;

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

// 每 30 秒发一次心跳，只在登录 + 页面在前台时发
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
                    // token 失效了（过期/被篡改），停止心跳、清掉本地登录状态
                    console.error('Heartbeat rejected, stopping.');
                    stopHeartbeat();
                    clearToken();
                    return;
                }
                // 这个页面没有登录组件可以更新，静默记录就行
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

// 页面加载时，如果本地已经登录，就悄悄开始记录在线时长
if (getToken()) {
    startHeartbeat();
}

// 页面从后台切回前台时，重新确认一下（比如刚才 token 过期了，避免继续无意义地发请求）
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getToken()) {
        startHeartbeat();
    }
});