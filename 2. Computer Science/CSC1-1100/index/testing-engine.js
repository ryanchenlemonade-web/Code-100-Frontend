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

// 在题目容器里显示一个"加载中"的提示，请求还没回来之前用，避免用户以为卡住/出bug了。
// 后续拿到数据（或者报错）时，会把这块内容整个清掉替换掉，不用单独去移除它。
function showQuestionsLoading(container, message = 'Loading questions...') {
    if (!container) return;
    container.innerHTML = '';
    const loadingEl = document.createElement('div');
    loadingEl.className = 'questions-loading';
    loadingEl.textContent = message;
    container.appendChild(loadingEl);
}

// 请求失败时，把"加载中"换成一个用户能看懂的错误提示，而不是让容器一直空着/停在加载状态
function showQuestionsError(container, message = 'Failed to load questions. Please try refreshing the page.') {
    if (!container) return;
    container.innerHTML = '';
    const errorEl = document.createElement('div');
    errorEl.className = 'questions-error';
    errorEl.textContent = message;
    container.appendChild(errorEl);
}

// 把数据库里的原始题型值统一格式化成"小写 + 连字符"，跟题型下拉框的选项风格保持一致
// （例如 get_output -> get-output），不管数据库里实际存的是下划线还是别的写法
function formatQuestionType(rawCategory) {
    if (!rawCategory) return rawCategory;
    return rawCategory.replace(/_/g, '-').toLowerCase();
}

// 记录当前登录用户标过重点的题目 id（进 Practice 页面时拉一次，用来决定每道题的星标要不要默认点亮）
let starredQuestionIds = new Set();

// Revision 页面点"Go to Question"之后，要跳去 Practice 页面对应的 Test 分类并高亮这道题。
// 这个变量记一下"接下来渲染完题目列表之后要滚到哪一道"，loadPracticeQuestionsByCategory 渲染完会检查它。
let pendingScrollToQuestionId = null;

function goToQuestionInPractice(question) {
    // 反查 paper_category（比如 "Test 1"）对应的 nav id（比如 "test1"）——
    // navToCategory 这个映射定义在 cs1_index.js 里，两个文件同一个页面里跑，是全局可见的
    const navId = Object.keys(navToCategory).find(key => navToCategory[key] === question.paper_category);
    if (!navId) return;

    pendingScrollToQuestionId = question.id;

    // 点一下对应的 Test 分类按钮：会自动完成"切分类 + 把 Practice 设为可见 + 重新加载题目"这一整套逻辑，
    // 不用自己再手写一遍，直接复用现成的点击处理器
    const navItem = document.getElementById(navId);
    if (navItem) navItem.click();
}

// 调用后端切换某道题的星标状态，返回最新状态（true=已标星）
function toggleQuestionStar(questionId) {
    const token = getToken();
    if (!token) return Promise.resolve(null);

    return fetch(`${APP_API_BASE}/api/progress/questions/${questionId}/star`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : null)
        .then(data => data ? data.starred : null)
        .catch(error => {
            console.error('Failed to toggle star:', error);
            return null;
        });
}

// 记录当前登录用户给哪些题打过几星难度评分（question_id -> 1~5），进 Practice 页面时拉一次
let myRatings = new Map();

let myRatingsLoadPromise = null;
function ensureMyRatingsLoaded() {
    const token = getToken();
    if (!token) return Promise.resolve();
    if (myRatingsLoadPromise) return myRatingsLoadPromise;

    myRatingsLoadPromise = fetch(`${APP_API_BASE}/api/progress/my-ratings`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : {})
        .then(data => {
            myRatings = new Map(Object.entries(data).map(([qid, rating]) => [Number(qid), rating]));
        })
        .catch(error => console.error('Failed to load my ratings:', error));

    return myRatingsLoadPromise;
}

