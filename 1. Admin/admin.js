// admin.js

const API_BASE = APP_API_BASE + '/api';
const ADMIN_KEY_STORAGE = 'code100_admin_key';

// ---------- 密钥门禁 ----------
const adminKeyGate = document.getElementById('admin-key-gate');
const adminApp = document.getElementById('admin-app');
const adminKeyInput = document.getElementById('admin-key-input');
const adminKeySubmit = document.getElementById('admin-key-submit');
const adminKeyError = document.getElementById('admin-key-error');

function getAdminKey() {
    return localStorage.getItem(ADMIN_KEY_STORAGE) || '';
}

// 所有 admin 接口都用这个包一层 fetch，自动带上密钥请求头，
// 401 的话统一处理成"密钥不对，退回门禁页面"，不用每个调用点各自判断
async function adminFetch(url, options = {}) {
    const headers = Object.assign({}, options.headers, { 'X-Admin-Key': getAdminKey() });
    const response = await fetch(url, Object.assign({}, options, { headers }));

    if (response.status === 401) {
        localStorage.removeItem(ADMIN_KEY_STORAGE);
        adminApp.style.display = 'none';
        adminKeyGate.style.display = 'flex';
        adminKeyError.textContent = 'Session expired or key is invalid. Please re-enter it.';
        throw new Error('Invalid admin key');
    }

    return response;
}

async function tryEnterAdmin(key) {
    localStorage.setItem(ADMIN_KEY_STORAGE, key);
    try {
        // 用一个真实的 admin 接口验证密钥对不对，而不是只在前端本地判断
        const response = await fetch(`${API_BASE}/admin/users`, {
            headers: { 'X-Admin-Key': key }
        });
        if (response.ok) {
            adminKeyGate.style.display = 'none';
            adminApp.style.display = 'flex';
            adminKeyError.textContent = '';
            initAdminApp();
        } else {
            localStorage.removeItem(ADMIN_KEY_STORAGE);
            adminKeyError.textContent = 'Incorrect admin key.';
        }
    } catch (error) {
        console.error('Failed to validate admin key:', error);
        localStorage.removeItem(ADMIN_KEY_STORAGE);
        adminKeyError.textContent = 'Could not reach the backend. Is it running?';
    }
}

adminKeySubmit.addEventListener('click', () => {
    const key = adminKeyInput.value.trim();
    if (!key) return;
    tryEnterAdmin(key);
});
adminKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') adminKeySubmit.click();
});

// 页面打开时，如果之前存过密钥，先自动试一下，不用每次都重新输
(function attemptAutoLogin() {
    const savedKey = getAdminKey();
    if (savedKey) {
        adminKeyInput.value = savedKey;
        tryEnterAdmin(savedKey);
    }
})();

// ---------- 侧边栏切换 ----------
// 切到某个 section(顶部导航高亮 + 只显示对应面板)。抽出来复用:
// 侧栏点击用它,列表里点 Edit 也用它跳到 "Add Question" 表单页。
function showAdminSection(name) {
    document.querySelectorAll('.admin-nav-item').forEach(b =>
        b.classList.toggle('active', b.dataset.section === name));
    document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
    const sec = document.getElementById(`section-${name}`);
    if (sec) sec.classList.add('active');
}

function initSidebarNav() {
    document.querySelectorAll('.admin-nav-item').forEach(btn => {
        btn.addEventListener('click', () => showAdminSection(btn.dataset.section));
    });
}

// 小提示条，右下角弹出，几秒后自动消失
function showToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.className = 'admin-toast' + (isError ? ' error' : '');
    toast.textContent = message;
    document.getElementById('toast-container').appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3500);
}

// 整个 Admin App 只在密钥验证通过之后才初始化一次，避免重复绑定监听器
let adminAppInitialized = false;
// ============================================================
// 课程上下文（全局）
// ============================================================
// course 是贯穿题库 / 试卷 / Cribsheet 的作用域。当前选中的课程存 localStorage，
// 【同步可读】——各 section 初始化时立刻能拿到，不必等下拉框那个异步填充。
// 下拉里"有哪些课程"才是异步的（从已有试卷的 course 去重而来）。
const ADMIN_COURSE_STORAGE = 'code100_admin_course';
const DEFAULT_ADMIN_COURSE = 'CSCI-1100';
const courseChangeListeners = [];

