// cs1_index.js

const items = document.querySelectorAll('.switcher-item');

const navItems = document.querySelectorAll('.bar-items');
const sectionSwitcher = document.querySelector('.section-switcher');
const navBar = document.querySelector('.nav-bar');
const footerContainer = document.getElementById('footer-container');

// 每个 Test 对应的颜色，跟navbar配色保持一致
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


// 进入考试专注模式：隐藏切换器、navbar 和 footer
// （被 testing-engine.js 里 Testing 模式的「开始考试」逻辑调用）
function enterExamFocusMode() {
    if (sectionSwitcher) sectionSwitcher.classList.add('exam-focus-hide');
    if (navBar) navBar.classList.add('exam-focus-hide');
    if (footerContainer) footerContainer.classList.add('exam-focus-hide');
    document.body.classList.add('exam-focus-mode');
}

// 退出考试专注模式：恢复切换器、navbar 和 footer
// （被 testing-engine.js 里 Testing 模式的「交卷」逻辑调用）
function exitExamFocusMode() {
    if (sectionSwitcher) sectionSwitcher.classList.remove('exam-focus-hide');
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
    // 同时退出考试专注模式，避免切到别的 Test 时切换器/navbar 还是隐藏状态
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

        scrollPageToTop();

        // 加载对应内容
        loadContent(this.id);

        // 切换 Test 时，把板块重置回 Practice，保持一致
        items.forEach(i => i.classList.remove('active'));
        document.getElementById('practice').classList.add('active');
    });
});


// 页面加载时，先拉取所有试卷的分组数据，再显示默认的 Test 1
fetchPapersGrouped().then(() => {
    loadContent('test1');
});


// 侧项缩小的比例，必须跟 CSS 里 .switcher-item 的 --scale 默认值一致
const SWITCHER_SIDE_SCALE = 0.5;
// 相邻两个标签之间的间隙
const SWITCHER_ITEM_GAP = 26;
// 轨道两端留的一点余量
const SWITCHER_EDGE_PAD = 8;

// 量一个子页标题在当前字体下有多宽。
// 伪元素的尺寸拿不到，只能建一个同样字体设置的临时元素来量，量完立刻移除。
// 字体设置必须跟 CSS 里 .switcher-track::after 保持一致，改一边要改两边
function measureSubPageTitleWidth(title) {
    const probe = document.createElement('span');
    probe.textContent = title;
    probe.style.cssText = `
        position: absolute;
        visibility: hidden;
        white-space: nowrap;
        font-size: 2rem;
        font-weight: 700;
        letter-spacing: -0.025em;
    `;
    document.body.appendChild(probe);
    const width = probe.offsetWidth;
    probe.remove();
    return Math.ceil(width);
}

// ---------- 子页标题覆盖 ----------
// 进到 Revision 的子页（Marked Questions / Cribsheet Builder）时，
// 切换器整个变成那个子页的标题：两侧首字母消失，也不能再左右切换。
//
// 为什么禁掉切换：子页比板块低一层，这时候轮滑已经不是"当前层级的导航"了。
// 留着能切的话，"当前项"到底是 Revision 还是 Marked Questions 就说不清。
// 想去别的板块，先点返回回到 Revision 首页。
//
// 由 testing-engine.js 的 showRevisionView() 调用——那边才知道进了哪个子页。
function setSwitcherSubPageTitle(title) {
    const switcher = document.getElementById('section-switcher');
    if (!switcher) return;

    // 标题写在 .switcher-track 上而不是外层——CSS 的 attr() 只能读
    // 伪元素所在元素自己的属性，读不到父元素的
    const track = document.getElementById('switcher-track');

    if (title) {
        switcher.classList.add('is-subpage');
        if (track) {
            track.dataset.subpageTitle = title;
            // 轨道要撑到标题那么宽。
            // 这里不能写 width: auto——轨道里的标签都是绝对定位的，
            // auto 会让它塌成 0 宽，而标题伪元素是相对轨道居中的，
            // 于是整个标题往左溢出、被屏幕边缘切掉。
            // 伪元素量不到宽度，所以拿一个临时元素照同样的字体设置量一次
            track.style.width = `${measureSubPageTitleWidth(title)}px`;
        }
    } else {
        switcher.classList.remove('is-subpage');
        if (track) delete track.dataset.subpageTitle;
        layoutSwitcher();   // 退回三项模式，宽度和位置都要重新算
    }
}