// 提交/更新某道题的难度评分（1~5），返回是否成功
function submitQuestionRating(questionId, rating) {
    const token = getToken();
    if (!token) return Promise.resolve(false);

    return fetch(`${APP_API_BASE}/api/progress/questions/${questionId}/rate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ rating })
    })
        .then(res => res.ok)
        .catch(error => {
            console.error('Failed to submit rating:', error);
            return false;
        });
}

// 星标切换之后，把页面上所有同一道题的星标按钮都同步一遍（Practice 和 Revision 可能同时
// 各自渲染着这道题的一份 DOM，切标签页只是显示/隐藏，不会重新加载，所以不主动同步的话，
// 另一边的星星会停留在切换前的旧状态，不会自动跟着变）
function syncAllStarButtonsForQuestion(questionId, isStarred) {
    document.querySelectorAll(`.question-block[data-question-id="${questionId}"] .question-star-btn`)
        .forEach(btn => {
            btn.classList.toggle('starred', isStarred);
            btn.title = isStarred ? 'Remove from Revision' : 'Mark as important \u2014 add to Revision';
        });
}

// 构建单道题目的 DOM 结构（题号 + 题干代码块），样式全部交给 CSS 里的 class 处理
// options.displayNumber 有值时，题号直接显示这个序号（Practice 模式跨年份混合展示时，
// 用它做纯粹的排序序号，而不是这道题在原本那张卷子里的题号，因为不同年份的题号会重复，容易看混）
// options.showYear = true 时，会在题号旁边加一个"年份 (原始题号)"的标签，比如 "2020 (1a)"
// options.showType = true 时，会再加一个题型标签（Practice 模式选 "All" 时，混合了多种题型，用来标注每道题是什么类型）
// options.showStar = true 时，会在题号那一行右边加一个可以点的星标（Revision 联动用，标了星的题目会出现在 Revision 页面）
// options.onUnstar 是个回调，只在 Revision 页面用——取消星标之后，把这道题从当前列表里移除
// options.showGoToQuestion = true 时，会加一个"Go to Question"按钮，跳到 Practice 页面对应的 Test 分类并高亮这道题
// options.showNote = true 时，题目下方会加一个小备注框（"为什么标了它"），失焦时自动保存
function buildQuestionBlock(question, options = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'question-block';
    wrapper.dataset.questionId = question.id; // 给"跳回原题"功能定位用

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

    if (options.showGoToQuestion && question.paper_category) {
        const goToBtn = document.createElement('button');
        goToBtn.type = 'button';
        goToBtn.className = 'question-goto-btn';
        goToBtn.innerHTML = '<i class="fa-solid fa-arrow-up-right-from-square"></i> Go to Question';
        goToBtn.addEventListener('click', () => goToQuestionInPractice(question));
        labelRow.appendChild(goToBtn);
    }

    if (options.showStar) {
        const starBtn = document.createElement('button');
        starBtn.type = 'button';
        starBtn.className = 'question-star-btn';
        const isStarred = starredQuestionIds.has(question.id);
        starBtn.classList.toggle('starred', isStarred);
        starBtn.innerHTML = '<i class="fa-solid fa-location-dot"></i>';
        starBtn.title = isStarred ? 'Remove from Revision' : 'Mark as important \u2014 add to Revision';

        starBtn.addEventListener('click', () => {
            if (!getToken()) {
                starBtn.title = 'Log in to save marked questions';
                return;
            }
            starBtn.disabled = true;
            toggleQuestionStar(question.id).then(nowStarred => {
                starBtn.disabled = false;
                if (nowStarred === null) return; // 请求失败/没登录，保持原状不动

                if (nowStarred) {
                    starredQuestionIds.add(question.id);
                } else {
                    starredQuestionIds.delete(question.id);
                }
                starBtn.classList.toggle('starred', nowStarred);
                starBtn.title = nowStarred ? 'Remove from Revision' : 'Mark as important \u2014 add to Revision';
                syncAllStarButtonsForQuestion(question.id, nowStarred);

                // Revision 页面里取消星标时，直接把这道题从列表里移除，不用整页重新拉一次数据
                if (!nowStarred && options.onUnstar) {
                    options.onUnstar(wrapper);
                }
            });
        });

        labelRow.appendChild(starBtn);
    }

    wrapper.appendChild(labelRow);

    const questionPre = document.createElement('pre');
    questionPre.className = 'question-code';
    questionPre.textContent = question.question_description;
    wrapper.appendChild(questionPre);

    if (options.showRating) {
        wrapper.appendChild(buildRatingWidget(question));
    }

    if (options.showNote) {
        const noteWrap = document.createElement('div');
        noteWrap.className = 'question-note-wrap';

        const noteInput = document.createElement('input');
        noteInput.type = 'text';
        noteInput.className = 'question-note-input';
        noteInput.placeholder = 'Why did you mark this question? (optional)';
        noteInput.value = question.note || '';
        noteInput.maxLength = 500;

        const noteStatus = document.createElement('span');
        noteStatus.className = 'question-note-status';

        // 失焦时自动保存，不用单独放个 Save 按钮，跟每道题写点小备注这个场景更贴合
        noteInput.addEventListener('blur', () => {
            const newValue = noteInput.value.trim();
            if (newValue === (question.note || '')) return; // 没改动就不用发请求

            const token = getToken();
            if (!token) return;

            fetch(`${APP_API_BASE}/api/progress/questions/${question.id}/note`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ note: newValue })
            })
                .then(res => res.ok ? res.json() : Promise.reject())
                .then(() => {
                    question.note = newValue;
                    noteStatus.textContent = 'Saved';
                    setTimeout(() => { noteStatus.textContent = ''; }, 2000);
                })
                .catch(() => {
                    noteStatus.textContent = 'Failed to save';
                });
        });

        noteWrap.appendChild(noteInput);
        noteWrap.appendChild(noteStatus);
        wrapper.appendChild(noteWrap);
    }

    return wrapper;
}

// Practice 页面用：5 星难度评分组件。点第几颗星就把评分设成几分（1~5），
// 已经评过的话进来就是点亮到对应位置；右边显示全站平均分 + 评分人数（静态展示，不会实时刷新，
// 想看到自己这次评分对平均分的影响，得刷新页面重新拉一次数据）
function buildRatingWidget(question) {
    const wrap = document.createElement('div');
    wrap.className = 'rating-widget';

    const starsWrap = document.createElement('div');
    starsWrap.className = 'rating-stars';

    const label = document.createElement('span');
    label.className = 'rating-label';
    label.textContent = 'Rate difficulty:';
    wrap.appendChild(label);

    let currentRating = myRatings.get(question.id) || 0;

    const starEls = [];
    for (let i = 1; i <= 5; i++) {
        const starBtn = document.createElement('button');
        starBtn.type = 'button';
        starBtn.className = 'rating-star';
        starBtn.innerHTML = '<i class="fa-solid fa-star"></i>';
        starBtn.title = `${i} star${i > 1 ? 's' : ''}`;
        starEls.push(starBtn);
        starsWrap.appendChild(starBtn);
    }

    function paintStars(uptoValue) {
        starEls.forEach((el, index) => {
            el.classList.toggle('filled', index < uptoValue);
        });
        // 整体评分对应一个颜色等级（1~5），加在容器上，CSS 靠这个 class 统一给所有点亮的星上色
        starsWrap.className = 'rating-stars' + (uptoValue > 0 ? ` rating-level-${uptoValue}` : '');
    }
    paintStars(currentRating);

    // hover 预览：划过第几颗就先亮到那，移开鼠标恢复到真实已选的评分
    starsWrap.addEventListener('mouseleave', () => paintStars(currentRating));

    starEls.forEach((starBtn, index) => {
        const value = index + 1;
        starBtn.addEventListener('mouseenter', () => paintStars(value));
        starBtn.addEventListener('click', () => {
            if (!getToken()) return;

            const previousRating = currentRating;
            currentRating = value;
            paintStars(currentRating);
            myRatings.set(question.id, currentRating);

            submitQuestionRating(question.id, value).then(success => {
                if (!success) {
                    // 保存失败就退回原来的评分，别让界面显示跟后端不一致的假象
                    currentRating = previousRating;
                    myRatings.set(question.id, previousRating);
                    paintStars(currentRating);
                }
            });
        });
    });

    wrap.appendChild(starsWrap);

    if (question.rating_count) {
        const avgText = document.createElement('span');
        avgText.className = 'rating-avg-text';
        avgText.textContent = `Avg ${question.avg_rating} (${question.rating_count} rating${question.rating_count > 1 ? 's' : ''})`;
        wrap.appendChild(avgText);
    }

    return wrap;
}

// 获取 Practice 模式题目（新版）：按 Test 分类查询，跨所有年份混合展示，
// 可选按题型（questionCategory）筛选，每道题上标注对应的年份
function loadPracticeQuestionsByCategory(category, questionCategory) {
    const questionsWrap = document.getElementById('practice-questions');
    if (!questionsWrap) return;

    showQuestionsLoading(questionsWrap);

    const params = new URLSearchParams({ category });
    if (questionCategory) {
        params.set('questionCategory', questionCategory);
    }

    // 先把这个用户标过星的题目 id 拉回来（没登录就跳过，星标按钮还是会显示，只是默认都是空心状态），
    // 这样题目渲染出来的时候，已经标过重点的题就能一开始就显示实心星标，不用等用户自己点一遍才知道
    Promise.all([ensureStarredQuestionIdsLoaded(), ensureMyRatingsLoaded()]).finally(() => {
        fetch(`${APP_API_BASE}/api/questions/practice-by-category?${params.toString()}`)
            .then(response => response.json())
            .then(data => {
                questionsWrap.innerHTML = '';   // 清掉加载提示，再填真正的题目

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
                    const wrapper = buildQuestionBlock(question, { showYear: true, showType, displayNumber: index + 1, showStar: true, showRating: true });

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
                scrollToPendingQuestionIfAny(questionsWrap);
            })
            .catch(error => {
                console.error('Failed to Obtain Practice Questions:', error);
                showQuestionsError(questionsWrap);
            });
    });
}

// 从 Revision 页面点"Go to Question"跳过来的话，题目渲染完之后滚到那道题、闪一下高亮，
// 方便用户一眼找到，而不是要在一长串题目里自己找
function scrollToPendingQuestionIfAny(container) {
    if (!pendingScrollToQuestionId) return;

    const target = container.querySelector(`[data-question-id="${pendingScrollToQuestionId}"]`);
    pendingScrollToQuestionId = null;
    if (!target) return;

    // 等淡入动画先跑一下，避免滚动跟动画同时发生看起来很突兀
    setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        target.classList.add('question-highlight');
        setTimeout(() => target.classList.remove('question-highlight'), 2000);
    }, 150);
}


// 拉一次"我标过星的题目 id 有哪些"，缓存在 starredQuestionIds 里，避免每次切换 Test/题型筛选都重新请求
let starredIdsLoadPromise = null;
function ensureStarredQuestionIdsLoaded() {
    const token = getToken();
    if (!token) return Promise.resolve();
    if (starredIdsLoadPromise) return starredIdsLoadPromise;

    starredIdsLoadPromise = fetch(`${APP_API_BASE}/api/progress/starred-questions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : [])
        .then(list => {
            starredQuestionIds = new Set(list.map(q => q.id));
        })
        .catch(error => console.error('Failed to load starred question ids:', error));

    return starredIdsLoadPromise;
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
// 交卷完成的时候记一笔"这个用户完成了这张卷子"，给 Profile 页面的 Practice Progress 用。
// 没登录的话直接跳过，不影响正常交卷流程（考试功能本身不强制登录）。
function recordExamCompletion(paperId) {
    const token = localStorage.getItem('csci1100_auth_token');
    if (!token || !paperId) return;

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/complete`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    }).catch(error => console.error('Failed to record exam completion:', error));
}

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

            recordExamCompletion(header.dataset.currentPaperId);

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

    showQuestionsLoading(questionsContainer);

    fetch(`${APP_API_BASE}/api/questions/practice/${paperId}`)
        .then(response => response.json())
        .then(data => {
            questionsContainer.innerHTML = '';   // 清掉加载提示，再填真正的题目

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
        .catch(error => {
            console.error('Failed to Obtain Testing Questions:', error);
            showQuestionsError(questionsContainer);
        });
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

// ---------- Revision 页面：首页（两张卡片）+ 两个子板块之间的切换 ----------
// 因为切 Test 分类时骨架会整个重新生成，这几个 view 元素每次都是新的节点，
// 所以这个函数本身没有状态依赖，每次调用都是全新查一遍当前 DOM，不会有缓存过期的问题
function showRevisionView(viewName) {
    document.querySelectorAll('.revision-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`revision-view-${viewName}`);
    if (!target) return;

    target.classList.add('active');
    triggerFadeIn(target);

    if (viewName === 'marked-questions') {
        loadRevisionQuestions();
    } else if (viewName === 'cribsheet') {
        initCribSheet();
        initCribsheetBuilder();
    }
}

// ---------- Revision 页面 板块一：展示这个用户在 Practice 里标过重点的所有题目 ----------
// 每次切到 Revision 标签页都重新拉一次完整列表（不缓存跨会话），筛选是在这份数据上前端本地过滤，
// 不用每次切筛选条件都重新发请求
let revisionFullList = [];

function loadRevisionQuestions() {
    const container = document.getElementById('marked-questions-container');
    const topicFilter = document.getElementById('revision-topic-filter');
    if (!container) return;

    const token = getToken();
    if (!token) {
        container.innerHTML = '<div class="revision-empty">' +
            '<div class="revision-empty-icon"><i class="fa-solid fa-location-dot"></i></div>' +
            '<p class="revision-empty-title">Log in to use Revision</p>' +
            '<p class="revision-empty-subtext">Mark questions as important in Practice, and they\u2019ll show up here for quick review.</p>' +
            '</div>';
        return;
    }

    showQuestionsLoading(container, 'Loading your marked questions...');

    fetch(`${APP_API_BASE}/api/progress/starred-questions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.json())
        .then(data => {
            revisionFullList = data || [];
            starredQuestionIds = new Set(revisionFullList.map(q => q.id)); // 保持跟 Practice 页面的星标状态同步

            // 筛选下拉框每次骨架重新生成都是新节点，用 dataset 标记避免重复绑监听器
            if (topicFilter && !topicFilter.dataset.listenerAttached) {
                topicFilter.dataset.listenerAttached = 'true';
                topicFilter.addEventListener('change', renderFilteredRevisionList);
            }

            renderFilteredRevisionList();
        })
        .catch(error => {
            console.error('Failed to load revision questions:', error);
            showQuestionsError(container, 'Failed to load your marked questions. Please try refreshing the page.');
        });
}

