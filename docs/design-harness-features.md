# harness 能力面调研与集成设计（2026-09-06）

> 配套文档：`docs/design-harness-plugins.md`（§1 codex 缺口矩阵 / §2 harness 抽象层 / §3 插件模型）。那份定**结构**（HarnessDescriptor、ACP、贡献点），这份定**内容**：四个 harness 各自长出来的能力，哪些是同一件事、落在哪一行 caps、由哪个测试守住。本文自足，读者不需要看过原始调研。
>
> 基准版本：Claude Code **2.1.257**（本机原生二进制）· Codex **0.153.4**（app-server v2：ClientRequest 155 方法 / ServerRequest 11 方法 / 369 个 v2 schema）· OpenCode **1.18.29** · Gemini CLI **0.33.2**（本机实测）· VibeSpace **2.369.53**。
>
> **证据规矩（本轮加严）**：① **能 dump 的 schema 不许猜**——codex 全量协议一条命令离线拿到，无登录、零 vendor 调用：`CODEX_HOME=/tmp/codexhome_iso codex app-server generate-json-schema --experimental --out /tmp/codexschema-r2`；② claude 的记录层从二进制取字面量（`strings` 里的 zod `.describe()` 与 enum 数组即协议真相）；③ 每条「VibeSpace 有/没有」指到 `file:line`，否定断言用未截断全仓 grep。上一稿有 **12 条断言**在这三条规矩下被推翻或改写，逐条见 §7。

---

## 0. 结论速览

**一句话**：缺口不是「某个 harness 少一个功能」，而是**几家各自长出了同一类能力，而我们没有承载它的那一行 caps**——回溯 / 结构化提问 / 本轮改动 / 权威回合状态 / 中途改设置。主体因此是**六个抽象**（§3），不是四十条功能。

1. **codex 队列动词的 schema 已经 dump 出来，线上真形状与直觉相反**（§2.1）：`thread/queue/reorder` 收的是**全序 id 数组**（不是锚点、不是索引）；`thread/queue/update` 要求**整包 `input`**，而 `UserInput` 有**七个**变体（text / image / localImage / **audio** / **localAudio** / skill / mention）——按白名单保留就是删附件；`thread/queue/start` 的 `queuedSubmissionId` **可为 null**，即「**现在就把队列跑完**」，是一个独立的用户动作。附带一条自伤：我们的 `refreshQueue()` **丢掉 `nextCursor`**（codex-chat-wrapper.js:1337-1349），在全序数组语义下，分页截断会直接**删掉没读到的队列项**。

2. **三层「未知记录」面包屑只有一层半是通的**（§2.2）。claude 的 `system.subtype` 有面包屑（message-manager.js:509），codex 有（codex-message-manager.js:717）；但 claude 的**顶层 `type` switch（message-manager.js:378-390）没有 `default`**——不过服务端已有一层顶层面包屑（src/server/stdout/claude-stream-json.js:146-150 对不在 CLAUDE_STREAM_TYPES 的 type 发 `cli-unknown-stream-type`），真正无声的是被列为「已知」的 `stream_event`（server.js:408）——它既不渲染也不留痕；此外`compact_progress`、`set_in_progress_tool_use_ids`、`tombstone`、`prompt_suggestion`、`conversation_reset` 等十余种顶层记录整层无声蒸发；ACP 的 `_processUpdate` default 是静默 `return`（acp-message-manager.js:529）。这是本仓库付过两次学费的「隐形记录」类（2.227.5 model_refusal、2.284.2 api_retry），也是全表性价比最高的一批。

3. **权威回合状态要一个开关才存在**。`system.subtype:'session_state_changed'`（`idle|running|requires_action`，describe 原话「authoritative turn-over signal」）在 2.1.257 里由 `if(a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) mu({type:"system",subtype:"session_state_changed",state:e})` 发出——**不设这个 env 就永远收不到**。只写消费分支等于写死代码（§2.5）。同族还有 `set_in_progress_tool_use_ids`（describe：「Surfaces use this to show which tools are running」），是工具粒度的转圈真相。

4. **今天就在生产里错着的四件事**，与新功能无关，应当先发：`personality:'pragmatic'` 硬编码两处静默盖掉用户 `~/.codex` 的选择（§2.4）；ServerRequest 回复**只有一个方法按名分发**，兜底 `{decision}` 形状对 11 个方法里的 **4 个**成立、对 **6 个**是错的（§2.7）；`imageGeneration` 在 live wrapper 里没有分支，重新 attach 才冒出来（§2.3）；review 与 fork 两条已上的路仍按 backend id 门控，而客户端 caps 早就有那一行（§2.13）。

5. **一个大方向决策**：codex `thread/start.dynamicTools`、ACP `session/new.mcpServers`（今天硬写 `[]`，acp-wrapper.js:705）、gemini 的 IDE companion 规范指向同一件事——**VibeSpace 成为工具提供方**，把 vibespace-* 从「PATH shim + 环境里的 session token」换成带类型带鉴权的工具通道（§3.7，决策 4）。注意：它**不能**让 2.369.17 的 codex loopback 洞退休（那个洞同时管终端模式与远程主机上的 AGENT_TOOLS），洞按舰队条件退役。

---

## 1. 能力 × harness 矩阵

图例：`原生` = harness 自己就有 · `via X` = 要经某条通道 · `—` = 没有 · VibeSpace 列：**已上** / **部分** / **缺**。

### 1.1 输入与回合控制

