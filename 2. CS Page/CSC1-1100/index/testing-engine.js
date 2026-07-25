// testing-engine.js


// Practice / Examination / Revision 的页面骨架内容现在放在独立的 skeleton.html 里，
// 不再硬编码在 JS 字符串里，好读好改。这里第一次调用时 fetch 一次并缓存下来，
// 之后切换 Test 分类直接复用缓存内容，不会重复发请求。
let cachedSkeletonHTML = null;

async function buildTestingPageSkeleton() {
    if (cachedSkeletonHTML !== null) {
        return cachedSkeletonHTML;
    }

    const response = await fetch('skeleton.html');
    cachedSkeletonHTML = await response.text();
    return cachedSkeletonHTML;
}

// 通用的重新触发淡入动画：先移除 animation，强制浏览器重排，再加回去，
// 用在切换题型筛选、切换 Examination 年份版本时，让内容有个过渡效果，而不是生硬地瞬间替换
function triggerFadeIn(el) {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;   // 强制重排，这一行不能删
    el.style.animation = 'contentFadeIn 0.9s ease forwards';
}

// 把数据库里的原始题型值统一格式化成"小写 + 连字符"，跟题型下拉框的选项风格保持一致
// （例如 get_output -> get-output），不管数据库里实际存的是下划线还是别的写法
function formatQuestionType(rawCategory) {
    if (!rawCategory) return rawCategory;
    return rawCategory.replace(/_/g, '-').toLowerCase();
}

// 构建单道题目的 DOM 结构（题号 + 题干代码块），样式全部交给 CSS 里的 class 处理
// options.displayNumber 有值时，题号直接显示这个序号（Practice 模式跨年份混合展示时，
// 用它做纯粹的排序序号，而不是这道题在原本那张卷子里的题号，因为不同年份的题号会重复，容易看混）
// options.showYear = true 时，会在题号旁边加一个"年份 (原始题号)"的标签，比如 "2020 (1a)"
// options.showType = true 时，会再加一个题型标签（Practice 模式选 "All" 时，混合了多种题型，用来标注每道题是什么类型）
function buildQuestionBlock(question, options = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question-block';

    const labelRow = document.createElement('div');
    labelRow.className = 'question-label-row';

    const labelP = document.createElement('p');
    labelP.className = 'question-label';
    labelP.textContent = options.displayNumber !== undefined
        ? `${options.displayNumber}.`
        : `${question.question_number}${question.subquestion_number ?? ''}.`;
    labelRow.appendChild(labelP);

    if (options.showYear && question.paper_year) {
        const yearTag = document.createElement('span');
        yearTag.className = 'question-year-tag';
        const originalNumber = `${question.question_number}${question.subquestion_number ?? ''}`;
        yearTag.textContent = `${question.paper_year} (Q${originalNumber})`;
        labelRow.appendChild(yearTag);
    }

    if (options.showType && question.question_category) {
        const typeTag = document.createElement('span');
        typeTag.className = 'question-type-tag';
        typeTag.textContent = formatQuestionType(question.question_category);
        labelRow.appendChild(typeTag);
    }

    wrapper.appendChild(labelRow);

    const questionPre = document.createElement('pre');
    questionPre.className = 'question-code';
    questionPre.textContent = question.question_description;
    wrapper.appendChild(questionPre);

    return wrapper;
}

