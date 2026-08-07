# Code 100 — 交接

> 更新于 2026-08-06。上一版把判分范围收窄 / Web Worker / 考试期间不下发答案写进来了。
> 这一版：成绩落库 + Previous attempts + Scoring Detail + 整卷难度评分**后端都已部署跑通**
> （不再是"差跑 SQL"）；新增了**改卷阶段**（自评期间不亮分）、admin 的**课程切换 /
> 年份分组 / points·rubric 录入**，以及 Cribsheet 笔记库的处置决定。
> **新增了本地 AI 引擎（Ollama/qwen3）+ 第一个 AI 功能：cribsheet 生成**——见下面「本地 AI 引擎」节。

## 项目

RPI CS1（CSCI-1100）刷题网站，学生用来练历年真题。

- **前端** 原生 HTML/CSS/JS，Netlify。目录 `2. Computer Science/CSC1-1100/index/`
- **后端** Java Spring Boot + MyBatis-Plus，Render。仓库 `~/Code100_Database_Connection`
- **数据库** Aiven MySQL（库名 `Code100`，线上是 `defaultdb`）
- **Admin** 独立页面 `1. Admin/`（密钥门禁 `X-Admin-Key`），录题/建卷/管理

三个板块：**Practice**（按题型刷题）、**Examination**（限时模拟考）、**Revision**（标记的题 + Cribsheet 小抄生成器）。

---

## 本地 AI 引擎（Ollama / qwen3）

**目标**：一个可被 Code100 所有 AI 功能复用的底座，以后换 OpenAI/Claude/Gemini 只加实现类、不改业务。

**链路**：`Controller → AIService(接口) → OllamaAIService → RestClient → Ollama(http://localhost:11434) → qwen3:8b`

**依赖 Ollama 在跑**（Mac 上菜单栏 app，开机自起；`curl localhost:11434/api/tags` 验活）。地址/模型**不写死**，在 `application.properties` 的 `ai.ollama.*`（可用 `OLLAMA_URL`/`OLLAMA_MODEL` 环境变量覆盖）。

**后端文件**（都在 `~/Code100_Database_Connection/.../ai/`，全构造器注入，无字段注入）：

| 位置 | 作用 |
|---|---|
| `ai/service/AIService.java` | 通用接口 `chat(String)→String`。**业务只依赖它** |
| `ai/service/impl/OllamaAIService.java` | 唯一懂 Ollama 协议的地方。设 `stream:false`+`think:false`，兜底正则剥 `<think>` |
| `ai/config/AIProperties.java` / `AIConfig.java` | 绑 `ai.ollama.*`；造带超时的 `RestClient` Bean |
| `ai/dto/AIRequest.java` / `AIResponse.java` | 对前端契约 `{message}`→`{answer}`，换 provider 不变 |
| `ai/exception/AIServiceException.java` | provider 层统一异常，Controller 转 503 |
| `ai/controller/AIController.java` | `POST /api/ai/chat`（通用聊天，**当前公开无鉴权**） |

**接口**：
- `POST /api/ai/chat` body `{message}` → `{answer}`。通用。
- `POST /api/ai/cribsheet` → 见下。

### 第一个 AI 功能：cribsheet 生成

`ai/cribsheet/`：`CribsheetAIController` + `CribsheetGenerationService` + 3 DTO。
`POST /api/ai/cribsheet` body `{scope, paperId?, topic?, count?}` → `{notes:[{title,content}]}`。

- **scope**：`custom`（自定主题）/ `marked`（本人标记题，**需 JWT**）/ `paper`（某张卷）。鉴权**可选**：只有 `marked` 必须带 token。
- 服务层按 scope 捞素材（marked=starred 题、paper=该卷题、custom=主题文本）→ 拼 prompt → `aiService.chat()` → **解析 LLM 返回的 JSON 数组**（截 `[`…`]`、解析失败兜底成一张整块笔记）。
- 素材上限：`MAX_QUESTIONS=12`、答案截 800 字，防 prompt 撑爆 8B。

