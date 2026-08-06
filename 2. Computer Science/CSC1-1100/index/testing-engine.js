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

// 哪些题型自动判分。不在这个名单里的题交卷后走【学生自评】：
// 摊开标准答案和减分条件，学生自己给自己打分。
//
// 收窄到这四类是有意的取舍。half-program / full-program 那种大题，
// 光靠测试用例判不出"思路对但边界写错扣几分"，而录用例的成本又高，
// 不如把判断交给学生自己——他手里有标准答案和减分条件。
//
// ⚠️ 必须用 formatQuestionType() 归一化之后再比。
//    数据库里存的是 get_output（下划线），前端筛选器发的是 get-output（连字符），
//    这两个值在这个项目里【同时存在】。直接比字面值会漏掉一整类题，
//    而且是静默漏掉——那类题会被当成自评题，不报任何错
const AUTO_GRADED_CATEGORIES = new Set([
    'one-liners',
    'debugging',
    'get-output',
    'mcq'
]);

function isAutoGradedCategory(rawCategory) {
    return AUTO_GRADED_CATEGORIES.has(formatQuestionType(rawCategory));
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

    // 判分调度要用：靠 category 决定这道题是自动判还是学生自评，
    // 靠 points 算总分。都挂在 DOM 上，免得判分时再去查一遍题目数据
    if (question.question_category) {
        wrapper.dataset.questionCategory = question.question_category;
    }
    // 只在真的有分值时才挂。null（还没录分值）不挂，
    // 读的时候 undefined 和 "0" 才区分得开
    if (question.points !== null && question.points !== undefined) {
        wrapper.dataset.points = question.points;
    }

    const labelRow = document.createElement('div');
    labelRow.className = 'question-label-row';

    const labelP = document.createElement('p');
    labelP.className = 'question-label';
    labelP.textContent = options.displayNumber !== undefined
        ? `${options.displayNumber}.`
        : `${question.question_number}${question.subquestion_number ?? ''}.`;
    labelRow.appendChild(labelP);

    // 分值徽标：放在题号之后、Flag 按钮【左边】。只在录了分值时显示（null = 还没录，不摆）。
    // 天然只出现在考试（TestingDto 带 points）和结果（PracticeDto 带 points）里——
    // Practice 那个 DTO 没有 points 字段，所以 Practice 页面不会出现，无需额外判断
    if (question.points !== null && question.points !== undefined) {
        const pointsTag = document.createElement('span');
        pointsTag.className = 'question-points-tag';
        const p = Number(question.points);
        pointsTag.textContent = `${p} ${p === 1 ? 'pt' : 'pts'}`;
        labelRow.appendChild(pointsTag);
    }

    // 考试模式：题号右边跟一个「标记」按钮。
    // ⚠️ 只在 Examination 用（loadTestingQuestions 传 showExamFlag），
    // Practice / Revision 那边用的是星标（options.showStar），
    // 两者含义不同，见 toggleExamFlag 上面的说明
    if (options.showExamFlag) {
        const paperId = document.getElementById('testing-header')?.dataset.currentPaperId;
        labelRow.appendChild(buildFlagButton(question.id, paperId));
    }

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
// ============================================================
// 把 Examination 从「准备中」退回第一步。
//
// 三个地方会用到：
//   1. loadTestingQuestions 的重置分支——换卷子、换年份、重考
//   2. 切换板块（Practice / Revision）——见 cs1_index.js 的 activateSection
//   3. 换 Test（navbar）——那条路径最终也会走到 activateSection
//
// 第 2 条是后补的：状态挂在 body 上，而切板块只是切换 .test-section 的显隐、
// 不重建骨架，所以 loadTestingQuestions 根本不会跑，
// 结果是"点了 Get Ready 之后切到 Practice 再切回来，还停在第二步"
function resetExamReadyState() {
    // ⚠️ 考试进行中时什么都不做。
    //
    // 这个函数在切板块时也会被调用（cs1_index.js 的 activateSection），
    // 而刷新恢复考试的流程里正好会切一次板块——结果是刚恢复好的考试状态
    // 立刻被这里重置掉，学生看到的是 Get Ready 页面，
    // 但计时器还在后台跑。
    //
    // 判断依据用 exam-in-progress 而不是 sessionStorage：
    // 前者是"界面当前处于什么状态"，后者是"有没有未结束的场次"，
    // 这里要拦的是前者
    const headerEl = document.getElementById('testing-header');
    if (headerEl && headerEl.classList.contains('exam-in-progress')) return;

    document.body.classList.remove('exam-ready-mode');

    // ⚠️ 这里【不清】exam-result-mode。这个函数在切板块时也会被调用
    // （见 cs1_index.js 的 activateSection），而"考完试去 Practice 看一眼
    // 再切回来"不该把成绩清掉——卡片上还写着 Correction、答案也还摊开着，
    // 只有那两块结果卡消失，状态就对不上了。
    // 成绩的清理放在 loadTestingQuestions 的重置分支里：
    // 重考、换卷子、换年份才是真的"这一场结束了"

    const header = document.getElementById('testing-header');
    if (header) header.classList.remove('exam-ready');

    const startBtn = document.getElementById('testing-start-btn');
    // 只在按钮还处于「可以开始」的状态时才改文案——
    // 考试进行中按钮是隐藏的，不该被这里改回 Get Ready
    if (startBtn && !header?.classList.contains('exam-in-progress')) {
        startBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Get Ready';
    }
}

// ⚠️⚠️  考试分析板块：里面的数字【全部是编的】  ⚠️⚠️
// ============================================================
// 分数、排名、班级平均、就绪度、难度星级、常错知识点、历次尝试——
// 一个都不是真的，也没有任何数据来源。
//
// Code 100 【不判分】：学生自己对照答案，系统永远不知道做对几道。
// 所以这些不是"等接口接上就有"的占位符，而是"要先建一整套判题系统才可能有"。
//
// 这个开关默认 false，整块不显示。想看设计效果就临时改成 true，
// 但【不要带着 true 上线】——Code 100 是学生在用的站点，
// 页面上写着 "92% · Top 15%"，没人会知道那是假的。
//
// 每一项要变成真数据分别需要什么：
//   Your score / Previous attempts  → 先做判题：标准答案结构化、答题输入、比对逻辑
//   Ranking / Class average         → 在判题之上再做跨用户聚合
//   Exam readiness                  → 定义"就绪"由哪些行为构成，并埋点记录
//   Difficulty (star rating)        → 聚合这张卷子所有题的 avg_rating（这项最容易，后端加个接口就行）
//   Common challenging topics       → 题目要先打知识点标签，目前只有题型分类
const EXAM_ANALYTICS_MOCK = true;

function applyExamAnalyticsVisibility() {
    document.querySelectorAll('[data-mock="true"]').forEach(el => {
        el.style.display = EXAM_ANALYTICS_MOCK ? '' : 'none';
    });
}

// 当前用户每张卷子的完成时间。进 Examination 页面时拉一次就够，
// 之后切年份、切 Test 都用缓存——这个数据在一次浏览里不会变
// （唯一会变的时机是本人刚交卷，那时候会主动清缓存）。
//
// 后端那张表 user_id + paper_id 有唯一约束，重复交卷走 update，
// 所以一张卷子只会有一个时间，不用在前端做"取最近一次"的处理。
let examCompletionsCache = null;

function loadExamCompletions() {
    if (examCompletionsCache) return Promise.resolve(examCompletionsCache);

    const token = localStorage.getItem('csci1100_auth_token');
    if (!token) {
        // 没登录就没有"我的记录"，返回空对象而不是报错——
        // 这只是卡片上的一行附加信息，不该影响页面能不能用
        examCompletionsCache = {};
        return Promise.resolve(examCompletionsCache);
    }

    return fetch(`${APP_API_BASE}/api/progress/exam-completions`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : {})
        .then(data => {
            examCompletionsCache = data || {};
            return examCompletionsCache;
        })
        .catch(error => {
            console.error('Failed to load exam completions:', error);
            examCompletionsCache = {};
            return examCompletionsCache;
        });
}

// 把 ISO 时间串格式化成 "Mar 12" 这种简短形式。
// 今年的省略年份，往年的带上——"Mar 12" 在跨年之后会有歧义
function formatLastAttempt(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;

    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString('en-US', sameYear
        ? { month: 'short', day: 'numeric' }
        : { month: 'short', day: 'numeric', year: 'numeric' });
}

// 在考卷卡片上显示"上次考过"。没考过就整项不显示——
// 显示 "Never attempted" 是一句废话，空着更干净
function renderLastAttempt(paperId) {
    const el = document.getElementById('exam-last-attempt');
    if (!el) return;

    loadExamCompletions().then(map => {
        const iso = map[String(paperId)];
        const text = iso ? formatLastAttempt(iso) : null;

        if (!text) {
            el.style.display = 'none';
            return;
        }

        el.style.display = '';
        el.querySelector('span').textContent = `Last attempted ${text}`;
    });
}

// 交卷完成的时候记一笔"这个用户完成了这张卷子"，给 Profile 页面的 Practice Progress 用。
// 没登录的话直接跳过，不影响正常交卷流程（考试功能本身不强制登录）。
function recordExamCompletion(paperId) {
    const token = localStorage.getItem('csci1100_auth_token');
    if (!token || !paperId) return;

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/complete`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    })
        // 刚记了一笔，缓存就过期了。清掉，下次进这张卷子会重新拉，
        // 能看到"上次考过 = 今天"
        .then(() => { examCompletionsCache = null; })
        .catch(error => console.error('Failed to record exam completion:', error));
}

// 揭晓考试结果。原来是交卷处理器里的一整段，抽成顶层函数——好在交卷和
// 结果【之间】插一屏难度评分（见 showPaperRatingStep）。评分/跳过之后才调它。
//
// 自己按 id 重取元素，不依赖交卷处理器的闭包：那些元素都是 getElementById
// 拿的稳定节点，重取跟闭包捕获等价，但少一层作用域耦合。
function revealExamResults(paperId, totalElapsedSeconds) {
    const header = document.getElementById('testing-header');
    const headerTitle = header ? header.querySelector('h2') : null;
    const timerDisplay = document.getElementById('testing-timer');
    const toggleTimerBtn = document.getElementById('timer-toggle-btn');
    const submitBtn = document.getElementById('testing-submit-btn');
    const backToTopBtn = document.getElementById('testing-back-to-top-btn');
    const retakeBtn = document.getElementById('testing-retake-btn');
    const versionWrap = document.getElementById('version-selector-wrap');
    if (!header || !headerTitle || !timerDisplay) return;

    // 进入批改模式：banner 左边换成 "Correction"，用时 + Retake 留在右侧
    header.classList.remove('exam-in-progress');
    header.classList.add('exam-finished');
    headerTitle.textContent = 'Correction';

    timerDisplay.textContent = `Time Spent: ${formatMMSS(totalElapsedSeconds)}`;
    // 考试中点过 Hide Timer 的话 timer-hidden 会一直留着，opacity:0 让更新后的
    // 文字照样看不见，所以连它一起清掉
    timerDisplay.classList.remove('timing-active', 'timer-overtime', 'timer-warning-10', 'timer-warning-5', 'timer-warning-1', 'timer-hidden');
    timerDisplay.classList.add('timer-finished');

    // 交卷后作答不能再改。用 readonly 不用 disabled——disabled 的文本没法
    // 选中复制，而学生往往想把自己的答案复制出来跟标准答案对照
    document.querySelectorAll('#testing-questions .answer-editor-input').forEach(el => {
        el.readOnly = true;
    });

    // 标准答案交卷后才去后端拉——考试期间它根本没到过浏览器。
    // ⚠️ 要【等】它把自评界面建好，才能数出有几道可打分的自评题、
    // 决定是先让学生改卷（暂不亮分）还是直接亮结果，所以留住这个 Promise
    const solutionsReady = revealSolutions(paperId);

    // Hide Timer 和提交按钮不再需要
    if (toggleTimerBtn) toggleTimerBtn.style.display = 'none';
    if (submitBtn) submitBtn.style.display = 'none';

    // ⚠️ 【不在这里展开页面外壳】。改卷阶段要保持和考试一样的专注布局——
    //    页头、Test 标签、VERSION 选择器、导航栏、页脚、卷面头卡全收起，
    //    屏幕上只剩「改卷提示 + 考卷」。展开外壳（退出专注模式、恢复 version /
    //    Retake / 回顶）的活全挪到 finalizeExamResults：点了 Submit、要亮结果时，
    //    外壳才和结果一起出现。没有可改的自评题时也走 finalizeExamResults，一样展开。

    // 有【能打分】的自评题（录了 points 的）时，先进入"改卷"阶段：学生对着标准答案
    // 自己打分，这期间【不亮任何分数】——自动分、班级平均、Scoring Detail、历次尝试
    // 全等改完再一起出（见 finalizeExamResults）。没有可打分的自评题就直接亮结果。
    solutionsReady.then(() => {
        const markable = document.querySelectorAll('#testing-questions .self-assess-input').length;
        if (markable > 0) {
            enterMarkingHold(paperId, totalElapsedSeconds);
        } else {
            finalizeExamResults(paperId, totalElapsedSeconds);
        }
    });
}

// 把结果页滚到"导航栏刚好吸顶"那一点：先到 0 让吸顶导航栏回到文档流，再量它的自然位置
function scrollToResultsTop() {
    window.scrollTo({ top: 0, behavior: 'auto' });
    const navBarEl = document.querySelector('.nav-bar');
    if (navBarEl) {
        window.scrollTo({ top: navBarEl.getBoundingClientRect().top + window.scrollY, behavior: 'auto' });
    }
}

// 改卷阶段：学生对着标准答案自评，期间【不亮分】。放一个说明条 + "Reveal my results"，
// 点了才把所有分数一起亮出来。只有存在【能打分】的自评题（录了 points）时才进这一步。
function enterMarkingHold(paperId, totalElapsedSeconds) {
    const container = document.getElementById('testing-questions');
    if (!container || !container.parentNode) {
        finalizeExamResults(paperId, totalElapsedSeconds);
        return;
    }

    const existing = document.getElementById('exam-marking-hold');
    if (existing) existing.remove();

    // 改卷阶段把卷面头卡（#testing-header：卷名/题数/Retake）也藏起来，
    // 等点了 Submit、finalizeExamResults 跑起来才跟结果一起出现。
    // 用 body class 而不是 inline display——重置时一处清干净，不留残留样式
    document.body.classList.add('exam-marking-mode');

    const hold = document.createElement('div');
    hold.id = 'exam-marking-hold';
    hold.className = 'exam-marking-hold';
    hold.innerHTML = `
        <p class="exam-marking-hold-text">
            <strong>Mark every question, then submit.</strong>
            Compare each answer with the model answer and enter your mark above.
            Submit stays locked until all are marked, and once you view your results
            your marks are final — you can't change them.
        </p>
        <button type="button" class="exam-marking-hold-btn" disabled>Submit</button>
    `;
    container.parentNode.insertBefore(hold, container);

    // 全部改完才能提交：没填完时按钮禁用。每次自评输入变化都会重新判断
    // （updateSelfAssessedTotal 里调 syncMarkingHoldSubmit），这里先摆一次初始状态
    syncMarkingHoldSubmit();

    hold.querySelector('.exam-marking-hold-btn').addEventListener('click', function () {
        if (this.disabled) return;
        // 查看成绩后自评分锁死：所有输入设 readOnly，不能再改
        document.querySelectorAll('#testing-questions .self-assess-input').forEach(input => {
            input.readOnly = true;
            input.classList.add('is-locked');
        });
        hold.remove();
        finalizeExamResults(paperId, totalElapsedSeconds);
    });

    // 平滑滚到改卷说明条，别从答题位置硬跳到顶——配合 banner / 标准答案栏的
    // 入场动画，"进入改卷"是滑进来的，不是瞬间跳过去。
    // 放到下一帧：等 exam-marking-mode 藏掉卷面头卡、DOM 高度落定后再滚，位置才准
    requestAnimationFrame(() => {
        hold.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
}

// 所有自评题都打了分了吗（每个 .self-assess-input 都有可解析的数值）
function allSelfMarksFilled() {
    const inputs = [...document.querySelectorAll('#testing-questions .self-assess-input')];
    if (inputs.length === 0) return true;
    return inputs.every(input => Number.isFinite(parseFloat(input.value)));
}

// 根据"是否全部改完"启用/禁用改卷说明条上的 Submit 按钮
function syncMarkingHoldSubmit() {
    const hold = document.getElementById('exam-marking-hold');
    if (!hold) return;
    const btn = hold.querySelector('.exam-marking-hold-btn');
    if (!btn) return;
    const ready = allSelfMarksFilled();
    btn.disabled = !ready;
    btn.title = ready ? '' : 'Mark every question above before you can submit';
}

// 结果页每道题的「得分/总分」徽标，放在题号旁的分值徽标【左边】。
// mode='auto' 用云图标（自动判分），mode='self' 用铅笔图标（学生自评）——一眼区分两种判法。
// 只在题目【录了 points】时才加：没有总分就没有 "X/10" 可言（分值徽标本身也只在有 points 时出现）。
// 按得分占比给出色带：0–50% 红、>50–80% 橙、>80% 绿（对应 /10 的 0-5 / 6-8 / 9-10）。
// 徽标和右侧题号导航共用这套色带
function scoreBandClass(earned, max) {
    if (!(max > 0)) return null;
    const frac = earned / max;
    if (frac <= 0.5) return 'score-low';    // 差 → 红
    if (frac <= 0.8) return 'score-mid';    // 中 → 橙
    return 'score-high';                     // 好 → 绿
}

// 把某题的得分色带同步到右侧题号导航的那个按钮：换成得分色，
// 并清掉考试期间的「已答/标记」色（结果页不再保留那两种状态色）
function setNavScoreBand(questionId, band) {
    const nav = getQuestionNav();
    if (!nav) return;
    const btn = nav.querySelector(`[data-target-question="${questionId}"]`);
    if (!btn) return;
    btn.classList.remove('is-answered', 'is-flagged', 'is-score-low', 'is-score-mid', 'is-score-high');
    if (band) btn.classList.add(`is-${band}`);
}

// 进结果页时统一清掉导航上考试期间的「已答/标记」色。
// 有得分的题随后由 addEarnedBadge → setNavScoreBand 换上得分色；
// 没得分的题（没录 points）就回到中性白，不再顶着考试中的绿/红
function clearNavExamStates() {
    const nav = getQuestionNav();
    if (!nav) return;
    nav.querySelectorAll('.exam-nav-item').forEach(btn => {
        btn.classList.remove('is-answered', 'is-flagged');
    });
}

function addEarnedBadge(block, earned, max, mode) {
    if (!block) return;
    const labelRow = block.querySelector('.question-label-row');
    if (!labelRow) return;

    // 重考/重算时先清掉旧的，避免叠加
    labelRow.querySelectorAll('.question-earned-tag').forEach(el => el.remove());

    const band = scoreBandClass(earned, max);   // 得分色带

    const tag = document.createElement('span');
    // is-auto / is-self 保留（图标区分判法）；颜色由 is-score-* 得分色带决定
    tag.className = `question-earned-tag is-${mode}${band ? ` is-${band}` : ''}`;
    const icon = mode === 'auto' ? 'fa-cloud' : 'fa-pencil';
    tag.title = mode === 'auto' ? 'Auto-checked' : 'Self-marked';
    tag.innerHTML = `<i class="fa-solid ${icon}"></i>${formatMark(earned)}/${formatMark(max)}`;

    // 放在分值徽标左边；没有分值徽标（理论上不会，两者同条件）就放题号后
    const pointsTag = labelRow.querySelector('.question-points-tag');
    if (pointsTag) labelRow.insertBefore(tag, pointsTag);
    else labelRow.appendChild(tag);

    // 右侧题号导航联动同一得分色
    setNavScoreBand(block.dataset.questionId, band);
}

// 数字显示：整数就整数，带小数留一位（7 而不是 7.0；7.5 保留）
function formatMark(n) {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// 结果页给每道【自评题】加上「得分/总分」铅笔徽标。
// ⚠️ 只加徽标、不删自评框——框在结果页由 CSS（body.exam-result-mode）藏掉，
//    但 .self-assess-input 仍留在 DOM 里，collectSelfTotal / saveExamAttempt 照样读得到值。
//    真删了这里的输入，自评分会在存尝试/算 Scoring Detail 时丢掉。
function annotateSelfScores() {
    document.querySelectorAll('#testing-questions .question-block').forEach(block => {
        const input = block.querySelector('.self-assess-input');
        if (!input) return;
        const max = Number(input.dataset.maxPoints);
        if (!Number.isFinite(max) || max <= 0) return;
        let earned = parseFloat(input.value);
        if (!Number.isFinite(earned)) earned = 0;
        earned = Math.max(0, Math.min(earned, max));   // 夹在 [0, max]
        addEarnedBadge(block, earned, max, 'self');
    });
}

// 把考试 + 改卷期间收起的页面外壳一次性展开：退出专注模式（页头/Test 标签/
// 导航栏/页脚），恢复 VERSION 切换、Retake、回顶按钮。这些在考试和改卷期间
// 都收着，等结果出来才和结果一起放出来。
function restoreExamShell() {
    // true = 瞬间恢复骨架，不播展开动画（带过渡会把结果卡片一路往下推）
    if (typeof exitExamFocusMode === 'function') exitExamFocusMode(true);

    const versionWrap = document.getElementById('version-selector-wrap');
    const backToTopBtn = document.getElementById('testing-back-to-top-btn');
    const retakeBtn = document.getElementById('testing-retake-btn');
    if (versionWrap) versionWrap.classList.remove('hide-during-exam');
    if (backToTopBtn) backToTopBtn.style.display = 'inline-block';
    if (retakeBtn) retakeBtn.style.display = 'inline-block';
}

// 亮出全部结果：判分 + 存这次尝试 + Scoring Detail（含班级平均）+ 用时 + 历次 + 揭示动画。
// 从 revealExamResults 拆出来，因为它可能【延后】到学生改完卷才跑（见 enterMarkingHold）。
function finalizeExamResults(paperId, totalElapsedSeconds) {
    // 结果要出来了：把考试+改卷期间收起的外壳全展开（专注模式、VERSION、Retake、回顶），
    // 再放出卷面头卡（exam-marking-mode）——外壳、卷面卡、结果卡片一起出现
    restoreExamShell();
    document.body.classList.remove('exam-marking-mode');

    // 结果页刷新导航配色：先清掉考试期间的「已答/标记」色，
    // 随后各题的得分色由 addEarnedBadge → setNavScoreBand 填上
    clearNavExamStates();

    // 自评题：把学生打的分变成题号旁的 "得分/总分" 铅笔徽标（自评框随后被 CSS 藏掉）。
    // 自动判分题的云徽标在 gradeExamAnswers 里逐题加（要等判分结果）
    annotateSelfScores();

    // ⚠️ 用 Promise.resolve().then() 起手，把整条判分链隔在异步边界之外：万一
    // gradeExamAnswers 返回了非 Promise，也只是被 .catch 兜住，绝不能让异常同步冒出来
    // 把下面的 exam-result-mode（分析卡总开关）拦掉。判分挂了是小事，分析卡整块消失是大事
    Promise.resolve()
        .then(() => gradeExamAnswers(paperId))
        .then(auto => { saveExamAttempt(paperId, auto); })
        .catch(err => console.error('Grading pipeline failed:', err))
        .finally(() => refreshScoringDetail(paperId));

    // 用时跟判分互不依赖：没录用例、判分整个跳过时，用时照样要显示
    applyTimeSpentStat(totalElapsedSeconds);

    // 历次尝试的真实分数。接口没上线前显示 Coming soon 占位
    loadPreviousAttempts(paperId);

    // 结算状态：Your performance / Previous attempts / Scoring Detail 只在交卷后显示。
    // 必须在测量滚动位置【之前】挂上——这几块一出现，页面高度和导航栏自然位置都会变
    document.body.classList.add('exam-result-mode');

    scrollToResultsTop();

    // 分析板块淡入 + 进度条从 0 长出来。必须等页面真的到顶再触发（双层 rAF），
    // 否则动画头几帧被滚动吃掉。播完把 class 去掉：动画含 transform，留着会让
    // 后代 position:fixed 相对它定位。2200ms 必须大于 CSS 里最长那条动画
    const analyticsGrid = document.querySelector('.exam-analytics-grid');
    if (analyticsGrid) {
        analyticsGrid.classList.remove('is-revealing');
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                analyticsGrid.classList.add('is-revealing');
                setTimeout(() => analyticsGrid.classList.remove('is-revealing'), 2200);
            });
        });
    }
}

// 提交整卷难度评分（1~5）。
// ⚠️ 后端接口 POST /api/progress/exams/{paperId}/rate 【还没有】——见 HANDOFF 待办。
//    没上线前这个 POST 会失败，评分暂时存不下；但【不阻塞结果页】（评分本就是可选的）。
//    契约：body { rating: 1..5 }；user_id + paper_id 唯一，重复提交走 update（覆盖）。
function submitPaperRating(paperId, rating) {
    const token = getToken();
    if (!token) return Promise.resolve(false);

    return fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/rate`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ rating })
    })
        .then(res => res.ok)
        .catch(error => {
            console.error('Failed to submit paper rating:', error);
            return false;
        });
}

