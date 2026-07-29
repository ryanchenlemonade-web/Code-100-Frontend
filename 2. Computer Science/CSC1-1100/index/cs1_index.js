// cs1_index.js

const items = document.querySelectorAll('.sidebar-item');

const navItems = document.querySelectorAll('.bar-items');
const sidebar = document.querySelector('.sidebar');
const navBar = document.querySelector('.nav-bar');
const footerContainer = document.getElementById('footer-container');

// 每个 Test 对应的颜色，跟navbar配色保持一致
// 侧边栏底色，按 Test 分类联动（绿 → 黄 → 橙 → 红，跟导航栏的色阶一致）。
// 用 CSS 变量而不是直接设 backgroundColor：背景的其他部分（透明度、边线）
// 归 CSS 管，这里只提供颜色，两边不打架。
// 亮度刻意定在 96%，比导航栏激活态（88-90%）明显淡一档。
// 两边同一档的话，侧边栏会跟导航栏抢注意力，而它只是背景
const sidebarTintMap = {
    'test1': 'hsl(140, 42%, 96%)',
    'test2': 'hsl(45, 80%, 96%)',
    'test3': 'hsl(28, 80%, 96%)',
    'final': 'hsl(0, 58%, 96.5%)'
};

function applySidebarTint(navId) {
    const tint = sidebarTintMap[navId];
    if (tint) sidebar.style.setProperty('--sidebar-tint', tint);
}

// nav 按钮 id 对应数据库里的 paper_category（必须跟 Test_Papers 表里的值完全一致）
// 以后新增分类（比如 Test 4），只需要在这里加一行映射即可，不需要新建任何文件
const navToCategory = {
    'test1': 'Test 1',
    'test2': 'Test 2',
    'test3': 'Test 3',
    'final': 'Final Test'
};

// 从后端拉回来的、按 paper_category 分组的所有试卷数据，例如：
// { "Test 1": [{id:1, paper_year:2020, paper_category:"Test 1"}, {id:2, paper_year:2019, ...}] }
let papersByCategory = {};

const contentContainer = document.getElementById('content-container');

// Revision 首页的两张卡片 + 两个子板块里的"返回"按钮，都靠这一个委托监听器处理。
// 用委托是因为切换 Test 分类时，骨架会通过 contentContainer.innerHTML 整个重新生成一份，
// 里面的按钮都是全新的 DOM 节点——如果直接绑在按钮本身，切一次 Test 分类监听器就失效了；
// 绑在 contentContainer 这个不会被替换的外层元素上，就不用管里面的按钮换了多少轮
contentContainer.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-revision-nav]');
    if (!navBtn) return;
    e.preventDefault();
    showRevisionView(navBtn.dataset.revisionNav);
});

// 页面加载时调用一次，把所有试卷按分类拉回来并缓存
function fetchPapersGrouped() {
    return fetch(`${APP_API_BASE}/api/papers/grouped`)
        .then(res => res.json())
        .then(data => { papersByCategory = data; })
        .catch(error => console.error('Failed to Obtain Papers:', error));
}

// 切换 Test 分类或者左边的模式时，把页面滚回顶部。
//
// 不这么做的话：在长列表里滚到很深的位置再切一下，新内容是从半截开始显示的——
// 因为滚动位置没变，而新内容的开头在屏幕上方之外。
//
// 用瞬时跳转而不是平滑滚动：从很深的位置平滑滚回顶部要花上一两秒，
// 那段时间内容已经换了，看着像卡住。这里的语义就是"翻到新的一页"，
// 瞬时才对得上。
function scrollPageToTop() {
    window.scrollTo({ top: 0, behavior: 'auto' });
}


// ---------- 侧边栏折叠 ----------
// 状态规则：刷新页面保持不变，但从别的页面点进来时一律回到展开。
//
// 理由是这两件事的性质不同：刷新是「还在原来那次使用里」，收起来是刚做的选择，
// 弹回去会很烦；而从首页点进来是一次新的开始，这时候把导航亮出来更合适——
// 尤其是收起状态下侧边栏完全不可见，新进来的人可能找不到它在哪。
//
// 用 sessionStorage 而不是 localStorage：这个状态本来就只该在当前标签页里有效，
// 换个标签页打开也应该是展开的。
const SIDEBAR_COLLAPSED_KEY = 'code100_sidebar_collapsed';
const sidebarToggle = document.getElementById('sidebar-toggle');

