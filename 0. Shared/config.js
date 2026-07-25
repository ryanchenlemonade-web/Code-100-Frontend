// config.js
// 自动判断当前访问环境（本地 Live Server 还是线上 Netlify），
// 自动决定该连本地后端（localhost:8080）还是线上后端（Render）。
// 所有其他 JS 文件都通过 APP_API_BASE 这个全局变量来拼接接口地址，
// 不用再各自写死 localhost:8080，也不用每次上线前手动改地址。
//
// ⚠️ 这个文件必须在其他所有会用到 APP_API_BASE 的 <script> 标签之前加载。

(function () {
    const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    window.APP_API_BASE = isLocal
        ? 'http://localhost:8080'
        : 'https://code-100-backend.onrender.com';
})();