// 交卷和结果之间的中间屏：给整卷打个难度星，或跳过。给完/跳过后调 onDone()。
//
// 没登录（拿不到 token，评分存不下）就直接跳过这一步，不摆一个点了也白点的界面。
// 评分是否 POST 成功都照样进结果——绝不因为一个可选评分卡住学生看不到成绩。
function showPaperRatingStep(paperId, onDone) {
    const finish = () => { if (typeof onDone === 'function') onDone(); };

    if (!getToken()) { finish(); return; }   // 匿名用户：跳过评分

    const backdrop = document.createElement('div');
    backdrop.className = 'paper-rating-backdrop';

    const card = document.createElement('div');
    card.className = 'paper-rating-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Rate this test');

    const h3 = document.createElement('h3');
    h3.textContent = 'How hard was this test?';
    card.appendChild(h3);

    const sub = document.createElement('p');
    sub.className = 'paper-rating-sub';
    sub.textContent = 'Your rating helps show the paper’s difficulty to other students. Optional.';
    card.appendChild(sub);

    const starsWrap = document.createElement('div');
    starsWrap.className = 'paper-rating-stars';

    let chosen = 0;
    const starEls = [];
    const paint = upto => {
        starEls.forEach((el, i) => el.classList.toggle('filled', i < upto));
        starsWrap.className = 'paper-rating-stars' + (upto > 0 ? ` rating-level-${upto}` : '');
    };

    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('button');
        star.type = 'button';
        star.className = 'paper-rating-star';
        star.innerHTML = '<i class="fa-solid fa-star"></i>';
        star.title = `${i} star${i > 1 ? 's' : ''}`;
        star.addEventListener('mouseenter', () => paint(i));
        star.addEventListener('click', () => {
            chosen = i;
            paint(i);
            submitBtn.disabled = false;
        });
        starEls.push(star);
        starsWrap.appendChild(star);
    }
    starsWrap.addEventListener('mouseleave', () => paint(chosen));
    card.appendChild(starsWrap);

    const actions = document.createElement('div');
    actions.className = 'paper-rating-actions';

    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'paper-rating-skip';
    skipBtn.textContent = 'Skip';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'paper-rating-submit';
    submitBtn.textContent = 'Submit rating';
    submitBtn.disabled = true;   // 没选星之前不能提交

    actions.appendChild(skipBtn);
    actions.appendChild(submitBtn);
    card.appendChild(actions);

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);

    // 只关这一屏、进结果页。清理事件监听，别泄漏
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
        finish();
    };
    const onKey = e => {
        if (e.key === 'Escape') close();          // Esc = 跳过
        else if (e.key === 'Enter' && chosen) submitBtn.click();
    };
    document.addEventListener('keydown', onKey);

    skipBtn.addEventListener('click', close);
    submitBtn.addEventListener('click', () => {
        if (!chosen) return;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Saving…';
        // 存不下也照样进结果——评分是可选的，不该卡住成绩
        submitPaperRating(paperId, chosen).finally(close);
    });

    // 打开就把焦点放到第一颗星，键盘用户能直接操作
    requestAnimationFrame(() => starEls[0] && starEls[0].focus());
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

    renderLastAttempt(paperId);
    applyExamAnalyticsVisibility();   // 骨架是整个重建的，每次都要重新应用一次

    // 有未结束的考试就【整个跳过重置】，直接恢复到考试中。
    //
    // 之前的做法是「先重置、后面再恢复」，依赖两者的执行先后。
    // 但 loadTestingQuestions 可能被调用不止一次（切板块、版本下拉框初始化都会触发），
    // 第二次的重置会把第一次恢复好的状态又抹掉——
    // 表现就是落在 Examination 却退回了 Get Ready，而计时器还在后台跑。
    //
    // 改成在源头判断，不管调用多少次、什么顺序，都不会覆盖已恢复的考试。
    const pendingSession = readExamSession(paperId);

    if (pendingSession) {
        // 恢复的场次：标题要更新，其余状态一概不动。
        // 真正切到「考试中」是在 fetch 的回调里做的——那时候题目元素才存在。
        // 结算状态（exam-result-mode）也不清：这场考试还没结束
        headerTitle.textContent = paperTitle;
    } else {

        // 重置成初始状态（切换 Test、切换年份版本、或点「Retake Test」重考时都会跑一遍这里）
        header.classList.remove('exam-in-progress', 'exam-finished');
        headerTitle.textContent = paperTitle;
        triggerFadeIn(headerTitle);   // 切换年份版本时，标题文字有个淡入过渡，不是瞬间跳变
        timerDisplay.className = 'testing-timer';
        // 开考之前显示的是"时长说明"而不是一个看起来在走的计时器——
        // "Timer: 110:00" 会让人以为已经在倒计时了。
        // 点 Start 之后 renderTimerDisplay 会把它换成真正的倒计时
        timerDisplay.textContent = `${Math.round(COUNTDOWN_TOTAL_SECONDS / 60)} min limit`;
        toggleTimerBtn.style.display = 'inline-block';   // 交卷后会被隐藏，这里重新显示回来
        toggleTimerBtn.disabled = true;
        toggleTimerBtn.textContent = 'Hide Timer';
        startBtn.disabled = false;
        // 回到第一步：Get Ready。
        // 用 innerHTML 不用 textContent——按钮里有图标，
        // textContent 会把它冲掉，重考一次之后图标就没了
        startBtn.innerHTML = '<i class="fa-solid fa-arrow-right"></i> Get Ready';
        startBtn.classList.remove('is-leaving');   // 上一轮考试的淡出动画可能还没播完
        startBtn.style.display = 'inline-block';

        // 清掉「准备中」状态。换卷子、换年份、重考都会走到这里
        resetExamReadyState();

        // 会话也要清。重考是新的一场，不该沿用上一场的剩余时间；
        // 换卷子/换年份更是另一场考试
        clearExamSession();


        // 结算状态也要清掉，否则重考时 Your performance / Previous attempts
        // 会在还没开始考的时候就挂在那儿
        document.body.classList.remove('exam-result-mode');

        // 改卷阶段的状态也清：说明条拆掉、卷面头卡的隐藏解除，
        // 否则中途切走/重考时上一场的改卷状态会残留（头卡一直藏着）
        document.body.classList.remove('exam-marking-mode');
        const markingHold = document.getElementById('exam-marking-hold');
        if (markingHold) markingHold.remove();

        // 卡片里的数字也要清。只摘掉 exam-result-mode 的话，
        // 上一场的分数还在 DOM 里躺着，下一次交卷判分失败时会原样露出来
        resetPerformanceCard();

        // 标记是"这场考试里待会儿回来看"的意思，重考是新的一场，
        // 沿用上一场的标记没有意义
        clearExamFlags();
    }
    questionsContainer.style.display = 'none';
    questionsContainer.classList.remove('exam-questions-enter');
    questionsContainer.innerHTML = '';

    // 题目都清了，导航也要拆——否则会留下一条指向不存在的题的导航
    destroyQuestionNav();
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

        // 准备阶段的退路
        const cancelReadyBtn = document.getElementById('exam-cancel-ready-btn');
        if (cancelReadyBtn) {
            cancelReadyBtn.addEventListener('click', () => resetExamReadyState());
        }

        // Esc 也能退回。页头和导航栏在准备阶段是收起的，
        // 多留一个键盘出口
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (!document.body.classList.contains('exam-ready-mode')) return;

            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

            resetExamReadyState();
        });

        startBtn.addEventListener('click', () => {
            // ---- 第一步：Get Ready ----
            // 不开始考试，只是把干扰收掉、把规则摆到眼前。
            // 分析板块那些数字在准备考试的时候没有意义，反而分散注意力；
            // 说明这时候才出现，是因为它要在按下 Begin 之前被读到——
            // 一直摆在那儿反而会被当成装饰略过去
            if (!header.classList.contains('exam-ready')) {
                header.classList.add('exam-ready');
                document.body.classList.add('exam-ready-mode');
                startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Begin Examination';
                return;
            }

            // ---- 第二步：真正开考 ----

            // ⚠️ 开考前先清掉上一场留下的作答。
            //
            // 以前只有点 Retake 才清，问题是【不点 Retake 的路径太多了】：
            // 考完切个板块再回来、刷新页面、换年份版本再换回来……
            // 这些都会走到"重新开考"，但一次 clearAllAnswers 都没跑过。
            //
            // 后果不只是输入框里有旧字。更麻烦的是后端那份也还在：
            // 新的一场只答了第 1、3 题，中途一刷新，
            // restoreSavedAnswers 会把第 2 题【上一场】的答案填回来，
            // 学生根本分不出那是不是自己这次写的。
            //
            // "开考"才是清空的正确时机——Retake 只是通往开考的其中一条路。
            clearAllAnswers(header.dataset.currentPaperId);

            enterExamInProgressState();
        });

        submitBtn.addEventListener('click', () => {
            stopTestingTimer();

            const submittedPaperId = header.dataset.currentPaperId;
            recordExamCompletion(submittedPaperId);

            const examStartTime = countdownEndTime - COUNTDOWN_TOTAL_SECONDS * 1000;
            const totalElapsedSeconds = Math.round((Date.now() - examStartTime) / 1000);

            // 交卷立即做：持久化作答 + 结束会话。原来这两步在揭晓结果那段里，
            // 现在提前——评分屏期间刷新页面也不该被恢复成"考试中"。
            // flush 是兜底：最后 800ms 敲的东西可能还在防抖里没发出去
            flushAllAnswers(submittedPaperId);
            clearExamSession();

            // 交卷 →〔难度评分，可跳过〕→ 结果。中间这一步像 Get Ready 之于开考。
            // 揭晓结果整段搬进了 revealExamResults()，评分/跳过之后才跑
            showPaperRatingStep(submittedPaperId, () => revealExamResults(submittedPaperId, totalElapsedSeconds));
        });

        retakeBtn.addEventListener('click', () => {
            stopTestingTimer();

            const retakePaperId = header.dataset.currentPaperId;

            // 重考是全新的一场，把上一次的作答清干净。
            //
            // 时机放在【点 Retake】而不是【交卷】：交卷后学生要拿自己写的
            // 跟标准答案对照，那时候清掉就没得看了。
            // （交卷后输入框是 readonly 但文字可选中复制，就是为了这个。）
            clearAllAnswers(retakePaperId);

            // 用 header.dataset 里记录的当前 paperId/title，而不是绑定时闭包捕获的参数，
            // 避免中途切换过年份版本后，Retake 又跑回最早绑定时的那份考卷
            loadTestingQuestions(Number(retakePaperId), header.dataset.currentPaperTitle);
        });
    }

    showQuestionsLoading(questionsContainer);

    // ⚠️ 走 /testing/ 而【不是】 /practice/。两个接口的区别就是
    // 前者不带 question_solution 和 rubric。
    //
    // 以前这里用的是 /practice/，标准答案在进考试页面的那一刻就跟着
    // 题目一起下发了，渲染成 <pre> 塞在 DOM 里，靠 CSS 的 display:none 藏着。
    // 那不是"藏"——Elements 面板点开就是，控制台一行
    // $$('.testing-answer').map(e => e.textContent) 全出来。
    // 说明面板里那句 "Solutions stay hidden until you submit" 当时是假的。
    //
    // 现在答案由 revealSolutions() 在【交卷之后】单独去拉。
    fetch(`${APP_API_BASE}/api/questions/testing/${paperId}`)
        .then(response => response.json())
        .then(data => {
            questionsContainer.innerHTML = '';   // 清掉加载提示，再填真正的题目

            // 把真实题目数填进考卷卡片。题目是进页面就拉的、不是点 Start 才拉，
            // 所以这个数在开考前就拿得到，不用编
            const countEl = document.getElementById('exam-question-count');
            if (countEl) countEl.textContent = String(data.length);

            data.forEach(question => {
                const wrapper = buildQuestionBlock(question, { showExamFlag: true });

                // 答题区和标准答案包在同一个容器里，交卷后并排显示。
                //
                // 并排的好处是能逐行对照，不用上下滚动来回看。
                // 代价是两边宽度各减半，长代码会挤——所以窄屏下 CSS 会
                // 自动堆叠回上下排列（见 .answer-compare 的媒体查询）
                const compare = document.createElement('div');
                compare.className = 'answer-compare';

                compare.appendChild(buildAnswerEditor(question.id));

                // 标准答案这里【故意不建】。
                // /testing/ 接口根本没返回 question_solution，
                // 交卷后由 revealSolutions() 拉 /practice/ 补进这个容器

                wrapper.appendChild(compare);

                questionsContainer.appendChild(wrapper);
            });

            // 有未结束的考试就直接恢复到考试中，跳过 Get Ready 那两步。
            // ⚠️ 必须放在题目渲染【之后】——恢复要显示题目容器、
            // 那时候元素得已经存在
            const session = readExamSession(paperId);

            // ⚠️ 【只在考试进行中才填回作答】。
            //
            // 以前这行是无条件跑的，结果是：考完试不点 Retake、切个板块
            // 再回来，输入框里还是上一场写的东西，而页面明明显示
            // "还没开考"。学生会以为系统记错了。
            //
            // 作答保存在后端本来就只是为了【中途刷新能接着写】，
            // 没有会话就说明这不是"中途"，不该往框里填内容。
            // 后端那份不删——重新开考时会被 clearAllAnswers 清掉，
            // 而且留着也不显示，不会造成困扰。
            //
            // 必须在 enterExamInProgressState 之前：先把写过的内容填回去，
            // 再切到考试中状态，顺序反了的话学生会先看到空白的输入框
            if (session) {
                restoreSavedAnswers(paperId);
                enterExamInProgressState(session.endTime);
            }

            triggerFadeIn(questionsContainer);
        })
        .catch(error => {
            console.error('Failed to Obtain Testing Questions:', error);
            showQuestionsError(questionsContainer);
        });
}