// 浏览器能区分这次是刷新还是从别处导航过来的。
// reload = 刷新；back_forward = 用前进/后退回到这个页面——
// 这两种都算「还在原来那次浏览里」，应该保持状态。
// navigate（从首页点进来、或者直接输网址）则回到默认展开。
function shouldKeepSidebarState() {
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (!nav) return false;
        return nav.type === 'reload' || nav.type === 'back_forward';
    } catch (e) {
        // 老浏览器拿不到这个 API，那就一律按「新进来」处理，展开是更安全的默认值
        return false;
    }
}

function applySidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', collapsed);
    if (sidebarToggle) {
        // aria-expanded 描述的是「侧边栏展开着吗」，所以跟 collapsed 相反
        sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        sidebarToggle.title = collapsed ? 'Show sidebar' : 'Hide sidebar';
    }
}

if (sidebarToggle) {
    const savedCollapsed = sessionStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    const initialCollapsed = shouldKeepSidebarState() ? savedCollapsed : false;

    applySidebarCollapsed(initialCollapsed);
    // 存回去，这样紧接着的刷新读到的是当前实际状态而不是上一次的残留
    sessionStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(initialCollapsed));

    sidebarToggle.addEventListener('click', () => {
        const collapsed = !document.body.classList.contains('sidebar-collapsed');
        applySidebarCollapsed(collapsed);
        sessionStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    });
}


// 进入考试专注模式：隐藏 sidebar、navbar 和 footer
// （被 testing-engine.js 里 Testing 模式的「开始考试」逻辑调用）
function enterExamFocusMode() {
    sidebar.classList.add('exam-focus-hide');
    if (navBar) navBar.classList.add('exam-focus-hide');
    if (footerContainer) footerContainer.classList.add('exam-focus-hide');
    document.body.classList.add('exam-focus-mode');
}

// 退出考试专注模式：恢复 sidebar、navbar 和 footer
// （被 testing-engine.js 里 Testing 模式的「交卷」逻辑调用）
function exitExamFocusMode() {
    sidebar.classList.remove('exam-focus-hide');
    if (navBar) navBar.classList.remove('exam-focus-hide');
    if (footerContainer) footerContainer.classList.remove('exam-focus-hide');
    document.body.classList.remove('exam-focus-mode');
}

// 根据点击的 nav id（test1/test2/...），找到对应分类下的所有版本（年份），
// 用共用骨架模板（testing-engine.js 里的 buildTestingPageSkeleton，从 skeleton.html 异步加载并缓存）生成内容，
// 默认显示最新年份的版本；如果同一分类下有多个版本，额外加一个下拉框切换
async function loadContent(id) {
    const category = navToCategory[id];
    const papers = papersByCategory[category];

    // 切换内容前，先停掉 Testing 模式可能还在跑的计时器，避免内存泄漏
    stopTestingTimer();
    // 同时退出考试专注模式，避免切到别的 Test 时 sidebar/navbar 还是隐藏状态
    exitExamFocusMode();

    if (!papers || papers.length === 0) {
        console.warn(`No papers found for category: ${category}`);
        // 该分类下暂无试卷，显示 Coming Soon 提示，不保留上一个分类的内容
        contentContainer.innerHTML = `
            <div style="padding: 80px 20px; text-align: center; color: var(--weak-color);">
                <p style="font-size: 1.5rem; font-style: italic; margin: 0;">Coming Soon...</p>
            </div>
        `;

        contentContainer.style.animation = 'none';
        void contentContainer.offsetWidth;
        contentContainer.style.animation = '';

        return;
    }

    // 按年份从新到旧排序，默认显示最新的版本
    const sortedPapers = [...papers].sort((a, b) => b.paper_year - a.paper_year);
    const defaultPaper = sortedPapers[0];

    contentContainer.innerHTML = await buildTestingPageSkeleton();

    // 骨架里的 version-selector-wrap 和 version-select 已经是现成的 DOM，
    // 这里只负责填充 <option> 和控制显隐（只有多个版本时才显示下拉框）
    const versionWrap = document.getElementById('version-selector-wrap');
    const versionSelect = document.getElementById('version-select');

    if (sortedPapers.length > 1) {
        versionSelect.innerHTML = sortedPapers
            .map(p => `<option value="${p.id}">${p.paper_year}</option>`)
            .join('');
        versionWrap.classList.add('show');

        versionSelect.addEventListener('change', (e) => {
            const selectedPaperId = Number(e.target.value);
            const selectedPaper = sortedPapers.find(p => p.id === selectedPaperId);
            const title = `${category} (${selectedPaper.paper_year})`;
            loadTestingQuestions(selectedPaperId, title);
        });
    } else {
        versionWrap.classList.remove('show');
    }

    // 重新触发动画：先移除 animation，强制浏览器重排，再加回去
    contentContainer.style.animation = 'none';
    void contentContainer.offsetWidth;   // 强制重排，这一行不能删
    contentContainer.style.animation = '';

     // 内容加载完后，默认让 Practice 淡入显示
    const initialSection = document.getElementById('practice-content');
    if (initialSection) {
        initialSection.style.animation = 'none';
        void initialSection.offsetWidth;
        initialSection.style.animation = 'contentFadeIn 0.9s ease forwards';
    }

    // Practice 和 Testing 现在各自独立：
    // Practice 按「Test 分类」查询，跨该分类下所有年份混合展示，不跟版本下拉框挂钩
    setupPracticeFilter(category);
    loadPracticeQuestionsByCategory(category, '');

    // Testing/Examination 按「具体某一年」的试卷整体查询，默认用最新年份，
    // 版本下拉框切换时（见上面 versionSelect 的 change 监听）会重新调用这个函数
    const defaultTitle = `${category} (${defaultPaper.paper_year})`;
    loadTestingQuestions(defaultPaper.id, defaultTitle);
}

