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

    // 同一个元素可能被连续触发（比如快速切 Test），先取消上一次的清理定时器
    if (el._fadeInTimer) clearTimeout(el._fadeInTimer);

    el.style.opacity = '';
    el.style.animation = 'none';
    void el.offsetWidth;   // 强制重排，这一行不能删
    el.style.animation = 'contentFadeIn 0.9s ease forwards';

    // 动画播完之后必须把 animation 清掉，原因不显然：
    // contentFadeIn 的最后一帧是 transform: translateY(0)，而 fill-mode: forwards
    // 会让这个值永久留在元素上。任何非 none 的 transform（哪怕是 translateY(0)
    // 这种什么都不动的值）都会让该元素成为后代 position: fixed 的定位基准——
    // 于是这个容器里的弹窗不再相对视口居中，而是相对这个很高的容器居中，
    // 跑到页面下方去了。
    //
    // 清 animation 之前先把 opacity 固定成 1：.test-section 的基础样式里
    // 有 opacity: 0，全靠 forwards 撑着，直接清掉元素会瞬间消失。
    el._fadeInTimer = setTimeout(() => {
        el.style.opacity = '1';
        el.style.animation = '';
        el._fadeInTimer = null;
    }, 950);   // 比动画时长 0.9s 略长一点，确保播完
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

// 题型筛选的唯一数据源。Practice 和 Marked Questions 两处筛选器都从这里生成。
// 原来这份列表在 skeleton.html 里硬编码了两遍，加一个题型要改两处，
// 漏掉一处是迟早的事——以后做课程参数化时，Math 的题型跟 CS1 完全不同，
// 到时候只需要按课程换掉这个数组，不用去 HTML 里找。
//
// value 是发给后端的值（对应 Test_Questions.question_category 格式化之后的形式），
// label 是显示给学生看的。空字符串表示"不筛选"。
const QUESTION_TYPE_FILTERS = [
    { value: '', label: 'All' },
    { value: 'one-liners', label: 'One-Liners' },
    { value: 'debugging', label: 'Debugging' },
    { value: 'get-output', label: 'Get-Output' },
    { value: 'half-program', label: 'Half-Program' },
    { value: 'full-program', label: 'Full-Program' }
];

// 把一排题型标签渲染进容器。当前选中值存在容器自己的 dataset 上，
// 读的时候统一走 getQuestionTypeFilterValue()，调用方不用各自记一份状态。
// 重复调用是安全的：会整个重建，但保留已选中的值，也不会叠加监听器。
function renderQuestionTypeFilter(container, onChange) {
    if (!container) return;

    const current = container.dataset.value || '';
    container.dataset.value = current;
    container.innerHTML = '';

    QUESTION_TYPE_FILTERS.forEach(filter => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'qtype-pill';
        pill.dataset.value = filter.value;
        pill.textContent = filter.label;

        const isActive = current === filter.value;
        pill.classList.toggle('active', isActive);
        // aria-pressed 让读屏软件知道这是个"开关"状态，而不是普通按钮
        pill.setAttribute('aria-pressed', String(isActive));

        pill.addEventListener('click', () => {
            if (container.dataset.value === filter.value) return;   // 点已经选中的那个，不用重新拉数据

            container.dataset.value = filter.value;
            container.querySelectorAll('.qtype-pill').forEach(el => {
                const nowActive = el.dataset.value === filter.value;
                el.classList.toggle('active', nowActive);
                el.setAttribute('aria-pressed', String(nowActive));
            });

            if (onChange) onChange(filter.value);
        });

        container.appendChild(pill);
    });
}

function getQuestionTypeFilterValue(container) {
    return container ? (container.dataset.value || '') : '';
}

