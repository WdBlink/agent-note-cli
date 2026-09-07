# 使用与配置

## 交互终端应用

运行 `agent-note` 或 `agent-note ui`。`ui` 可以组合 `--date`、`--project`、`--source`、`--root`、`--settings`、`--timezone`、`--data-dir` 和 `--read-only`。格式导出、生成与深读在菜单中完成；脚本继续使用 `brief`。

| 场景 | 按键 |
| --- | --- |
| 菜单 | ↑↓ 或 j/k 移动，Enter 打开，1–9 直接选择 |
| 返回与退出 | Esc 返回，q 或 Ctrl-C 退出 |
| 搜索列表 | / 开始输入，Enter 完成筛选，Esc 清除 |
| 阅读长文 | ↑↓ 滚动，Space/PageDown 下翻，PageUp 上翻，Home/End 跳转 |
| 工作线 | d 深读，s 来源，e 导出 |
| 输入日期、路径 | Enter 确认，Esc 取消，Ctrl-U 清空 |
| 生成中 | Esc 取消并返回，q 或 Ctrl-C 取消并退出 |

应用启动和浏览不会自动调用模型；生成入口会标明使用模型额度。只读模式不提供生成入口。错误显示在应用内，可查看完整原因、重试或返回。导出使用独占创建，不覆盖已有文件。

窗口最小为 24 列 × 12 行；100 列以上的菜单可显示右侧预览。`NO_COLOR=1` 保留文字选中标记并关闭颜色。`TERM=dumb` 或非 TTY 不启动交互界面，请使用普通 `brief` 命令。

### 配色和图稿没有出现

文字菜单、配色和 PNG 图稿使用不同的终端能力；当前应用在禁色时也停用彩色图稿。菜单可以操作但没有暖色配色时，先检查启动环境；有配色但显示字符像素图稿时，再检查图片协议；只有 `▤` 标记时还需检查窗口大小。

```sh
printenv TERM TERM_PROGRAM COLORTERM NO_COLOR
env -u NO_COLOR agent-note ui
```

`NO_COLOR` 可能从启动终端的父进程继承，包括 IDE、自动化工具和其他 shell。`env -u NO_COLOR` 只对这次启动移除它。`agent-note ui --color always` 可以覆盖继承的禁色设置，`--color never` 明确使用无颜色模式；默认 `auto` 仅在 `NO_COLOR` 非空时禁色。v0.5.0 起支持这些选项；此前 v0.4.0 会把空值 `NO_COLOR=` 也当作禁色，旧版本使用上面的 `env -u` 命令即可恢复。

| 运行环境 | 当前应用选择的渲染方式 |
| --- | --- |
| iTerm2、WezTerm | ANSI 配色 + iTerm inline PNG 协议 |
| Ghostty、Kitty、Otty | ANSI 配色 + Kitty PNG 协议 |
| Apple Terminal、Alacritty、VS Code 集成终端及未识别的终端 | ANSI 配色 + 字符像素笔记本；当前应用未启用其图片传输 |
| tmux / screen | ANSI 配色 + 字符像素笔记本；当前应用未实现图片透传 |
| NO_COLOR 非空或 --color never | 单色字符像素笔记本 |

图片优先、字符回退随 v0.5.0 发布。协议按终端环境标识识别，不保证自动发现所有终端的图形能力；未识别时安全回退。`--color always` 不会强制发送不受支持的图片协议。标题图稿要求至少 60 列 × 16 行，开合动画要求至少 80 列 × 22 行。窗口过小或经 SSH 丢失终端标识时仍可能只显示文字；不要通过伪造 `TERM_PROGRAM` 强行开启协议。

