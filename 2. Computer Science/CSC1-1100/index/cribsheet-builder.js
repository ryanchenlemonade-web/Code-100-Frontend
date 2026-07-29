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
const CRIBSHEET_GRID_COLS = 12;
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
let pendingCribsheetAdd = null; // 记录当前"选尺寸"弹窗是给哪条内容用的：{noteId} 或 {customTitle, customContent}

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
    initCribsheetSizeModal();
    initCribsheetEditModal();
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
                openCribsheetSizeModal({ noteId: note.id, title: note.title });
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
        openCribsheetSizeModal({ customTitle: title, customContent: content, title });
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

function initCribsheetSizeModal() {
    const cancelBtn = document.getElementById('cribsheet-size-modal-cancel');
    if (!cancelBtn || cancelBtn.dataset.listenerAttached) return;
    cancelBtn.dataset.listenerAttached = 'true';

    cancelBtn.addEventListener('click', () => {
        document.getElementById('cribsheet-size-modal-backdrop').style.display = 'none';
        pendingCribsheetAdd = null;
    });
}

function openCribsheetSizeModal(addContext) {
    pendingCribsheetAdd = addContext;

    const backdrop = document.getElementById('cribsheet-size-modal-backdrop');
    const titleEl = document.getElementById('cribsheet-size-modal-title');
    const optionsEl = document.getElementById('cribsheet-size-options');

    titleEl.textContent = `Choose a starting size for "${addContext.title}"`;
    optionsEl.innerHTML = '<p class="cribsheet-size-hint">You can freely resize it after adding.</p>';

    (cribsheetNoteSizesCache || []).forEach(size => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cribsheet-size-option';
        btn.innerHTML = `<span class="cribsheet-size-option-name">${escapeHtml(size.name)}</span><span class="cribsheet-size-option-dims">${size.cols} \u00d7 ${size.rows}</span>`;
        btn.addEventListener('click', () => {
            backdrop.style.display = 'none';
            addNoteToGrid(pendingCribsheetAdd, size);
            pendingCribsheetAdd = null;
        });
        optionsEl.appendChild(btn);
    });

    if ((cribsheetNoteSizesCache || []).length === 0) {
        optionsEl.innerHTML = '<p class="cribsheet-empty-hint">No sizes have been set up yet. Ask an admin to add some in the Admin panel.</p>';
    }

    backdrop.style.display = 'flex';
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
}

function closeCribsheetEditModal() {
    const backdrop = document.getElementById('cribsheet-edit-modal-backdrop');
    if (backdrop) backdrop.style.display = 'none';
    pendingCribsheetEditId = null;
}

