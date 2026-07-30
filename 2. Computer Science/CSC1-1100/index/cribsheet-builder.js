// cribsheet-builder.js
//
// Cribsheet Builder（阶段 4）：笔记库 + 拖拽画布 + 样式 + 撤销重做 + 打印导出。
// 原本这一整段都在 testing-engine.js 里，那个文件涨到两千多行之后翻起来太痛苦，
// 就整段挪了出来。挪的时候一行逻辑都没改。
//
// 跟 testing-engine.js 之间只有两个接触点：
//   1. showRevisionView() 会调用这里的 initCribsheetBuilder()
//   2. 这里的 cribsheetToast() 在探测不到 showToast 时会退回用 showExamToast()
// 两个文件都是全局作用域，函数互相看得见，加载顺序按依赖方向排在它后面即可。
//
// 依赖：GridStack（cs1_index.html 里从 CDN 引入）、
//      APP_API_BASE（0. Shared/config.js）、getToken（0. Shared/auth.js）

// ---------- Cribsheet Builder v2：网格拖拽画布（GridStack.js）----------
// 笔记库/尺寸列表不用登录也能看；加笔记/拖动/删除/导出这些操作需要登录
// 画布的列数。从 12 改成 24：12 列时一格 55×28px（纸宽约 660px），
// 横向是纵向的两倍，格子又扁又大；24 列时一格 27.5×28px，基本正方形。
// ⚠️ 改这个值必须同时做两件事，否则已存的卡片会错位：
//    1. 跑 migration_grid_24_columns.sql（把 grid_col / item_cols 按比例放大）
//    2. 改 CSS 里网格底那条竖线渐变的 calc(100% / 24)
const CRIBSHEET_GRID_COLS = 24;
// 每行的高度。GridStack 初始化和对齐参考线的纵向坐标都用这一个值，
// 改的时候 CSS 里网格底那条 repeating-linear-gradient 的 28px 也要跟着改
const CRIBSHEET_CELL_HEIGHT = 28;
// 撤销栈的 localStorage key 现在按用户区分。原来是固定 key，同一台浏览器换账号登录之后，
// 上一个用户的快照还留着，新用户按一下 Undo 会把别人的画布内容灌进自己的表里。
const CRIBSHEET_UNDO_KEY_BASE = 'code100_cribsheet_undo_stack';
const CRIBSHEET_REDO_KEY_BASE = 'code100_cribsheet_redo_stack';
const CRIBSHEET_MAX_HISTORY = 30;

let cribsheetLibraryCache = null; // 笔记库内容不常变，缓存一份，切换标签页不用重复请求
let cribsheetNoteSizesCache = null;
let gridStackInstance = null;

// 画布上每个方块的完整数据模型（layoutId -> {id, noteId, sizeId, isCustom, title, content}）。
// 原来做快照是从 DOM 里读 textContent 反推的，那样只能拿到"屏幕上显示了什么"，
// noteId / sizeId 这类不显示在界面上的字段一律丢失，撤销一次引用笔记库的笔记就被转成自定义笔记。
// 阶段4C 要加富文本字段（字号/加粗/颜色），从 DOM 反推更是完全不可行，所以这里改成
// 内存里维护一份权威数据，位置尺寸仍然从 GridStack 实时读（那才是它的权威来源）。
let cribsheetItemModels = new Map();

// 程序化重建画布（加载布局、Undo/Redo 恢复、清空）期间，GridStack 会因为内部批量布局
// 触发 change 事件。不屏蔽的话，光是打开页面就会给每个方块发一遍 PUT，还会污染撤销栈。
let isCribsheetRestoring = false;

// 笔记标题/正文是拼进 innerHTML 的，而这是个 CS1 复习网站，
// 学生笔记里出现 a < b、vector<int>、-> 是必然的，一个 < 就能把卡片结构撕烂。
function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// showToast 定义在这个文件之外（应该在 auth.js 里），这里没法确认它一定存在。
// 万一没有，下面那几处错误提示会直接抛 ReferenceError。用 typeof 探测一下，
// 探测不到就退回 testing-engine.js 里的 showExamToast，行为不变但不会崩。
function cribsheetToast(message) {
    if (typeof showToast === 'function') {
        showToast(message, true);
        return;
    }
    showExamToast(message);
}

// 从 JWT 里取一个稳定的用户标识给撤销栈的 key 加后缀。
// 自建 JWT 的 claim 名字不确定，几种常见写法都试一遍；都取不到就退回用 token 尾部区分
// （效果一样是"换用户就换一份历史"，只是重新登录之后旧历史接不上，这个代价可以接受）。
function getCribsheetHistoryScope() {
    const token = typeof getToken === 'function' ? getToken() : null;
    if (!token) return 'anon';
    try {
        const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
        const id = payload.sub ?? payload.userId ?? payload.user_id ?? payload.id ?? payload.username;
        if (id !== undefined && id !== null) return String(id);
    } catch (e) {
        // 解析失败不用管，下面有兜底
    }
    return token.slice(-16);
}

function cribsheetUndoKey() { return `${CRIBSHEET_UNDO_KEY_BASE}_${getCribsheetHistoryScope()}`; }
function cribsheetRedoKey() { return `${CRIBSHEET_REDO_KEY_BASE}_${getCribsheetHistoryScope()}`; }

function initCribsheetBuilder() {
    // 清掉改成按用户区分之前留下的那两个旧 key，避免它们一直占着 localStorage
    localStorage.removeItem(CRIBSHEET_UNDO_KEY_BASE);
    localStorage.removeItem(CRIBSHEET_REDO_KEY_BASE);

    loadCribsheetNoteSizes().then(() => {
        initCribsheetGridStack();
        loadMyCribsheetLayout();
    });
    loadCribsheetLibrary();
    initCribsheetLibrarySearch();
    initCribsheetCustomNoteFlow();
    initCribsheetEditModal();
    initCribsheetClipboardShortcuts();
    initCribsheetStylePanel();
    initCribsheetToolbarActions();
    initCribsheetOrientationToggle();
    initCribsheetPdfExport();
}

// ---------- 笔记库（左边面板） ----------
function loadCribsheetLibrary() {
    const container = document.getElementById('cribsheet-library-container');
    if (!container) return;

    if (cribsheetLibraryCache) {
        renderCribsheetLibrary(cribsheetLibraryCache);
        return;
    }

    container.innerHTML = '<div class="questions-loading">Loading note library...</div>';

    fetch(`${APP_API_BASE}/api/cribsheet/notes`)
        .then(res => res.json())
        .then(data => {
            cribsheetLibraryCache = data;
            renderCribsheetLibrary(data);
        })
        .catch(error => {
            console.error('Failed to load note library:', error);
            container.innerHTML = '<div class="questions-error">Failed to load the note library. Please try refreshing the page.</div>';
        });
}

// 记住当前展开的是哪个分类。搜索框每敲一个字都会整个重渲染，
// 状态存在这里才不会一打字就折回去
let cribsheetOpenCategory = null;

function renderCribsheetLibrary(grouped, searchText = '') {
    const container = document.getElementById('cribsheet-library-container');
    if (!container) return;

    container.innerHTML = '';
    const search = searchText.trim().toLowerCase();
    const isSearching = search.length > 0;
    let anyVisible = false;

    // 有匹配内容的分类
    const visibleCategories = [];

    Object.keys(grouped).forEach(category => {
        const notesInCategory = grouped[category].filter(note =>
            !search
            || (note.title || '').toLowerCase().includes(search)
            || (note.content || '').toLowerCase().includes(search)
        );
        if (notesInCategory.length === 0) return;
        anyVisible = true;
        visibleCategories.push(category);

        const section = document.createElement('div');
        section.className = 'cribsheet-library-category';
        section.dataset.category = category;

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'cribsheet-library-category-header';
        header.setAttribute('aria-expanded', 'false');

        const nameEl = document.createElement('span');
        nameEl.className = 'cribsheet-library-category-name';
        nameEl.textContent = category;

        // 分类名旁边标一下条数，折起来的时候也知道里面有多少
        const countEl = document.createElement('span');
        countEl.className = 'cribsheet-library-category-count';
        countEl.textContent = notesInCategory.length;

        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-down cribsheet-library-category-chevron';

        header.appendChild(nameEl);
        header.appendChild(countEl);
        header.appendChild(chevron);

        const body = document.createElement('div');
        body.className = 'cribsheet-library-category-body';

        notesInCategory.forEach(note => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'cribsheet-library-item';
            item.innerHTML = `<span class="cribsheet-library-item-title">${escapeHtml(note.title)}</span><i class="fa-solid fa-plus"></i>`;
            item.title = 'Add to my Cribsheet';

            item.addEventListener('click', () => {
                if (!getToken()) return;
                // 先确保尺寸预设已经拉回来了再加。
                // 原来那个"选尺寸"弹窗是在 loadCribsheetNoteSizes().then() 里打开的，
                // 天然保证加载完成；现在直接添加就没有这层保障——
                // 笔记库渲染完用户可能立刻就点，那时候缓存还是空的
                loadCribsheetNoteSizes().then(() => {
                    addNoteToGrid({ noteId: note.id, title: note.title }, getDefaultCribsheetSize());
                });
            });

            body.appendChild(item);
        });

        header.addEventListener('click', () => {
            const willOpen = !section.classList.contains('open');

            // 一次只展开一个：先把别的都折起来
            container.querySelectorAll('.cribsheet-library-category').forEach(other => {
                if (other !== section) setCribsheetCategoryOpen(other, false);
            });

            setCribsheetCategoryOpen(section, willOpen);
            cribsheetOpenCategory = willOpen ? category : null;
        });

        section.appendChild(header);
        section.appendChild(body);
        container.appendChild(section);
    });

    if (!anyVisible) {
        container.innerHTML = '<p class="cribsheet-empty-hint">No notes match your search.</p>';
        return;
    }

    // 搜索状态下把所有有匹配的分类都展开——搜出来的东西还藏在折叠的标题后面，
    // 用起来就像搜索坏了。清空搜索之后再回到"一次只展开一个"
    if (isSearching) {
        container.querySelectorAll('.cribsheet-library-category')
            .forEach(section => setCribsheetCategoryOpen(section, true));
        return;
    }

    // 没在搜索：展开上次那个，上次那个已经不在了就展开第一个
    const target = visibleCategories.includes(cribsheetOpenCategory)
        ? cribsheetOpenCategory
        : visibleCategories[0];
    cribsheetOpenCategory = target;

    const targetSection = container.querySelector(`.cribsheet-library-category[data-category="${CSS.escape(target)}"]`);
    if (targetSection) setCribsheetCategoryOpen(targetSection, true);
}