// 切到「考试进行中」的状态。
//
// 开考和「刷新后恢复」走的是同一个函数——两边要做的事几乎一样
// （切状态、起计时器、显示题目、收起页面骨架），
// 分开写两份必然会漏掉其中一处，改动时也容易只改一边。
//
// resumeEndTime 有值 = 从刷新中恢复：计时器沿用原来的结束时间，
// 并且【跳过所有入场动画】——那些动画是给"刚点下按钮"这个动作做反馈的，
// 刷新后播一遍会让人以为考试是这一刻才开始的。
function enterExamInProgressState(resumeEndTime = null) {
    const header = document.getElementById('testing-header');
    const timerDisplay = document.getElementById('testing-timer');
    const startBtn = document.getElementById('testing-start-btn');
    const submitBtn = document.getElementById('testing-submit-btn');
    const toggleTimerBtn = document.getElementById('timer-toggle-btn');
    const questionsContainer = document.getElementById('testing-questions');
    const versionWrap = document.getElementById('version-selector-wrap');

    if (!header || !timerDisplay || !startBtn || !submitBtn || !questionsContainer) return;

    const isResume = !!resumeEndTime;

    // 三个状态互斥，两个标记都要摘掉。
    //
    // body 上的 exam-ready-mode：不摘的话考试期间会同时挂着它和 exam-focus-mode，
    // 两条针对 .exam-info-panel 的规则特异性一模一样，
    // 谁生效取决于它们在文件里的先后——这种依赖太脆。
    //
    // header 上的 exam-ready：漏掉过一次。它不影响样式（CSS 规则都挂在
    // body.exam-ready-mode 上），但按钮的分支判断读的是它——
    //     if (!header.classList.contains('exam-ready')) { 走第一步 }
    // 留着的话状态就不一致了，而且刷新恢复之后 header 上会同时有
    // exam-ready 和 exam-in-progress，看 class 完全读不出当前是哪一步
    document.body.classList.remove('exam-ready-mode');
    header.classList.remove('exam-ready');

    // 状态标志全部立刻设置，只有【显隐】走动画——
    // 逻辑状态和视觉过渡分开，避免动画期间点到不该点的东西
    submitBtn.disabled = false;
    if (toggleTimerBtn) toggleTimerBtn.disabled = false;
    startBtn.disabled = true;
    timerDisplay.classList.add('timing-active');
    header.classList.add('exam-in-progress');
    if (versionWrap) versionWrap.classList.add('hide-during-exam');   // 考试期间隐藏版本切换，避免中途换年份

    startTestingTimer(resumeEndTime);
    enterExamFocusMode(isResume);   // 恢复时页面骨架瞬间收起，不播展开动画

    submitBtn.style.display = 'inline-block';
    questionsContainer.style.display = 'block';

    // 载入本场考试的标记。刷新页面后要能恢复，
    // 所以先读 sessionStorage 再建导航
    flaggedQuestionIds = readExamFlags(header.dataset.currentPaperId);
    document.querySelectorAll('#testing-questions .question-block').forEach(block => {
        refreshFlagButton(block.dataset.questionId);
    });

    // 题目这时候才可见，导航条也在这时候才建。
    // 开考前建的话点了跳不到任何地方——那时候题目容器是隐藏的
    buildQuestionNav();

    if (isResume) {
        // 恢复：所有东西直接就位，不播动画
        startBtn.style.display = 'none';
        return;
    }

    // 开考的过渡分成三段，错开一点而不是同时发生：
    //   1. Start 按钮先淡出缩小（180ms）
    //   2. 计时器同时从"时长说明"平滑变成倒计时
    //   3. 题目延后 140ms 再淡入上移，等按钮先让开位置

    // display 没法过渡，所以先加 class 播动画，播完再真正从版面里拿掉
    startBtn.classList.add('is-leaving');
    setTimeout(() => {
        startBtn.style.display = 'none';
        startBtn.classList.remove('is-leaving');
    }, 200);

    // 题目淡入。先移除再强制重排再加上，否则连续两次开考（Retake）时
    // 动画不会重播
    questionsContainer.classList.remove('exam-questions-enter');
    void questionsContainer.offsetWidth;
    questionsContainer.classList.add('exam-questions-enter');

    // 播完把 class 去掉。动画里有 transform，而 animation-fill-mode 会让
    // 最后一帧的 transform 永久留在元素上——任何非 none 的 transform 都会让
    // 后代 position: fixed 相对它定位而不是相对视口，之前踩过这个坑
    setTimeout(() => {
        questionsContainer.classList.remove('exam-questions-enter');
    }, 700);
}