// 合并成一个监听器：颜色切换 + 内容加载，一起处理
navItems.forEach(item => {
    item.addEventListener('click', function(e) {
        e.preventDefault();   // 阻止 <a href="#"> 的默认跳转行为，防止页面跳到顶部

        navItems.forEach(i => i.classList.remove('active'));
        this.classList.add('active');

        applySidebarTint(this.id);
        scrollPageToTop();

        // 加载对应内容
        loadContent(this.id);

        // 切换 Test 时，把 sidebar 重置回 Practice，保持一致
        items.forEach(i => i.classList.remove('active'));
        document.getElementById('practice').classList.add('active');
    });
});


// 页面加载时，先拉取所有试卷的分组数据，再显示默认的 Test 1
fetchPapersGrouped().then(() => {
    applySidebarTint('test1');
    loadContent('test1');
});


items.forEach(item => {
    item.addEventListener('click', function(e) {
        e.preventDefault();

        items.forEach(i => i.classList.remove('active'));
        this.classList.add('active');
        scrollPageToTop();

        // 隐藏所有板块
        document.querySelectorAll('.test-section').forEach(section => {
            section.classList.remove('active');
        });

        // 显示被点击的那一块
        const target = document.getElementById(this.id + '-content');
        if (target) {
            target.classList.add('active');

            // 重新触发淡入动画，跟切换 Test 时保持一致
            target.style.animation = 'none';
            void target.offsetWidth;   // 强制重排，这一行不能删
            target.style.animation = 'contentFadeIn 0.9s ease forwards';
        }

        // 切到 Revision 标签页时，先回到首页（两张卡片），具体内容等用户点进某张卡片才加载，
        // 不用一进来就把星标题目和 Crib Sheet 都请求一遍
        if (this.id === 'revision') {
            showRevisionView('landing');
        }
    });
});


// footer
fetch('../../../0.%20Footer/footer.html')
    .then(res => res.text())
    .then(html => {
        const footerEl = document.getElementById('footer-container');
        footerEl.innerHTML = html;
        footerEl.classList.add('footer-loaded');   // 内容插入之后再加这个 class，触发淡入动画
});

// 登录/注册/忘记密码 弹窗（共用片段，见 0. Shared/auth-modal.html）
fetch('../../../0.%20Shared/auth-modal.html')
    .then(res => res.text())
    .then(html => {
        document.getElementById('auth-modal-container').innerHTML = html;
        if (window.initAuthModal) window.initAuthModal();
    });