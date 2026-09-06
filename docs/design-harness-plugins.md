# Design: Codex 支持缺口 + 多 harness 抽象层 + 插件系统（2026-09-05 调研）

> 触发：GPT-6 Astra 发布（2026-09-03），owner 将把部分会话转到 Codex 上跑，并要求 (1) 盘点 VibeSpace 各功能在 Codex 上支持不好的地方 (2) 研究多 agent harness 抽象层 (3) 研究插件系统——未来 OpenCode、Gemini CLI 等 harness 以插件形式接入，插件还要支持界面自定义等复杂功能（参考 VS Code）。
> 调研产物：8 个并行 agent（5 个读代码：chat 管线 / 运维面 / 客户端的 Codex 分支、harness 接缝、现有插件系统；3 个外部调研：Codex app-server 协议与 GPT-6、OpenCode/Gemini/ACP、VS Code/Theia/Zed/Obsidian 扩展模型），代码行号为 2.369.16 master。上一轮调研 docs/design-backend-parity.md（2026-08-24）的 P0–P4 切片 1–3 已交付，本文在其上扩展；**每节末尾标注跟踪归属**（feedback_design_doc_debt 法则：无归属的节 = 红旗）。

## 0. 结论速览

- **Codex 今天就有一个 P0**：codex-chat-wrapper 以 `workspaceWrite` 沙箱启动线程，而 codex 的 seccomp 网络策略默认禁 loopback（本机实测 `codex sandbox -c sandbox_mode="workspace-write"` 下 connect 127.0.0.1 → EPERM，`CODEX_SANDBOX_NETWORK_DISABLED=1`；AF_UNIX 同样 EPERM；加 `sandbox_workspace_write.network_access=true` 后 CONNECT OK）。结果：除 yolo 外每个 codex 会话里 vibespace-status/-task/-ask/-job/-msg/-page/-docs 全部 EPERM，而我们每 turn 还在教它用这些工具、Stop 时催它记账。**2.369.17 修复**（§1 P0）。
- Codex 版本漂移是第二个坑：本机 codex-cli 0.149.1，最新 0.153.4；**gpt-6-astra 从 0.153.1 起进 catalog**，且 owner 账号的远程 catalog（2026-09-05 拉取）里**没有** gpt-6-astra——要用 Astra 需先升级 CLI 并确认账号权限；0.153.4 起无 `model` 配置时默认模型翻成 gpt-6-astra（默认 effort LOW、Fast 档 2× 用量）——我们必须显式传 model/effort。
- 抽象层：注册表已覆盖 adapter/caps/normalizer/peerDelivery/客户端 META；剩余 if-chain 集中在 accounts.js(25)、ws-create.js(27)、发现/转录定位/用量 walker/stdout 管线/上下文注入，客户端还有 ~165 处 id 字面比较。第三 harness 今天要碰 ~15 个文件。目标形态是 **HarnessDescriptor**（一个对象 = 一个 harness 的全部声明 + 代码钩子）+ **一致性套件**（每个注册的 harness 跑同一组断言）。
- 通用第三方 harness 协议选 **ACP（Agent Client Protocol, Zed+JetBrains 治理，v1 稳定 2026-06，SDK 1.0）**：Gemini CLI `--acp`、OpenCode `acp`、Copilot CLI、Cursor、Kiro、codex-acp 原生支持；**Claude 不走 ACP**（claude-agent-acp 基于 Agent SDK = 计量计费，违反 program-use 法则）。一个 ACP adapter ≈ 一次性接入 6+ 个 harness。
- 插件系统：今天的 "plugin"（src/plugins.js）是两个硬编码 host 守护进程（tailscale/frp）的管理器，不是扩展机制；客户端 18 个天然贡献点全是编译期字面量/switch。目标是 VS Code 形态：**一个 manifest + 派生激活 + 分层隔离**（声明式 → 沙箱 iframe UI → 受信客户端模块 → 独立进程服务端插件 → harness 插件），贡献点直接映射到现有注册表。

## 1. Codex 支持缺口盘点（按严重度，去重后）