// ---------- 考试会话的持久化 ----------
// 刷新页面之后要能接着考，而不是从头开始。
//
// 存的是【结束时间戳】不是【剩余秒数】：
// 时间戳是绝对的，刷新后直接跟 Date.now() 相减就得到剩余时间；
// 存剩余秒数的话还得记录"存的那一刻是几点"，等于绕了一圈。
//
// 用 sessionStorage 不是 localStorage：
// 关掉标签页就该结束这场考试，不该几天后打开还在倒计时。
const EXAM_SESSION_KEY = 'code100_exam_session';

function saveExamSession(paperId, endTime) {
    try {
        sessionStorage.setItem(EXAM_SESSION_KEY, JSON.stringify({
            paperId: String(paperId),
            endTime: endTime
        }));
    } catch (e) {
        // 存不进去就算了，最多是刷新后要重新开始
        console.warn('Failed to save exam session:', e);
    }
}

function clearExamSession() {
    try {
        sessionStorage.removeItem(EXAM_SESSION_KEY);
    } catch (e) { /* 忽略 */ }
}

// 有没有未结束的考试（不关心是哪一场）。
// 页面初始化时用它决定落在哪个板块——那时候还没加载任何卷子，
// 拿不到 paperId，所以不能用 readExamSession
function hasUnfinishedExam() {
    let raw;
    try {
        raw = JSON.parse(sessionStorage.getItem(EXAM_SESSION_KEY));
    } catch (e) {
        return false;
    }
    return !!(raw && raw.endTime && raw.endTime > Date.now());
}

// 读出未结束的考试。返回 null 表示没有可恢复的场次
function readExamSession(paperId) {
    let raw;
    try {
        raw = JSON.parse(sessionStorage.getItem(EXAM_SESSION_KEY));
    } catch (e) {
        return null;
    }
    if (!raw || !raw.endTime) return null;

    // 必须是同一张卷子。换了 Test 或者换了年份就不该恢复——
    // 那是另一场考试了
    if (String(raw.paperId) !== String(paperId)) return null;

    // 已经超时的场次不恢复。学生关着页面等到时间过完再打开，
    // 不该看到一个负数的倒计时
    if (raw.endTime <= Date.now()) {
        clearExamSession();
        return null;
    }

    return raw;
}

// ---------- 判分 ----------
// 交卷后在浏览器里跑学生的代码，跟测试用例比对。
// 引擎在 grading-engine.js（用 Pyodide 跑 Python）。
//
// ⚠️ 当前是验证阶段：
//   - 超时保护不可靠，学生写死循环会卡死页面（要换 Web Worker）
//   - 隐藏用例的输入在 Network 面板里看得见（浏览器端判分的固有限制）
//   上线给学生用之前这两条都要处理。

// 两栏之间的拖动条。
//
// 拖的是 CSS 变量 --answer-split（左栏占的百分比），布局是三列
// minmax(0, var(--answer-split)) | auto | minmax(0, 1fr)——
// 右栏吃掉剩下的，所以【总宽度不变】，左边多一点右边就少一点。
//
// 每道题的两栏各拖各的，不联动：学生可能只想把某一道题的
// 标准答案拉宽看清楚，没理由把整张卷子都改了。
const ANSWER_SPLIT_MIN = 20;   // 单侧最小占比（%）。再小就只剩一条缝，没有意义
const ANSWER_SPLIT_MAX = 80;

function buildSplitHandle(compare) {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.className = 'answer-split-handle';
    handle.setAttribute('aria-label', 'Drag to resize the two panels');

    // 键盘也能调。拖动条对键盘用户本来完全不可用，
    // 加上方向键之后至少能用
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');

    const setSplit = (percent) => {
        const clamped = Math.min(ANSWER_SPLIT_MAX, Math.max(ANSWER_SPLIT_MIN, percent));
        compare.style.setProperty('--answer-split', `${clamped}%`);
        handle.setAttribute('aria-valuenow', String(Math.round(clamped)));
    };

    setSplit(50);

    const onPointerMove = (event) => {
        const rect = compare.getBoundingClientRect();
        if (rect.width === 0) return;
        setSplit(((event.clientX - rect.left) / rect.width) * 100);
    };

    const onPointerUp = () => {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.body.classList.remove('is-splitting');
        handle.classList.remove('is-dragging');
    };

    handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();   // 不让浏览器把这次按下当成拖选文字的开始

        // ⚠️ 监听挂在 document 上，不是 handle 上。
        // 挂在 handle 上的话，鼠标一拖快就跑到条子外面去了，
        // 后续的 move 事件收不到，表现就是"拖着拖着断了"
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);

        document.body.classList.add('is-splitting');
        handle.classList.add('is-dragging');
    });

    handle.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 10 : 2;
        const current = parseFloat(compare.style.getPropertyValue('--answer-split')) || 50;

        if (event.key === 'ArrowLeft') {
            setSplit(current - step);
        } else if (event.key === 'ArrowRight') {
            setSplit(current + step);
        } else if (event.key === 'Home') {
            setSplit(50);           // 回到对半
        } else {
            return;
        }
        event.preventDefault();
    });

    // 双击复位。拖歪了想回到对半，比一点点挪回去快
    handle.addEventListener('dblclick', () => setSplit(50));

    return handle;
}

// ============================================================
// 交卷后：揭晓标准答案 + 学生自评
// ============================================================
//
// 考试期间前端走 /testing/，那个接口不含 question_solution 和 rubric，
// 所以答案压根没到过浏览器。交卷后才来拉 /practice/ 补上。
//
// 顺带把自评界面装起来：不在 AUTO_GRADED_CATEGORIES 里的题
// （half-program / full-program 这类大题）自动判不了，
// 交给学生对着标准答案和减分条件自己打分。
function revealSolutions(paperId) {
    return fetch(`${APP_API_BASE}/api/questions/practice/${paperId}`)
        .then(res => res.ok ? res.json() : null)
        .then(questions => {
            if (!questions) throw new Error('No solution data.');

            const byId = new Map(questions.map(q => [String(q.id), q]));

            document.querySelectorAll('#testing-questions .question-block').forEach(block => {
                const question = byId.get(block.dataset.questionId);
                const compare = block.querySelector('.answer-compare');
                if (!question || !compare) return;

                if (question.question_solution) {
                    // 拖动条插在两栏【中间】，所以要在标准答案之前加进去。
                    // 只有两栏都在时才有意义——没有标准答案的题只有一栏，
                    // 那时候加个拖动条，拖谁?
                    compare.appendChild(buildSplitHandle(compare));
                    compare.classList.add('has-split');

                    const solutionBox = document.createElement('div');
                    solutionBox.className = 'answer-solution-box';

                    const solutionLabel = document.createElement('div');
                    solutionLabel.className = 'answer-editor-label';
                    solutionLabel.textContent = 'Model answer';
                    solutionBox.appendChild(solutionLabel);

                    const solutionPre = document.createElement('pre');
                    // 直接带上 .show：以前答案是开考前就渲染好、藏起来，
                    // 交卷时再加 .show 显示。现在是交卷后才创建的，
                    // 没有"先藏后显"这一步了
                    solutionPre.className = 'answer-code testing-answer show';
                    solutionPre.textContent = question.question_solution;

                    // tabindex=0 让这块代码可以被点中（也能用 Tab 键走到）。
                    // 【它是"点进来才能滚"的关键】：CSS 里滚动条是挂在
                    // :focus 上的，元素不可聚焦就永远 focus 不了。
                    // 顺带也解决了键盘用户没法滚长代码的问题
                    solutionPre.tabIndex = 0;
                    solutionPre.setAttribute('role', 'region');
                    solutionPre.setAttribute('aria-label', 'Model answer, click to scroll');

                    solutionBox.appendChild(solutionPre);

                    // 内容超出了才加渐隐提示。不超出还加的话，
                    // 底部凭空多一道看不出所以然的阴影
                    requestAnimationFrame(() => {
                        if (solutionPre.scrollHeight > solutionPre.clientHeight + 1) {
                            solutionBox.classList.add('is-scrollable');
                        }
                    });

                    compare.appendChild(solutionBox);
                }

                // 自动判分的题到此为止，分数由判分引擎给
                if (isAutoGradedCategory(question.question_category)) return;

                // 自评框放在【题号行和题干之间】，而不是追加到题块最底部——
                // 改卷时评分入口紧跟题号，学生不用滚到最下面找
                const selfBox = buildSelfAssessment(question);
                const labelRow = block.querySelector('.question-label-row');
                if (labelRow && labelRow.nextSibling) {
                    block.insertBefore(selfBox, labelRow.nextSibling);
                } else {
                    block.appendChild(selfBox);
                }
            });

            updateSelfAssessedTotal();

            // Difficulty analysis 的星级：优先用整卷评分，回退到这份 /practice/
            // 数据里每道题的 avg_rating 聚合。放在这里是因为【只有此刻】合法地
            // 拿到了带评分的题目数据（考前拉 /practice/ 会泄露答案）
            applyRealDifficulty(paperId, questions);
        })
        .catch(error => {
            console.error('Failed to load solutions:', error);

            // 答案拉不到就直说。什么都不做的话学生看到的是一片空白的
            // 对照区，会以为这些题本来就没有标准答案
            const container = document.getElementById('testing-questions');
            if (container && !container.querySelector('.solutions-error')) {
                const note = document.createElement('p');
                note.className = 'solutions-error';
                note.textContent = 'Could not load the model answers — please refresh the page.';
                container.prepend(note);
            }
        });
}

// 一道自评题的界面：减分条件 + 自己打的分。
//
// ⚠️ 自评分【存不下来】。Exam_Completions 现在只有 user_id / paper_id /
//    completed_at，没有分数字段（见 migration_grading_scope.sql 末尾的说明：
//    自评 UI 还不存在的时候加列只会得到一列 NULL）。
//    所以刷新页面自评分就没了，界面上要跟学生说清楚这件事
function buildSelfAssessment(question) {
    const box = document.createElement('div');
    box.className = 'self-assess-box';

    const heading = document.createElement('div');
    heading.className = 'self-assess-heading';
    heading.textContent = 'Mark this one yourself';
    box.appendChild(heading);

    if (question.rubric) {
        const rubric = document.createElement('div');
        rubric.className = 'self-assess-rubric';
        // rubric 是老师录进数据库的自由文本，用 textContent 不用 innerHTML——
        // 录入时手滑打了 < 号也不该变成标签
        rubric.textContent = question.rubric;
        box.appendChild(rubric);
    } else {
        const missing = document.createElement('p');
        missing.className = 'self-assess-missing';
        // 没有减分条件的话学生只能靠感觉打分，这一点要明说，
        // 不能让界面看起来像"这题本来就没有评分标准"
        missing.textContent = 'No marking guide has been entered for this question yet.';
        box.appendChild(missing);
    }

    const row = document.createElement('div');
    row.className = 'self-assess-row';

    const points = Number(question.points);
    const hasPoints = Number.isFinite(points) && points > 0;

    if (hasPoints) {
        const label = document.createElement('label');
        label.className = 'self-assess-label';
        label.textContent = 'Your mark';

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'self-assess-input';
        input.min = '0';
        input.max = String(points);
        // 允许半分：CS1 的评分标准里 0.5 分很常见
        input.step = '0.5';
        input.placeholder = '—';
        input.dataset.maxPoints = String(points);

        input.addEventListener('input', () => {
            // 夹在 [0, points] 之间。学生手滑输入 999 的话，
            // 总分会变成一个没有意义的数字
            const raw = parseFloat(input.value);
            if (Number.isFinite(raw)) {
                if (raw > points) input.value = String(points);
                if (raw < 0) input.value = '0';
            }
            updateSelfAssessedTotal();
        });

        const outOf = document.createElement('span');
        outOf.className = 'self-assess-outof';
        outOf.textContent = `/ ${points}`;

        label.appendChild(input);
        label.appendChild(outOf);
        row.appendChild(label);
    } else {
        // points 是 null（还没录分值）。
        // ⚠️ 【不能】默认成 0 或者 1 —— 那样总分会静默算错，而且看不出来。
        // 明说分值没录，这道题就不参与总分
        const note = document.createElement('p');
        note.className = 'self-assess-missing';
        note.textContent = 'No mark value has been set for this question, so it is left out of the total.';
        row.appendChild(note);
    }

    box.appendChild(row);
    return box;
}

// 汇总自评分。
//
// ⚠️ 跟自动判分的分数【分开显示】，不合并成一个总分。
//    两者性质不同：一个是测试用例跑出来的，一个是学生自己填的。
//    合成一个数字之后，那个数字既不是客观成绩也不是自评成绩，
//    没有任何一句话能准确描述它是什么
function updateSelfAssessedTotal() {
    // 改卷阶段：每次自评分变化都重新判断能不能提交（放最前，不受下面 early return 影响）
    syncMarkingHoldSubmit();

    const inputs = [...document.querySelectorAll('.self-assess-input')];
    if (inputs.length === 0) return;

    let earned = 0;
    let total = 0;
    let filled = 0;

    inputs.forEach(input => {
        const max = Number(input.dataset.maxPoints);
        if (!Number.isFinite(max)) return;
        total += max;

        const value = parseFloat(input.value);
        if (Number.isFinite(value)) {
            earned += value;
            filled += 1;
        }
    });

    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card || total === 0) return;

    let note = card.querySelector('.exam-self-score');
    if (!note) {
        note = document.createElement('p');
        note.className = 'exam-self-score';
        card.appendChild(note);
    }

    // 还没填完时把进度也写出来，否则学生看到一个偏低的总分
    // 会以为是自己分低，其实只是还没填
    const progress = filled < inputs.length
        ? ` (${filled} of ${inputs.length} marked)`
        : '';

    note.textContent =
        `Self-assessed: ${earned} / ${total} points${progress}.`;

    // 自评分现在【会存】：更新最新一次尝试的 self 分（防抖），并刷新 Scoring Detail
    // 下层的"You"。paperId 从考卷头上取（自评界面只在结算页出现，那时它是当前卷）
    const paperId = document.getElementById('testing-header')?.dataset.currentPaperId;
    if (paperId) {
        pushSelfScoreUpdate(paperId);
        refreshScoringDetail(paperId);
    }
}