// 展开高度用 scrollHeight 实测出来写进 max-height，这样才能有过渡动画——
// max-height 没法从 0 过渡到 auto。scrollHeight 不受 max-height 裁剪影响，
// 折叠状态下量到的也是完整内容高度
function setCribsheetCategoryOpen(section, open) {
    const header = section.querySelector('.cribsheet-library-category-header');
    const body = section.querySelector('.cribsheet-library-category-body');
    if (!header || !body) return;

    section.classList.toggle('open', open);
    header.setAttribute('aria-expanded', open ? 'true' : 'false');
    body.style.maxHeight = open ? `${body.scrollHeight}px` : '0px';
}

function initCribsheetLibrarySearch() {
    const searchInput = document.getElementById('cribsheet-library-search');
    if (!searchInput) return;
    if (searchInput.dataset.listenerAttached) return;
    searchInput.dataset.listenerAttached = 'true';

    searchInput.addEventListener('input', () => {
        if (cribsheetLibraryCache) renderCribsheetLibrary(cribsheetLibraryCache, searchInput.value);
    });
}

// ---------- 自定义笔记（学生自己写） ----------
function initCribsheetCustomNoteFlow() {
    const addBtn = document.getElementById('cribsheet-add-custom-btn');
    const backdrop = document.getElementById('cribsheet-custom-modal-backdrop');
    const titleInput = document.getElementById('cribsheet-custom-title-input');
    const contentInput = document.getElementById('cribsheet-custom-content-input');
    const cancelBtn = document.getElementById('cribsheet-custom-modal-cancel');
    const nextBtn = document.getElementById('cribsheet-custom-modal-next');
    if (!addBtn || addBtn.dataset.listenerAttached) return;
    addBtn.dataset.listenerAttached = 'true';

    addBtn.addEventListener('click', () => {
        if (!getToken()) return;
        titleInput.value = '';
        contentInput.value = '';
        backdrop.style.display = 'flex';
    });

    cancelBtn.addEventListener('click', () => { backdrop.style.display = 'none'; });

    nextBtn.addEventListener('click', () => {
        const title = titleInput.value.trim();
        const content = contentInput.value.trim();
        if (!title) {
            cribsheetToast('Please give your note a title.');
            return;
        }
        backdrop.style.display = 'none';
        loadCribsheetNoteSizes().then(() => {
            addNoteToGrid({ customTitle: title, customContent: content, title }, getDefaultCribsheetSize());
        });
    });
}

// ---------- 选尺寸弹窗（引用笔记库 / 自定义笔记 都走这一个） ----------
function loadCribsheetNoteSizes() {
    if (cribsheetNoteSizesCache) return Promise.resolve(cribsheetNoteSizesCache);
    return fetch(`${APP_API_BASE}/api/cribsheet/note-sizes`)
        .then(res => res.json())
        .then(data => { cribsheetNoteSizesCache = data; return data; })
        .catch(error => {
            console.error('Failed to load note sizes:', error);
            cribsheetNoteSizesCache = [];
            return [];
        });
}

// 现在只有一个尺寸预设（4×4），所以不再弹"选尺寸"的窗——
// 一个选项的选择题没有意义，点笔记直接加到画布上，少一次点击。
// 加完仍然可以自由拖拽缩放，所以这个尺寸只是个起点。
//
// 仍然从后端读预设而不是写死 4×4：这样以后想改默认大小，
// 在 Admin 后台改一下就行，不用动代码
function getDefaultCribsheetSize() {
    const list = cribsheetNoteSizesCache || [];
    if (list.length > 0) return list[0];

    // 后端没返回任何预设时的兜底。sizeId 留空——数据库里没有对应的行，
    // 硬塞一个 id 会变成悬空引用
    return { id: null, cols: 4, rows: 4 };
}

// ---------- 双击编辑笔记 ----------
// 引用笔记库的方块被编辑之后，会转成学生自己的副本（后端把 note_id 置空）——
// 公共笔记库是全站共享的，不能因为某一个学生改了自己的复习单就跟着变。
let pendingCribsheetEditId = null;

function initCribsheetEditModal() {
    const cancelBtn = document.getElementById('cribsheet-edit-modal-cancel');
    const saveBtn = document.getElementById('cribsheet-edit-modal-save');
    if (!cancelBtn || cancelBtn.dataset.listenerAttached) return;
    cancelBtn.dataset.listenerAttached = 'true';

    cancelBtn.addEventListener('click', closeCribsheetEditModal);
    if (saveBtn) saveBtn.addEventListener('click', saveCribsheetItemEdit);

    // 遮罩是透明的，没有深色蒙层提示"这是个模态框"，
    // 所以点弹窗外面要能关掉——只认点在遮罩本身上的，
    // 点在弹窗内部时 e.target 是弹窗里的元素，不该触发
    const backdrop = document.getElementById('cribsheet-edit-modal-backdrop');
    if (backdrop) {
        backdrop.addEventListener('click', (e) => {
            if (e.target === backdrop) closeCribsheetEditModal();
        });
    }

    // 窗口尺寸变了，卡片位置会动，弹窗要跟着重新摆
    window.addEventListener('resize', () => {
        if (pendingCribsheetEditId) positionCribsheetEditModal(pendingCribsheetEditId);
    });
}

function closeCribsheetEditModal() {
    const backdrop = document.getElementById('cribsheet-edit-modal-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    pendingCribsheetEditId = null;
}

// 把编辑弹窗摆到被编辑那张卡的右边。右边放不下就翻到左边，
// 上下夹在视口内。
//
// 这里能用 position: fixed 是因为 triggerFadeIn 现在会在淡入结束后清掉
// animation——之前那个 fill-mode: forwards 留下的 transform 会让
// .revision-view 成为 fixed 的定位基准，弹窗就跑到页面下方去了
function positionCribsheetEditModal(layoutId) {
    const modal = document.querySelector('#cribsheet-edit-modal-backdrop .cribsheet-modal-anchored');
    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${layoutId}"]`);
    if (!modal || !el) return;

    const card = el.getBoundingClientRect();
    const width = modal.offsetWidth;
    const height = modal.offsetHeight;

    const gap = 14;      // 弹窗和卡片之间的缝
    const margin = 12;   // 离视口边缘至少留这么多

    let left = card.right + gap;
    if (left + width > window.innerWidth - margin) {
        left = card.left - gap - width;   // 右边塞不下，翻到左边
    }
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));

    // 纵向跟卡片顶部对齐，超出视口就往回收
    let top = card.top;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));

    modal.style.left = `${Math.round(left)}px`;
    modal.style.top = `${Math.round(top)}px`;
}

function openCribsheetEditModal(layoutId) {
    if (!getToken()) return;

    // 双击的第一下已经排了一个"显示工具条"的定时器，掐掉它——
    // 双击的意图是编辑内容，不是调样式，工具条不该闪一下
    cancelCribsheetStyleBarReveal();
    hideCribsheetStylePanel();

    const model = cribsheetItemModels.get(Number(layoutId));
    if (!model) return;   // 数据模型里没有这个方块，说明状态已经不同步了，不如什么都不做

    const backdrop = document.getElementById('cribsheet-edit-modal-backdrop');
    const titleInput = document.getElementById('cribsheet-edit-title-input');
    const contentInput = document.getElementById('cribsheet-edit-content-input');
    const warning = document.getElementById('cribsheet-edit-warning');
    if (!backdrop || !titleInput || !contentInput) return;

    pendingCribsheetEditId = Number(layoutId);
    titleInput.value = model.title || '';
    contentInput.value = model.content || '';

    // 只有引用笔记库的方块才需要提示"保存之后会变成你自己的副本"
    if (warning) warning.style.display = model.noteId ? 'block' : 'none';

    backdrop.style.display = 'block';
    // 先显示出来才量得到弹窗自己的宽高，量完再摆位置
    positionCribsheetEditModal(pendingCribsheetEditId);
    titleInput.focus();
}

function saveCribsheetItemEdit() {
    const layoutId = pendingCribsheetEditId;
    if (!layoutId) return;

    const token = getToken();
    if (!token) return;

    const titleInput = document.getElementById('cribsheet-edit-title-input');
    const contentInput = document.getElementById('cribsheet-edit-content-input');
    if (!titleInput || !contentInput) return;

    const newTitle = titleInput.value.trim();
    const newContent = contentInput.value.trim();

    if (!newTitle) {
        cribsheetToast('Please give your note a title.');
        return;
    }

    const model = cribsheetItemModels.get(layoutId);

    // 什么都没改就直接关掉，不用发请求、也不用往撤销栈里塞一份一模一样的快照
    if (model && newTitle === model.title && newContent === model.content) {
        closeCribsheetEditModal();
        return;
    }

    pushCribsheetUndoSnapshot();

    fetch(`${APP_API_BASE}/api/cribsheet/layout-items/${layoutId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customTitle: newTitle, customContent: newContent })
    })
        .then(res => res.ok ? res.json() : Promise.reject(new Error('Update failed')))
        .then(() => {
            // 后端已经把 note_id 置空了，内存模型跟着改，否则撤销重建时会又按笔记库内容还原回去
            if (model) {
                model.title = newTitle;
                model.content = newContent;
                model.noteId = null;
                model.isCustom = true;
            }

            // 画布上的显示用 textContent 更新，天然不用担心 < > 这些字符
            const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${layoutId}"]`);
            if (el) {
                const titleEl = el.querySelector('.cribsheet-note-title');
                const contentEl = el.querySelector('.cribsheet-note-content');
                if (titleEl) titleEl.textContent = newTitle;
                if (contentEl) contentEl.textContent = newContent;
            }

            closeCribsheetEditModal();
        })
        .catch(error => {
            console.error('Failed to save note edit:', error);
            cribsheetToast('Failed to save your changes. Please try again.');
        });
}

// ---------- 样式条 + 富文本样式 ----------
// 不是常驻侧栏：选中画布上的方块时才出现，取消选中就整条收起。
// 它固定摆在画布正上方，不跟着方块跑——跟随定位那版会把面板算到窗口外面去。
// 样式值全部存在数据模型和数据库里，null / false 表示"用 CSS 默认"，不写内联样式——
// 这样"恢复默认"就是把值清成 null，而不是硬写一个"默认色"进去。
let cribsheetStylePanelTargetId = null;