// 根据筛选下拉框当前选的值，从 revisionFullList 里过滤出要显示的题目并渲染
function renderFilteredRevisionList() {
    const container = document.getElementById('marked-questions-container');
    const topicFilter = document.getElementById('revision-topic-filter');
    if (!container) return;

    if (revisionFullList.length === 0) {
        container.innerHTML = '<div class="revision-empty">' +
            '<div class="revision-empty-icon"><i class="fa-solid fa-location-dot"></i></div>' +
            '<p class="revision-empty-title">No marked questions yet</p>' +
            '<p class="revision-empty-subtext">Go to Practice and click the star on any question to add it here.</p>' +
            '</div>';
        return;
    }

    const topicValue = topicFilter ? topicFilter.value : '';

    const filtered = revisionFullList.filter(q => {
        if (topicValue && formatQuestionType(q.question_category) !== topicValue) return false;
        return true;
    });

    container.innerHTML = '';

    if (filtered.length === 0) {
        container.innerHTML = '<div class="revision-empty">' +
            '<div class="revision-empty-icon"><i class="fa-solid fa-filter-circle-xmark"></i></div>' +
            '<p class="revision-empty-title">No questions match these filters</p>' +
            '<p class="revision-empty-subtext">Try a different Topic or Exam filter.</p>' +
            '</div>';
        return;
    }

    filtered.sort((a, b) => {
        if (b.paper_year !== a.paper_year) return b.paper_year - a.paper_year;
        return (a.question_number ?? 0) - (b.question_number ?? 0);
    });

    filtered.forEach((question, index) => {
        const wrapper = buildQuestionBlock(question, {
            showYear: true,
            showType: true,
            displayNumber: index + 1,
            showStar: true,
            showGoToQuestion: true,
            // 备注输入框先去掉，之后想好新的记笔记方案再说；底层的 note 存储/接口先保留不动
            // 在 Revision 页面取消星标，直接把这道题从当前列表和缓存里移除，不用整页重新拉一次
            onUnstar: (questionEl) => {
                questionEl.remove();
                revisionFullList = revisionFullList.filter(q => q.id !== question.id);
                if (container.querySelectorAll('.question-block').length === 0) {
                    renderFilteredRevisionList(); // 全部取消了，刷新一下显示空状态
                }
            }
        });

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

        container.appendChild(wrapper);
    });

    triggerFadeIn(container);
}