// ============================================================
// 考试期间的「标记」
// ============================================================
//
// 做不出来先跳过、待会儿回来看的那种标记。
//
// ⚠️ 跟 Revision 的星标（starredQuestionIds / question-star-btn）
//    【不是一回事】，故意不复用：
//      星标  = "这题以后要复习"，存后端，跨会话一直在
//      标记  = "这场考试里待会儿回来看"，考完就没意义了
//    混用的话，考试中随手标几道题，Revision 页面会莫名多出一堆内容。
//
// 存 sessionStorage，跟考试会话同寿命——刷新页面还在，
// 关掉标签页就没了，跟这场考试一起结束。
const EXAM_FLAGS_KEY = 'code100_exam_flags';

let flaggedQuestionIds = new Set();

function readExamFlags(paperId) {
    try {
        const raw = JSON.parse(sessionStorage.getItem(EXAM_FLAGS_KEY));
        // 卷子对不上就当没有——换了年份版本，上一张卷的标记不该跟过来
        if (!raw || String(raw.paperId) !== String(paperId)) return new Set();
        return new Set(raw.ids || []);
    } catch (e) {
        return new Set();
    }
}

function saveExamFlags(paperId) {
    try {
        sessionStorage.setItem(EXAM_FLAGS_KEY, JSON.stringify({
            paperId: String(paperId),
            ids: [...flaggedQuestionIds]
        }));
    } catch (e) {
        // 存不进去最多是刷新后标记没了，不影响答题
        console.warn('Failed to save exam flags:', e);
    }
}

function clearExamFlags() {
    flaggedQuestionIds = new Set();
    try {
        sessionStorage.removeItem(EXAM_FLAGS_KEY);
    } catch (e) {
        /* 清不掉也无所谓，下次开考会按 paperId 判定失效 */
    }
}

// 切换一道题的标记状态，并把三处显示同步过去：
// 题目上那个按钮、导航面板上的方格、sessionStorage
function toggleExamFlag(questionId, paperId) {
    const id = String(questionId);

    if (flaggedQuestionIds.has(id)) {
        flaggedQuestionIds.delete(id);
    } else {
        flaggedQuestionIds.add(id);
    }

    saveExamFlags(paperId);
    refreshFlagButton(id);
    refreshQuestionNavFlags();
}

function refreshFlagButton(questionId) {
    const id = String(questionId);
    const btn = document.querySelector(
        `#testing-questions .question-block[data-question-id="${id}"] .exam-flag-btn`
    );
    if (!btn) return;

    const on = flaggedQuestionIds.has(id);
    btn.classList.toggle('is-flagged', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Remove flag' : 'Flag to come back to';
}

// 题目上那个「标记」按钮。放在答题框的标签那一行右边——
// 学生是在写答案的时候决定"这题先跳过"的，按钮就该在手边
function buildFlagButton(questionId, paperId) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'exam-flag-btn';
    btn.innerHTML = '<i class="fa-regular fa-flag"></i><span>Flag</span>';
    btn.setAttribute('aria-pressed', 'false');
    btn.title = 'Flag to come back to';

    btn.addEventListener('click', () => toggleExamFlag(questionId, paperId));
    return btn;
}

// ============================================================
// 题目导航条
// ============================================================
//
// 容器（<nav id="exam-question-nav">）写在 skeleton.html 里，
// 【不在这里 createElement】。理由是位置：
// 它得待在 #testing-content 内部，切板块时跟着一起隐藏。
// 以前是 appendChild 到 <body> 上的，结果考试中途切到 Revision，
// 这条导航还浮在右边不走。
//
// 这里只负责往容器里填题号按钮——题号是动态的（每张卷子题目数不一样），
// 那部分写不进 HTML。

let questionNavObserver = null;

function getQuestionNav() {
    return document.getElementById('exam-question-nav');
}

function destroyQuestionNav() {
    if (questionNavObserver) {
        questionNavObserver.disconnect();
        questionNavObserver = null;
    }

    // 边距跟条子同生同灭
    document.body.classList.remove('has-question-nav');

    const nav = getQuestionNav();
    if (!nav) return;

    // 清空并藏起来，但【保留元素本身】——它是 skeleton.html 的一部分，
    // 删掉的话下次考试就没有容器可以填了
    nav.innerHTML = '';
    nav.hidden = true;
}

function buildQuestionNav() {
    // 先清旧的。重考、换年份都会重建题目，
    // 不清的话会留下一批指向已经不存在的题的按钮
    destroyQuestionNav();

    const nav = getQuestionNav();
    const container = document.getElementById('testing-questions');
    if (!nav || !container) return;

    const blocks = [...container.querySelectorAll('.question-block')];
    if (blocks.length === 0) return;

    blocks.forEach(block => {
        // 题号直接从已经渲染好的标签上读，不另外存一份到 dataset。
        // 存两份的话，哪天题号的拼法改了（比如加上年份），
        // 导航这边不会跟着变
        const labelEl = block.querySelector('.question-label');
        const label = labelEl ? labelEl.textContent.replace(/\.\s*$/, '').trim() : '•';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'exam-nav-item';
        btn.textContent = label;
        btn.dataset.targetQuestion = block.dataset.questionId;
        btn.title = `Question ${label}`;

        btn.addEventListener('click', () => {
            // scroll-margin-top 在 CSS 里，保证跳过去之后
            // 题目不会被顶部的 Test 分类导航栏压住
            block.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });

        nav.appendChild(btn);
    });

    nav.hidden = false;

    // 让 CSS 知道面板在了，好给 #testing-content 留出右边距。
    // 边距和面板必须同生同灭，所以两件事绑在同一处开关上
    document.body.classList.add('has-question-nav');


    // 滚到哪道题就高亮哪个。
    // rootMargin 上下各收 45%，等于只把视口中间那一条窄带算作"当前"——
    // 不收的话屏幕上同时可见的三四道题会一起高亮，等于没高亮
    //
    // lastCurrent 记住上一个当前项：滚到页面最顶或最底时，
    // 那条窄带里可能【一道题都没有】，这时候如果不兜底，
    // 唯一显示数字的那一段会突然变回条子，看起来像坏了
    let lastCurrent = nav.querySelector('.exam-nav-item');

    questionNavObserver = new IntersectionObserver(entries => {
        entries.forEach(entry => {
            const btn = nav.querySelector(
                `[data-target-question="${entry.target.dataset.questionId}"]`
            );
            if (btn) btn.classList.toggle('is-current', entry.isIntersecting);
        });

        const found = nav.querySelector('.exam-nav-item.is-current');
        if (found) {
            lastCurrent = found;
        } else if (lastCurrent) {
            lastCurrent.classList.add('is-current');
        }
    }, { rootMargin: '-45% 0px -45% 0px' });

    blocks.forEach(block => questionNavObserver.observe(block));

    // 初始化在第一题。
    // ⚠️ 必须放在 observe() 【之后】：IntersectionObserver 一注册就会
    // 异步回调一次所有观察对象，没进窄带的会被 toggle 掉。
    // 先加类的话会被那次回调抹掉。
    // 这里等一帧，让那次初始回调先跑完，再由上面的 lastCurrent 兜底
    // 补上第一题——所以这里不用自己加类，交给回调就行
    if (lastCurrent) lastCurrent.classList.add('is-current');

    refreshQuestionNavAnswered();
    refreshQuestionNavFlags();
}

// 标出哪些题写了东西。考试快结束时扫一眼就知道哪道还空着——
// 这是这个导航条比"回到顶部"有用的地方
function refreshQuestionNavAnswered() {
    const nav = getQuestionNav();
    if (!nav || nav.hidden) return;

    document.querySelectorAll('#testing-questions .question-block').forEach(block => {
        const textarea = block.querySelector('.answer-editor-input');
        const btn = nav.querySelector(`[data-target-question="${block.dataset.questionId}"]`);
        if (btn) {
            btn.classList.toggle('is-answered', !!(textarea && textarea.value.trim()));
        }
    });
}

// 把标记状态同步到导航面板。
// ⚠️ 标记的样式要盖过"已作答"——一道题可能既写了答案又被标记，
//    那时候学生更需要看到的是"这题我要回来改"，而不是"这题写了"。
//    优先级在 CSS 里靠规则顺序保证（.is-flagged 写在 .is-answered 后面）
function refreshQuestionNavFlags() {
    const nav = getQuestionNav();
    if (!nav || nav.hidden) return;

    nav.querySelectorAll('.exam-nav-item').forEach(btn => {
        btn.classList.toggle(
            'is-flagged',
            flaggedQuestionIds.has(String(btn.dataset.targetQuestion))
        );
    });
}

// 交卷后触发判分。没有测试用例的题会被跳过，不影响其他题
function gradeExamAnswers(paperId) {
    if (typeof gradeQuestion !== 'function') {
        console.warn('Grading engine not loaded.');
        setNoAutoScore('Auto-checking is unavailable right now.');
        return Promise.resolve(null);
    }

    // 成绩卡片先进入"计算中"状态。Pyodide 首次要下 3~4MB，
    // 这段时间卡片上如果还挂着上一场的数字，会被当成本场的成绩
    setPerformanceCardPending(true);

    lastAutoScore = null;   // 本场自动分先清，算出来才填（Scoring Detail 的"You"要用）

    // ⚠️ 必须 return 这条链：revealExamResults 拿它的返回值 .then() 去存尝试。
    // 漏了 return 的话这里返回 undefined，调用方 undefined.then() 会抛 TypeError，
    // 把 revealExamResults 拦在 exam-result-mode 之前——结果就是交卷后
    // 题目还在、Correction 头也在，但分析卡整块不出现（排查过一次，别再删）
    return fetch(`${APP_API_BASE}/api/questions/papers/${paperId}/test-cases`)
        .then(res => res.ok ? res.json() : null)
        .then(caseMap => {
            if (!caseMap || Object.keys(caseMap).length === 0) {
                // 这张卷子一条测试用例都没录。这是【当前的常态】——
                // 目前只有第 6 题有用例，其余卷子都会走到这里
                setNoAutoScore('No questions on this paper are auto-checked yet.');
                return null;
            }

            const blocks = [...document.querySelectorAll('#testing-questions .question-block')];
            const jobs = [];

            blocks.forEach(block => {
                const questionId = block.dataset.questionId;

                // 只判这四类：one-liners / debugging / get-output / mcq。
                // 其余的题（half-program、full-program）走自评，
                // 由 revealSolutions() 给它们装自评界面。
                //
                // 这个判断放在取用例【之前】：万一某道大题被误录了测试用例，
                // 也不该拿去自动判——题型才是唯一的依据
                if (!isAutoGradedCategory(block.dataset.questionCategory)) return;

                const cases = caseMap[questionId];
                if (!cases || cases.length === 0) return;   // 这道题没录用例，跳过

                const textarea = block.querySelector('.answer-editor-input');
                const code = textarea ? textarea.value : '';

                // 这道题的权重：录了 points 就按 points，没录就 1 分/题（等权）。
                // 自动分做成加权绝对分（auto_points / auto_max）而不是纯百分比平均，
                // 是为了跟自评分（也是绝对分）能相加成总分，且录 points 后自动生效
                const points = Number(block.dataset.points);
                const weight = Number.isFinite(points) && points > 0 ? points : 1;

                // 每道题一个"判分中"的占位
                const panel = document.createElement('div');
                panel.className = 'grade-panel is-pending';
                panel.innerHTML = `
                    <span class="grade-spinner"></span>
                    <span class="grade-pending-text">Checking your answer…</span>
                `;
                // 判分面板放在对照区【上面】：先看得分和哪条没过，
                // 再往下逐行对照代码。
                // ⚠️ 插入点从 .testing-answer 改成 .answer-compare——
                // 标准答案现在包在对照容器里，不再是 block 的直接子元素，
                // 用旧的选择器会插到容器【内部】，破坏并排布局
                block.insertBefore(panel, block.querySelector('.answer-compare'));

                jobs.push(
                    gradeQuestion(code, cases)
                        .then(result => {
                            renderGradeResult(panel, result);
                            // 结果页题号旁的「得分/总分」云徽标。只在录了 points 时加
                            // （没 points 就没绝对总分）；没作答/跳过的题不加
                            if (Number.isFinite(points) && points > 0 && result && !result.skipped) {
                                addEarnedBadge(block, Math.round(result.score / 100 * points), points, 'auto');
                            }
                            return { result, weight };
                        })
                        .catch(error => {
                            console.error('Grading failed:', error);
                            panel.className = 'grade-panel is-error';
                            panel.textContent = 'Could not check this answer.';
                            return null;   // 这道题算不出来，不计入总分
                        })
                );
            });

            // 全部判完再算总分。
            // 用 Promise.all 而不是逐题累加：逐题累加的话总分会一格一格往上跳，
            // 而且中途的数字是没有意义的"半场比分"
            return Promise.all(jobs).then(entries => {
                const valid = entries.filter(e => e && e.result && !e.result.skipped);
                if (valid.length === 0) {
                    // 有用例，但没有一道题算出结果——通常是这几道题都没作答
                    setNoAutoScore('Nothing to auto-check — none of the auto-checked questions were answered.');
                    return null;
                }

                // 加权绝对分：每题 (通过率 × 权重) 累加。题内部的用例权重已经在
                // gradeQuestion 里折算进 result.score（0~100）了
                let autoPoints = 0;
                let autoMax = 0;
                valid.forEach(e => {
                    autoPoints += (e.result.score / 100) * e.weight;
                    autoMax += e.weight;
                });

                const overall = Math.round(autoPoints / autoMax * 100);
                applyRealScore(overall, valid.length);

                lastAutoScore = { points: autoPoints, max: autoMax };   // 供 Scoring Detail 的"You"

                // 交给调用方（revealExamResults）去存这次尝试
                return { autoPoints, autoMax, gradedCount: valid.length };
            });
        })
        .catch(error => {
            console.error('Failed to load test cases:', error);
            setNoAutoScore('Could not check your answers — please try again later.');
        });
}