function escapeHTMLAttr(str) {
    return String(str ?? '').replace(/[&<>"']/g, s =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

function getAdminCourse() {
    return localStorage.getItem(ADMIN_COURSE_STORAGE) || DEFAULT_ADMIN_COURSE;
}

function setAdminCourse(course) {
    if (!course) return;
    localStorage.setItem(ADMIN_COURSE_STORAGE, course);
    courseChangeListeners.forEach(cb => { try { cb(course); } catch (e) { console.error(e); } });
}

// 各 section 注册回调，课程一变就按新课程重载自己的数据
function onAdminCourseChange(cb) {
    courseChangeListeners.push(cb);
}

async function initCourseSwitcher() {
    const select = document.getElementById('admin-course-select');
    const addBtn = document.getElementById('admin-course-add');
    if (!select || !addBtn) return;

    async function loadCourseOptions(selected) {
        let courses = [];
        try {
            const res = await adminFetch(`${API_BASE}/papers`);   // 不带 course = 全部课程
            const papers = await res.json();
            courses = [...new Set(papers.map(p => p.course).filter(Boolean))];
        } catch (e) {
            console.error('Failed to load courses:', e);
        }
        // 兜底：默认课程 + 当前选中课程一定要在选项里，
        // 否则刚新建、还没有卷子的课程会选不中（select.value 落空）
        [DEFAULT_ADMIN_COURSE, selected].forEach(c => {
            if (c && !courses.includes(c)) courses.push(c);
        });
        courses.sort();
        select.innerHTML = courses.map(c =>
            `<option value="${escapeHTMLAttr(c)}">${escapeHTMLAttr(c)}</option>`).join('');
        select.value = selected;
    }

    await loadCourseOptions(getAdminCourse());

    select.addEventListener('change', () => setAdminCourse(select.value));

    addBtn.addEventListener('click', async () => {
        const name = (prompt('New course code (e.g. MATH-1010):') || '').trim();
        if (!name) return;
        setAdminCourse(name);            // 立刻切过去（哪怕这门课还没有卷子）
        await loadCourseOptions(name);   // 把新课程并进下拉并选中
    });

    // 别处（如果以后有）切换课程时，让下拉框显示的值跟上
    onAdminCourseChange(course => { if (select.value !== course) select.value = course; });
}

function initAdminApp() {
    if (adminAppInitialized) return;
    adminAppInitialized = true;

    // 课程切换器先起：它异步填充下拉，但 getAdminCourse() 是同步的，
    // 下面各 section 初始化时立刻就能按当前课程拉数据
    initCourseSwitcher();

    initSidebarNav();
    initQuestionBank();
    initExamImport();
    initCribsheetLibrary();
    initUserManagement();
}

// ============================================================
// Import Exam (AI 批量导入)
// ============================================================
// 粘贴整张卷 -> POST /api/admin/parse-exam(AI 解析)-> 渲染成可编辑卡 -> 复核 ->
// "Create all" 逐条走现有 POST /api/questions 创建。创建部分复用现有建题接口,不新增。
function initExamImport() {
    const parseBtn = document.getElementById('import-parse-btn');
    if (!parseBtn || parseBtn.dataset.wired) return;
    parseBtn.dataset.wired = '1';

    const statusEl = document.getElementById('import-status');
    const resultsEl = document.getElementById('import-results');

    const setStatus = (msg, isErr = false) => {
        statusEl.textContent = msg || '';
        statusEl.classList.toggle('is-error', !!isErr);
    };

    // ---------- 文件上传 ----------
    // 只收图片:【不 OCR】,转 base64 让后端的视觉模型直接看图(比 OCR 准得多)。
    // 图片累积在 importImages 里(每项 {name, b64}),复核卡片由 Parse 结果生成。
    const fileInput = document.getElementById('import-file');
    const fileListEl = document.getElementById('import-file-list');
    let importImages = [];   // [{name, b64}] —— b64 不含 data: 前缀

    // 已选文件渲染成一排可删的小卡片:能单独删、能继续加。
    // 已解析过的图打勾+变淡(Parse 时会跳过它们),只解析新加入的。
    function renderFileList() {
        fileListEl.innerHTML = '';
        if (!importImages.length) return;
        importImages.forEach((img, i) => {
            const chip = document.createElement('span');
            chip.className = 'import-file-chip' + (img.parsed ? ' is-parsed' : '');
            chip.innerHTML = `<i class="fa-regular ${img.parsed ? 'fa-circle-check' : 'fa-image'}"></i><span class="import-file-name"></span>
                              <button type="button" class="import-file-remove" title="Remove">✕</button>`;
            chip.querySelector('.import-file-name').textContent = img.name || `image ${i + 1}`;
            if (img.parsed) chip.title = 'Already parsed';
            chip.querySelector('.import-file-remove').addEventListener('click', () => {
                importImages.splice(i, 1);
                renderFileList();
            });
            fileListEl.appendChild(chip);
        });
        const pending = importImages.filter(x => !x.parsed).length;
        const count = document.createElement('span');
        count.className = 'import-file-count';
        count.textContent = pending
            ? `${pending} new image${pending === 1 ? '' : 's'} to parse — click Parse.`
            : 'All images parsed.';
        fileListEl.appendChild(count);
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => {
                const s = String(r.result || '');
                const comma = s.indexOf(',');       // 去掉 "data:image/...;base64," 前缀
                resolve(comma >= 0 ? s.slice(comma + 1) : s);
            };
            r.onerror = reject;
            r.readAsDataURL(file);
        });
    }

    if (fileInput && !fileInput.dataset.wired) {
        fileInput.dataset.wired = '1';
        fileInput.addEventListener('change', async () => {
            const files = [...fileInput.files];
            if (!files.length) return;
            fileInput.disabled = true;
            try {
                for (const f of files) {
                    if (f.type.startsWith('image/')) {
                        importImages.push({ name: f.name, b64: await fileToBase64(f), parsed: false });
                    }
                }
                renderFileList();
            } catch (err) {
                console.error('File read failed:', err);
                setStatus('Could not read that file.', true);
            } finally {
                fileInput.disabled = false;
                fileInput.value = '';   // 允许再次选同一个文件
            }
        });
    }

    parseBtn.addEventListener('click', async () => {
        if (!importImages.length) { setStatus('Upload exam image(s) first.', true); return; }
        // 只解析【还没解析过】的新图;已解析的卡片和你的改动都原样保留,新卡片追加在后面。
        const pending = importImages.filter(x => !x.parsed);
        if (!pending.length) { setStatus('No new images to parse — add more first.', true); return; }

        parseBtn.disabled = true;
        setStatus(`AI reading ${pending.length} new image${pending.length === 1 ? '' : 's'}… this can take a while.`);
        try {
            const res = await adminFetch(`${API_BASE}/admin/parse-exam`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ images: pending.map(x => x.b64) })
            });
            const data = await res.json();
            const questions = (data && Array.isArray(data.questions)) ? data.questions : [];
            if (!res.ok || !questions.length) {
                setStatus((data && data.error) || 'No questions parsed. Try fewer pages at once.', true);
                return;
            }
            pending.forEach(x => { x.parsed = true; });   // 标记这些图已解析
            renderFileList();
            appendImportRows(questions);                   // 追加,不清空已有卡片
            const total = resultsEl.querySelectorAll('.import-q-card').length;
            setStatus(`Added ${questions.length} — ${total} question${total === 1 ? '' : 's'} ready to review.`);
            showToast(`✨ AI parsed ${questions.length} question${questions.length === 1 ? '' : 's'} — review below, then create.`);
        } catch (err) {
            console.error('Parse exam failed:', err);
            setStatus('Parse failed — is the backend running?', true);
            showToast('Parse failed — is the backend running?', true);
        } finally {
            parseBtn.disabled = false;
        }
    });

    const TYPES = ['one-liners', 'debugging', 'get-output', 'half-program', 'full-program', 'mcq'];

    // ---------- 导入文本格式清理(确定性,不靠 AI) ----------
    // 把每行末尾的 #1 #2 #3… 行号标记补空格【竖向对齐成一列】。只在至少两行带标记时才对齐,
    // 且要求标记前有空白(避免误伤 x=5#1 这种);普通 Python 注释 "# text" 不是 #数字,不受影响。
    function alignLineTags(text) {
        const lines = String(text).replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''));
        const re = /^(.*?)[ \t]+(#\d+)$/;
        const parsed = lines.map(l => {
            const m = l.match(re);
            return m ? { code: m[1].replace(/[ \t]+$/, ''), tag: m[2] } : null;
        });
        if (parsed.filter(Boolean).length < 2) return lines.join('\n');
        const maxCode = Math.max(...parsed.filter(Boolean).map(p => p.code.length));
        // 像原试卷那样:#号统一顶到一个【靠右的固定列】(至少第 44 列),代码短也照样把 # 甩到右边;
        // 只有当某行代码比这还长时,才以"最长行 + 2"为准,免得撞上。
        const tagCol = Math.max(maxCode + 2, 44);
        return lines.map((l, i) => parsed[i] ? parsed[i].code.padEnd(tagCol, ' ') + parsed[i].tag : l).join('\n');
    }

    // 把 AI 输出的 Markdown 竖线表格【确定性对齐】成整齐的 ASCII 表格(列宽取每列最长,补空格 + 表头下划线)。
    // 靠"表头行 + 紧跟一条 --- 分隔行"来精确识别,避免把 Python 里的 `a | b`(位或/集合并)误判成表格。
    function alignTables(text) {
        const lines = String(text).split('\n');
        const sepRe = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;   // | --- | --- | ...
        const splitRow = (line) => {
            let s = line.trim();
            if (s.startsWith('|')) s = s.slice(1);
            if (s.endsWith('|')) s = s.slice(0, -1);
            return s.split('|').map(c => c.trim());
        };
        const out = [];
        for (let i = 0; i < lines.length; i++) {
            if (i + 1 < lines.length && lines[i].includes('|') && sepRe.test(lines[i + 1])) {
                const rows = [splitRow(lines[i])];
                let j = i + 2;
                while (j < lines.length && lines[j].includes('|') && !sepRe.test(lines[j])) {
                    rows.push(splitRow(lines[j])); j++;
                }
                const cols = Math.max(...rows.map(r => r.length));
                rows.forEach(r => { while (r.length < cols) r.push(''); });
                const w = [];
                for (let c = 0; c < cols; c++) w[c] = Math.max(...rows.map(r => r[c].length));
                const fmt = r => r.map((c, k) => c.padEnd(w[k])).join(' | ');
                out.push(fmt(rows[0]));
                out.push(w.map(width => '-'.repeat(width)).join('-+-'));   // 表头下划线,+ 对齐竖线
                for (let k = 1; k < rows.length; k++) out.push(fmt(rows[k]));
                i = j - 1;
            } else {
                out.push(lines[i]);
            }
        }
        return out.join('\n');
    }

    // 整体清理:统一换行、剥掉 AI 偶尔套的 ```代码块围栏、去掉外层多余空行、对齐表格、再对齐行号。
    function cleanupImportedText(text) {
        if (text == null) return '';
        let t = String(text).replace(/\r\n/g, '\n');
        const fenced = t.match(/^\s*```[^\n]*\n([\s\S]*?)\n```\s*$/);
        if (fenced) t = fenced[1];
        t = t.replace(/^\n+/, '').replace(/\n+$/, '');
        // 兜底:去掉开头残留的"题号 + 分值注记"——分值已单独入库,题干不重复。
        // 例:"4. (15 points) Write…" / "(20 points total; 4 each) …" -> 直接从正题开始。
        t = t.replace(/^\s*(?:\d+\.\s*)?\(\s*\d+\s*points?\b[^)]*\)\s*/i, '');
        t = alignTables(t);
        return alignLineTags(t);
    }

    // 顶部创建栏【只建一次】(归卷 Test/Year + 一键批改题型/知识点 + Create all)。
    // 增量解析时保留它,这样 Test/Year 选择和一键设置都不会被后续 Parse 冲掉。
    function ensureCreatebar() {
        let bar = document.getElementById('import-createbar');
        if (bar) return bar;
        bar = document.createElement('div');
        bar.className = 'import-createbar';
        bar.id = 'import-createbar';
        const setAllTypeOpts = ['<option value="">Set all types…</option>']
            .concat(TYPES.map(t => `<option value="${t}">${t}</option>`)).join('');
        bar.innerHTML = `
            <div class="import-createbar-assign">
                <label>Test
                    <select id="import-bar-test">
                        <option value="Test 1">Test 1</option>
                        <option value="Test 2">Test 2</option>
                        <option value="Test 3">Test 3</option>
                        <option value="Final Test">Final Test</option>
                    </select>
                </label>
                <label>Year
                    <input type="number" id="import-bar-year" placeholder="e.g. 2024" min="1990" max="2100">
                </label>
            </div>
            <div class="import-createbar-bulk">
                <select id="import-setall-type" title="Set every question's type at once">${setAllTypeOpts}</select>
                <span class="import-bulk-topic">
                    <input type="text" id="import-setall-topic" placeholder="Set all topics…">
                    <input type="number" id="import-setall-points" placeholder="pts" min="0" step="1" title="Set every question's points at once">
                    <button type="button" id="import-setall-topic-btn">Apply</button>
                </span>
            </div>
            <button type="button" class="admin-primary-btn" id="import-create-all">Create all</button>
            <span class="import-status" id="import-create-status"></span>`;
        resultsEl.appendChild(bar);

        // 一键设所有题型:选中即刷新每张卡的题型下拉(含后来追加的卡)
        bar.querySelector('#import-setall-type').addEventListener('change', (e) => {
            const val = e.target.value;
            if (!val) return;
            resultsEl.querySelectorAll('.import-q-card .imp-type').forEach(sel => { sel.value = val; });
        });
        // 一键设所有知识点/分值:点 Apply(或回车)。只应用【填了的】那个,留空的不动。
        const applyBulk = () => {
            const topicVal = bar.querySelector('#import-setall-topic').value.trim();
            const ptsVal = bar.querySelector('#import-setall-points').value.trim();
            if (topicVal !== '') resultsEl.querySelectorAll('.import-q-card .imp-topic').forEach(inp => { inp.value = topicVal; });
            if (ptsVal !== '') resultsEl.querySelectorAll('.import-q-card .imp-points').forEach(inp => { inp.value = ptsVal; });
        };
        bar.querySelector('#import-setall-topic-btn').addEventListener('click', applyBulk);
        const bulkEnter = (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulk(); } };
        bar.querySelector('#import-setall-topic').addEventListener('keydown', bulkEnter);
        bar.querySelector('#import-setall-points').addEventListener('keydown', bulkEnter);
        // 同一个按钮两种角色:还有没建的 -> Create;全建完了 -> Clear all(一键清空重来)
        bar.querySelector('#import-create-all').addEventListener('click', () => {
            const btn = document.getElementById('import-create-all');
            if (btn.dataset.mode === 'clear') clearAllImport();
            else createAll();
        });
        return bar;
    }

    // Create 按钮:还有没建的 -> "Create all N"(蓝);全建完了 -> "Clear all"(红,一键清空)。
    function updateCreateCount() {
        const btn = document.getElementById('import-create-all');
        if (!btn) return;
        const total = resultsEl.querySelectorAll('.import-q-card').length;
        if (total === 0) { resultsEl.innerHTML = ''; return; }   // 卡片删光了,顺手把创建栏也收掉
        const pending = resultsEl.querySelectorAll('.import-q-card:not(.import-q-done)').length;
        if (pending > 0) {
            btn.textContent = `Create all ${pending}`;
            btn.dataset.mode = 'create';
            btn.classList.remove('import-clear-mode');
        } else {
            btn.textContent = '🗑 Clear all';
            btn.dataset.mode = 'clear';
            btn.classList.add('import-clear-mode');
        }
    }

    // 一键清空:复核卡片 + 已解析的图全清掉,回到干净状态,方便直接录下一套卷。
    function clearAllImport() {
        resultsEl.innerHTML = '';
        importImages = [];
        renderFileList();
        if (fileInput) fileInput.value = '';
        setStatus('');
        showToast('Cleared — ready for the next exam.');
    }

    // 追加渲染新解析出的卡片(不清空已有卡片,也不动创建栏)
    function appendImportRows(questions) {
        ensureCreatebar();
        questions.forEach((q) => {
            const card = document.createElement('section');
            card.className = 'card import-q-card';
            const typeOpts = TYPES.map(t =>
                `<option value="${t}"${(q.questionCategory || '') === t ? ' selected' : ''}>${t}</option>`).join('');
            card.innerHTML = `
                <div class="import-q-head">
                    <span class="import-q-badge">Q</span>
                    <input type="number" class="imp-num" value="${escapeHTMLAttr(q.questionNumber ?? '')}" placeholder="#" title="Question number">
                    <input type="text" class="imp-sub" value="${escapeHTMLAttr(q.subquestionNumber ?? '')}" placeholder="a" maxlength="3" title="Subquestion (a/b/c)">
                    <select class="imp-type">${typeOpts}</select>
                    <input type="text" class="imp-topic" value="${escapeHTMLAttr(q.topic ?? '')}" placeholder="Topic (optional)">
                    <input type="number" class="imp-points" value="${escapeHTMLAttr(q.points ?? '')}" placeholder="pts" min="0" step="1" title="Points">
                    <button type="button" class="import-remove" title="Remove this one">✕</button>
                </div>
                <label>Main intro <span class="import-label-soft">(shared lead-in for this question's parts — optional)</span></label>
                <textarea class="imp-intro" rows="2">${escapeHTMLAttr(cleanupImportedText(q.mainIntro))}</textarea>
                <label>Question</label>
                <textarea class="imp-desc" rows="5">${escapeHTMLAttr(cleanupImportedText(q.questionDescription))}</textarea>
                <label>Solution</label>
                <textarea class="imp-sol" rows="3">${escapeHTMLAttr(cleanupImportedText(q.questionSolution))}</textarea>
            `;
            card.querySelector('.import-remove').addEventListener('click', () => { card.remove(); updateCreateCount(); });
            resultsEl.appendChild(card);
        });
        updateCreateCount();
    }

    async function createAll() {
        const createBtn = document.getElementById('import-create-all');
        const createStatus = document.getElementById('import-create-status');
        const category = document.getElementById('import-bar-test').value;
        const year = Number(document.getElementById('import-bar-year').value);
        if (!year || year < 1990) { createStatus.textContent = 'Set a valid Year first.'; createStatus.classList.add('is-error'); return; }

        // 只创建【还没创建过】的卡片,避免增量导入时重复建之前那批
        const cards = [...resultsEl.querySelectorAll('.import-q-card:not(.import-q-done)')];
        if (!cards.length) { createStatus.textContent = 'Nothing new to create.'; return; }

        createBtn.disabled = true;
        createStatus.classList.remove('is-error');
        const course = getAdminCourse();

        let paperId;
        try {
            paperId = await importGetOrCreatePaperId(category, year, course);
        } catch (e) {
            console.error(e);
            createStatus.textContent = 'Failed to create/find the paper.';
            createStatus.classList.add('is-error');
            createBtn.disabled = false;
            return;
        }

        let ok = 0, fail = 0;
        for (const card of cards) {
            const payload = {
                paperId,
                question_number: Number(card.querySelector('.imp-num').value) || null,
                subquestion_number: card.querySelector('.imp-sub').value.trim(),
                question_category: card.querySelector('.imp-type').value,
                topic: card.querySelector('.imp-topic').value.trim(),
                points: card.querySelector('.imp-points').value.trim() === '' ? null : Number(card.querySelector('.imp-points').value),
                main_intro: card.querySelector('.imp-intro').value.trim() || null,
                question_description: card.querySelector('.imp-desc').value,
                question_solution: card.querySelector('.imp-sol').value,
                course
            };
            createStatus.textContent = `Creating… ${ok + fail + 1}/${cards.length}`;
            try {
                const r = await adminFetch(`${API_BASE}/questions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                if (r.ok) { ok++; card.classList.add('import-q-done'); } else { fail++; }
            } catch (e) { fail++; }
        }

        createStatus.textContent = `Done — created ${ok}${fail ? `, ${fail} failed` : ''}.`;
        createBtn.disabled = false;
        updateCreateCount();   // 已建的卡片标了 import-q-done,按钮数字同步(可继续解析新图再建)
        showToast(`Imported ${ok} question${ok === 1 ? '' : 's'}${fail ? ` (${fail} failed)` : ''}.`, fail > 0);
    }

    // 找/建这门课这个 Test+Year 的试卷,返回 paperId(跟 Question Bank 那边同一套逻辑)
    async function importGetOrCreatePaperId(category, year, course) {
        const res = await adminFetch(`${API_BASE}/papers?course=${encodeURIComponent(course)}`);
        const papers = await res.json();
        const existing = (papers || []).find(p => p.paper_category === category && p.paper_year === year);
        if (existing) return existing.id;
        const created = await adminFetch(`${API_BASE}/papers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paper_category: category, paper_year: year, course })
        }).then(r => r.json());
        return created.id;
    }
}


