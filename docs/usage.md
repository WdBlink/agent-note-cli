# 使用与配置

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

每个范围保存 `traceink-assets-v1.json` 及 SQLite checkpoint。失败/中断后的下一次相同请求使用原后端恢复逻辑；能否复用取决于冻结证据和工作流标识是否仍一致。已发布的旧版本在失败刷新后保留。原后端可能截断过大证据，相关覆盖状态仍保留；CLI 不另写摘要降级路径。

同一范围只允许一个进程使用存储。如果进程异常退出留下 `writer.lock`，先确认没有相关 CLI 进程在运行，再对错误信息中的**空锁目录**执行 `rmdir`。不要删除资产 JSON 或数据库来解锁。

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