| 级 | 功能 | Codex 现状 | 证据 | 修法 |
|---|---|---|---|---|
| **P0** | agent 工具（status/task/ask/job/msg/page/docs）在会话内可达 | default/safe-yolo/read-only 下沙箱禁 loopback → 全部 EPERM；只有 yolo 能用；同时终端模式因 `codex-linux-sandbox` PATH 探测失败被降级成 danger-full-access（同一"default"选择，chat 有沙箱、终端没有） | codex-chat-wrapper.js:112-118,342,823；cli-env.js:90-105；adapters/codex.js:20-31,853-854；实测 EPERM | wrapper 的 readOnly/workspaceWrite 策略带 `networkAccess:true`（VIBESPACE_API 存在时）；终端路径加 `-c sandbox_workspace_write.network_access=true`；探测改为 `codex sandbox -- true` 功能探测；gate：test-codex-sandbox-net |
| P1 | 图片粘贴 / >64KB 帧 | 帧文件旁路按 backend id 排除 codex，wrapper 无 `_frame_file` 动词，不可解析行静默 `continue` —— 79928a2b 38MB 粉碎类事故对 codex 仍开放且无声 | ws-handler.js:380；codex-chat-wrapper.js:187,1178 | wrapper 实现 `_frame_file` + 宣告 caps.frameFile；旁路只看 wrapperCaps().frameFile；不可解析行记日志+task_failed —— **已交付**（gate：test-chat-frame-guard §2b/§4；kb-bugfix-invariants "CODEX EXCLUDED FROM THE FRAME-FILE BYPASS BY BACKEND ID"） |
| P1 | peer/通知卡片（vibespace-msg、Background Work、auto-resume 公告） | CodexMessageManager 无 injectPeerCard → feedPeerCard 静默 false：auto-resume 的"已安排/已续跑"在 codex 会话里永远不出现，job 通知无卡片进上下文，互聊消息成匿名 user 气泡 | normalizers.js:37；codex-message-manager.js | 实现 injectPeerCard（同 noticeKind）；rpc-queue 通道传 fromName/cardText 让 wrapper 记带标签的记录 — **已交付**：codex injectPeerCard（claude 同形卡）+ 帧带 fromName/cardText + wrapper 记录上的 `webui_peer` 标记（recordKey/mergeCodexRecords 剥掉它保持 buffer/rollout 双副本去重，两种时间序都钉）+ 无标记副本按锚定服务器 frame 回退取名；gate test-peer-msg-card 52 / test-peer-delivery 21 |
| P1 | codex 池化账号的 UI | 2.368.20 冷切池无任何客户端操作面（切目标/成员/自动切换）；三处图标/标签错 | accounts.list() pooled 分支；manage-agents _renderCodexAccounts | list() 先评估 pooled 分支；codex 账号面复用 claude 的池菜单块 |
| P1 | resume 双写保护 | resume-already-live 守卫 + 预 resume writer sweep 都豁免 codex → 两个 app-server 压一个 rollout（B-4058 类）无拒绝无警告 | ws-create.js:48；writer-sweep.js | 守卫按 backendSessionId 覆盖 codex；sweep 加 codex 臂（fd 扫 `rollout-*-$RID.jsonl` + `codex app-server` argv） |
| P2 ✅2.369.20 | 忙碌时发送 | Review/Compact 进行中的输入被 ActiveTurnNotSteerable 拒绝，文本丢失；Regular turn 时是 steer 不是 queue（与 claude 语义不同且 UI 未说明） | codex-chat-wrapper.js:867-882 | 有 activeTurnId 时走 thread/queue/add（镜像 peer-message 路径），UI 显示"已排队" |
| P2 ✅2.369.20 | 活流里 MCP 调用 / 动态工具 / 图片查看 / 上下文压缩不可见 | 只在重 attach 合并 rollout 后出现；活 turn 里几分钟只有"thinking…" | wrapper 事件映射 | wrapper 把 mcpToolCall/dynamicToolCall/imageView/contextCompaction 记成可渲染记录 |
| P2 ✅2.369.20 | 斜杠命令 | 零可发现命令；/compact 显示误导标签且浪费一个模型 turn | chat-input/normalizer init | normalizer init 合成命令表（/goal /compact /review /model /effort），/compact→thread/compact/start |
| P2 ✅S4 | auto-resume 预触发探测 | pre-fire 用陈旧快照；getQuotaProbe 固定走 claude 的 `claude -p /usage`（对 codex 身份是白烧一个 claude 进程） | usage-pool-engine getQuotaProbe | **已修（S4）**：engine `probeQuotaForKey` 按 harness 注册表的 `quota.probe` 分发——'rpc-rate-limits' → 活 codex 会话 `codex-read-limits` 并等 rate_limits_updated（cache 写入后才 settle）；'cli-usage' 保持 refreshViaCliPanel；shell/未知 = 不跑；wall 验证探测 / 探测阶梯 / beforeAutoResumeFire 三处同一分发器；gate test-quota-source |
| P2 | stdin ack | wrapper 冷启动（大线程 resume）>5s 无输出 → 服务器判 pty 坏、重发同一 chat-input → 就绪后处理两次（重复 user 气泡 + 第二条 steer 第一条） | codex-chat-wrapper.js stdin handler | stdin 行处理器顶部立即 emit `_stdin_ack`（服务端已消费） |
| P2 ✅2.369.21 | 新手引导 / 计费切换器 / fork | 引导只认 claude 命名账号；切换器 codex 行不显示配额；codex fork 服务端已通但 caps.fork=false | setup-flows.js:265；session-lifecycle usageFor；agent-meta caps | per-backend 计算 namedLoggedIn；usageFor 读 `_codexAccountUsage`；真 wrapper 测过 thread/fork 后翻 caps.fork |
| P2 | 发现热路径 | 5s /api/sessions 同步走 ~/.codex/sessions 树 + /proc（NFS 下每次 poll 都卡）；localDiscovery 开关对 codex 无效 | codex-session-store.js:46-118 | 走 transcript worker + mtime 缓存；agentd.localDiscovery 时消费 devSnap.codexRollouts |
| P2 | 远程 / 配对设备 | 远程 codex 线程无名字、host 终端里活着的线程显示 stopped（Resume 造第二个 writer）；无 dial/daemon pipe codex 会话；incident 冻结拿不到 codex 转录 | discovery-facts / remote-shell / incident.js | ssh 脚本与 daemon 快照发 NC/CO 行；R6 按 streamProtocol 路由 pipe 会话；incident 用 findCodexSessionJsonlPath |
| P3 | personality ↔ 输出风格、状态标签、权限模式下拉首帧、effort/model-lock/设置前缀的 id 分支、远程 ⟳、终端 idle 检测、autoResume 设置命名、占位文案、design-kit 教学、host 配额快照、转录 rescue、keeper 重认领、远程活投递、外部 codex 终止、sidecar todos 恢复、workflow 芯片 cap、侧栏 backend 过滤默认 | 各 1 处，见 §附录 A 原始条目 | — | 随 §2 S7（客户端 caps 描述符）与 S3/S4 一起消化 |

