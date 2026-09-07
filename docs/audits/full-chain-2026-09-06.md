# Agent Note CLI 全链路审查

审查日期：2026-09-06。审查版本：`0a531599b6fbafd66a25920dfc047c0b5ff1f4ed`（v0.1.0）。本地 HEAD 与审查开始时的远端 HEAD 一致。仅增加审查报告、探针和证据，没有修改产品代码、调用真实模型或发布版本。

**结论：复用 App 后端、保持 CLI 薄层的方向正确，但当前实现存在会影响主要使用流程和证据可信度的缺陷。它是 V1 的“会话家族摘要 → 工作线合成 → 按需深读”，不是完整的“结构化事件 → 精选 → 聚簇”流水线。测试通过证明已有契约可运行，不证明边界正确或真实语义质量达标。**

`node scripts/sync-backend.mjs /Users/wdblink/Code/my_repo/agent-notebook --check` 确认 49 个文件逐字节一致。复用也继承了旧后端问题；CLI 没有继承 Electron 的日期刷新竞态、反思草稿丢失和 IPC 广播成本，不能把那些 App 问题算到这个版本上。

## 1. 实际链路与产品含义

| 用户关心的环节 | 实际实现 | 判断 |
| --- | --- | --- |
| 发现与结构化 | 扫描 JSONL，解析来源身份、工作目录、活动日期、主子会话关系；记录完整文件字节数与哈希 | 基础合理，但限额先于项目筛选，历史日发现有遗漏 |
| 预筛 | 来源/日期/去重/容量限制、capture 可用性校验 | 是确定性准入，不是语义重要性评分；按新近程度截断不能当作精选 |
| 精选 | 没有独立精选节点；可用家族基本都进入 Digest，合成时分配工作线或 unresolved | 不必为了阶段齐全增加模型，但尚无明确的重要性选择与可回查理由 |
| 摘要 | 主会话与已发现的子 Agent 组成一个家族，做一次 Digest | 比每个子 Agent 单独摘要合理；一个家族只输出 summary/currentStop/participation/evidenceIds/uncertainties，可能压缩掉多件独立事项 |
| 事件 | 原始日志有 provider event，但生产路径没有持久化的原子工作事实/事件集合 | provider 日志事件不等于“测试失败、完成迁移、改变决策”等工作事件 |
| 聚簇 | synthesis 模型直接把家族摘要归入 worklines；一个 Session 可分配多条工作线 | 这是一次语义分组，不是基于独立事件的稳定聚簇；成员 ID 一致性有确定性校验，分组语义正确性没有同等验证 |
| 深读 | gather 定位信息 → analysis → critique → compose → 结构/引用 ID 校验 → 保存 | 原文输入与语义验收有缺口，详见下文 |
| 阅读与缓存 | 扫描后比较来源版本；未变直接重开，变更自动生成新 Index；独立 JSON 资产与 SQLite checkpoint | 成功重开零模型调用正确；自动刷新与编号选择耦合会打开错误工作线 |

生产入口见 [service.mjs](../../src/service.mjs)、[runtime](../../backend/upstream/app/desktop/structured-today-runtime.ts)、[LangGraph](../../backend/upstream/src/structured-today-langgraph.ts)。快照带有部分 V2 类型和输入构造代码，但 `brief` 没有走 V2 的消息级 finding 链路。

正常调用数量：F 个家族首次生成为 F 次 Digest + 1 次 synthesis，Digest 并发上限 3；关系修复最多再增加一次 synthesis。每条首次深读再增加 3 次串行调用。统计的是宿主发起的模型节点，不是 Provider 内部工具/推理回合。当前没有真实语义评测支持额外插入四轮模型。

## 2. 应优先修复的确定问题

P1：主要流程、选择正确性或证据可靠性问题。P2：适用特定使用条件、规模或脚本场景的可用性问题。以下“已复现”均指本仓库合成输入和假 Provider；探针断言当前缺陷存在，不是修复验收测试。

### P1：一次暂时性 Digest 失败后，普通重试无法恢复

**已复现：** 第一次模型调用 1 次后失败；模拟 Provider 恢复，再运行相同 `brief`，新增调用 **0 次**，仍然无法通过发布门槛。

根因：[structured-today-langgraph.ts:552](../../backend/upstream/src/structured-today-langgraph.ts) 的 `executeDigest` 把异常变成业务 failed 结果，图仍可走到终点；[structured-today-runtime.ts:137](../../backend/upstream/app/desktop/structured-today-runtime.ts) 发现相同 run 的 checkpoint 后用 `invoke(null)` 恢复已经结束的图。失败返回值不等于待重试节点。

