# Font Awesome 本地化（不再依赖 CDN）

版本跟原来 CDN 引的完全一致：**Font Awesome Free 6.5.2**，官方 npm 包里取的，不是第三方镜像。

## 为什么要做这件事

原来引的是 `https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css`。
这个域名在国内网络会被墙，一被墙**整站图标全部消失**——按钮框还在，里面是空的。

Cribsheet Builder 的工具条改成纯图标之后症状最明显：整条变成一排看不见的空按钮，
看起来像功能坏了，实际只是字体没加载。

放本地之后就跟网络环境无关了。

## 放哪里

整个 `fontawesome` 文件夹放进 `0. Shared/`，最终结构：

```
0. Shared/
    auth.js
    auth.css
    auth-modal.html
    config.js
    fontawesome/
        css/all.min.css
        webfonts/fa-solid-900.woff2
        webfonts/fa-regular-400.woff2
        webfonts/fa-brands-400.woff2
        LICENSE.txt
```

`css` 和 `webfonts` 的相对位置**不能改**。`all.min.css` 里是用
`url(../webfonts/fa-solid-900.woff2)` 引字体的，挪了就找不到。

## 改 HTML

先找出所有引了 CDN 的文件。在项目根目录跑：

```bash
grep -rn "cdnjs.cloudflare.com" --include="*.html" .
```

每一处把这一行：

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
```

换成指向本地的（`crossorigin` 和 `referrerpolicy` 是给跨域 CDN 用的，本地不需要，一起去掉）：

```html
<link rel="stylesheet" href="../../../0. Shared/fontawesome/css/all.min.css">
```

⚠️ **`../../../` 的层数每个文件不一样**，照抄同一个文件里已有的那行 `0. Shared/auth.css` 的前缀就不会错。

- `2. Computer Science/CSC1-1100/index/cs1_index.html` → `../../../0. Shared/...`
- `1. Home Page/home_page.html` → `../0. Shared/...`
- `1. Admin/admin.html` → `../0. Shared/...`
- `2. Computer Science/CSC1-1100/auth/verify-email.html` → `../../../0. Shared/...`

拿不准就在浏览器 Network 面板里看 `all.min.css` 是不是 200。

## 只带了 woff2

`.ttf` 没有放进来。`all.min.css` 里 woff2 排在 ttf 前面，现代浏览器用了 woff2
就不会再去请求 ttf，所以省掉这 700KB 不影响任何东西。
（woff2 从 2016 年起全平台支持，RPI 学生的浏览器不会有问题。）

`fa-v4compatibility` 也没带——那是给 FA4 时代 `<i class="fa fa-star">` 这种老写法用的，
你站内全是 `fa-solid` 的新写法，用不到。

## 验证

改完硬刷新（`Cmd+Shift+R`），确认：

1. 页面上的图标都回来了
2. Network 面板里 `all.min.css` 是 200，来源是本地不是 cdnjs
3. `fa-solid-900.woff2` 也是 200
4. Console 里没有 404

## 顺带

`gridstack` 也是从 CDN 引的（`cdn.jsdelivr.net`），是**同一类风险**，而且后果严重得多——
Font Awesome 挂了只是没图标，GridStack 挂了整个 Cribsheet Builder 直接不工作
（`initCribsheetGridStack` 里有 `typeof GridStack === 'undefined'` 就 return）。

现在 jsdelivr 是通的所以没暴露，但哪天不通就是白屏。
要一起本地化的话方法一样，npm 包名是 `gridstack`。