// 获取 Practice 模式题目（新版）：按 Test 分类查询，跨所有年份混合展示，
// 可选按题型（questionCategory）筛选，每道题上标注对应的年份
function loadPracticeQuestionsByCategory(category, questionCategory) {
    const questionsWrap = document.getElementById('practice-questions');
    if (!questionsWrap) return;
    questionsWrap.innerHTML = '';

    const params = new URLSearchParams({ category });
    if (questionCategory) {
        params.set('questionCategory', questionCategory);
    }

    fetch(`${APP_API_BASE}/api/questions/practice-by-category?${params.toString()}`)
        .then(response => response.json())
        .then(data => {
            // 只有选 "All" 时（没有指定具体题型）才需要标注每道题的题型，
            // 如果已经按某个题型筛选了，所有题都是同一类型，标了也是多余信息
            const showType = !questionCategory;

            // 后端没有保证返回顺序，这里先按年份从新到旧、再按原始题号排一下，
            // 这样左边的排序序号（1, 2, 3...）才是按固定顺序来的，不是随机的
            data.sort((a, b) => {
                if (b.paper_year !== a.paper_year) return b.paper_year - a.paper_year;
                return (a.question_number ?? 0) - (b.question_number ?? 0);
            });

            data.forEach((question, index) => {
                const wrapper = buildQuestionBlock(question, { showYear: true, showType, displayNumber: index + 1 });

                if (question.question_solution) {
                    const toggleBtn = document.createElement('button');
                    toggleBtn.textContent = 'Show Solution';
                    toggleBtn.className = 'show-answer-btn';

                    const solutionPre = document.createElement('pre');
                    solutionPre.className = 'answer-code';
                    solutionPre.textContent = question.question_solution;

                    toggleBtn.addEventListener('click', () => {
                        const isHidden = !solutionPre.classList.contains('show');
                        solutionPre.classList.toggle('show', isHidden);
                        toggleBtn.textContent = isHidden ? 'Hide Solution' : 'Show Solution';
                    });

                    wrapper.appendChild(toggleBtn);
                    wrapper.appendChild(solutionPre);
                }

                questionsWrap.appendChild(wrapper);
            });

            triggerFadeIn(questionsWrap);
        })
        .catch(error => console.error('Failed to Obtain Practice Questions:', error));
}

// 绑定 Practice 题型筛选下拉框的变化事件（每次切换 Test 分类、重新生成骨架后都要重新绑定，
// 因为骨架是整个替换的，旧的 DOM 和监听器已经不存在了）
function setupPracticeFilter(category) {
    const typeSelect = document.getElementById('practice-type-select');
    if (!typeSelect) return;

    typeSelect.value = '';   // 每次切换 Test 分类，题型筛选重置为 "All"

    typeSelect.addEventListener('change', () => {
        loadPracticeQuestionsByCategory(category, typeSelect.value);
    });
}

// Testing 模式计时器状态
let testingTimerInterval = null;
let countdownEndTime = 0;        // 倒计时的目标结束时间戳（毫秒），用它反推剩余秒数，避免 setInterval 延迟导致跳过精确节点
let warned10 = false;
let warned5 = false;
let warned1 = false;
let warnedTimesUp = false;
const COUNTDOWN_TOTAL_SECONDS = 30;   // ⚠️ 测试用：30秒，正式上线记得改回 110 * 60（1小时50分钟）

// 把秒数格式化成 mm:ss
function formatMMSS(totalSeconds) {
    const safeSeconds = Math.max(totalSeconds, 0);
    const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, '0');
    const seconds = String(safeSeconds % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
}

