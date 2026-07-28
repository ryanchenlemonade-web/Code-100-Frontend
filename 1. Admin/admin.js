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
function initSidebarNav() {
    document.querySelectorAll('.admin-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.admin-nav-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.admin-section').forEach(s => s.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(`section-${btn.dataset.section}`).classList.add('active');
        });
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
function initAdminApp() {
    if (adminAppInitialized) return;
    adminAppInitialized = true;

    initSidebarNav();
    initQuestionBank();
    initCribsheetLibrary();
    initNoteSizes();
    initUserManagement();
}


// ============================================================
// Note Sizes
// ============================================================
function initNoteSizes() {

    let allSizes = [];

    const form = document.getElementById('note-size-form');
    const nameInput = document.getElementById('note-size-name-input');
    const colsInput = document.getElementById('note-size-cols-input');
    const rowsInput = document.getElementById('note-size-rows-input');
    const tableBody = document.getElementById('note-sizes-table-body');

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function loadSizes() {
        try {
            const response = await adminFetch(`${API_BASE}/admin/note-sizes`);
            allSizes = await response.json();
            renderSizesTable();
        } catch (error) {
            console.error('Failed to load note sizes:', error);
            showToast('Failed to load note sizes.', true);
        }
    }

    function renderSizesTable() {
        if (allSizes.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="empty-state">No sizes yet.</td></tr>`;
            return;
        }

        tableBody.innerHTML = allSizes.map(s => `
            <tr>
                <td>${s.id}</td>
                <td>${escapeHTML(s.name || '')}</td>
                <td>${s.cols}</td>
                <td>${s.rows}</td>
                <td>
                    <div class="row-actions">
                        <button class="delete-btn" data-id="${s.id}">Delete</button>
                    </div>
                </td>
            </tr>
        `).join('');

        tableBody.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteSize(Number(btn.dataset.id)));
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const name = nameInput.value.trim();
        const cols = Number(colsInput.value);
        const rows = Number(rowsInput.value);

        if (!name || !cols || !rows || cols < 1 || cols > 12) {
            showToast('Name is required, Columns must be 1-12, Rows must be a positive number.', true);
            return;
        }

        try {
            await adminFetch(`${API_BASE}/admin/note-sizes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, cols, rows })
            });
            showToast(`Size "${name}" added.`);
            form.reset();
            await loadSizes();
        } catch (error) {
            console.error('Failed to add size:', error);
            showToast('Failed to add size.', true);
        }
    });

    async function deleteSize(id) {
        const size = allSizes.find(s => s.id === id);
        const confirmed = confirm(`Delete size "${size ? size.name : id}"?\n\nNote: any notes already placed on a student's Cribsheet using this size will show incorrectly next time they load their canvas.`);
        if (!confirmed) return;

        try {
            await adminFetch(`${API_BASE}/admin/note-sizes/${id}`, { method: 'DELETE' });
            showToast(`Size #${id} deleted.`);
            await loadSizes();
        } catch (error) {
            console.error('Failed to delete size:', error);
            showToast('Failed to delete size.', true);
        }
    }

    loadSizes();
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
    const questionDescriptionInput = document.getElementById('question-description-input');
    const questionSolutionInput = document.getElementById('question-solution-input');
    const submitBtn = document.getElementById('submit-btn');
    const cancelEditBtn = document.getElementById('cancel-edit-btn');

    const filterPaperSelect = document.getElementById('filter-paper-select');
    const filterCategorySelect = document.getElementById('filter-category-select');
    const filterSearchInput = document.getElementById('filter-search-input');
    const questionsCountEl = document.getElementById('questions-count');
    const questionsFoldersEl = document.getElementById('questions-folders');

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
        const existingPaper = allPapers.find(p => p.paper_category === category && p.paper_year === year);
        if (existingPaper) return existingPaper.id;

        const response = await adminFetch(`${API_BASE}/papers`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paper_category: category, paper_year: year })
        });
        const createdPaper = await response.json();
        allPapers.push(createdPaper);
        return createdPaper.id;
    }

    async function loadPapers() {
        try {
            const response = await adminFetch(`${API_BASE}/papers`);
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
            const response = await adminFetch(`${API_BASE}/questions/admin-list`);
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
        const paperFilter = filterPaperSelect.value;
        const categoryFilter = filterCategorySelect.value;
        const searchText = filterSearchInput.value.trim().toLowerCase();

        const filtered = allQuestions.filter(q => {
            if (paperFilter && String(q.paperId) !== paperFilter) return false;
            if (categoryFilter && q.question_category !== categoryFilter) return false;
            if (searchText && !q.question_description?.toLowerCase().includes(searchText)) return false;
            return true;
        });

        questionsCountEl.textContent = `Showing ${filtered.length} of ${allQuestions.length} questions`;

        if (filtered.length === 0) {
            questionsFoldersEl.innerHTML = `<p class="empty-state">No questions match your filters.</p>`;
            return;
        }

        const groupsByCategory = {};
        filtered.forEach(q => {
            const category = q.testCategory || 'Unknown Paper';
            if (!groupsByCategory[category]) groupsByCategory[category] = [];
            groupsByCategory[category].push(q);
        });

        const sortedCategories = Object.keys(groupsByCategory).sort(
            (a, b) => categorySortKey(a) - categorySortKey(b)
        );

        questionsFoldersEl.innerHTML = sortedCategories.map(category => {
            const questionsInCategory = groupsByCategory[category];

            questionsInCategory.sort((a, b) => {
                if ((a.year || 0) !== (b.year || 0)) return (b.year || 0) - (a.year || 0);
                return (a.question_number ?? 0) - (b.question_number ?? 0);
            });

            const rowsHTML = questionsInCategory.map(q => {
                const descriptionSnippet = (q.question_description || '').slice(0, 100)
                    + (q.question_description && q.question_description.length > 100 ? '…' : '');

                return `
                    <tr>
                        <td>${q.id}</td>
                        <td>${category} (${q.year ?? ''})</td>
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
            }).join('');

            return `
                <details class="paper-folder">
                    <summary>${category} <span class="folder-count">(${questionsInCategory.length})</span></summary>
                    <table>
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>Paper</th>
                                <th>#</th>
                                <th>Sub</th>
                                <th>Type</th>
                                <th>Topic</th>
                                <th>Description</th>
                                <th>Actions</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHTML}</tbody>
                    </table>
                </details>
            `;
        }).join('');

        questionsFoldersEl.querySelectorAll('.edit-btn').forEach(btn => {
            btn.addEventListener('click', () => enterEditMode(Number(btn.dataset.id)));
        });
        questionsFoldersEl.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', () => deleteQuestion(Number(btn.dataset.id)));
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
        questionDescriptionInput.value = question.question_description ?? '';
        questionSolutionInput.value = question.question_solution ?? '';

        formTitle.textContent = `Edit Question #${question.id}`;
        submitBtn.textContent = 'Update Question';
        cancelEditBtn.style.display = 'inline-block';
        formCard.classList.add('editing');

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

    // ---------- 图片扫描（OCR） ----------
    const scanImageInput = document.getElementById('scan-image-input');
    const scanImageBtn = document.getElementById('scan-image-btn');
    const scanStatus = document.getElementById('scan-status');

    scanImageBtn.addEventListener('click', async () => {
        const file = scanImageInput.files[0];
        if (!file) {
            scanStatus.textContent = 'Please choose an image first.';
            scanStatus.className = 'scan-status error';
            return;
        }

        scanImageBtn.disabled = true;
        scanStatus.className = 'scan-status';
        scanStatus.textContent = 'Scanning... 0%';

        try {
            const result = await Tesseract.recognize(file, 'eng', {
                logger: (info) => {
                    if (info.status === 'recognizing text') {
                        scanStatus.textContent = `Scanning... ${Math.round(info.progress * 100)}%`;
                    }
                }
            });

            const extractedText = result.data.text.trim();

            if (!extractedText) {
                scanStatus.textContent = 'No text detected. Try a clearer image.';
                scanStatus.className = 'scan-status error';
            } else {
                questionDescriptionInput.value = extractedText;
                scanStatus.textContent = 'Done! Please review the text below for accuracy — OCR is not perfect, especially with code formatting.';
                scanStatus.className = 'scan-status success';
            }
        } catch (error) {
            console.error('OCR failed:', error);
            scanStatus.textContent = 'Scan failed. Please try again.';
            scanStatus.className = 'scan-status error';
        }

        scanImageBtn.disabled = false;
    });

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

        const payload = {
            paperId: paperId,
            question_number: Number(questionNumberInput.value),
            subquestion_number: subquestionNumberInput.value.trim(),
            question_category: questionCategorySelect.value,
            topic: questionTopicInput.value.trim(),
            question_description: questionDescriptionInput.value,
            question_solution: questionSolutionInput.value,
            course: 'CSCI-1100'
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

    filterPaperSelect.addEventListener('change', renderQuestionsTable);
    filterCategorySelect.addEventListener('change', renderQuestionsTable);
    filterSearchInput.addEventListener('input', renderQuestionsTable);

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
            console.error('Failed to load notes:', error);
            showToast('Failed to load notes.', true);
        }
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
        const payload = { category, title, content, course: 'CSCI-1100' };

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