外部调研带来的额外硬约束（Codex 侧）：
- **版本**：0.153.0 起 rollout 可能是 `.jsonl.zst`；fork 带 `forked_from_id + forked_from_ordinal_exclusive`；新行类型（world_state、inter_agent_communication*、retained_context、token_usage_record…）——session-store/usage-walker/parity 扫描器必须容错并支持 zst。
- **effort 枚举**扩到 none/minimal/low/medium/high/xhigh/max/ultra/persistent/custom，`ultra` = 主动多 agent 委派（额外子线程烧量）——控件与用量表要接受未知值并对 ultra 提示。
- **resume**：分页时代用 `thread/resume {excludeTurns:true}` + `thread/turns|items/list`；全量 hydration 已 deprecated；`thread/read {includeTurns}` 是死会话只读回放的正解。
- **配额被动捕获免费**：每条 rollout `token_count` 与 `account/rateLimits/updated` 都带 primary/secondary/resets_at/plan_type/credits/rateLimitReachedType——可直接喂 usage-anchors/estimator（今天只进 sidecar 展示）。
- **进程模型机会**：`codex app-server daemon` + unix 控制 socket + TUI 重连（0.153.0）= 一台机器一个长命 app-server 拥有多线程并跨 VibeSpace 重启——R6 daemon-pipe 可对接该 socket 而非每会话一个 app-server。
- **审批卡新变体**：decision ∈ accept|acceptForSession|decline|cancel|acceptWithExecpolicyAmendment、网络审批（networkApprovalContext）、item/permissions/requestApproval、item/tool/requestUserInput（阻塞 1–3 问）。
- **上下文注入**：`thread/inject_items` 已在用；`turn/start.additionalContext` 与 `developerInstructions` 是更干净的 per-turn 通道；hooks 在 codex 已一等（SessionStart/UserPromptSubmit/Stop… 且需 config.toml [hooks.state] 内容哈希信任）。

**跟踪：P0 → 2.369.17（本次）；P1 四项 → B-codex-p1（新）；P2 → B-codex-p2（新）；P3 并入 §2 S7；版本/zst/effort → B-codex-0153（新）。原 B-c158 由这三项替代。**

## 2. 多 harness 抽象层

### 2.1 现状（接缝分类）
- 注册表（drop-in）：adapters/index.js（但 cmd 解析/wrapper 路径/探测在 cli-env.js 另一份）、backend-caps.js、normalizers.js、conversation-deliver 的 peerDelivery 通道（**唯一有文档化合同的通道，其它接缝的范本**）、客户端 BACKEND_META。
- 接口：base.js 只声明 7 个 stdin 格式化方法（"一个后端"含义的 ~20%）；ws-create 实际还要求 `buildSessionArgs`（未声明）。
- 孪生文件：chat-wrapper.js / codex-chat-wrapper.js（stdin 动词集各自私有，codex-only 动词在 ws-handler 里字面分发）；session-store.js / codex-session-store.js（`${backend}:${id}` 会话键在 ≥7 处重实现）。
- if-chain（行为分叉，第三 harness 必改核心）：accounts.js(25)、ws-create.js(27)、routes/sessions.js 发现、transcript-service 定位/拉取/搜索三目、usage-walker 双 walker 内联块、session-stdout 两条 ~300 行管线、agent-routes 注入拓扑、客户端 ~165 处（chat-status-bar 折叠、session-lifecycle 计费切换器对第三 id 直接 return、layout.js `|| 'claude'` 默认填充）。

