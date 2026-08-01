// ============================================================
// 判分引擎：在浏览器里跑学生的 Python 代码，拿结果跟测试用例比对
// ============================================================
//
// 为什么在浏览器跑而不是后端：
//   - 零成本。后端跑要么自己做沙箱（防死循环、防 import os 读文件），
//     要么租机器，Render 免费层扛不住几十个人同时跑
//   - 天然隔离。学生的死循环只影响他自己那一页
//   - 快。没有网络往返
//
// 用的是 Pyodide（CPython 编译成 WebAssembly）。
//
// ⚠️ 这个文件【只做调度】，不碰 Python。真正执行学生代码的是
//    grading-worker.js，跑在一个独立线程里。
//
//    以前是在主线程里直接跑的，那样有个致命问题：Pyodide 执行 Python
//    是同步阻塞的，学生写 `while True: pass` 会把整个页面卡死，
//    await 拦不住、setTimeout 排不上队。老版本里那个
//    "用例之间检查一下 Date.now()" 的兜底完全不起作用——
//    代码卡住的时候，那段检查本身也永远轮不到执行。
//
//    现在的做法是：超时了就 terminate 掉整个 Worker 线程。
//    这是唯一能真正打断同步死循环的手段。
//
// 对外只暴露 gradeQuestion(studentCode, testCases)，
// 签名和返回结构跟以前完全一致，testing-engine.js 那边不用改。

// Worker 脚本的路径，相对于页面（cs1_index.html）。
// ⚠️ 挪动 grading-worker.js 的位置时要同步改这里，
//    而且它必须跟页面【同源】——Worker 不能直接从 CDN 加载
const WORKER_URL = 'grading-worker.js';

// 单条用例的执行时限。
//
// 正常的 CS1 代码都在几十毫秒内跑完，1 秒是 20 倍的余量。
// 不敢设得更低是因为一次会话里【第一条】用例还包含 Python 的
// 编译预热，比后面的慢一截；为了少判几百毫秒而误杀正确答案不划算。
// 死循环反正是无限长，1 秒和 300 毫秒一样拦得住。
const PY_CASE_TIMEOUT_MS = 1000;

// Pyodide 装载的时限。3~4MB 的 wasm，网络差的时候会久一点，
// 但超过一分钟基本就是拉不到了（CDN 挂了 / 被墙 / 断网）
const PY_INIT_TIMEOUT_MS = 60000;

const TIMEOUT_MESSAGE = 'Timed out — your code may contain an infinite loop.';
const ABORTED_MESSAGE = 'Skipped — an earlier check on this question timed out.';

let worker = null;
let workerReady = null;
let messageSeq = 0;

// ---------- Worker 的生命周期 ----------

// 起一个新 Worker，并返回"它已经装好 Pyodide"的 Promise。
//
// 每次 terminate 之后都要重来一遍。好消息是那 3~4MB 还在 HTTP 缓存里，
// 重建只是 wasm 重新初始化，大概 1~3 秒，不是重新下载
function spawnWorker() {
    worker = new Worker(WORKER_URL);

    workerReady = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timed out loading the Python runtime.'));
        }, PY_INIT_TIMEOUT_MS);

        const onReady = (event) => {
            const msg = event.data;
            if (!msg) return;

            if (msg.type === 'ready') {
                clearTimeout(timer);
                worker.removeEventListener('message', onReady);
                resolve();
            } else if (msg.type === 'init-failed') {
                clearTimeout(timer);
                worker.removeEventListener('message', onReady);
                reject(new Error(msg.error || 'Failed to load Pyodide.'));
            }
        };

        worker.addEventListener('message', onReady);

        // Worker 脚本本身加载失败（路径写错、文件没部署上去）走这里。
        // 这个错误一定要冒出来，不能悄悄退回主线程执行——
        // 退回去就等于把刚删掉的"死循环卡死页面"又装了回来
        worker.addEventListener('error', () => {
            clearTimeout(timer);
            reject(new Error('Failed to start the grading worker.'));
        }, { once: true });
    });

    return workerReady;
}

function ensureWorker() {
    if (worker && workerReady) return workerReady;
    return spawnWorker();
}

function killWorker() {
    if (!worker) return;
    worker.terminate();
    worker = null;
    workerReady = null;
}

// 可选：交卷后的判分结束、或者点 Retake 的时候可以调一下，
// 把闲置的 Worker 连同它占的几十 MB 内存一起释放。
// 不调也不会出错——下次判分会照常复用
function disposeGradingEngine() {
    killWorker();
}

// ---------- 跑一条用例 ----------

