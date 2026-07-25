// admin.js

const API_BASE = APP_API_BASE + '/api';

// 缓存拉回来的数据，筛选的时候直接在这份数据上过滤，不用每次都重新发请求
let allPapers = [];      // 所有试卷 [{id, paper_category, paper_year}, ...]
let allQuestions = [];   // 所有题目

// DOM 引用
const questionForm = document.getElementById('question-form');
const formTitle = document.getElementById('form-title');
const formCard = formTitle.closest('.card');
const questionIdInput = document.getElementById('question-id');
const paperCategorySelect = document.getElementById('paper-category-select');
const paperYearInput = document.getElementById('paper-year-input');
const questionNumberInput = document.getElementById('question-number-input');
const subquestionNumberInput = document.getElementById('subquestion-number-input');
const questionCategorySelect = document.getElementById('question-category-select');
const questionDescriptionInput = document.getElementById('question-description-input');
const questionSolutionInput = document.getElementById('question-solution-input');
const submitBtn = document.getElementById('submit-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

const filterPaperSelect = document.getElementById('filter-paper-select');
const filterCategorySelect = document.getElementById('filter-category-select');
const filterSearchInput = document.getElementById('filter-search-input');
const questionsCountEl = document.getElementById('questions-count');
const questionsFoldersEl = document.getElementById('questions-folders');

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

// 试卷显示成 "Test 1 (2020)" 这种格式，跟学生端保持一致
function formatPaperLabel(paper) {
    return `${paper.paper_category} (${paper.paper_year})`;
}

// Test 下拉框固定包含这四个分类，不管数据库里现在有没有对应的试卷数据 —
// 这样即使 Test 3 / Final Test 还一张卷子都没有，管理员也能直接选中它们，
// 配合下面自由填写的 Year，一起新增一张全新的卷子
const KNOWN_CATEGORIES = ['Test 1', 'Test 2', 'Test 3', 'Final Test'];

// 表单里的 Test 分类下拉框：固定的四个分类 + 数据库里如果出现了其他自定义分类，也一并列出
function populateCategoryOptions() {
    const extraCategories = [...new Set(allPapers.map(p => p.paper_category))]
        .filter(c => !KNOWN_CATEGORIES.includes(c));

    const categories = [...KNOWN_CATEGORIES, ...extraCategories]
        .sort((a, b) => categorySortKey(a) - categorySortKey(b));

    paperCategorySelect.innerHTML = categories
        .map(c => `<option value="${c}">${c}</option>`)
        .join('');
}

// 根据 Test 分类 + 年份，找到已存在的 paperId；如果这个组合在数据库里还不存在，
// 就先调后端新增一张试卷，再把新试卷加进本地缓存，返回新的 paperId
async function getOrCreatePaperId(category, year) {
    const existingPaper = allPapers.find(p => p.paper_category === category && p.paper_year === year);
    if (existingPaper) return existingPaper.id;

    const response = await fetch(`${API_BASE}/papers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paper_category: category, paper_year: year })
    });
    const createdPaper = await response.json();
    allPapers.push(createdPaper);   // 加进缓存，同一次会话里再选到同样的组合就不用重复创建了
    return createdPaper.id;
}

// 拉取所有试卷，填充表单里的 Test 下拉框，以及筛选区域的 Paper 下拉框
async function loadPapers() {
    try {
        const response = await fetch(`${API_BASE}/papers`);
        allPapers = await response.json();

        // 按分类、再按年份排序，方便别处（比如题目列表分组）复用这份缓存数据
        allPapers.sort((a, b) => {
            if (a.paper_category !== b.paper_category) {
                return categorySortKey(a.paper_category) - categorySortKey(b.paper_category);
            }
            return b.paper_year - a.paper_year;
        });

        populateCategoryOptions();

        // 筛选区域的 Paper 下拉框仍然是合并显示（"Test 1 (2020)"），一步选到具体某张卷子
        const filterOptionsHTML = allPapers
            .map(p => `<option value="${p.id}">${formatPaperLabel(p)}</option>`)
            .join('');
        filterPaperSelect.innerHTML = '<option value="">All Papers</option>' + filterOptionsHTML;
    } catch (error) {
        console.error('Failed to load papers:', error);
        showToast('Failed to load papers. Is the backend running?', true);
    }
}

// 拉取所有题目
async function loadQuestions() {
    try {
        const response = await fetch(`${API_BASE}/questions`);
        allQuestions = await response.json();
        renderQuestionsTable();
    } catch (error) {
        console.error('Failed to load questions:', error);
        showToast('Failed to load questions. Is the backend running?', true);
    }
}

// 根据 paperId 找到对应的试卷信息（分类 + 年份）
function getPaperById(paperId) {
    return allPapers.find(p => p.id === paperId);
}

// 根据 paperId 找到对应的试卷显示文字（"Test 1 (2020)"），找不到就退回显示原始 id
function getPaperLabelById(paperId) {
    const paper = getPaperById(paperId);
    return paper ? formatPaperLabel(paper) : `Paper #${paperId}`;
}

// 计算分类的排序权重：Test 1 < Test 2 < Test 3 < ... < Final Test（不管以后加多少个 Test，顺序都对）
function categorySortKey(category) {
    if (/final/i.test(category)) return Infinity;
    const match = category.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 999;
}

// 应用当前的筛选条件（Paper / Type / 关键字搜索），按 Test 分类分组渲染（每个分类一个可折叠的 folder，
// 组内按年份从新到旧排序），方便按分类找题目，不用在一整张大表里翻
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

    // 按 paper_category 分组
    const groupsByCategory = {};
    filtered.forEach(q => {
        const paper = getPaperById(q.paperId);
        const category = paper ? paper.paper_category : 'Unknown Paper';
        if (!groupsByCategory[category]) groupsByCategory[category] = [];
        groupsByCategory[category].push(q);
    });

    // 分类本身按 Test 1 -> Test 2 -> ... -> Final Test 的顺序排序
    const sortedCategories = Object.keys(groupsByCategory).sort(
        (a, b) => categorySortKey(a) - categorySortKey(b)
    );

    questionsFoldersEl.innerHTML = sortedCategories.map(category => {
        const questionsInCategory = groupsByCategory[category];

        // 组内按年份从新到旧排序，年份相同再按题号排序
        questionsInCategory.sort((a, b) => {
            const paperA = getPaperById(a.paperId);
            const paperB = getPaperById(b.paperId);
            const yearA = paperA ? paperA.paper_year : 0;
            const yearB = paperB ? paperB.paper_year : 0;
            if (yearA !== yearB) return yearB - yearA;   // 年份大的在上面
            return (a.question_number ?? 0) - (b.question_number ?? 0);
        });

        const rowsHTML = questionsInCategory.map(q => {
            const descriptionSnippet = (q.question_description || '').slice(0, 120)
                + (q.question_description && q.question_description.length > 120 ? '…' : '');

            return `
                <tr>
                    <td>${q.id}</td>
                    <td>${getPaperLabelById(q.paperId)}</td>
                    <td>${q.question_number ?? ''}</td>
                    <td>${q.subquestion_number ?? ''}</td>
                    <td><span class="type-badge">${q.question_category ?? ''}</span></td>
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
                            <th>Description</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHTML}</tbody>
                </table>
            </details>
        `;
    }).join('');

    // 每次重新渲染后，重新绑定 Edit / Delete 按钮的点击事件
    questionsFoldersEl.querySelectorAll('.edit-btn').forEach(btn => {
        btn.addEventListener('click', () => enterEditMode(Number(btn.dataset.id)));
    });
    questionsFoldersEl.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteQuestion(Number(btn.dataset.id)));
    });
}