### 2.2 目标形态：HarnessDescriptor + 一致性套件
```js
// src/harnesses/<id>/index.js — 一个 harness = 一个描述符（声明 + 代码钩子）
module.exports = {
  id: 'gemini', label: 'Gemini CLI', icon: 'brand/gemini.svg', brandColor: '#…',
  caps: { ...BACKEND_CAPS 行, frameFile, fork, effortLevels|effortSource, permissionModes,
          outputStyle: 'style'|'personality'|null, slashCommands: 'cli'|'synth'|null,
          inject: 'hooks'|'wrapper'|'acp', workflows: false, quotaRefresh, sandbox },
  spawn:   { buildSessionArgs(opts) → {cmd,args,env,wrapper,cwd,mode}, remotePrelude, probes() },
  wrapper: 'data/bin/<id>-chat-wrapper.js',      // WRAPPER CONTRACT（sidecar meta + stdin 动词 + streamProtocol 事件）
  normalizer: <class>,                            // NORMALIZER CONTRACT（onOp/processLive/convertHistory[Async]/tail/turnMap/goalState/injectPeerCard/taskState/collapseKind）
  store:   { discover(machine), locate(id,cwd), parse(records) → SessionMessages 形状, writerSweep(id), forkChain(id) },
  accounts:{ credsScheme, readAuth(dir), spawnEnv(dir), loginFlow, shipRemote },
  usage:   { walk(records) → ledger 事件, pricing, quota: { normalize(raw) → {fiveHour,sevenDay,scopedWeekly}, onStreamSignal, probe(session), classifyAuthFailure } },
  inject:  { teach(session, ctx) },               // hooks 注册 或 wrapper 注入 或 ACP prompt 前缀
  client:  { META 行（含 caps/fallbackModels/permissionModes/placeholders/settingsPrefix）, settingsKeys }
};
```
- 合同用基类固定（`BaseWrapperContract` 在 wrapper 侧以协议测试固定，`BaseNormalizer`、`BaseStore`），**src/harnesses/index.js** 是唯一注册表：内建 claude/codex/shell + 插件贡献的 harness；核心任何地方**禁止 `|| 'claude'` 默认**（未知 = 响亮失败，gemini-as-claude 类事故根除）。
- **scripts/test-harness-contract.mjs**：对每个注册 harness 跑同一组断言（描述符完整性、wrapper 动词集、normalizer 方法集、store/usage 纯函数在 fixture 上的形状、客户端 META 完整性）——"twin-sets=0 是指标不是状态"的通用化。
- stdout 管线：session-stdout 的两条内联管线改为 `descriptor.stream.parse(line) → 归一化事件`（id 采纳/todos/配额/墙信号/peer 去重各一份消费者），daemon 侧共用同一模块（三层法则）。**S5 落地形态（见 §2.4）**：descriptor 只用 caps.streamProtocol 命名协议，src/server/stdout/index.js 注册表解析出消费者；消费者留在 ORCH（依赖 engine/hosts/ledger），daemon 侧不共用——设备流仍走 session-brain 的 claudeSideEffects。

### 2.3 通用第三方 harness 协议：ACP v1（2026-09-05 二次调研后定案，owner 拍板）
三组调研（中文生态+DeepSeek / 开源通用 / 厂商 CLI）结论一致：**ACP v1（stdio JSON-RPC，schema 1.7.0，TS SDK 1.4.0，Zed+JetBrains 治理）是唯一跨厂商覆盖"会话生命周期 + 流式工具调用(kind/status) + 权限往返(allow_once/always/reject) + 配置项(model/mode)"的协议**；ACP 注册表 40 个 agent / 99 个 client。v2 草案（2026-07）更合我们的模型但零实现，按版本协商预留。远程传输仍是 RFD（Streamable HTTP/WS），与 R6 daemon-pipe 一致：拥有机器上的 agentd 做 ACP client。