最小修复：明确区分节点中断与终局业务失败，保留成功家族结果，仅重新调度失败家族。验收必须覆盖“失败后恢复，再次运行成功且成功家族不重算”。现有恢复测试覆盖 synthesis 抛错，漏掉这一种失败。

### P1：输入裁剪会复制消息，并突破预算数倍

**已复现：** 4000 条短消息进入预算函数后成为 **8001 条**（包含省略标记），仅 4001 个不同 ID；结果 **1,372,629 字符**，声明上限 **240,000**。

根因：[structured-today-input.ts:338](../../backend/upstream/app/desktop/structured-today-input.ts) 用完整 JSON 判断超限，却在 `takeMessages` 中只累计 content 长度；head/tail 不排除交集，最终序列化后也不复核。实际模型 prompt 还会再次 JSON 编码，不能把 evidenceText 的 24 万限额等同于整个 prompt 大小。

影响：重复证据、额外费用、超时和上下文超限风险。修复应按序列化成本计数，按消息位置排除 head/tail 重叠，最终检查载荷上限，保留准确的省略范围。

同类缺陷：[transcript-reader.ts:182](../../backend/upstream/app/desktop/transcript-reader.ts) 把单条 81000 字符消息截成 **80018** 字符，但 `truncated` 仍为 **false**。截断状态必须传到输入和用户可见的证据覆盖信息。

### P1：深读没有受控原文输入，源文件删掉后仍能发布

**已复现：** Index 的 Digest 输入含唯一事实；随后删除源文件，`brief --workline 1` 仍进行 3 次深读调用并发布 supportingEvidence。三次 prompt 都不包含该事实。

根因：[structured-today-langgraph.ts:234](../../backend/upstream/src/structured-today-langgraph.ts) 的 gather 只收集 evidence locator；analysis/critique 接收路径、哈希、范围等定位字段，没有宿主读取并校验的冻结原文。CLI 的 stale 状态也没有阻止这一生成。

这证明输入契约缺口，**不证明真实模型永远不自行读文件**：Provider CLI 允许读取。但读取是否成功、是否符合 Index 冻结字节范围，没有成为可校验的发布前提。

最小修复：复用已有 `readBoundedTranscriptSource`，把选定工作线的冻结片段提供给模型；不可读/不匹配进入明确缺口。合法引用 ID 只能证明“引用对象存在”，不能证明“结论有原文支持”。

### P1：critique 否定后，结果仍无条件标记 semantic passed

**已复现：** 假 critique 返回 `acceptable: false` 和未支持结论问题；compose 不作修正，仍能发布 `validation.semantic: passed`。问题保存在 JSON 的 `critiqueIssues`，但普通文本/Markdown 没有显示。

根因：[structured-today-artifacts.ts:159](../../backend/upstream/src/structured-today-artifacts.ts) 无条件填写三类 passed；后续校验检查证据 ID、归属和哈希，不检查语义问题是否解除。[presentation.mjs:31](../../src/presentation.mjs) 也未呈现 critiqueIssues。

不能简单把“critic 曾否定”一律视为最终失败，因为 compose 可能真正完成修正。最小正确边界是：未完成复核就明确显示未验证及仍待解决的问题，不能无条件声称语义通过。若产品需要自动发布门槛，再定义有限的修复与复核步骤。

### P1：输入旧列表编号，可能深读新列表中的另一条工作线

**已复现：** 首次列表为 A、B；源会话新增内容后，合成输出变为 B、A；用户输入 `--workline 1`，得到 B 的深读。

根因：[service.mjs:57](../../src/service.mjs) 先自动刷新，`:66` 才解析编号；[cli.mjs:92](../../src/cli.mjs) 的交互菜单只传数字，没有把已显示的选择绑定到 Index revision。

最小修复：交互选择立即解析为“当前 Index 引用 + worklineId”，在该版本上深读。非交互编号应先对已发布列表解析；如果要刷新，需要先展示新列表或让调用者提供明确版本，不能静默重解释原选择。

### P1：Ctrl-C 后锁永久残留，连只读都不能使用

**已复现真实进程信号：** 启动 CLI 与本地假 Provider，对整个进程组发送 SIGINT，CLI 退出，但空 `writer.lock` 保留；下一次 `--read-only` 报“已有 CLI 正在使用”。