// ---------- Revision 页面 板块二：自己写的 Crib Sheet（纯文本笔记，手动 Save） ----------
// 每次切到 Revision 标签页都会调用；Test 分类切换时骨架会整个重新注入，
// 所以用 dataset 标记一下，避免同一个按钮被重复绑定监听器（不然点一次 Save 会触发好几次请求）
function initCribSheet() {
    const textarea = document.getElementById('crib-sheet-textarea');
    const saveBtn = document.getElementById('crib-sheet-save-btn');
    const statusEl = document.getElementById('crib-sheet-status');
    if (!textarea || !saveBtn) return;

    const token = getToken();
    if (!token) {
        textarea.value = '';
        textarea.disabled = true;
        textarea.placeholder = 'Log in to write and save your crib sheet.';
        saveBtn.disabled = true;
        return;
    }

    textarea.disabled = false;
    saveBtn.disabled = false;

    // 拉一次已经保存过的内容，填进文本框
    fetch(`${APP_API_BASE}/api/progress/crib-sheet`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
            if (data) textarea.value = data.content || '';
        })
        .catch(error => console.error('Failed to load crib sheet:', error));

    if (saveBtn.dataset.listenerAttached) return; // 已经绑过了，不重复绑
    saveBtn.dataset.listenerAttached = 'true';

    saveBtn.addEventListener('click', () => {
        const currentToken = getToken();
        if (!currentToken) return;

        saveBtn.disabled = true;
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        if (statusEl) statusEl.textContent = '';

        fetch(`${APP_API_BASE}/api/progress/crib-sheet`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${currentToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: textarea.value })
        })
            .then(res => res.ok ? res.json() : Promise.reject(new Error('Save failed')))
            .then(() => {
                if (statusEl) {
                    statusEl.textContent = 'Saved';
                    setTimeout(() => {
                        if (statusEl.textContent === 'Saved') statusEl.textContent = '';
                    }, 3000);
                }
            })
            .catch(error => {
                console.error('Failed to save crib sheet:', error);
                if (statusEl) statusEl.textContent = 'Failed to save \u2014 please try again.';
            })
            .finally(() => {
                saveBtn.disabled = false;
                saveBtn.textContent = originalText;
            });
    });
}