// 把数据模型里的样式应用到画布上那张卡片。
// 字号写在卡片根元素上，标题和正文的 font-size 是 em，会跟着一起缩放；
// 正文的颜色要单独写一遍，因为 CSS 里给它定了 color: #333，光靠继承盖不住
function applyCribsheetItemStyles(layoutId) {
    const model = cribsheetItemModels.get(Number(layoutId));
    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${layoutId}"]`);
    if (!model || !el) return;

    const card = el.querySelector('.cribsheet-note-card');
    const content = el.querySelector('.cribsheet-note-content');
    if (!card) return;

    card.style.fontSize = model.fontSize ? `${model.fontSize}px` : '';
    card.style.background = model.backgroundColor || '';
    card.style.color = model.textColor || '';

    if (content) {
        content.style.color = model.textColor || '';
        content.style.fontWeight = model.isBold ? '700' : '';
        content.style.fontStyle = model.isItalic ? 'italic' : '';
    }
}

function initCribsheetStylePanel() {
    const panel = document.getElementById('cribsheet-style-panel');
    if (!panel || panel.dataset.listenerAttached) return;
    panel.dataset.listenerAttached = 'true';

    // 窗口宽度变化会让纸和方块一起重排，工具条要跟着重新定位
    window.addEventListener('resize', positionCribsheetStyleBar);

    // 样式条上的点击不能冒泡到画布——画布的 click 会清掉选中态，
    // 那样一点控件这条自己就消失了
    panel.addEventListener('mousedown', e => e.stopPropagation());
    panel.addEventListener('click', e => e.stopPropagation());

    const sizeSelect = document.getElementById('cribsheet-style-size');
    const boldBtn = document.getElementById('cribsheet-style-bold');
    const italicBtn = document.getElementById('cribsheet-style-italic');
    const textColor = document.getElementById('cribsheet-style-text-color');
    const bgColor = document.getElementById('cribsheet-style-bg-color');
    const resetBtn = document.getElementById('cribsheet-style-reset');
    const deleteBtn = document.getElementById('cribsheet-style-delete');

    if (sizeSelect) {
        // 用 change 而不是 input：input 会在每敲一个数字时触发，
        // 打「12」的过程中会先以「1」发一次请求。change 是失焦或回车时才触发
        sizeSelect.addEventListener('change', () => {
            const raw = sizeSelect.value.trim();

            // 留空也当 Auto 处理（虽然框里平时不会是空的，
            // 但用户可以手动全选删掉）
            if (raw === '') {
                applyCribsheetStylePatch({ fontSize: null });
                return;
            }

            const value = Number(raw);
            if (!Number.isFinite(value)) {
                // 填了非数字：还原成当前实际值，不发请求
                syncCribsheetStylePanelControls(cribsheetItemModels.get(cribsheetStylePanelTargetId) || {});
                return;
            }

            // 夹在 6–72。不夹的话：太小看不见，太大会把卡片整个撑爆，
            // 而且数据库那列是 SMALLINT。HTML 的 min/max 只在用步进箭头时生效，
            // 手打进去的数字不受限，所以这里必须再夹一次
            const clamped = Math.min(72, Math.max(6, Math.round(value)));
            if (clamped !== value) sizeSelect.value = String(clamped);

            applyCribsheetStylePatch({ fontSize: clamped });
        });

        // 回车立刻生效，不用等失焦
        sizeSelect.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sizeSelect.blur();
        });

        // 双击输入框恢复自动字号。
        // 框里现在总是有数字（自动状态下显示的是实测值），所以"清空回到 auto"
        // 这条路没了，需要一个明确的手势
        sizeSelect.addEventListener('dblclick', () => {
            applyCribsheetStylePatch({ fontSize: null });
        });
    }

    if (boldBtn) {
        boldBtn.addEventListener('click', () => {
            const model = cribsheetItemModels.get(cribsheetStylePanelTargetId);
            if (!model) return;
            applyCribsheetStylePatch({ isBold: !model.isBold });
        });
    }

    if (italicBtn) {
        italicBtn.addEventListener('click', () => {
            const model = cribsheetItemModels.get(cribsheetStylePanelTargetId);
            if (!model) return;
            applyCribsheetStylePatch({ isItalic: !model.isItalic });
        });
    }

    // 用 change 而不是 input：拖着调色盘选颜色的时候 input 会连续触发，
    // 那样每挪一下就发一个 PUT，还会往撤销栈里塞一堆快照
    if (textColor) {
        textColor.addEventListener('change', () => {
            applyCribsheetStylePatch({ textColor: textColor.value });
        });
    }

    if (bgColor) {
        bgColor.addEventListener('change', () => {
            applyCribsheetStylePatch({ backgroundColor: bgColor.value });
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            applyCribsheetStylePatch({
                fontSize: null,
                isBold: false,
                isItalic: false,
                textColor: null,
                backgroundColor: null
            });
        });
    }

    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            const selected = getCribsheetSelectedItems();
            if (selected.length === 0) return;

            // 删之前先把工具条收起来。它是浮在选中卡片旁边的，
            // 卡片没了工具条还挂在那儿会指向一个不存在的目标
            hideCribsheetStylePanel();

            // 整批只存一次快照，按一次 Undo 就能把删掉的全部找回来
            pushCribsheetUndoSnapshot();
            selected.forEach(el => {
                deleteCribsheetItem(Number(el.dataset.layoutId), el, true);
            });
        });
    }

}

// 量出"自动"状态下卡片实际用的字号（px）。
// 卡片的基础字号写在 CSS 里（.cribsheet-note-card 的 font-size: 0.78rem），
// 硬编码一个数字迟早会跟 CSS 不一致，所以直接从渲染结果里读。
// 拿不到就退回一个合理的默认值
function getCribsheetAutoFontSize() {
    const card = document.querySelector('#cribsheet-grid .cribsheet-note-card');
    if (!card) return 13;

    // 临时清掉可能存在的内联字号，量到的才是 CSS 的基准值
    const inline = card.style.fontSize;
    card.style.fontSize = '';
    const size = parseFloat(getComputedStyle(card).fontSize);
    card.style.fontSize = inline;

    return Number.isFinite(size) ? Math.round(size) : 13;
}

// 把面板上的控件同步成这个方块当前的实际样式
function syncCribsheetStylePanelControls(model) {
    const sizeSelect = document.getElementById('cribsheet-style-size');
    const boldBtn = document.getElementById('cribsheet-style-bold');
    const italicBtn = document.getElementById('cribsheet-style-italic');
    const textColor = document.getElementById('cribsheet-style-text-color');
    const bgColor = document.getElementById('cribsheet-style-bg-color');

    // 字号框：设过就显示那个值（白字），没设过就显示【真实的自动字号】并置灰。
    // 之前是留空 + placeholder "Auto"，但用户看不到自动状态下究竟是多大，
    // 想微调只能靠猜。现在把 CSS 算出来的实际字号填进去，
    // 靠 .is-auto 这个 class 把它变灰，表示"这是自动值，不是你设的"
    if (sizeSelect) {
        if (model.fontSize) {
            sizeSelect.value = String(model.fontSize);
            sizeSelect.classList.remove('is-auto');
        } else {
            sizeSelect.value = String(getCribsheetAutoFontSize());
            sizeSelect.classList.add('is-auto');
        }
    }
    if (boldBtn) boldBtn.classList.toggle('active', model.isBold === true);
    if (italicBtn) italicBtn.classList.toggle('active', model.isItalic === true);

    // 没设过颜色的时候，色块显示的是 CSS 里的默认值，只是给个参考，
    // 数据模型里仍然是 null（不写内联样式）
    if (textColor) textColor.value = model.textColor || '#333333';
    if (bgColor) bgColor.value = model.backgroundColor || '#f5f9fd';
}

// 拖动/缩放期间给工具条挂上 .is-tracking，那个 class 会临时关掉位置过渡——
// 不关的话工具条会慢半拍地追着卡片跑。
//
// ⚠️ 这个函数原先被调用了 5 次却从来没定义过，每次拖动开始/结束都在抛
// ReferenceError；更糟的是它抛在 positionCribsheetStyleBar() 前面，
// 导致拖完工具条不会重新定位。node --check 只查语法不查未定义引用，所以一直没暴露
function setCribsheetStyleBarTracking(tracking) {
    const bar = document.getElementById('cribsheet-style-panel');
    if (bar) bar.classList.toggle('is-tracking', tracking);
}

// 工具条延后一点再显示。双击是用来打开编辑弹窗的，而浏览器在双击时
// 会先补一次单击——立刻显示的话，双击时工具条会闪一下才消失。
// 延后到这个窗口之后，双击的第二下会先把它取消掉，于是根本不出现
const CRIBSHEET_STYLE_BAR_DELAY = 220;
let cribsheetStyleBarTimer = null;

function cancelCribsheetStyleBarReveal() {
    if (cribsheetStyleBarTimer) {
        clearTimeout(cribsheetStyleBarTimer);
        cribsheetStyleBarTimer = null;
    }
}

function showCribsheetStylePanel(layoutId) {
    const panel = document.getElementById('cribsheet-style-panel');
    const model = cribsheetItemModels.get(Number(layoutId));
    if (!panel || !model) return;
    if (!getToken()) return;   // 改样式要发 PUT，没登录就别把工具条亮出来了

    cribsheetStylePanelTargetId = Number(layoutId);
    syncCribsheetStylePanelControls(model);

    cancelCribsheetStyleBarReveal();
    cribsheetStyleBarTimer = setTimeout(() => {
        cribsheetStyleBarTimer = null;
        panel.style.display = 'flex';
        positionCribsheetStyleBar();   // 显示出来才量得到宽高，量完再摆位置
        void panel.offsetWidth;        // 让位置先应用掉，否则淡入会从旧位置飘过来
        panel.classList.add('is-visible');
    }, CRIBSHEET_STYLE_BAR_DELAY);
}

function hideCribsheetStylePanel() {
    cancelCribsheetStyleBarReveal();   // 排着队还没显示出来的也要掐掉
    const panel = document.getElementById('cribsheet-style-panel');
    if (panel) panel.classList.remove('is-visible');
    cribsheetStylePanelTargetId = null;
}

// 两个矩形有没有重叠
function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