| 能力 | Claude Code 2.1.257 | Codex 0.153.4 | OpenCode 1.18.29 | Gemini 0.33.2 | VibeSpace |
|---|---|---|---|---|---|
| 中途发送=排队 | 原生（CLI 自排，无可读状态） | 原生 `thread/queue/add` | via wrapper promptQueue | 原生（TUI） | **已上** `inputModes.queue` |
| 中途注入=steer | — | 原生 `turn/steer`（一 turn 可多次，**不出队**） | —（ACP v1 无此动词） | 原生（仅 TUI） | **已上**（仅 codex） |
| 队列可枚举 | — | 原生 `thread/queue/list`（**带 cursor/limit + nextCursor**） | via wrapper | — | **部分**（枚举已上，**分页未消费**） |
| 队列重排 / 改写 / 立即执行 / 全部执行 | — | 原生 `reorder`（全序数组）/ `update`（整包 input）/ `start`（id 可 null=drain） | — | — | **缺** → §2.1 |
| 打断整个 turn | 原生 `interrupt` | 原生 `turn/interrupt` | 原生 `session/cancel` | 原生 | **已上** |
| **逐工具**运行集合（转圈真相） | 原生 `set_in_progress_tool_use_ids` | via item 生命周期 | via tool_call_update | — | **缺** → §2.5 |
| 逐工具后台化 / 单杀 | 原生 `background_tasks{tool_use_id}` / `stop_task` | via 后台终端 | — | — | **缺** → §2.14 |
| 权威回合状态 idle/running/**requires_action** | 原生 `session_state_changed`（**env `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 门控**） | 原生 turn/started+completed | via ACP stop reason | — | **缺** → §2.5 |
| 压缩进度 | 原生 `compact_progress`（hooks_start / compact_start{hint_text} / compact_end） | via context_compacted | — | — | **缺**（今天是一句硬编码致歉文案）→ §2.11 |
| 中途改设置（下一 turn） | 原生 `apply_flag_settings` | 原生 `thread/settings/update`（12 字段） | via ACP `set_config_option` | — | **部分** |
| 改**正在跑的** turn | — | 原生 `turn/settings/update`（model/effort/serviceTier/summary/approvalsReviewer） | — | — | **缺** → §2.14 |
| stdin 送达确认 | `--replay-user-messages`（**未验证**：其依赖的 `--input-format` help 自称 print-only） | via `_stdin_ack`（三个 wrapper 都发：chat-wrapper.js:373 / codex-chat-wrapper.js:1906 / acp-wrapper.js:761；broken-pty 检测器） | 同左 | — | **已上**（三家；`--replay-user-messages` 不需要）|

### 1.2 历史、记录与内容

| 能力 | Claude Code | Codex | OpenCode | Gemini | VibeSpace |
|---|---|---|---|---|---|
| 对话回溯 | 原生 `rewind_conversation` + `/branch` | 原生 `thread/rollback{numTurns}` / `thread/revert{beforeTurnId}` | 原生 `POST /revert{messageID}` | 原生 `/rewind` | **缺** → §3.2 |
| 文件回滚 | 原生 `rewind_files` + `enableFileCheckpointing` | — | 原生（snapshot 支撑） | 原生（影子 git repo） | **缺** → §3.2 |
| 重做 / unrevert | via 消息选择器 | — | 原生 `unrevert` | 原生 | **缺** |
| fork | 原生 `--fork-session` | 原生 `thread/fork` | 原生 `POST /fork`（运行时验证） | —（0.33.2 只有 `-r/--resume`、`--list-sessions`，无 `--session-id`） | **已上**（三家，但按 backend id 门控）→ §2.13 |
| **消息被撤回** | 原生 `tombstone`（「Consumers that render or persist the stream should remove the referenced message」） | — | 原生 SSE `message.removed` | — | **缺**（我们既渲染又持久化）→ §2.10 |
| 本轮改动 diff | —（Edit 卡拼）；但有 `vcs_state_changed{kind,cwd}` + `code_change_published{provider}` | 原生 `turn/diff/updated` **推送** | 原生 `GET /session/:id/diff?messageID` | — | **缺** → §2.8 / §3.4 |
| 结构化提问 | 原生 AskUserQuestion + `request_user_dialog` + hooks `Elicitation`/`ElicitationResult` | 原生 `item/tool/requestUserInput` + `mcpServer/elicitation/request` + **`thread/{increment,decrement}_elicitation`** | 原生 `question` 工具；回答口在 HTTP `/question/{id}/reply|reject`，**`opencode acp --port` 自带该 HTTP** | 原生 `ask_user` | **部分/错** → §2.7 / §3.3 |
| 命令列表中途变更 | 原生 `commands_changed`（「Clients should REPLACE their cached command list」） | via thread settings | 原生 `available_commands_update` | — | **部分**（ACP 侧已上 acp-message-manager.js:503，claude 侧缺）→ §2.6 |
| 子代理 / 子会话 | 原生 Task + 独立转录 + `/subtask` | 原生 collab（effort=ultra） | 原生 `GET /children` | 原生 `.md` 子代理 | **部分**（opencode 未接）→ §2.9 |
| Web 搜索卡 | 原生 WebSearch/WebFetch | 原生 `webSearch` | via websearch 工具 | 原生 | **已上**（src/search-card.js） |
| 图片生成 | — | 原生 `imageGeneration` | — | — | **部分**（rollout 有、live 无）→ §2.3 |
| sleep / 等待 | — | 原生 `clock.sleep`（SleepThreadItem） | — | — | **缺** → §2.3 |
| agent→user 的一等通道 | 原生 **SendUserMessage / SendUserFile**（`--brief` 开启） | via 我们的 CLI shim | — | — | **缺**（我们手搓了两遍：vibespace-ask、published pages）→ §2.12 |
| 逐消息 token/model | via transcript requestId | 原生 token_count | 原生 Session.tokens/cost（`opencode stats`） | 原生 JSONL tokens | **部分**（opencode 无账本） |
| 每 turn 摘要 / 时长 | 原生 `post_turn_summary` / `turn_duration` / `task_summary` | — | — | — | **缺**（自家分类器代劳） |
| 记忆路径权威来源 | 原生 init 帧 `memory_paths{auto,team}` | ~/.codex/memories | — | 原生 auto-memory | **部分**（硬编码正则 agent-meta.js:20）→ §2.6 |
| 记忆事件 / 引用 | 原生 `memory_saved` / `memory_recall` | 原生 `memoryCitation` | — | 原生 | **缺** |

### 1.3 管理、生态与传输

| 能力 | Claude Code | Codex | OpenCode | Gemini | VibeSpace |
|---|---|---|---|---|---|
| 模型目录（协议来源） | 原生 `list_models`（含禁用行+原因） | 原生 `model/list` | via ACP config option | via models.dev | **部分**（基线+被动学习） |
| 服务档位 / fast | 原生 `/fast`（含冷却态） | 原生 `serviceTier`（thread 与 turn 两级） | — | — | **缺** |
| 响应风格 | 原生 outputStyle（**仅 spawn**） | 原生 personality（**可中途改**） | via agent | — | **部分**（codex 侧静默覆盖）→ §2.4 |
| 计划模式 | 原生 permission mode `plan` | 原生 `collaborationMode{mode:'plan'}` | 原生 agent `plan` | 原生 | **部分**（codex 无 plan 档） |
| 权限规则面 | 原生 auto-mode config | 原生 permissionProfile + granular（`thread/approveGuardianDeniedAction` 是**我们调用**的申诉 ClientRequest，不是入站请求） | 原生 PermissionRuleset + saved | 原生 TOML 策略引擎 | **缺**（只有四档模式） |
| hooks 事件数 | **33**（二进制最宽 enum：PreToolUse…PostToolBatch/StopFailure/**Elicitation**/**ElicitationResult**/**MessageDisplay**/ConfigChange/InstructionsLoaded/CwdChanged/FileChanged/DirectoryAdded/WorktreeCreate/WorktreeRemove/TaskCreated/TaskCompleted/TeammateIdle…） | 12 | 插件事件 | 11 | **部分**（只用 3 个做注入） |
| skills | 原生（init 帧 `skills[]`、`/skill-doctor`） | 原生（`{type:'skill'}` 输入项、`skills/extraRoots/set`） | 原生（读 ~/.claude/skills） | 原生 | **部分**（只当 slash 名） |
| 插件 / 市场 | 原生（init 帧 `plugins[]` + `plugin_errors[]`） | 原生 | 原生（进程内 JS） | 原生扩展 | **自有一套**（不互通，§4） |
| host 作为工具提供方 | via MCP | 原生 `dynamicTools`（ServerRequest `item/tool/call` 回调） | via ACP `mcpServers`（今天硬写 `[]`） | 原生 IDE companion 规范 | **缺** → §3.7 |
| 会话命名回写 | 原生 `rename_session` | 原生 `thread/name/set` | 原生 | — | **已上**（codex；ws-handler.js:677-679 + wrapper:1732，**按 backend id 门控**）→ §2.13 |
| 服务端归档/删除 | via `claude rm` | 原生 `thread/archive` / `unarchive` / `delete` | 原生 | 原生 retention | **部分**（本地归档已服务端持久化+多端同步：persistence.js:412/543/546-563；**未推到 harness**） |
| 服务端列表 / 全文搜索 | — | 原生 `thread/list` + `search` + `searchOccurrences` | 原生 REST | — | **部分**（文件遍历） |
| 协议级转录分页 | — | 原生 `thread/items/list` / `turns/list` / `timeline/list`（cursor+limit+sortDirection） | 原生 REST | — | **缺**（我们整套大转录故事是文件式的）→ §2.14 |
| 推送式发现（SSE/事件） | — | notifications | 原生 SSE（可重放） | — | **缺** → §2.14 |
| 每会话 worktree | 原生 `-w` | — | 原生 sandbox worktree | 原生 `-w` | **缺**（决策 9） |
| 临时 / 不落盘会话 | 原生 `--no-session-persistence` | 原生 `ephemeral` | — | — | **缺** |
| 提示缓存杠杆 | 原生 `--system-prompt-snapshot` / `--exclude-dynamic-system-prompt-sections` / `--autocompact` | — | — | — | **缺**（决策 8） |
| 零成本本地 oracle | `agents --json` / `auth status` | `doctor --json` | `/global/health`、`opencode stats` | `debug *` | **缺**（决策 6） |
| 分享对话 / 上传 | via /bug | 原生 feedback/upload | 原生 opncd.ai 分享 | — | **拒**（§4，决策 7） |
| 远程 agent 传输 | Remote Control | 原生 app-server `ws://` | 原生 `attach <url>` + mDNS | — | **拒**（走机器句柄，§4） |

---

## 2. 逐项集成设计（按现有接缝）

固定格式：**现状**（证据）→ **接缝**（caps 行 / descriptor 钩子 / adapter 动词 / normalizer 记录 / 贡献点）→ **门**（gate 套件）→ **尺寸**。

### 2.0 批次

| 批 | 内容 | 依赖 |
|---|---|---|
| **B1 诚实性 + 孪生**（全 S） | §2.2 三层面包屑 · §2.3 item 联合体普查 · §2.4 personality · §2.10 tombstone · §2.13 caps 门收口 | 无 |
| **B2 队列动词**（✅ 2026-09-07） | §2.1 全套 | 无（schema 已 dump） |
| **B3 回合真相**（S+M） | §2.5 turnState + 逐工具集合 · §2.11 compact_progress · §2.6 init 帧加宽 + commands_changed · §2.7 ServerRequest 分发 | 无 |
| **B4 抽象落地**（M–L） | §3.2 checkpoints（先 conversation）· §3.3 questions · §2.8 changes · §2.9 opencode acp --port | B3（turnState 是 checkpoints 的前置） |
| **B5 生态**（M–L，各带决策） | §2.12 用户通道工具 · §2.14 速记表各项 · §3.7 工具通道 · gemini · worktree | 各自独立 |

### 2.1 codex 队列动词 reorder / edit / run-now / run-all —— ✅ 已落地 2026-09-07（owner 决策 (a)）

> **状态（2026-09-07 实装）**：七动词表 `queueVerbs` 落在 backend-caps（旧的 `{steer,queueOps}` 布尔降为派生视图，客户端镜像用同一个 `deriveInputModes`）；ws 帧走相对语义并按动词表 + 运行中 wrapper 的动词广告双重门控；codex wrapper 里 `listQueueAll()`（翻完 `nextCursor`）/ `reorderedIds()` / `replaceQueuedText()` 三个纯函数把相对意图翻成 RPC 的绝对形状；ACP wrapper 也上了 `reorder`/`edit`（本地数组三个 splice），但 `run-now`/`run-all` 按**结构性理由**声明为 false——那条队列只在 prompt 运行期间存在，"现在就跑"只能永远答 busy。门：test-queue-steer 274（含真 0.153.4 app-server 腿 + 真浏览器 trusted 指针拖拽腿）/ test-codex-p2-wrapper 220（分页 stub + 背着 wrapper 注入的条目）/ test-acp-harness 114。
>
> **本轮实测把设计里两条断言改写了（证据优先）**：
> ① 「分页截断 + 全序替换 = **静默删项**」**不成立**——0.153.4 对不完整的全序数组回 `-32600 queue reorder must include every queued submission exactly once`，是**大声拒收**而不是静默删除。翻完分页仍然是硬性纪律，但理由变成「不翻完这个动词根本不工作」，而不是「会丢数据」。分页本身也确实是真的：`limit:1` 实测回 `nextCursor:"1"`，游标可继续。
> ② 队列动词需要 `initialize` 带 `capabilities.experimentalApi`（wrapper 一直带着；不带则每个 queue 方法回 "requires experimentalApi capability"）。另外实测到一条影响 run-now/run-all 价值判断的事实：**空闲线程上的 `thread/queue/add` 会被 app-server 立刻 drain 成一个 turn**，所以「空闲且队列非空」基本只出现在**恢复(resume)回来的线程**上——这正是这两个动词真正有用的场景，忙时一律明确拒绝。
> 验证成本为零的做法（本轮用的）：一次性 `CODEX_HOME` + **未登录**跑真 app-server——队列动词是服务端簿记，不需要 API；app-server 自己 drain 出来的那个 turn 因 401 立刻死掉，零 token。测试腿自己断言从未发出 `turn/start` / `thread/queue/start`。


**现状**。wrapper 今天用 `thread/queue/{add,list,delete}` + `turn/steer`（codex-chat-wrapper.js:1259-1272 有实测 census；:1390 steer 成功后自己 delete，因为 steer **不出队**）。ws 门在 ws-handler.js:552-583，adapter 三份 `formatQueueOp`（codex.js:1059 / claude-code.js:298 / acp.js:86），客户端 strip 在 chat-input.js:741 `queueStripHtml`（PURE、DOM-free 可测）。