// 获取 Examination（原 Testing）模式题目：header（标题/计时器/按钮）已经是骨架里现成的静态结构，
// 这里负责找到这些元素、重置初始状态、（第一次进入时）绑定事件，再去后端拉题目数据填进 #testing-questions
// paperTitle：banner 左边显示的考卷名称，例如 "Test 1 2020"
function loadTestingQuestions(paperId, paperTitle) {
    const header = document.getElementById('testing-header');
    const headerTitle = header ? header.querySelector('h2') : null;
    const timerDisplay = document.getElementById('testing-timer');
    const toggleTimerBtn = document.getElementById('timer-toggle-btn');
    const startBtn = document.getElementById('testing-start-btn');
    const questionsContainer = document.getElementById('testing-questions');
    const submitBtn = document.getElementById('testing-submit-btn');
    const backToTopBtn = document.getElementById('testing-back-to-top-btn');
    const retakeBtn = document.getElementById('testing-retake-btn');
    const versionWrap = document.getElementById('version-selector-wrap');

    if (!header || !headerTitle || !timerDisplay || !toggleTimerBtn || !startBtn || !questionsContainer
        || !submitBtn || !backToTopBtn || !retakeBtn) {
        return;
    }

    // 记住当前考卷的 id 和标题，供下面的 Retake 按钮使用（不能靠闭包捕获参数，
    // 因为事件监听器只在第一次绑定，如果中途切换了年份版本，闭包里的 paperId 会是旧的）
    header.dataset.currentPaperId = paperId;
    header.dataset.currentPaperTitle = paperTitle;

    // 重置成初始状态（切换 Test、切换年份版本、或点「Retake Test」重考时都会跑一遍这里）
    header.classList.remove('exam-in-progress', 'exam-finished');
    headerTitle.textContent = paperTitle;
    triggerFadeIn(headerTitle);   // 切换年份版本时，标题文字有个淡入过渡，不是瞬间跳变
    timerDisplay.className = 'testing-timer';
    timerDisplay.textContent = `Timer: ${formatMMSS(COUNTDOWN_TOTAL_SECONDS)}`;
    toggleTimerBtn.style.display = 'inline-block';   // 交卷后会被隐藏，这里重新显示回来
    toggleTimerBtn.disabled = true;
    toggleTimerBtn.textContent = 'Hide Timer';
    startBtn.disabled = false;
    startBtn.textContent = 'Start Examination';
    startBtn.style.display = 'inline-block';
    questionsContainer.style.display = 'none';
    questionsContainer.innerHTML = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'All Done!!';
    submitBtn.style.display = 'none';   // 开始考试之前不显示
    backToTopBtn.style.display = 'none';
    retakeBtn.style.display = 'none';   // 交卷之后才出现
    if (versionWrap) versionWrap.classList.remove('hide-during-exam');   // 重置掉上一轮考试期间强制隐藏的状态

    // 事件监听器只在第一次加载这批 DOM 时绑定一次，避免「Retake Test」重复调用本函数时叠加监听器
    if (header.dataset.bound !== 'true') {
        header.dataset.bound = 'true';

        toggleTimerBtn.addEventListener('click', () => {
            const isHidden = timerDisplay.classList.toggle('timer-hidden');
            toggleTimerBtn.textContent = isHidden ? 'Show Timer' : 'Hide Timer';
        });

        backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });

        startBtn.addEventListener('click', () => {
            questionsContainer.style.display = 'block';
            submitBtn.style.display = 'inline-block';
            startTestingTimer();
            submitBtn.disabled = false;
            toggleTimerBtn.disabled = false;
            startBtn.disabled = true;
            // 点击后彻底移除 Start 按钮（不只是靠 CSS 隐藏），避免依赖 class 状态
            startBtn.style.display = 'none';
            timerDisplay.classList.add('timing-active');
            header.classList.add('exam-in-progress');
            if (versionWrap) versionWrap.classList.add('hide-during-exam');   // 考试期间隐藏版本切换，避免中途换年份
            enterExamFocusMode();
        });

        submitBtn.addEventListener('click', () => {
            stopTestingTimer();

            const examStartTime = countdownEndTime - COUNTDOWN_TOTAL_SECONDS * 1000;
            const totalElapsedSeconds = Math.round((Date.now() - examStartTime) / 1000);

            // 交卷后进入批改模式：banner 左边换成 "Correction"，
            // 用时显示 + Retake 按钮留在右侧（h2 靠左，其余元素靠右，flex 自动分布）
            header.classList.remove('exam-in-progress');
            header.classList.add('exam-finished');
            headerTitle.textContent = 'Correction';

            timerDisplay.textContent = `Time Spent: ${formatMMSS(totalElapsedSeconds)}`;
            // 修复：如果考试进行中点过 Hide Timer，timer-hidden 这个 class 会一直留着，
            // 导致这里更新了文字内容，但因为 opacity:0 还是看不见，所以要连它一起清掉
            timerDisplay.classList.remove('timing-active', 'timer-overtime', 'timer-warning-10', 'timer-warning-5', 'timer-warning-1', 'timer-hidden');
            timerDisplay.classList.add('timer-finished');

            document.querySelectorAll('.testing-answer').forEach(el => {
                el.classList.add('show');
            });

            // 交卷之后，Hide Timer 和提交按钮（原来的 Turned In）都不再需要，直接移除
            toggleTimerBtn.style.display = 'none';
            submitBtn.style.display = 'none';

            // 考试已经结束，版本切换重新开放
            if (versionWrap) versionWrap.classList.remove('hide-during-exam');

            backToTopBtn.style.display = 'inline-block';
            retakeBtn.style.display = 'inline-block';
            exitExamFocusMode();
        });

        retakeBtn.addEventListener('click', () => {
            stopTestingTimer();
            // 用 header.dataset 里记录的当前 paperId/title，而不是绑定时闭包捕获的参数，
            // 避免中途切换过年份版本后，Retake 又跑回最早绑定时的那份考卷
            loadTestingQuestions(Number(header.dataset.currentPaperId), header.dataset.currentPaperTitle);
        });
    }

    fetch(`${APP_API_BASE}/api/questions/practice/${paperId}`)
        .then(response => response.json())
        .then(data => {
            data.forEach(question => {
                const wrapper = buildQuestionBlock(question);

                if (question.question_solution) {
                    const solutionPre = document.createElement('pre');
                    solutionPre.className = 'answer-code testing-answer';
                    solutionPre.textContent = question.question_solution;
                    wrapper.appendChild(solutionPre);
                }

                questionsContainer.appendChild(wrapper);
            });

            triggerFadeIn(questionsContainer);
        })
        .catch(error => console.error('Failed to Obtain Testing Questions:', error));
}