**前端**（`cribsheet-builder.js` / `skeleton.html` / `testing-engine.css`）：
Revision → Cribsheet Builder 左侧「✨ Generate with AI」按钮 + 弹窗（选 scope/主题/卷/数量）。生成的卡片走**现有** `addNoteToGrid` **追加**到画布，不覆盖。`ObjectMapper` 在服务里**自建静态实例**——Boot 4 默认没暴露 `ObjectMapper` bean，注入会启动失败。

### ⚠️ AI 相关的坑 / 待办

- **`/api/ai/*` 现在公开无鉴权、无限流**。`/api/ai/chat` 完全公开；`/api/ai/cribsheet` 仅 `marked` 需登录。上线前在两个 Controller 预留的钩子处加 JWT + 限流——否则本地/GPU 模型会被白嫖刷爆。
- **改后端 Java 必须重启**（无热重载）。AI 代码改完不重启 = 旧接口。
- qwen3 默认带 `<think>`，靠 `think:false`+正则双保险剥掉；换非思考模型时 `think:false` 可能报 400，注意。
- Ollama 没开时 `/api/ai/*` 返回 **503**；前端 cribsheet 弹窗会显示红字提示。

---

## 判分与结算现在是什么设计

**只有四类题自动判分**，其余交给学生自评。

| 题型 | 怎么判 |
|---|---|
| `one-liners` | 自动（用例还没实现，见待办） |
| `debugging` | 自动（函数式用例可用） |
| `get-output` | 自动（纯文本比对，不跑代码） |
| `mcq` | 自动（同上，选项写在题干里） |
| `half-program` / `full-program` | **学生自评** |

分流依据是**题型**，见 `testing-engine.js` 的 `AUTO_GRADED_CATEGORIES` / `isAutoGradedCategory()`。

**交卷后的流程（`revealExamResults`）：**

1. 揭晓标准答案（拉 `/practice/`），给自评题装打分界面。
2. **难度评分**一屏（可跳过，`showPaperRatingStep`）。
3. **改卷阶段**（`enterMarkingHold`）——只在有【能打分】的自评题（录了 `points`）时进入：
   学生对着标准答案自己打分，**这期间自动分、班级平均、Scoring Detail、历次全部藏着**，
   顶部一条说明 +「Reveal my results」按钮。**没有可打分自评题就跳过这步，直接亮。**
4. 点按钮 → `finalizeExamResults`：判分 + 存这次尝试 + 全部分数**一起**揭示（挂 `exam-result-mode`）。

**结算卡片：**
- **Your performance**：Your score（自动分，真）/ Ranking（假，跨用户，mock）/ Time spent（真）。
- **Previous attempts**：历次真实分数（总分 = 自动 + 自评），后端 `Exam_Attempts` 存。没登录/没记录时显示占位。
- **Scoring Detail**（**替代了原 Exam readiness**）：上层自动判分、下层自评，各「你 vs 所有人」。
  "所有人"来自公开的 `score-stats` 聚合；只有本人考过时标 "(only you so far)"。
- **Difficulty analysis**：星级 = 本卷各题 `avg_rating` 聚合（真）。优先读整卷评分 `GET .../rating`，
  没有则回退按题聚合。下面的「70–80%」「Hard topics」仍是 mock。

**两条铁律：自评分和自动分分开算（只有 Previous attempts 的"总分"才相加）；不编造跨用户数据。**

---

## 这一轮做完的事

**学生端**
- **改卷阶段**：自评期间不亮分，改完点按钮统一揭示（`enterMarkingHold` / `finalizeExamResults`）。
- **修复：右侧题号导航条切板块回来就消失**——切回 Examination（板块 id 是 `testing`）时，
  若 header 有 `exam-in-progress` 或 `exam-finished` 且题目还在，`buildQuestionNav()` 重建。
- **修复：交卷后分析卡整块不出现**——`gradeExamAnswers` 漏了 `return`，返回 `undefined`，
  `undefined.then()` 抛错把 `revealExamResults` 拦在挂 `exam-result-mode` 之前。已补 `return`，
  且判分链用 `Promise.resolve().then()` 隔在异步边界外，异常再也冲不垮结果页。

**后端（已部署跑通，不再是待办）**
- **`Exam_Attempts`**（每交一次一行，留历史）：`ExamAttempt`/`ExamAttemptDao` +
  `POST .../attempts`、`PUT .../attempts/latest/self`、`GET .../attempts`、`GET .../score-stats`（公开）。
