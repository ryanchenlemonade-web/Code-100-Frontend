// ============================================================
// 判分 Worker：真正跑学生 Python 代码的地方
// ============================================================
//
// 为什么要单独一个文件（这些逻辑原来在 grading-engine.js 的主线程里）：
//
//   Pyodide 执行 Python 是【同步阻塞】的。学生写 `while True: pass`，
//   主线程就再也回不来了——await 拦不住、setTimeout 排不上队、
//   连"停止"按钮都点不动，整个页面死掉，只能强制关标签页。
//
//   挪进 Worker 之后卡死的是 Worker 自己那个线程，主线程照常跑。
//   超时了主线程调 terminate() 把这个线程直接杀掉。
//   【terminate 是唯一能打断同步死循环的手段】——
//   任何跟被测代码在同一个线程里做的"超时检查"都是自欺欺人：
//   代码卡住的时候，那段检查本身也永远轮不到执行。
//
// 消息协议（对面是 grading-engine.js）：
//   主 → Worker   { type: 'run', id, code, testCase }
//   Worker → 主   { type: 'ready' }                  Pyodide 装好了，可以收活
//                 { type: 'init-failed', error }     Pyodide 没装上
//                 { type: 'result', id, result }     一条用例跑完了
//
// ⚠️ 这个文件【不能】用 <script> 标签引，cs1_index.html 里不要加。
//    它是 new Worker() 的参数，路径写在 grading-engine.js 的 WORKER_URL 里，
//    默认跟 cs1_index.html 同目录。挪动文件位置时要同步改那个常量。

const PYODIDE_CDN = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js';

let py = null;

// 一进来就开始装 Pyodide（3~4MB 的 wasm）。
// Worker 是在交卷那一刻才创建的，所以这个下载不会拖慢进考试页面的速度。
(async function init() {
    try {
        importScripts(PYODIDE_CDN);
        py = await loadPyodide();
        postMessage({ type: 'ready' });
    } catch (e) {
        // 断网、CDN 挂了、公司网络墙了 jsdelivr 都会走到这。
        // 主线程收到之后会把这道题标成"判不了"，而不是静默算 0 分
        postMessage({ type: 'init-failed', error: String((e && e.message) || e) });
    }
})();

// ---------- 值的转换与比较 ----------

// 把 Python 的返回值转成能跟期望值比对的形式。
// Pyodide 返回的是 PyProxy（Python 对象的代理），不转的话
// 比的是两个代理对象，永远不相等
function toComparable(value) {
    if (value === undefined || value === null) return null;

    if (typeof value.toJs === 'function') {
        const js = value.toJs({ dict_converter: Object.fromEntries });
        value.destroy();   // PyProxy 要手动释放，不然内存泄漏
        return js;
    }
    return value;
}

// 结果要通过 postMessage 传回主线程，走的是结构化克隆，
// 有些东西克隆不了（函数、没转干净的代理）。这里过一道 JSON，
// 传不过去的退化成字符串——这个值只用来显示给学生看，不参与判定
function jsonSafe(value) {
    if (value === undefined || value === null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch (e) {
        return String(value);
    }
}

// 深比较。期望值来自用例的 JSON 字段，可能是数字、字符串、列表、字典
//
// ⚠️ 不处理 set / Map。用例的 expected_return 是 JSON，JSON 里没有 set，
//    所以题目要求返回 set 的话这里比不出来——录用例时要把题改成返回
//    排序后的 list，或者等以后专门加一种比较模式
function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (a === null || b === null) return false;

    // 数组和普通对象必须先分开。Object.keys([1,2]) 得到 ['0','1']，
    // 跟 {0:1, 1:2} 的键完全一样，不挡一下会判成相等
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
        return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
    }

    // 原来这里第二个条件误写成 `typeof a === 'object'`（本意是 b）。
    // 上面有 typeof a !== typeof b 的早退兜着，行为上没出过问题，
    // 但它不是本意，顺手改掉
    if (typeof a === 'object') {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return ka.length === kb.length && ka.every(k => deepEqual(a[k], b[k]));
    }

    return false;
}

// ---------- 跑一条用例 ----------

function runCase(code, tc) {
    // 每条用例一个全新的命名空间。
    // 共用的话，上一条用例定义的变量会留到下一条，
    // 本该报 NameError 的代码会意外通过
    const ns = py.globals.get('dict')();
    let fn = null;

    try {
        // 先把学生的代码整个执行一遍（定义函数）。
        // 这里用同步的 runPython 而不是 runPythonAsync：Worker 里没必要异步，
        // 而且死循环这件事有没有 await 都一样拦不住，靠的是外面的 terminate
        py.runPython(code, { globals: ns });

        if (tc.case_type === 'function') {
            fn = ns.get(tc.function_name);
            if (!fn) {
                return {
                    passed: false,
                    actual: null,
                    error: `Function "${tc.function_name}" is not defined.`
                };
            }

            const args = JSON.parse(tc.call_args || '[]');
            const actual = toComparable(fn(...args));
            const expected = JSON.parse(tc.expected_return);

            // trim_output 只对字符串结果生效——学生返回 "Strong password "
            // （末尾多个空格）不该算错
            const norm = (v) => (tc.trim_output && typeof v === 'string') ? v.trim() : v;

            return {
                passed: deepEqual(norm(actual), norm(expected)),
                actual: jsonSafe(actual),
                error: null
            };
        }

        // 脚本式（喂 stdin、抓 stdout）还没实现。
        //
        // ⚠️ one-liner 的判分也落在这个位置。它有三种形态，
        //    靠自动探测区分一定会出错，必须由用例声明判哪一种：
        //      表达式的值       lst[::-1]              → eval
        //      打印出来的东西   print(sum(lst))        → 抓 stdout
        //      执行后的变量     lst = [x+1 for x in lst] → exec 之后读 ns
        //    而且这三种都需要一段"前置代码"先把 lst 之类的变量绑好，
        //    Test_Case 现在没有字段放它。等题目形态定了再在这里加分支
        return {
            passed: false,
            actual: null,
            error: 'This question type is not auto-checked yet.'
        };

    } catch (e) {
        // 学生代码自己报错（语法错误、运行时异常）。
        // 这条算不通过，但错误信息要留下来告诉学生错在哪。
        // 只取最后一行：Python 的 traceback 前面几行是 Pyodide 的内部栈，
        // 对学生没有意义
        return {
            passed: false,
            actual: null,
            error: String((e && e.message) || e).split('\n').pop()
        };
    } finally {
        // 两个 PyProxy 都要手动释放。
        // 原来的版本漏了 fn，每跑一条用例泄漏一个代理对象
        if (fn && typeof fn.destroy === 'function') fn.destroy();
        ns.destroy();
    }
}

// ---------- 收活 ----------

self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'run') return;

    // 正常情况下主线程会等到 'ready' 才派活，这里只是兜底：
    // 万一时序错了，宁可回一条明确的错误，也不要静默算成不通过
    if (!py) {
        postMessage({
            type: 'result',
            id: msg.id,
            result: { passed: false, actual: null, error: 'Python runtime is not ready.' }
        });
        return;
    }

    postMessage({
        type: 'result',
        id: msg.id,
        result: runCase(msg.code, msg.testCase)
    });
};