// 侧边小提示条（替代浏览器原生 alert），不需要点确认，3秒后自动消失
function showExamToast(message) {
    const toast = document.createElement('div');
    toast.className = 'exam-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('exam-toast-hide');
        toast.addEventListener('animationend', () => toast.remove(), { once: true });
    }, 3000);
}

// 把秒数显示在计时器上；正常倒计时显示「Timer」，超时后显示「Overtime」（超时状态不闪烁，只是持续变红）
function renderTimerDisplay(totalSeconds) {
    const timerDisplay = document.getElementById('testing-timer');
    if (!timerDisplay) return;

    if (totalSeconds >= 0) {
        timerDisplay.textContent = `Timer: ${formatMMSS(totalSeconds)}`;
        timerDisplay.classList.remove('timer-overtime');
    } else {
        timerDisplay.textContent = `Overtime: ${formatMMSS(-totalSeconds)}`;
        timerDisplay.classList.remove('timer-warning-10', 'timer-warning-5', 'timer-warning-1');
        timerDisplay.classList.add('timer-overtime');
    }
}

// 倒计时阶段，检查是否到达提醒节点
function checkCountdownWarning(remainingSeconds) {
    const timerDisplay = document.getElementById('testing-timer');

    if (remainingSeconds <= 20 && !warned10) {   // ⚠️ 测试用：20秒节点，正式上线记得改回 10 * 60
        warned10 = true;
        if (timerDisplay) timerDisplay.classList.add('timer-warning-10');
        showExamToast('10 minutes remaining!');
    }

    if (remainingSeconds <= 10 && !warned5) {   // ⚠️ 测试用：10秒节点，正式上线记得改回 5 * 60
        warned5 = true;
        if (timerDisplay) timerDisplay.classList.add('timer-warning-5');
        showExamToast('5 minutes remaining!');
    }

    if (remainingSeconds <= 5 && !warned1) {   // ⚠️ 测试用：5秒节点，正式上线记得改回 1 * 60
        warned1 = true;
        if (timerDisplay) timerDisplay.classList.add('timer-warning-1');
        showExamToast('1 minute remaining!');
    }
}

// 启动 Testing 倒计时：从 COUNTDOWN_TOTAL_SECONDS 开始往下计，归零后不停止，继续往上计显示超时时长
function startTestingTimer() {
    stopTestingTimer();
    warned10 = false;
    warned5 = false;
    warned1 = false;
    warnedTimesUp = false;

    countdownEndTime = Date.now() + COUNTDOWN_TOTAL_SECONDS * 1000;
    renderTimerDisplay(COUNTDOWN_TOTAL_SECONDS);

    testingTimerInterval = setInterval(() => {
        const remainingSeconds = Math.round((countdownEndTime - Date.now()) / 1000);
        renderTimerDisplay(remainingSeconds);

        if (remainingSeconds > 0) {
            checkCountdownWarning(remainingSeconds);
        } else if (!warnedTimesUp) {
            warnedTimesUp = true;
            showExamToast("Time's up!");
        }
    }, 1000);
}

// 停止 Testing 计时器
function stopTestingTimer() {
    if (testingTimerInterval) {
        clearInterval(testingTimerInterval);
        testingTimerInterval = null;
    }
}