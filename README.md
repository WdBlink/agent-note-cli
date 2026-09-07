# Agent Note CLI

```text
  ▐ AGENT NOTE

  工作脉络  /  日期与项目  /  深读与原文
  ↑↓ 移动   Enter 打开   Esc 返回
```

**今天，和 AI 一起推进了什么？**

把散落在 Codex、Claude Code 中的工作整理成一份有来源依据的 daily brief。在终端查看工作脉络、当前进展和参与情况，再按需深读一条工作线。

![Agent Note CLI 交互终端预览](docs/assets/agent-note-preview.gif)

交互终端会把会话整理成可继续阅读的工作线，并保留来源与深读入口。

[![Checks](https://github.com/WdBlink/agent-note-cli/actions/workflows/check.yml/badge.svg)](https://github.com/WdBlink/agent-note-cli/actions/workflows/check.yml)
[![Release](https://img.shields.io/github/v/release/WdBlink/agent-note-cli)](https://github.com/WdBlink/agent-note-cli/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[安装](#安装) · [快速开始](#快速开始) · [常用命令](#常用命令) · [配置与排错](docs/usage.md) · [后端与开发](docs/backend.md)

Agent Note CLI 是 Agent Notebook 的开源命令行客户端，**使用 App 原有的 Today 后端、编辑规则、模型流程和存储格式**。CLI 开放工作总结与深读；桌面 App 承接更完整的可视化复盘与知识工作。

## 安装

### Homebrew（macOS）

已安装 [Homebrew](https://brew.sh/) 后运行：

```sh
brew install wdblink/tap/agent-note-cli
agent-note --version
```

Homebrew 会安装所需的 Node.js。发布包已包含锁定的运行时依赖，不需要另行克隆 App 仓库，也不需要在安装时构建。

生成 brief 还需要你已安装并登录 [Codex CLI](https://developers.openai.com/codex/cli/) 或 [Claude Code](https://code.claude.com/docs/en/overview)。Agent Note 使用你的模型额度；**首次生成、刷新和首次深读可能产生模型费用，并向所选服务发送会话证据**。仅阅读已有结果可用 `--read-only`。

<details>
<summary>从源码安装（macOS / Linux）</summary>

需要 Node.js 22.16+；CI 覆盖 Node.js 22、24、26。

```sh
git clone https://github.com/WdBlink/agent-note-cli.git
cd agent-note-cli
npm ci
npm run build
npm install -g .
agent-note --version
```

也可以不全局安装，直接运行 `node src/cli.mjs`。`an` 是 `agent-note` 的短别名；若与已有命令冲突，请使用完整命令或源码入口。

</details>

## 快速开始

只用 Codex 的用户，可以从这条命令开始：

```sh
agent-note brief --source codex
```

只用 Claude Code 则替换为 `--source claude`。两个来源都已配置时，运行 `agent-note brief`。

不带参数运行 `agent-note`，会进入可持续导航的终端应用。也可以用 `agent-note ui --source codex` 带着指定范围进入：

```text
  ▐ AGENT NOTE    /    首页
  ─────────────────────────────────────
  今天，和 Agent 一起推进了什么？

  › 01  工作脉络
        阅读简报，按工作线继续深读
    02  回看日期
    03  选择项目
    04  会话来源
    05  浏览会话原文
    06  使用帮助

  ↑↓/jk 移动  Enter打开  Esc返回  q退出
```

方向键选择，Enter 打开，Esc 返回。列表支持 `/` 搜索；宽终端显示选中项预览，窄终端使用单列。工作线中按 `d` 深读、`s` 查看冻结原文、`e` 导出，长文用方向键和 Space 翻页。返回后保留列表选中项和阅读位置。

浏览时只读取会话与已存结果；选择生成或刷新才使用模型额度。进度页按 Esc 取消并返回，失败后可以查看详情、重试或继续浏览。`agent-note ui --read-only` 全程禁止模型生成。下面使用测试样例说明输出结构，不代表真实模型效果：

```text
01  结构化 Today 后端
把确定性控制流与模型节点分离。

当前停在：等待 UI 切换。
可能变化（AI 判断，尚未采纳）：Today 可以稳定显示结构化工作线。
你的参与：确定产品方向。
Agent 的参与：完成工程实现。
证据：ready · 会话 session-1
来源：session:codex:session-1
```

来源区列出会话文件与冻结的字节范围。AI 的判断与原始证据保持区分；失败或未归属的会话会显示出来。

## 常用命令

| 想做什么 | 命令 |
| --- | --- |
| 进入交互应用 | `agent-note ui` |
| 看今日工作脉络 | `agent-note brief` |
| 回看指定日期 | `agent-note brief --date 2026-09-05` |
| 只看当前项目 | `agent-note brief --project "$PWD"` |
| 深读第 1 条工作线 | `agent-note brief --workline 1` |
| 阅读已有结果，不调用模型 | `agent-note brief --read-only` |
| 用最新证据重新整理 | `agent-note brief --refresh` |
| 导出 Markdown | `agent-note brief --format markdown > today.md` |
| 导出完整结构化结果 | `agent-note brief --format json > today.json` |
| 查看所有选项 | `agent-note --help` |

这些选项可以组合。深读和重开时保持相同的 `--source`、`--project`、`--root` 与时区，才能定位到相同数据范围。

已有且未变化的结果直接重开，不重复调用模型。`--refresh` 保存新版本；失败不会覆盖旧版本。没有已有结果时，`--read-only` 会说明尚未整理，不会用原文摘录冒充 AI brief。

## 为终端与脚本而做

- 交互应用：键盘菜单、搜索、预览、分页和应用内导出；支持缩放，退出后恢复终端。
- `brief` 命令：直接输出结果，不插入应用菜单。
- 管道：进度写入 stderr，结果写入 stdout；`NO_COLOR=1` 关闭界面颜色。
- JSON：保留原后端 `index`、`dossier`、来源及覆盖情况，便于接入自己的工具。

`brief` 退出码：`0` 正常完成；`1` 参数、模型或运行失败；`2` 已输出结果但扫描或证据覆盖不完整，或来源已变化；`130` 用户中断。空日期正常返回 `index: null`。脚本应同时检查退出码与覆盖信息。

## 数据在哪里？

默认读取本机 `~/.codex/sessions`、`~/.codex/archived_sessions` 和 `~/.claude/projects`；原始会话只读。CLI 结果与恢复状态保存在 `~/.local/share/agent-note`，按来源、项目和时区隔离，可用 `--data-dir` 修改。

没有 Agent Note 账号或必需的 Agent Note 云服务。AI 生成走你的 provider；发送的会话证据可能包含代码、路径和敏感信息。继承的 provider 或 LangChain 环境配置仍可能影响这些依赖的行为，详见 [配置、隐私与结果边界](docs/usage.md)。

## 更新与卸载

```sh
brew update
brew upgrade wdblink/tap/agent-note-cli

brew uninstall agent-note-cli
```

卸载保留本地 brief 和恢复数据；不会删除 Codex / Claude Code 的会话。

## 开发与反馈

```sh
npm ci
npm run check

# macOS / Linux：真实伪终端验收，使用 Python 标准库与假模型
npm run test:tui
```

检查包含 App 原有测试、客户端与直接后端调用的结果对比、类型检查和发布包离线安装。测试使用合成会话与模拟模型响应，不能替代真实模型质量验收。

查看 [贡献说明](CONTRIBUTING.md)、[后端复用与发布流程](docs/backend.md)，或提交 [Issue](https://github.com/WdBlink/agent-note-cli/issues)。定位问题时请先移除日志里的私密内容。

MIT © WdBlink · [License](LICENSE)