// ---------- Cribsheet Builder：笔记库 + 点击加入自己的复习单 + 导出 PDF ----------
// 笔记库不用登录也能看；点击加入/移出、导出 PDF 需要登录
let cribsheetLibraryCache = null; // 笔记库内容不常变，缓存一份，切换标签页不用重复请求

function initCribsheetBuilder() {
    loadCribsheetLibrary();
    loadMySelectedNotes();
    initCribsheetOrientationToggle();
    initCribsheetPdfExport();
}

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

function renderCribsheetLibrary(grouped) {
    const container = document.getElementById('cribsheet-library-container');
    if (!container) return;

    container.innerHTML = '';
    const categories = Object.keys(grouped);

    if (categories.length === 0) {
        container.innerHTML = '<p class="cribsheet-empty-hint">No notes in the library yet.</p>';
        return;
    }

    categories.forEach(category => {
        const section = document.createElement('div');
        section.className = 'cribsheet-library-category';

        const heading = document.createElement('h4');
        heading.textContent = category;
        section.appendChild(heading);

        grouped[category].forEach(note => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'cribsheet-library-item';
            item.dataset.noteId = note.id;
            item.innerHTML = `<span class="cribsheet-library-item-title">${note.title}</span><i class="fa-solid fa-plus"></i>`;
            item.title = 'Add to my Cribsheet';

            item.addEventListener('click', () => {
                if (!getToken()) return;
                item.disabled = true;
                toggleCribsheetNote(note.id).then(result => {
                    item.disabled = false;
                    if (result === null) return;
                    if (result.selected) {
                        addNoteToSheetView({ id: note.id, category, title: note.title, content: note.content });
                        item.classList.add('added');
                    }
                });
            });

            section.appendChild(item);
        });

        container.appendChild(section);
    });

    // 加载库的时候，把已经加入过的笔记在库里也标记一下（打勾/变灰），避免重复点
    syncLibraryItemsWithSelection();
}