// 把工具条摆到选中方块附近**空的**地方。
//
// 坐标全部相对纸张算——纸是 position: relative，工具条是它的 absolute 子元素，
// 所以不需要碰视口坐标，也就不受祖先 transform、页面滚动的影响。
//
// 依次试上、下、右、左四个位置，挑第一个不压到其他卡片的。
// 光挑"上面放不下就放下面"是不够的：画布上卡片挨得密的时候，
// 上下都可能正好压在别的卡片上，那就挡住内容了。
// 四个都压到的话用上方兜底——总得摆在某处。
function positionCribsheetStyleBar() {
    const bar = document.getElementById('cribsheet-style-panel');
    const page = document.getElementById('cribsheet-page');
    if (!bar || !page || !cribsheetStylePanelTargetId) return;

    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${cribsheetStylePanelTargetId}"]`);
    if (!el) {
        hideCribsheetStylePanel();
        return;
    }

    const pageRect = page.getBoundingClientRect();
    // 隐藏态用的是 visibility 不是 display:none，所以这里量得到真实宽高
    const barW = bar.offsetWidth;
    const barH = bar.offsetHeight;

    const gap = 10;      // 工具条和卡片之间留的缝
    const margin = 6;    // 离纸边至少留这么多

    // 换算成"相对纸张左上角"的坐标
    const toPageRect = (node) => {
        const r = node.getBoundingClientRect();
        return {
            left: r.left - pageRect.left,
            top: r.top - pageRect.top,
            right: r.right - pageRect.left,
            bottom: r.bottom - pageRect.top
        };
    };

    // 多选时工具条要浮在【整个选区】外侧，所以取所有选中卡片的外接矩形。
    // 只按锚点那一张算的话，工具条可能正好落在选区里另一张卡上面
    const selected = getCribsheetSelectedItems();
    const selectedRects = (selected.length > 0 ? selected : [el]).map(toPageRect);

    const item = selectedRects.reduce((box, r) => ({
        left: Math.min(box.left, r.left),
        top: Math.min(box.top, r.top),
        right: Math.max(box.right, r.right),
        bottom: Math.max(box.bottom, r.bottom)
    }), { ...selectedRects[0] });

    // 避让的对象是【没被选中】的卡片。选区里的卡片不参与——
    // 它们已经被算进上面那个外接矩形了，再当障碍物会让四个方向全部落空
    const selectedSet = new Set(selected.length > 0 ? selected : [el]);
    const others = Array.from(document.querySelectorAll('#cribsheet-grid .grid-stack-item'))
        .filter(node => !selectedSet.has(node))
        .map(toPageRect);

    const centerLeft = item.left + (item.right - item.left) / 2 - barW / 2;
    const centerTop = item.top + (item.bottom - item.top) / 2 - barH / 2;

    const candidates = [
        { left: centerLeft, top: item.top - gap - barH, below: false },   // 上
        { left: centerLeft, top: item.bottom + gap, below: true },        // 下
        { left: item.right + gap, top: centerTop, below: false },         // 右
        { left: item.left - gap - barW, top: centerTop, below: false }    // 左
    ];

    const clamp = (c) => {
        const left = Math.min(
            Math.max(margin, c.left),
            Math.max(margin, pageRect.width - barW - margin)
        );
        const top = Math.min(
            Math.max(margin, c.top),
            Math.max(margin, pageRect.height - barH - margin)
        );
        return { left, top, right: left + barW, bottom: top + barH, below: c.below };
    };

    let chosen = null;
    for (const c of candidates) {
        const box = clamp(c);
        // 夹进纸内之后可能已经偏离原意（比如"上方"被压回纸内变成压在卡片上），
        // 所以要连卡片自己一起算进碰撞检测
        const hitsOthers = others.some(o => rectsOverlap(box, o));
        const hitsSelf = rectsOverlap(box, item);
        if (!hitsOthers && !hitsSelf) {
            chosen = box;
            break;
        }
    }

    // 四个位置都被占：用上方兜底，挡住一点也比不显示好
    if (!chosen) chosen = clamp(candidates[0]);

    bar.style.left = `${Math.round(chosen.left)}px`;
    bar.style.top = `${Math.round(chosen.top)}px`;
    bar.classList.toggle('is-below', chosen.below);
}

// 改一项样式：先把界面更新掉（点下去立刻有反应），再异步存后端。
// 存失败就回滚成改之前的值，不让界面显示一个后端并不认账的样子
// 改样式：应用到【整个选区】，不只是工具条锚定的那一张。
// 多选之后改一次字号/颜色，选中的每张卡都会变
function applyCribsheetStylePatch(patch) {
    const token = getToken();
    if (!token) return;

    // 选区为空时退回锚点那一张——加完笔记自动选中的场景走的是这条
    const ids = getCribsheetSelectedIds();
    const targets = ids.length > 0
        ? ids
        : (cribsheetStylePanelTargetId ? [cribsheetStylePanelTargetId] : []);
    if (targets.length === 0) return;

    // 整批只存一次撤销快照，否则选了 5 张就要按 5 次 Undo 才回到改之前
    pushCribsheetUndoSnapshot();

    targets.forEach(layoutId => {
        const model = cribsheetItemModels.get(layoutId);
        if (!model) return;

        // 每张卡各自记住自己的旧值——请求失败要回滚的是它自己的，
        // 不能用锚点那张的值去覆盖别人
        const previous = {};
        Object.keys(patch).forEach(key => { previous[key] = model[key]; });

        Object.assign(model, patch);
        applyCribsheetItemStyles(layoutId);

        fetch(`${APP_API_BASE}/api/cribsheet/layout-items/${layoutId}`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(patch)
        })
            .then(res => res.ok ? res.json() : Promise.reject(new Error('Style update failed')))
            .catch(error => {
                console.error('Failed to save style:', error);
                Object.assign(model, previous);
                applyCribsheetItemStyles(layoutId);
                if (layoutId === cribsheetStylePanelTargetId) {
                    syncCribsheetStylePanelControls(model);
                }
                cribsheetToast('Failed to save that change. Please try again.');
            });
    });

    // 控件只按锚点那张同步，不然多选时会来回跳
    const anchorModel = cribsheetItemModels.get(cribsheetStylePanelTargetId);
    if (anchorModel) syncCribsheetStylePanelControls(anchorModel);
}

// ---------- 画布本身（GridStack） ----------
// 纸张能放下多少行。实测算出来而不是写死——横竖版的纸高不一样
// （竖版 700×906，横版 920×711），能放的行数差了 7 行。
//
// 这个上限交给 GridStack 的 maxRow，它会拒绝把方块拖到界外，
// 也拒绝在没空间时放新方块。配合纸张的 overflow: hidden，
// 纸就真的是一张固定大小的 Letter 纸，不会越加越长
function getCribsheetMaxRow() {
    const page = document.getElementById('cribsheet-page');
    const header = document.querySelector('.cribsheet-sheet-header');
    if (!page) return 29;   // 拿不到就按竖版的值兜底

    const style = getComputedStyle(page);
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const headerH = header ? header.offsetHeight + parseFloat(getComputedStyle(header).marginBottom || 0) : 0;

    const usable = page.clientHeight - padding - headerH;
    const rows = Math.floor(usable / CRIBSHEET_CELL_HEIGHT);

    // 至少留 4 行，否则纸太小时会变成 0，什么都放不进去
    return Math.max(4, rows);
}