// ============================================================
// Question Bank
// ============================================================
function initQuestionBank() {

    let allPapers = [];
    let allQuestions = [];

    const questionForm = document.getElementById('question-form');
    const formTitle = document.getElementById('form-title');
    const formCard = formTitle.closest('.card');
    const questionIdInput = document.getElementById('question-id');
    const paperCategorySelect = document.getElementById('paper-category-select');
    const paperYearInput = document.getElementById('paper-year-input');
    const questionNumberInput = document.getElementById('question-number-input');
    const subquestionNumberInput = document.getElementById('subquestion-number-input');
    const questionCategorySelect = document.getElementById('question-category-select');
    const questionTopicInput = document.getElementById('question-topic-input');
    const questionMainIntroInput = document.getElementById('question-main-intro-input');
    const questionDescriptionInput = document.getElementById('question-description-input');
    const questionSolutionInput = document.getElementById('question-solution-input');
    const questionPointsInput = document.getElementById('question-points-input');
    const questionRubricInput = document.getElementById('question-rubric-input');
    const submitBtn = document.getElementById('submit-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');

    const filterPaperSelect = document.getElementById('filter-paper-select');
    const filterCategorySelect = document.getElementById('filter-category-select');
    const filterSearchInput = document.getElementById('filter-search-input');
    const questionsCountEl = document.getElementById('questions-count');
    const questionsFoldersEl = document.getElementById('questions-folders');

    // 当前筛选(Paper/Type/搜索)下的题目——列表渲染和"删本年份"共用同一套过滤
    function currentFiltered() {
        const paperFilter = filterPaperSelect.value;
        const categoryFilter = filterCategorySelect.value;
        const searchText = filterSearchInput.value.trim().toLowerCase();
        return allQuestions.filter(q => {
            if (paperFilter && String(q.paperId) !== paperFilter) return false;
            if (categoryFilter && q.question_category !== categoryFilter) return false;
            if (searchText && !q.question_description?.toLowerCase().includes(searchText)) return false;
            return true;
        });
    }

    function formatPaperLabel(paper) {
        return `${paper.paper_category} (${paper.paper_year})`;
    }

    const KNOWN_CATEGORIES = ['Test 1', 'Test 2', 'Test 3', 'Final Test'];

    function populateCategoryOptions() {
        const extraCategories = [...new Set(allPapers.map(p => p.paper_category))]
            .filter(c => !KNOWN_CATEGORIES.includes(c));

        const categories = [...KNOWN_CATEGORIES, ...extraCategories]
            .sort((a, b) => categorySortKey(a) - categorySortKey(b));

        paperCategorySelect.innerHTML = categories
            .map(c => `<option value="${c}">${c}</option>`)
            .join('');
    }

    async function getOrCreatePaperId(category, year) {
        // allPapers 已按当前课程过滤，所以这里的 find 天然限定在本课程内。
        // 仍显式带上 course：同一个 (Test, 年份) 在不同课程下是不同的卷子
        const course = getAdminCourse();
        const existingPaper = allPapers.find(p =>
            p.paper_category === category && p.paper_year === year && p.course === course);
        if (existingPaper) return existingPaper.id;

        const response = await adminFetch(`${API_BASE}/papers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paper_category: category, paper_year: year, course })
        });
        const createdPaper = await response.json();
        allPapers.push(createdPaper);
        return createdPaper.id;
    }

    async function loadPapers() {
        try {
            // 只拉当前课程的卷子——试卷下拉、分类选项、年份都按课程作用域
            const response = await adminFetch(`${API_BASE}/papers?course=${encodeURIComponent(getAdminCourse())}`);
            allPapers = await response.json();

            allPapers.sort((a, b) => {
                if (a.paper_category !== b.paper_category) {
                    return categorySortKey(a.paper_category) - categorySortKey(b.paper_category);
                }
                return b.paper_year - a.paper_year;
            });

            populateCategoryOptions();

            const filterOptionsHTML = allPapers
                .map(p => `<option value="${p.id}">${formatPaperLabel(p)}</option>`)
                .join('');
            filterPaperSelect.innerHTML = '<option value="">All Papers</option>' + filterOptionsHTML;
        } catch (error) {
            console.error('Failed to load papers:', error);
            showToast('Failed to load papers. Is the backend running?', true);
        }
    }

    // 用新的、需要密钥的 admin-list 接口，取代原来公开无保护的 /api/questions
    async function loadQuestions() {
        try {
            // 按当前课程过滤题库列表（admin-list 支持 course 参数）
            const response = await adminFetch(`${API_BASE}/questions/admin-list?course=${encodeURIComponent(getAdminCourse())}`);
            allQuestions = await response.json();
            renderQuestionsTable();
        } catch (error) {
            console.error('Failed to load questions:', error);
            showToast('Failed to load questions.', true);
        }
    }

    function categorySortKey(category) {
        if (/final/i.test(category)) return Infinity;
        const match = category.match(/(\d+)/);
        return match ? parseInt(match[1], 10) : 999;
    }

    // 现在 admin-list 接口已经把 testCategory / year 直接带回来了，不用再自己去 allPapers 里查一遍
    function renderQuestionsTable() {
        const filtered = currentFiltered();

        // 重渲染前记下哪些文件夹是展开的,渲染后按 data-key 还原——
        // 这样删一道题(会重渲染)后,展开的 Test/年份不会被收起,页面"不跳走"。
        const prevOpen = new Set([...questionsFoldersEl.querySelectorAll('details[open]')].map(d => d.dataset.key));

        questionsCountEl.textContent = `Showing ${filtered.length} of ${allQuestions.length} questions`;

        if (filtered.length === 0) {
            questionsFoldersEl.innerHTML = `<p class="empty-state">No questions match your filters.</p>`;
            return;
        }

        // 两级分组：外层每个 Test 分类一个文件夹，内层再按年份分。
        // byCategory: { "Test 1": { 2026: [q...], 2020: [q...] }, ... }
        const byCategory = {};
        filtered.forEach(q => {
            const category = q.testCategory || 'Unknown Paper';
            const year = q.year ?? '';
            if (!byCategory[category]) byCategory[category] = {};
            if (!byCategory[category][year]) byCategory[category][year] = [];
            byCategory[category][year].push(q);
        });

        // 外层按 Test 分类排（Test 1 < 2 < 3 < Final）
        const sortedCategories = Object.keys(byCategory).sort(
            (a, b) => categorySortKey(a) - categorySortKey(b)
        );

        // 一行题目。Paper 列去掉了——外层/内层文件夹标题已经写了 Test + 年份，行里再列一遍是冗余
        const rowFor = q => {
            const descriptionSnippet = (q.question_description || '').slice(0, 100)
                + (q.question_description && q.question_description.length > 100 ? '…' : '');
            return `
                <tr>
                    <td>${q.id}</td>
                    <td>${q.question_number ?? ''}</td>
                    <td>${q.subquestion_number ?? ''}</td>
                    <td><span class="type-badge">${q.question_category ?? ''}</span></td>
                    <td>${q.topic ? escapeHTML(q.topic) : '<span class="muted">—</span>'}</td>
                    <td class="description-cell">${escapeHTML(descriptionSnippet)}</td>
                    <td>
                        <div class="row-actions">
                            <button class="edit-btn" data-id="${q.id}">Edit</button>
                            <button class="delete-btn" data-id="${q.id}">Delete</button>
                        </div>
                    </td>
                </tr>
            `;
        };

        questionsFoldersEl.innerHTML = sortedCategories.map(category => {
            const yearsMap = byCategory[category];
            const totalInCategory = Object.values(yearsMap).reduce((n, arr) => n + arr.length, 0);

            // 内层年份，新的在前
            const sortedYears = Object.keys(yearsMap).sort((a, b) => (Number(b) || 0) - (Number(a) || 0));

            const yearFoldersHTML = sortedYears.map(year => {
                const items = yearsMap[year].slice().sort((a, b) => (a.question_number ?? 0) - (b.question_number ?? 0));
                const yearLabel = year === '' ? 'No year' : year;
                const yKey = 'y:' + category + '|' + year;
                return `
                    <details class="paper-folder paper-folder-year" data-key="${escapeHTMLAttr(yKey)}"${prevOpen.has(yKey) ? ' open' : ''}>
                        <summary>${escapeHTML(String(yearLabel))} <span class="folder-count">(${items.length})</span><button type="button" class="folder-delete-btn" data-cat="${escapeHTMLAttr(category)}" data-year="${escapeHTMLAttr(String(year))}" title="Delete every question in this year">🗑 Delete all</button></summary>
                        <table>
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>#</th>
                                    <th>Sub</th>
                                    <th>Type</th>
                                    <th>Topic</th>
                                    <th>Description</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>${items.map(rowFor).join('')}</tbody>
                        </table>
                    </details>
                `;
            }).join('');

            // 首次渲染全部收起(prevOpen 为空);之后重渲染会保留用户展开的状态
            const cKey = 'c:' + category;
            return `
                <details class="paper-folder paper-folder-test" data-key="${escapeHTMLAttr(cKey)}"${prevOpen.has(cKey) ? ' open' : ''}>
                    <summary>${escapeHTML(category)} <span class="folder-count">(${totalInCategory})</span></summary>
                    <div class="paper-folder-years">${yearFoldersHTML}</div>
                </details>
            `;
        }).join('');

        questionsFoldersEl.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => enterEditMode(Number(btn.dataset.id)));
        });
        questionsFoldersEl.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteQuestion(Number(btn.dataset.id)));
        });
        // 每个年份文件夹的"删本年份全部"。按钮在 <summary> 里,阻止默认展开/收起。
        questionsFoldersEl.querySelectorAll('.folder-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                deleteYear(btn.dataset.cat, btn.dataset.year, btn);
            });
        });
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function enterEditMode(id) {
        const question = allQuestions.find(q => q.id === id);
        if (!question) return;

        questionIdInput.value = question.id;

        if (question.testCategory) paperCategorySelect.value = question.testCategory;
        if (question.year) paperYearInput.value = question.year;

        questionNumberInput.value = question.question_number ?? '';
        subquestionNumberInput.value = question.subquestion_number ?? '';
        questionCategorySelect.value = question.question_category ?? '';
        questionTopicInput.value = question.topic ?? '';
        questionMainIntroInput.value = question.main_intro ?? '';
        questionDescriptionInput.value = question.question_description ?? '';
        questionSolutionInput.value = question.question_solution ?? '';
        // points 为 null = 未设置，回填成空字符串（不是 0）；rubric 同理
        questionPointsInput.value = (question.points === null || question.points === undefined) ? '' : question.points;
        questionRubricInput.value = question.rubric ?? '';

        formTitle.textContent = `Edit Question #${question.id}`;
        submitBtn.textContent = 'Update Question';
        cancelEditBtn.style.display = 'inline-block';
        formCard.classList.add('editing');

        // 表单现在是独立的 "Add Question" 页——从 All Questions 点 Edit 时切过去,不然看不到表单
        showAdminSection('questions');
        formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function exitEditMode() {
        questionForm.reset();
        questionIdInput.value = '';
        requiredFields.forEach(field => field.classList.remove('input-error'));
        formTitle.textContent = 'Add New Question';
        submitBtn.textContent = 'Add Question';
        cancelEditBtn.style.display = 'none';
        formCard.classList.remove('editing');
    }

    cancelEditBtn.addEventListener('click', exitEditMode);

    const requiredFields = [
        paperCategorySelect,
        paperYearInput,
        questionNumberInput,
        questionCategorySelect,
        questionDescriptionInput
    ];

    requiredFields.forEach(field => {
        field.addEventListener('input', () => field.classList.remove('input-error'));
        field.addEventListener('change', () => field.classList.remove('input-error'));
    });

    function validateRequiredFields() {
        let isValid = true;
        requiredFields.forEach(field => {
            const value = field.value.trim();
            if (!value) {
                field.classList.add('input-error');
                isValid = false;
            } else {
                field.classList.remove('input-error');
            }
        });
        return isValid;
    }

    questionForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!validateRequiredFields()) {
            return;
        }

        const category = paperCategorySelect.value;
        const year = Number(paperYearInput.value);

        const id = questionIdInput.value;
        let paperId;

        try {
            paperId = await getOrCreatePaperId(category, year);
        } catch (error) {
            console.error('Failed to resolve paper:', error);
            showToast('Failed to create/find the paper for that Test and Year.', true);
            return;
        }

        // points 留空 → null（"未设置"，跟值 0 分不是一回事）；rubric 留空 → null
        const pointsRaw = questionPointsInput.value.trim();
        const rubricRaw = questionRubricInput.value.trim();

        const payload = {
            paperId: paperId,
            question_number: Number(questionNumberInput.value),
            subquestion_number: subquestionNumberInput.value.trim(),
            question_category: questionCategorySelect.value,
            topic: questionTopicInput.value.trim(),
            main_intro: questionMainIntroInput.value.trim() || null,
            question_description: questionDescriptionInput.value,
            question_solution: questionSolutionInput.value,
            points: pointsRaw === '' ? null : Number(pointsRaw),
            rubric: rubricRaw === '' ? null : rubricRaw,
            // 后端会以试卷的 course 为准覆盖这个值，这里仍显式传当前课程（语义清楚）
            course: getAdminCourse()
        };

        try {
            if (id) {
                await adminFetch(`${API_BASE}/questions/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                showToast(`Question #${id} updated.`);
            } else {
                const response = await adminFetch(`${API_BASE}/questions`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const created = await response.json();
                showToast(`Question #${created.id} added.`);
            }

            exitEditMode();
            await loadQuestions();
        } catch (error) {
            console.error('Failed to save question:', error);
            showToast('Failed to save question.', true);
        }
    });

    async function deleteQuestion(id) {
        const confirmed = confirm(`Delete question #${id}? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await adminFetch(`${API_BASE}/questions/${id}`, { method: 'DELETE' });
            showToast(`Question #${id} deleted.`);

            if (questionIdInput.value === String(id)) {
                exitEditMode();
            }

            await loadQuestions();
        } catch (error) {
            console.error('Failed to delete question:', error);
            showToast('Failed to delete question.', true);
        }
    }

    // 删掉某一个 Test·年份文件夹里(当前筛选下)的全部题目。危险操作,强确认。
    async function deleteYear(cat, yearStr, btn) {
        const list = currentFiltered().filter(q =>
            (q.testCategory || 'Unknown Paper') === cat && String(q.year ?? '') === yearStr);
        if (!list.length) return;
        const label = `${cat} · ${yearStr === '' ? 'No year' : yearStr}`;
        if (!confirm(`Delete all ${list.length} question${list.length === 1 ? '' : 's'} in ${label}? This cannot be undone.`)) return;

        if (btn) btn.disabled = true;
        let ok = 0, fail = 0;
        for (const q of list) {
            try {
                await adminFetch(`${API_BASE}/questions/${q.id}`, { method: 'DELETE' });
                ok++;
                if (questionIdInput.value === String(q.id)) exitEditMode();
            } catch (e) { fail++; }
        }
        showToast(`Deleted ${ok} from ${label}${fail ? `, ${fail} failed` : ''}.`, fail > 0);
        await loadQuestions();
    }

    filterPaperSelect.addEventListener('change', renderQuestionsTable);
    filterCategorySelect.addEventListener('change', renderQuestionsTable);
    filterSearchInput.addEventListener('input', renderQuestionsTable);

    // 切换课程：重载本课程的试卷 + 题目，并退出编辑（编辑中的题属于旧课程）
    onAdminCourseChange(async () => {
        exitEditMode();
        await loadPapers();
        await loadQuestions();
    });

    (async function initQuestions() {
        await loadPapers();
        await loadQuestions();
    })();
}


// ============================================================
// Cribsheet Library
// ============================================================
function initCribsheetLibrary() {

    let allNotes = [];

    const noteForm = document.getElementById('note-form');
    const noteFormTitle = document.getElementById('note-form-title');
    const noteIdInput = document.getElementById('note-id');
    const noteCategoryInput = document.getElementById('note-category-input');
    const noteTitleInput = document.getElementById('note-title-input');
    const noteContentInput = document.getElementById('note-content-input');
    const noteSubmitBtn = document.getElementById('note-submit-btn');
    const noteCancelEditBtn = document.getElementById('note-cancel-edit-btn');
    const notesCountEl = document.getElementById('notes-count');
    const notesTableBody = document.getElementById('notes-table-body');

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function loadNotes() {
        try {
            const response = await adminFetch(`${API_BASE}/admin/cribsheet-notes`);
            allNotes = await response.json();
            renderNotesTable();
        } catch (error) {
            // 后端还没有 /api/admin/cribsheet-notes 这套增删改接口，而且大概率
            // 【不会】再补——Cribsheet 笔记库以后打算用 AI 生成，手工管理接口没必要建
            // （见 HANDOFF）。所以拉不到就安静显示占位：不弹 toast、不刷红色 console，
            // 它不是当前在做的东西。用 console.debug（默认级别看不到）留个线索就够
            console.debug('Cribsheet note admin endpoint not implemented (on hold for AI generator).');
            allNotes = [];
            renderNotesPlaceholder();
        }
    }

    function renderNotesPlaceholder() {
        notesCountEl.textContent = '';
        notesTableBody.innerHTML =
            `<tr><td colspan="5" class="empty-state">Note management isn't wired up — this section is on hold for the planned AI cribsheet generator.</td></tr>`;
    }

    function renderNotesTable() {
        notesCountEl.textContent = `${allNotes.length} note${allNotes.length === 1 ? '' : 's'} total`;

        if (allNotes.length === 0) {
            notesTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">No notes yet.</td></tr>`;
            return;
        }

        notesTableBody.innerHTML = allNotes.map(n => `
            <tr>
                <td>${n.id}</td>
                <td>${escapeHTML(n.category || '')}</td>
                <td>${escapeHTML(n.title || '')}</td>
                <td class="description-cell">${escapeHTML((n.content || '').slice(0, 100))}${(n.content || '').length > 100 ? '…' : ''}</td>
                <td>
                    <div class="row-actions">
                        <button class="edit-btn" data-id="${n.id}">Edit</button>
                        <button class="delete-btn" data-id="${n.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');

        notesTableBody.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => enterNoteEditMode(Number(btn.dataset.id)));
        });
        notesTableBody.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteNote(Number(btn.dataset.id)));
        });
    }

    function enterNoteEditMode(id) {
        const note = allNotes.find(n => n.id === id);
        if (!note) return;

        noteIdInput.value = note.id;
        noteCategoryInput.value = note.category || '';
        noteTitleInput.value = note.title || '';
        noteContentInput.value = note.content || '';

        noteFormTitle.textContent = `Edit Note #${note.id}`;
        noteSubmitBtn.textContent = 'Update Note';
        noteCancelEditBtn.style.display = 'inline-block';

        noteForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function exitNoteEditMode() {
        noteForm.reset();
        noteIdInput.value = '';
        noteFormTitle.textContent = 'Add New Note';
        noteSubmitBtn.textContent = 'Add Note';
        noteCancelEditBtn.style.display = 'none';
    }

    noteCancelEditBtn.addEventListener('click', exitNoteEditMode);

    noteForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const category = noteCategoryInput.value.trim();
        const title = noteTitleInput.value.trim();
        const content = noteContentInput.value.trim();

        if (!category || !title || !content) {
            showToast('Category, Title, and Content are all required.', true);
            return;
        }

        const id = noteIdInput.value;
        const payload = { category, title, content, course: getAdminCourse() };

        try {
            if (id) {
                await adminFetch(`${API_BASE}/admin/cribsheet-notes/${id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                showToast(`Note #${id} updated.`);
            } else {
                const response = await adminFetch(`${API_BASE}/admin/cribsheet-notes`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const created = await response.json();
                showToast(`Note #${created.id} added.`);
            }

            exitNoteEditMode();
            await loadNotes();
        } catch (error) {
            console.error('Failed to save note:', error);
            showToast('Failed to save note.', true);
        }
    });

    async function deleteNote(id) {
        const confirmed = confirm(`Delete note #${id}? This cannot be undone.`);
        if (!confirmed) return;

        try {
            await adminFetch(`${API_BASE}/admin/cribsheet-notes/${id}`, { method: 'DELETE' });
            showToast(`Note #${id} deleted.`);

            if (noteIdInput.value === String(id)) {
                exitNoteEditMode();
            }

            await loadNotes();
        } catch (error) {
            console.error('Failed to delete note:', error);
            showToast('Failed to delete note.', true);
        }
    }

    loadNotes();
}


// ============================================================
// User Management
// ============================================================
function initUserManagement() {

    let allUsers = [];

    const userSearchInput = document.getElementById('user-search-input');
    const usersCountEl = document.getElementById('users-count');
    const usersTableBody = document.getElementById('users-table-body');

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function formatDate(isoString) {
        if (!isoString) return '—';
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    async function loadUsers(search = '') {
        try {
            const url = search
                ? `${API_BASE}/admin/users?search=${encodeURIComponent(search)}`
                : `${API_BASE}/admin/users`;
            const response = await adminFetch(url);
            allUsers = await response.json();
            renderUsersTable();
        } catch (error) {
            console.error('Failed to load users:', error);
            showToast('Failed to load users.', true);
        }
    }

    function renderUsersTable() {
        usersCountEl.textContent = `${allUsers.length} user${allUsers.length === 1 ? '' : 's'}`;

        if (allUsers.length === 0) {
            usersTableBody.innerHTML = `<tr><td colspan="5" class="empty-state">No users found.</td></tr>`;
            return;
        }

        usersTableBody.innerHTML = allUsers.map(u => `
            <tr>
                <td>${u.id}</td>
                <td>${escapeHTML(u.username || '')}</td>
                <td>${escapeHTML(u.email || '')}</td>
                <td>${formatDate(u.createdAt)}</td>
                <td>
                    <div class="row-actions">
                        <button class="edit-btn" data-id="${u.id}">Edit</button>
                        <button class="delete-btn" data-id="${u.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');

        usersTableBody.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => editUser(Number(btn.dataset.id)));
        });
        usersTableBody.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteUser(Number(btn.dataset.id)));
        });
    }

    // 简单起见，编辑用两次 prompt() 弹窗完成，不用再建一整套编辑表单/弹层
    async function editUser(id) {
        const user = allUsers.find(u => u.id === id);
        if (!user) return;

        const newUsername = prompt('Username:', user.username);
        if (newUsername === null) return; // 用户点了取消

        const newEmail = prompt('Email:', user.email);
        if (newEmail === null) return;

        try {
            await adminFetch(`${API_BASE}/admin/users/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: newUsername.trim(), email: newEmail.trim() })
            });
            showToast(`User #${id} updated.`);
            await loadUsers(userSearchInput.value.trim());
        } catch (error) {
            console.error('Failed to update user:', error);
            showToast('Failed to update user. Username or email may already be taken.', true);
        }
    }

    async function deleteUser(id) {
        const user = allUsers.find(u => u.id === id);
        const confirmed = confirm(`Delete user "${user ? user.username : id}"? This cannot be undone.\n\nThis will also permanently delete all of their activity records (starred questions, exam history, ratings, daily activity, cribsheet data, etc.).`);
        if (!confirmed) return;

        try {
            await adminFetch(`${API_BASE}/admin/users/${id}`, { method: 'DELETE' });
            showToast(`User #${id} deleted.`);
            await loadUsers(userSearchInput.value.trim());
        } catch (error) {
            console.error('Failed to delete user:', error);
            showToast('Failed to delete user.', true);
        }
    }

    let searchDebounceTimer = null;
    userSearchInput.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => loadUsers(userSearchInput.value.trim()), 300);
    });

    loadUsers();
}