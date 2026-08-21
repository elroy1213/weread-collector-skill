# weread-collector · 微信读书公众号采集器

把你微信读书里关注的公众号文章，批量抓到本地，存成能直接看的 Markdown 和 JSON。

**它做什么、不做什么**：它只是用「你自己登录的浏览器」去读你本来就关注的公众号，**不破解、不碰你的账号密码、不存你的 cookie**。所以你需要先在本机登录一次微信读书。

---

## 你需要准备

- 一台电脑（**Mac、Linux 或 Windows** 都行；Windows 请用安装 Git 时自带的 **Git Bash** 来运行下面的命令）
- 装了 Google Chrome 浏览器
- 装了 Node.js（版本 ≥ 20；没装的话看下面「第 0 步」）
- 你的微信（用来扫码登录一次微信读书）

---

## 三步就能用上

> 打开「终端」（Windows 用户请打开 **Git Bash**），用 `cd` 进入这个项目文件夹，然后照着做。

### 第 0 步：装 Node.js（已经装过就跳过）

先检查一下有没有装：

```bash
node -v
```

- 看到 `v20.x.x` 或更高的版本号 → 直接进第 1 步。
- 看到 `command not found`（提示找不到命令）→ 去 https://nodejs.org/ 下载 **LTS** 版，一路「下一步」装完，然后**关掉终端重新打开**再试。

### 第 1 步：装依赖（只做一次）

```bash
npm install
```

第一次会下载一个叫 playwright 的组件，**可能要等几分钟**，看到 `added ... packages` 就好了。
想快一点可以用：`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install`

### 第 2 步：启动并登录（只做一次）

```bash
./scripts/start-chrome.sh
```

- 会自动弹出**一个新的 Chrome 窗口**（和你平时用的 Chrome 互不影响）。
- 如果窗口里是微信读书登录页，就用**微信扫码**登录。
- 回到终端，看到 `✅ 登录成功` 就可以进行下一步了。

> ⚠️ 这个 Chrome 窗口先别关，后面抓取要靠它。它在你电脑上的位置是 `~/.weread-collector/`，登录状态会一直留着，下次不用重扫。

### 第 3 步：发现公众号 → 抓文章

**先让工具认出你关注了哪些公众号（只做一次）：**

```bash
node scripts/discover_sources_cdp.js --config=sources.json
```

看到 `发现 N 个公众号` 就说明认出你了。

**再抓某个公众号的文章**（把 `【公众号名字】` 换成你关注的名字）：

```bash
node scripts/weread-content-cdp.js --config=sources.json --source=【公众号名字】
```

抓完的文章在 `outputs/weread-content/【公众号名字】/` 文件夹里，`.md` 文件双击就能看。

---

## 遇到问题怎么办

| 你看到的提示 | 怎么办 |
|---|---|
| `没找到正在运行的采集专用 Chrome` 或 `连不上采集专用 Chrome` | 先跑一遍第 2 步：`./scripts/start-chrome.sh` |
| `还没登录微信读书` / `请扫码` | 切到那个新开的 Chrome 窗口，用微信扫码登录 |
| `sources.json 没有可用来源` | 先跑第 3 步的 discover 命令 |
| 抓到一半卡住不动 | 按 `Ctrl + C` 停掉，重新运行同一条命令即可（已抓好的会自动跳过，不会重复抓） |
| `找不到 Playwright` | 回到第 1 步重新 `npm install` |

---

## 想抓更多

**只抓某段时间的文章**（比如只要 2026 年 8 月的）：

```bash
node scripts/weread-content-cdp.js --config=sources.json --source=【公众号名字】 --from=2026-08-01 --to=2026-08-31
```

**抓你所有的公众号**：把第 3 步的抓取命令对每个公众号各跑一次就行（把 `--source=` 换成不同名字）。

**更多进阶玩法**（定时自动抓、增量更新、和 AI 助手配合）：看 `SKILL.md` 和 `references/` 文件夹里的说明。

---

## 工作原理（想了解就看，不想了解可以跳过）

微信的公众号文章页（mp.weixin.qq.com）直接抓有反爬限制。这个工具改走**微信读书的公众号阅读器**——你在微信读书里关注的公众号，都能通过它稳定读到目录和正文。工具用一个带调试接口的 Chrome 复用你的登录状态，通过 `weread.qq.com/web/mp/articles` 接口列出文章，再逐篇打开微信原文页提取正文和图片。

- 你的登录信息只存在你自己电脑的 Chrome 里，这个工具不读取、不保存。
- `sources.json` 记录你关注的公众号清单，只存在本机，不会被上传到任何地方。