function toggleCribsheetNote(noteId) {
    const token = getToken();
    if (!token) return Promise.resolve(null);

    return fetch(`${APP_API_BASE}/api/cribsheet/notes/${noteId}/toggle`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : null)
        .catch(error => {
            console.error('Failed to toggle note selection:', error);
            return null;
        });
}

let mySelectedNoteIds = new Set();

function loadMySelectedNotes() {
    const sheetContainer = document.getElementById('cribsheet-selected-notes');
    if (!sheetContainer) return;

    const token = getToken();
    if (!token) {
        mySelectedNoteIds = new Set();
        renderEmptyHintOnly(sheetContainer);
        return;
    }

    fetch(`${APP_API_BASE}/api/cribsheet/my-selected-notes`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.json())
        .then(notes => {
            mySelectedNoteIds = new Set((notes || []).map(n => n.id));
            sheetContainer.innerHTML = '';

            if (!notes || notes.length === 0) {
                renderEmptyHintOnly(sheetContainer);
                return;
            }

            notes.forEach(note => addNoteToSheetView(note));
            syncLibraryItemsWithSelection();
        })
        .catch(error => console.error('Failed to load my selected notes:', error));
}

function renderEmptyHintOnly(sheetContainer) {
    sheetContainer.innerHTML = '<p class="cribsheet-empty-hint" id="cribsheet-empty-hint">No notes added yet \u2014 click a note on the left to add it here.</p>';
}

