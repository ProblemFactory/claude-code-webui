# 撞墙检测 + 自动恢复：turn 粒度状态机（2.369.0）

Owner 与 agent 共同设计（2026-08-28 讨论定稿），替换 2.368.27-34 的补丁堆。
四条支柱、每条对应一次真实事故：

## 设计原则

1. **文本只作布尔触发，绝不是数据源**。banner（"You've hit your … limit"）
   出现 = 本 turn 有撞墙信号，仅此而已；桶种类、重置时间一律不从文本解析
   （.34 的 parseBannerResetMs 已删除）。
2. **quotaVerdict = 账户系统唯一的可用性答案**（account-pool-auto.js 纯函数
   + engine 的 quotaVerdictFor 包装）：
   - 纯基于剩余用量预测（estimator overlay 后的缓存，模型投影后）；
   - 可用线 = THRESH hot 档（**5h < 10%，weekly < 5%**，owner 定），与池引
     擎同一张 THRESH 表——无孪生实现；
   - `blockedUntil` = 死桶未来重置的 **max**（会话解封需所有死桶都过重置）；
   - 池 = 任一成员 usable 即 usable；否则 blockedUntil = 成员的 **min**；
   - 任一死桶重置未知 ⇒ blockedUntil=0 ⇒ 调用方 **probe**，绝不猜。
3. **turn 粒度分类**：撞墙信号（rejected 事件 / banner 布尔 / codex typed
   exhaustion）累积在当前 turn 上；`result` 记录（codex：task_complete /
   task_failed）盖章定性——
   - **walled** = 有信号且最后一个信号之后无实际工作（≤1 条 assistant 记
     录；banner 自己的记录不算工作）→ 进入 BLOCKED；
   - **normal** = 正常完成 → 无条件 disarm（"一个正常完成的 turn 是没被卡
     的充分证据"）。04:55 误报案（rejected 后池切救回、turn 继续完成）自然
     分类为 normal，无需预检/延迟/年龄门。
4. **信息缺口用 probe 填**：blockedUntil 未知时对阻塞账号跑 auto-cli
   `/usage`（官方 binary 发请求，§ban-safety 不变），退避 0→30min→1h→2h，
   4 次后响亮放弃。fire 前同样 probe 一次 + 重新 verdict——false 否决本次
   花费并 re-arm 到新的 blockedUntil（auto-resume 的 beforeFire 支持
   veto，sync boolean 或 Promise<boolean>）。

## 状态流

```
RUNNING ──(walled turn)──► BLOCKED
BLOCKED: maybePoolAutoSwitch（免费，永远先试）
         verdict.usable      → arm(now+45s)（近程 fire 重入工作；公告延迟 90s > 45s，快速成功保持静默）
         verdict.blockedUntil → arm(blockedUntil)
         两者皆无             → probe 阶梯
WAITING ──(到点)──► beforeFire: probe + verdict → veto/fire continue
fired turn 正常完成 → RUNNING；再撞墙 → 回 BLOCKED（阶梯重跑，自限）
任意 normal turn → RUNNING（清除一切等待）
```

## 身份

阻塞身份 = `orgVerifiedKey`（OTel 观测 org 优先于 link——活 CLI 持旧 token
≥25min，.33/.34 事故的根源）；池会话的 verdict 范围 = 整个池。

## 保留的既有语义

死桶 max/跨成员 min（.32）、公告延迟 90s（.34）、fireNow-on-hot-switch
（.28）、user-prompt / 非拒绝读数 disarm（belt）、markLimitBanner 的被动缓
存标记（池引擎消费，与状态机无关）。

## 已退役

armBestReset / pickArmReset / isDeadBucket / noteWorked(30s 年龄门) /
parseBannerResetMs / "已恢复"预检（.33）。

## B-2c9b 补丁（2026-09-05，owner 批准 plan A+B）：撞墙 = 落点账号的真值 + 观测 org 感知评估

同日三起生产事故：walled turn 的 verdict 读的是**池**范围，凭 link 成员的健康缓存
报 "usable via <linked member>"，而 banner 实际落在 CLI 真正运行的那个 org
（193 条 usage-reading-reattributed 已把该会话的读数搬过去）；池 1.5-3 分钟后
才随一条 edf/exhaustion 读数切换，空档里 in-flight subagents 全部 "session limit"。

**不变量：撞墙对它落点的账号就是真值，读数只做确认。**

- **Plan A（BLOCKED 入口先降级）**：每个撞墙信号携带其 mark 落点的 org-verified
  cache key（rejected 事件 / banner 布尔——bucket 名沿用 parseLimitBanner 给缓存
  mark 的那个，仍不从文本取时间 / codex 三处）+ 每账号的 walled-turn 时间环
  （一 turn 一条，120s 窗）。`demoteWalledAccount`：落点账号是本池成员（或 link
  成员）⇒ 立即经 **同一条写路径** `captureRateLimitEvent(…, source:'wall')` 把
  受影响桶标满（utilization 1；resetsAt = 信号的未来重置 > 缓存的未来重置 >
  有界猜测；fetchedAt=now ⇒ anchors/estimator/verdict 同 tick 可见）。
  **误归属守卫（2.368.34 类）**：同账号 120s 内 ≥2 次 walled turn，或该账号 =
  会话 OTel 观测 org（≤10min）才降级；单次且不可证实 ⇒ hold（journal +
  `wall-demote-held`）。降级 journal `[wall] demoted <name> <bucket> until <iso>
  (n walls / observed-org)` + 事件 `wall-demote`。
- **Plan B（观测 org 感知）**：`sessionCurrentMember` = OTel 观测成员（≤10min）
  否则 link；驱动 `resolveUsageKey`（活 odometer / probe 匹配）、
  `quotaVerdictFor(scope,{model,session})`（先判会话所在成员，verdict 带
  on/linked/divergent）、per-session 池评估（从观测成员出发决策；目标就是 link
  时只 journal `(re-point, same target)` + creds mtime bump，不发通知）、两处
  probe 目标。分歧每会话每 10min 记一次 `[pool] session <id> observed on <X>
  while linked to <Y>`。symlink 仍指向**选定**成员——只改引擎"认为会话在烧谁"。
- **入口顺序**：demote → 会话感知 verdict → arm → `finally` 里池评估（arm 之后，
  热切的 fireNow 才能找到已 armed 的会话，同 tick 续跑）；正常完成分支保留原
  `maybePoolAutoSwitch`。

Gate：test-auto-resume §11（真 AccountManager 池 + 真引擎 + 真 auto-resume +
假 OTel；单次 hold / 两次降级+同 tick 切换续跑 / 分歧 verdict 与 re-point /
过期观测回落 / 命名的不降级 / 环按 turn 计数 / 顺序钉）+
test-rate-limit-capture ⑧（`source` 选项）。

## Gate

test-auto-resume §8-10（quotaVerdict 纯函数 + 全部 wiring 钉 + beforeFire
veto functional）；test-pool-auto / test-codex-pool / test-codex-quota 邻接。