// 成绩卡片的"计算中"状态
function setPerformanceCardPending(pending) {
    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (card) card.classList.toggle('is-calculating', pending);
}

// 把成绩卡片恢复成没考过的样子。重考/换卷子时调。
//
// ⚠️ 不清的话上一场的数字会留在卡片上。平时看不出来（那时候
// exam-result-mode 已经摘掉，整张卡是隐藏的），但下一次交卷如果判分
// 走不下去——比如新换的这张卷子没录用例——卡片一显示出来，
// 挂着的还是【上一场】的分数，而它看起来跟本场成绩没有任何区别。
function resetPerformanceCard() {
    // 重考/换卷是新的一场，清掉本场成绩状态，别让上一场的自动分/尝试记录串场
    currentAttemptPaperId = null;
    lastAutoScore = null;

    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card) return;

    card.classList.remove('has-real-score', 'is-calculating');

    // 两条说明文字都是动态插进去的，直接删掉
    card.querySelectorAll('.exam-score-note, .exam-self-score').forEach(el => el.remove());

    const stats = card.querySelectorAll('.exam-stat');
    const scoreValue = stats[0] && stats[0].querySelector('.exam-stat-value');
    if (scoreValue) scoreValue.textContent = '—';

    // 用时那格回到初始："—" + 去掉 data-real-stat（applyTimeSpentStat 交卷时再置回）。
    // ⚠️ 只清用时这一格，【不能】用 querySelectorAll('[data-real-stat]') 全清——
    //    Ranking 那格的 data-real-stat 是常驻的（它永远是真数据，不是每场重置的），
    //    全清会让它在下一场被 has-real-score 的 CSS 加上 "(sample)"
    const timeStat = stats[stats.length - 1];
    if (timeStat) {
        timeStat.removeAttribute('data-real-stat');
        const timeValue = timeStat.querySelector('.exam-stat-value');
        const timeLabel = timeStat.querySelector('.exam-stat-label');
        if (timeValue) timeValue.textContent = '—';
        if (timeLabel) timeLabel.textContent = 'Time spent';
    }

    // Ranking 回到 "—"（data-real-stat 保留），真值由 applyRanking 交卷后填
    const rankingValue = card.querySelector('[data-ranking-value]');
    if (rankingValue) rankingValue.textContent = '—';

    // You/Global 总体对比条回到空（0% 宽、"—"），真值由 applyOverallComparison 填
    card.querySelectorAll('[data-overall-you-fill], [data-overall-global-fill]')
        .forEach(fill => { fill.style.width = '0%'; });
    card.querySelectorAll('[data-overall-you-num], [data-overall-global-num]')
        .forEach(num => { num.textContent = '—'; });

    // 全体均分那句话（在 Difficulty 卡里）回到隐藏
    const globalNote = document.querySelector('[data-global-average-note]');
    if (globalNote) { globalNote.hidden = true; globalNote.textContent = ''; }
}

// 判不出分的时候，明确说出来。
//
// ⚠️ 这个函数是补一个真实存在的洞：以前判分走不下去时就直接 return，
//    Your score 那一格保持 skeleton.html 里写死的初始值不动。
//    那个初始值曾经是 "92%"，学生交完卷看到的就是它——
//    一个凭空捏造的分数，长得跟真分数一模一样。
//    现在静态值改成了 "—"，再加上这行说明，
//    学生看到的是"这张卷子没有自动判分"而不是一个假成绩。
function setNoAutoScore(message) {
    setPerformanceCardPending(false);

    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card) return;

    let note = card.querySelector('.exam-score-note');
    if (!note) {
        note = document.createElement('p');
        note.className = 'exam-score-note';
        card.appendChild(note);
    }
    note.textContent = message;
}

// 把真实的【自动判分】总分填进 Your score 那一格。
//
// Ranking 和 You/Global 对比条现在都是真的（分别由 applyRanking /
// applyOverallComparison 从后端填）——这张卡不再有编的数字。
// 注意：这里只管 "Your score" 那一格（=自动判分分数），对比条是【总体】
// （自动+自评），归 applyOverallComparison 管，别在这里动它，否则会把
// 总体条错误地覆盖成纯自动分。
function applyRealScore(score, gradedCount) {
    setPerformanceCardPending(false);

    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card) return;

    card.classList.add('has-real-score');

    // 第一个 .exam-stat 是 Your score
    const scoreEl = card.querySelector('.exam-stat .exam-stat-value');
    if (scoreEl) {
        scoreEl.innerHTML = `${score}<span class="exam-stat-unit">%</span>`;
    }

    // 说明这个分数是怎么来的。不写的话学生不知道
    // "为什么只算了 1 道题" —— 没录测试用例的题是不参与判分的
    let note = card.querySelector('.exam-score-note');
    if (!note) {
        note = document.createElement('p');
        note.className = 'exam-score-note';
        card.appendChild(note);
    }
    note.textContent = gradedCount === 1
        ? 'Based on 1 auto-checked question.'
        : `Based on ${gradedCount} auto-checked questions.`;
}

// 把「考试用时」填进 Your performance 卡片的第三格。
//
// 那格原来是 Class average。换掉的理由不是嫌它不好看：
// 班级平均要跨用户聚合，这个网站根本算不出来，那个数字一直是编的。
// 而用时是实打实量出来的——开考时间戳到点交卷这一刻，
// 中途刷新过也不影响（endTime 存在 sessionStorage 里，恢复时沿用）。
// 拿一个真数字换掉一个假数字。
//
// ⚠️ 这里是【运行时改 DOM】，skeleton.html 里那一格的静态文案还写着
//    Class average / 78%。两边要对上，否则以后只看 HTML 的人会误会。
//    JS 万一没跑到，学生看到的就是那份写死的假数字
function applyTimeSpentStat(totalElapsedSeconds) {
    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card) return;

    // 三格依次是 Your score / Ranking / Class average，要换的是最后一格
    const stats = card.querySelectorAll('.exam-stat');
    const target = stats[stats.length - 1];
    if (!target) return;

    const valueEl = target.querySelector('.exam-stat-value');
    const labelEl = target.querySelector('.exam-stat-label');
    if (!valueEl || !labelEl) return;

    // 不到一分钟就按秒显示。四舍五入到分钟的话，
    // 交卷特别快（比如只是来试一下）会显示 "0 min"，看着像坏了
    const useSeconds = totalElapsedSeconds < 60;
    const value = useSeconds
        ? Math.max(0, totalElapsedSeconds)
        : Math.round(totalElapsedSeconds / 60);

    // 超时交卷会大于 110，不做上限截断——真花了多久就显示多久
    valueEl.innerHTML = `${value}<span class="exam-stat-unit">${useSeconds ? 'sec' : 'min'}</span>`;
    labelEl.textContent = 'Time spent';

    // 这一格原来是 Class average，值上带着 exam-stat-muted（压暗，
    // 表示"这不是你的数据"）。现在它是本人的真实用时，不该再压暗
    valueEl.classList.remove('exam-stat-muted');

    // 标记成真数据，CSS 据此跳过 " (sample)" 后缀和压暗
    //
    // ⚠️ 这里【不能】靠 removeAttribute('data-mock') 来防止 EXAM_ANALYTICS_MOCK
    //    把它藏掉——那个属性挂在外层的 <section class="exam-analytics-card"> 上，
    //    根本不在这一格上。真正的解法在 skeleton.html：
    //    把 data-mock 从整张卡挪到卡里确实是假的那几块（Ranking、班级对比条），
    //    否则关掉 mock 开关会连 Your score 和 Time spent 这两个真数字一起藏了
    target.setAttribute('data-real-stat', 'true');
}

// 把这张卷子的【真实难度】填进 Difficulty analysis 卡的星级。
//
// 数据来源：交卷后拉的 /practice/ 里每道题的 avg_rating / rating_count
// （学生平时在 Practice/Revision 给题打的星，见 buildQuestionBlock 的评分入口）。
// 按打分人数加权：被 20 人评过的题比只被 1 人评过的更有发言权——
// 等价于把所有人的原始打分汇到一起求平均，而不是先按题平均再平均。
//
// ⚠️ 只有【交卷后】能算。带评分的数据在 /practice/ 里，考试期间走的是
//    /testing/（不含答案也不含评分）；考前去拉 /practice/ 会把标准答案
//    一起泄露。所以 Difficulty 卡是 is-result-only，交卷后才出现。
//    考前也想显示难度，得后端单开一个只返聚合难度、不含答案的接口——
//    那是另一件事，见 HANDOFF 待办。
function applyRealDifficulty(paperId, questions) {
    const starsBox = document.querySelector('.exam-difficulty-stars');
    if (!starsBox) return;

    // Hard topics 用本卷各题的 topic + 单题评分算，跟星级的来源无关，先渲染
    renderHardTopics(questions);

    // 先试【整卷评分】聚合——学生在交卷后的评分步骤给的（见 showPaperRatingStep），
    // 这是难度的首选来源。接口没上线（404）/ 没人评过，就回退到【按题评分】的聚合。
    // 两个来源都是真数据，谁都不编；整卷接口一上线且有人评过，卡片自动切到它。
    // ⚠️ GET /api/progress/exams/{paperId}/rating 【还没有】——见 HANDOFF 待办。
    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/rating`)
        .then(res => res.ok ? res.json() : null)
        .then(agg => {
            const count = agg ? Number(agg.rating_count) || 0 : 0;
            if (count > 0) {
                renderDifficulty(Number(agg.avg_rating), count, 'this test');
            } else {
                applyDifficultyFromQuestions(questions);
            }
        })
        .catch(() => applyDifficultyFromQuestions(questions));
}

// 结果页 "Hard topics"：把本卷各题按【知识点】(topic) 分组，用单题难度评分给知识点
// 排序，最难的几个就是 hard topics。数据全真：topic 是 admin 录的，评分是学生在
// Practice 给单题打的星（Question_Ratings），/practice/{paperId} 一起带回来了。
//
// ⚠️ 只有【有评分】的知识点才能称为 "hard"——没有单题评分就无从判断难易，
//    那样整块（小标题 + 标签）由 JS 隐藏，绝不摆一个凭空的"难点"。
function renderHardTopics(questions) {
    const tagsBox = document.querySelector('.exam-topic-tags');
    if (!tagsBox) return;
    const card = tagsBox.closest('.exam-analytics-card');
    const subhead = card ? card.querySelector('.exam-subhead') : null;

    const hide = () => {
        tagsBox.style.display = 'none';
        if (subhead) subhead.style.display = 'none';
    };
    const show = () => {
        tagsBox.style.removeProperty('display');
        if (subhead) subhead.style.removeProperty('display');
    };

    // 按 topic 聚合评分：难度 = sum(avg×n) / sum(n)，权重是打分人数
    const byTopic = new Map();
    (questions || []).forEach(q => {
        const topic = (q.topic || '').trim();
        const n = Number(q.rating_count) || 0;
        const avg = Number(q.avg_rating);
        if (!topic || n <= 0 || !isFinite(avg)) return;
        const cur = byTopic.get(topic) || { sum: 0, count: 0 };
        cur.sum += avg * n;
        cur.count += n;
        byTopic.set(topic, cur);
    });

    // 没有一个带评分的知识点：不摆假的，整块藏掉
    if (byTopic.size === 0) { hide(); return; }

    const ranked = [...byTopic.entries()]
        .map(([topic, s]) => ({ topic, difficulty: s.sum / s.count, count: s.count }))
        .sort((a, b) => b.difficulty - a.difficulty)
        .slice(0, 4);   // 最多 4 个，避免铺满

    tagsBox.innerHTML = '';
    ranked.forEach(t => {
        const span = document.createElement('span');
        span.textContent = t.topic;
        // tooltip 是真实平均难度，不再是编的"X% 学生做错"
        span.setAttribute('data-tip',
            `Rated ${t.difficulty.toFixed(1)}/5 difficulty from ${t.count} rating${t.count > 1 ? 's' : ''}.`);
        tagsBox.appendChild(span);
    });
    show();
}

// 回退来源：把本卷各题的 avg_rating 按打分人数加权平均。
// 被 20 人评过的题比只被 1 人评过的更有发言权——等价于把所有原始打分
// 汇到一起求平均，而不是先按题平均再平均
function applyDifficultyFromQuestions(questions) {
    let ratingSum = 0;
    let ratingCount = 0;
    (questions || []).forEach(q => {
        const n = Number(q.rating_count) || 0;
        const avg = Number(q.avg_rating);
        if (n > 0 && isFinite(avg)) {
            ratingSum += avg * n;
            ratingCount += n;
        }
    });
    if (ratingCount === 0) {
        renderDifficulty(null, 0, null);   // 一条评分都没有：不摆假星
        return;
    }
    renderDifficulty(ratingSum / ratingCount, ratingCount, 'these questions');
}

// 把难度画成星级 + 一句真话注脚。mean 为 null（没有评分）时清空、只留说明。
// subject 说明"评的是谁"：整卷评分 = "this test"，按题回退 = "these questions"
function renderDifficulty(mean, ratingCount, subject) {
    const starsBox = document.querySelector('.exam-difficulty-stars');
    if (!starsBox) return;
    const card = starsBox.closest('.exam-analytics-card');
    // 每次交卷重算：先清掉上一次留下的真数据说明，避免叠加
    if (card) card.querySelectorAll('.exam-difficulty-real-note').forEach(el => el.remove());

    const addNote = text => {
        if (!card) return;
        const note = document.createElement('p');
        note.className = 'exam-analytics-note exam-difficulty-real-note';
        note.textContent = text;
        starsBox.insertAdjacentElement('afterend', note);
    };

    if (mean == null || !(ratingCount > 0)) {
        starsBox.innerHTML = '';
        starsBox.removeAttribute('title');
        addNote('No difficulty ratings yet for this paper.');
        return;
    }

    // 四舍五入到半星
    const rounded = Math.round(mean * 2) / 2;
    const full = Math.floor(rounded);
    const half = rounded - full === 0.5;
    const empty = 5 - full - (half ? 1 : 0);

    let html = '';
    for (let i = 0; i < full; i++) html += '<i class="fa-solid fa-star"></i>';
    if (half) html += '<i class="fa-solid fa-star-half-stroke"></i>';
    for (let i = 0; i < empty; i++) html += '<i class="fa-regular fa-star"></i>';
    starsBox.innerHTML = html;
    starsBox.setAttribute('title', `${mean.toFixed(1)} out of 5`);

    const who = subject ? ` for ${subject}` : '';
    addNote(`Average difficulty ${mean.toFixed(1)} from ${ratingCount === 1 ? '1 rating' : `${ratingCount} ratings`}${who}.`);
}

// 历次尝试的【真实分数】。交卷后拉，接口没上线/没登录就摆 Coming soon 占位。
//
// 接口：GET /api/progress/exams/{paperId}/attempts（带 Bearer token）→
//   [{ attempt_no, auto_points, auto_max, self_points, self_max, completed_at }, ...]
// 存绝对分值不存百分比（题目集一变旧百分比没法回溯）；前端算总分百分比。
function loadPreviousAttempts(paperId) {
    const list = document.querySelector('.exam-analytics-card .exam-attempts');
    if (!list) return;

    // 接口还没上线（或没登录 / 请求失败）：摆 Coming soon 占位，语气跟考卷
    // 说明里那条 "Your best attempt is recorded (Coming soon)" 保持一致。
    // 不再整卡隐藏——隐藏会在分析网格里留个突兀的空位
    const comingSoon = () => renderAttemptsPlaceholder(list, 'Previous attempts will show here.', 'Coming soon');
    // 接口在、但这人确实没考过：诚实空态，不是 Coming soon
    const empty = () => renderAttemptsPlaceholder(list, 'No previous attempts yet.', null);

    const token = localStorage.getItem('csci1100_auth_token');
    if (!token) { comingSoon(); return; }   // 没登录，拿不到"我的历史"

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/attempts`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => {
            if (res.status === 404) return 'no-endpoint';   // 接口还没做
            return res.ok ? res.json() : 'error';
        })
        .then(data => {
            // 404 / 其它错误：当"功能还没上线"处理，Coming soon。
            // 【不】在这里编数字——宁可占位也不假装有历史
            if (data === 'no-endpoint' || data === 'error') { comingSoon(); return; }
            if (!Array.isArray(data) || data.length === 0) { empty(); return; }
            renderPreviousAttempts(list, data);
        })
        .catch(() => comingSoon());   // 网络失败也当接口没上线
}