- **`Paper_Ratings`**（整卷难度评分）：`PaperRating`/`PaperRatingDao` +
  `POST .../rate`、`GET .../rating`（公开）。
- 建表 SQL 都已在 Aiven 跑过（`score-stats` 返 200、难度评分能回数，验证过）。

**Admin（`1. Admin/`）**
- **课程切换器**（侧边栏）：课程是 `course` 字符串列（`TestPaper`/`TestQuestion` 都有），
  下拉列出已有课程 + 内联新建。切换后题库/试卷/年份按课程重载。`getAdminCourse()` 存 localStorage。
  （**没建 Courses 表**——只有一门课时属过度设计，以后要给课程挂全名/描述再升级。）
- **题库列表两级文件夹**：外层每个 Test、内层年份（`Test 1 → 2026 / 2020 / …`），默认全收起。
- **`points` / `rubric` 录入框** + 编辑回填（`AdminQuestionDto` 加了这两字段；POST/PUT 绑定整实体，本就入库）。
- **Cribsheet Library**：后端 `/api/admin/cribsheet-notes` 增删改**从没实现过**（学生端只读的
  `GET /api/cribsheet/notes` 是好的）。**决定不补**——以后打算用 AI 生成 cribsheet，手工管理会被取代。
  `loadNotes()` 拉不到就安静显示占位，不再报错。

---

## 现在的文件

**前端**（`index/`）

| 文件 | 说明 |
|---|---|
| `cs1_index.html` | 主页面。脚本顺序：`grading-engine.js` 必须在 `testing-engine.js` 之前。题号导航 `<nav>` 在这里（body 直属层，原因见坑） |
| `cs1_index.js` | 板块切换器、专注模式。切板块 `destroyQuestionNav()`；**切回 Examination 重建导航** |
| `skeleton.html` | 三板块内容骨架，注入到 `#content-container` |
| `testing-engine.js` | 最大的一个。考试/答题/判分调度/自评/改卷阶段/结算/导航/标记 |
| `testing-engine.css` / `cs1_index_style.css` | 样式 |
| `grading-engine.js` | 判分调度（只调度，不碰 Python） |
| `grading-worker.js` | Pyodide 独立线程，真正跑学生代码；超时靠 `terminate()` |
| `cribsheet-builder.js` | Cribsheet 生成器（GridStack） |

**Admin**（`1. Admin/`）：`admin.html` / `admin.js` / `admin.css`

**后端**（`~/Code100_Database_Connection`，`.../tests/` 和 `.../progress/` 下）
- `TestQuestionsController` / `TestPapersController`（`tests/controllers/`）
- `ProgressController` / `CribsheetController`（`progress/controllers/`）
- 实体：`TestQuestion`（含 `course`/`topic`/`points`/`rubric`）、`TestPaper`（含 `course`/`paper_year`）、
  `ExamAttempt`、`PaperRating`、`QuestionRating`、`ExamAnswer` 等
- DTO：`PracticeQuestionsDto` / `TestingDto`（**不含 rubric**）/ `AdminQuestionDto`（含 points/rubric）

**数据库迁移**（都已执行）：`migration_test_cases`、`migration_exam_answers`、`testcases_q6`、
`migration_grading_scope`、`migration_exam_attempts`、`migration_paper_ratings`

---

## 必须知道的坑

### 数据
- **⚠️ `points` / `rubric` / `Test_Case.setup_code` / `check_target` 现在全是 NULL。** 列在了、没录数据。
  没 `points` 的自评题不出打分框、不进"改卷阶段"，也不计入总分。**要看到自评/改卷流程，先在 admin 录 `points`。**
  `points` 故意允许 NULL——NULL 是"还没录"，跟"0 分"不是一回事，默认 0 会静默算错。
- **⚠️ `question_category` 取值不统一**：库里 `get_output`（下划线），前端筛选发 `get-output`（连字符），
  后端 `eq()` 精确匹配 → Practice 的 Get-Output 筛选**可能是坏的**。前端判分那边 `formatQuestionType()` 归一化过，服务端筛选没有。