| harness | 版本 (2026-09-05) | ACP | 备注 / 特殊处理 |
|---|---|---|---|
| **OpenCode** (anomalyco) | 1.18.29（本机已装） | 原生 `opencode acp`（load/list/fork） | **首发目标**：models.dev 覆盖 DeepSeek V4/Kimi/Qwen/GLM/MiniMax 含 coding-plan 端点；另有 `opencode serve` HTTP+SSE（S9 原生 adapter）；ChatGPT/Claude OAuth 登录在 OpenCode 内属厂商 ToS 灰区，不作为我们的默认 |
| Kimi Code CLI (Moonshot) | 0.41.0 | 原生 `kimi acp`，SDK 1.3：ACP 面最全（load/list/resume/fork/close/delete、image、elicitation、set_config_option/set_model） | 需 `kimi login`（会员）；`kimi web` REST+WS |
| Qwen Code (Alibaba) | 0.23.0 | 原生 `qwen --acp`（SDK 0.14，loadSession，无 fork→spawn 时 `--fork-session`） | Qwen OAuth 免费层 2026-04-15 停；`qwen serve` 含 ACP Streamable-HTTP `/acp` |
| Qoder CLI / CodeBuddy Code | 1.1.45 / 2.146.0 | 原生 `--acp` | PAT / API key；CodeBuddy 有 `--serve` HTTP |
| DeepSeek Harness (dsh) | 0.1.2-rc.1（dev preview） | 原生但"automation-only"（无 load/fork/modes/terminal/elicitation） | API key only；会话日志 zstd JSONL；社区 `dsh-acp-enhanced` 补齐 load/list/流式——存在时优先 |
| Goose / Cline / Kilo / Mistral Vibe | 1.49.0 / … | 原生（Goose 另有 ACP-over-HTTP `goose serve`） | |
| Copilot CLI / Cursor CLI / Kiro CLI / Devin CLI / Junie CLI | 1.0.83 / rolling / 2.21.0 / 3000.6.14 / 1468.30.0 | 原生 v1 | Copilot 另有 TCP；Cursor/Kiro 无 list/fork |
| Gemini CLI | 0.58.0 | 原生 `--acp` | **消费者 OAuth 2026-06-18 起拒绝**，仅 API key/企业；继任 Antigravity CLI **无 ACP** → 不再作为首发 |
| ZCode (Zhipu) | 3.11.2 桌面 | 非原生：`zcode-acp-server` 桥接其 app-server | 或注册表的 `glm-acp-agent` |
| Codex | 0.153.4 | 非原生：`codex-acp`（ACP 组维护，非 OpenAI） | **保留我们的原生 app-server adapter**（能力更全、无翻译层） |
| Claude Code | 2.1.257 | 非原生：`claude-agent-acp` = Agent SDK 通道 | **永不**（计量计费，违反 program-use 法则） |
| Amp / Aider / Crush / Trae / iFlow / MiniMax | — | 社区桥 / 已弃 / 无 | 不做 adapter；模型经 OpenCode |

**形态**：`src/harnesses/acp/`（一个描述符模板 + per-agent 小配置：可执行/参数/auth 方法/store 位置/能力探测）；`data/bin/acp-wrapper.js`（在 dtach/daemon 下拥有 stdio，把 `session/update` 记录进 buffer 文件 + sidecar，实现 WRAPPER CONTRACT 动词：chat-input→session/prompt、interrupt→session/cancel、permission-response→request_permission 回复、set-model/set-mode→set_config_option、peer-message→prompt 前缀、_frame_file、_stdin_ack）；ACP normalizer（tool_call kind → collapseKind；permission 选项 → harness 中立权限卡；agent_thought_chunk → 思考块；plan → todos；available_commands_update → 斜杠命令）；resume 用 `session/load`（无 load 的 agent 走 `session/resume` 或按 store 回放）；adapter 按 initialize 返回的 agentCapabilities 决定 fork/list/load/image 等 caps（能力驱动，不写死）。**gate 用 mock ACP agent**（scripts 内一个最小 ACP v1 agent：initialize/session/new/prompt→tool_call→request_permission→agent_message_chunk→end），真 agent 用手动脚本（OpenCode 装好即跑）。

**跟踪：S8 = B-a140（首发改 OpenCode，mock-agent gate）；S9 = B-03f2。**