// 防止题目描述里如果含有 <, > 等字符，被当成 HTML 标签解析
function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// 把表单切换成「编辑」模式，并把该题目的数据填进表单
function enterEditMode(id) {
    const question = allQuestions.find(q => q.id === id);
    if (!question) return;

    const paper = getPaperById(question.paperId);

    questionIdInput.value = question.id;

    if (paper) {
        paperCategorySelect.value = paper.paper_category;
        paperYearInput.value = paper.paper_year;
    }

    questionNumberInput.value = question.question_number ?? '';
    subquestionNumberInput.value = question.subquestion_number ?? '';
    questionCategorySelect.value = question.question_category ?? '';
    questionDescriptionInput.value = question.question_description ?? '';
    questionSolutionInput.value = question.question_solution ?? '';

    formTitle.textContent = `Edit Question #${question.id}`;
    submitBtn.textContent = 'Update Question';
    cancelEditBtn.style.display = 'inline-block';
    formCard.classList.add('editing');

    formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// 把表单重置回「新增」模式
function exitEditMode() {
    questionForm.reset();
    questionIdInput.value = '';
    requiredFields.forEach(field => field.classList.remove('input-error'));   // 清掉可能残留的描红
    formTitle.textContent = 'Add New Question';
    submitBtn.textContent = 'Add Question';
    cancelEditBtn.style.display = 'none';
    formCard.classList.remove('editing');
}

cancelEditBtn.addEventListener('click', exitEditMode);

// ---------- 图片扫描（OCR）：拍照/上传题目图片，自动识别文字填进 Question Description ----------
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

// 必填字段（Test / Year / Question Number / Question Type / Question Description）
// Subquestion 和 Solution 不是必填，不放进这个列表
const requiredFields = [
    paperCategorySelect,
    paperYearInput,
    questionNumberInput,
    questionCategorySelect,
    questionDescriptionInput
];

// 用户开始修正某个字段后，自动去掉描红
requiredFields.forEach(field => {
    field.addEventListener('input', () => field.classList.remove('input-error'));
    field.addEventListener('change', () => field.classList.remove('input-error'));
});

// 校验必填字段：没填的直接描红，不弹文字提示。返回 true/false 表示整体是否通过
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

// 提交表单：有 question-id 就走「更新」，没有就走「新增」
questionForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!validateRequiredFields()) {
        return;   // 没填的字段已经描红了，不需要额外弹提示
    }

    const category = paperCategorySelect.value;
    const year = Number(paperYearInput.value);

    const id = questionIdInput.value;
    let paperId;

    try {
        // 如果这个 Test + 年份的组合还没有对应的试卷，这里会自动先建一张新的
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
        question_description: questionDescriptionInput.value,
        question_solution: questionSolutionInput.value
    };

    try {
        if (id) {
            // 更新
            await fetch(`${API_BASE}/questions/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            showToast(`Question #${id} updated.`);
        } else {
            // 新增
            const response = await fetch(`${API_BASE}/questions`, {
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
        showToast('Failed to save question. Check the backend console for details.', true);
    }
});

// 删除题目
async function deleteQuestion(id) {
    const confirmed = confirm(`Delete question #${id}? This cannot be undone.`);
    if (!confirmed) return;

    try {
        await fetch(`${API_BASE}/questions/${id}`, { method: 'DELETE' });
        showToast(`Question #${id} deleted.`);

        // 如果正好在编辑这道被删掉的题，退出编辑模式，避免表单卡在一个已经不存在的题目上
        if (questionIdInput.value === String(id)) {
            exitEditMode();
        }

        await loadQuestions();
    } catch (error) {
        console.error('Failed to delete question:', error);
        showToast('Failed to delete question.', true);
    }
}

// 筛选条件变化时，直接在已缓存的数据上重新渲染，不用重新发请求
filterPaperSelect.addEventListener('change', renderQuestionsTable);
filterCategorySelect.addEventListener('change', renderQuestionsTable);
filterSearchInput.addEventListener('input', renderQuestionsTable);

// 页面加载时，先拉试卷（表单下拉框需要），再拉题目列表
(async function init() {
    await loadPapers();
    await loadQuestions();
})();