兼容性依据：[iTerm2 图片协议](https://iterm2.com/3.5/documentation-images.html)、[WezTerm 图片协议](https://wezterm.org/imgcat.html)、[Kitty 图片协议](https://sw.kovidgoyal.net/kitty/graphics-protocol/)、[Ghostty 功能说明](https://ghostty.org/docs/features)及 [NO_COLOR 约定](https://no-color.org/)。2026-09-07 在本机 iTerm2 完成实际显示验证；其他分支使用环境矩阵和协议输出测试，未逐个安装终端实测。

界面采用暖色深底与奶油色正文。Otty、Ghostty、Kitty、iTerm2 和 WezTerm 自动显示原生笔记本图稿：欢迎时先揭开绑带再展开，正常退出时合上并扣回绑带，可按任意键跳过；Ctrl-C / SIGTERM 直接退出。日常菜单和阅读页只在标题旁显示 4 列 × 2 行的小图。超过 0.6 秒的等待才显示较大的打开状态，图片最多 24 列 × 12 行，保持原图质感，进度条独立更新。图片不可用时使用同一套字符像素图稿：标题标记为 4 列 × 2 行，开合及等待图稿为 26 列 × 12 行，整理等待时显示笔的书写循环。字符回退也支持单色；窗口低于相应尺寸时保留文字标记和完整内容。真彩色终端使用完整配色，其他终端使用 256 色近似。长文限制行宽并区分章节标题。深读按实际阶段更新，移动光标表示仍在处理，不代表完成百分比；页面只重绘发生变化的行。

来源偏好保存在数据目录下的 `ui-preferences.json`，仅用于交互应用。显式 `--source` 和 settings 中的来源配置优先；日期、项目只在当前浏览会话中生效。`brief` 脚本接口不读取 UI 偏好。

## 来源与模型

`--source all|codex|claude` 控制启用的会话来源，也沿用 App 的 provider 分配规则。默认启用两个来源；如果只有其中一个 CLI，请明确选择它。

首次安装后先运行 `codex --version` 或 `claude --version`，并在对应 CLI 完成登录。Agent Note 不复制登录凭据。已有会话但模型 CLI 未安装时，生成会失败；已有 brief 仍可用 `--read-only` 阅读。

`--settings FILE` 读取 App 格式的 settings 对象，或包含 `settings` 字段的 JSON。示例（目录与 CLI 路径按自己机器修改）：

```json
{
  "sessionScanRoots": ["~/.codex/sessions", "~/.codex/archived_sessions"],
  "enabledSessionProviders": ["codex"],
  "codexCliPath": "codex",
  "claudeCliPath": "claude"
}
```

```sh
agent-note brief --settings ./settings.json
```

模型分配、默认模型及编辑规则来自 App。显式覆盖示例：

```sh
agent-note brief --source codex --codex-model YOUR_MODEL --refresh
agent-note brief --source claude --claude-model YOUR_MODEL --refresh
```

两个选项分别映射到原有的 `AGENT_NOTEBOOK_TODAY_CODEX_MODEL` 与 `AGENT_NOTEBOOK_TODAY_CLAUDE_MODEL` 环境变量。未加 `--refresh` 时，已有未变化的结果仍直接重开。

## 自定义范围

```sh
agent-note brief --date 2026-09-05 --timezone Asia/Shanghai
agent-note brief --root ~/exports/codex --source codex
agent-note brief --root ~/exports/codex --root ~/exports/claude
agent-note brief --project ~/Code/my-project --data-dir ~/agent-note-data
```

`--root` 可重复。原后端依赖目录名中的 `codex` 或 `claude` 识别来源；无该标识的目录会被拒绝。命令行不根据 `CODEX_HOME`、`CLAUDE_CONFIG_DIR` 自动改写 App 默认扫描目录，请用 `--root` 或 settings 明确设置。

日期依据所选时区，默认系统时区。项目筛选保留匹配主会话的完整 Agent 家族，即使子 Agent 在另一个目录执行。不同来源、项目和时区使用独立数据范围。工作线编号属于当前范围当前版本；脚本可使用 JSON 中的 `worklineId`。

## 结果与恢复

重新扫描会重新读取来源，不调用模型。快速操作保持当前列表；较慢的操作显示进度页。完成后列表上方保留扫描时间、会话数与工作线数，直到选择下一项操作。取消或失败会显示“扫描未完成”，并保留上次结果。

JSON 外层为 `agent-note-cli/view/v1`：

| 字段 | 含义 |
| --- | --- |
| `mode` | `raw` 尚未生成；`compiled` 已生成；`stale` 已有结果与当前证据不一致 |
| `index` | App 原始 `today-workline-index/v1`，未生成时为 `null` |
| `dossier` | 指定工作线的 App 原始深读产物，未请求时为 `null` |
| `sessions` | 当前扫描会话，包含完整 transcript capture 标识 |
| `evidenceCoverage` / `warnings` | 扫描覆盖与警告 |
| `dataDir` | 当前范围的持久化目录 |

原始 V1 证据定位是会话及冻结字节范围，不声称具有精确到单条消息的引用能力。模型生成的参与描述与可能变化不是用户确认。

每个范围保存 `traceink-assets-v1.json`、SQLite checkpoint 和 `structured-today-runtime-v1.sqlite`。后者存放小体积进度与可复用的成功摘要。失败/中断后的下一次相同请求使用原后端恢复逻辑；能否复用取决于冻结证据和工作流标识是否仍一致。已发布的旧版本在失败刷新后保留。原后端可能截断过大证据，相关覆盖状态仍保留；CLI 不另写摘要降级路径。

同一范围只允许一个进程使用存储。如果进程异常退出留下 `writer.lock`，先确认没有相关 CLI 进程在运行，再对错误信息中的**空锁目录**执行 `rmdir`。不要删除资产 JSON 或数据库来解锁。

正常取消会等待运行中的模型进程停止并释放锁。强制杀进程或断电仍可能留下锁。交互深读绑定到所见的工作线 ID 与 Index 版本，不会因自动刷新而把旧编号解释成另一条工作线。

## 隐私

原始会话只读。生成、刷新或首次深读会把原后端选择的证据通过你的模型 CLI 发给对应 provider；证据可能含代码、文件路径、用户反思或秘密，当前版本不自动脱敏。provider 的认证、配额和数据政策仍适用。

CLI 继承与 App 相同的模型进程环境和依赖；例如用户已设置的 `LANGCHAIN_TRACING_V2` / `LANGSMITH_TRACING` 可能启用第三方 tracing。需要严格本地阅读时使用 `--read-only`，并自行检查宿主机的 provider/依赖环境配置。Agent Note 没有自己的遥测服务。

`--read-only` 保证不调用模型；为读取并管理缓存，仍可能创建本地数据目录、空资产存储和短暂锁目录。它不是“整个文件系统零写入”模式。

## 常见问题

**找不到会话**：确认日期和时区、来源是否正确，自定义目录是否包含 provider 标识。未生成的 raw 状态与模型失败是两种不同情况。

**模型报错或不识别参数**：升级对应 CLI，检查登录状态与模型可用性。App 的结构化输出、临时会话和隔离参数需要 provider CLI 支持。可在 settings 中填写 CLI 绝对路径。

**切换了模型但结果没变**：用 `--refresh` 生成新版本。

**深读提示找不到工作线**：复用生成 brief 时的来源/项目/时区，并从当前 brief 获取编号或 ID。

**看到 SQLite ExperimentalWarning**：这是部分 Node.js 版本对内置 SQLite 的提示，写入 stderr，不影响 JSON stdout。

**`an` 与其他命令冲突**：使用 `agent-note`。若 Homebrew 链接阶段报已有文件，先检查已有命令归属；不要使用 `--overwrite` 覆盖不相关工具。

**Windows**：当前发行验证覆盖 macOS 与 Linux，没有声称原生 Windows 支持。