function initCribsheetGridStack() {
    const gridEl = document.getElementById('cribsheet-grid');
    if (!gridEl || typeof GridStack === 'undefined') return;

    // Test 分类切换会让骨架整个重新生成，旧的 GridStack 实例已经跟着旧 DOM 一起没了，
    // 这里直接重新 init 一个新的就行，不用特地去 destroy 旧的
    gridStackInstance = GridStack.init({
        column: CRIBSHEET_GRID_COLS,
        cellHeight: CRIBSHEET_CELL_HEIGHT,
        margin: 4,
        float: true,          // 自由摆放，不会自动往上挤压对齐
        minRow: 1,
        // 纸张是固定的 Letter 尺寸，装不下就不该继续往下长。
        // maxRow 让 GridStack 自己拒绝越界的拖动和放置
        maxRow: getCribsheetMaxRow(),
        resizable: { handles: 'se' } // 只留右下角一个缩放手柄，避免看着像重复的图标
    }, gridEl);

    // 每次进 Cribsheet 视图都会调用一次本函数，而 GridStack.init 对已经初始化过的元素
    // 是直接返回现有实例的，下面这些监听器却会实打实地再挂一遍——进出视图几次，
    // 拖一下卡片就会发出几个重复的 PUT。切 Test 分类时骨架整个重建，gridEl 是全新节点，
    // dataset 是空的，那时候会正常重新绑定，不受这个守卫影响。
    if (gridEl.dataset.listenerAttached) return;
    gridEl.dataset.listenerAttached = 'true';

    // 撤销快照必须在拖动/缩放【开始】的时候抓，抓的才是"改之前"的样子。
    // 原来是放在 change 事件里的，那时候位置已经变完了，存进去的是"改之后"，
    // 表现出来就是按一次 Undo 没反应、按第二次才跳回更早的状态。
    gridStackInstance.on('dragstart', () => {
        if (!isCribsheetRestoring) pushCribsheetUndoSnapshot();
        setCribsheetGridGuideVisible(true);
        setCribsheetStyleBarTracking(true);
    });
    gridStackInstance.on('resizestart', () => {
        if (!isCribsheetRestoring) pushCribsheetUndoSnapshot();
        setCribsheetGridGuideVisible(true);
        setCribsheetStyleBarTracking(true);
    });

    // 拖动/缩放过程中持续更新对齐参考线。这两个事件是跟着鼠标连续触发的，
    // 但每次只是重建几个 div，开销可以忽略
    gridStackInstance.on('drag', (event, el) => {
        if (el && el.gridstackNode) updateCribsheetAlignmentGuides(el.gridstackNode);
        positionCribsheetStyleBar();
    });
    gridStackInstance.on('resize', (event, el) => {
        if (el && el.gridstackNode) updateCribsheetAlignmentGuides(el.gridstackNode);
        positionCribsheetStyleBar();
    });

    // 拖动/缩放结束就把网格底和参考线一起收回去，平时保持白纸原样
    gridStackInstance.on('dragstop', () => {
        setCribsheetGridGuideVisible(false);
        clearCribsheetAlignmentGuides();
        setCribsheetStyleBarTracking(false);
        positionCribsheetStyleBar();
    });
    gridStackInstance.on('resizestop', () => {
        setCribsheetGridGuideVisible(false);
        clearCribsheetAlignmentGuides();
        setCribsheetStyleBarTracking(false);
        positionCribsheetStyleBar();
    });

    // 兜底：如果拖到一半鼠标移出了窗口，GridStack 的 dragstop 可能不会触发，
    // 网格底和参考线就会一直留在那儿。全局补一个 mouseup 保证它们一定收得回去
    document.addEventListener('mouseup', () => {
        setCribsheetGridGuideVisible(false);
        clearCribsheetAlignmentGuides();
        setCribsheetStyleBarTracking(false);
    });

    // 'change' 事件在拖动位置、缩放大小的时候都会触发，node 里的 x/y/w/h 就是最新的位置和尺寸
    gridStackInstance.on('change', (event, changedItems) => {
        if (isCribsheetRestoring) return;   // 程序化重建画布时也会触发，那种不用回写后端
        if (!changedItems) return;
        changedItems.forEach(node => {
            const el = node.el;
            const layoutId = el ? el.dataset.layoutId : null;
            if (!layoutId) return;
            syncCribsheetItemPosition(Number(layoutId), node.x, node.y, node.w, node.h);
        });
    });

    // 点纸张上的空白处也要取消选中。
    // gridEl 的监听只覆盖网格区域，而纸张有 20px 内边距、纸外面还有一圈工作台，
    // 点那些地方原本没有任何反应，工具条会一直挂着。
    // 工具条自己在 click 上 stopPropagation 了，所以点它不会走到这里
    const pageWrap = document.querySelector('.cribsheet-page-wrap');
    if (pageWrap) {
        pageWrap.addEventListener('click', (e) => {
            if (e.target.closest('.grid-stack-item')) return;   // 点在卡片上，交给下面那个监听处理
            if (e.target.closest('.cribsheet-style-bar')) return;
            setCribsheetSelection(null);
        });
    }

    gridEl.addEventListener('click', (e) => {
        // 双击是用来打开编辑弹窗的，它的第二下不该被当成「再点一次取消选中」，
        // 否则编辑完弹窗一关，方块已经不是选中状态了
        if (e.detail > 1) return;

        const itemEl = e.target.closest('.grid-stack-item');

        // 按住 Shift 点击 = 加入/移出选区，可以选中多张一起改样式或一起删。
        // Cmd/Ctrl 也认，两种手势用户都会试
        if (itemEl && (e.shiftKey || e.metaKey || e.ctrlKey)) {
            setCribsheetSelection(itemEl, true);
            return;
        }

        // 不按修饰键点已经选中的方块 = 取消选中，工具条跟着收起。
        // 想收起工具条不用特地点到画布空白处，再点一下这张卡就行。
        // 注意这里只在"选区里只有它一张"时才收起——多选状态下点其中一张
        // 应该是"只保留这一张"，而不是全部取消
        if (itemEl && itemEl.classList.contains('cribsheet-item-selected')
            && getCribsheetSelectedItems().length === 1) {
            setCribsheetSelection(null);
            return;
        }

        setCribsheetSelection(itemEl);
    });
}

// 选中/取消选中统一走这一个函数，顺带同步工具栏那两个按钮的亮暗状态，
// 不然选中了但按钮还是暗的、或者方块被删了按钮还亮着，就对不上了
// 选区没有单独的状态变量，就存在 DOM 的 class 上。
// 这样"当前选中了哪些"只有一个来源，不会出现状态和界面对不上的情况
function getCribsheetSelectedItems() {
    return Array.from(document.querySelectorAll('#cribsheet-grid .grid-stack-item.cribsheet-item-selected'));
}

function getCribsheetSelectedIds() {
    return getCribsheetSelectedItems()
        .map(el => Number(el.dataset.layoutId))
        .filter(id => Number.isFinite(id));
}

// additive = true 时把这张卡加入/移出选区（按住 Shift 点击），
// 否则清空选区只留这一张
function setCribsheetSelection(itemEl, additive = false) {
    if (!itemEl) {
        getCribsheetSelectedItems().forEach(el => el.classList.remove('cribsheet-item-selected'));
        hideCribsheetStylePanel();
        updateCribsheetToolbarState();
        return;
    }

    if (additive) {
        itemEl.classList.toggle('cribsheet-item-selected');
    } else {
        getCribsheetSelectedItems().forEach(el => el.classList.remove('cribsheet-item-selected'));
        itemEl.classList.add('cribsheet-item-selected');
    }

    // 工具条的锚点：刚点的那张如果还在选区里就用它，否则退回选区里的第一张。
    // 多选时工具条显示的是锚点这一张的样式值，但改动会应用到整个选区——
    // 混合选区里显示谁的值都是一种取舍，取"最后碰过的那张"最符合直觉
    const anchor = itemEl.classList.contains('cribsheet-item-selected')
        ? itemEl
        : getCribsheetSelectedItems()[0];

    if (anchor && anchor.dataset.layoutId) {
        showCribsheetStylePanel(Number(anchor.dataset.layoutId));
    } else {
        hideCribsheetStylePanel();
    }

    updateCribsheetToolbarState();
}

function updateCribsheetToolbarState() {
    const hasSelection = !!document.querySelector('#cribsheet-grid .grid-stack-item.cribsheet-item-selected');

    ['cribsheet-duplicate-selected-btn', 'cribsheet-delete-selected-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.toggle('cribsheet-btn-armed', hasSelection);
    });
}

// 拖动/缩放的时候在画布上浮出网格底，让人看清方块会吸附到哪一格；
// 平时收起来，纸就是白纸一张。网格线的间距在 CSS 里跟 GridStack 的
// 列数和 cellHeight 对齐过，改那边的配置这里也要跟着改
function setCribsheetGridGuideVisible(visible) {
    const page = document.getElementById('cribsheet-page');
    if (page) page.classList.toggle('cribsheet-show-grid', visible);
}

// 对齐参考线：拖动/缩放时，把跟其他方块对齐上的边显示出来。
//
// 这里不需要 Figma 那种"距离阈值内就算对齐"的模糊判断——GridStack 是吸附到
// 12 列整数网格的，方块坐标只可能是整数，所以对齐与否是精确的相等比较。
// 那套模糊逻辑之所以复杂，是因为自由画布上坐标连续；这个场景直接绕过去了。
//
// 比的是四条边：左、右、上、下，另外加一组中线（中线可能落在半格上，
// 所以用两倍坐标来比，避免小数相等判断）。
function updateCribsheetAlignmentGuides(activeNode) {
    const layer = document.getElementById('cribsheet-guide-layer');
    if (!layer || !gridStackInstance || !activeNode) return;

    const others = gridStackInstance.getGridItems()
        .map(el => el.gridstackNode)
        .filter(node => node && node.el !== activeNode.el);

    const aLeft = activeNode.x;
    const aRight = activeNode.x + activeNode.w;
    const aTop = activeNode.y;
    const aBottom = activeNode.y + activeNode.h;
    const aCenterX2 = activeNode.x * 2 + activeNode.w;   // 两倍横向中线
    const aCenterY2 = activeNode.y * 2 + activeNode.h;   // 两倍纵向中线

    const verticalEdges = new Set();
    const horizontalEdges = new Set();
    const verticalCenters = new Set();
    const horizontalCenters = new Set();

    others.forEach(node => {
        const left = node.x;
        const right = node.x + node.w;
        const top = node.y;
        const bottom = node.y + node.h;

        // 左边缘对上对方的左边缘或右边缘，都算对齐；右边缘同理
        if (aLeft === left || aLeft === right) verticalEdges.add(aLeft);
        if (aRight === left || aRight === right) verticalEdges.add(aRight);
        if (aTop === top || aTop === bottom) horizontalEdges.add(aTop);
        if (aBottom === top || aBottom === bottom) horizontalEdges.add(aBottom);

        if (aCenterX2 === node.x * 2 + node.w) verticalCenters.add(aCenterX2);
        if (aCenterY2 === node.y * 2 + node.h) horizontalCenters.add(aCenterY2);
    });

    const lines = [];

    verticalEdges.forEach(col => lines.push({
        cls: 'cribsheet-guide cribsheet-guide-v',
        style: `left: ${(col / CRIBSHEET_GRID_COLS) * 100}%;`
    }));
    horizontalEdges.forEach(row => lines.push({
        cls: 'cribsheet-guide cribsheet-guide-h',
        style: `top: ${row * CRIBSHEET_CELL_HEIGHT}px;`
    }));
    verticalCenters.forEach(col2 => lines.push({
        cls: 'cribsheet-guide cribsheet-guide-v cribsheet-guide-center',
        style: `left: ${(col2 / 2 / CRIBSHEET_GRID_COLS) * 100}%;`
    }));
    horizontalCenters.forEach(row2 => lines.push({
        cls: 'cribsheet-guide cribsheet-guide-h cribsheet-guide-center',
        style: `top: ${(row2 / 2) * CRIBSHEET_CELL_HEIGHT}px;`
    }));

    // 一次性替换整层，比逐条增删省事，数量也就几条，开销可以忽略
    layer.innerHTML = lines
        .map(line => `<div class="${line.cls}" style="${line.style}"></div>`)
        .join('');
}

function clearCribsheetAlignmentGuides() {
    const layer = document.getElementById('cribsheet-guide-layer');
    if (layer) layer.innerHTML = '';
}

// 画布空状态：没登录、页面空、有内容三种情况。
// 原来是直接对着容器写 textContent，那样会把里面的图标和两行文案结构整个抹掉，
// 所以改成只更新标题和副文案两个子元素
function setCribsheetCanvasEmptyState(mode) {
    const hint = document.getElementById('cribsheet-empty-hint');
    if (!hint) return;

    if (mode === 'hidden') {
        hint.style.display = 'none';
        return;
    }

    const title = document.getElementById('cribsheet-empty-title');
    const subtext = document.getElementById('cribsheet-empty-subtext');
    hint.style.display = 'block';

    if (mode === 'logged-out') {
        if (title) title.textContent = 'Log in to build your Cribsheet';
        if (subtext) subtext.textContent = 'Your page and everything on it is saved to your account, so you can pick up where you left off.';
    } else {
        if (title) title.textContent = 'Your page is empty';
        if (subtext) subtext.textContent = 'Pick a note from the library on the left to place it here. Drag to move it, or drag the bottom-right corner to resize.';
    }
}