### 2.4 切片（每片一个 gate，可独立发版）
| 切片 | 内容 | gate |
|---|---|---|
| S1 ✅2.369.18 | HarnessDescriptor + src/harnesses 注册表，把 claude/codex/shell 原样包进去（零行为变化）；删除 cli-env 里的第二份 adapter 配置 | test-harness-contract（3 harness） |
| S2 ✅2.369.27 (creds descriptor: dirs/auth/files/seed/remote-ship/host-facts/bump/oat; 保留 resolveForSpawn 分派 + claude-only hostSubs) | accounts.js 凭据策略对象（25 处三目收口：credsScheme/readAuth/spawnEnv/loginFlow/shipRemote） | test-account-pool + test-harness-contract S2 pins |
| S3 ✅2.369.31 (store descriptor + worker-side codex discovery + .zst + NC/CO remote facts) | store：discover/locate/parse/writerSweep/forkChain 归描述符；routes/sessions 与 transcript-service 只调描述符；zst 支持 | test-transcript-parity / test-discovery-interpret 扩到每 harness |
| S4 ✅ | usage/quota：QuotaSignalSource（normalize/signalFromStream/probe/classifyAuthFailure）；getQuotaProbe 按 caps 分发（顺带修 §1 P2 的 auto-resume 探测）。**已交付**：src/harnesses/{index,claude,codex,shell}.js 最小注册表（S1 未落地时先行，`get()` 未知 id 响亮失败）+ claude-quota/codex-quota（claude 与 codex 的 normalizer 原样迁入，usage-routes 只重导出；claude 的 stream 信号=rate_limit_event+banner，codex=rate_limits_updated/task_failed typed enum/reset_credit_result）；engine 的 recordRateLimitEvent/recordCodexQuotaSignal/notePoolAuthFailure 经注册表取信号与分类器；probeQuotaForKey 分发器替换三处 getQuotaProbe 直呼。零行为变化（signal 分类与旧分支逐一等价）。未动：session-stdout 的两条管线仍各自喂 engine（S5），codex auth-failure 仍只上报不驱逐（credsTokenSig 是 claude creds 路径，S2 归属） | test-quota-source（新）+ test-codex-quota / test-codex-pool / test-auto-resume / test-pool-auto / test-vendor-whitelist |
| S5 ✅ (stdout consumer registry；descriptor 只命名) | session-stdout 的三条内联管线（claude stream-json / codex-events / acp-events）**原样**迁入 src/server/stdout/<protocol>.js（主体逐行 === HEAD，仅缩进），注册表 src/server/stdout/index.js 按 descriptor 的 caps.streamProtocol 解析出唯一消费者（`create(deps) → {protocol, attach(session,id,pty,helpers)}`；descriptor **不加** stdout:{protocol} 副本——caps 行是唯一真源，contract 套件钉死没有副本），setupSessionPty 只剩查表 + attach；未知协议在会话启动时响亮失败（console.error + `chat-protocol-no-consumer` 事件 + RAW 透传，绝不回落 stream-json；无协议沿用原文案）。**刻意偏离本表原文**："descriptor.stream.parse + daemon 共用"未做：三个消费者都依赖 orchestrator（pool/quota engine、hosts.harvestUsage、ledger、goal sync、delivery ladder），SHARED 描述符装不下（test-architecture 禁止 SHARED 上探 ORCH），设备侧仍由 session-brain 的 claudeSideEffects 经 sbSeenFirst 补位（本片未动）。零行为变化：per-attach 闭包状态（lineBuf / ANSI stripper / subagent watcher 绑定）留在 attach 闭包，其余字段仍在 session 上 | test-stdout-registry（新：注册表形状 + 未知协议响亮（带负控） + 每消费者假 pty 喂真实 normalizer 代表记录 + id 采纳/streaming/_stdin_ack/todos/engine 调用 + wiring pins）+ test-harness-contract（每个 chat harness 的协议有消费者、无死行、无副本）+ test-session-brain-dark 不变 + 迁移的 pins（attach-rebuild / chat-frame-guard / acp-harness / tool-progress / compaction-ux / auto-resume / codex-pool / peer-delivery / peer-msg-card / quota-source） |
| S6 ✅2.369.22 | 上下文注入策略对象（hooks/wrapper/acp）；agent-tool-generators 的 harness→hook 文件映射进描述符 | test-agent-hooks |
| S7 ✅2.369.23 (pins 2.369.26) | 客户端：META caps 补齐（effortSource/modelLock/settingsPrefix/accounts/usageBucketType/permissionModes/placeholders/workflows/terminalIdle），消灭 ~165 处 id 比较；test-architecture 断言 src/lib 里零 `=== 'claude'|'codex'` | test-architecture 新断言 + test-client-boot |
| S8 ✅2.369.29 (generic ACP v1 harness + OpenCode; 剩: stopped会话发现/远程spawn) | ACP harness（Gemini CLI 首发）作为第三 harness 的证明；acp-wrapper + normalizer + store facts | test-acp-harness（真子进程：initialize → prompt → tool_call → permission → cancel） |
| S9 | OpenCode serve-mode adapter | test-opencode-harness |

**跟踪：S1–S7 → B-6967（已有，改为本表）；S8 → B-acp-gemini（新）；S9 → B-opencode（新）；B-7dbc（第三方模型/多账号全 harness 生效）随 S2/S4 交付。**

## 3. 插件系统（VS Code 式）

### 3.1 今天
src/plugins.js = tailscale/frp 两个硬编码 host 守护进程的管理器（`defs()` 字面量、每个生命周期方法 id 分支、无 manifest、无卸载、下载无校验、进程内运行于 ORCH 层、只收 `{dataDir, broadcast}`）。客户端 18 个天然贡献点（窗口类型/rail 面板/文件查看器/右键菜单/状态栏芯片/customize 区域/gs-menu/设置/主题/快捷键/斜杠命令/i18n/图标/agent 工具/路由/ws 类型/backend/agentd ops）中只有主题、斜杠命令、agent 工具是数据驱动的；其余都是编译期字面量或 switch（ws-handler 的 switch 无 default，未知类型静默忽略）。