- **⚠️ `Test_Questions` 列名是 `paperId` 不是 `paper_id`。**
- **⚠️ `EXAM_ANALYTICS_MOCK`（`testing-engine.js` 顶部）仍是 `true`。** 还在编的：Ranking、班级对比条、
  Difficulty 的「70–80%」和 Hard topics。Scoring Detail / Your score / Time spent / Difficulty 星级 / Previous attempts 都是真的了。上线前改 `false` 前先决定那几块 mock 怎么办（改 false 是让它们消失，不是变真）。

### CSS
- **⚠️ 零位移 `transform` 破坏 `position: fixed`。** `#testing-content`/`#content-container` 过渡里写过 transform，
  停下后 `matrix(1,0,0,1,0,0)` 照样建立包含块 → 题号导航**必须挂 body 直属层**。
- **⚠️ 同选择器写两遍，后者【整个】覆盖前者，不合并。** 加规则前先 grep 同名的。
- **⚠️ `hidden` 会被作者样式的 `display` 盖掉** → `.exam-question-nav[hidden]{display:none}` 那条必须写。
- **⚠️ 跨结构状态挂 body 上**（`#testing-header` 在 `.exam-layout` 里、`#testing-questions` 在外面，`~` 匹配不上）。

### 判分 / 安全
- **⚠️ 隐藏用例防不住有心人**：`is_visible=0` 的输入仍发到前端，Network 看得见。get-output/mcq 是纯文本比对，**可挪后端**（答案就不必下发）。
- **⚠️ `/papers/{paperId}/test-cases`、`/practice/{paperId}`、`GET .../rating`、`GET .../score-stats` 无鉴权**，curl 直接拿（前两个会泄露答案）。
- **Cribsheet 打印坏的**：试了五次没修好。用 DevTools Rendering 的 `Emulate CSS media type: print` 边改边看。

---

## 待办

### 紧急
- **git 历史里有明文密钥**（commit `9d1ccdd`：JWT 签名密钥、Aiven 密码、Resend key、Gmail 密码）。
  JWT 最要紧（能伪造登录态）。**先轮换、再清历史**（`git filter-repo`）——只清历史不轮换等于没做。
- 前后端两个仓库的改动记得各自提交/推送。

### 判分 / 数据
- **录 `points`（+ `rubric`）**——不录的话自评、改卷阶段、总分、Scoring Detail 下层全是空的。admin 已有录入口。
- **admin 测试用例编辑器（D，说好这轮之后做）**：后端加 `Test_Case` 增删改接口 + 前端每题一个用例面板。
  没有它，除 `question_id=6`（8 条）外的题都没法配自动判分用例（现在只能手写 SQL）。
- **one-liner 判分没实现**：接口位置在 `grading-worker.js` 的 `case_type` 分支，注释写了三形态（`expr`/`stdout`/`var:名字`）。
- **脚本式用例（`input()`/`print()`）没实现。**
- get-output / mcq 判分挪后端（纯文本比对，不需沙箱，挪过去答案不必下发）。
- 考前难度：Difficulty 只在交卷后算得出（评分在 `/practice/`，考前拉会泄露答案）。想考前也显示得后端单开只返聚合难度的接口。

### 其他
- **AI 生成 Cribsheet**（方向）：取代手工录笔记卡片。做的时候回头处理 admin 的 Cribsheet Library（接上或删掉）。
- Cribsheet 打印。
- CDN 依赖：GridStack、admin 的 `tesseract.js`（OCR）还从 CDN 加载（Font Awesome 已本地化，同一类风险）。
- 死代码清理：`EXAM_ANALYTICS_MOCK` 分支、`exam-readiness-*` 的旧 CSS（卡片已换成 Scoring Detail）、grep 不到引用的类。改到哪个文件顺手清，别专门开一轮批量删。

---

## 工作方式

改之前先查现状（别叠加重复规则）、改完自检、坑写进代码注释而不是只在对话里说。

**不编造假数据**：没有来源的数字（排名、班级平均…）要么接真数据要么明确标 sample。
自评分和自动分不合并成一个总分（Previous attempts 的总分是唯一例外，且口径写清）。

改 CSS：同选择器后写的整个覆盖前面的，加规则前先 grep；改完用 `getComputedStyle()` 在控制台验证，别靠肉眼。