// 拿这个用户画布上的完整布局，渲染出来
function loadMyCribsheetLayout() {
    const token = getToken();

    if (!token) {
        setCribsheetCanvasEmptyState('logged-out');
        return;
    }

    fetch(`${APP_API_BASE}/api/cribsheet/my-layout`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.json())
        .then(items => renderCribsheetGridFromData(items || []))
        .catch(error => console.error('Failed to load Cribsheet layout:', error));
}

// 把一份布局数据（数组）整个渲染到画布上——新加载页面、以及 Undo/Redo 恢复某个历史快照时都用这个
function renderCribsheetGridFromData(items) {
    if (!gridStackInstance) return;

    // 这一整段是程序化重建，GridStack 内部批量布局会连带触发 change 事件；
    // 不屏蔽的话，光是打开页面就会给每个方块发一遍 PUT，撤销栈也会被塞满无意义的快照。
    // 用 setTimeout(0) 归零，是为了等 GridStack 把这一批布局引起的事件都跑完再放开。
    isCribsheetRestoring = true;

    gridStackInstance.removeAll();
    cribsheetItemModels.clear();
    hideCribsheetStylePanel();

    setCribsheetCanvasEmptyState(items.length === 0 ? 'empty' : 'hidden');

    items.forEach(item => {
        addGridStackWidgetFromItem(item);
    });

    updateCribsheetToolbarState();

    setTimeout(() => { isCribsheetRestoring = false; }, 0);
}

function addGridStackWidgetFromItem(item) {
    if (!gridStackInstance) return;

    // 这里最外层原本也带了 grid-stack-item-content 这个 class，而 addWidget({content})
    // 本身就会再包一层同名的元素，结果 DOM 里嵌套了两层。功能上靠 .cribsheet-note-card 的
    // width/height:100% 顶住了，但双击编辑用 closest() 定位、富文本样式往哪一层写这些事情上，
    // 两层同名会直接变成不确定行为，所以这里去掉。
    const contentHTML = `
        <div class="cribsheet-note-card" title="Double-click to edit">
            <button type="button" class="cribsheet-note-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            <p class="cribsheet-note-title">${escapeHtml(item.title)}</p>
            <p class="cribsheet-note-content">${escapeHtml(item.content)}</p>
        </div>
    `;

    const el = gridStackInstance.addWidget({
        w: item.cols,
        h: item.rows,
        x: item.gridCol,
        y: item.gridRow,
        content: contentHTML
    });

    el.dataset.layoutId = item.id;

    // 新加进来的卡片播一个落下的动画。程序化重建画布时（页面加载、撤销恢复）
    // isCribsheetRestoring 是 true，那时候几十张卡一起弹会很吵，所以跳过。
    // 动画本身在 CSS 里，这里只负责挂 class，播完就摘掉，免得留在 DOM 上影响后续
    if (!isCribsheetRestoring) {
        const card = el.querySelector('.cribsheet-note-card');
        if (card) {
            card.classList.add('cribsheet-just-added');
            card.addEventListener('animationend', () => {
                card.classList.remove('cribsheet-just-added');
            }, { once: true });
        }
    }

    // 把这个方块的完整数据登记下来。位置尺寸不存在这里——那两样以 GridStack 的实时状态为准，
    // 存了反而会不同步。这里只存界面上看不出来、但重建时必须知道的东西。
    cribsheetItemModels.set(Number(item.id), {
        id: Number(item.id),
        noteId: item.noteId ?? null,
        sizeId: item.sizeId ?? null,
        isCustom: item.isCustom ?? (item.noteId == null),
        title: item.title || '',
        content: item.content || '',
        // 样式字段。null / false 表示"用 CSS 里的默认值"，不写内联样式
        fontSize: item.fontSize ?? null,
        isBold: item.isBold === true,
        isItalic: item.isItalic === true,
        textColor: item.textColor ?? null,
        backgroundColor: item.backgroundColor ?? null
    });

    applyCribsheetItemStyles(Number(item.id));

    const removeBtn = el.querySelector('.cribsheet-note-remove');
    if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCribsheetItem(Number(item.id), el);
        });
    }

    // 双击打开编辑弹窗。点右上角那个删除按钮的时候不算，避免手快点两下直接弹出编辑框
    el.addEventListener('dblclick', (e) => {
        if (e.target.closest('.cribsheet-note-remove')) return;
        openCribsheetEditModal(Number(item.id));
    });

    setCribsheetCanvasEmptyState('hidden');
}