### 3.2 目标模型
**Manifest**（`vibespace-plugin.json`，VS Code 形）：`id`（`<publisher>.<name>`，小写连字符，= 目录名）、`version`、`engines.vibespace`（最低宿主版本）、`description/icon/repository`、`contributes`、`capabilities`、`tier`（instance|device）。**激活派生自贡献**（VS Code ≥1.74 的教训）：纯声明式插件永不加载代码；服务端在首个路由/工具/hook/harness 命中或 onStartup 激活；客户端在贡献的窗口/面板/查看器/命令首次调用时激活。

**贡献点 → 现有注册表**（核心先把自己的字面量改成注册调用，dogfooding）：
| contributes | 映射 | 备注 |
|---|---|---|
| `backends[]` | src/harnesses 注册表（§2） | 最深层，仅 trusted-server |
| `windows[]` {type, icon, openSpec, ui:'iframe'|'trusted'} | TYPE_ICONS + replayOpenSpec（switch → 注册表，加 default 响亮） | published pages 的 shell/iframe 就是现成宿主 |
| `panels[]` | sidebar-rail（四个平行字面量 → 一个注册表） | |
| `viewers[]` {ext[], viewer} | file-types REGISTRY（私有常量 → register()） | |
| `commands[]` + `menus[]` {where, when, group} | 命令注册表 + showContextMenu items（已是数据驱动）+ gs-menu | `when` 谓词参考 VS Code |
| `statusChips[]` | chat-status-bar render() 的 parts | design 芯片是首个迁移对象 |
| `settings` | settings-schema（含分类）+ serverSetting | 命名空间 `plugin.<id>.*` |
| `themes[]` / `keybindings[]` / `slashCommands[]` / `i18n` | 已是数据 / command-mode → 键位注册表 / chat-input / DICTS | |
| `agentTools[]` {name, args schema, docs} | **声明 + 生成的 shim CLI**（`data/bin/vibespace-tool-<plugin>-<name>` POST 到插件路由，带 vsst_）——不是任意二进制；随 AGENT_TOOLS 分发到远程主机 | |
| `routes` / `ws` | `/api/plugins/<id>/*` 反代到插件进程；ws 类型命名空间 `plugin:<id>:*` | 走正常 cookie/vsst 鉴权之后 |
| `deviceOps[]` | agentd 的通用 `plugin-op`（三触法则：id 键回复、推送分支、重连重臂） | tier:device |

**分层隔离（由弱到强的信任）**：
1. 声明式（主题/键位/设置/菜单/i18n）——无代码。
2. **沙箱 iframe UI**（默认）：`/plugins/<id>/…` 用 published-pages 同一 CSP `sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads`（不透明源，**永不** allow-same-origin），postMessage 桥 `vibespace-plugin-api` v1（settings get/set、会话列表/订阅、开窗、通知、命名空间存储（SyncStore → 多客户端广播）、主题变量）。geo/storage 桥（2.369.7）就是原型。
3. **受信客户端模块**：`import('/plugins/<id>/client.js')` 同源 ES 模块（零构建），Obsidian 模型；等价于提交代码——安装时 owner 显式同意 + 展示能力清单；所有 XSS/innerHTML/DOMPurify/escHtml 法则适用；这是"深度界面自定义"（自定义聊天渲染器、原生观感的 rail 面板）唯一可行层。
4. **服务端插件 = 独立进程**：`child_process.fork(server.js, {serialization:'advanced', env: agentEnv()+插件变量})`，一进程一插件，IPC-only API（路由代理、ws 命名空间、设置、存储、会话事件订阅、host ops），进程崩溃不带走 orchestrator；`node --permission --allow-fs-*` 做安全带（非安全保证）。vm/vm2/isolated-vm/worker_threads 都不是隔离边界（调研结论）。
5. **harness 插件**：tier-4 进程提供 HarnessDescriptor 的代码钩子 + wrapper 文件（wrapper 仍在 dtach/daemon 下跑）；只允许 trusted；这是 Gemini/OpenCode 接入的形态。

**能力声明**（Zed + WebExtensions）：`capabilities: { server.fs:{read:[globs],write:[globs]}（默认仅插件目录 + data/plugins/<id>/）, server.spawn:[{command,args}], server.net:[{host,path}], server.routes, agent.tools, client:'iframe'|'trusted' }`，安装时展示，越权调用返回错误；`plugins.allowTrusted` 设置默认关。