// 难度徽章的色阶：越难越暖。分档跟着 5 星评分走——
// 3 分以下算简单（绿），3 到 4.5 算中等（橙），4.5 以上算难（红）。
// 边界取的是连续区间，不留空档，免得 2.7 分这种落不到任何一档
function difficultyLevelClass(avgRating) {
    const value = Number(avgRating);
    if (!Number.isFinite(value)) return '';
    if (value < 3) return 'difficulty-easy';
    if (value < 4.5) return 'difficulty-medium';
    return 'difficulty-hard';
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

    // 难度徽章。只有真的有人评过分才显示——没有评分记录时 avg_rating 是空的，
    // 那就什么都不放，不编一个默认难度出来
    if (options.showDifficulty && question.rating_count) {
        const difficultyTag = document.createElement('span');
        difficultyTag.className = `question-difficulty-tag ${difficultyLevelClass(question.avg_rating)}`;
        difficultyTag.innerHTML = `<i class="fa-solid fa-star"></i>${question.avg_rating}`;
        difficultyTag.title = `Average difficulty ${question.avg_rating} from ${question.rating_count} rating${question.rating_count > 1 ? 's' : ''}`;
        labelRow.appendChild(difficultyTag);
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
    // 只在「扫列表找题」的场景（Practice / Marked Questions）允许折叠。
    // 真正折不折要等它进了 DOM 才知道——这里只是打个标记
    if (options.collapseLongCode) {
        questionPre.classList.add('question-code-collapsible');
    }
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

// 超过这个高度的题目会被折起来（px）。full-program 那类题动辄几十行，
// 一道就能占满整屏，而 Practice 是跨年份混合展示的，一个 Test 下几十道题。
const QUESTION_CODE_COLLAPSE_MAX = 360;

// 把过长的题干折起来，底部留一个「Show more」。
//
// 没有用块内滚动条：嵌套滚动会跟页面滚动打架——鼠标划过代码块的时候，
// 滚的就变成块内部了，得等它滚到底页面才继续动，扫列表的时候很难受。
//
// 必须在元素进入 DOM 之后才能调用：detached 元素的 scrollHeight 是 0，
// 那样每道题都会被判定成「不够长」。
function applyLongCodeCollapse(container) {
    if (!container) return;

    container.querySelectorAll('.question-code-collapsible').forEach(pre => {
        if (pre.dataset.collapseChecked === 'true') return;   // 同一块只量一次
        pre.dataset.collapseChecked = 'true';

        // 不够长的题目完全不动它，也不挂那个按钮——
        // 短题目下面吊一个点了没反应的「Show more」很傻
        if (pre.scrollHeight <= QUESTION_CODE_COLLAPSE_MAX) return;

        pre.classList.add('code-collapsed');

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'code-collapse-toggle';
        toggle.textContent = 'Show more';
        toggle.setAttribute('aria-expanded', 'false');

        toggle.addEventListener('click', () => {
            const collapsed = pre.classList.toggle('code-collapsed');
            toggle.textContent = collapsed ? 'Show more' : 'Show less';
            toggle.setAttribute('aria-expanded', String(!collapsed));

            // 收起的时候如果视线停在题目下半部分，页面会突然「往上缩」，
            // 人就不知道自己滚到哪了。把题目开头拉回视野内
            if (collapsed) {
                pre.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        });

        pre.insertAdjacentElement('afterend', toggle);
    });
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
                    const wrapper = buildQuestionBlock(question, { showYear: true, showType, displayNumber: index + 1, showStar: true, showRating: true, showDifficulty: true, collapseLongCode: true });

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

                applyLongCodeCollapse(questionsWrap);
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

// 渲染 Practice 的题型筛选（每次切换 Test 分类、重新生成骨架后都要重新调用，
// 因为骨架是整个替换的，旧的 DOM 和监听器已经不存在了）
function setupPracticeFilter(category) {
    const filterEl = document.getElementById('practice-type-filter');
    if (!filterEl) return;

    filterEl.dataset.value = '';   // 每次切换 Test 分类，题型筛选重置为 "All"

    renderQuestionTypeFilter(filterEl, (value) => {
        loadPracticeQuestionsByCategory(category, value);
    });
}

// Testing 模式计时器状态
let testingTimerInterval = null;
let countdownEndTime = 0;        // 倒计时的目标结束时间戳（毫秒），用它反推剩余秒数，避免 setInterval 延迟导致跳过精确节点
let warned10 = false;
let warned5 = false;
let warned1 = false;
let warnedTimesUp = false;
// 考试时长和三个提醒节点。四个值放在一起，是因为之前它们散在两个函数里，
// 调试的时候改成了秒级的短值，上线前只记得改回一部分，很容易漏。
// 以后要临时调短来测流程，改这四行就够，测完记得改回来。
const COUNTDOWN_TOTAL_SECONDS = 110 * 60;   // 1 小时 50 分钟
const WARN_AT_SECONDS_10MIN = 10 * 60;
const WARN_AT_SECONDS_5MIN = 5 * 60;
const WARN_AT_SECONDS_1MIN = 1 * 60;

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

    if (remainingSeconds <= WARN_AT_SECONDS_10MIN && !warned10) {
        warned10 = true;
        if (timerDisplay) timerDisplay.classList.add('timer-warning-10');
        showExamToast('10 minutes remaining!');
    }

    if (remainingSeconds <= WARN_AT_SECONDS_5MIN && !warned5) {
        warned5 = true;
        if (timerDisplay) timerDisplay.classList.add('timer-warning-5');
        showExamToast('5 minutes remaining!');
    }

    if (remainingSeconds <= WARN_AT_SECONDS_1MIN && !warned1) {
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
// 子页对应的标题。进到子页时上面那个板块切换器会整个变成这个标题，
// 所以子页自己不再放 <h2>——两处写同一个词是迟早会不一致的
const REVISION_VIEW_TITLES = {
    'marked-questions': 'Marked Questions',
    'cribsheet': 'Cribsheet Builder'
};

function showRevisionView(viewName) {
    document.querySelectorAll('.revision-view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`revision-view-${viewName}`);
    if (!target) return;

    target.classList.add('active');
    triggerFadeIn(target);

    // 切换器变成子页标题；回到 landing 就恢复成三项轮滑。
    // setSwitcherSubPageTitle 定义在 cs1_index.js 里，那个文件在这个之后加载，
    // 但调用发生在用户点击之后，那时候它已经存在了
    if (typeof setSwitcherSubPageTitle === 'function') {
        setSwitcherSubPageTitle(REVISION_VIEW_TITLES[viewName] || null);
    }

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

            // 重复调用是安全的：renderQuestionTypeFilter 会整个重建这排标签，
            // 不会叠加监听器，已选中的值也会保留
            renderQuestionTypeFilter(topicFilter, renderFilteredRevisionList);

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

    const topicValue = getQuestionTypeFilterValue(topicFilter);

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
            showDifficulty: true,
            collapseLongCode: true,
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

    applyLongCodeCollapse(container);
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