// 摆放三个标签：当前项居中，另外两个缩小放在左右两侧当预览。
//
// 位置按各自的【实际宽度】算，不是固定偏移——三个词长短差很多，
// 固定偏移会让间隙忽宽忽窄。侧项是用 scale 缩小的，scale 不改变
// 布局宽度，所以视觉宽度要自己乘一下比例。
//
// direction 只影响哪个词落到左边、哪个落到右边（按环形顺序）。
// 只有三个项时两种方向的结果其实一样，留着是为了以后加第四个板块。
function layoutSwitcher(direction) {
    const track = document.getElementById('switcher-track');
    const list = Array.from(items);
    const activeIndex = list.findIndex(i => i.classList.contains('active'));
    if (!track || activeIndex === -1) return;

    const total = list.length;
    const prevIndex = (activeIndex - 1 + total) % total;
    const nextIndex = (activeIndex + 1) % total;

    // 先量宽度。侧项虽然被 scale 缩小了，offsetWidth 拿到的仍是未缩放的值，
    // 所以乘上比例才是它在屏幕上实际占的宽度
    // 侧项显示的是首字母、当前项是全称，两者宽度差很远。
    // active 类刚刚才切换，先读一次 offsetWidth 逼浏览器把新的伪元素内容
    // 应用掉，后面量到的才是新文字的宽度
    void list[activeIndex].offsetWidth;

    const widthOf = (el, isActive) =>
        el.offsetWidth * (isActive ? 1 : SWITCHER_SIDE_SCALE);

    const activeW = widthOf(list[activeIndex], true);
    const leftW = widthOf(list[prevIndex], false);
    const rightW = widthOf(list[nextIndex], false);

    // 左右两侧各自的中心，距离整体中心多远
    const leftX = -(activeW / 2 + SWITCHER_ITEM_GAP + leftW / 2);
    const rightX = activeW / 2 + SWITCHER_ITEM_GAP + rightW / 2;

    list.forEach((item, index) => {
        let x = 0;
        if (index === prevIndex) x = leftX;
        else if (index === nextIndex) x = rightX;
        item.style.setProperty('--x', `${Math.round(x)}px`);
    });

    // 轨道要正好裹住三个标签
    const totalWidth = leftW + rightW + activeW
        + SWITCHER_ITEM_GAP * 2 + SWITCHER_EDGE_PAD * 2;
    track.style.width = `${Math.round(totalWidth)}px`;
}

// 切到某个板块。点标签和点箭头都走这里，逻辑只有一份
function activateSection(item, direction) {
    if (!item) return;

    items.forEach(i => {
        const isActive = i === item;
        i.classList.toggle('active', isActive);
        i.setAttribute('aria-selected', String(isActive));
    });

    setSwitcherSubPageTitle(null);   // 换板块了，子页标题要撤掉
    layoutSwitcher(direction);

    scrollPageToTop();

    // 隐藏所有板块
    document.querySelectorAll('.test-section').forEach(section => {
        section.classList.remove('active');
    });

    // 显示被选中的那一块
    const target = document.getElementById(item.id + '-content');
    if (target) {
        target.classList.add('active');

        // 重新触发淡入动画，跟切换 Test 时保持一致
        target.style.animation = 'none';
        void target.offsetWidth;   // 强制重排，这一行不能删
        target.style.animation = 'contentFadeIn 0.9s ease forwards';
    }

    // 切到 Revision 时，先回到首页（两张卡片），具体内容等用户点进某张卡片才加载，
    // 不用一进来就把星标题目和 Crib Sheet 都请求一遍
    if (item.id === 'revision') {
        showRevisionView('landing');
    }
}

items.forEach(item => {
    item.addEventListener('click', function(e) {
        e.preventDefault();
        activateSection(this);
    });
});

// 首屏摆一次。字体加载完标签宽度会变，load 之后再摆一次
layoutSwitcher();
window.addEventListener('load', () => layoutSwitcher());





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