**线上真形状（本轮 dump，非推测）**：

```
thread/queue/add     {threadId, input:[UserInput], clientUserMessageId}  → {queuedSubmission}
thread/queue/list    {threadId, cursor?, limit?}                        → {data:[QueuedSubmission], nextCursor:string|null}
thread/queue/delete  {threadId, queuedSubmissionId}                     → {deleted:boolean}
thread/queue/update  {threadId, queuedSubmissionId, input:[UserInput]}  → {queuedSubmission}     // input 是 required
thread/queue/reorder {threadId, queuedSubmissionIds:[string]}           → {}                     // 全序数组，二者皆 required
thread/queue/start   {threadId, queuedSubmissionId?:string|null}        → {turn}                 // 只有 threadId 是 required
notification thread/queue/changed {threadId}
QueuedSubmission = {id, clientUserMessageId, input:[UserInput]}
UserInput = text{text,text_elements[]} | image{url,detail?} | localImage{path,detail?}
          | audio{url} | localAudio{path} | skill{name,path} | mention{name,path}
```

**为什么不能再加布尔**。`inputModes` 今天是 `{queue, steer, queueOps}` 三个布尔（backend-caps.js:67/82/88/103），被五处消费（accounts.js:22、ws-create.js:11、ws-handler.js:13、server/conversation-deliver.js:20 + 客户端镜像 agent-meta.js；daemon bundle 不含它；**scripts/test-queue-steer.mjs:61-65 按 JSON.stringify 精确比对服务端行与客户端镜像**，加字段两边同批）：ws 门、三份 `formatQueueOp`、客户端 META 镜像（agent-meta.js:29/72/100）、strip 渲染、daemon bundle、test-queue-steer 的一致性断言。加一个动词动六处。

**设计：显式动词表**（`QUEUE_VERBS` 从 backend-caps 导出为封闭集合）

```js
inputModes: {
  queue: true, steer: true, queueOps: true,      // 派生视图，保留给既有门与客户端镜像
  queueVerbs: ['remove','steer','steer-all','reorder','edit','run-now','run-all'],
}
// claude: []（CLI 自己拥有队列，不发布也不接管——诚实的空）
// opencode/ACP: ['remove']
```

不变量（test-queue-steer 钉）：`queueOps === (queueVerbs.length>0)`；`steer === queueVerbs.includes('steer')`；`queueVerbs ⊆ QUEUE_VERBS`；**每个声明的动词在 adapter 里都有构造分支**（声明了却构造不出来 = 红，这是 accept-and-ignore（2.361.4）在结构上不可能发生的保证）。

**ws 帧**（`case 'queue-op'`）：门从 `modes.queueOps && (op!=='steer'||modes.steer)` 改为 `modes.queueVerbs.includes(op)`；拒绝照旧 `code:'queue-op-unsupported'` + `scope:'action'`（inc-mt2arppw：session 级 error 会把活窗口翻成只读）。两道门都保留——harness caps **和**运行中 wrapper 的 sidecar `caps.inputQueue`（server/wrapper-files.js；2.361.1/2.364.1 的版本漂移类）。帧扩展：

```js
{ type:'queue-op', sessionId, op, id, afterId?, text? }
```

**推荐 UI 语义（owner 确认，决策 1）**——ws 帧走**相对语义**，RPC 的**绝对形状在 wrapper 里合成**，两层不共用词汇：

- **拖拽重排 = 相对 `afterId`，wrapper 翻成全序数组**。`{op:'reorder', id, afterId}`，`afterId===null` = 移到队首。选相对锚点不是因为 wire 长这样（它不长这样），而是因为**这条队列不是用户独占的**：`kind:'peer'` 是 agent 互聊 / jobs 消息走同一条 `rpc-queue` 通道（backend-caps peerDelivery）。索引会被并发插入错位，锚点消失时自然退化成已有的 `reason:'gone'`。
  - **全序数组的两条纪律**：① wrapper **必须先 list 到底**（跟 `nextCursor` 翻完），今天的 `refreshQueue()` 丢掉了它——分页截断 + 全序替换 = 静默删项；② **发送前立刻重新 list 并归并未知 id**（peer 通道可能在渲染与落点之间 `queue/add` 了一条），未知 id 按服务端顺序补回队尾，绝不发陈旧数组。这两条是本动词的真实危险，不是索引错位。
- **编辑 = 按排除法保留，不按白名单**。`{op:'edit', id, text}`：wrapper 从**新鲜的 list** 取该项原 `input`，逐元素重建——**除被替换的那个 text 元素外，一切原位保留**（image/localImage/**audio**/**localAudio**/skill/mention 都不认识也不动）。第一个 `text` 元素换成新文本并**清空它自己的 `text_elements`**（那些 `byteRange` 是旧文本缓冲区的偏移，留着就是错的），其余 text 元素删除；原本没有 text 元素就在**索引 0** 插入一个（与我们自己的 `encodeUserInput` 同形，codex-chat-wrapper.js:125-127：text 在前、附件在后）。天真实现 `input=[{type:'text',text}]` 会销毁附件——正是 `queuePreview` 里 `[image]`/`[skill …]`/`[@…]` 在提示的东西。
- **peer 项不可编辑**，重排 / 删除可以。改写另一个 agent 说的话 = 错误归属。adapter 拿不到 kind，所以门在 wrapper（有 `queueMeta.get(cid).kind`）+ 客户端（`it.kind==='peer'` 不渲染 ✎），两边都要，理由说人话。
- **run-now 在忙时明确拒绝**。`{op:'run-now', id}` → `thread/queue/start{threadId, queuedSubmissionId:id}`。有活跃 turn 时回 `reason:'busy'` 并说明「当前 turn 结束后它本来就会跑」，**不排队等待**（accept-and-ignore 的变体）。
- **`run-all` 是独立动词，不是 run-now 的空参数版**。`thread/queue/start` 省略 `queuedSubmissionId` = 「现在就把队列跑完」。这必须是 strip 头部一个**显式**的「立即全部执行」控件，且 `formatQueueOp` 对 `run-now` **强制要求 id**（缺 id 抛错），否则一次 id 丢失就会意外 drain 整个队列。

**normalizer**。`queue_op_result` 形状不变，reason 枚举加 `busy` / `not-editable` / `anchor-gone` / `stale-order`。`queue_changed` 照旧驱动整条 strip 重渲染（`refreshQueue()` 的单飞+合并已处理连发）。

**客户端**。`queueStripHtml(items, caps)` 按 `caps.queueVerbs` 加控件：拖拽把手（reorder）、编辑（edit，peer 不出）、立即运行（run-now）、头部「立即全部执行」（run-all）——控件图标一律走 icons.js 的 SVG（今天的 queue/bolt/close 就是 UI_ICONS，chat-input.js:741-754），**不用 ✎/▶ 文字符号**。**拖拽用 per-drag AbortController**（listener lifecycle 法律：per-render 的 controller 会在拖到一半时把自己拆掉）。`_sendQueueOp(op,id)` 扩成 `(op,id,extra)`。文案 zh+ja。

**门**：`test-queue-steer` 新增第⑧组（动词表一致性 / 每动词拒绝理由 / 按动词表出控件 / peer 无编辑控件 / run-now 缺 id 抛错）；`test-codex-p2-wrapper` 加「edit 保留 audio+localAudio+skill 并清 text_elements」「reorder 前必须翻完分页」「重排前重新 list 归并未知 id」「run-all 与 run-now 不同帧」四行；第⑥档**真 app-server** 钉参数名与响应形状（该档已存在，无二进制/未登录按证据 SKIP）。**尺寸 M。**

### 2.2 三层「未知记录」面包屑 —— S，全表性价比最高

**现状**（三处不同病）：
- claude **顶层 type** `switch(raw.type)`（message-manager.js:378-390）**没有 `default`**。二进制里的顶层记录类型至少有：`compact_progress`、`set_in_progress_tool_use_ids`、`tombstone`、`prompt_suggestion`、`conversation_reset`、`stream_mode`、`command_lifecycle`、`transcript_mirror`、`active_goal`、`hint_clears`、`api_metrics`、`os_notification`、`open_message_selector`、`refusal_continuation`、`query_model_change`、`keep_alive`、`stream_event`——**全仓 grep 全部为 0**。这一层没有任何信号。
- claude **system.subtype** 有面包屑（:509 `cli-unknown-system-subtype`），`HANDLED_SYSTEM_SUBTYPES`（:19）9 条，而二进制里 subtype 共 **45** 种——这一层是健康的（未知会在 Diagnostics 出声），不用改。
- ACP `_processUpdate` 的 `default: return;`（acp-message-manager.js:529）静默。**注意**：上一稿说「plan / current_mode_update / config_option_update / user_message_chunk 会被丢掉」是错的——这四个连同 `available_commands_update`、`usage_update` **都已有 case**（:495/498/505/512/517/521）；OpenCode 1.18.29 二进制里 `sessionUpdate:"…"` 只有 6 种，**全部已覆盖**。真正的缺口是 default 没有面包屑：ACP 规范里还有 `session_info_update` 等变体，上游任何一版新增都会无声消失。

**接缝**：三处各加一次性 `global.__vsEvent?.(...)`——`cli-unknown-record:<type>`（claude 顶层，新 default 分支）、`acp-unknown-update:<kind>`（ACP default）；每进程按名去重，进 Diagnostics。**门**：test-stdout-registry（claude 顶层，喂一条构造的未知 type）+ test-acp-harness（ACP）。**尺寸 S。**

### 2.3 codex `item/completed` 联合体普查（不是「两个孪生」）—— S

**现状**：`imageGeneration` 在 `src/codex-thread-read.js:102` 有映射，live wrapper 的 renderItem 链（codex-chat-wrapper.js:628-880）**没有**；结果是生成的图流式时不可见，重新 attach 读 rollout 才冒出来。`sleep` 两边都丢（codex-thread-read.js:114 的 default 注释写着「hookPrompt, sleep, future kinds: not conversation content」）——于是一个 `clock.sleep 20m` 的会话看起来就是卡死，而这正是 Background Work 的长跑场景。