根因：[service.mjs:47](../../src/service.mjs) 用空目录作锁，仅依赖 finally 删除；[cli.mjs](../../src/cli.mjs) 没有信号清理与模型任务取消接入。默认信号退出不会完成异步 finally。锁没有 PID/所有权信息；纯阅读也要求同一把写锁。

最小修复：正常信号中断取消任务并释放自己持有的锁；保存可验证的持有者信息以恢复崩溃残留锁；只读使用原子发布的文件快照，避免争抢整段模型运行的写锁。恢复不能仅靠固定超时强删仍在使用的锁。

### P1/P2：扫描限额让历史日和指定项目看起来没有会话

**两个已复现反例：**

- 磁盘存在目标历史日的一条会话，加入 90 条较新日期文件，查询历史日返回 0。
- 指定项目存在一条会话，同日其他项目有 48 条较新会话，`--project target` 返回 0。

历史日根因：[agent-sessions.ts:410](../../backend/upstream/src/agent-sessions.ts) 逆序遍历先消耗候选预算，之后读取正文才判定目标日；为跨日持续写入扩大了候选窗口，较新无关文件能耗尽名额。

项目根因：scanner 的全局文件/Session 截断先发生，[service.mjs:36](../../src/service.mjs) 再筛选项目。CLI 沿用默认 90 文件、900 目录项、深度 4、48 Sessions；App 显式传入的发现预算是 180/2400/5，因此“同一份后端源码”不保证大型语料纳入范围相同。

CLI 会展示 `evidenceCoverage` 的截断提示，这一点比 App 对应旧展示路径更好；不能说它静默宣称扫描完整。但目标数据仍未返回，且当前命令没有扫描预算参数。

最小修复：优先目标日期目录，并为跨日补查留独立预算；在真正应用项目 Session 容量前完成项目与家族筛选。不能简单依赖当天 mtime，否则会漏掉跨日续写的记录。单纯把 48/90 调大只推迟同一问题。

### P2：证据已不存在，脚本仍收到成功退出码

**已复现：** 已生成 Index 后删除唯一源文件，`--read-only --format json` 返回 `mode: stale`、缺少 Session 的 diagnostic，但进程退出码为 **0**。

根因：[cli.mjs:95](../../src/cli.mjs) 只判断 warnings、failed/truncated 扫描项和旧 Index coverage，未判断当前 stale/missing evidence。这不代表输出完全隐藏异常，JSON 与文本有状态；但与 README 的“覆盖不完整退出 2”约定不一致，管道容易继续消费过期结果。

修复：明确 stale 的退出语义，区分可读历史快照与当前证据覆盖；缺失证据至少进入非零部分成功状态。只读历史内容本身应继续可用。

## 3. 输入边界和默认体验的额外限制

**目标日与跨日背景没有明确分栏。** 已复现查询 8 月 29 日，Digest 同时收到该 Session 的 8 月 30 日独有消息，仍是 coverage complete。scanner 用目标日活动决定是否纳入，但冻结和解析的是整个文件；Session 的时间、标题、状态也可能来自后续进展。输入有 logicalDate 和消息时间戳，因此不能据此断言真实模型一定写错日期；问题是“当日事件/此前背景/后续变化”的区分依赖模型自行完成。日简报应明确这些范围并对生成日期归属做校验，尤其避免历史简报因后续进展而改写当天事实。

**默认 all 不等于自动使用已安装的 Provider。** provider plan 对纯 Claude 语料仍选 Codex synthesis；对 Codex 用户，默认 all 的深读 critique 则会选 Claude。无参数交互菜单无法选择 source。README 对显式命令已给单 Provider 指南，所以属于默认交互体验缺口，而非 `--source claude` 本身失效。最小处理是在入口确定可用 Provider/明确选择并持久化，再调用既有 plan；不要增加第三套模型配置。

**事件事实可能在摘要前已丢失。** 阅读器主要提取用户/助手文本，工具调用及输出不作为完整工作事实进入 Digest。测试失败输出、提交结果等若没有被对话文字复述，不能靠后面再加一次“事件提取”恢复。也不宜直接把全部工具日志送模型；应按产品要表达的完成/失败状态保留相关来源片段。本次没有用真实语料量化遗漏率。

**来源精度仍是 Session 字节范围。** CLI 输出来源路径与冻结范围，没有原文查看命令或 message/span 引用。这是 V1 明示能力边界，不能将 App 子证据点击失败直接归类为 CLI 按钮缺陷；不过用户核实具体结论仍要手工找消息。