**打包/分发/版本**：目录或 zip（`.vsp`）= manifest + 资产；从本地文件、git URL、GitHub release 资产（tag == manifest version）安装；无 marketplace（先不做）；更新 = 重装；API 单一版本号 `api.version` 加法演进，实验 API 走 `proposedApi[]` + 设置门。解压必须防 Zip Slip（Zed 的教训）。

**架构红线进红测**：test-architecture 加 PLUGIN 行——插件只能触达 `src/plugin-api.js`（服务端）/ `src/lib/plugin-bridge.js`（客户端）；loader 绝不 `require()` 插件代码进 orchestrator（harness 插件的描述符除外，且经合同套件）。今天的 tailscale/frp 折叠成内建 server 插件（它们本来就符合：安装步骤、持久状态、boot 重放、引导登录）。

**不借鉴**：Obsidian 式第三方直接 DOM（多客户端应用 = 全船存储型 XSS 面）；OpenCode 式进程内顺序 hook 改共享对象（零隔离）；VS Code 运行时其实也无沙箱（防线全在 marketplace）——我们没有 marketplace，所以隔离必须在运行时。

### 3.3 分期
| 期 | 内容 | 依赖 |
|---|---|---|
| Ph1 | 核心贡献点注册表化（窗口类型 ✅2.369.19 window-types.js / rail 面板 / 查看器 / **命令+菜单 when+键位+ws default ✅ src/lib/contributions.js**：`registerCommand`/`registerMenuItem({menu, command, group, order, when})`/`menuItems(menu, ctx)`/`registerKeybinding`+一个 document 级分发器（app 生命周期 AbortController）/`runCommand`；核心已把 session-card 右键菜单（session.* 命令，session-card.js）、窗口标题栏/taskbar/窗口列表菜单（window.* 命令，taskbar.js）、⚙ 菜单（gear-menu.js，含插件窗口 expand 行）迁成注册项且**字节级一致**（scripts/test-contributions.mjs 用逐字复制的旧 builder 在状态矩阵上做 diff）；command mode/Ctrl+K 只注册为命令、键位分发原地保留（旧检查对修饰键宽松+capture 顺序 load-bearing，迁移即行为变化）；分隔符是显式贡献（VS Code 自动分组规则无法复现窗口菜单无会话时 Minimize/Close 之间无线的形状）；plugin-client 受信模块 host API `api.registerCommand/registerMenuItem/registerKeybinding/runCommand`（id 命名空间 `plugin:<id>:<slug>`，全部绑到插件 signal）；ws-handler `switch(data.type)` 加 `default:`（限频日志+telemetry `ws-unknown-type`+回 `{type:'error', code:'unknown-type'}` **不带 sessionId**）。**未迁**：file-explorer 菜单（file-explorer-ops.js，超出本片）、状态芯片 / rail 面板 / 查看器注册表 / 状态芯片）——与 §2 S1/S7 同批，无 loader | — |
| Ph2 ✅2.369.24 最小 + ✅2.369.30 全部(受信层/设置主题贡献/安装UI/能力执行) | manifest + loader：声明式 + iframe UI + 独立进程服务端插件 + agentTools shim + 安装/卸载 UI；tailscale/frp 迁入 | Ph1 |
| Ph3 | harness 插件：ACP/Gemini 作为首个外部 harness 插件（= §2 S8 的交付形态） | S1–S6, Ph2 |
| Ph4 ✅2.369.30 (受信模块+同意+打包安装源+能力清单UI+--permission执行+远程shim) | 受信客户端模块 + 打包/安装源 + 能力清单 UI | Ph2 |

**跟踪：Ph1 → B-plugin-registries（新）；Ph2 → B-plugin-loader（新）；Ph3 = B-acp-gemini；Ph4 → B-plugin-trusted（新）。**

## 4. owner 决策（2026-09-05 已拍板）
1. **ACP 作为通用第三方 harness 协议**（Claude 不走、Codex 保留 app-server 原生 adapter）——✅ 同意；二次调研后首发改 OpenCode（§2.3）。
2. **插件"受信客户端模块"层**——✅ 允许，默认关、安装时展示能力清单。
3. **优先级**——owner：无优先级，全部推进（并行切片 + 每片 gate）。
4. **GPT-6 Astra 前置**——✅ 本机已升 0.153.4，model/list 含 gpt-6-astra；真实会话 e2e 通过（scripts/dev/codex-e2e-live.mjs）；0.153 命名注入 `<recommended_plugins>` 已修。

## 附录 A：原始盘点条目
完整三镜头条目（含每条的 file:line 证据与修法）与外部调研来源列表保存在调研会话的本机 workflow journal（run id `wf_01ba5210-a8d`，未入库——§1 表已收录全部 P0–P2 条目，P3 条目按 §2 S7 消化）。
