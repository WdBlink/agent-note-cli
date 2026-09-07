# 会话直达 · 开发测试版

阅读工作总结时，想法应能回到提供证据的原会话。直达的对象是经过来源校验的会话身份，不是总结标题，也不是由模型生成的一条命令。

## 阅读与选择

| 位置 | 展示 | 操作 |
| --- | --- | --- |
| 工作线、深读 | 标题下展示来源会话及 Provider，底部保留直达键 | `o`：一个来源直接定位，多个来源先选择 |
| 来源列表 | 会话标题取代 JSONL 文件名；右侧保留原始路径和证据范围 | `Enter` 读原文，`o` 直达选中会话 |
| 原文阅读 | 会话标题与 ID；子 Agent 标明返回所属主会话 | `o` 直达，返回后保留滚动位置 |
| 多会话选择 | 标题、Provider、窗口定位结果；预览包含完整 ID 与项目路径 | ↑↓ / 搜索选择，Enter 直达，Esc 返回 |

同一会话在多个窗口中出现时，再选择具体窗口。单一目标不增加确认页。搜索状态中的字母 `o` 只作为搜索内容，Ctrl-O 不触发跳转。首页不新增会话管理面板，来源信息跟随正在阅读的内容出现。

直达成功只在原阅读页留下提示，不弹出成功对话框。它不刷新总结、不滚回文首，也不自动把想法发送给模型。用户在目标窗口继续输入。

## 会话身份与运行状态

来源匹配使用 Provider、canonical path 和来源中保存的 Session ID。模型给出的同名标题、工作线序号和摘要“进行中”不能用作定位依据。子 Agent 记录沿现有家族关系回到同一 Provider 的主会话；找不到主会话时不猜测。

| 能力 | 本版实现与边界 |
| --- | --- |
| Codex app | 用已有本地 ID 的 `codex://threads/<id>` 链接定位；不使用 new、fork 或 prompt 参数。已知 app 持有该会话时可直接定位。只有 app 正在运行、且没有无法定位的 Codex CLI/后台进程时，才允许通过 app 打开尚未匹配到窗口的原 ID。 |
| Otty | 读取原生 CLI 的窗格清单，按 `agent` + `agent_session_id` 精确匹配，聚焦原 pane ID。不会向窗格注入命令。 |
| iTerm2 / Terminal | 通过对应会话进程的 TTY 和父进程链定位原窗口、标签及分屏。macOS Automation 拒绝时显示错误。 |
| tmux | 在 Agent Note 所在 server 按精确 TTY 匹配 pane，再选择原 session、window、pane；不创建新的 pane 或 Agent。其他 server、外部终端中的 tmux 客户端不自动接管。 |
| Claude 空闲会话 | transcript 在两次写入之间可能关闭；读取 provider 的 PID registry，并校验进程启动时间，防止旧 PID 被重用。旧版本或读取失败不能被判定为“已关闭”。 |
| 不支持或无法确认 | 显示窗口未定位/状态读取失败，并保留阅读页。本版不执行 CLI resume。关闭的 Claude CLI、Copilot、未接入终端及远程主机暂不直达。 |

窗口清单只在用户发起直达时读取；选择之后再核验一次身份及目标。窗口消失、pane 被复用、权限拒绝或取消时不改走另一个会话。源码中没有创建或恢复 Provider 进程的分支。

这是第一版的明确边界：先保证已有会话可以被复用。要支持恢复已关闭的 CLI，需要 provider 能提供可靠的占用/恢复协调能力；进程扫描没有找到目标，并不足以证明恢复不会产生第二个写入者。

## 依据与验证

- [Codex app 现有会话深链](https://learn.chatgpt.com/docs/reference/commands#chats)：本地技术 ID 的线程入口。
- [Claude Code 会话文档](https://code.claude.com/docs/en/sessions)：同一会话在两个终端恢复，会交错写入同一 transcript。
- [Otty CLI](https://docs.otty.sh/reference/cli)：列出和聚焦指定窗格，选择器匹配失败不会改用当前窗格。
- [iTerm2 脚本接口](https://iterm2.com/documentation-scripting.html)：TTY、session、tab 和 window 的精确选择。

自动检查覆盖真实来源绑定、多 Provider 同名/同 ID、子 Agent 归属、重复窗口选择、PID 重用、窗格消失、取消、命令失败、只聚焦而不启动 Provider，以及选择和阅读位置保持。PTY 检查验证原文页 `o` 入口、拒绝未校验 ID 后返回原文、终端恢复。开发验证不发送真实模型消息。