**上一稿的修法指错了孪生**（本轮纠正）。这条路上有**三个**形状，不是两个：
1. `codex-thread-read.js:103` 的 `{output:'status: <status>'}`（只是「没有 rollout 文件」时的 thread/read 兜底）；
2. **真正在重新 attach 时画卡的**是 `src/codex-message-manager.js:1599-1606`（`Extension` kind `image_gen.generation`），输出 `status: …\nsaved <savedPath>`，3MB base64 从不进卡片——由 `scripts/test-codex-history.mjs:761` 逐字钉住；
3. live wrapper（缺）。

所以 live 分支要**照抄 (2)**，不是 (1)。且 `image_generation_begin/end` 在 `SKIPPED_RECORD_TYPES`（codex-message-manager.js:252）里是**故意**的，live 分支必须骑 `item/completed`。

**做法**：不要按名字补两个分支，而是**对着 `v2/ItemCompletedNotification.json` 的 ThreadItem 联合体做一次普查**——除 imageGeneration / sleep 外还有 `PlanThreadItem`（今天靠 `turn/plan/updated` 通知碰巧覆盖，wrapper:937-946，是运气不是普查结果）、`HookPromptThreadItem`（无人覆盖）、`UserMessageThreadItem`。普查结果落成一张表进 kb。`sleep` 给一行状态（「sleeping 20m…」，理想带倒计时）——这是「卡死」与「在等」的区别。

**门**：test-codex-p2-wrapper（同一条 item 分别走 live 与 rollout，断言两边卡片形状一致，negative control：拆掉任一边即红）+ test-codex-history 的既有钉子不许改。**尺寸 S。**

> 这条是「STANDING SWEEP」的现成案例：`twin-sets = 0` 不是状态，是要重测的指标。改任何一个 renderItem 分支之前，先 grep 它在 codex-thread-read / codex-message-manager / usage-walker / vibespace-usage-scan 里的孪生。

### 2.4 codex personality 停止静默覆盖 —— S（决策 3）

**现状**：`personality:'pragmatic'` 硬写在 `data/bin/codex-chat-wrapper.js:1114`（startThread）与 `:1244`（startTurn）。全仓 grep 确认只有这两处写入端（其余命中是测试 fixture 里的 rollout 记录）。用户在 `~/.codex` 里选的风格，在 VibeSpace 里每次都被盖掉且不出声。

**接缝**：接到 §3.6 `responseStyle`。descriptor 加 `style:{key:'personality', values:['none','friendly','pragmatic'], applyAt:'live'}`（claude 是 `{key:'outputStyle', applyAt:'spawn'}`）。UI 复用 2.368.0 的菜单槽，**文案按 applyAt 变**：codex 不显示「下次恢复生效」（`thread/settings/update` 能中途改）。**不选就不传**。**门**：test-codex-p2-wrapper（不选 = 参数缺席）+ test-auto-resume（已钉 claude 那半）。**尺寸 S。**

### 2.5 权威回合状态 + 逐工具运行集合 —— S

**现状**：`session_state_changed` / `set_in_progress_tool_use_ids` 全仓 0 命中。今天 `_isStreaming` 由 `result` 或 `compact_boundary` 推（server/stdout/claude-stream-json.js:407），attach 到一个已在跑的 CLI 时只能猜——2.339.2 STUCK-THINKING 与 2.369.16 ATTACH STORM 都踩在这个模糊地带。

**两条上游原话**：`session_state_changed{state:'idle'|'running'|'requires_action'}` 的 describe 是「'idle' fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal」；`set_in_progress_tool_use_ids{op:{action:'add'|'remove', ids:[…]}}` 的 describe 是「Surfaces use this to show which tools are running」。

**关键前提（上一稿漏掉，会让实现变成死代码）**：2.1.257 里发这条记录的代码是
`if (a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS) mu({type:"system",subtype:"session_state_changed",state:e})`
——**必须在 spawn 环境里打开这个 env**（`agentEnv()` 是 **DROP 表**（ws-handler.js:88-97：除 AGENT_ENV_DROP/npm_*/未保留的 VIBESPACE_* 外全部透传），所以做法是像 `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`（claude-code.js:85）那样在 spawn env 上 **SET** 它，不碰 AGENT_ENV_KEEP）。这是产品默认值改动，进决策 8。

**接缝**：`HANDLED_SYSTEM_SUBTYPES`（message-manager.js:19）加 `session_state_changed`；claude-stream-json 消费者直驱 `_isStreaming`，attach 时对账；`requires_action` 是我们没有的第三态（今天靠「有没有权限卡」反推）。`set_in_progress_tool_use_ids` 走 §2.2 修好的顶层 default 之后新增的分支，喂工具卡的转圈状态。归 §3.5 `turnState`。**门**：test-stdout-registry + test-attach-rebuild（含 env 缺席时的降级路径：老 CLI / 未开开关 ⇒ 回到推断，不许崩）。**尺寸 S。**

### 2.6 claude init 帧加宽 + `commands_changed` 后续推送 —— M

**现状**：`_processSystem` 的 init 分支只取三个字段（message-manager.js:398：`raw.model` / `raw.permissionMode` / `raw.slash_commands`）。整帧还有 `tools` / `mcp_servers[{name,status}]` / `agents` / `skills` / `plugins[{name,path,source,version}]` / `plugin_errors[{plugin,type,message}]` / `terminal_slash_commands` / `output_style` / `memory_paths{auto,team}` / `betas` / `claude_code_version`。逐个 grep：全 0。

四个即时收益：

1. **`memory_paths` 取代硬编码正则**。`src/lib/agent-meta.js:20` 是 `/\/\.claude\/(?:projects\/[^/]+\/)?memory\//`；上游 `@internal` 原话就是这个字段存在的理由：「Lets SDK renderers classify Read/Write/Edit tool calls on these paths as memory operations without re-implementing CLI path detection」。用户设了自定义 memory 目录，我们的正则就静默失准。老 CLI 保留正则做降级。
2. **`terminal_slash_commands` 从补全里滤掉**。上游原话：「Subset of slash_commands whose UX is bound to the local terminal… Phone/remote UIs should hide these」——单列就是给非终端 host 剔除用的。今天 `/exit` 这类塞进聊天补全，点了没用。
3. **`mcp_servers` + `plugin_errors` 渲染成 init 卡的健康条**。今天一个连不上的 MCP server 在 VibeSpace 里完全隐形——它的工具就是不存在，用户无从知道为什么。
4. **`skills[]` 单独成节 + `output_style` 回显**。`src/adapters/claude-code.js:281-291` 那段「success-blind and nothing echoes back」说的是**中途 effort/ultracode 的 apply_flag_settings 路径**，不是 output_style；init 帧（2.1.257 zod）带 `output_style` 与 `skills[]` 但**不带 effortLevel**——所以 effort 仍无回显，output_style 有回显。

**外加 `commands_changed`**（上一稿只加宽 init，导致整场会话的命令面持续陈旧）：上游原话「Fire-and-forget push of the full slash-command list after a mid-session change (e.g. skills discovered dynamically as the agent works in a subdirectory). Clients should REPLACE their cached command list」。ACP 侧的等价物我们**已经**处理（acp-message-manager.js:505 `available_commands_update`）——这是一个现成的本地/远程孪生漂移。

**接缝**：init 分支保留整帧到 `_status`（已经通过 `initData` 到客户端）→ chat-input 的 `setSlashCommands` 分节 + 支持 REPLACE → chat-renderers 的 init 卡加健康条 → agent-meta 的 `memoryPathRe` 降级为 fallback。**门**：test-stdout-registry（真 init 帧 fixture + 一条 `commands_changed` 后断言列表被整体替换）+ i18n zh/ja。**尺寸 M。**

### 2.7 codex ServerRequest 按 method 分发回复 —— M

**现状**（本轮按 schema 重算，比上一稿严重）：`respondToServerRequest`（codex-chat-wrapper.js:1469+）**只有一个 method 按名匹配**（`item/tool/requestUserInput`，:1476），其余全部落到 `msg.approved` / decline 的兜底，产出 `{decision:…}`（:1486-1497）。`ServerRequest.json` 的 `oneOf` 是 **11 个** method，逐个对响应 schema：

| method | 响应 required | 兜底 `{decision}` |
|---|---|---|
| `item/commandExecution/requestApproval` | `decision` | ✅ |
| `item/fileChange/requestApproval` | `decision` | ✅ |
| `applyPatchApproval` | `decision` | ✅ |
| `execCommandApproval` | `decision` | ✅ |
| `item/permissions/requestApproval` | **`permissions`**（+scope, strictAutoReview） | ❌ |
| `mcpServer/elicitation/request` | **`action`**（accept\|decline\|cancel） | ❌ |
| `currentTime/read` | **`currentTimeAt`** | ❌ |
| `attestation/generate` | **`token`** | ❌ |
| `account/chatgptAuthTokens/refresh` | **`accessToken`, `chatgptAccountId`** | ❌ |
| `item/tool/call` | **`contentItems`, `success`**（§3.7 依赖它） | ❌ |
| `item/tool/requestUserInput` | **`answers`** | 按名处理，但见下 |

即 **4 对 6 错**。用户可见后果：`mcpServer/elicitation/request` 会渲染成一张无标题的 Permission 卡，答了也没用。**另一条本轮新发现**：`ToolRequestUserInputResponse` 的 `required` 只有 `answers`、**没有 `decision`**，而我们的拒绝路径回的是 `{decision:'decline'}`（无 `answers`）——形状是否被服务端容忍属于**必须在真 app-server 上验证**的事，不许从「今天看起来能用」推断。

**接缝**：wrapper 的 `respondToServerRequest` 改成 method → 回复构造器的分发表，**未知 method 响亮拒绝并逐字记日志**（no-silent-failures + 「degrade 路径不能吞掉自己的 bug」：2.276.0 那个 `shq` 引用错误活了 6 个版本，全靠逐字日志才被发现）。normalizer 侧加 `elicitation` 卡种（表单来自 RMCP schema），归 §3.3。`thread/approveGuardianDeniedAction`（申诉流）今天也会渲染成未处理的 Permission 卡，同批纳入。**门**：test-codex-p2-wrapper（stub app-server 发全部 11 种，逐条断言回复形状 + 未知 method 的拒绝可见）+ 第⑥档真 app-server 验 `requestUserInput` 的拒绝形状。**尺寸 M。**

