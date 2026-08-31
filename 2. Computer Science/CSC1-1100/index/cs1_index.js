// cs1_index.js

const items = document.querySelectorAll('.switcher-item');

const navItems = document.querySelectorAll('.bar-items');
const sectionSwitcher = document.querySelector('.section-switcher');
const navBar = document.querySelector('.nav-bar');
const footerContainer = document.getElementById('footer-container');
const headerWrapper = document.getElementById('header-wrapper');

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
// Cribsheet Builder 还在打磨，暂不对外开放：非本地（线上）给 body 上锁——
// 卡片会标 "Coming soon" 且不可点（见 CSS 的 body.cribsheet-locked）。
// 本地（localhost / 127.0.0.1）不上锁，方便继续开发。想上线时删掉这段即可。
if (!['localhost', '127.0.0.1'].includes(location.hostname)) {
    document.body.classList.add('cribsheet-locked');
}

contentContainer.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-revision-nav]');
    if (!navBtn) return;
    e.preventDefault();
    // 上锁时挡住 Cribsheet Builder 的入口（pointer-events 已经挡了一道，这里兜底）
    if (navBtn.dataset.revisionNav === 'cribsheet' && document.body.classList.contains('cribsheet-locked')) {
        return;
    }
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
// instant = true 时页面骨架【瞬间】收起，不播 400ms 的折叠动画。
//
// 刷新页面恢复考试时要用这个：那些动画是给"刚点下开始按钮"这个动作做反馈的，
// 恢复时播一遍会让人以为考试是这一刻才开始的。
//
// 跟 exitExamFocusMode 的 instant 是同一套机制，两个函数要保持对称——
// 只有一边支持的话，进去和出来的观感会不一致。
function enterExamFocusMode(instant = false) {
    // 页头（logo + 课程名 + Back to Home）也一起收起。
    // 考试期间那个返回首页的链接尤其不该留着——点一下考试就中断了
    const targets = [headerWrapper, sectionSwitcher, navBar, footerContainer].filter(Boolean);

    if (instant) targets.forEach(el => el.classList.add('skip-transition'));

    targets.forEach(el => el.classList.add('exam-focus-hide'));
    document.body.classList.add('exam-focus-mode');

    if (instant) {
        // 强制重排让"没有过渡的那一次布局变化"立刻落定，
        // 之后再摘掉 skip-transition，下次展开时过渡照常
        targets.forEach(el => void el.offsetHeight);
        requestAnimationFrame(() => {
            targets.forEach(el => el.classList.remove('skip-transition'));
        });
    }
}

// 退出考试专注模式：恢复切换器、navbar 和 footer
// （被 testing-engine.js 里 Testing 模式的「交卷」逻辑调用）
// instant = true 时页面骨架【瞬间】恢复，不播展开动画。
//
// 交卷的时候要用这个。默认的展开是有过渡的：页头 350ms、切换器 280ms、
// 导航栏 400ms、页脚 400ms，加起来最多 500px 的高度在 400ms 里长出来，
// 把下面所有内容一路往下推——看起来就像页面在往下滑。
// 而结果卡片的淡入正好同时进行，一边淡入一边被推走，两个位移叠在一起。
//
// 骨架瞬间回来、然后结果卡片干净地依次淡入，节奏才对。
function exitExamFocusMode(instant = false) {
    const targets = [headerWrapper, sectionSwitcher, navBar, footerContainer].filter(Boolean);

    if (instant) targets.forEach(el => el.classList.add('skip-transition'));

    targets.forEach(el => el.classList.remove('exam-focus-hide'));
    document.body.classList.remove('exam-focus-mode');

    if (instant) {
        // 强制重排，让"没有过渡的那一次布局变化"立刻落定，
        // 之后再把 skip-transition 摘掉，下次收起时过渡照常
        targets.forEach(el => void el.offsetHeight);
        requestAnimationFrame(() => {
            targets.forEach(el => el.classList.remove('skip-transition'));
        });
    }
}