// 把一条用例派给 Worker，并在主线程这边计时。
// 超时就 terminate——这是整套超时保护真正生效的地方
function runCaseInWorker(studentCode, testCase) {
    return ensureWorker().then(() => new Promise((resolve) => {
        const id = ++messageSeq;
        const activeWorker = worker;
        let settled = false;

        const cleanup = () => {
            clearTimeout(timer);
            activeWorker.removeEventListener('message', onMessage);
            activeWorker.removeEventListener('error', onError);
        };

        const onMessage = (event) => {
            const msg = event.data;
            if (settled || !msg || msg.type !== 'result' || msg.id !== id) return;
            settled = true;
            cleanup();
            resolve(msg.result);
        };

        const onError = () => {
            if (settled) return;
            settled = true;
            cleanup();
            // Worker 自己崩了（比如 Pyodide 内部炸了）。
            // 状态已经不可信，杀掉重来
            killWorker();
            resolve({ passed: false, actual: null, error: 'The grading worker crashed.' });
        };

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            killWorker();
            resolve({ passed: false, actual: null, error: TIMEOUT_MESSAGE, timedOut: true });
        }, PY_CASE_TIMEOUT_MS);

        activeWorker.addEventListener('message', onMessage);
        activeWorker.addEventListener('error', onError);

        activeWorker.postMessage({ type: 'run', id, code: studentCode, testCase });
    }));
}

// ---------- 队列 ----------

// 全局只有一个 Worker，所以所有判分请求必须排队。
//
// 这不是性能取舍，是正确性要求：testing-engine.js 那边是把所有题
// 一起发起、最后 Promise.all 等结果的（见 gradeExamAnswers）。
// 不排队的话，第 3 题超时触发的 terminate 会顺手杀掉正在同一个
// Worker 里跑的第 5 题，第 5 题就莫名其妙地失败了
let queue = Promise.resolve();

function enqueue(task) {
    // 用 then(task, task)：前一个任务失败也要接着跑下一个，
    // 一道题判不出来不该拖垮整场判分
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
}

// ---------- 对外接口 ----------

// 跑一道题的全部用例，返回得分和逐条结果。
//
// 返回结构（跟老版本一致，testing-engine.js 的 renderGradeResult 依赖它）：
//   { score, total, earned, results: [{ label, passed, error, visible, input, expected, actual }], skipped }
async function gradeQuestion(studentCode, testCases) {
    if (!studentCode || !studentCode.trim()) {
        return { score: 0, total: 0, results: [], skipped: true };
    }
    if (!testCases || testCases.length === 0) {
        return { score: 0, total: 0, results: [], skipped: true };
    }

    return enqueue(async () => {
        const results = [];
        let earned = 0;
        let totalWeight = 0;

        // 这道题里已经出现过一次超时。
        //
        // 一旦出现，剩下的用例直接标记跳过、不再真跑。理由是成本：
        // 每次超时要 terminate + 重建 Worker（1~3 秒 wasm 重新初始化），
        // 一道题 8 条用例全超时就是 8 次重建，学生要干等半分钟。
        // 而死循环基本不挑输入，第一条卡住的话后面多半也卡。
        //
        // 代价是"只在某个特定输入下死循环"的代码会被少算几条用例的分。
        // 这个取舍偏保守，真要改的话就是把这个 flag 换成计数器、
        // 允许超时 N 次再放弃
        let aborted = false;

        for (const tc of testCases) {
            const weight = tc.weight || 1;
            totalWeight += weight;

            if (aborted) {
                results.push({
                    label: tc.label,
                    passed: false,
                    error: ABORTED_MESSAGE,
                    visible: !!tc.is_visible
                });
                continue;
            }

            let r;
            try {
                r = await runCaseInWorker(studentCode, tc);
            } catch (e) {
                // ensureWorker 失败（Pyodide 拉不下来、Worker 起不来）。
                // 这种是环境问题不是学生的错，整道题都判不了，
                // 但也不能 throw——throw 会让 Promise.all 短路，
                // 把其他题的结果一起丢掉
                r = { passed: false, actual: null, error: String((e && e.message) || e) };
                aborted = true;
            }

            if (r.timedOut) aborted = true;
            if (r.passed) earned += weight;

            results.push({
                label: tc.label,
                passed: r.passed,
                error: r.error,
                // 隐藏用例只告诉学生过没过，不泄露输入和期望输出——
                // 否则针对它们硬编码答案就行了。
                //
                // ⚠️ 这只挡得住不看 DevTools 的人。用例的输入必须发到前端
                // 才能跑，Network 面板里全看得见。真要防住得把判分挪到后端
                visible: !!tc.is_visible,
                input: tc.is_visible ? tc.call_args : null,
                expected: tc.is_visible ? tc.expected_return : null,
                actual: tc.is_visible ? r.actual : null
            });
        }

        return {
            score: totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100),
            total: totalWeight,
            earned,
            results,
            skipped: false
        };
    });
}