### 2.8 「本轮改动」——三个来源一个落点 —— M

**现状**：codex 的 `turn_diff` 在 `SKIPPED_RECORD_TYPES`（codex-message-manager.js:249）里显式跳过，`patchUpdated` 全仓 0；opencode 有 `GET /session/:id/diff?messageID` 没接；claude **有**两个 VCS 级信号——`system.subtype:'vcs_state_changed'{kind:'commit'|'push'|'merge'|'rebase', cwd}`（describe 明写「New kinds may be added — treat an unrecognized kind exactly like a recognized one」）与 `code_change_published{provider:'github'|…}`，全仓 grep 均为 0。上一稿断言「claude 没有」，不准确：claude 没有 **diff 级**推送，但有 **VCS 级**事实。

**为什么值得**：一个通知处理器换来一份永远正确的「这个 turn 改了什么」，而这是我们对任何 harness 都答不出的问题。渲染器（chat-renderers 的 diff 路径）已经有了；文件浏览器 + Ports 面板能直接吃 VCS 事件。

**接缝**：§3.4 `changes` meta op（统一 unified diff 字符串）+ `vcs` meta op（kind + cwd + provider）→ turn footer 的 diff 芯片 / 「改动」页签，VCS 事件另给一行时间轴标记。**门**：新增 `test-turn-changes`（normalizer + DOM-free 渲染 + push/pull 两条路形状一致 + 未知 vcs kind 按已知处理）。**尺寸 M。**

### 2.9 OpenCode：会话自己的 HTTP 面 —— S/M

**现状**：`src/opencode-serve.js:368 children()` 与 `:370 todo()` 定义齐全、**全仓零调用**（唯一其它命中是 daemon bundle 的副本）。上一稿说 children 「是 v1 路由所以零开销」——**这是从路径形状推成本**，正是 2.369.50 自己禁止的推理：那次 `/proc` 实测的是**四条**路由（`/session`、`/session/:id`、`/session/:id/message`、`/project`，opencode-serve.js:44-52），children 不在其中；而同为 v1 形状的 `POST /session/:id/fork` 就是起 instance 的（:832-835 专门 dispose）。**动工前 `/proc` A/B 实测**。

**更好的一条路（本轮新增）**：`opencode acp --help` 列出 `--port` / `--hostname` / `--mdns` / `--cors` ——**活着的 ACP 进程自己就能开 HTTP 面**。二进制里带 `/session/{sessionID}/question`、`/question/{requestID}/reply`、`/question/{requestID}/reject`。于是：
- §3.3 缺的**回答通道**有了，而且是**这个会话自己的 instance**（它本来就为这个 cwd 起着），不必再起第二个 `opencode serve`；
- children / todo 也在同一个面上，成本增量接近零（仍要实测）。

**todos 还有更省的一条**：ACP normalizer 从 `todowrite` 工具调用的 input 直接合成 todos meta，零 HTTP、对活会话即时（`case 'plan'` 在 acp-message-manager.js:498 已就位，只是 OpenCode 从不发 plan）。

**接缝**：wrapper spawn 加 `--port <freePort>` 并把端口经 sidecar caps 上报（**实测 1.18.29：默认与显式 `--port 0` 都不监听**，0 个 socket fd；只有显式非零端口才起 127.0.0.1 listener 且 /doc、/session、/session/x/question 都 200）（`caps.acpHttp`）→ descriptor `store.questionReply` / `store.children` 走它；能力缺席时按今天的行为明确标为不支持，不假装能答。**门**：test-opencode-serve（/proc A/B + 端口发现 + 回答往返）+ test-acp-harness（todos 合成）。**尺寸 S/M。**

### 2.10 `tombstone`：被撤回的消息 —— S

**现状**：claude 顶层记录 `tombstone`，describe 原话「Emitted when a previously-yielded message is superseded or removed from the transcript (e.g. streaming→non-streaming fallback removes a partial)… Consumers that render or persist the stream should remove the referenced message」。全仓 grep 的 2 处命中是无关散文（agent-routes.js:1174、server/session-stdout.js:5）。**我们既渲染又持久化**（buffer + normalizer + rebuildHistory），所以一个被上游撤回的半截消息会**永远留在转录里**。§4 里我们为 opencode SSE 的 `message.removed` 提过同一危险，却没为 claude 提——而 claude 的记录今天就在流上。

**接缝**：§2.2 修好的顶层 default 之后新增分支 → normalizer 的 `remove` op（已有 create/edit，删除是第三个）→ ChatView 的虚拟滚动要能处理「窗口内一条消失」（与既有 trim 路径共用，不许触发 §2.369.x 那批分页事故）。**门**：test-attach-rebuild（撤回后重建历史不再出现该消息）+ test-chat-trim-guard 的现成守卫。**尺寸 S。**

### 2.11 `compact_progress`：压缩进度 —— S

**现状**：全仓 0。今天 chat-renderers.js:1203 是一句硬编码致歉：「Compacting a large conversation takes 1–2 minutes — do not press Stop」；kb 里还记着一次「/compact 卡在 thinking」事故。上游有 `{type:'compact_progress', event: hooks_start{hook_type} | compact_start{hint_text} | compact_end}`，describe：「Emitted while compaction is running… Distinct from system/compact_boundary」。

**接缝**：顶层新分支 → 现有的流式标签（与 2.284.2 `api_retry` 同一条通道，deliberately card-less）→ 压缩期间显示真实阶段与 `hint_text`，`compact_end` 收尾。硬编码文案降级为「收不到进度时」的兜底。**门**：test-stdout-registry。**尺寸 S。**

### 2.12 claude 的两个用户通道工具 SendUserMessage / SendUserFile —— S/M（决策 8）

**现状**：`claude --help` 有 `--brief  Enable SendUserMessage tool for agent-to-user communication`，二进制里 `SendUserMessage` / `SendUserFile` 都是一等工具名。我们**手搓了这两件事的等价物**：`vibespace-ask`（用户 inbox）与 published pages（把文件交给用户）。全仓 grep：两个工具名 0 命中——也就是说，如果一个会话开了 `--brief`，agent 调它们，我们连**卡片都画不出来**。

**接缝**：先做**渲染**（chat-renderers 的工具卡分支，SendUserFile 的产物落到 published-pages 的现成通道）；是否**默认开** `--brief` 是产品默认值改动（决策 8）。这条也修正 §3.7 的前提：agent 已经有一等的 user-message / user-file 通道，我们的工具通道设计要与它对齐，而不是再造第三套。**门**：渲染 fixture + i18n。**尺寸 S/M。**

### 2.13 review / fork / rename：按 caps 收口（**取代上一稿的「review 联合体」条目**）—— S

**上一稿这条是幻影工作**。codex review 的四种 target × inline/detached **已经全部上线**：`src/lib/chat-status-bar.js:842-880` 给八行（Working tree / Base branch… / Commit… / Custom…，各带 detached），构造 `{type:'baseBranch',branch}` / `{type:'commit',sha}` / `{type:'custom',instructions}` → `_startReview({target,delivery})` → `src/lib/chat-view.js:2970-2978` → `ws-handler.js:586` 已转发 `data.target` 与 `data.delivery`。

**真正的缺陷是它旁边那条**：这条路仍**按 backend id 门控**——`session.backend === 'codex'`（ws-handler.js:587）、`if (backend !== 'codex') return;`（chat-view.js:2982 `_syncReviewAvailability`——只决定按钮何时可用，和 :2990 `_startReadOnlyPolling`；`_startReview` :2970-2978 本身没有 backend 检查）——而客户端 `backendFeatureCaps(this._backend).review` 早就在（agent-meta.js:29/72/100）。**服务端 `src/backend-caps.js` 根本没有 `review` 这一行**（grep 0），所以镜像无从对账。同类还有两处：`addForkBtn` 的 `if (this.backend !== 'claude') return;`（chat-renderers.js:1525-1529）、codex 改名回写的 `session.backend === 'codex'`（ws-handler.js:677-679）。

**接缝**：backend-caps 加 `review` / `renameWriteback` 两行，ws 门与客户端都读 caps。**`addForkBtn`（chat-renderers.js:1525-1529）是「从这条消息 fork」= claude `--resume-session-at <uuid> --fork-session`，与 codex `caps.fork`（整线程 `thread/fork`）不是同一能力——读 `caps.fork` 会给 codex 一个坏按钮；需要独立的 `forkAtMessage` 位。****门**：`test-harness-contract` 的服务端↔客户端 caps 深比对（漂移即红）。**尺寸 S。**

### 2.14 buildLater 项的接缝速记

| 项 | 接缝 | 门 | 尺寸 |
|---|---|---|---|
| claude `list_models` | `ClaudeCodeAdapter.formatListModels()`（紧挨 `buildGetUsage`）→ init 时发一次 → 合并进模型下拉，**禁用行保留置灰 + 显示原因**。终结「发新模型基线就过期」类 | test-cli-usage-parse 扩 + 下拉 fixture | M |
| codex `thread/settings/update` + `turn/settings/update` | 既有 `formatSetModel`/`formatSetEffort` 动词不变，改 wrapper 内部实现（发 RPC 而非存到下 turn）；新增 `formatRetargetTurn({model,effort,serviceTier})` = 「给正在跑的这个 turn 加档」（TurnSettingsUpdateParams 允许 model/effort/serviceTier/summary/approvalsReviewer）；消费 `thread/settings/updated` 让状态栏对 TUI 侧改动诚实 | test-codex-p2-wrapper + 真 app-server 档 | M |
| claude `background_tasks` / `stop_task` | 工具卡两个按钮 → 两个 control_request；不带 `tool_use_id` = 全部后台化 | test-stdout-registry + 渲染 fixture | M |
| codex `thread/list` + `search` + **`items/list` / `turns/list` / `timeline/list`** | descriptor 加 `store.discoverViaProtocol`（bounded app-server child，照抄 codex-thread-read 的模式），优先它、失败回落文件遍历；三个分页 list 是**协议级转录分页**，与我们纯文件式的大转录故事（slab、.zst head、远端增量）是同一问题的第二个解 | test-codex-zst 扩 + 真 app-server 档 | M/L |
| opencode SSE `/event` | 替掉 10s 轮询 + 补上「external driver 不可检测」洞。**动工前 /proc 实测订阅本身起不起 instance**；订阅是我们拥有的长连接 ⇒ 采样/设界/退避/出声一样不少，**并且每事件与整条流都要字节上限**（2.369.50 法则：整份响应读进 server 必须有上限）；`message.removed` / `message.part.removed` 必须处理（与 §2.10 同一条不变量） | test-opencode-serve + /proc A/B | M |
| 权限规则面（codex permissionProfile / opencode saved permissions / gemini policy） | 只读展示：一张「这条规则从哪来」的层次视图（codex `config/read` 的 layers+origins 恰是我们自己设置面缺的视图） | 渲染 fixture | M |