function openCribsheetEditModal(layoutId) {
    if (!getToken()) return;

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

    backdrop.style.display = 'flex';
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

    if (sizeSelect) {
        sizeSelect.addEventListener('change', () => {
            applyCribsheetStylePatch({ fontSize: sizeSelect.value === '' ? null : Number(sizeSelect.value) });
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

}

// 把面板上的控件同步成这个方块当前的实际样式
function syncCribsheetStylePanelControls(model) {
    const sizeSelect = document.getElementById('cribsheet-style-size');
    const boldBtn = document.getElementById('cribsheet-style-bold');
    const italicBtn = document.getElementById('cribsheet-style-italic');
    const textColor = document.getElementById('cribsheet-style-text-color');
    const bgColor = document.getElementById('cribsheet-style-bg-color');

    if (sizeSelect) sizeSelect.value = model.fontSize ? String(model.fontSize) : '';
    if (boldBtn) boldBtn.classList.toggle('active', model.isBold === true);
    if (italicBtn) italicBtn.classList.toggle('active', model.isItalic === true);

    // 没设过颜色的时候，色块显示的是 CSS 里的默认值，只是给个参考，
    // 数据模型里仍然是 null（不写内联样式）
    if (textColor) textColor.value = model.textColor || '#333333';
    if (bgColor) bgColor.value = model.backgroundColor || '#f5f9fd';
}

function showCribsheetStylePanel(layoutId) {
    const panel = document.getElementById('cribsheet-style-panel');
    const model = cribsheetItemModels.get(Number(layoutId));
    if (!panel || !model) return;
    if (!getToken()) return;   // 改样式要发 PUT，没登录就别把工具条亮出来了

    const isSwitching = cribsheetStylePanelTargetId !== null
        && cribsheetStylePanelTargetId !== Number(layoutId);

    cribsheetStylePanelTargetId = Number(layoutId);
    syncCribsheetStylePanelControls(model);

    positionCribsheetStyleBar();

    // 从一张卡换到另一张时，工具条是滑过去的（CSS 里 left/top 有过渡），
    // 不销毁重建，所以不会闪。第一次出现则是淡入
    if (!isSwitching) {
        // 先让浏览器把上面算出的位置应用掉，再加显示 class，
        // 否则淡入会从上一次的旧位置飘过来
        void panel.offsetWidth;
    }
    panel.classList.add('is-visible');
}

function hideCribsheetStylePanel() {
    const panel = document.getElementById('cribsheet-style-panel');
    if (panel) panel.classList.remove('is-visible');
    cribsheetStylePanelTargetId = null;
}

// 把工具条摆到选中方块的正上方居中。
// 坐标全部相对纸张算——纸是 position: relative，工具条是它的 absolute 子元素，
// 所以不需要碰视口坐标，也就不受祖先 transform、页面滚动的影响。
function positionCribsheetStyleBar() {
    const bar = document.getElementById('cribsheet-style-panel');
    const page = document.getElementById('cribsheet-page');
    if (!bar || !page || !cribsheetStylePanelTargetId) return;

    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${cribsheetStylePanelTargetId}"]`);
    if (!el) {
        hideCribsheetStylePanel();
        return;
    }

    const itemRect = el.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();

    // 隐藏态用的是 visibility 不是 display:none，所以这里量得到真实宽高
    const barWidth = bar.offsetWidth;
    const barHeight = bar.offsetHeight;

    const gap = 10;      // 工具条和方块之间留的缝
    const margin = 6;    // 离纸边至少留这么多

    const centerX = itemRect.left - pageRect.left + itemRect.width / 2;
    const itemTop = itemRect.top - pageRect.top;
    const itemBottom = itemTop + itemRect.height;

    // 默认摆上方；上面塞不下就翻到下方
    let top = itemTop - gap - barHeight;
    let isBelow = false;
    if (top < margin) {
        top = itemBottom + gap;
        isBelow = true;
    }
    // 上下都塞不下（方块几乎占满整张纸）就压回纸内，别跑出去
    if (top + barHeight > pageRect.height - margin) {
        top = Math.max(margin, pageRect.height - barHeight - margin);
    }

    // 水平方向夹在纸的左右边界内。工具条是 translateX(-50%) 居中的，所以按半宽夹
    const half = barWidth / 2;
    const left = Math.min(
        Math.max(centerX, half + margin),
        Math.max(half + margin, pageRect.width - half - margin)
    );

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
    bar.classList.toggle('is-below', isBelow);
}

// 拖动/缩放期间工具条要即时跟随，位置过渡会拖后腿，用这个 class 临时关掉
function setCribsheetStyleBarTracking(tracking) {
    const bar = document.getElementById('cribsheet-style-panel');
    if (bar) bar.classList.toggle('is-tracking', tracking);
}

// 改一项样式：先把界面更新掉（点下去立刻有反应），再异步存后端。
// 存失败就回滚成改之前的值，不让界面显示一个后端并不认账的样子
function applyCribsheetStylePatch(patch) {
    const layoutId = cribsheetStylePanelTargetId;
    if (!layoutId) return;

    const token = getToken();
    if (!token) return;

    const model = cribsheetItemModels.get(layoutId);
    if (!model) return;

    const previous = {};
    Object.keys(patch).forEach(key => { previous[key] = model[key]; });

    pushCribsheetUndoSnapshot();

    Object.assign(model, patch);
    applyCribsheetItemStyles(layoutId);
    syncCribsheetStylePanelControls(model);

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
            syncCribsheetStylePanelControls(model);
            cribsheetToast('Failed to save that change. Please try again.');
        });
}

// ---------- 画布本身（GridStack） ----------
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

    gridEl.addEventListener('click', (e) => {
        // 双击是用来打开编辑弹窗的，它的第二下不该被当成「再点一次取消选中」，
        // 否则编辑完弹窗一关，方块已经不是选中状态了
        if (e.detail > 1) return;

        const itemEl = e.target.closest('.grid-stack-item');

        // 点已经选中的方块 = 取消选中，工具条跟着收起。
        // 想收起工具条不用特地点到画布空白处，再点一下这张卡就行
        if (itemEl && itemEl.classList.contains('cribsheet-item-selected')) {
            setCribsheetSelection(null);
            return;
        }

        setCribsheetSelection(itemEl);
    });
}

