# 后端与开发

## 与 App 相同的后端

CLI 没有自己的会话解析器、摘要 prompt、工作线算法或降级版模型流程。实际调用的是 App 使用的模块：

| 能力 | 原有模块 |
| --- | --- |
| 会话发现、去重、家族归属、完整 transcript capture | `src/agent-sessions.ts` |
| 冻结证据、主会话及子 Agent 证据归属 | `app/desktop/structured-today-input.ts` |
| 编辑规则、模型节点和输出约束 | `src/structured-today-model-functions.ts` + Traceink bundle |
| 有界并发、合成、校验和重试 | `src/structured-today-langgraph.ts` |
| 正式准备与发布、指定工作线深读 | `app/desktop/structured-today-runtime.ts` |
| 原子保存、版本、工作流恢复 | `traceink-asset-repository.ts` + `langgraph-node-sqlite-checkpointer.ts` |
| 运行状态与成功摘要缓存 | `structured-today-runtime-store.ts` |
| 读取已有结果、判断证据变化 | `src/structured-today-review-state.ts` |
| 模型分配和进程调用 | `structured-today-cli-caller.ts` + `cli-runner.ts` |

`backend/upstream/` 是上述后端及依赖的**未改写源码快照**，带原有测试与编辑规则。`backend/provenance.json` 记录来源提交和每个文件的 SHA-256；来源为该提交上的工作树，哈希也覆盖当时尚未提交的编辑规则修订。构建时逐文件校验，禁止在 CLI 中维护第二套后端实现。App 当前仍是后端源码来源，通过同步脚本更新快照；这不是已经完成双仓库包依赖迁移的 monorepo。本分支在该快照上增加了 Cursor 会话来源与 Cursor Agent CLI 编译路径；从 App 重新同步前需要把同等改动带回 Agent Notebook，否则会被覆盖。改动清单见下节。

### 需要带回 Agent Notebook 的改动

快照来自 App 的 `e259f166`。生成可直接在 App 工作树上 `git apply` 的补丁：

```sh
git diff 6ae8403 -- backend/upstream | sed 's#\([ab]\)/backend/upstream/#\1/#g' > /tmp/cursor-support.patch
```

其中三类改动**与 Cursor 无关**，是快照里既有的缺陷，App 同样中招，建议单独评审：

| 位置 | 问题 |
| --- | --- |
| `src/agent-summary.ts`、`src/workline-review.ts`、`app/desktop/structured-today-cli-caller.ts` | 传给 Claude Code 的 `--safe-mode` 已被该 CLI 移除，任何较新版本上 Claude 编译都以非零码退出 |
| `app/desktop/structured-today-runtime.ts` | 会话 ID 一致性检查发生在 digest 缓存写入之后，一次坏响应会被永久固化，无法重试 |
| `src/workline-review.ts`、`src/traceink-review-assets.ts`、`app/desktop/structured-today-citations.tsx` | 读回与展示侧只认 codex/claude，写入侧却已能产生 cursor |

其余是 Cursor 支持本身：会话发现与解析、编译器分派、以及三处传输层补偿（内联 schema、还原唯一值 enum、读取第一个完整 JSON 值）。补偿的依据是对 Cursor Agent CLI `2026.09.02` 的实测偏差，注释里记录了各自的观测现象。

```sh
# 维护者：从 App 工作树同步相同后端，随后重新验证
node scripts/sync-backend.mjs /path/to/agent-notebook
npm run check

# 校验两个仓库的后端源文件逐字节一致
node scripts/sync-backend.mjs /path/to/agent-notebook --check
```

JSON 中的 `index` 保留原始 `today-workline-index/v1` 产物，包括工作线、Session membership、参与情况、证据、覆盖情况与 provenance；`dossier` 保留原始深读产物。没有把完整后端结果改成几个字符串的简化摘要。V1 来源精度仍以 App 的会话级证据为准，不冒充消息级引用。

CLI 当前开放 Today 的工作脉络与按需深读，会话来源包括 Codex、Claude Code 和 Cursor。Wiki 编辑、反思写入、提案采纳和封页没有命令入口；它们不是用另一套简化逻辑替代实现。Cursor 会话由 Cursor Agent CLI（`agent`）整理：digest 跟会话来源走，三个来源同时启用时合成仍优先 Codex、核查走 Claude。

交互界面在 `src/interactive.mjs` 组织页面流程，`src/terminal.mjs` 负责键盘、终端单元宽度、分页和生命周期。两者使用 Node 标准库，不增加运行时 UI 框架。原文阅读仍调用共享的冻结范围阅读器与 transcript parser。React 与图标包仅是同步后端引用测试的开发依赖，不进入发布包。

## 本地开发与验证

```sh
npm ci
npm run check
npm run test:tui # macOS/Linux + Python 3，真实 PTY 与假 Provider
```

测试目录包括导入的 App 测试、客户端与直接后端的等价性测试，以及带空 npm 缓存的离线安装检查。后端原文件与 contract 哈希不变；客户端测试允许独立运行产生不同 invocation UUID。

## 发布

1. 更新 `package.json`、锁文件和 `docs/releases/vVERSION.md`。
2. 运行 `npm run check` 和 `node scripts/sync-backend.mjs /path/to/agent-notebook --check`。本分支的 Cursor 改动尚未回到 App，`--check` 必然报 `Backend drift`；等改动在 Agent Notebook 落地后这步才应重新生效，在此之前不要靠改哈希绕过。
3. 提交并推送，确认 Check 工作流通过。
4. 创建与包版本一致的 `vVERSION` tag 并推送。Release 工作流再次运行检查矩阵，再发布 tarball、`SHA256SUMS`、`agent-note-cli.rb`。
5. 把该 release 的 formula 同步到 `WdBlink/homebrew-tap/Formula/agent-note-cli.rb`，验证实际 `brew install` 与 `brew test` 后发布 tap 更新。

```sh
# 本地生成相同的发布产物，不执行 GitHub 发布
npm run release:pack
```

产物位于 gitignored 的 `release/`。包使用 npm 的 bundled dependencies，安装不需要重新解析或下载运行时依赖；Homebrew 的 npm 安装明确开启 offline 模式。它仍需 Homebrew 提供 Node.js。