---

## 3. 浮现出来的通用抽象

判据：**一个能力至少两家有、且我们的消费点是同一个**，才升为抽象；只有一家有的（fast mode、gemma 本地路由）就是 harness-specific 功能，不占 caps 行。

### 3.1 sendModes —— 中途发送能做什么（已存在，本轮扩容）

`inputModes` 加 `queueVerbs` 动词表，布尔降为派生视图（§2.1）。封闭集合 `QUEUE_VERBS = ['remove','steer','steer-all','reorder','edit','run-now','run-all']` 从 backend-caps 导出，adapter 与客户端都从它取；加动词 = 改一行数组 + 三处实现 + 一行断言。

**分层词汇**是这条抽象的核心：**ws 帧说相对语义**（`afterId` / `text`），**wrapper 说 RPC 的绝对形状**（全序 `queuedSubmissionIds` / 整包 `input` / 可空 `queuedSubmissionId`）。理由不是「参数名没 dump 出来」（已经 dump 了），而是：全序数组在多写者队列上是**竞态形状**，相对锚点才是用户意图的忠实表达，翻译与归并必须在**拿得到新鲜队列的那一层**做。同理，`edit` 的「保留」必须是**排除法**（保留一切不是被替换 text 元素的东西），不是白名单——白名单在 `UserInput` 加第八个变体的那天会静默删数据。

四家现状（✅ 2026-09-07 实装）：claude `[]`（CLI 自己拥有队列，既不发布也不接管——**诚实的空**）· codex 全七个 · opencode/ACP `['remove','reorder','edit']`（比原计划多两个：promptQueue 是本地数组，重排/改写就是 splice；**run-now/run-all 仍然是 false，且理由是结构性的**——该队列只在 prompt 运行期间有条目，"立刻跑"只能答 busy，声明它就是 accept-and-ignore）· gemini `[]`。派生律 `steer === verbs.includes('steer')` / `queueOps === verbs.length>0` 由 `deriveInputModes()`（PURE，服务端与客户端镜像**共用同一个函数**）保证，test-queue-steer ① 对两边逐行钉。运行中 wrapper 还有自己的一层动词广告（sidecar `caps.queueVerbs` + 每条 `queue_changed` 的 `verbs`，远端会话只能看到后者），只报 `inputQueue` 不报列表的旧 wrapper 按 `remove/steer/steer-all` 对待——旧进程既不能被问它会静默丢弃的动词，也不能丢掉它本来就服务的动词。

### 3.2 checkpoints —— 回溯（新，四家里三家有）

| harness | 对话回溯 | 文件回滚 | 粒度 | 重做 |
|---|---|---|---|---|
| claude | `rewind_conversation{target_message_uuid}`、`/branch`（在此处分叉对话） | `rewind_files` + spawn 时 `enableFileCheckpointing` | message uuid | 消息选择器 |
| codex | `thread/rollback{threadId,numTurns}` / `thread/revert{threadId,beforeTurnId}` | — | turn | — |
| opencode | `POST /session/:id/revert{messageID}` | 同一动作（snapshot 支撑） | message | `unrevert` |
| gemini | `/rewind`（对话+代码 / 只对话 / 只代码） | 影子 git repo | 交互列表 | — |

**caps 行**：`checkpoints: { conversation:bool, files:bool, granularity:'message'|'turn', redo:bool }`
**descriptor 钩子**：`store.rewind(sessionId, {toMessageId, files})`（HTTP/协议驱动的 opencode、以及停用会话）
**adapter 动词**：`formatRewind({toMessageId, files})`（活会话走控制通道的 claude/codex）
**normalizer 记录**：`rewound` meta op → 视图截断。**即使不提供动作，消费这个事件也是最低要求**：codex 的 `thread_rolled_back` 今天在 `SKIPPED_RECORD_TYPES` 里（codex-message-manager.js:249），所以从 TUI 做的回溯在 VibeSpace 里是隐形的，我们会继续显示幽灵 turn。
**贡献点**：消息级按钮，挂在 chat-renderers.js:1525 的 `addForkBtn` 旁边（该按钮是消息级 fork，见 §2.13 的 `forkAtMessage` 说明）。
**红线**：动工作树 ⇒ ① 必须有点名后果的确认对话框（含 snapshot diff 摘要），**用 `showConfirmDialog`，绝不用原生 confirm**（no-native-dialogs 法律）；② streaming 时一律拒绝（依赖 §3.5 的权威状态）；③ 与 writer-sweep 的「一个转录只能有一个写者」不变量对齐。
**门**：新增 `scripts/test-checkpoints.mjs`（caps 矩阵 + 每 harness 一档 + 拒绝路径 + DOM-free 按钮渲染）。**尺寸 L**，建议先只做 `conversation`（决策 2）。

### 3.3 questions —— 结构化提问（新）

四条今天各走各的：claude `AskUserQuestion`（已上，含 2.109.5 的重启存活不变量）+ `request_user_dialog`（未接，新工具将用的通道，不接 = 挂起整个 turn）+ hooks `Elicitation`/`ElicitationResult`（未接）· codex `item/tool/requestUserInput`（已上）+ `mcpServer/elicitation/request`（**回错形状**，§2.7）· opencode `question` 工具（ACP 侧只有一个没有回答通道的 tool_call，回答口在 HTTP，**`opencode acp --port` 就能开**，§2.9）· gemini `ask_user`。

**caps 行**：`questions: { toolDriven:bool, mcpElicitation:bool, replyLane:'control'|'rpc'|'http'|null }`
**codex 的硬前提（上一稿漏）**：`thread/increment_elicitation` / `thread/decrement_elicitation`（响应 `{count, paused:'Whether timeout accounting remains paused…'}`）。任何**由 driver 托管的带外等待**（我们自己的权限卡/提问卡、插件对话框）都必须**括起来**，否则 codex 的 turn 超时会在等待底下开火。
**normalizer**：一张通用「结构化提问卡」，每 harness 一个回复构造器；claude 的 `_meta['anthropic/permissionDisplay']`（结构化标题）在卡头上用起来，今天是从 `message` 里 parse 的。
**opencode 的坑**：ACP tool_call 携带的是 tool call id，不是 `que_…` requestID，必须经 `GET /session/:id/question` 关联；关联不上就明确标为不支持，不假装能答。
**门**：新增 `test-questions`（每 harness 的回复形状 + 括号计数的成对性 + 未知 method 的响亮拒绝）。**尺寸 M。**

### 3.4 changes —— 本轮改动（新）

codex 有推送（`turn/diff/updated`，今天被丢）· opencode 有拉取（`GET /session/:id/diff?messageID`，今天没接）· claude 有 **VCS 级**信号（`vcs_state_changed` / `code_change_published`，今天没接）· gemini 无。
**caps 行**：`changes: 'push'|'pull'|'vcs'|null`。**normalizer**：`changes` meta op（统一 unified diff）+ `vcs` meta op。**贡献点**：turn footer 的 diff 芯片 → 复用现有 diff 渲染。三家来源不同、落到同一个 meta op —— 「hostId 是参数不是分支」的同构写法。**尺寸 M**（§2.8）。

### 3.5 turnState —— 权威回合状态（新）

claude `session_state_changed{idle|running|requires_action}`（**env 开关**）+ `set_in_progress_tool_use_ids`（工具粒度）· codex turn/started+completed · ACP stop reason · gemini 无。
**caps 行**：`turnState: 'authoritative'|'derived'`，外加 `inProgressTools: bool`。derived 的走今天的推断路径；authoritative 的直驱 `_isStreaming` 并在 attach 时对账。`requires_action` 是我们没有的第三态。**降级是一等公民**：env 没开 / 老 CLI ⇒ 回到推断，不许崩、不许假装权威。**尺寸 S**（§2.5）。

### 3.6 responseStyle —— 响应风格（新，两家有）

claude outputStyle（**只能 spawn 时改**，adapters/claude-code.js:79-82 注释写着 stream-json 会话从不被给 `/output-style`）· codex personality（**可中途改**，`thread/settings/update`）· opencode 走 agent 选择 · gemini 无。
**descriptor**：`style: { key, values, applyAt:'spawn'|'live' }`。UI 复用 2.368.0 的菜单槽，`applyAt` 决定要不要显示「下次恢复生效」+ 那个一键重启行。**尺寸 S**（§2.4）。

### 3.7 host 作为工具提供方（新，方向性）

三条路同一件事：codex `thread/start.dynamicTools`（客户端声明工具，服务端经 ServerRequest `item/tool/call` 回调，响应 `{contentItems, success}`——**不需要 MCP server、不需要 PATH 二进制**）· ACP `session/new.mcpServers`（今天硬写 `[]`，data/bin/acp-wrapper.js:705，一个字面量就是全部缺口）· gemini 的 IDE companion 规范（MCP-over-HTTP + tmpdir 端口发现文件 + bearer 鉴权 + `workspacePath` 越界拒绝）。

今天我们的做法是生成 PATH shim + 环境里带 session token（data/bin/vibespace-{status,task,ask,job,msg,page,docs} + plugin-loader 生成的 `vibespace-tool-<id>-<name>`）。换成工具通道的收益：无 argv/env 里的凭据、远程 app-server 上同样工作、plugin 的 `agentTools` 贡献点在 codex 上无需生成二进制即可到达。