## 4. 性能与复杂度：先减少重复工作

1. **只读也先扫描。** [service.mjs:33](../../src/service.mjs) 在加载资产和拿锁之前扫描；交互进入每条深读会重新运行 brief。扫描是串行逐候选整文件读取，随后生成输入再次读取冻结内容。`--read-only` 保证不调模型，不保证只读缓存。优先把“阅读已发布结果”和“检查新证据”分开；若保留自动新鲜度检查，应明确成本并复用当次扫描。
2. **成功 Digest 没有跨 Index 版本缓存。** 探针确认未变普通重开新增 0 次调用；显式 refresh 新增 2 次（一个 Digest + synthesis）。显式 refresh 重算本身符合文档，不单列为缺陷；性能问题是自动证据变化也重新处理全部家族，而非只处理变化者。缓存身份必须包含冻结来源、日期范围、模型和编辑契约等，不可只用 mtime。
3. **进度写入反复携带整个资产库。** runtime 的 `persistProgress` 调用仓库 mutate，进行 clone、normalize/验证、完整 JSON 原子替换；成本随历史 Index/Dossier 增长。单家族普通成功路径按调用路径为 7 次资产 mutation，另有 SQLite checkpoint 写入。本次未测生产规模耗时，不沿用 Electron 的目录广播成本。先分离小运行状态与不可变内容，继续用已有 SQLite/原子存储能力。
4. **三轮深读先补证据，再决定是否收缩。** 缺原文的 critique 不能仅靠多调模型变可靠。修好输入后比较单轮与三轮的事实支持、遗漏率、耗时和调用量；没有比较结果前不声称任一方案更好。

不建议重写 CLI 框架、替换 LangGraph、增加 embedding/向量数据库或事件微服务。当前 CLI 层只有参数、service、presentation 三个主要文件，薄层设计值得保留。Zod 边界校验、哈希/冻结范围、版本发布 CAS、原子替换和恢复机制都有职责；存在接缝缺陷不意味着这些机制该删除。未做删除后的兼容验证，不提供虚构的可删行数/依赖数量。

## 5. 最小收敛路线与验收

| 顺序 | 改什么 | 完成标准 |
| --- | --- | --- |
| 1 | 失败重试、输入预算、信号锁、编号绑定 | 对应反例变为成功恢复/不超限/可重开/选中原工作线 |
| 2 | 冻结原文进入深读、真实验证状态、扫描与项目范围、退出码 | 源不可读时不冒充证据通过；范围内会话可发现；脚本可靠识别缺口 |
| 3 | 区分当日事实与背景；Digest 中保留可引用的工作事实 | “后天发生的事”不能被当作当日进展；每个事实可定位到片段；子 Agent 证据仍归属主家族 |
| 4 | 复用未变 Digest、减少全库进度写入、评估深读轮数 | 用真实样本记录调用量、耗时、事实支持与遗漏；没有质量回退后再迁移 |

推荐目标为“冻结来源 → 带范围的事实与摘要 → 工作线 → 按需深读”。事件可以是 Digest 输出中的可复用结构，而不必独立增加一轮模型。所谓精选应有明确的用户价值标准与保留理由；所谓聚簇应消费带来源的事实并允许保留未归属项，不能仅靠增加阶段名字证明质量。

按 CONTRIBUTING 的后端单源规则，共享问题应修 App 源码并同步快照，随后同时验证两个消费者；锁、CLI 选择和退出码问题则修本仓库客户端。

## 6. 实际验证与复现

- `npm run check`：构建、类型检查、CLI 语法检查及 **46 项测试通过**，包含发布包离线安装。
- 后端 parity：49 个文件与本地 App 逐字节一致。
- 审查探针：**12 项通过，表示成功观测到对应缺陷/限制**。包括临时目录 JSONL、确定性假 Provider、实际子进程 SIGINT、实际 CLI 退出码。
- 未调用真实 Provider、未读取私人会话做评估、未做生产负载基准或发布、未修改产品代码。无法据此给出真实摘要质量分数或模型优劣判断。

```sh
npm run build
node --import tsx --test docs/audits/full-chain-2026-09-06.probes.mjs
```

探针会清理自己创建的临时目录与进程。结果见 [evidence JSON](./full-chain-2026-09-06.evidence.json)，代码见 [probes](./full-chain-2026-09-06.probes.mjs)。
