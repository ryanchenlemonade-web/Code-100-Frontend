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