**一条纠偏**：它**不能**让 2.369.17 的 codex loopback 洞退休。那次修的是**两件事**——chat 会话的沙箱策略 `networkAccess:true`，以及**终端模式**的 `-c sandbox_workspace_write.network_access=true`；而同一批 AGENT_TOOLS 还分发到远程主机、还在 `vibespace-job` 下跑。dynamicTools 只覆盖 codex 的 **chat** 会话。那个洞按舰队条件退役，不由一条 chat-only 的工具通道注销。

**对齐 §2.12**：claude 已经有一等的 `SendUserMessage` / `SendUserFile`，工具通道的设计要与它对齐（同一张卡、同一个 inbox），不是再造第三套。**尺寸 L，需立项**（决策 4）。

### 3.8 不成立的抽象（记下来免得重提）

- **terminal-in-session**（codex `command/exec` + `process/spawn` · opencode `/pty` · ACP `terminal/*`）：我们已经拥有终端，复制即孪生。反向的那半（声明 ACP `terminal:true`、用我们自己的 PTY 层顶上）是**通用 ACP 客户端**的事，且要和 `fs/*` 的信任边界一起决定。Park。
- **memory**：四家形态差太远（claude 路径+事件、codex sqlite+citation、gemini 后台挖掘+人审、opencode 无）。只取一个具体收益：用 `memory_paths` 换掉硬编码正则（§2.6）。不做 caps 行。
- **plugins/skills 互通**：两个生态在不同信任域（我们的插件扩展**工作区**：窗口/agent 工具/路由；harness 的插件扩展 **agent**：skills/命令/hooks/子代理/MCP）。互补而非重叠，只做只读展示。

---

## 4. 不做的，以及为什么

### 4.1 计费陷阱 —— 一切 `-p` / `--print` / SDK / exec 推理通道

CLAUDE.md 的 program-use billing 法律：会话跑交互式 PTY，**永不**用 `-p`/`--print`/Agent SDK 做推理（会把用量挪到计量型程序化计费）。适用于：claude 的 print-only 全家（`--json-schema` / `--max-budget-usd` / `--fallback-model` / `--forward-subagent-text` / `--include-partial-messages`；`--fallback-model` 的意图我们已用 settings key 达成：`switchModelsOnFlag:false` + `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK`，claude-code.js:57-86）；`codex exec` 全家（`--json` / `-o last-message` / `--output-schema` / `--ephemeral`）——**这些 flag 读起来像明显的自动化捷径，而计费后果是隐形的**，所以要写进文档，免得未来有人「发现」它；gemini `-o stream-json`（**不是 claude 的 schema**：扁平 `content` + snake_case type，误当 claude 解析正是 backend-caps.js:24 点名的 gemini-as-claude 类；且没有 `--input-format`，只出不进）。

**两条候选例外，状态从「已核」降为「未验证」**：`--replay-user-messages` 与 `--include-hook-events` 的 help 只提 stream-json，**但 `--replay-user-messages` 依赖的 `--input-format` 自己的 help 写着「only works with --print」**。上一稿把「help 没提 print」当成「不依赖 print」，是从缺席论证。现实里我们**已经**在交互式 PTY 模式下传 `--input-format stream-json`（ws-create.js:1109、chat-wrapper.js:66-67）且整条聊天管线在跑，所以那句注释不是硬约束——但要成为「送达保证」的设计前提，必须先做一次**零推理的运行时验证**：往 stream-json stdin 送一条只含本地 slash 命令（如 `/help`）的 user 记录，看 stdout 有没有回声。做完再谈设计。

### 4.2 §ban-safety —— 不新增任何 vendor 调用

exactly two files 的规矩不变（scripts/test-vendor-whitelist 执行）。三个**候选**本地 oracle（`claude agents --json`、`claude auth status`、`codex doctor --json`）与 codex `account/usage/read` 都很有用，但它们的「零 vendor HTTP」性质**必须逐条举证**，不能靠形状推断——`auth status` 尤其可疑，max 封号复盘的主因正是后台的 auth/usage 型调用。因此它们统一进**决策 6**，需要 owner 就「每条附一份不发请求的证据 + 白名单豁免理由 + 只走人触发/已有节拍」拍板。auto-cli 那条 owner 批准的例外**不得泛化**。

### 4.3 沙箱与安全红线

- **codex 沙箱**：2.369.17 打开 loopback 只为让 vibespace-* 工具能用。**不得再放宽**——不默认 `--yolo`/`danger-full-access`，不把 `--auto`/`--allow-all-tools`/`bypassPermissions` 做成一键默认。
- **opencode `--auto`**：`opencode acp --help` 里**没有**这个 flag（本轮实测），所以「加个 flag 就有自动批准」是未经验证的断言。要做先验证。
- **发布页 CSP sandbox**：`/p/<id>` 的 sandbox 是同源 XSS 防线，**绝不加 `allow-same-origin`**。
- **插件 iframe opaque origin** 与 per-package consent（contentHash+source）：2.369.43-.44 刚解决的问题，代理 codex/opencode 的插件安装会原样重演。只读展示可以，安装留在它们自己手里。
- **第三方上传默认不做**：opencode `POST /session/:id/share`（整段对话传 opncd.ai）、codex `feedback/upload`（线程+日志传 OpenAI）。最低标准是点名后果的确认对话框（决策 7）。

### 4.4 与自有层竞争的（twin-set 风险）

`hostId` 是参数不是分支——远程 codex/opencode 走机器句柄（ssh/agentd 上跑本地 serve/app-server），**不**开第二条网络传输：OpenCode `workspace/*` + `sync/steal` + `attach <url>` + mDNS；codex `environment/*` + `remoteControl/*` + `app-server --listen ws://`；opencode `/pty`、codex `command/exec`/`fs/*`。留两条防御性事实：① OpenCode 会话 `workspaceID` 变化 = 「被别的 workspace 搬走」的可检测信号；② 若订阅 SSE，`message.removed` / `message.part.removed` 必须处理（与 §2.10 同一条不变量）。

### 4.5 破坏历史的

opencode `DELETE /session/:id/message/:id` 与 part 的 PATCH/DELETE：与 append-only 的转录叙事冲突，且与 writer-sweep 的双写者不变量正面相撞。codex `config/value/write`/`batchWrite` 的乐观并发（expectedVersion）让一次粗心的写变成数据丢失——`config/read` 的 layers+origins 是只读高价值项，写不做。

### 4.6 定位重叠的

claude Remote Control / `--cloud` / `/teleport` / `/schedule` routines：我们**就是**本地会话的远程控制；调度上 src/jobs.js + job-model.js（cron 解析、jitter、15 分钟 agent 下限、park-after-6、单引擎锁）比 `/every` 强。唯一值得单拎的是 `worker_shutting_down` 带 snake_case 原因（`host_exit` / `remote_control_disabled`）——一个干净可归因的会话死亡信号，胜过今天基于 dtach 的推断。各家 TUI 主题/键位（注意 opencode 的键位在 **tui.json** 而非 opencode.json）、`opencode web`（我们自己就是前端）、`opencode db`/`debug`、opencode `experimental.policies`（服务端就过滤了，我们的模型列表天然正确——记下来只是让「为什么 X provider 不在下拉里」有个不是 bug 的答案）。`opencode stats` 是个例外候选：opencode 是唯一没有进我们账本的 harness。Aider 维持原判（无结构化协议），但它的 `--watch-files`（用编辑器写注释驱动 agent）是我们的文件浏览器+编辑器可以为**任意** harness 提供的控制通道，值得记住。

---

## 5. Owner 决策清单

> 每条一行：**选项** → **建议**。1 是本批的门槛（不定就没法写 §2.1），2–3 影响用户看到的语义，4–10 各带一次立项/默认值改动。

1. **codex 队列动词语义**（§2.1）：(a) 本文方案——拖拽=相对 `afterId` 由 wrapper 翻成全序数组、编辑=排除法保留七变体并清 `text_elements`、peer 项不可编辑、run-now 忙时明确拒绝、`run-all` 独立控件；(b) 直接把全序数组暴露到 ws 帧。→ **建议 (a)**，并把「reorder 前必须翻完 `nextCursor` 且发送前重新 list 归并未知 id」写成不变量（今天的 `refreshQueue()` 会静默删项）。
2. **checkpoints 边界**（§3.2）：(a) 先只做 `conversation`（三家齐全、零文件风险）；(b) 同批做 `files`（动用户工作树）。→ **建议 (a)**，`files` 单独立项并带确认对话框 + streaming 拒绝 + writer-sweep 对齐。
3. **codex personality 默认值**（§2.4）：(a) 不选就不传，尊重用户 `~/.codex`（可能改变现有会话语气）；(b) 保留 `pragmatic` 但在 UI 明说是 VibeSpace 覆盖。→ **建议 (a)**（「改默认值先提案」，这条本来就是未经提案的覆盖）。
4. **VibeSpace 作为工具提供方**（§3.7）：(a) 立项（dynamicTools + ACP mcpServers，取代 PATH shim + 环境 token）；(b) 不做。→ **建议 (a)，但明确写清它不注销 2.369.17 的沙箱洞**（那个洞覆盖终端模式与远程主机，按舰队条件退役）。
5. **Gemini CLI 解冻**（`docs/design-harness-plugins.md:88` 的否决理由针对的是 **0.58.0**（消费者 OAuth 2026-06-18 起拒绝），而下面的证据来自本机 **0.33.2**——旧版接受不能证明新版接受；解冻第一步是在隔离目录装 0.58.0 重测 `oauth-personal`）：本机 0.33.2 的 ACP `initialize` 应答实测 `authMethods[0].id="oauth-personal"`（"Log in with Google"）+ `loadSession:true` + image/audio prompt caps，`~/.gemini/oauth_creds.json` 是活的——**当初的理由已不成立**（是条件变了，不是写错）。(a) 走现成 acpHarness 工厂重开（M，不是 L）；(b) 维持冻结。→ **建议 (a)**，第一步是一次真登录+一个真 turn 验证消费者档是否真被接受（提供方法被 offer ≠ 被接受）。
6. **零成本本地 oracle + codex `account/usage/read`**（§4.2）：(a) 逐条附「不发 vendor 请求」的证据后纳入白名单豁免，只走人触发/已有节拍；(b) 全部不做。→ **建议 (a) 但门槛硬**：`claude auth status` 必须先拿出证据（max 封号复盘主因就是后台 auth/usage 调用），拿不出就单独否掉它，其余三条纳入。
7. **第三方上传**（§4.3）：(a) share 与 feedback/upload 都做（带点名后果的确认框）；(b) share 不做、feedback/upload 只做成「报告问题」面板里的可选勾选；(c) 都不做。→ **建议 (b)**。
8. **三个 spawn 侧开关**（§2.5 / §2.12 / §1.3）：`CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`（权威回合状态的唯一来源）· `--brief`（开 SendUserMessage/SendUserFile）· 提示缓存三件套（`--system-prompt-snapshot` / `--exclude-dynamic-system-prompt-sections` / `--autocompact`）。(a) 逐个默认开；(b) 逐个做成设置项默认关；(c) 只默认开第一个（纯可观测性、无行为改变），另两个做设置项。→ **建议 (c)**；提示缓存那组对「一个订阅跑几十个并发会话」是一阶成本杠杆，值得先做 A/B 再谈默认。
9. **每会话 worktree**（claude 有 `-w/--worktree`；**gemini 0.33.2 没有**——包内 0 命中，上一稿写错；qwen 有 PR 形式）：(a) 新建会话对话框加勾选；(b) 不做。→ **建议 (a)**，且**绝不传 `--tmux`**（dtach 是我们的持久层）。
10. **权限规则面暴露程度**（§2.14）：(a) 只读展示（含 codex `config/read` 的 layers+origins「这个值从哪一层来」视图）；(b) 可写。→ **建议 (a)**。