// 根据点击的 nav id（test1/test2/...），找到对应分类下的所有版本（年份），
// 用共用骨架模板（testing-engine.js 里的 buildTestingPageSkeleton，从 skeleton.html 异步加载并缓存）生成内容，
// 默认显示最新年份的版本；如果同一分类下有多个版本，额外加一个下拉框切换
async function loadContent(id) {
    const category = navToCategory[id];
    // 只保留【有题的】卷子(大题数 > 0)——0 题的空壳卷不显示,免得点进去是空考试误导人。
    // mainQuestionCount 由后端 /api/papers/grouped 带回(distinct question_number)。
    const papers = (papersByCategory[category] || []).filter(p => (p.mainQuestionCount ?? 0) > 0);

    // 切换内容前，先停掉 Testing 模式可能还在跑的计时器，避免内存泄漏
    stopTestingTimer();
    // 同时退出考试专注模式，避免切到别的 Test 时切换器/navbar 还是隐藏状态
    exitExamFocusMode();

    if (papers.length === 0) {
        console.warn(`No non-empty papers for category: ${category}`);
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

    // 内容加载完后默认显示 Practice——但如果有未结束的考试，
    // 就直接落在 Examination 上。
    //
    // 不这么做的话，刷新页面会先跳回 Practice，
    // 而恢复考试的逻辑在 loadTestingQuestions 里、那时候板块早就切走了：
    // 结果是计时器在后台继续跑，学生却看不到考试界面。
    //
    // hasUnfinishedExam 只读 sessionStorage、不依赖任何 DOM，
    // 所以可以在这个时间点安全调用
    // typeof 检查是保险：万一以后脚本加载顺序变了，
    // 不至于让整个 loadContent 抛错、页面一片空白
    // 考试中、或交卷后改卷阶段——两种都要落在 Examination，别刷新回 Practice 把状态丢了
    const resumeExam = (typeof hasUnfinishedExam === 'function' && hasUnfinishedExam())
        || (typeof hasPendingMarking === 'function' && hasPendingMarking());

    const initialSection = document.getElementById(
        resumeExam ? 'testing-content' : 'practice-content'
    );
    if (initialSection) {
        // 其他板块要藏掉——skeleton 里 practice-content 默认带 active，
        // 恢复考试时得手动把它摘掉，否则两个板块会同时显示
        document.querySelectorAll('#content-container .test-section')
            .forEach(el => el.classList.remove('active'));
        initialSection.classList.add('active');

        initialSection.style.animation = 'none';
        void initialSection.offsetWidth;
        initialSection.style.animation = 'contentFadeIn 0.9s ease forwards';
    }

    // 切换器上的高亮也要跟着走，否则标题写着 Practice、内容却是 Examination
    if (resumeExam) {
        items.forEach(i => i.classList.remove('active'));
        // 切换器上 Examination 的 id 是 'testing' 不是 'examination'——
        // 跟 .test-section 的 'testing-content' 对应
        const examItem = document.getElementById('testing');
        if (examItem) examItem.classList.add('active');
        layoutSwitcher();
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

        // 切换 Test 时回到 Practice。
        //
        // 必须走 activateSection 而不是手动改 class：
        // 原来这里是 items.forEach(remove) + practice.add('active')，
        // 只改了"哪个标签高亮"，没有清掉子页标题（Marked Questions /
        // Cribsheet Builder 那个 is-subpage 状态），也没重新摆放三个标签的位置。
        // 结果是从 Cribsheet Builder 直接点 Test 2 时，切换器还写着
        // "Cribsheet Builder"，但下面已经是 Practice 的内容了。
        //
        // 放在 loadContent 之后：那个函数是 async 的，会用 innerHTML 整个重建骨架，
        // 在它之前操作 .test-section 是白做——那些元素马上会被换掉
        loadContent(this.id).then(() => {
            activateSection(document.getElementById('practice'));
        });
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

    // Examination 的「准备中」状态挂在 body 上，而切板块只是切换
    // .test-section 的显隐、不重建骨架——不主动清的话，
    // 点了 Get Ready 之后切到 Practice 再切回来，还停在第二步
    if (typeof resetExamReadyState === 'function') resetExamReadyState();

    scrollPageToTop();

    // 隐藏所有板块
    document.querySelectorAll('.test-section').forEach(section => {
        section.classList.remove('active');
    });

    // 题目导航条挂在 body 直属层（原因见 cs1_index.html 里的说明），
    // 【不会】跟着 .test-section 一起隐藏，所以这里显式拆掉。
    // 不拆的话切到 Practice / Revision 之后，右边还浮着一条
    // 指向 Examination 题目的导航
    if (typeof destroyQuestionNav === 'function') destroyQuestionNav();

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

    // 切回 Examination（id 是 'testing'）时，如果正处在考试中或批改结果页，
    // 重建右侧题号导航条。它挂在 body 直属层，上面切板块时被 destroyQuestionNav()
    // 拆掉了——题目还在、状态也还在，只是导航条没了，回来得把它重建出来。
    if (item.id === 'testing') {
        const header = document.getElementById('testing-header');
        // exam-in-progress = 考试中；exam-finished = 交卷后（改卷阶段 + 已亮分都算），
        // 两个状态下题目都在、导航条都该在。用 exam-finished 而不是 exam-result-mode，
        // 因为"改卷阶段"还没挂 exam-result-mode，但那时导航条也得能重建
        const active = header && (header.classList.contains('exam-in-progress')
            || header.classList.contains('exam-finished'));
        const hasQuestions = document.querySelector('#testing-questions .question-block');
        if (active && hasQuestions && typeof buildQuestionNav === 'function') {
            buildQuestionNav();
        }
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


// ---------- 沉浸模式 ----------
// 把跟题目无关的东西全部收起：页头、导航栏、板块切换器、页脚。
// 只留下题目本身。
//
// 状态存在 sessionStorage 里，沿用侧边栏折叠当初定下的那条规则：
// 刷新保持，但从别的页面点进来回到正常模式——新进来的人不该
// 一上来就面对一个"什么都没有"的页面，还得先找按钮。
const IMMERSIVE_KEY = 'code100_immersive_mode';
const immersiveToggle = document.getElementById('immersive-toggle');

// 浏览器能区分这次是刷新还是从别处导航过来的。
// reload = 刷新；back_forward = 用前进/后退回到这个页面——
// 这两种都算"还在原来那次浏览里"，应该保持沉浸状态。
// navigate（从首页点进来、或者直接输网址）则回到正常模式：
// 新进来的人不该一上来就面对一个"什么都没有"的页面，还得先找按钮。
//
// ⚠️ 这段逻辑原来是引用 shouldKeepSidebarState()，那是侧边栏时代的函数，
// 侧边栏整个撤掉时它一起被删了，而我沿用了它——结果这里抛 ReferenceError，
// 而它在 addEventListener 之前，点击监听根本没挂上，按钮是个死按钮。
function shouldKeepImmersiveState() {
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (!nav) return false;
        return nav.type === 'reload' || nav.type === 'back_forward';
    } catch (e) {
        // 老浏览器拿不到这个 API，一律按"新进来"处理
        return false;
    }
}

function setImmersiveMode(on) {
    document.body.classList.toggle('immersive-mode', on);

    if (immersiveToggle) {
        immersiveToggle.setAttribute('aria-pressed', String(on));
        immersiveToggle.title = on ? 'Exit immersive mode' : 'Immersive mode';
        const icon = immersiveToggle.querySelector('i');
        if (icon) icon.className = on ? 'fa-solid fa-compress' : 'fa-solid fa-expand';
    }

    sessionStorage.setItem(IMMERSIVE_KEY, String(on));
}

if (immersiveToggle) {
    const savedImmersive = sessionStorage.getItem(IMMERSIVE_KEY) === 'true';
    setImmersiveMode(shouldKeepImmersiveState() ? savedImmersive : false);

    immersiveToggle.addEventListener('click', () => {
        setImmersiveMode(!document.body.classList.contains('immersive-mode'));
    });

    // Esc 退出。进去之后页面上没剩几个可点的东西，留个键盘出口。
    // 光标在输入框里的时候不拦——那时候 Esc 可能是用来取消输入的
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!document.body.classList.contains('immersive-mode')) return;

        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

        setImmersiveMode(false);
    });
}