// 占位/空态：把时间线列表藏掉，改在下面摆一行说明。
// tag 非空时（Coming soon）追加一个跟考卷说明同款的徽标
function renderAttemptsPlaceholder(list, text, tag) {
    const card = list.closest('.exam-analytics-card');
    list.innerHTML = '';
    list.style.display = 'none';   // 空态不显示时间线的竖线和圆点
    if (!card) return;

    card.querySelectorAll('.exam-attempt-placeholder').forEach(el => el.remove());

    const p = document.createElement('p');
    p.className = 'exam-analytics-note exam-attempt-placeholder';
    p.textContent = text;
    if (tag) {
        p.appendChild(document.createTextNode(' '));
        const badge = document.createElement('span');
        badge.className = 'upcoming-tag';
        badge.textContent = tag;
        p.appendChild(badge);
    }
    list.insertAdjacentElement('afterend', p);
}

function renderPreviousAttempts(list, attempts) {
    // 从占位/空态切回真数据：清掉占位说明，恢复时间线列表
    const card = list.closest('.exam-analytics-card');
    if (card) card.querySelectorAll('.exam-attempt-placeholder').forEach(el => el.remove());
    list.style.removeProperty('display');
    list.innerHTML = '';

    // 按完成时间升序：最后一次在最下面，跟 Attempt 编号方向一致
    const rows = attempts.slice().sort((a, b) =>
        String(a.completed_at).localeCompare(String(b.completed_at)));

    let prevPct = null;
    rows.forEach((att, i) => {
        // Previous attempts 显示【总分】= 自动判分 + 自评 的绝对分之和 / 总满分。
        // 自评还没录 points 时 self_max=0，总分就只含自动分——不会因此少算
        const totalPoints = (Number(att.auto_points) || 0) + (Number(att.self_points) || 0);
        const totalMax = (Number(att.auto_max) || 0) + (Number(att.self_max) || 0);
        const pct = totalMax > 0 ? Math.round(totalPoints / totalMax * 100) : null;

        const li = document.createElement('li');

        const no = document.createElement('span');
        no.className = 'exam-attempt-no';
        no.textContent = `Attempt ${att.attempt_no != null ? att.attempt_no : i + 1}`;
        li.appendChild(no);

        const score = document.createElement('span');
        score.className = 'exam-attempt-score';
        // 分数算不出（没有任何满分）时显示 "—"，不编一个数字
        score.textContent = pct == null ? '—' : `${pct}%`;
        li.appendChild(score);

        const date = document.createElement('span');
        date.className = 'exam-attempt-date';
        date.textContent = formatLastAttempt(att.completed_at) || '';
        li.appendChild(date);

        // 跟上一次比的涨跌。两次都有百分比、且不相等才显示
        if (pct != null && prevPct != null && pct !== prevPct) {
            const up = pct > prevPct;
            const delta = document.createElement('span');
            delta.className = 'exam-attempt-delta' + (up ? '' : ' is-down');
            delta.innerHTML = `<i class="fa-solid fa-arrow-${up ? 'up' : 'down'}"></i> ${Math.abs(pct - prevPct)}%`;
            li.appendChild(delta);
        }
        if (pct != null) prevPct = pct;

        list.appendChild(li);
    });
}

// ============================================================
// 成绩落库 & Scoring Detail（你 vs 所有人）
// ============================================================

// 本场是否已存进后端（存了才谈得上后续用自评分去更新它）。存 paperId：
// 重考/换卷时用它判断"最新那次"是不是当前这场
let currentAttemptPaperId = null;
// 本场自动分 {points, max}，供 Scoring Detail 的"You"用。gradeExamAnswers 算完时填
let lastAutoScore = null;

// 从自评输入框汇总 {selfPoints, selfMax}。没录 points 的题不出输入框，
// 所以一道都没录时 selfMax = 0
function collectSelfTotal() {
    let selfPoints = 0;
    let selfMax = 0;
    document.querySelectorAll('.self-assess-input').forEach(input => {
        const max = Number(input.dataset.maxPoints);
        if (!Number.isFinite(max)) return;
        selfMax += max;
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) selfPoints += v;
    });
    return { selfPoints, selfMax };
}

// 交卷后存一次尝试。auto 是 gradeExamAnswers 的结果（可能为 null）。
// 只有【确实有东西可评分】才存（auto_max>0 或 self_max>0）——否则这张卷子
// 既没自动判分题也没录自评 points，不留 0/0 的废记录，Previous attempts 保持占位。
function saveExamAttempt(paperId, auto) {
    const token = getToken();
    if (!token) return;

    const autoPoints = auto ? auto.autoPoints : 0;
    const autoMax = auto ? auto.autoMax : 0;
    const { selfPoints, selfMax } = collectSelfTotal();

    if (autoMax <= 0 && selfMax <= 0) {
        currentAttemptPaperId = null;   // 没有可评分内容，不记这一次
        return;
    }

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/attempts`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_points: autoPoints, auto_max: autoMax, self_points: selfPoints, self_max: selfMax })
    })
        .then(res => res.ok ? res.json() : null)
        .then(saved => {
            if (!saved) return;
            currentAttemptPaperId = String(paperId);   // 之后自评改动可 PUT 更新这一次
            loadPreviousAttempts(paperId);             // 把这次纳入历次列表
            refreshScoringDetail(paperId);             // "所有人"里也把这次算进去了
        })
        .catch(err => console.error('Failed to save attempt:', err));
}

// 自评分改动后，把最新一次尝试的 self 分补上（自评是交卷后才填的，POST 时还没有）。
// 防抖 600ms：学生连续调分时不必每次打后端
let selfUpdateTimer = null;
function pushSelfScoreUpdate(paperId) {
    const token = getToken();
    if (!token || currentAttemptPaperId !== String(paperId)) return;
    const { selfPoints, selfMax } = collectSelfTotal();
    if (selfMax <= 0) return;   // 没录 points，没有自评分可存

    clearTimeout(selfUpdateTimer);
    selfUpdateTimer = setTimeout(() => {
        fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/attempts/latest/self`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ self_points: selfPoints, self_max: selfMax })
        })
            .then(() => { loadPreviousAttempts(paperId); refreshScoringDetail(paperId); })
            .catch(err => console.error('Failed to update self score:', err));
    }, 600);
}

// 拉全体平均（公开接口，不带 token），再渲染 Scoring Detail 卡
// + Your performance 的 You/Global 总体对比条 + 全体均分那句话。
// 失败就用 null 渲染——所有"全体"数字显示 "—" / 隐藏，不编数字。
function refreshScoringDetail(paperId) {
    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/score-stats`)
        .then(res => res.ok ? res.json() : null)
        .then(stats => {
            renderScoringDetail(stats);
            applyOverallComparison(stats);
            applyGlobalAverageNote(stats);
        })
        .catch(() => {
            renderScoringDetail(null);
            applyOverallComparison(null);
            applyGlobalAverageNote(null);
        });

    // Ranking 走单独的鉴权接口（要知道"你"是谁），跟 score-stats 并行拉
    applyRanking(paperId);
}

// 本场"总体"得分率 =（自动得分+自评得分）/（自动满分+自评满分）。
// 两边满分都为 0（没自动判、也没录自评分值）时返回 null——无从算起
function computeOverallYou() {
    const auto = lastAutoScore || { points: 0, max: 0 };
    const { selfPoints, selfMax } = collectSelfTotal();
    const totalMax = (auto.max || 0) + (selfMax || 0);
    if (totalMax <= 0) return null;
    return Math.round(((auto.points || 0) + (selfPoints || 0)) / totalMax * 100);
}

// Your performance 卡里的 You / Global 总体对比条。
// You 用本场现算（computeOverallYou），Global 用 score-stats 的 overall_avg_pct。
function applyOverallComparison(stats) {
    const card = document.querySelector('.exam-analytics-card.is-primary');
    if (!card) return;

    const youPct = computeOverallYou();
    const globalPct = stats && stats.overall_avg_pct != null ? Number(stats.overall_avg_pct) : null;

    const setBar = (fillSel, numSel, pct) => {
        const fill = card.querySelector(fillSel);
        const num = card.querySelector(numSel);
        if (fill) fill.style.width = `${pct == null ? 0 : pct}%`;
        if (num) num.textContent = pct == null ? '—' : `${pct}%`;
    };
    setBar('[data-overall-you-fill]', '[data-overall-you-num]', youPct);
    setBar('[data-overall-global-fill]', '[data-overall-global-num]', globalPct);
}

// Difficulty 卡里那句话：改成真实的全体平均分。没有全体数据就整句隐藏。
function applyGlobalAverageNote(stats) {
    const note = document.querySelector('[data-global-average-note]');
    if (!note) return;

    const pct = stats && stats.overall_avg_pct != null ? Number(stats.overall_avg_pct) : null;
    const count = stats ? Number(stats.overall_count) || 0 : 0;

    if (pct == null || count === 0) {
        note.hidden = true;
        note.textContent = '';
        return;
    }
    note.hidden = false;
    note.textContent = count === 1
        ? `Global average: ${pct}% (1 student so far).`
        : `Global average: ${pct}% across ${count} students.`;
}

// Ranking（真实百分位）。需要 token——是"你"在全体里的位次。
// out_of<2（只有你一个考生）或 top_percent 为 null（这次没有可计分内容）→ 显示 "—"，不编排名。
function applyRanking(paperId) {
    const el = document.querySelector('[data-ranking-value]');
    if (!el) return;

    const token = getToken();
    if (!token) { el.textContent = '—'; return; }

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/my-ranking`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : null)
        .then(r => {
            if (!r || r.top_percent == null || Number(r.out_of) < 2) {
                el.textContent = '—';
                el.title = (r && Number(r.out_of) < 2)
                    ? 'Not enough students have taken this paper yet' : '';
                return;
            }
            el.innerHTML = `Top ${Number(r.top_percent)}<span class="exam-stat-unit">%</span>`;
            el.title = `Rank ${r.rank} of ${r.out_of}`;
        })
        .catch(() => { el.textContent = '—'; });
}

// Scoring Detail 卡：两层，各是"你 vs 所有人"。
//   上层 = 自动判分，下层 = 自评。
// "你"用本场分数（lastAutoScore / 自评输入框现值），"所有人"用 score-stats。
function renderScoringDetail(stats) {
    const container = document.querySelector('[data-scoring-detail]');
    if (!container) return;
    container.innerHTML = '';

    const autoYou = lastAutoScore && lastAutoScore.max > 0
        ? Math.round(lastAutoScore.points / lastAutoScore.max * 100) : null;
    const { selfPoints, selfMax } = collectSelfTotal();
    const selfYou = selfMax > 0 ? Math.round(selfPoints / selfMax * 100) : null;

    const autoEveryone = stats && stats.auto_avg_pct != null ? Number(stats.auto_avg_pct) : null;
    const selfEveryone = stats && stats.self_avg_pct != null ? Number(stats.self_avg_pct) : null;
    const autoCount = stats ? Number(stats.auto_count) || 0 : 0;
    const selfCount = stats ? Number(stats.self_count) || 0 : 0;

    container.appendChild(buildScoringLayer(
        'Auto-checked', autoYou, autoEveryone, autoCount,
        'No auto-checked questions on this paper yet.'));
    container.appendChild(buildScoringLayer(
        'Self-marked', selfYou, selfEveryone, selfCount,
        'Self-marking opens once a mark value (points) is set on these questions.'));
}