---

### 5.1 Owner 裁决（2026-09-07）

| # | 裁决 |
|---|---|
| 1 | 按 (a)：拖拽=相对 afterId、编辑排除法保留七变体、peer 不可编辑、run-now 忙时拒绝、run-all 独立控件 |
| 2 | **conversation 与 files 都做**（files 档：确认对话框、streaming 中拒绝、与 writer-sweep 不变量对齐） |
| 3 | (a) 不选就不传 |
| 4 | 立项，**两条硬约束**：① 权限按会话 token 作用域——agent **不能枚举、猜测或访问**不属于它的会话/任务/账号/文件；② **渐进式披露**——先注入一个入口工具 + 极简清单，子工具按需展开，绝不一次注入全部（owner 明指 context rot）。先出安全+披露设计再建 |
| 5 | 做（先按上文在隔离目录用 0.58.0 重验 oauth-personal） |
| 6 | 用（逐条附「不发 vendor 请求」证据进白名单豁免；人触发/已有节拍） |
| 7 | (b) share 不做；feedback/upload 只作「报告问题」面板可选项 |
| 8 | (c)：只默认开 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`（纯可观测性），`--brief` 与提示缓存三件套做设置项默认关（owner 2026-09-07 「按你说的来」） |
| 9 | 做（只传 `--worktree`，绝不 `--tmux`） |
| 10 | (a) 只读 |

执行顺序（受机器并发限制）：B1 诚实批（§2.2/2.3/2.4/2.7）→ §2.1 队列动词（等 Stop 清队列链落地，同一 wrapper 文件）→ §3.2/3.3/3.5/3.4 → worktree 勾选 + §2.14 权限只读 + oracle → Gemini → §3.7 工具提供方。

## 6. 落地纪律（每批都适用）

- 新增/修改 caps 行 ⇒ 客户端 `BACKEND_META.caps` 镜像同批改，`test-harness-contract` 深比对防漂移；**服务端没有的 caps 行，客户端也不许单独有**（§2.13 的 `review` 就是这么漂的）。
- 新增 stdin 动词 ⇒ **两个 wrapper 同批**（codex + acp），`unknown-verb` 路径必须出声（data/bin/acp-wrapper.js:584 是范本）。
- 新增 harness 记录消费 ⇒ 先做**联合体普查**再写分支（§2.3 的教训：按名字补两个，漏掉 plan/hookPrompt/userMessage），并 grep live/rollout 孪生。
- 任何拒绝都要**带理由**且 `scope:'action'`（inc-mt2arppw：session 级 error 会把活窗口翻成只读）。
- 对话框一律 `showConfirmDialog` / `showInputDialog`，**原生 prompt/alert/confirm 禁用**；图标只用 icons.js 的 SVG。
- 新 UI 文案 ⇒ zh + ja 同批（i18n-check 在 build 里）。
- 改了行为 ⇒ 同一个 commit 更新对应 kb 文件（CLAUDE.md 顶部的契约）。
- 涉及第三方守护进程（opencode serve / ACP HTTP 面 / codex app-server child）⇒ 采样、设界、可停、出声；**路由成本要 `/proc` 实测，不能从 API 形状推断**；任何整份响应读进 server 进程必须带**字节上限**。
- **能 dump 的 schema 不许猜；从缺席论证前先跑一次**（§4.1 的 `--replay-user-messages` 就是被这条打回的）。

---

## 7. 与上一稿的差异（12 条被推翻/改写的断言）

| # | 上一稿的断言 | 裁定 | 依据 |
|---|---|---|---|
| 1 | 「§2.13 codex review 联合体是缺口，能命名不能发起」 | **推翻**，整条删除 | 已全量上线：chat-status-bar.js:842-880 → chat-view.js:2970-2978 → ws-handler.js:586。改写为 §2.13「按 caps 收口」 |
| 2 | 「会话命名回写 = 缺」 | **推翻** | ws-handler.js:677-679 + codex-chat-wrapper.js:1732-1736 已上；真缺陷是 backend-id 门控 |
| 3 | 「我们的 archive 只在 localStorage」 | **推翻** | persistence.js:412/543/546-563 服务端持久化 + 广播；sidebar-state.js:43-53 明写 localStorage 是缓存 |
| 4 | 「ACP 的 plan / current_mode_update / config_option_update / user_message_chunk 会被静默丢掉」 | **推翻**（结论保留） | 四个都有 case（:495/498/517/521）；OpenCode 只发 6 种且全覆盖。真缺口是 default 无面包屑 + claude 顶层 switch 无 default |
| 5 | 「queue 三动词的参数 schema 本轮没 dump 出来」 | **推翻** | 一条命令离线 dump；`reorder` = 全序数组，不是锚点也不是索引 |
| 6 | 「edit 保留 image/localImage/skill/mention 四种」 | **推翻** | `UserInput` 七变体（漏 audio/localAudio）；改为排除法保留 + 清 `text_elements` |
| 7 | 「run-now = `thread/queue/start{id}`」 | **补全** | `queuedSubmissionId` 可空 = drain 整个队列，是独立动作；新增 `run-all` 并强制 run-now 带 id |
| 8 | 「ServerRequest 只对四个 method 特判」 | **推翻并加重** | 只有 1 个按名匹配；兜底 `{decision}` 对 11 个里的 4 个对、6 个错（逐条列表） |
| 9 | 「image_gen live 分支照抄 codex-thread-read」 | **推翻** | 三个形状；要照抄的是 codex-message-manager.js:1599-1606（test-codex-history.mjs:761 钉住） |
| 10 | 「`--replay-user-messages` 不需要 `--print`」 | **降级为未验证** | `--input-format` 自己的 help 写着 print-only；给出零推理的验证配方 |
| 11 | 「claude hooks 事件数 = 11」 | **推翻** | 二进制最宽 enum 有 33 项，含 Elicitation/ElicitationResult/MessageDisplay |
| 12 | 「children 是 v1 路由所以零 instance 开销」 | **推翻** | 2.369.50 只实测了四条路由，children 不在内；同形状的 `POST …/fork` 就要 dispose。改为 /proc 实测 + `opencode acp --port` 新路 |

另有三条**本轮自查发现、两稿都没有的**：① `refreshQueue()` 丢 `nextCursor`（全序 reorder 下会删项）；② `session_state_changed` 被 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 门控，不开 env 则消费分支是死代码；③ `ToolRequestUserInputResponse` 的 `required` 只有 `answers`，我们的拒绝路径回 `{decision:'decline'}` 不含它。

## 8. 事实核查修订（2026-09-07，定稿前第二次核查，15 条）

r2 稿经独立核查后逐条订正，已在正文就地改写的不再重复；这里只记订正**结论**，供读者对照旧稿：

1. claude 顶层记录并非「整层无信号」——`cli-unknown-stream-type` 面包屑已在（claude-stream-json.js:146-150）；真空洞是 `stream_event` 被列为已知后无声丢弃。
2. `_stdin_ack` 三个 wrapper 都发，claude 侧不缺。
3. `thread/approveGuardianDeniedAction` 是 ClientRequest（我们调用），不会以入站卡片出现；入站 guardian 面另议。
4. opencode acp `--port 0` 不监听；要显式非零端口。
5. gemini 0.33.2 无 `--session-id`、无 `-w`；决策 5 的证据版本（0.33.2）与被否决的版本（0.58.0）不同，需重验。
6. review 路径的 backend 门在 `_syncReviewAvailability`/`_startReadOnlyPolling`，`_startReview` 无门；ws 侧行号 587。
7. `addForkBtn` 是消息级 fork，不能读整线程 `caps.fork`。
8. claude-code.js 的「nothing echoes back」注释属于 effort 路径；init 帧有 output_style 无 effortLevel。
9. `agentEnv()` 是 DROP 表，env 开关在 spawn env 上 SET。
10. 队列控件图标走 icons.js SVG，不用文字符号。
11. SendUserMessage/SendUserFile 会以通用工具卡渲染，缺的是语义不是卡片。
12. `inputModes` 消费方五处，daemon bundle 不含；test-queue-steer 精确比对两侧。
13-15. 行号漂移：available_commands_update :503、usage_update :509、queueStripHtml :741、thread_rolled_back :252。
