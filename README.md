# Token Meter — ZCode 实时速率条

把 **tok/s 和缓存命中率**直接显示在 ZCode **输入框下方**的一条常驻状态栏里。

![live](docs/tokbar-live.png)

- 背景**完全透明**，直接透出对话区底色（不会和侧边栏/输入框色对不上）；配色只用黑白灰。
- **延迟注入**：等界面真正挂载好（出现输入框）再等 2.5s 才插入，避开启动期的布局抖动。

数据来自 ZCode 自己的真实用量日志，不是界面文字估算：

```
~/.zcode/cli/rollout/model-io-*.jsonl
    durationMs                     → 速率分母
    response.usage.outputTokens    → 速率分子
    response.usage.cacheReadTokens → 缓存命中
    response.usage.inputTokens     → 命中率分母
```

---

## 用法（CDP 注入，内嵌到输入框下方）

ZCode 是 Electron 应用，给它加一个调试端口，就能往渲染层注入一条 UI。**不改安装目录、不打包。**

1. **完全退出 ZCode**（不是关窗口，是退出进程）。
2. 双击运行：

   ```
   injector\start-zcode-tokbar.bat
   ```

   它会：等 ZCode 退干净 → 用 `--remote-debugging-port=9333` 启动 ZCode → 等端口就绪 → 运行注入器。
3. 速率条会出现在**输入框正下方**；**保持那个命令行窗口开着**（关掉就停止刷新）。

> 已经用调试端口启动过 ZCode 的话，也可以单独跑：
> ```
> node injector\injector.mjs --port 9333
> ```

### 开关 / 入口：托盘图标（可选，默认不自启）

> 托盘**默认不会自动启动**，免得任务栏多一个图标。需要开关时手动双击 `injector\tokbar-tray.vbs`。

启动后托盘出现 **Token Bar** 图标，右键菜单：

| 菜单项 | 作用 |
|---|---|
| 状态 | 未运行 / 等待调试端口 / 已显示 / 已隐藏 |
| **显示 / 隐藏速率条** | 一键实时切换，不用重启 ZCode |
| 启动注入器 | 注入器没跑时一键拉起 |
| 启动 ZCode（带调试端口） | ZCode 已关闭时，用调试端口启动它 |
| 退出 | 关掉托盘（注入器仍在跑） |

开关原理：注入器在 `127.0.0.1:9334` 暴露控制接口 —— `GET /status`、`POST /visible`、`POST /toggle`。托盘只是它的一个 UI 外壳。

> 为什么不能像 A 方案那样出现在 ZCode 的插件列表里？
> 插件列表只认 MCP 插件；而这条速率条是注入进渲染层的 DOM 节点，ZCode 并不知道它的存在。所以入口放在系统托盘。

### 条上显示什么

```
● 95.2 tok/s   缓存命中 99.9%            7 次 · 6.4k out
```

指标口径是**按对话轮次（`turnId`）聚合**，不是瞬时值：

- **速率** = 上一轮所有模型调用的 `outputTokens 之和 ÷ durationMs 之和`
- **缓存命中** = 上一轮 `cacheReadTokens 之和 ÷ inputTokens 之和`
- 一次"轮"里通常有多次模型调用（工具循环），所以显示的是**这一轮的平均值**
- 绿点 = 正在输出，灰点 = 空闲
- 配色：黑白灰中性，不随数值变色
- 右侧：该轮调用次数 / 输出 token
- 曲线：最近 30 轮的速率

### 可选：截图按钮

如果你装了 **zcode-screenshot** 插件（`~/.zcode/local-plugins/zcode-screenshot/`），输入框工具栏里会**自动多出一个 📷 按钮**（在「完全访问」右边）：

- 点一下 = 框选截图 → 图片自动填入输入框（走那个插件原本的 `capture.ps1`，和 `/screenshot`、全局热键完全一致）
- **没装那个插件时按钮自动隐藏**，不影响本工具
- 脚本路径可用环境变量 `TOKBAR_SHOT_SCRIPT` 覆盖
- **如果截完没贴进输入框**：先跑一次插件的校准（`powershell -File capture.ps1 校准`，或直接点输入框后运行），因为 `capture.exe` 对 DPI 非感知，粘贴坐标需要按缩放比例校准

> 两个项目是**独立的**：tokbar 只负责注入条子和这个按钮，截图能力完全由 zcode-screenshot 提供。

### 位置怎么定的

自适应：找页面上最靠下的输入框（`textarea` / `contenteditable`），向上找到"输入框容器"，把条子插在它后面、且仍在应用主列内部（条子覆盖在底部，**不挤压布局**，所以不会把输入框顶高）。