// 一层：标题 + You / Everyone 两条对比条（复用 Your performance 卡的 .exam-compare 样式）。
// 你和所有人都没有数据时，整层只显示一句说明，不摆空条。
function buildScoringLayer(title, youPct, everyonePct, everyoneCount, emptyMsg) {
    const layer = document.createElement('div');
    layer.className = 'scoring-layer';

    const head = document.createElement('div');
    head.className = 'scoring-layer-head';
    head.textContent = title;
    layer.appendChild(head);

    // 这一层完全没数据（本场没这类题、别人也没有）：一句诚实说明代替空条
    if (youPct == null && everyonePct == null) {
        const note = document.createElement('p');
        note.className = 'exam-analytics-note';
        note.textContent = emptyMsg;
        layer.appendChild(note);
        return layer;
    }

    layer.appendChild(buildCompareRow('You', youPct, true));

    // "Global"（全体平均）：按要求恒显示 "Global"，不再加 "(only you so far)" 提示。
    // ⚠️ 副作用：只有你一人考过时，Global 那条其实就是你自己的分——数字不假
    //    （确实是现有全体的平均），但会让人以为背后有一群人。everyoneCount 仍可用于
    //    以后需要小样本判断时（比如少于 N 人干脆不显示 Global 条）
    layer.appendChild(buildCompareRow('Global', everyonePct, false));

    return layer;
}

function buildCompareRow(label, pct, isYou) {
    const row = document.createElement('div');
    row.className = 'exam-compare-row';

    const l = document.createElement('span');
    l.className = 'exam-compare-label';
    l.textContent = label;
    row.appendChild(l);

    const track = document.createElement('div');
    track.className = 'exam-compare-track';
    const fill = document.createElement('div');
    fill.className = 'exam-compare-fill' + (isYou ? ' is-you' : '');
    fill.style.width = `${pct == null ? 0 : pct}%`;
    track.appendChild(fill);
    row.appendChild(track);

    const num = document.createElement('span');
    num.className = 'exam-compare-num';
    num.textContent = pct == null ? '—' : `${pct}%`;
    row.appendChild(num);

    return row;
}

// 把判分结果画出来
function renderGradeResult(panel, result) {
    if (result.skipped) {
        panel.remove();   // 没作答或没用例，不显示任何东西
        return;
    }

    const passed = result.results.filter(r => r.passed).length;
    const total = result.results.length;

    panel.className = `grade-panel ${result.score === 100 ? 'is-full' : (result.score === 0 ? 'is-zero' : 'is-partial')}`;
    panel.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'grade-head';
    head.innerHTML = `
        <span class="grade-score">${result.score}<span>%</span></span>
        <span class="grade-count">${passed} of ${total} checks passed</span>
    `;
    panel.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'grade-case-list';

    result.results.forEach(r => {
        const li = document.createElement('li');
        li.className = r.passed ? 'is-pass' : 'is-fail';

        const icon = r.passed ? 'fa-circle-check' : 'fa-circle-xmark';
        let html = `<i class="fa-solid ${icon}"></i><span>${escapeHtml(r.label || 'Check')}</span>`;

        // 只有可见用例才展示输入和期望输出。
        // 隐藏用例只说过没过——否则针对它们硬编码答案就行了
        if (!r.passed && r.visible && r.expected) {
            html += `<code class="grade-detail">expected ${escapeHtml(r.expected)}</code>`;
        }
        // 代码本身报错的话，错误信息对学生最有用，一定要显示
        if (r.error) {
            html += `<code class="grade-error">${escapeHtml(r.error)}</code>`;
        }

        li.innerHTML = html;
        list.appendChild(li);
    });

    panel.appendChild(list);
}

// ---------- 答题 ----------
// 每道题一个输入框。分开存是因为判分是按题算的，
// 整张卷子一个大框的话没法对应到具体某道题。

// 作答的本地缓存：paperId -> { questionId: text }
// 后端存一份、本地也存一份。断网或者接口挂了的时候，
// 本地这份至少能保住学生已经写的东西
const EXAM_ANSWER_KEY_PREFIX = 'code100_exam_answers_';

function examAnswerStorageKey(paperId) {
    return `${EXAM_ANSWER_KEY_PREFIX}${paperId}`;
}

function readLocalAnswers(paperId) {
    try {
        return JSON.parse(localStorage.getItem(examAnswerStorageKey(paperId))) || {};
    } catch (e) {
        return {};
    }
}

function writeLocalAnswer(paperId, questionId, text) {
    const all = readLocalAnswers(paperId);
    all[questionId] = text;
    try {
        localStorage.setItem(examAnswerStorageKey(paperId), JSON.stringify(all));
    } catch (e) {
        // 存储满了之类的，静默失败——后端那份才是主的
        console.warn('Failed to cache answer locally:', e);
    }
}

// 把答题框的高度调整到刚好装下内容，但不超过上限。
//
// ⚠️ 上限是后加的。原来是【无上限】自动增高，当时的理由是
//    "代码被塞在小框里滚动很难通读"。但交卷后是左右并排对照的布局，
//    一份长答案会把左栏拉得很长，而右边标准答案本来就有 max-height，
//    两栏高度差一大截，逐行对照的意义就没了。
//    现在两边共用 CSS 里的 --answer-box-max-h，谁超了谁自己内部滚动。
//
// 上下限都从 CSS 读回来，不在这里写死数字：写死的话就有两个真相来源，
// 而且窄屏的媒体查询要是改了这两个值，JS 这边完全不知道。
// 每次都重新读而不是缓存，也是为了这个——布局会随窗口宽度变
function autoGrowAnswerInput(textarea) {
    if (!textarea) return;

    // 先归零再量。不归零的话 scrollHeight 会被上一次设的高度顶住，
    // 结果是内容删掉了框子也不会收回去，只增不减
    textarea.style.height = 'auto';

    const styles = getComputedStyle(textarea);
    const maxHeight = parseFloat(styles.maxHeight);       // max-height: none 时是 NaN
    const minHeight = parseFloat(styles.minHeight) || 0;

    // scrollHeight 含 padding 但【不含 border】，而这个框是 border-box。
    // 直接拿 scrollHeight 当 height 会少掉上下两条边框的高度，
    // 表现是最后一行被切掉一点点，或者刚打完字就莫名闪出一条滚动条
    const border = textarea.offsetHeight - textarea.clientHeight;

    const wanted = Math.max(textarea.scrollHeight + border, minHeight);
    const capped = Number.isFinite(maxHeight) && wanted > maxHeight;

    textarea.style.height = `${capped ? maxHeight : wanted}px`;

    // 顶到上限了就标记上。真正让它能滚的是 CSS 里的 .is-capped:focus——
    // 【没点进来之前不给滚】，滚轮事件落到页面上，
    // 不会出现鼠标划过答题框时整页突然不动了的情况。
    //
    // ⚠️ 这里不能写 style.overflowY：inline 样式盖过 CSS，
    //    focus 那条规则就永远不生效了
    textarea.classList.toggle('is-capped', capped);
    textarea.style.overflowY = '';
}

function buildAnswerEditor(questionId) {
    const box = document.createElement('div');
    box.className = 'answer-editor';

    const label = document.createElement('label');
    label.className = 'answer-editor-label';
    label.textContent = 'Your answer';
    label.setAttribute('for', `answer-${questionId}`);

    const textarea = document.createElement('textarea');
    textarea.className = 'answer-editor-input';
    textarea.id = `answer-${questionId}`;
    textarea.dataset.questionId = questionId;
    textarea.spellcheck = false;
    textarea.placeholder = 'Write your code here...';
    // 关掉浏览器的自动纠正——写代码时它会把引号换成弯引号、首字母大写
    textarea.autocapitalize = 'off';
    textarea.autocomplete = 'off';
    textarea.setAttribute('autocorrect', 'off');

    // Tab 键插入缩进而不是跳到下一个控件。
    // 写 Python 不能缩进的话这个框根本没法用
    textarea.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        e.preventDefault();

        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const INDENT = '    ';   // Python 惯例是 4 个空格

        textarea.value = textarea.value.slice(0, start) + INDENT + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + INDENT.length;

        textarea.dispatchEvent(new Event('input'));
    });

    // 随内容自动增高，到 --answer-box-max-h 为止，再长就内部滚动。
    // 具体的取舍见 autoGrowAnswerInput 上面的注释
    textarea.addEventListener('input', () => {
        autoGrowAnswerInput(textarea);
        // 导航条上这道题的"已作答"标记跟着变
        refreshQuestionNavAnswered();
    });

    // 自动保存。防抖 800ms——每敲一个字就发一次请求会打爆后端，
    // 而且没有意义：中途的半截代码存下来也没用
    let saveTimer = null;
    textarea.addEventListener('input', () => {
        const paperId = document.getElementById('testing-header')?.dataset.currentPaperId;
        if (!paperId) return;

        // 本地那份【立刻】写，不等防抖。
        // 学生手一抖关了标签页，最后 800ms 内敲的东西也不该丢
        writeLocalAnswer(paperId, questionId, textarea.value);

        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveAnswerToServer(paperId, questionId, textarea.value);
        }, 800);
    });

    // 失焦时立刻存一次，不等防抖。
    // 学生切走去看别的题时，这一题的内容应该已经落库了
    textarea.addEventListener('blur', () => {
        const paperId = document.getElementById('testing-header')?.dataset.currentPaperId;
        if (!paperId) return;

        clearTimeout(saveTimer);
        saveAnswerToServer(paperId, questionId, textarea.value);
    });

    box.appendChild(label);
    box.appendChild(textarea);
    return box;
}

// 清掉一张卷子的全部作答：输入框、本地缓存、后端那份，三处都要清。
//
// 只清其中一处会留下不一致：
//   - 只清输入框 → 刷新之后 restoreSavedAnswers 又把旧内容填回来了
//   - 只清本地 → 换个设备打开还是能看到上次的
//   - 只清后端 → 本地缓存还在，同一个浏览器里照样看得到
function clearAllAnswers(paperId) {
    if (!paperId) return;

    // 1. 输入框
    document.querySelectorAll('#testing-questions .answer-editor-input').forEach(el => {
        el.value = '';
        el.readOnly = false;   // 上一场交卷时设成了只读，重考要能写
        el.style.height = '';  // 高度是随内容撑起来的，清空后要收回去

        // 上一场如果写满过、顶到了上限，autoGrowAnswerInput 会在元素上
        // 留一条 inline 的 overflow-y: auto。不清掉的话重考时空框子
        // 也挂着滚动条的样式
        el.style.overflowY = '';
    });

    // 2. 本地缓存
    try {
        localStorage.removeItem(examAnswerStorageKey(paperId));
    } catch (e) { /* 清不掉就算了，下面后端那份是主的 */ }

    // 3. 后端。逐题发空字符串——后端接口是「按题保存」，
    //    没有批量删除的接口，为这一处专门加一个不划算
    const token = getToken();
    if (!token) return;

    document.querySelectorAll('#testing-questions .answer-editor-input').forEach(el => {
        saveAnswerToServer(paperId, el.dataset.questionId, '');
    });
}

// 交卷时把所有作答再提交一遍。
// 逐条发而不是打包成一个请求：后端已经有单题接口了，
// 再加一个批量接口只为这一处调用不划算
function flushAllAnswers(paperId) {
    if (!paperId) return;

    document.querySelectorAll('#testing-questions .answer-editor-input').forEach(el => {
        saveAnswerToServer(paperId, el.dataset.questionId, el.value);
    });
}

// 把一道题的作答发给后端。
// 失败不打断考试——本地缓存那份还在，交卷时会再整体提交一次
function saveAnswerToServer(paperId, questionId, text) {
    const token = getToken();
    if (!token) return;

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/answers/${questionId}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: text })
    }).catch(error => console.error('Failed to save answer:', error));
}

// 把已保存的作答填回输入框。
// 先用本地缓存立刻填上（不用等网络），再拉后端那份覆盖——
// 换了设备或者清过缓存的时候，后端那份才是唯一的来源
function restoreSavedAnswers(paperId) {
    const fill = (map) => {
        document.querySelectorAll('#testing-questions .answer-editor-input').forEach(el => {
            const saved = map[el.dataset.questionId];
            if (saved === undefined || saved === null || saved === '') return;

            el.value = saved;

            // ⚠️ 这里原来自己抄了一份撑高的算法。现在统一走
            // autoGrowAnswerInput——刷新恢复出来的长答案也要受同一个上限管，
            // 两份实现迟早会改歪一边
            autoGrowAnswerInput(el);
            // 恢复出来的作答也要在导航条上标成已答
            refreshQuestionNavAnswered();
        });
    };

    fill(readLocalAnswers(paperId));

    const token = getToken();
    if (!token) return;

    fetch(`${APP_API_BASE}/api/progress/exams/${paperId}/answers`, {
        headers: { 'Authorization': `Bearer ${token}` }
    })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
            if (!data) return;
            fill(data);

            // 顺手把后端那份同步到本地，下次刷新不用等网络
            try {
                localStorage.setItem(examAnswerStorageKey(paperId), JSON.stringify(data));
            } catch (e) { /* 存储满了就算了，后端那份是主的 */ }
        })
        .catch(error => console.error('Failed to load saved answers:', error));
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
// resumeEndTime 有值时表示「从刷新中恢复」，直接沿用原来的结束时间；
// 不传就是一场新考试，从现在起算满 110 分钟
function startTestingTimer(resumeEndTime = null) {
    stopTestingTimer();

    // 恢复时不重置这些提醒标记会有个问题：如果刷新前已经提醒过「还剩 10 分钟」，
    // 重置之后会再提醒一次。但反过来，不重置的话新开一场考试又不会提醒。
    // 这里按「恢复时保留、新考试时重置」处理
    if (!resumeEndTime) {
        warned10 = false;
        warned5 = false;
        warned1 = false;
        warnedTimesUp = false;
    }

    countdownEndTime = resumeEndTime || (Date.now() + COUNTDOWN_TOTAL_SECONDS * 1000);
    renderTimerDisplay(Math.round((countdownEndTime - Date.now()) / 1000));

    // 存下来，刷新页面之后能接着考。
    // 恢复的场次也要重存一次——不然 sessionStorage 里那条不会被刷新，
    // 虽然值一样，但逻辑上「当前正在考的是哪一场」应该始终由这里维护
    const headerEl = document.getElementById('testing-header');
    if (headerEl && headerEl.dataset.currentPaperId) {
        saveExamSession(headerEl.dataset.currentPaperId, countdownEndTime);
    }

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