// ---------- 跟后端同步的几个操作：加/删/挪位置，每次操作之前都先把"操作之前"的完整布局存进撤销栈 ----------
function addNoteToGrid(addContext, size) {
    const token = getToken();
    if (!token) return;   // 没登录直接退出，快照放在这之后，避免白存一份

    pushCribsheetUndoSnapshot();

    // 先找画布上一个空位（很朴素的从左到右、从上到下找空位逻辑）。
    // 找不到说明纸满了——纸是固定的 Letter 尺寸，不会为了塞下去而变长
    const pos = findFreeGridPosition(size.cols, size.rows);
    if (!pos) {
        cribsheetToast('This page is full. Move or remove a note to make room.');
        return;
    }

    const body = {
        sizeId: size.id, // 只作参考记录，加完之后可以自由缩放，不受这个限制
        cols: size.cols,
        rows: size.rows,
        gridCol: pos.x,
        gridRow: pos.y
    };
    if (addContext.noteId) {
        body.noteId = addContext.noteId;
    } else {
        body.customTitle = addContext.customTitle;
        body.customContent = addContext.customContent;
    }

    fetch(`${APP_API_BASE}/api/cribsheet/layout-items`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(res => res.json())
        .then(created => {
            addGridStackWidgetFromItem({
                id: created.id,
                noteId: addContext.noteId ?? null,   // 登记进数据模型，撤销重建时才知道这是引用笔记库的
                sizeId: size.id,
                isCustom: !addContext.noteId,
                title: addContext.customTitle ? addContext.customTitle : addContext.title,
                content: addContext.customContent !== undefined ? addContext.customContent : (cribsheetLibraryLookupContent(addContext.noteId) || ''),
                cols: size.cols,
                rows: size.rows,
                gridCol: pos.x,
                gridRow: pos.y
            });
        })
        .catch(error => {
            console.error('Failed to add note to Cribsheet:', error);
            cribsheetToast('Failed to add note. Please try again.');
        });
}

// 从缓存的笔记库数据里找一条笔记的正文内容（加完笔记后本地直接渲染用，不用再额外请求一次）
function cribsheetLibraryLookupContent(noteId) {
    if (!cribsheetLibraryCache) return '';
    for (const category of Object.keys(cribsheetLibraryCache)) {
        const found = cribsheetLibraryCache[category].find(n => n.id === noteId);
        if (found) return found.content;
    }
    return '';
}

// 很朴素地找一个能放得下这个尺寸的空位：从左上角开始按行扫描，格子本身有没有被占用
// 用一个简单的二维占用表来判断（画布上笔记数量不会很多，这样做完全够用）
function getCribsheetOccupiedRects() {
    const occupied = [];
    if (gridStackInstance) {
        gridStackInstance.getGridItems().forEach(el => {
            const node = el.gridstackNode;
            if (!node) return;
            occupied.push({ x: node.x, y: node.y, w: node.w, h: node.h });
        });
    }
    return occupied;
}

function isCribsheetAreaFree(x, y, w, h, occupied) {
    if (x < 0 || y < 0 || x + w > CRIBSHEET_GRID_COLS) return false;
    return !occupied.some(o => x < o.x + o.w && x + w > o.x && y < o.y + o.h && y + h > o.y);
}

// 找一个空位。扫描范围限制在纸张能放下的行数之内——
// 原来是扫到第 200 行，纸上放不下也照样返回位置，
// 结果卡片被塞到纸外面去，打印时看不见。
// 放不下就返回 null，由调用方提示"纸满了"
function findFreeGridPosition(w, h) {
    const occupied = getCribsheetOccupiedRects();
    const maxRow = getCribsheetMaxRow();

    for (let y = 0; y + h <= maxRow; y++) {
        for (let x = 0; x <= CRIBSHEET_GRID_COLS - w; x++) {
            if (isCribsheetAreaFree(x, y, w, h, occupied)) return { x, y };
        }
    }
    return null;
}

// 复制出来的副本优先摆在原件正下方，其次右边，都放不下再退回从头扫描找空位。
// 让副本紧挨着原件，比它突然出现在页面最上方好找得多
function findCopyGridPosition(node) {
    const occupied = getCribsheetOccupiedRects();

    const candidates = [
        { x: node.x, y: node.y + node.h },
        { x: node.x + node.w, y: node.y },
        { x: node.x, y: node.y + 1 }
    ];

    for (const c of candidates) {
        if (isCribsheetAreaFree(c.x, c.y, node.w, node.h, occupied)) return c;
    }

    return findFreeGridPosition(node.w, node.h);
}

// 复制一个方块：读它当前的完整状态，再走一遍跟"加笔记"一样的 POST 逻辑创建一份新的。
// 引用笔记库的方块，复制出来的副本也还是引用——复制这个动作不该把跟笔记库的关联弄断。
// skipSnapshot 同 deleteCribsheetItem：批量复制时由调用方统一存一份快照
function duplicateCribsheetItem(layoutId, skipSnapshot = false) {
    const token = getToken();
    if (!token) return;

    const model = cribsheetItemModels.get(Number(layoutId));
    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${layoutId}"]`);
    if (!model || !el || !el.gridstackNode) return;

    // 尺寸从 GridStack 实时读，不从数据模型读——这个方块很可能已经被自由缩放过了，
    // 数据模型里根本不存尺寸（存了反而会跟实际不同步）
    const node = el.gridstackNode;
    const pos = findCopyGridPosition(node);
    if (!pos) {
        cribsheetToast('This page is full. Move or remove a note to make room.');
        return;
    }

    if (!skipSnapshot) pushCribsheetUndoSnapshot();

    const body = {
        cols: node.w,
        rows: node.h,
        gridCol: pos.x,
        gridRow: pos.y
    };
    if (model.sizeId) body.sizeId = model.sizeId;
    if (model.noteId) {
        body.noteId = model.noteId;
    } else {
        body.customTitle = model.title;
        body.customContent = model.content;
    }

    fetch(`${APP_API_BASE}/api/cribsheet/layout-items`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(res => res.ok ? res.json() : Promise.reject(new Error('Duplicate failed')))
        .then(created => {
            addGridStackWidgetFromItem({
                id: created.id,
                noteId: model.noteId ?? null,
                sizeId: model.sizeId ?? null,
                isCustom: model.noteId == null,
                title: model.title,
                content: model.content,
                cols: node.w,
                rows: node.h,
                gridCol: pos.x,
                gridRow: pos.y
            });

            // 选中状态挪到新副本上，接着按复制就是连续复制，符合直觉
            setCribsheetSelection(document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${created.id}"]`));
        })
        .catch(error => {
            console.error('Failed to duplicate note:', error);
            cribsheetToast('Failed to duplicate note. Please try again.');
        });
}

// 拖动/缩放结束后把新的位置尺寸回写后端。撤销快照不在这里抓——
// 这个函数是被 change 事件调用的，那时候位置已经变完了，抓到的是"改之后"；
// 快照现在统一放在 dragstart / resizestart 里抓。
function syncCribsheetItemPosition(layoutId, gridCol, gridRow, cols, rows) {
    const token = getToken();
    if (!token) return;

    fetch(`${APP_API_BASE}/api/cribsheet/layout-items/${layoutId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gridCol, gridRow, cols, rows })
    }).catch(error => console.error('Failed to save new position/size:', error));
}

// skipSnapshot：批量删除时由调用方统一存一份快照，这里就不要再各存一次了，
// 否则删 5 张要按 5 次 Undo 才回到删之前
function deleteCribsheetItem(layoutId, el, skipSnapshot = false) {
    const token = getToken();
    if (!token) return;

    if (!skipSnapshot) pushCribsheetUndoSnapshot();

    fetch(`${APP_API_BASE}/api/cribsheet/layout-items/${layoutId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(() => {
            // 数据先更新掉，界面上的移除延后一点，让淡出动画播完。
            // 瞬间消失会让人怀疑是不是点错了，收一下才像是「确实删掉了」
            cribsheetItemModels.delete(Number(layoutId));
            if (cribsheetStylePanelTargetId === Number(layoutId)) hideCribsheetStylePanel();

            const card = el ? el.querySelector('.cribsheet-note-card') : null;
            const finishRemoval = () => {
                if (gridStackInstance && el) gridStackInstance.removeWidget(el);
                const remaining = document.querySelectorAll('#cribsheet-grid .grid-stack-item').length;
                setCribsheetCanvasEmptyState(remaining === 0 ? 'empty' : 'hidden');
                updateCribsheetToolbarState();
            };

            if (card) {
                card.classList.add('cribsheet-removing');
                // 用定时器而不是 animationend：万一动画因为任何原因没触发，
                // animationend 就永远等不到，卡片会留在画布上删不掉
                setTimeout(finishRemoval, 170);
            } else {
                finishRemoval();
            }
        })
        .catch(error => {
            console.error('Failed to delete note:', error);
            cribsheetToast('Failed to delete note.');
        });
}

// ---------- 工具栏：Undo / Redo / 删除选中 / 清空整页 ----------
function initCribsheetToolbarActions() {
    const undoBtn = document.getElementById('cribsheet-undo-btn');
    const redoBtn = document.getElementById('cribsheet-redo-btn');
    const duplicateBtn = document.getElementById('cribsheet-duplicate-selected-btn');
    const deleteSelectedBtn = document.getElementById('cribsheet-delete-selected-btn');
    const clearBtn = document.getElementById('cribsheet-clear-page-btn');

    if (undoBtn && !undoBtn.dataset.listenerAttached) {
        undoBtn.dataset.listenerAttached = 'true';
        undoBtn.addEventListener('click', undoCribsheet);
    }
    if (redoBtn && !redoBtn.dataset.listenerAttached) {
        redoBtn.dataset.listenerAttached = 'true';
        redoBtn.addEventListener('click', redoCribsheet);
    }
    if (duplicateBtn && !duplicateBtn.dataset.listenerAttached) {
        duplicateBtn.dataset.listenerAttached = 'true';
        duplicateBtn.addEventListener('click', () => {
            const selected = getCribsheetSelectedItems();
            if (selected.length === 0) {
                cribsheetToast('Click a note on the page first to select it.');
                return;
            }

            pushCribsheetUndoSnapshot();
            selected.forEach(el => {
                duplicateCribsheetItem(Number(el.dataset.layoutId), true);
            });
        });
    }
    if (deleteSelectedBtn && !deleteSelectedBtn.dataset.listenerAttached) {
        deleteSelectedBtn.dataset.listenerAttached = 'true';
        deleteSelectedBtn.addEventListener('click', () => {
            const selected = getCribsheetSelectedItems();
            if (selected.length === 0) {
                cribsheetToast('Click a note on the page first to select it.');
                return;
            }

            // 整批只存一次快照，然后逐个删。deleteCribsheetItem 自己也会存一次，
            // 所以传 true 让它跳过——否则删 5 张要按 5 次 Undo 才回得来
            pushCribsheetUndoSnapshot();
            selected.forEach(el => {
                deleteCribsheetItem(Number(el.dataset.layoutId), el, true);
            });
        });
    }
    if (clearBtn && !clearBtn.dataset.listenerAttached) {
        clearBtn.dataset.listenerAttached = 'true';
        clearBtn.addEventListener('click', () => {
            const confirmed = confirm('Clear the entire page? This removes every note from your Cribsheet.');
            if (!confirmed) return;

            const token = getToken();
            if (!token) return;   // 快照放在登录检查之后，没登录就不要留下一份没用的历史

            pushCribsheetUndoSnapshot();

            fetch(`${APP_API_BASE}/api/cribsheet/layout`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            })
                .then(() => renderCribsheetGridFromData([]))
                .catch(error => console.error('Failed to clear page:', error));
        });
    }
}

// ---------- Cmd/Ctrl + C / V 复制粘贴卡片 ----------
// 剪贴板是内存里的一个数组，不是系统剪贴板。
// 系统剪贴板要读权限，而且卡片是结构化数据（标题、正文、尺寸、字号、颜色），
// 塞进纯文本再解析回来不可靠。代价是不能跨标签页粘贴，这个可以接受。
let cribsheetClipboard = [];

// 把当前选区抄进剪贴板。返回是否真的抄到了东西——
// 调用方靠这个决定要不要 preventDefault
function copyCribsheetSelection() {
    const items = getCribsheetSelectedItems();
    if (items.length === 0) return false;

    cribsheetClipboard = items.map(el => {
        const model = cribsheetItemModels.get(Number(el.dataset.layoutId));
        const node = el.gridstackNode;
        if (!model || !node) return null;

        return {
            noteId: model.noteId ?? null,
            sizeId: model.sizeId ?? null,
            title: model.title,
            content: model.content,
            // 尺寸从 GridStack 实时读，不从数据模型读——卡片很可能被自由缩放过，
            // 数据模型里根本不存尺寸
            cols: node.w,
            rows: node.h,
            // 样式一起抄。复制一张调过字号颜色的卡，粘出来还是那个样子才合理
            fontSize: model.fontSize ?? null,
            isBold: !!model.isBold,
            isItalic: !!model.isItalic,
            textColor: model.textColor ?? null,
            backgroundColor: model.backgroundColor ?? null
        };
    }).filter(Boolean);

    return cribsheetClipboard.length > 0;
}

// 把剪贴板里的内容粘到画布上。
// 必须【串行】创建：findFreeGridPosition 是看当前画布找空位的，
// 一次性并发发出去的话每一张都会算到同一个位置，粘出来全叠在一起
function pasteCribsheetClipboard() {
    if (cribsheetClipboard.length === 0) return false;

    const token = getToken();
    if (!token) return false;

    // 整批只存一次快照，按一次 Undo 就能把粘贴的全部撤掉
    pushCribsheetUndoSnapshot();

    let pasteStoppedForSpace = false;

    const createOne = (entry) => {
        const pos = findFreeGridPosition(entry.cols, entry.rows);
        if (!pos) {
            // 纸满了就停下，不要把剩下的继续硬塞。
            // 只提示一次，粘 10 张弹 10 个提示很吵
            if (!pasteStoppedForSpace) {
                pasteStoppedForSpace = true;
                cribsheetToast('This page is full — some notes were not pasted.');
            }
            return Promise.resolve();
        }

        const body = {
            cols: entry.cols,
            rows: entry.rows,
            gridCol: pos.x,
            gridRow: pos.y
        };
        if (entry.sizeId) body.sizeId = entry.sizeId;
        if (entry.noteId) {
            body.noteId = entry.noteId;
        } else {
            body.customTitle = entry.title;
            body.customContent = entry.content;
        }
        if (entry.fontSize != null) body.fontSize = entry.fontSize;
        if (entry.isBold) body.isBold = true;
        if (entry.isItalic) body.isItalic = true;
        if (entry.textColor) body.textColor = entry.textColor;
        if (entry.backgroundColor) body.backgroundColor = entry.backgroundColor;

        return fetch(`${APP_API_BASE}/api/cribsheet/layout-items`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(res => res.ok ? res.json() : Promise.reject(new Error('Paste failed')))
            .then(created => {
                addGridStackWidgetFromItem({
                    id: created.id,
                    noteId: entry.noteId,
                    sizeId: entry.sizeId,
                    isCustom: entry.noteId == null,
                    title: entry.title,
                    content: entry.content,
                    cols: entry.cols,
                    rows: entry.rows,
                    gridCol: pos.x,
                    gridRow: pos.y,
                    fontSize: entry.fontSize,
                    isBold: entry.isBold,
                    isItalic: entry.isItalic,
                    textColor: entry.textColor,
                    backgroundColor: entry.backgroundColor
                });
            });
    };

    cribsheetClipboard
        .reduce((chain, entry) => chain.then(() => createOne(entry)), Promise.resolve())
        .catch(error => {
            console.error('Failed to paste notes:', error);
            cribsheetToast('Failed to paste. Please try again.');
        });

    return true;
}

function initCribsheetClipboardShortcuts() {
    if (window.__cribsheetClipboardHooked) return;   // 每次进视图都会调一次，只挂一遍
    window.__cribsheetClipboardHooked = true;

    document.addEventListener('keydown', (e) => {
        if (!(e.metaKey || e.ctrlKey)) return;

        const key = e.key.toLowerCase();
        if (key !== 'c' && key !== 'v') return;

        // 光标在输入框里的时候绝对不能劫持——搜索框、姓名/考试名、
        // 编辑弹窗里的复制粘贴必须照常工作
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

        // 只在 Cribsheet 视图开着的时候生效
        const view = document.getElementById('revision-view-cribsheet');
        if (!view || !view.classList.contains('active')) return;

        if (key === 'c') {
            // 页面上有选中的文字时优先复制文字。
            // 不这么判断的话，用户想抄卡片里的一段文本会莫名其妙地抄到整张卡
            const textSelection = window.getSelection();
            if (textSelection && textSelection.toString().trim()) return;

            if (copyCribsheetSelection()) {
                e.preventDefault();
                const n = cribsheetClipboard.length;
                cribsheetToast(`Copied ${n} note${n > 1 ? 's' : ''}.`);
            }
            return;
        }

        // preventDefault 只在真的粘了东西时才调——剪贴板为空的话
        // 应该让浏览器的默认粘贴行为继续
        if (pasteCribsheetClipboard()) e.preventDefault();
    });
}

// ---------- Undo / Redo：整份布局的快照，存在 localStorage 里，刷新页面之后也能接着撤销 ----------
// 撤销的做法比较"简单粗暴但可靠"：撤销的时候不是精确回退单个操作，而是把当前整页数据
// 拿这个快照整个覆盖重建（先清空服务器上的画布，再按快照内容一条条重新创建）——
// 这样实现起来不容易出细节 bug，代价是撤销/重做的时候会有一两次额外的网络请求，
// 对于这种不是高频操作的场景，这个取舍是划算的。
function getCribsheetUndoStack() {
    try {
        return JSON.parse(localStorage.getItem(cribsheetUndoKey())) || [];
    } catch (e) { return []; }
}
function getCribsheetRedoStack() {
    try {
        return JSON.parse(localStorage.getItem(cribsheetRedoKey())) || [];
    } catch (e) { return []; }
}
function saveCribsheetUndoStack(stack) {
    localStorage.setItem(cribsheetUndoKey(), JSON.stringify(stack.slice(-CRIBSHEET_MAX_HISTORY)));
}
function saveCribsheetRedoStack(stack) {
    localStorage.setItem(cribsheetRedoKey(), JSON.stringify(stack.slice(-CRIBSHEET_MAX_HISTORY)));
}

// 位置和尺寸从 GridStack 的实时节点读——那是它的权威来源；
// 标题/正文/noteId/sizeId 从内存里的数据模型读，不从 DOM 反推。
// 从 DOM 读的问题是只能拿到"屏幕上显示了什么"，noteId 这类不显示的字段一律丢失，
// 撤销一次引用笔记库的笔记就会被永久转成自定义笔记；阶段4C 加了富文本字段之后，
// 从 DOM 反推更是彻底不可行。
function snapshotCurrentCribsheetLayout() {
    if (!gridStackInstance) return [];
    return gridStackInstance.getGridItems().map(el => {
        const node = el.gridstackNode;
        const layoutId = Number(el.dataset.layoutId);
        const model = cribsheetItemModels.get(layoutId) || {};
        return {
            layoutId,
            noteId: model.noteId ?? null,
            sizeId: model.sizeId ?? null,
            isCustom: model.isCustom ?? true,
            title: model.title ?? '',
            content: model.content ?? '',
            fontSize: model.fontSize ?? null,
            isBold: model.isBold === true,
            isItalic: model.isItalic === true,
            textColor: model.textColor ?? null,
            backgroundColor: model.backgroundColor ?? null,
            cols: node.w,
            rows: node.h,
            gridCol: node.x,
            gridRow: node.y
        };
    });
}

// 每次真正修改画布之前调用一次，把"修改之前"的样子存进撤销栈
function pushCribsheetUndoSnapshot() {
    const stack = getCribsheetUndoStack();
    stack.push(snapshotCurrentCribsheetLayout());
    saveCribsheetUndoStack(stack);
    saveCribsheetRedoStack([]); // 一旦有新操作，之前撤销掉又想重做的路径就作废了
}

function undoCribsheet() {
    const undoStack = getCribsheetUndoStack();
    if (undoStack.length === 0) {
        cribsheetToast('Nothing to undo.');
        return;
    }

    const redoStack = getCribsheetRedoStack();
    redoStack.push(snapshotCurrentCribsheetLayout());
    saveCribsheetRedoStack(redoStack);

    const previousSnapshot = undoStack.pop();
    saveCribsheetUndoStack(undoStack);
    restoreCribsheetSnapshot(previousSnapshot);
}

function redoCribsheet() {
    const redoStack = getCribsheetRedoStack();
    if (redoStack.length === 0) {
        cribsheetToast('Nothing to redo.');
        return;
    }

    const undoStack = getCribsheetUndoStack();
    undoStack.push(snapshotCurrentCribsheetLayout());
    saveCribsheetUndoStack(undoStack);

    const nextSnapshot = redoStack.pop();
    saveCribsheetRedoStack(redoStack);
    restoreCribsheetSnapshot(nextSnapshot);
}

// 把服务器上的画布重建成快照里记录的样子：全部清空，再按快照内容一条条重新创建。
// 关键在于引用笔记库的方块要用 noteId 重建，不能一律当成自定义笔记重新写一遍标题正文——
// 那样做的话每撤销一次，跟笔记库的关联就断一次，笔记库那边改了内容也再也同步不过来。
function restoreCribsheetSnapshot(snapshot) {
    const token = getToken();
    if (!token) return;

    fetch(`${APP_API_BASE}/api/cribsheet/layout`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(() => {
            const createPromises = snapshot.map(item => {
                const body = {
                    cols: item.cols,
                    rows: item.rows,
                    gridCol: item.gridCol,
                    gridRow: item.gridRow
                };
                if (item.sizeId) body.sizeId = item.sizeId;

                // 样式跟着一起重建，不然撤销一次所有排版就没了
                if (item.fontSize) body.fontSize = item.fontSize;
                if (item.isBold) body.isBold = true;
                if (item.isItalic) body.isItalic = true;
                if (item.textColor) body.textColor = item.textColor;
                if (item.backgroundColor) body.backgroundColor = item.backgroundColor;

                if (item.noteId) {
                    body.noteId = item.noteId;
                } else {
                    body.customTitle = item.title;
                    body.customContent = item.content;
                }

                return fetch(`${APP_API_BASE}/api/cribsheet/layout-items`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                })
                    .then(res => res.json())
                    .then(created => ({ ...item, id: created.id }));
            });
            return Promise.all(createPromises);
        })
        .then(restoredItems => {
            renderCribsheetGridFromData(restoredItems.map(item => ({
                id: item.id,
                noteId: item.noteId ?? null,
                sizeId: item.sizeId ?? null,
                isCustom: item.isCustom ?? (item.noteId == null),
                title: item.title,
                content: item.content,
                fontSize: item.fontSize ?? null,
                isBold: item.isBold === true,
                isItalic: item.isItalic === true,
                textColor: item.textColor ?? null,
                backgroundColor: item.backgroundColor ?? null,
                cols: item.cols,
                rows: item.rows,
                gridCol: item.gridCol,
                gridRow: item.gridRow
            })));
        })
        .catch(error => console.error('Failed to restore snapshot:', error));
}


// ---------- 页面朝向切换（Portrait / Landscape）：只影响预览大小和打印时的纸张方向 ----------
function initCribsheetOrientationToggle() {
    const toggle = document.getElementById('cribsheet-orientation-toggle');
    const page = document.getElementById('cribsheet-page');
    if (!toggle || !page) return;
    if (toggle.dataset.listenerAttached) return; // 避免切 Test 分类导致骨架重建时重复绑定
    toggle.dataset.listenerAttached = 'true';

    toggle.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('click', () => {
            toggle.querySelectorAll('button').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const orientation = btn.dataset.orientation;
            page.classList.toggle('landscape', orientation === 'landscape');
            updatePrintOrientationStyle(orientation);

            // 纸高变了，能放的行数也变了（竖版 29 行、横版 22 行），
            // maxRow 要跟着更新，否则横版下方块能被拖到纸外面去。
            // 等 0.35s 的过渡走完再量，不然量到的是过渡中间的尺寸
            setTimeout(() => {
                if (gridStackInstance) gridStackInstance.opts.maxRow = getCribsheetMaxRow();
            }, 380);

            // 纸的宽高变了，方块跟着重排，工具条要重新算位置。
            // 等朝向切换那 0.35s 过渡走完再算，否则量到的是过渡中间的尺寸
            setTimeout(positionCribsheetStyleBar, 380);
        });
    });
}

// 打印用的纸张方向（Letter portrait / landscape）没法直接用 class 选择器控制 @page，
// 所以在打印之前动态写一个 <style> 标签，切换方向的时候同步更新它的内容
function updatePrintOrientationStyle(orientation) {
    let styleEl = document.getElementById('cribsheet-print-orientation-style');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'cribsheet-print-orientation-style';
        document.head.appendChild(styleEl);
    }

    // margin: 0 —— 纸张元素自己就是一整张物理 Letter 纸（CSS 里写的是 8.5in × 11in），
    // 页边距由纸张自己的 padding 提供。
    //
    // 之前的做法是 @page 留 0.25in 边距、再用 transform: scale() 把 700px 的纸
    // 放大到刚好填满可打印区。那条路走不通：算出来的倍数对不对没法验证，
    // 而且 Chrome 打印对话框自己还会再缩一次，两个缩放叠在一起完全不可控。
    //
    // 现在尺寸直接用英寸写死，8.5in 打印出来就是 8.5in，不需要任何换算，
    // 屏幕上看到的就是印出来的——这是由构造保证的，不依赖任何倍数算得对。
    styleEl.textContent = `@page { size: letter ${orientation}; margin: 0; }`;
}

// ---------- Save as PDF：直接调用浏览器的打印功能，选"另存为 PDF"就是导出 ----------
function initCribsheetPdfExport() {
    const btn = document.getElementById('cribsheet-pdf-btn');
    if (!btn) return;
    if (btn.dataset.listenerAttached) return;
    btn.dataset.listenerAttached = 'true';

    // 默认按 portrait 初始化一次打印方向样式，不然第一次点 Save as PDF 时可能还没设置过
    updatePrintOrientationStyle('portrait');

    btn.addEventListener('click', () => {
        window.print();
    });
}