如果 ZCode 的 DOM 结构特殊导致位置不对，改 `injector/injector.mjs` 里的 `findComposer()` / `ensure()` 即可。

---

## 分享给别人怎么用

### 对方需要

- **Windows 10/11**
- **Node.js（LTS）** —— 注入器用它连 CDP，没有 Node 就跑不了
- **ZCode 桌面版**（Electron）

### 对方要做的

1. 解压
2. 双击 **`install.bat`** —— 检查 Node、自动定位 ZCode、在桌面建一个「ZCode Token Bar」快捷方式
3. **完全退出 ZCode**
4. 双击桌面上的「ZCode Token Bar」
5. 条子出现在输入框下方；托盘图标可随时显示/隐藏

### 发布时只带这些

```
install.bat
injector/          # 自包含：injector.mjs + metrics.mjs + find-zcode.ps1 + 启动器 + 托盘
README.md
```

不需要 `node_modules/`、`dist/`、`plugin/`、`src/`、`scripts/`、测试脚本。

### 已知限制（要写进 README，别让人踩坑）

- **必须从启动器起 ZCode**（需要调试端口）；直接双击 ZCode 图标不会有条子
- ZCode 找不到时，可设环境变量 `ZCODE_EXE=C:\path\to\ZCode.exe`
- 属于**非官方注入**，ZCode 改版后 DOM 变了可能需要调整选择器
- 端口被占用时，改 `start-zcode-tokbar.bat` 里的 `PORT` 和 `--ctl-port`

## 不用启动器：app.asar 注入

把功能**焊进 ZCode 本体**，之后正常双击 ZCode 就有条子，不需要启动器和额外进程。

```bat
asar-patch\install-asar.bat     :: 等 ZCode 退出 → 打补丁 → 重启 ZCode
asar-patch\restore-asar.bat     :: 还原
```

**原理**：`app.asar` 是「头部 JSON + 数据区」。安装器只做两件事：

1. 在 `out/renderer/index.html` 里插入 <code>&lt;script&gt;</code>（状态栏 UI）
2. 在 `out/main/index.js` 末尾追加一段（主进程内起 `127.0.0.1:9335` 的 metrics 服务，读真实日志）

采用**追加式补丁**：不动原有数据区，只更新这两个条目的 `offset/size/integrity` 并把新内容追加到末尾 ——
原生模块（`node-pty` / `ssh2` 的 14 个 unpacked 条目）完全不受影响。

安全措施：

- 自动备份 `app.asar.tokbar-bak`，`restore-asar.bat` 一键还原
- 打完后校验：条目数、注入标记、以及被改条目的 SHA256 integrity 是否与内容一致
- 只在 ZCode 完全退出时执行（否则文件被占用）

> ⚠️ **ZCode 每次升级都会覆盖 `app.asar`，条子会消失** —— 升级后重跑一次 `install-asar.bat` 即可。
> 这个模式没有托盘开关（条子常驻）；要开关请用上面的启动器方案。

## ⚠️ 安全与注意

- `--remote-debugging-port` 会在本机暴露一个 CDP 端口（**等于能在这个 ZCode 窗口里执行任意 JS**）。仅本机可连，但**本机任何程序都能连**。不用时关掉注入器和 ZCode 即可。
- 这是**非官方**的渲染层注入：**ZCode 升级/改版后可能需要调整选择器**。
- 注入器不修改任何文件，只在内存里加一个 DOM 节点。

---

## 目录

```
zcode-tokbar/
├─ injector/                    # 启动器方案（CDP 注入，可开关）
│  ├─ injector.mjs              #   注入 + 每 800ms 推数据 + 控制接口(9334)
│  ├─ metrics.mjs               #   读 model-io 日志，按 turnId 聚合
│  ├─ find-zcode.ps1            #   自动定位 ZCode.exe
│  ├─ start-zcode-tokbar.bat    #   等 ZCode 退出 → 带调试端口启动 → 注入
│  ├─ relaunch.bat              #   守望式重启（退出后自动拉起）
│  ├─ tokbar-tray.ps1 / .vbs    #   托盘开关（显示/隐藏、启动注入器、启动 ZCode）
├─ asar-patch/                  # app.asar 方案（焊进客户端，无启动器）
│  ├─ install-asar.mjs          #   追加式补丁 + 校验 + 备份 + 还原
│  ├─ install-asar.bat          #   等 ZCode 退出 → 打补丁 → 重启
│  ├─ restore-asar.bat          #   还原
│  ├─ main-snippet.js           #   主进程：127.0.0.1:9335 metrics 服务
│  └─ renderer-snippet.html     #   渲染层：状态栏 + 截图按钮
├─ install.bat                  # 检查 Node / 定位 ZCode / 建桌面快捷方式
└─ docs/                        # 截图
```