// 把一条笔记加到"我的复习单"预览区里，带一个移除按钮
function addNoteToSheetView(note) {
    const sheetContainer = document.getElementById('cribsheet-selected-notes');
    if (!sheetContainer) return;

    const emptyHint = document.getElementById('cribsheet-empty-hint');
    if (emptyHint) emptyHint.remove();

    if (sheetContainer.querySelector(`[data-note-id="${note.id}"]`)) return; // 已经在里面了，不重复加

    const card = document.createElement('div');
    card.className = 'cribsheet-note-card';
    card.dataset.noteId = note.id;
    card.innerHTML = `
        <button type="button" class="cribsheet-note-remove" title="Remove from my Cribsheet"><i class="fa-solid fa-xmark"></i></button>
        <p class="cribsheet-note-title">${note.title}</p>
        <p class="cribsheet-note-content">${note.content}</p>
    `;

    card.querySelector('.cribsheet-note-remove').addEventListener('click', () => {
        toggleCribsheetNote(note.id).then(result => {
            if (result === null) return;
            if (!result.selected) {
                card.remove();
                mySelectedNoteIds.delete(note.id);
                syncLibraryItemsWithSelection();
                if (sheetContainer.querySelectorAll('.cribsheet-note-card').length === 0) {
                    renderEmptyHintOnly(sheetContainer);
                }
            }
        });
    });

    sheetContainer.appendChild(card);
    mySelectedNoteIds.add(note.id);
}

// 库里已经加入过的笔记，按钮变灰 + 打勾，提示"已经在你的表里了"
function syncLibraryItemsWithSelection() {
    document.querySelectorAll('.cribsheet-library-item').forEach(item => {
        const noteId = Number(item.dataset.noteId);
        const isAdded = mySelectedNoteIds.has(noteId);
        item.classList.toggle('added', isAdded);
        item.innerHTML = item.querySelector('.cribsheet-library-item-title').outerHTML +
            (isAdded ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-plus"></i>');
    });
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