// 选中/取消选中统一走这一个函数，顺带同步工具栏那两个按钮的亮暗状态，
// 不然选中了但按钮还是暗的、或者方块被删了按钮还亮着，就对不上了
function setCribsheetSelection(itemEl) {
    document.querySelectorAll('#cribsheet-grid .grid-stack-item')
        .forEach(el => el.classList.remove('cribsheet-item-selected'));

    if (itemEl) itemEl.classList.add('cribsheet-item-selected');

    if (itemEl && itemEl.dataset.layoutId) {
        showCribsheetStylePanel(Number(itemEl.dataset.layoutId));
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

    // 先找画布上一个空位（很朴素的从左到右、从上到下找空位逻辑）
    const pos = findFreeGridPosition(size.cols, size.rows);

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

function findFreeGridPosition(w, h) {
    const occupied = getCribsheetOccupiedRects();

    for (let y = 0; y < 200; y++) {
        for (let x = 0; x <= CRIBSHEET_GRID_COLS - w; x++) {
            if (isCribsheetAreaFree(x, y, w, h, occupied)) return { x, y };
        }
    }
    return { x: 0, y: 0 };
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
function duplicateCribsheetItem(layoutId) {
    const token = getToken();
    if (!token) return;

    const model = cribsheetItemModels.get(Number(layoutId));
    const el = document.querySelector(`#cribsheet-grid .grid-stack-item[data-layout-id="${layoutId}"]`);
    if (!model || !el || !el.gridstackNode) return;

    // 尺寸从 GridStack 实时读，不从数据模型读——这个方块很可能已经被自由缩放过了，
    // 数据模型里根本不存尺寸（存了反而会跟实际不同步）
    const node = el.gridstackNode;
    const pos = findCopyGridPosition(node);

    pushCribsheetUndoSnapshot();

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

function deleteCribsheetItem(layoutId, el) {
    const token = getToken();
    if (!token) return;

    pushCribsheetUndoSnapshot();

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
            const selected = document.querySelector('#cribsheet-grid .grid-stack-item.cribsheet-item-selected');
            if (!selected) {
                cribsheetToast('Click a note on the page first to select it.');
                return;
            }
            duplicateCribsheetItem(Number(selected.dataset.layoutId));
        });
    }
    if (deleteSelectedBtn && !deleteSelectedBtn.dataset.listenerAttached) {
        deleteSelectedBtn.dataset.listenerAttached = 'true';
        deleteSelectedBtn.addEventListener('click', () => {
            const selected = document.querySelector('#cribsheet-grid .grid-stack-item.cribsheet-item-selected');
            if (!selected) {
                cribsheetToast('Click a note on the page first to select it.');
                return;
            }
            deleteCribsheetItem(Number(selected.dataset.layoutId), selected);
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
    styleEl.textContent = `@page { size: letter ${orientation}; margin: 0.6in; }`;
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