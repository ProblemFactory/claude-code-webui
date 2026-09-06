# Changelog

## 2.369.40
- **Wall → switch in the same tick (B-2c9b, plan A+B; worktree agent, integrated).** Three times on 2026-09-05 a walled turn's verdict read the POOL scope ("usable via <linked member>" off the linked member's healthy cache) while the limit banner had landed on the org the CLI was ACTUALLY on (a hot-switched CLI keeps its old token — 193 readings had been re-attributed away from the link); the pool only moved 1.5–3 min later when a reading arrived, and in-flight subagents died in the gap. (A) **A wall is ground truth for the account it lands on; readings only confirm.** Every wall signal (rate_limit_event, limit banner, the codex sites) now carries the org-verified cache key its mark landed on, and `demoteWalledAccount` runs FIRST in `onWalledTurn`: if that account is a member of the session's pool, the affected bucket is written exhausted NOW through the same write path readings use (`captureRateLimitEvent`, source `wall`: utilization 1, resetsAt = the signal's future reset, else the cached future reset, else the bounded 5h/24h guess), and the pool evaluation runs in the same `noteTurnEnd` AFTER the auto-resume arm, so a hot switch's fireNow continues the armed session immediately. Misattribution guard (the 2.368.34 class): demote only when the account saw ≥2 walled turns inside 120 s (any sessions, one entry per turn) OR it is the session's OTel-observed org (≤10 min); a single unverified wall holds — journal `[wall] … holding the demotion` + telemetry `wall-demote-held`; demotions log `[wall] demoted <name> <bucket> until <iso> (n walls / observed-org)` + `wall-demote`. (B) **Observed-org aware evaluation.** `sessionCurrentMember` (OTel truth ≤10 min → pool member, else the link) now drives `resolveUsageKey` for pooled sessions (live odometer, probe matching, every derived cache key), `quotaVerdictFor(scope, {model, session})` (the session's current member is judged first so `via` names what it is on; verdict carries on/linked/divergent), the per-session auto-switch pass (decides FROM the observed member; a same-target re-point is journal-only + creds-mtime bump) and both probe targets; divergence logs once per session per 10 min (`[pool] session <id> observed on <X> while linked to <Y>`, telemetry `pool-observed-divergence`). The hot-switch symlink still targets the chosen member. No product default changed. Known limit: a live CLI can hold its old token ≥25 min, so a re-pointed session may re-wall once — the second wall inside 120 s demotes (self-limiting). Gate: test-auto-resume §11 (real pool + real engine + real auto-resume, 125), test-rate-limit-capture ⑧ (42); design record docs/design-wall-machine.md addendum.

## 2.369.39
- **Harness S5 — stdout pipeline per descriptor** (docs/design-harness-plugins.md §2.4 S5; worktree agent, integrated). The three inline branches of `setupSessionPty` (claude stream-json / codex-events / acp-events, ~830 lines) moved VERBATIM into `src/server/stdout/<protocol>.js` behind a protocol registry (`src/server/stdout/index.js`): the harness descriptor NAMES the protocol (`caps.streamProtocol` stays the ONE source of truth, pinned identical by harness-contract), the registry resolves it to `create(deps) → { protocol, attach(session, id, pty, helpers) }`, and session-stdout.js (1169→352 lines) does nothing but look it up and attach. A declared protocol with NO registered consumer used to fall to raw passthrough silently — it now fails LOUDLY at session start (console.error naming backend/protocol/fix + telemetry `chat-protocol-no-consumer`, output still RAW, never mis-parsed as stream-json); the no-protocol text is unchanged. Verbatim proof: every moved body diffed identical modulo indentation against HEAD, and every free identifier each body uses is declared in its new header (the lost-binding class). Deliberate deviation from the design's "descriptor.stream.parse shared with the daemon": the consumers need the pool/quota engine, hosts.harvestUsage, the ledger, goal sync and the delivery ladder, so they stay ORCH-tier; session-brain's claudeSideEffects/sbSeenFirst wiring is untouched. Gate: scripts/test-stdout-registry.mjs (58: registry shape, descriptor↔consumer coverage, every consumer driven on a fake pty with REAL normalizers, unknown-protocol loudness) + harness-contract pins; attach-rebuild/session-schema/chat-frame-guard pins now scan src/server/stdout/.

## 2.369.38
- **Plugin Ph1 complete — commands + menus + keybindings registry, ws `default` loud case** (docs/design-harness-plugins.md §3.3 Ph1; worktree agent, integrated). New `src/lib/contributions.js` (DOM-free at import): `registerCommand`, `registerMenuItem` (menu/group/order/`when`, explicit separators, submenus, decorate), `menuItems(menu, ctx)` → showContextMenu-shaped items with VS Code ordering, `registerKeybinding` + ONE document-level dispatcher under an app-lifetime AbortController, `runCommand`; every register returns dispose() and honours a signal; malformed/duplicate registrations throw, unknown commands warn once + telemetry. Core dogfoods it with ZERO behaviour change, proven by identity tests against the verbatim legacy builders (session-card menu over 2048 states, window menu over 320, gear menu over 16 incl. the plugin-windows block): session-card.js `session.*` commands + `registerSessionCardMenu()`, taskbar.js `window.*` + `registerWindowMenu()`, new `src/lib/gear-menu.js` (`registerGearMenu`/`buildGearMenu`, shared with mobile-nav), command-mode.js and session-palette.js route every action through `runCommand` while keeping their modifier-lenient capture-phase key dispatch (a strict chord migration would change behaviour — documented). Plugin host API gains `api.registerCommand / registerMenuItem / registerKeybinding / runCommand`, ids namespaced `plugin:<id>:<slug>`, removed on deactivate (docs/plugins.md). Server: ws-handler's `switch(data.type)` has a `default:` — one log line per unknown type per 10 min, telemetry `ws-unknown-type`, reply `{type:'error', code:'unknown-type'}` deliberately without sessionId (every client error consumer is sessionId/reqId-gated, so it can never flip a window read-only). Gate: scripts/test-contributions.mjs (133). Loader-suite pin updated for the gear-menu move.

## 2.369.37
- Plugin loader: `stopChild` detaches the exiting process immediately, so the `startChild` that install/update issue right after it spawns a fresh child instead of waiting for the old one's exit handler + crash backoff (CI-caught: the reinstall/update assertions timed out on the runner while passing locally).

## 2.369.36
inc-mtox23xw ("content jumped after I sent a message"; the two DreamVanLife windows stuck at open/loading) — two faults, both fixed:
- **Server event loop blocked 10–59 s by the usage estimator.** Ground truth: `Debugger.pause` through the inspector caught the main thread three times inside `usageHistory._events` ← `costBetweenMulti` ← `extractPairs`/`learnRates` ← `ratesFor`, reached from `/api/usage` and from the pool engine's `sweepUsageAnchors` timer; strace showed ~90 `openat`/s (a readdir + stat per ledger shard per call) and no idle during the "loop gaps"; the CPU profiler's `(idle)` attribution had hidden it. `learnRates` costs EVERY historical anchor pair on every recompute (thousands of pairs, recomputed on every new anchor) and each cost was a full scan of the whole permanent ledger. Fix: the ledger keeps a lazily rebuilt time-sorted view and `_events(from,to)` binary-searches it (O(log n + k)); `_loadEvents` re-checks the shard directory at most once per second (its own appends reset the throttle); `costBetweenMulti` memoizes per interval, keyed by the count of events at or before `to` so a late backfill into an interval still recomputes it. Gate: scripts/test-usage-ledger-perf.mjs (brute-force parity over an unsorted 60k-event ledger, 2000 pair costs cold <1.5 s / warm <60 ms, memo invalidation, readdir throttle).
- **Chat view paged up on its own after the reconnect rebuild.** The heartbeat terminated the (frozen) client → reconnect → every window re-attached and rebuilt; 100 ms later the "auto-fill when content doesn't fill the viewport" check saw unresolved content-visibility heights (sh ≤ ch) on a tall PINNED window and fired an ungated `_extendTop`; the slab landed 7 s later (stalled server), `trimBottom` dropped the live tail and the view unpinned ~1500 px up. Now the check waits 700 ms for heights to settle and only fires for a genuinely short view (<30 rendered cards).

## 2.369.35
- **Image tool results froze the page** (owner: two DreamVanLife windows stuck at "opening"/"loading history" while this session opened in 2s): the agent had been `Read`-ing PNG screenshots — the CLI returns each as a base64 block, and the normalizer JSON-stringified it into the card's `output` TEXT (~600 KB per card; 78 cards; a 12 MB attach payload; the transcript grew 0.6→65 MB in 85 minutes). The renderer's escHtml/linkify over base64 froze the browser thread (telemetry: renderer-freeze-s, ws-reply-timeout:attach ×19, ws-heartbeat-terminate ×11 → reconnect storm), and the codex window in the same page could not get its attach ack. Fix: `splitToolResultContent` lifts image blocks out as `{mediaType, bytes}` metadata (the output keeps a one-line `[image image/png · 586 KB]` marker; text/array results keep their exact previous shape), and the tool card renders the FILE from disk via the file viewer's `/api/file/raw` URL (lazy) — or a size chip when there is no path. Binary never enters a normalized message or the DOM again.

## 2.369.34
- **Fold summary names every kind, image views fold too** (owner: "5 bash, 3 web searches, 5 file reads, 2 image reads"): the run header's per-kind counter only initialised the kinds it knew — a `search` card counted `undefined++` = NaN and silently vanished from the summary. Every classifier kind is initialised now, the labels read "N Bash · N web searches · N file reads · N image reads · …", and `image` is a new fold kind (default ON): claude `Read` of an image file (png/jpg/gif/webp/svg/…), codex `view_image`. Generated images (image_gen) and plan updates stay visible.

## 2.369.33
- **Web searches fold** (owner report: a session with 42 WebSearch cards, none folded): the chat's semantic fold gains a `search` kind (default ON) — claude WebSearch/WebFetch, codex `web_search`/`web_fetch`, ACP tool kind `search`; claude Grep/Glob/LS now count as reads and ToolSearch as MCP housekeeping. Before, every one of those returned null from the classifier, which not only left the card visible but BROKE the surrounding run so neighbouring reads/commands stayed unfolded too. Users who customised "Card kinds that collapse" need to tick the new kind once.
- **Weekly reset times are projected** (owner ask "记一下 reset 时间之后 estimate"): weekly windows (7-day + model-scoped) reset on a fixed 7-day anchor per account, so when the CLI's /usage panel omits the reset (a bucket at 0%) the last observed weekly reset is carried forward (`projectReset`, marked "≈" with a tooltip). 5-hour windows are not projectable — they start with the first request — so those keep "not started". An account that never showed a weekly reset (PandyMax today) has nothing to project until its first reading.

## 2.369.32
Owner-reported batch (six reports, 2026-09-05 afternoon):
- **Codex model continuity** ("I picked GPT-6, the view says 5.6"): a codex resume that carries no explicit model now keeps the model the thread LAST ran on (`lastCodexTurnModel` = the rollout's last turn_context, the wrapper's own authoritative record) instead of the app-server's thread.model (= the START model); the wrapper pins a user-chosen model (spawn env or set-model — `meta.modelPinned`) so a thread/resume or thread/name/set response can never revert it. The reported thread itself ran its first three turns on gpt-5.6-sol (no model was recorded at its 10:34 start) and switched to gpt-6-astra at 12:50 — the facts are in its turn_context records.
- **Sidebar hides sub-agent threads by default** (codex sub-agents flooded the list): the agent-kind filter defaults to PRIMARY; ALL is an explicit, persisted choice.
- **Codex ⟳ refreshed Claude's quota**: the codex button carried both classes and the generic handler matched first — the specific class now dispatches first.
- **Auto-resume's continue prompt is attributed to VibeSpace** in the chat (a labelled card: "VibeSpace auto-resume — sent automatically after the usage limit cleared") instead of an anonymous user bubble — it is the CLI's own continue wording, sent by the server, never typed by the owner (claude + codex normalizers carry originKind 'auto-resume').
- **"?" reset times on a freshly reset account**: a bucket at 0% has no running window, so the CLI's /usage panel reports no reset time — the popup now says "not started" (tooltip explains) instead of "?".
- Analysis of the wall-vs-switch episodes is in the session report (the pool evaluated the session's LINKED member while the CLI was actually on another org — OTel re-attributed 193 readings; proposal parked in the backlog).

## 2.369.31
- **Harness S3 — descriptor STORE + codex facts off the hot path + zstd rollouts** (docs/design-harness-plugins.md §2.4 S3 and the §1 P2 rows "discovery hot path" / "remote codex names+liveness"; started by a worktree agent, finished solo). Each harness descriptor's `store` now declares `discover({activeSessions,webuiPids,devSnap})`, `locate(id,cwd)`, `createReader`/`Reader`, `forkChain(id)`, `writerSweep(rid,shq,opts)`, `remoteFind(id)` (find(1) root + predicate + cache name); routes/sessions.js iterates the registry and merges (the claude lock-first sweep moved VERBATIM to session-store.discoverClaudeSessions; the codex listing runs its rollout walk + /proc liveness scan in the transcript worker with a per-directory mtime cache — the 5s poll no longer touches ~/.codex/sessions on the loop); transcript-service locates and fetches through the descriptor (`hosts.fetchTranscript(host, backend, id)` is THE remote fetch; the two legacy methods are shims). **.jsonl.zst rollouts (codex ≥0.153)**: discovery-facts gains `zstdDecompressFrames` (every frame, skippable frames stepped over, output capped → EZSTBIG) and `readHeadText` (bounded compressed prefix); adapters/codex locates `.jsonl.zst` twins and materializes them ONCE into a per-user temp cache so the whole seek family runs unchanged; the usage walker module + the shipped scanner count compressed rollouts in lockstep (cursor = plain offset + compressed size); an older node simply skips them. **Remote codex names + liveness**: the ssh discovery script and the daemon snapshot emit NC lines (first user records, zstd(1)/readHeadText for compressed heads) and CO lines (rollouts held open by a codex process); `interpretDiscoveryLines` names threads through the ONE codex naming rule (`deriveCodexSessionName` moved to discovery-facts; injected blocks skipped, truncated lines still name) and marks CO threads `remote-running` (Resume refuses the double-writer). Gate: scripts/test-codex-zst.mjs (44: readers, walker/scanner parity incl. incremental append, NC/CO interpretation + snapshot synthesis, a 2000-rollout async listing with a main-thread stall watchdog, store contract + wiring pins). Not in this slice (B-21e4 remainder): forked_from_ordinal, effort enum hints, thread/resume exclusions.

## 2.369.30
- **Plugin Ph4 + the Ph2 remainder — trusted tier, consent, contributions, install sources, capability enforcement, remote shims** (docs/plugins.md is the user-facing reference; design §3.3 Ph2/Ph4 rows closed). Manifest (PURE validator): `client: "module"` = a TRUSTED same-origin ES module (`clientEntry`, `activate(api)` / `deactivate()`, the small host API documented in plugin-client.js + docs/plugins.md); `contributes.settings[]` → Settings window category "Plugin: <label>" as `plugin.<id>.<key>` (registerPluginSettings, torn down on disable); `contributes.themes[]` → JSON theme files registered as "<label> (plugin)" (ThemeManager.registerPluginTheme, own `plugin-*` namespace, pending plugin theme survives boot); `capabilities.server` normalized (`~` expansion, no `..`, a path covering VibeSpace's install/data dir is refused). **Consent**: enabling a module plugin or any plugin with declared capabilities returns 409 `consentRequired` with the plain-words capability list (capabilitySummary — the same items on server and client); the panel's dialog re-enables with `trusted:true`; the registry stores `{trusted, trustedAt, capabilitiesHash}` and a manifest whose consent surface later changes is switched off at discovery with a notice (drift = re-consent). **Enforcement**: plugin server processes fork under `node --permission` with allowlists = plugin dir (read) + data dir (rw) + declared fs paths, `--allow-child-process` only when declared, NODE_OPTIONS stripped; an undeclared access fails inside the plugin with ERR_ACCESS_DENIED and is classified into the panel's error line (network is declared-only — said so in the dialog and the docs). **Install sources** (src/server/plugin-install.js, ONE staging pipeline): local path / git (execFile shallow clone, https+ssh forms only) / `.vsp` upload (multipart, unzip with a Zip-Slip listing audit) / GitHub release (`owner/repo[@tag]` → the `*.vsp` asset); symlinks and size caps refused; a previous copy MOVES to data/plugins-trash (never deleted); update re-runs the recorded source; uninstall trashes plugin + state and drops the registry rows. **Remote shims**: plugin agent-tool shims ship to ssh hosts and dial devices with the core tools (HostManager.agentTools() = static list + loader.shimNames(); ws-create distributes it) and bake the instance's public URL (instance-url.js, regenerated on change) as the call-back fallback — with neither VIBESPACE_API nor a public URL they fail with a clear message. Panel: Install plugin… dialog, ⋯ → Show capabilities… / Update / Uninstall (confirmed), tier + trust badges, notices, client-module load errors; zh/ja. Loader also handles the child IPC 'error' event (ERR_ACCESS_DENIED crash loops racing a disable would otherwise throw in the HOST). Gate: scripts/test-plugin-trust.mjs (real fixture plugins: consent 409 → trusted → module 200/403, theme serving, --permission granted vs denied path, drift re-prompt, install path/zip/Zip-Slip/symlink/update/uninstall-to-trash, shim baking, client pins) + test-plugin-loader updated. The hello example now contributes a setting and a theme. Started by a worktree agent (validator/installer/loader/settings/themes), finished solo after the subagent limit.

## 2.369.29
- **Harness S8 — the generic ACP v1 harness, OpenCode first** (docs/design-harness-plugins.md §2.3; owner decision: OpenCode over Gemini CLI, whose consumer OAuth is gone). New backend `opencode` = `acpHarness({...})` (src/harnesses/acp.js factory + src/harnesses/opencode.js): the SHARED pieces serve every Agent Client Protocol agent — `data/bin/acp-wrapper.js` (runs `opencode acp` under dtach like the codex wrapper: JSON-RPC 2.0 over the child's stdio, `initialize` with NO fs/terminal capabilities, session/new|load|resume by advertised capability, prompts with text+image blocks, request_permission → ordered options, session/cancel, set_config_option for model/mode/thought_level with LOUD unsupported/rejected notices, fs/terminal requests refused cleanly, the task-context prefix + stop-time nudge, every stdin verb incl. `_frame_file`/`_stdin_ack`/peer-message; journals one `{type:'acp', kind}` record per line to stdout + the buffer file — that journal IS the history, ACP exposes no transcript read API), `src/acp-message-manager.js` (normalizer: tool_call kinds → Read/Edit/Bash… cards with the chat view's fold kinds, thought chunks → thinking, plan → todos, available_commands → slash commands, usage_update → context %, request_permission → the harness-neutral permission card with ORDERED options; + `AcpSessionMessages` store reader over the buffer), `src/adapters/acp.js`, the `acp-events` consumer in session-stdout (id adoption from the `session` record, streaming from prompt_start/end, activity label, todos, the agent's offered models into /api/available-models, peer honesty re-stash, feedLive). cli-env resolves each ACP executable once (`OPENCODE_CMD` override); /api/home reports installed harnesses so the New Session picker only offers OpenCode where the CLI exists; ws-create refuses an uninstalled harness before any spawn. Client: BACKEND_META.opencode (brand mark, modes build/plan, modelsFromAgent, no effort/fork/review/accounts chrome), settings `opencode.defaultModel/.defaultPermissionMode/.defaultExtraArgs` (zh/ja), and the permission card now renders ordered options (replying with the chosen optionId) for any harness that sends them. Gate: scripts/test-acp-harness.mjs (72: the REAL wrapper vs scripts/dev/mock-acp-agent.mjs over pipes — new/load/prompt/permission/cancel/config/fs-refusal/frame-file/peer/boot-failure, normalizer + store shapes, wiring pins); conformance suite 92→124 with opencode as the third chat harness (creds:null ⇒ META caps.accounts false + no pool). Manual live check: scripts/dev/acp-e2e-live.mjs (spends a real turn). Not in this slice: sidebar discovery of STOPPED OpenCode conversations (no transcript files — resume works through the window's own session id) and remote/dial spawns of ACP harnesses.

## 2.369.28
- **test-tool-toggles back in the gate** (B-0e1b): the suite pinned a literal '3 CLIs' / 'one CLI' heading and rotted silently since jobs joined the taught set in 2.342.0 (it was never in scripts/ci.mjs). It now pins the SHAPE — a dynamic count that shrinks by exactly the number of disabled tools — plus the core status/ask/task teaching, and runs in the release gate.

## 2.369.27
- **Harness S2 complete — accounts.js is harness-neutral** (docs/design-harness-plugins.md §2.4 S2): the descriptor `creds` now also carries `files` (what an account dir ships/backs up), `bumpFile` (creds-mtime bump on a pool symlink swap), `hostFactsKey` (which hosts.js facts bucket holds the login email), `longLivedToken` (oat accounts exist), `supportsApiKeys`, `remoteSymlinks`/`ensureTargets`/`probe` (the remote-ship shape) and `seedDir(dir)` (claude: onboarding-complete .claude.json; codex: sessions/config.toml symlinks into the shared home — `sharedHome()` lives on the codex descriptor). accounts.js: ONE subscription branch in list() (authMode rides where the reader reports it, oat meta where the harness has one), export/import/delete/verdict/pool-swap/spawn-env/remoteCreds all read the descriptor (`_remoteCreds(be,id,a)` builds the ws-create ship shape — `shippable` only exists for keychain-sensitive harnesses, codex's shape is byte-identical), `createPool` validates the backend against capsOf().pool + the registry (unknown ids throw), the oat gates use `longLivedToken`, and the remote account-cleanup `rm` lists every registered harness's dir family. Still backend-dispatched by design: `resolveForSpawn` (claude's oat/api-key ladder vs codex's CODEX_HOME resolve) and the claude-only `hostSubs` held-check (hosts.js probes only claude dirs). test-harness-contract 87→92 (remainder descriptor completeness, seedDir on a fresh dir for both harnesses, accounts.js source pins); test-codex-pool pin updated (no codex branch left to order against).

## 2.369.26
- **Harness S2 first slice — credential mechanics on the descriptor** (docs/design-harness-plugins.md §2.4): each chat harness now carries `creds` = { subsDirName, authFile, spawnEnvVar, loginLabel, defaultIdField, keychainSensitive, parseAuth(dir) [, parseAuthFile] } (claude: `subs`/`.credentials.json`/`CLAUDE_SECURESTORAGE_CONFIG_DIR`; codex: `codex-subs`/`auth.json`/`CODEX_HOME`, id_token JWT parse). accounts.js reads dirs/auth/labels/default-account fields through `_credsOf/_acctDir/_readAuthFor` — 13 mechanical `backend === 'codex' ? … : …` sites gone (list() pool identity, verdicts, pool link/member dirs, import dir, default-account field, pool-create error label). readSubCreds/readCodexSubAuth/_parseCodexAuthFile stay as thin shims over the descriptor.
- **Conformance pins that never landed**: the S7 pins (settingsPrefix client⇄server, no `codex ? 'codex' : 'claude'` collapse in src/lib, account surfaces gated on META caps) were in a patch batch that aborted before reaching the suite in 2.369.23 — now in test-harness-contract with the S2 pins (creds descriptor completeness, parseAuth on an empty dir never throws, claude/codex fixture parses, accounts.js source pin). The last collapse (pool members dialog filter) derives the backend from the pool row. test-harness-contract 76→87.

## 2.369.25
- **Plugins panel lists manifest plugins** (⚙ → Plugins / the rail's Plugins panel): every folder under `data/plugins/<id>/` with its id/version/description, state (running / starting / crashed–restarting / parked / disabled / invalid — invalid ones show their validator errors, never hidden), Enable/Disable, Rescan, the contributed agent-tool shim names, and an Open button per contributed window. zh/ja strings. test-plugin-loader 47.

## 2.369.24
- **Plugin system Ph2 (minimal loader) — docs/design-harness-plugins.md §3.** A plugin is a folder under `data/plugins/<id>/` with `vibespace-plugin.json` (validated by the PURE `src/plugin-manifest.js`: `<publisher>.<name>` id = folder name, semver, `engines.vibespace` minimum, `client: none|iframe|trusted`, `server: true|false`, `contributes: { windows[], agentTools[], routes }`, declared `capabilities`; reserved contributions warn). `src/server/plugin-loader.js`: ① iframe-tier assets served at `/plugins/<id>/…` from the plugin's `ui/` under the SAME opaque-origin sandbox CSP as published pages (never allow-same-origin; path-traversal-proof, no-cache); ② `server: true` forks `server.js` as its OWN process (IPC-only API v1: `route` / `tool` / `shutdown`; crash restart with backoff, parked after 5 crashes in 10 min; stdout/stderr tagged in the server log); `/api/plugins/<id>/x/*` is proxied over IPC; ③ `agentTools` become generated executable shims `data/bin/vibespace-tool-<id>-<name>` that POST `/api/agent/plugin-tool/<id>/<name>` with the session's vsst_ token (the route is cookie-exempt and validates the bearer itself; the plugin never sees a credential); ④ enable/disable persisted in `data/plugin-registry.json`, every change broadcasts `plugins-manifests-updated`. Client (`src/lib/plugin-client.js`): each enabled iframe plugin's `contributes.windows[]` registers as a WINDOW TYPE (Ph1 registry) — a sandboxed iframe window with a tiny postMessage bridge (`ready/init`, namespaced `storage`, `notify` toast, `close`) — and appears in the ⚙ menu. Shipped example: `docs/examples/hello-plugin/` (one window, one proxied route, one agent tool). Not yet: trusted client modules (owner-approved tier, `plugins.allowTrusted`), contributed settings/themes/keybindings, install-from-URL UI, capability enforcement, teaching plugin tools in the agent intro, shipping shims to remote hosts — tracked in B-bb56/B-93f9. scripts/test-plugin-loader.mjs (43: validator matrix + the real example plugin lifecycle end to end + wiring pins).

## 2.369.23
- **Harness S7 (first slice) — client id-collapses → META descriptors.** `BACKEND_META.<id>.settingsPrefix` + `settingsPrefixFor(backend)` replace the `backend === 'codex' ? 'codex' : 'claude'` collapses (session defaults in app.js, the per-session config popover in session-card.js, the status-bar model picker) — a third backend read claude's defaults; the account surfaces (session-card account row, the billing switcher) gate on `caps.accounts` instead of an id list; the pool-members dialog filters by the pool's own backend. test-harness-contract 78 pins: no collapse left in src/lib, client settingsPrefix == server descriptor per chat harness.

## 2.369.22
- **Harness S6 — context-injection strategy per harness.** `src/harnesses/<id>.js` `inject` is now an object `{ kind: 'hooks'|'wrapper'|'acp', hookFile: {file(), createIfMissing} | null, hookEvents[], sessionStartHonoured }`: agent-tool-generators derives the hook files + events from the registry (claude registers SessionStart/UserPromptSubmit/Stop, codex SessionStart/UserPromptSubmit — codex's app-server has no blockable Stop hook and IGNORES SessionStart output), and agent-routes' four SessionStart seen-gates consult `inject.sessionStartHonoured` instead of `s.backend !== 'codex'` (a harness that ignores SessionStart must not burn its seen-gates; an unknown harness is never treated as claude). Zero behaviour change; test-harness-contract 75 pins the strategy shape + the wiring.

## 2.369.21
- **Codex P2, client side (docs/design-harness-plugins.md §1).** Onboarding counts named/pooled accounts for EVERY backend (`/api/backend-status` now reports `codex.namedLoggedIn`; the 2.267.4 fix was claude-only, so codex named accounts never satisfied the wizard) and offers the "Accounts & pool…" door for any installed backend; the billing switcher shows codex quota (per-account rows read the persisted codex buckets, the ChatGPT-login row the global codex quota) — users picked a ChatGPT account blind; **whole-thread fork is exposed for codex** (`backend-caps.fork` per harness, `_forkRequested` honours it, client META caps.fork true; a real-wrapper stub test pins that CODEX_WEBUI_FORK=1 sends `thread/fork` for the parent and adopts the child id); the permission-mode dropdown seeds per backend from `BACKEND_META.permissionModes` (an early click on a codex chat no longer offers claude modes). scripts/test-codex-p2-client.mjs (13).

## 2.369.20
- **Codex P2, wrapper side (docs/design-harness-plugins.md §1).** ① **Send while busy** — a chat-input during an active turn now rides `thread/queue/add` (runs right after the current turn; the lane peer messages already used) instead of `turn/start`, which codex either steered into the running turn or, for review/compact turns, rejected with ActiveTurnNotSteerable and the text was lost; the client gets a "Queued — runs after the current turn" notice under the bubble. ② **Slash commands** — the wrapper serves `/compact` (a REAL `thread/compact/start`, verified on 0.153.4, instead of a wasted model turn), `/review` (uncommitted changes), `/model`, `/effort`, adverts them in `wrapper_meta.slashCommands` and the normalizer patches the init card in place so the chat-input autocomplete shows them; "Compacting context…" / "Context compacted" cards + a minimap compaction marker. ③ **Live visibility** — `mcpToolCall` (as `mcp__<server>__<tool>`, folds under the mcp kind), `dynamicToolCall`, `webSearch`, `imageView` and `contextCompaction` items are recorded while the turn runs (function_call / function_call_output twins) — they used to appear only after a re-attach merged the rollout, leaving minutes of "thinking…". Also guarded a startTurn-vs-turn/completed ordering race (a turn that completed before its start reply resolved must not be re-marked active, or every later input would queue forever). scripts/test-codex-p2-wrapper.mjs (30: real wrapper vs a stub app-server that keeps the first turn active and pushes item notifications).

## 2.369.19
- **Harness S4 — QuotaSignalSource per harness.** `src/harnesses/{claude-quota,codex-quota,null-quota}.js`: each harness carries `quota = { normalize(raw) → {fiveHour, sevenDay, scopedWeekly…}, signalFromStream(record) → typed wall/quota signal, probe (caps rung: 'cli-usage' | 'rpc-rate-limits' | null), classifyAuthFailure }`; usage-routes binds the registry instead of defining normalizers of its own (old export names kept), and the pool engine's quota probe DISPATCHES on the identity's harness — a codex identity now refreshes through a live codex session's `account/rateLimits/read` (`codex-read-limits`) instead of spawning a pointless `claude -p /usage`; the wall-machine verification probe and the auto-resume pre-fire gate ride the same dispatcher. The registry gained `register/unregister/get/has/list` with quota-contract validation (plugin tier-5 seam). scripts/test-quota-source.mjs (91).
- **Plugin Ph1 — window-type registry.** `src/lib/window-types.js`: every window kind registers `{type, icon, replay(app, spec)}`; `replayOpenSpec` dispatches through the registry and an unknown openSpec action is a LOUD console warning + telemetry (`openspec-unknown`) instead of the silent no-default switch; `TYPE_ICONS` is a view over the registry. Core registers its own 14 kinds in the modules that own them (zero behaviour change; scripts/test-window-types.mjs 53 pins the exact type/action sets and that no switch/literal is left).
- Both slices were authored by implementation agents that hit the subagent usage limit mid-run; their worktree diffs were salvaged, unified with the S1 registry, and re-verified (registry/quota/pool/account/vendor-whitelist/client-boot/sidebar-rail suites + build).

## 2.369.18
- **Codex P1 parity batch + harness registry S1 (docs/design-harness-plugins.md; owner: "今天都给我弄好").** Four Codex gaps closed: ① **image paste / large frames** — the >64KB `_frame_file` bypass is capability-gated only (the backend-id exclusion of codex is gone); the codex wrapper serves `_frame_file`, adverts `caps.frameFile`, emits `_stdin_ack` per stdin line (the 5s broken-pty re-send no longer double-applies input) and turns an unparseable stdin line into a loud task_failed instead of a silent `continue` (test-chat-frame-guard 58: real codex wrapper against a stub app-server). ② **peer / notification cards** — CodexMessageManager.injectPeerCard (auto-resume notices, Background Work notifications, vibespace-msg cards now render in codex chats; the rpc-queue lane records a labelled peer message via the wrapper's `webui_peer` marker; test-peer-msg-card 52). ③ **codex pool UI** — accounts.list() evaluates the pooled branch first for every backend (codex pools were listed as bare ChatGPT logins with no target/members/auto/hot fields — the pool engine's auto tick never saw them), one shared pool menu in Manage Agents for both backends, `hotSupported` from backend-caps, mislabels in session-card/session-props/usage-meter fixed (test-codex-pool 61). ④ **resume double-writer guard** — the resume-already-live guard covers codex (thread/resume REUSES the thread id; the old "codex forks on resume" exemption was false), and the writer sweep gained codex legs: /proc fd scan for an open `rollout-*-<threadId>.jsonl[.zst]`, an argv leg for `codex resume <id>` / orphaned wrappers, with a PROTECT list of live VibeSpace codex sessions (an app-server keeps every rollout of its thread tree open for its lifetime — sweeping a finished sub-agent thread must never SIGTERM the live parent); ssh-script parity kept (test-writer-sweep 43). **S1 harness registry**: `src/harnesses/{index,claude,codex,shell}.js` — one descriptor per harness (identity, caps row, Adapter + config mapping, Normalizer, wrapper path, store/locator, settings prefix, injection strategy); adapters/index.js and normalizers.js are built from it, unknown ids throw; scripts/test-harness-contract.mjs (70) runs the same descriptor/adapter/normalizer/wrapper/store/client-META assertions over every registered harness. **Codex 0.153.4**: gpt-6-astra leads the codex model lists; the 0.153.x `<recommended_plugins>` first-user-message injection no longer becomes the session name; scripts/dev/codex-e2e-live.mjs (manual, spends one real turn) verified a gpt-6-astra chat end to end incl. `vibespace-status` from inside the sandbox. Design doc §2.3 records the second harness survey's verdict (ACP v1; OpenCode first — Gemini CLI's consumer OAuth ended 2026-06-18 and Antigravity CLI has no ACP) and §4 the owner's decisions.

## 2.369.17
- **Codex sessions could not reach the VibeSpace agent tools (P0 of docs/design-harness-plugins.md).** The codex chat wrapper started every thread and turn with `sandboxPolicy {type:'workspaceWrite'}` (or `readOnly`), whose network policy defaults to closed — and codex's seccomp filter closes loopback too (measured on this machine: `connect 127.0.0.1` → EPERM with `CODEX_SANDBOX_NETWORK_DISABLED=1`; AF_UNIX is blocked as well). Every vibespace-status/-task/-ask/-job/-msg/-page/-docs call from a default / safe-yolo / read-only codex session therefore failed, while the wrapper kept injecting the tools intro each turn and the Stop nudge kept asking for bookkeeping the agent could not do; only yolo worked. Fix: the wrapper's readOnly/workspaceWrite policies carry `networkAccess:true` whenever the integration is on (`VIBESPACE_API` set by the spawner) — filesystem sandboxing unchanged; the TERMINAL path pushes the bare TOML override `-c sandbox_workspace_write.network_access=true` (the JSON-quoted form is a string, not a boolean); and the boot-time sandbox probe is now FUNCTIONAL (`codex sandbox -- true`, async) instead of a PATH lookup for `codex-linux-sandbox` that "failed" on every npm install and silently ran terminal 'default' sessions with danger-full-access while chat was sandboxed. Gate: scripts/test-codex-sandbox-net.mjs (real `codex sandbox` A/B when the binary is present, evidence-SKIP otherwise + static pins; the probe reports through a file because Node's socketpair stdio is swallowed by the network-disabled seccomp filter — a stdout-based control silently reads as "no output").
- **docs/design-harness-plugins.md** — the 2026-09-05 research (8 agents): Codex support-gap matrix (P0–P3), the HarnessDescriptor abstraction layer + conformance suite + ACP as the generic third-party harness protocol (Gemini CLI first; Claude never via ACP), and the VS-Code-shaped plugin system (manifest, derived activation, five isolation tiers, contribution points mapped onto existing registries). Tracked items filed in the backlog; four owner decisions listed in §4.

## 2.369.16
- **Post-restart attach storm no longer stalls the server, and a stall no longer kills the client (userW inc-mtndq0vb "一些 session 无法打开也没法 terminate，卡死了").** Forensics: the "stuck" session's process tree was alive and its socket connectable; the server had restarted 3 minutes earlier (self-update to 2.369.15). After a restart, every chat session's FIRST attach ran a synchronous `convertHistory` over its whole transcript on the main thread (this instance: 58 live sessions, 1.35GB of transcripts, 10–56MB each) — a desktop switch re-attached 19 windows and the event loop stalled for ~4 minutes (attach-acks arrived in 32s bursts, `attached` replies 4 minutes late). The 30s heartbeat then saw the pong it could not have read during its own stall, TERMINATED the live client, and the inbound frames still queued on that socket (the second attach, both kills) were dropped — the client reconnected into another re-attach round: blank window, Terminate a no-op. Three layers: ① **time-sliced first-attach rebuild** — `MessageManager.convertHistoryAsync` / `CodexMessageManager.convertHistoryAsync` yield to the loop every ~25ms; `normalizers.rebuildHistory(session, id, records)` is single-flight (concurrent attaches await one promise) and arms `session._rebuildQueue` so live records arriving mid-rebuild are held and replayed IN ORDER afterwards; `_historyLoaded` is still set only after success. Every live-feed site (stdout parse ×2, chat-input echo, permission payload) now goes through `normalizers.feedLive(session, msg)` — never `processLive` directly. ② **stall-aware heartbeat** (`src/server/ws-heartbeat.js`): a tick that fires >5s late is a no-terminate round (everyone re-pinged, judged next tick) — a missed pong measured across our own stall is not evidence; real half-open detection is unchanged. ③ **reliable kill**: the server now replies `killed {ok}` to the REQUESTER (ok:false = not found; `exited` only ever reached attached clients), and every client kill path (sidebar/taskbar/card Terminate, close-to-terminate, restart-with-permission, pool restart) routes through `app.killSession(webuiId, backendSessionId)` = `ws.request(..., {resend:true})`, re-sent on each reconnect until acknowledged. **Adversarial review (5 lenses) then hardened the design:** rebuilds run FIFO (fair round-robin slicing made every window land at the total time, past the client's 2-minute ladder — serialized, the first windows open in seconds) and the server re-acks every 10s with `{progress:{done,total}}` while a session waits/converts, the client ladder treating a fresh ack as proof of life (bounded 15min); the attach re-checks liveness after the rebuild (`error code:'ended-during-attach'` instead of a live-looking window on a session killed meanwhile); peer cards (Background Work notify, vibespace-msg, auto-resume notice) and auto-resume's continuation prompt go through the same gate (`feedPeerCard` / `feedLive`) — they wrote mid-history before; a failed rebuild still drains the held records; codex's async rebuild isolates per record; view-only, subagent and HTTP (`transcript-service.view`, which now joins an in-flight rebuild) converts are async too — no synchronous whole-transcript work is left on the main thread; the heartbeat got a second detector (a 1s loop-gap pulse taints the round — tick lateness alone had a blind band: a 30–35s block starting right after a ping ends with the tick only seconds late but the pong still unread) plus a bound (a client pong-less across 6 tainted rounds is still reaped) and logs/telemetry on every termination; the kill ack carries the id the client ASKED for (`sessionId` = requested, `resolvedId` = after the 2.179.0 stale-id remap — replying with the remapped id would have orphaned every stale-id kill), the client's 3-minute watchdog now DISARMS the request, and the backendSessionId frame is a one-shot sent before the resend-chased plain kill, so a resend can never kill the conversation's resumed successor. New gate suite scripts/test-attach-rebuild.mjs (45: sync/async parity on a 7500-record transcript with loop-turn proof, gate ordering + FIFO + peer cards + failure drain + malformed-record isolation, heartbeat matrix incl. the blind band and the bound, wiring pins across server.js + src/server for zero direct normalizer writes).

## 2.369.15
- **Stranded writes under a disconnected storage — quarantine + guard (owner's OneDrive `is not empty, use --allow-non-empty` failure).** Diagnosis: the mount point was not a stale fuse endpoint, it held REAL files — the task store's generated `.vibespace/TASK.md` recreated `<mountpoint>/…/AIContext/.vibespace/` on the bare local directory while OneDrive was disconnected (the boot regeneration runs before mounts exist, and every task change regenerates); rclone then refused every reconnect, and `--allow-non-empty` would only have hidden the files under the mount. Three layers: ① **connect quarantines leftovers** — `_ensureMountpointDir(mp, {quarantine:true})` (rclone AND cephfs connect paths; the mount-point EDIT path never quarantines) moves the whole directory aside to a sibling `<mountpoint>.stranded-<timestamp>/`, recreates the mount point empty, and broadcasts a level-2 server-notice naming the path and the items (never deletes, never merges; a dead fuse endpoint makes the `ls` fail ⇒ falls through to the stale-daemon kill); ② **`mounts.shadowedBy(path)`** = the registered storage whose mount point contains the path but is NOT mounted (gmail folders + credential-only records excluded; `isMounted(m, live)` takes a pre-read /proc/mounts) — `files.js` refuses every explorer/editor/upload op under it with 503 "“X” is not connected — this folder is its mount point" instead of writing into the bare dir; ③ **the TASK.md mirror skips shadowed context folders** (`isPathShadowed` dep, lazy TDZ-safe getter from server.js; warned once per group + telemetry `ctx-md-skipped-shadowed`) and `syncAllContextMd()` re-runs once mounts exist and on every `mounts-updated` broadcast, so the skipped file lands the moment the storage is back. New gate suite scripts/test-mount-stranded.mjs (26: real temp-dir quarantine incl. dotfiles + idempotence + edit-path negative control, predicate matrix incl. \040 escaping, writer guard + retry, wiring pins).

## 2.369.14

- **/design works again on Claude Code ≥2.1.257** (owner hit "设计工具包未就绪: design skill text not found in the CLI binary"; parked as B-6ee8 when the CLI auto-updated). Those builds no longer embed the skill as a JS template literal: the three pieces are ZSTD FRAMES inside the bun binary (`/$bunfs/root/SKILL-<hash>.md.zst`, `seed-canvas.mjs-<hash>.txt.zst`, and the 2.4MB editor payload — verified by a full-frame scan: skill 56KB with its frontmatter intact, helper 40KB, payload ends `</html>`). design-kit gains a zstd rung behind the old anchors: every zstd magic is a candidate, junk fails to decode in microseconds, the three pieces are classified by their heads (frontmatter `name: design` / `// Design-canvas seeding helper` / `<!doctype html` + `id="appifact-doc"`); 176ms on the 220MB binary, cached per CLI version. Older CLIs keep the template-literal path; Node <22.15 (no zlib zstd) says so plainly. The evidence-SKIP in test-design-kit no longer triggers — the suite's full extraction/seed/check legs run again (33).

## 2.369.13

- **Mobile Task-Groups tab no longer renders 500px icons** (owner: "任务组的手机版界面非常丑陋"). The Folders tab's mobile card icon carried inline sizing; the Task-Groups tab's icon carried only a class (`mobile-folder-icon`) that had NO CSS rule — an unsized SVG in a flex row scales to its viewBox and swallowed the whole row (giant icon, group name squeezed to 0px, one group per screen). One rule sizes it like Folders (18px, no shrink). Verified on a 412px viewport: icon 18×18, row 51px, group name + counts + chevron on one line.

## 2.369.12

- **Sharing a folder onto a Mac: real errors, `~` mountpoints, and a FUSE-less path** (inc-mtl78uhs, userW: "无法mount vibespace文件夹到mac" — the dialog only ever said "Daemon timed out … daemon exited with error code 1"). Three fixes on the push-mount path: ① `rclone … --daemon` detaches its child's stderr, so the child's REAL failure reason was lost forever; the daemon now logs to the same file the dialog tails (`--log-file`), and every failed rung's message is shown. ② A mountpoint typed as `~/x` or `$HOME/x` now resolves against the MACHINE's home (argv-form mkdir used to create a literal `~` directory and the quoted rclone path never expanded it either), and a trailing slash is dropped (the mount-table liveness probe compares bare paths — a `…/x/` mount would flip to "GONE" forever). ③ macOS gets a mount LADDER: `rclone nfsmount` first (rclone ≥1.66's built-in NFS server + the OS's native NFS client — no kext, no macFUSE approval dance), then FUSE `rclone mount` when macFUSE is present, then native `mount_webdav`; the device rclone pin moves v1.65.2 → v1.69.3 and an owned pre-1.66 install is re-installed (a system rclone is never touched). Pins in test-machine-migrate.

## 2.369.11

- **Published pages work offline + get a large-blob storage lane** (owner traveling into no-signal areas; 生活方式助手's request for the trip handbook). ① A **scope-limited service worker** (`/p/sw.js` — its location caps the scope at `/p/`, so it can never intercept the app, `/api` or `/ws`) makes the shell + raw pair open without signal: network-first with a 4s race falling back to cache — online keeps auth enforced and content fresh, weak-signal/offline serves the last good copy (and a timed-out slow response still back-fills the cache when it lands). The shell shows a subtle 6s "✓ offline ready · <cached at>" badge once a cached copy exists. ② **`vibeBlob`** joins the bridge protocol: large values ride IndexedDB (`vibespace-pages`/blobs, keys namespaced `<pageId>:`), fetched ON DEMAND (`{vibeBlob:'get',k}` → `{vibeBlob:'val',k,v}`) instead of replayed wholesale — sized for 10-30MB map-tile caches that localStorage (~5MB strings) cannot hold. Sandbox red line untouched as ever. Deliberate deviation from the proposal, told to the proposer: cache-first was downgraded to network-first-with-fallback so an online logged-out browser can never read a private page out of cache. test-published-pages 78→81.

## 2.369.10

- **Mobile desktop switcher shows real window lists/counts on first open** (inc-mtfici94, owner: "手机上重新加载页面后第一次切换桌面不展示session列表…没切换到过的桌面都展示 0"). Two bugs: ① the window snapshot was captured ONCE when the popup opened, so after a switch materialized a desktop's lazy-replayed windows the list still rendered the stale snapshot (reopening "fixed" it) — it is now computed fresh on every render, plus one more render ~700ms after a switch (lazy replay materializes on a timer); ② desktop tab counts only counted LIVE windows, and un-visited desktops keep their windows in `_savedStates` until the first switch — saved-but-unmaterialized windows now count too.

## 2.369.9

- **Mobile desktop switches no longer land on an old conversation position** (inc-mtfi6034, owner: "手机上每次切换桌面后默认窗口总会停留在奇怪的过去的对话位置而不是最新的"). The capture shows the mechanism: touch scrolling near the top had paged the window UP (`extendTop` + `trimBottom` removed the tail messages — `windowEnd` fell behind the live total), so the suspend-resume re-tail introduced in 2.369.1 scrolled to the bottom of the RENDERED window, which was 17+ messages behind the conversation. A pinned view now returns to the LIVE tail on resume: behind-the-tail (or teleported) windows take the full `jumpToBottom` (refetches the tail slab); tail-anchored ones keep the cheap scroll. Pin in test-chat-trim-guard (15).

## 2.369.8

- **One-click session restart + locate, everywhere the owner reached for it** (owner UX feedback: applying a "next resume" style pick meant hunting the sidebar entry among dozens, terminating, watching the entry move, re-finding it, resuming). Four pieces: ① the **style menu** shows a "⟳ Restart now to apply (Terminate + Resume)" row whenever a pick is pending (the menu stays open after picking so the row appears in place); ② new `restartConversationInPlace` — kill → wait for the transcript flush → resume the SAME conversation (the pool cold switch's field-proven machinery); per-session config (style, auto-resume, account) rides the respawn automatically; ③ the **window-title right-click menu** gains common session ops: Restart / Terminate / Resume (dead sessions) / Locate in sidebar / Session properties; ④ the **sidebar card menu** gains Restart for live sessions, and `locateSessionInSidebar` jumps to Folders, expands a collapsed group, scrolls the entry into view and flashes it. Design note: title-bar single-click was left alone (it conflicts with drag/focus) — locating rides the right-click menu instead. zh/ja strings added; pins in test-auto-resume (86).

## 2.369.7

- **Published pages gain a geolocation + persistent-storage bridge — sandbox untouched** (B-74de, owner-directed via 生活方式助手's verified spec while traveling; consumer: the trip handbook page's GPS blue dot). The 2.366.1 shell IS the privileged real origin: it now ships a per-request-nonce'd postMessage bridge (`script-src 'nonce-…'` added to the shell CSP) forwarding a geolocation watch stream and per-page-namespaced localStorage (`vp_<pageId>_` keys) into the sandboxed iframe. The red line stands exactly: the iframe never gains `allow-same-origin`, the raw route's CSP is untouched, and NO user content enters the shell (interpolations = ID_RE-validated id + our own nonce). Message source is verified (`e.source === iframe.contentWindow`); pages cannot read each other's keys. Accepted trade-off (spec §安全): any published page may surface a geolocation PROMPT on this origin — the browser still asks. Protocol (frozen, consumer already shipped): `vibeBridge:'ready'` (+ geo flag + stored data on load) / `vibeGeo:'start'|'stop'` → `'pos'|'err'` / `vibeStore:'set'|'del'`. E2E-verified by the proposing session (playwright, CSP-replica harness: opaque origin preserved, blue dot, persistence across reloads). test-published-pages 75→78 (bridge + source-check/namespace + per-request nonce).

## 2.369.6

- **A confident blocked verdict gets verified too** (inc-mtdsoj5f, userW on 2.369.4: "我有账号还活着，但是它觉得我账号都死了…去 agents 那里刷新一下就认出来了" — his pod's journal shows the wall machine working exactly as coded: `[wall] walled turn → blocked until 2026-08-31` off a stale cache that read an ALIVE member as dead-with-a-far-weekly-reset, so sessions armed a 2.6-day wait while the honest notice said "5h 100%, 7d 5%, Fable 96%"). The probe rung only fired when `blockedUntil` was UNKNOWN — but a cache that lies confidently is exactly as wrong as one that says nothing. BLOCKED entry now also fires ONE throttled verification probe (10min floor per scope) alongside the arm: usable ⇒ the near-fire path takes over within seconds, genuinely blocked ⇒ the arm stands corrected with fresh numbers. Self-heals the manual-⟳-fixes-it class for both userW's lockup and the owner's earlier "100% 其实 0%" flap. test-auto-resume 81→82.

## 2.369.5

- **VNC desktop pointer offset under DPI scaling fixed** (inc-mtdrm922, userW's report, owner-reproduced at DPI 90%: right-click on the in-container desktop and the remote XFCE menu highlights one row ABOVE the cursor). Under the body DPI zoom, noVNC mixes viewport px (`clientX`/`getBoundingClientRect`) with layout px (`clientWidth`) — the remote pointer lands ~zoom× off, growing with distance from the canvas origin. The desktop window's content container now carries `zoom: calc(1 / var(--ui-scale, 1))`: the canvas lives at NET zoom 1, every coordinate space coincides, the framebuffer maps ~1:1 to device pixels (sharper as a bonus), and a live DPI change stays correct (var()-reactive; calc-in-zoom verified in Chromium).

## 2.369.4

- **The wall machine was DEAD in production — the engine never exported it** (inc-mtd65xm3, owner: the heavy session stuck again with no auto-recovery + one account briefly shown 100% + the pool only switching after a manual refresh). The 2.369.0 wiring edit added `noteTurnEnd`/`noteWallSignal`/`beforeAutoResumeFire`/`quotaVerdictFor` to server.js's destructure but the ENGINE's return-list edit silently missed (the replace matched server.js's field order, not the engine's) — so session-stdout destructured `undefined`, every `noteTurnEnd?.()` no-op'd, `beforeFire` threw-and-defaulted, and not one `[wall]` line ever hit the journal. The sixth unstaged-wiring strike, and self-inflicted: every pin was a SOURCE grep (green — the functions exist in source) instead of a call-seam check. Fixed with `assert count==1` replaces; the suite now **instantiates the engine** with stub deps and asserts each machine function on the returned instance — a seam is verified by calling it, never by grepping for it. (The Personal-100% display flap is a separate estimator-overlay question — folded into B-cd7e with this capture as evidence.)

## 2.369.3

- **Desktop-switch jank, the render-cost leg** (inc-mtd54h45, owner: "切换桌面还是会卡顿" on 2.369.2 — the paging/rebuild storms are fixed, what remains is pure rendering). Under bare `visibility:hidden` the browser still styles/lays out the whole hidden tree every frame AND treats the `content-visibility:auto` message items as irrelevant, discarding their rendering state — so every switch re-measured the shown windows from scratch. Desktop-hidden CHAT windows now get `content-visibility: hidden`, which both skips the hidden subtree entirely (zero per-frame cost while hidden) and **preserves the cached rendering state** (the spec'd difference from `auto`) — a switch repaints from cache instead of re-measuring 600-message windows. Chat windows only (terminals carry WebGL canvases). Pin in test-chat-trim-guard (13→14).

## 2.369.2

- **Reconnect re-attach freeze fixed** (inc-mtd2pg6x, owner: "刚刚又卡死了" on 2.369.1 — the 5.5s stall co-timed exactly with a `state-resync`, i.e. a ws reconnect). A reconnect re-attaches EVERY session and each attach rebuilt its window's entire DOM — N chat windows × hundreds of messages synchronously, with zero content change (the trace shows three windows' pinned scroll restores mid-stall). `loadHistory` now recognizes an IDENTICAL slab (same normalizer epoch, same total, same head/tail message ids, tail-anchored window, not teleported) and skips the rebuild entirely — meta/status/live state/typing indicator still apply. The 2.369.1 suspend gate handled the desktop-switch paging storm; this closes the reconnect leg of the same "重渲染一切" family. Pins in test-chat-trim-guard (11→13).

## 2.369.1

- **Dialog vanishing mid-form fixed** (inc-mtd1c2sd, owner: "我选中个东西结果对话框没了 好难受"): the legacy shared dialog overlay closed on **click** with `target === overlay` — a text-selection drag that starts inside an input (the New-Session cwd field, in the capture) and releases outside fires the click on the common ancestor = the overlay, and the whole dialog vanished with the form contents. It now closes only when the interaction also STARTED on the backdrop (mousedown tracked; `createModalShell` keys on mousedown and was always immune).
- **Desktop-switch freeze tamed** (inc-mtd1d0ft, owner: "每次从工作桌面切换到个人桌面就会卡死一段时间" — the capture shows repeated 30-60s compositor stalls): on a switch every shown chat window's content-visibility state re-measures, geometry transits through scrollHeight≈clientHeight, and the paging machinery of 4-6 windows went wild simultaneously (fill-loops, extendTop storms, pin restores — the trace shows scroll 0→1408→668 churn at stall times). New suspend gate: a desktop-hidden ChatView makes NO paging/pin decisions (`setSuspended`, wired through desktop-manager hide/show + the stage un-hide writers); on resume the structural settle window arms (collapsedGeomSkip covers the re-measure) and a pinned view returns to the tail in one hop. Pins in test-chat-trim-guard (6→11).

## 2.369.0

- **Wall detection + auto-recovery rebuilt as a turn-granular state machine** (owner-designed after "你需要想一个更systematic的方法解决这个问题，而不是各种打补丁"; full design: docs/design-wall-machine.md). Replaces the 2.368.27-34 patch pile. Four pillars: ① the limit banner is a BOOLEAN signal only — no field is ever parsed from text again (parseBannerResetMs removed); ② **`quotaVerdict`** — the account system's ONE usability answer (account-pool-auto.js pure + engine `quotaVerdictFor`): purely from predicted remaining (estimator-overlaid, model-projected), usability line 5h<10% / weekly<5% (the pool engine's own THRESH hot tier — no twin), `blockedUntil` = MAX over dead buckets' future resets, pool = any-member-usable / MIN over members; ③ wall signals accumulate on the CURRENT TURN and the `result` record classifies it — walled (signals with no real work after the last one) enters BLOCKED, a normally-completed turn is sufficient proof the session is not blocked and unconditionally disarms (the record-granular noteWorked/30s-age hacks retire; the pool-rescued-mid-turn case classifies NORMAL by construction); ④ a missing reset time is filled by PROBING the owner-approved auto-cli /usage channel (0→30min→1h→2h, loud give-up), never guessed — and the pre-fire gate probes + re-verdicts, VETOING the spend when still blocked (auto-resume `beforeFire` now supports sync/async veto). Blocking identity = orgVerifiedKey (OTel-observed org over the pool link — the .33/.34 root cause). Retired: armBestReset/pickArmReset/isDeadBucket/noteWorked/parseBannerResetMs/the "already recovered" pre-check. test-auto-resume rewritten §8-10 (80), all neighbor suites green.

## 2.368.34

- **2.368.33's "already recovered" pre-check ate a REAL wall — removed, replaced by mechanisms that cannot** (owner: "这个会话撞墙了你没检测到也没继续" — journal 08:50:06: "pool already recovered onto a usable member — not arming", twice, then 9 dark hours). The check was unsound by construction: a live CLI holds its OLD token, so the org-verified banner marks the OLD member's cache dead while the pool LINK points at a healthy member — the check consulted the link and read "usable" on a genuinely blocked session. Now: arming is unconditional on exhaustion again; the 04:55-noise class is handled by ① a **delayed arm announcement** (the armed state + status chip are instant, the loud in-chat line waits 90s — a disarm inside the window means it never speaks) and ② **`noteWorked`**: the produced-work disarm is age-gated to >30s after arming, so the wall banner's own trailing assistant records can't kill a fresh arm while sustained post-arm output still disarms false ones. Plus precision the incident exposed: the banner's own "resets 12:40pm (America/Los_Angeles)" is now parsed (timezone-aware, rolls to tomorrow when passed) and feeds both the cache mark and the arm target — previously a now+5h guess while the exact time sat in the text. test-auto-resume 86→91.

## 2.368.33

- **False "已安排自动继续" announcements suppressed** (owner: "你是不是错误通知了？这里没被打断任何对话" — journal shows the 04:55:50 hot pool switch succeeding and the session continuing seamlessly, then ONE SECOND later the same rejection event armed the wait and announced it; and since the healthy account emits no rate_limit_events, nothing ever disarmed — a wasted continue message was left pending for 14:40Z). Two layers: ① `armBestReset` now checks whether the pool ALREADY recovered the session — when the session's CURRENT member (post-eval) has no dead bucket (shared `isDeadBucket` predicate with the picker; unknown cache never guessed), there is nothing to wait for and no arm happens; ② the most precise recovery signal there is: **any main-thread assistant record disarms an armed wait** (`noteSessionProduced`, engine → session-stdout — the readings-based disarm net misses accounts that emit no events at all). test-auto-resume 81→86.

## 2.368.32

- **Auto-resume waits for the RIGHT reset: max over the identity's DEAD buckets** (owner caught the premature fire: "重置的是7d用量上限，但它并没有和5h的对齐，所以在5h还在cd的时候发送了恢复消息" — armed for the 2:00am seven-day reset, fired, and bounced off "session limit · resets 4:40am"). 2.368.27's nearest-reset-wins was the wrong contract: a session unblocks only when ALL its dead buckets have reset, so within one identity the wait is the **MAX over dead-bucket resets** — a healthy bucket's nearer reset is not a candidate at all, and an earlier dead bucket's reset still leaves the later one blocking. Across identities (self + pool siblings) the soonest-USABLE member still wins (min over identities of max-over-dead — the c1206711 pool case is unchanged). `pickArmReset` rewritten to the identity contract (dead = utilization≥0.999 / status limited/rejected / usedPercent≥99.5, future resetsAt); `armBestReset` feeds it per-identity bucket sets (both scoped shapes). Plus the gap the incident exposed: the **limit-banner path never armed** — after the premature fire the "resets 4:40am" banner marked the cache dead and re-evaluated the pool but left nothing waiting; it now (re-)arms off the just-marked dead buckets. test-auto-resume 79→81 (the premature-fire shape and the healthy-bucket negative control are the fixtures).

## 2.368.31

- **The forever-'running' regression fixed at its true transport** (owner: "又开始出现大量已经完成的任务显示成在进行了" — reproduced live: 17 phantom-running in the field session's taskState). A BUSY agent's task completions never become the idle-wake user record the closers read — the transcript shape is `queue-operation`(enqueue/remove) records + an `attachment`(queued_command) carrying the `<task-notification>` in `content`/`attachment.prompt`. For a session that is always mid-turn (exactly the heavy-workflow ones), most completions rode ONLY those shapes and every rebuilt view kept the cards running. One closer (`_closeTaskFromNotification`) now serves all three transports in the normalizer AND the session-store scan; the queued delivery renders a notification card, never a "You" bubble of XML (provenance law). Plus two residuals the real data surfaced: ① a Workflow resumed via `resumeFromRunId` re-launches under the SAME run id — the resume's completion closed only the resume card, so the original stayed running; a same-id re-launch now supersedes the earlier card. ② `taskState()` treated wrapper live tasks as a FALLBACK — one live wrapper entry hid the entire history-synthesized set (observed as a 41→1 flap); it MERGES now (scan as base, wrapper overlay — the two-shape-payload law). Post-fix real-data check: 41 tasks, 1 genuinely running. test-task-lifecycle 13→19 (real transcript record shapes incl. the queue-operation/attachment lines).

## 2.368.30

- **Background Agent/Workflow/Bash tasks survive resume — recognized from HISTORY** (owner on c1206711: "很多subagent任务你没识别出来"). Forensics on the 602MB field transcript: the `task_started`/`task_progress`/`task_notification` SYSTEM subtypes are **live-stream-only — the file carries ZERO** — so after any restart every background launch froze as an anonymous ack card, the status-bar tracker was empty, and the 787 persisted `<task-notification>` user records had nothing to close. Now the launch ACK itself (which IS persisted) synthesizes the task: `parseBackgroundLaunch` (PURE, one parser shared by the normalizer AND session-store's taskState scan — no twin) recognizes Agent ("Async agent launched… agentId:"), Workflow ("Run ID: wf_…") and background Bash acks → `taskInfo` running; the persisted wakeup record closes it (status + **summary** captured, shown on the card). Real-data validation: 34 tasks recognized in the transcript tail, 18 closed with summaries, 33ms. Phantom cut: a synthesized 'running' whose launch predates the CURRENT wrapper start is dropped (an OS task cannot outlive the CLI process — the field data showed 16 forever-running watchers from previous wrapper lives). Agent/Workflow cards now show a lifecycle chip (⟳ running / failed states) and prefer the completion summary over the launch-ack first line.
- **Multiple running workflows collapse like tasks** (owner: "多个workflow在运行也应该支持像tasks那样收起来"): >1 running workflow renders ONE status-bar chip ("N workflows · done/agents") with a dropdown row per run (click → live workflow view); a single run keeps the direct chip. scripts/test-task-lifecycle.mjs (13, real-transcript fixture shapes) in gate.

## 2.368.29

- **Scroll-up white-screen in fold-heavy transcripts fixed** (inc-mtajy6wr, owner: "上翻的时候出现大量白屏"). With semantic collapse (2.368.22-24) folding whole tool/agent runs, a 150-message rendered window can amount to a couple of collapsed run headers — SHORTER than the viewport (the capture shows scrollHeight clamped to clientHeight, 787=787, on every landing). `_trimBottom`'s fixed 150-message cap then removed the only VISIBLE content on each upward page, and every wheel-tick teleported the window 50 messages deeper through fold-space (captured: ws 4572→4036 in ~6s) on a blank screen. Fix: while the rendered window is shorter than ~2 viewports the trim cap grows to 600 instead of trimming (fold members are hidden and cheap; 600 is the absolute DOM bound), applied symmetrically to `_trimTop` for downward paging. Content already on screen now stays put, headers accumulate real height, the scrollbar returns, and paging physics recover. scripts/test-chat-trim-guard.mjs (6) in gate.

## 2.368.28

- **2.368.27 was the wrong scope — the owner's correction is the real story**: the pool (hot) had moved the session onto a member whose seven-day quota then died, while the five-hour-exhausted SIBLING (seven-day fine) was the account to come back to; the pool even switched back on its own at the sibling's 5h reset — **but a hot re-point does not move an idle limit-blocked session**, and the session's wait had been refused, so it sat dead on a healthy account. Three mechanisms, all functionally tested + wiring-pinned (test-auto-resume 71→79): ① `armBestReset` now merges **pool sibling members'** future bucket resets into the candidate set (the freeing reset lives in the SIBLING's cache, not the current member's — 2.368.27 only read the session's own identity); ② a HOT pool switch (per-session pass AND pool-level default-link pass) calls `autoResume.fireNow()` on ARMED sessions — the continue is delivered the moment the pool lands them on a healthy account, instead of waiting out a reset that no longer matters (armed-only: an unarmed session was never promised a continue; cold switches keep restarting via the client); ③ the timed fire runs a new `beforeFire` hook (engine: `maybePoolAutoSwitch`) BEFORE spending, so the continue rides whichever member is healthy at that moment.

## 2.368.27

- **Auto-resume arms for the NEAREST known reset, and a refusal is no longer silent** (owner: "c1206711…这个怎么没自动恢复？" — full forensics in the session buffer). What happened: the session armed for its five-hour reset, 90s later an `allowed_warning` event (a request genuinely went through) disarmed the wait — correct — then the NEXT rejection carried the **seven-day** bucket's resetsAt (~100h out, org overage disabled), `armIfEnabled` refused it (MAX_WAIT 26h) **journal-only**, and nothing was left waiting — while the five-hour reset 8h away, sitting in the usage cache the whole time, is exactly what freed the sibling session that had kept its arm. Fixes: ① `pickArmReset` (PURE, in auto-resume.js) — candidates = the event's own resetsAt + every known future bucket reset (fiveHour/sevenDay/opus/scoped) from the identity's usage cache; nearest-in-range wins (one possibly-wasted continue at a nearer reset beats hours of silence; a still-dead account just re-runs the ladder on the next rejection). Engine calls it via `armBestReset` at ALL THREE exhaustion sites (claude dead-branch + both codex sites — backend-neutral, wiring PINNED per the 2.355.0 lesson). ② A too-far refusal now **declares itself in the session** ("重置在N小时后，超过自动等待上限，不会自动续跑…", 1/h floor) instead of a journal line the user never sees. test-auto-resume 62→71, incident shape as fixture.

## 2.368.26

- **Agent messages now reach Codex sessions LIVE, with full claude-inbox parity** (owner: "继续对齐，还有第三方其它agent支持（注册表）"; reverses the "codex不能被唤醒" claim the 2026-08-25 research refuted). New delivery rung in conversation-deliver, **registry-gated**: `capsOf(backend).peerDelivery` ∈ 'cli-inbox' (claude — CLI cross-session inbox) / 'rpc-queue' (codex) / 'stash-only' (shell/unknown) — never a backend-id branch; a third backend claims the live lane by declaring the cap + serving the contract. The codex wrapper owns the app-server RPC connection, so the rung writes a `peer-message` stdin frame and the wrapper delivers natively: **idle ⇒ `turn/start`** (billed turn + reply — exactly claude's inbox behavior), **busy ⇒ `thread/queue/add`** (runs right after the current turn; upstream-test-pinned semantics). Capability-gated on the wrapper's own sidecar advert (`caps.peerMessage`, the 2.361.1/2.364.1 law — old wrappers get an honest miss→stash, never a swallowed frame); the wrapper records the peer user message itself (item notifications never carry userMessage — no double render, no invisible delivery) and reports `peer_message_result` both ways — ok:false re-stashes the text server-side so a promised message is never lost.
- **Dead-wiring fix (found while wiring the above, 2.355.0 class)**: `recordCodexQuotaSignal` was exported by the engine and destructured by session-stdout but server.js never passed it through — the `?.` call silently no-op'd, so the ENTIRE codex quota signal chain (rate_limits_updated cache writes, exhaustion escape ladder, reset_credit_result) had been dead in production since 2.368.21 while its unit pins glowed green. Wired through both server.js touch points; scripts/test-peer-delivery.mjs (19, in gate) now pins the wiring alongside the functional rung test (real deliver.create() + real sidecar + negative controls: old wrapper, claude-backend session).

## 2.368.25

- **Usage popup shows Codex reset credits** (owner: "usage里是不是应该展示一下codex账号剩余reset"). The stored reset-credit count only rides the `account/rateLimits/read` RPC — the passive `account/rateLimits/updated` push never carries it — so the wrapper now reads limits once at startup (fire-and-forget after the thread starts) and both quota paths keep `resetCredits` on the account snapshot (engine event write + sidecar reader merge). The popup's Codex section shows "Reset credits: N" with an explanatory tooltip, plus a ⟳ that asks a LIVE codex session's own app-server to re-read (capability-gated via `caps.quotaRefresh: 'session-rpc'` on BACKEND_META — 注册表, not a backend-id branch; no live session ⇒ honest toast, not a silent no-op). test-codex-pool 28→33.

## 2.368.24

- **Client feature gates are capability-driven (P4 slice three).** `BACKEND_META` gains a per-backend `caps` descriptor (`fork/effort/review/outputStyle/autoResume`) and the chrome now gates on it instead of backend ids: the output-style chip, the auto-resume chip (which as a side effect now APPEARS for codex sessions — codex exhaustion has armed the same auto-resume module since 2.368.20), the Review chip, and the sidebar Fork menu item. The billing switcher's account roster filters by exact backend equality (the old boolean "is codex / is not" partition broke structurally with a third backend). An unknown backend gets all-false caps — chrome shows nothing it can't deliver. `test-bundle-globals` earned its keep mid-batch: it caught a used-but-never-imported `backendFeatureCaps` before the push (the 2.340.x lost-binding class).

## 2.368.23

- **Codex fold fixes, round two — both owner re-reports** ("还是不展示折叠的文件名，还多了好多乱七八糟的卡片"). ① File names: apply_patch arrives as a **function_call with structured JSON** (`{reason, changes:[{path, kind, diff}]}`) on the live channel — the 2.368.22 fix parsed only the rollout envelope AND only on the custom_tool_call branch, so live sessions still showed nothing (fixture-not-from-real-data twice in one feature; now verified against the owner's actual buffer record). One shared `parseToolInput` covers both record types and both shapes, synthesizing a patch text so the diff renderer keeps working. ② Stray cards: a saved `chat.collapseKinds` predating the 'agent' kind can never contain it (a multiSelect save can't distinguish "unchecked" from "the option didn't exist"), so Agent Wait / list_agents broke every fold on any instance with a saved selection — a **registry migration** (`2026-08-collapse-kinds-agent-default`, ledger-keyed run-once) adds the default-on kind; un-ticking it afterwards sticks. Unknown/dynamic codex tools (plugins, browser tools) now classify as the external-tool 'mcp' kind instead of breaking runs, and `dynamic_tool_call`(+output) records are routed at all.
- **P4 slice two — the silently-treated-as-claude hazards are dead**: `normalizers.js` is a registry (an unregistered backend throws at session start instead of getting the claude normalizer), the live stdout parse dispatches on a declared `streamProtocol` capability (a protocol-less chat backend reports loudly and passes output through raw), and the remote-spawn flag injection appends claude stream-json flags only for `backend === 'claude'` (it used to hit ANY non-codex backend). `test-codex-history` 24→29, `test-migrations` 11→14.

## 2.368.22

- **Codex fold summaries name their files** (owner: "codex里的writes和read似乎不展示文件名" — a "3 Bash · 7 writes" header with no paths). apply_patch input carries no `file_path`; the touched paths only exist in the patch envelope (`*** Add/Update/Delete File: <path>`). The normalizer now parses them into `input.files` (+`file_path`), fold summaries list every file a patch touches (multi-file patches included), the ✎ write mark keys on the semantic kind, and the memory-path classifier now works for codex writes too. Codex reads have no structured path by construction (they go through `exec`), so read names remain a claude-only nicety. `test-codex-history` 21→24.

## 2.368.21

- **Codex stored reset credits join the limit escape ladder** (owner ask: let the user choose reset vs switching). ChatGPT plans can hold rate-limit reset credits (`account/rateLimitResetCredit/consume`); on a codex limit the order is now ① consume a stored credit when opted in (`codex.limitResetCredit` = Auto — default OFF: it spends a stored credit unattended, same consent class as auto-resume) → ② pool switch → ③ auto-resume wait. A successful reset continues on the same account; `nothingToReset`/`alreadyRedeemed`/cooldown falls through the ladder. The wrapper gains two verbs on the live app-server (`codex-read-limits` = on-demand `account/rateLimits/read` incl. the credits count — codex finally has a ⟳-class proactive read; `codex-reset-credit` = consume), both exposed as ws cases for manual use.
- **P3 verdict: codex hot-switch is IMPOSSIBLE with the current CLI — experimentally refuted twice over.** The app-server canonicalizes CODEX_HOME to the real path at startup (a symlink repoint never reaches a running process — its own stderr prints the dereferenced `AbsolutePathBuf`), and a turn completed normally after auth.json's *content* was swapped to garbage tokens (tokens live in process memory). Cold-restart switching is codex's ceiling, not our implementation's.
- **Per-backend switching capabilities are now an interface** (P4 first slice, owner ask "接口化之后怎么区分冷切热切"): `src/backend-caps.js` declares per backend `{pool, hotSwitch: verified|impossible|unverified, planC, sealedOrders, resetCredit, quotaProbe}` — the pool engine gates on capabilities instead of backend ids (hot only where a live re-read is *verified*; an unknown backend gets no pool, cold, no credits). A future agent adds a caps row, never an if-chain. `test-codex-pool` 17→28.

## 2.368.20

- **Codex pooled account + auto-switch on limit, cold-switch v1 (P2 of the backend-parity plan).** The claude pool's three layers were reused where proven: the pure decision core (EDF/thresholds — codex readings already normalize to the same bucket shape), the atomic symlink material act (a codex pool is a symlink among the member CODEX_HOME dirs at data/codex-subs/<poolId>; the darwin exclusion doesn't apply — auth.json is a plain file), and the backend-agnostic cold-restart machinery (kill → exited → resume). New: Manage Agents grows "+ Add pooled account…" in the ChatGPT section; the codex spawn resolver takes a pool id with the same signed-out-target self-heal as claude's; the wrapper now RELAYS every account/rateLimits/updated push to the server (the sidecar was display-only) and forwards the typed codex_error_info on failures (it used to be dropped) — readings land in the current MEMBER's usage cache, a tripped rate_limit_reached_type or a usage_limit_reached/quota_exceeded/workspace_* error triggers the pool switch first and arms auto-resume as the fallback, and 'unauthorized' is surfaced as an event. **Hot switching is structurally OFF for codex pools** — claude's hot path rests on a forensically verified per-request credential re-read; codex's long-lived app-server has no such proof, so hot waits for the P3 symlink-swap verification. Sealed orders and plan-C per-session links stay claude-only. New gate suite test-codex-pool (17).

## 2.368.19

- **Collapse folding is now semantic and covers codex** (owner: exec cards, agent wait, send message never folded — the classifier matched claude tool names only). The normalizer stamps a semantic collapseKind on every tool card and the chat view folds by MEANING: one global checkbox set for every backend (owner-decided — per-provider copies are config sprawl), with codex exec/write_stdin as command runs, apply_patch as writes, and a NEW sub-agent-orchestration kind covering the codex collab family (spawn/wait/send_message/interrupt/followup, 30+ per real session) AND claude Agent/Task cards, folded by default. codex 0.149.x renamed its shell tool to bare exec — even the old exec_command mapping missed it, so exec cards now also get the Bash display treatment. Settings labels reworded semantically (Command runs / Sub-agent orchestration). Per-backend offline model fallback moves to BACKEND_META — a codex session never lists claude models when /api/available-models is unreachable. test-codex-history 13→21. NOTE: an existing saved collapse-kinds selection keeps its old choices — tick the new Sub-agent box once to fold collab cards.

## 2.368.18

- **Codex quota display fixed and made first-class (P0+P1 of the backend-parity plan).** P0: `normalizeCodexRateLimit` classified windows by primary/secondary *position* — codex 0.149.x switched to a single-window shape where `primary` IS the weekly window, so every current reading rendered weekly usage as the 5h bucket; windows now classify by **length** (≤8h = burst, else weekly), the live push's `windowDurationMins` field is finally read, both shape generations are accepted, and the exhaustion markers that were silently dropped (`rate_limit_reached_type` — the tripped window now reads dead — plus `spend_control_reached`/`credits`) survive normalization. P1: per-account codex snapshots **persist** to `data/usage-cache/<cxs-id>.json` (seed-from-disk + freshest-wins write-through — an idle account's quota no longer vanishes after 14 days of rollout rotation); codex identities **join the anchors → estimator stack** (backend-prefixed identity keys so an email shared between a ChatGPT and an Anthropic login never merges their quotas; prior-less learning — the claude Max-20x priors are meaningless for ChatGPT plans), `/api/usage` serves codex estimates, and the popup's codex section renders the same est-now overlay as claude's. Found along the way: codex CLI-login ledger events were being counted into the **claude** global identity's cost (`costBetweenMulti` keyed bare `__global__`), and the auto-cli refresh loop didn't exclude codex accounts from the `claude -p /usage` channel. Cache-efficiency bar drops its fake cache-write segment on codex-only views. New gate suite `test-codex-quota` (18).

## 2.368.17

- Settings fixes (owner-caught, both 2.368.0 regressions): the **Default output style dropdown rendered blank** — enum options are `{value, label}` objects by the settings-ui contract and the plain-string list left every row empty; and `claude.outputStyle` / `claude.autoResumeOnLimit` move from the generic Session group into the **Claude** category where backend-specific settings belong.
- Unified backend-parity plan updated (docs/design-backend-parity.md §5): the collapse-kinds codex gap (real card names measured: `exec` ×209, collab family — none participate today) gets a **global semantic-kind design** (normalizer stamps collapseKind; per-provider checkbox sets rejected as config sprawl), plus the found-along-the-way gaps: codex tool name is `exec` (not `exec_command`, so even the Bash mapping misses), the status bar model fallback list is claude-hardcoded, codex fork RPC is unwired.

## 2.368.16

- **Codex garbled-fragment messages fixed — our bug, not codex's** (owner: "很多不是人话的内容" — "断 AA 边"、"缘小"、"通过：8 个路由在"…). Codex collab/sub-agent turns stream **several message items concurrently, interleaved delta-by-delta** (real buffer: two item ids alternating per character); our delta handler finalized *every* open stream whenever a delta with a new key arrived, so each key switch chopped both messages into per-run fragments. Replaying the owner's real buffer: 13 fragmented assistant messages → 6 complete ones, 0 fragments, and the quoted shards reassemble verbatim into "最终审计通过：8 个路由在 1440、1024…". Streams now run concurrently; each closes in place when its own full `response_item:message` arrives (turn end still finalizes everything).
- **A codex session's account row no longer masquerades as the claude CLI login.** The billing chip and the switcher's global row used the backend-agnostic "CLI login" label AND attached the claude machine login's quota chips — a codex session's account info read as "点开是 claude 的 CLI". Both surfaces now say **ChatGPT login** for codex (matching the New-Session dialog) and the claude quota chips stay off the codex row. `test-codex-history` 7→13.

## 2.368.15

- **Background tasks no longer show "running" forever after they finished** (owner: "基本每个对话都有已经结束的后台任务依然显示为正在进行"). Root cause: every task-lifecycle closer resolved the task's card via `pendingToolCalls` — the permission/result matcher whose entry the tool_result DELETES. A background command's result arrives in seconds ("Command running in background with ID…"), its completion notification minutes later, so the lookup always came up empty and the 2.233.0 closer never fired (its test passed only because it skipped the tool_result). Task lifecycle now has its own index (`toolUseId→msg` + `task_id→msg`, alive for the whole conversation); already-stuck cards heal on the next attach/reload since the buffer replay runs the fixed code. `test-task-wakeup-card` gains the real record order + a task-id-only case, and joins the CI gate (it wasn't in it — silent-stale class, third find this week).
- **Codex feature audit against a real 582-record session** (owner-requested): ① `custom_tool_call_output` was never routed (only the `function_call_output` twin) — 84 outputs dropped wholesale, **52 tool cards stuck "pending" forever**; routed + array-of-blocks outputs flattened to text: the audited session now renders 0 stuck cards. ② Codex **sub-agent threads** (2026-08 CLI) were fully invisible — spawns now announce as a system line naming the agent path + thread id (full viewer parked in backlog). ③ **Live context%** ("context length为啥无法获取到"): the window size only arrived with attach-time chatStatus, so a created-here codex session showed `123k/?` until re-attach — `contextWindow` now rides every token_count usage meta. ④ Historical reasoning is `encrypted_content`-only in codex rollouts (summary empty) — thinking can't be shown for history by upstream design; the live stream still renders it while streaming. New gate suite `test-codex-history` (7).

## 2.368.14

- **Deleted accounts' zombie usage-cache files no longer poison org→account resolution** — found by actually chasing the under-prediction the owner refused to let me hand-wave as "multi-device consumption" (they were right: single machine, all of it). The trail: the org-29c4 identity's implied-full crashed to absurd values ($8–12 for the 5h bucket) exactly when this session's marathon began — because `usageIdentityGroups` admits any cache file with a `fetchedAt`, a deleted account's file (`sub-a453…`, deleted but its cache lingering since 07-16) stayed in the group, OTel's `resolveOrg` picked that dead id as the org's named account, and **live spend got booked to an account that no longer exists** (`atype: unknown`, invisible to every quota view). Cache files with no roster record are now excluded (`test-rate-limit-capture` ⑦, 38); the two zombie files on this instance are retired to `data/usage-cache/.retired/`.
- Honest remaining gap, deliberately NOT closed by tuning: even with attribution fixed, recent buckets move faster per classed-$ than the learned weights predict (the 5h moved ~8pt on ~$23 of cache-read-heavy cost — far above the learned cr weight). Whether Anthropic reweighted cache reads in bucket accounting needs a controlled odometer re-measurement (the 2026-08-09 method), not a curve fit; parked with the estimator backlog item.

## 2.368.13

- **Estimator accuracy is now measured delta-relative, not absolute** (owner-corrected: absolute |pred−act| shrinks with refresh cadence alone — refresh every minute and any model looks perfect; the model's real claim is the *movement*). Calib rows now record `u0`/`predDu`/`actDu` and `rel` = predΔ/actΔ (null when the window moved <2pt — a ratio there is noise division), and the engine's headline metric becomes `usage-est-rel-err-pct` (=|predΔ−actΔ|/|actΔ|, emitted only for windows that moved), replacing the absolute one. Re-evaluated on the honest metric, 14 days of same-source pairs with ≥2pt movement: the estimator **systematically under-predicts movement** — 5h captures ~85% of real Δ (median ratio 0.83), Fable weekly ~78%, and 7d only ~61%. The absolute numbers (median 0pt) were real but flattered by cadence, exactly as the owner said. `test-usage-estimator` (83) gains the delta-relative pins and — found while wiring them — **joins the CI gate for the first time** (the dead-reckoning core suite was outside it; the silent-stale class).

## 2.368.12

- **Quota readings are now org-verified before they touch an account's usage cache** (B-b3cd, found while auditing prediction accuracy — the dead-reckoning itself measured excellent: median error 0pt, p90 ≈2pt *absolute* utilization points over 4115 calibration pairs, near-zero bias). The real problem was attribution: a hot-switched pool session keeps its old token ≥25 min, and its `rate_limit_event` readings describe the OLD org — written under the newly-linked account they flapped a half-empty account's 7d odometer 48↔95 (22 of 65 such anchors in one week jumped >10pt against a <1h-old panel reading, on 3 of 4 accounts). A magnitude gate was rejected — parallel workflows genuinely can burn >10pt/h (owner-confirmed) — so the gate is **identity**: the OTel truth stream's per-session observed org (`observedOrgFor`) must match the link, else the reading (and dead marks, and limit banners — same stale-token physics) is re-attributed to the org actually billed. No OTel observation or an unmapped org ⇒ link attribution, exactly the old behavior. Session-scoped actions (pool switch, auto-resume) stay on the blocked session either way.
- Calibration metric hygiene: calib pairs are now same-source (mirrors `extractPairs`' 2.340.0 learning rule) — a cross-source pair carries the inter-source offset, not prediction error, and those flips were drowning the accuracy signal the stream exists to expose. `test-rate-limit-capture` 30→37, `test-otel-truth` 40→43.

## 2.368.11

- **⚙→Update now runs the *latest* update script, not the stranded checkout's copy.** The 2.368.10 rewrite-recovery rung had a chicken-and-egg hole: it rode the very update that was broken, so instances cloned before the history rewrite (the whole existing fleet) still ran their old `update.sh`, failed the ff-only pull, and froze — exactly what the owner's own hosted instance hit. The self-update route now `git fetch`es origin and executes `origin/master:scripts/update.sh` (same trust domain as the code the update is about to pull and run anyway); fetch failure falls back to the checkout's copy. Any future fix to update logic reaches every instance ≥2.368.11 on the next click, with no manual help.

## 2.368.10

- **History rewrite executed (owner-approved): the two rclone binary blobs are scrubbed from git history** — `git filter-repo` on a fresh mirror, force-pushed with all tags; the tip tree hash is byte-identical (`8182ee45…`), all 1871 commits preserved, fresh-clone size 56MB → **8.3MB**. Because every SHA changed, `git pull --ff-only` can never succeed again on a checkout cloned before the rewrite — **`update.sh` gains a rewrite-recovery rung**: when the pull fails twice and neither side is the other's ancestor (true divergence, not unpushed local work — that still fails loudly), it keeps the old HEAD under a local `pre-realign-<ts>` tag and realigns with `reset --hard`. Instances that update through the script self-heal; anyone updating by hand: `git fetch origin && git reset --hard origin/master`.

## 2.368.9

- **The rclone binary is no longer tracked in git.** The one-click-install commit put the 57MB binary itself into the public repo, so history grows ~60MB on every pin bump (2.368.8's push added the 63MB v1.69.3 blob before this was caught) — and a boot self-heal writing a *tracked* file is the dirty-tree-blocks-`git pull` class that already bit `vibespace-status` (2.111.26). Untracked + gitignored (`rclone-dl.zip` too); the update pull therefore deletes the copy older releases committed, so the boot self-heal now also *installs* when the binary is missing, some mount needs rclone, and the PATH has none — a user's own PATH rclone is never shadowed. The two blobs already in history stay (removing them is a history-rewrite decision for the owner). `test-mount-oauth-probe` 26→28.

## 2.368.8

- **The real OneDrive fix: rclone pin v1.65.2 → v1.69.3** — and a diagnosis correction. 2.368.6 blamed a dead refresh token; a parallel session proved otherwise by testing each Graph endpoint separately: token refresh, listings and uploads all worked — only the `/content` download endpoint returned 401 `unauthenticated`. That is Microsoft's migrated consumer OneDrive rejecting the old rclone's download path; A/B against the live account with identical config: 1.65.2 fails every read, 1.69.3 and 1.75.0 download fine. 1.69.3 also stays inside the documented Cloudflare-STS-safe range (1.63–1.69), so the S3 constraint that motivated the old pin still holds. Because nothing ever re-ran the installer, a pin bump alone would never reach existing deployments — `restore()` now self-heals our `data/bin/rclone` copy to the pin at boot (best-effort, never blocks, never touches a user's own PATH rclone).
- **The health probe now catches download-only failures.** This incident passed `lsf` — a list-only probe calls the mount healthy while every read is EIO — so the OAuth sweep now also reads 1 byte of the first root file; download-denied gets its own message ("downloads are rejected while listings work — reconnect") without the Re-authorize button, because re-authorizing genuinely would not have helped (the owner's re-auth flow was fine all along). `test-mount-oauth-probe` 18→26.

## 2.368.7

- **Unmount now actually ends the mount daemon — re-auth can't silently change nothing anymore** (same OneDrive incident, second half: the owner re-authorized, and reads still failed). An EIO-wedged rclone daemon (dead token, stuck VFS waiters) survives the lazy `fusermount -uz`, so the re-auth bounce "unmounted", spawned a fresh daemon **on top of the surviving dead one**, and the kernel kept routing to the old daemon — the fix looked applied and did nothing; four leaked daemons were found on this box, two of them stacked on a path no record even owns anymore. `unmount()` now polls for daemon death and kills survivors by exact argv **before resolving** (bounce callers mount right after — a deferred kill would murder the fresh daemon instead), and `mount()` refuses to stack: any stale daemon still serving the path is killed before the spawn. `test-mount-oauth-probe` (18) pins both.

## 2.368.6

- **A dead OAuth sign-in no longer hides behind a healthy-looking mount** (owner: every file in the OneDrive mount opens with an IO error — while the mount row showed nothing wrong). The refresh token had died ("unauthenticated: Unauthenticated" on every download); the fuse dir cache kept listings working, so the health sweep's mountpoint `ls` saw a fine mount, `_revocable` said an own-configured backend can't expire (wrong for OAuth), and even the backend probe's denied-regex had no phrasing for rclone's OAuth-death errors — three misses stacked into total silence. OAuth-backed mounts (Drive/OneDrive/Dropbox/…) now get the fresh-process backend probe on a slow clock (10 min; every sweep while an auth error is showing so recovery clears fast), the probe classifies `unauthenticated`/`invalid_grant`/`InvalidAuthenticationToken` as denied, the health message says what to do ("re-authorize"), and the sidebar's **Re-authorize** button appears for it. New gate suite `test-mount-oauth-probe` (15) pins the whole chain.

## 2.368.5

- **The auto-continue toggle now looks toggled** (owner: "几乎没有视觉反馈，似乎就是变粗了一点？而且自动继续也是个沙漏，和旁边 output style 的待加载沙漏挨着不好"). Two fixes on the same chip: ① ON is a real state — accent color plus an "auto" label — instead of a one-shade opacity difference from OFF; armed stays amber with the reset time. ② New `autoContinue` SVG (clock circle + play triangle) replaces the hourglass, which sits one chip to the left on the style chip meaning "pending pick" — two adjacent hourglasses with different meanings read as one broken widget. Verified against the real CSS in a headless render (all three states distinct); pinned in `test-auto-resume` (62): the chip must not use the hourglass, and the on-state class must exist and be accent-styled.

## 2.368.4

- **The resumed window finally SHOWS the style it is running** (owner, after updating to 2.368.3: "切换+resume还是停留在默认"). The style was genuinely active — the whole remaining bug was display, and it had two halves. ① The **creator of a resume never receives an `attached` payload**: its history loads over HTTP with no meta at all, so the live style/auto-resume state never reached the chip on the exact flow the feature was built for — before 2.368.3 that surfaced as the eternally-pending hourglass, after it as a flat "默认". The `created` reply now always carries `outputStyle`/`autoResume` (null = CLI default) and the client applies it. ② The sibling `attached` path in `attachSession` copied the payload into meta **key by key** and that hand list lacked `outputStyle`/`autoResume`/`streamingKind` — the whitelist-drift class, fifth strike. Both attach-shaped call sites now pass the server payload **wholesale** (the payload IS the meta), style/auto-resume application is one shared `_applyLiveMeta`, and a zero-message attach still applies live state. Worktree E2E: `created.outputStyle:"Concise"` and `attached.outputStyle:"Concise"` both confirmed; `test-auto-resume` (58) pins the created-payload fields, the created-handler application, and the no-hand-copied-list shape of both call sites.

## 2.368.3

- **The style chip no longer sticks on the pending hourglass for a session that is really running the picked style** (owner: Concise verifiably active, chip still pending). Server truth was correct — a worktree E2E shows a fresh attach reporting `outputStyle:"Concise"` — but `loadHistory` is also called by partial-meta refresh paths (subagent viewer, dead-session view) which carry no `outputStyle`, and the unconditional update reset the live value to empty, making the saved pick look pending again. Style/auto-resume state now updates only when the payload carries those keys; pinned in `test-auto-resume` (53). Same invariant as the config-whitelist strike: a partial payload must never clobber known state.

## 2.368.2

- UI hygiene (owner: third emoji correction): the pending-style chip uses the SVG hourglass icon instead of an emoji, and the auto-resume conversation notices are plain text. The SVG-only icon rule stands; the sanctioned text-symbol exceptions remain only warning/refresh glyphs.

## 2.368.1

- **The output-style pick actually survives a resume now** (owner picked a style, resumed, chip still said "默认" — within hours of 2.368.0 shipping). Root cause is the FOURTH strike of a bug the code itself documents: `setSessionConfig`'s key whitelist silently dropped both new keys, exactly as it once dropped `account` (2.43.0) and `groupManager` (2.132.0) — its own NOTE says "keep it in sync with EVERY per-session config writer", and I added two writers without doing so. `outputStyle` is whitelisted now, and `autoResume` persists as a real tri-state — the truthy filter would have erased an explicit `false`, whose whole point is beating the global default being ON. `test-auto-resume` (52) now pins the whitelist and the tri-state exception so a fifth strike fails the gate.
- Two honesty gaps around the same chip: the session now records the EFFECTIVE spawn style (a default-sourced Concise displayed as "默认" before), and a pick is **visibly pending** on the chip (`Concise ⏳`, tooltip naming both the saved and the currently-running style, shown at pick time and re-derived at attach) — the silent drop was only findable because the chip looked inert; it must never look inert again.

## 2.368.0

- **Output style (Concise / Explanatory / Learning / Proactive) is pickable per session** (owner asked whether chat mode supports the CLI's new concise mode — it did not). The CLI's styles are a **settings key**, not a flag, and a stream-json session is never offered `/output-style` (verified against a real init record), so VibeSpace sets it at spawn through the ONE `--settings` flag it already uses for `ultracode` / `switchModelsOnFlag`. A chip in the chat status bar picks it, the choice persists as per-session config and rides the next resume, and both the chip and its dropdown say plainly that a running session cannot change style. New setting `claude.outputStyle` is the default for new sessions.
- **Auto-continue when a usage limit resets.** The CLI has this, but only in the interactive REPL (`/rate-limit-options` is absent from a stream-json session's command list and its timer is a TUI interval), so a VibeSpace chat session just sat there. `src/server/auto-resume.js` arms on exhaustion — **after** the account pool has tried to switch, because another account resumes in seconds instead of hours — and at the reset sends the CLI's own continue wording verbatim. It **survives a server restart**, which the CLI's own version explicitly cannot ("Automatic continue cancelled · Claude Code relaunched during the wait"): a wait measured in hours that a deploy silently cancels would be worse than no feature.
- Because firing **spends quota while you are away**, the gate is explicit: global default `claude.autoResumeOnLimit` (**off**), a per-session value taken at spawn, and a live toggle in the status bar — a per-session OFF beats the default being ON. It never fires early, never twice, never while the session is already working, and it disarms itself the moment the session recovers (a pool switch, a fresh non-rejected reading, or your own prompt). Arming and firing both announce themselves in the conversation, and a failed delivery keeps the wait for the next tick instead of dropping it.
- `scripts/test-auto-resume.mjs` (48) in the gate: the tri-state gate, the four refusals (no reset time / past / >26h out / unknown session), timing (early, grace, busy, once), every disarm path, restart survival across a fresh module instance, delivery-failure retry, both wiring chains, and the `--settings` merge (one flag, never two).

## 2.367.3

- **A mapped instance is now used by every link the UI hands you** (owner: "我给vibespace开了frp反代，但是所有地址还是继续用的本机主机名 … 无论是活跃转发的地方的path挂载，还是本对话design chip里的artifact"). 2.367.0 made the SERVER resolve "this instance's URL" correctly, but each client surface still built its own link by gluing a path onto `location.origin`, so a mapped instance kept handing out this box's LAN hostname. `utils.absUrl()` is now the single joiner — it prefers the instance's public address and falls back to the browser origin only when nothing is mapped — and the server tells the client that address at boot (`/api/home` → `instancePublicUrl`) and LIVE (the `instance-url` broadcast), so mapping or unmapping repoints every link with no reload. Surfaces fixed: the design popover (Open / Copy link — it was also preferring the relative `path` over the server's already-absolute `url`), the file browser's Publish page… dialog, `/p/<id>` linkified in a chat reply, and the Ports panel's `/svc/<name>` path mount (anchor, Copy and the make-public confirmation). Sibling sweep: the device-pairing installer command now prefers the relay/instance URL over `location.origin` too — that command runs on ANOTHER machine, where this box's hostname resolves to nothing.
- `scripts/test-public-links.mjs` (22) in the gate: the helper's precedence and its refusals (junk value, double slash, absolute passthrough, non-path), the boot + live wire, and a NEGATIVE pin per surface that no hand-rolled `location.origin` join survives.

## 2.367.2

- **The CI failure is diagnosed and fixed, with evidence** (follow-up to 2.367.1, whose counters immediately paid off: `posts=1 kept=2 events={api_request:2,…}`). The runner's CLI *did* export and our parser *did* understand it — the two `api_request` records were dropped one line before the stash by `if (!rec.rid || !rec.orgUuid) continue`, because the CI identity is a personal setup-token whose events carry **no `organization.id`**. Nothing of ours was broken; the assertion was demanding an account property. Ingest now counts WHY a parsed record is dropped (`noRid` / `noOrg` / `stashed`) — a quiet truth channel was previously undiagnosable in production too — and the E2E asserts what is provable in that environment: env→exporter→receiver→parser reached, stated as a real passing check with the stats, while `posts>0` with nothing parsed remains a hard failure and `posts=0` is still a loud skip.

## 2.367.1

- **GitHub Actions CI is green again — it had been red on every push since 2.361.0** (owner: "我怎么老收到ci失败的邮件提醒?"). Exactly one assertion failed there, 20+ times: the chat E2E's OTel truth check (`env→receiver→parser`). It passes locally and always failed on the runner, because *whether the CLI exports OpenTelemetry logs at all* is a property of the environment, not of our pipeline — and with only a "did anything land in the stash" signal there was no way to tell "the runner's CLI exported nothing" from "our parser dropped what it sent". The local pre-push gate is not evidence about the Actions mirror, so every push mailed the owner a failure I never saw.
- The receiver now counts arrivals (`posts` / `rejected` / `kept` / per-event `seen`) and exposes them at `GET /api/otel-stats`; `otel-ingest.registerRoutes(app)` owns all three OTLP signal routes. The E2E classifies a miss: **no OTLP post ever arriving ⇒ a loud SKIP** naming the counters (nothing of ours is proven, nothing of ours is broken); **posts arriving but no usable `api_request` ⇒ still a hard FAIL** (that is our bug). Locally the real capture still passes, so the signal is unchanged where it can be had. `scripts/test-otel-truth.mjs` (39) pins the counters, the stats route and the folded registration.

## 2.367.0

- **Map the whole VibeSpace to a public URL from the Ports panel** (owner request). The Ports panel gains a **This VibeSpace** row: one click publishes the instance's own port through the frp relay (pick or keep a subdomain) and one click unmaps it. While mapped, that URL becomes the address every "this instance's URL" consumer uses — reverse mounts, remote agent installs, the agentd auto-graduation gate, and published-page share links. **It never overwrites `agentd.publicUrl`**: the mapping is a layer on top, so unmapping falls straight back to whatever the setting said (the owner's explicit requirement). The row states which address is in effect and what is being kept underneath, so the fallback is visible rather than folklore.
- `src/server/instance-url.js` is now the ONE reader of "this instance's URL" (four call sites read `agentd.publicUrl` inline before) and the ONE publisher of the `vibespace-instance` frp proxy — the remote-agent-install path published that same proxy name as an invisible side effect, so two owners could fight over one relay proxy and nothing recorded the result. That path now calls `ensurePublished()`, which records and shows the URL but marks it **auto**: a side effect must not silently repoint everyone's share links, so only an explicit map outranks the setting.
- Publishing is **refused while auth is off** — an unauthenticated VibeSpace reachable from the internet is remote code execution as the owner, not a convenience; the refusal names the fix. A mapping the user asked for is re-asserted at boot (the persisted URL is kept, since frpc is its own process and usually outlives a restart) and a failed re-assert keeps the intent and says why instead of vanishing.
- `scripts/test-instance-url.mjs` (39) in the gate: the precedence ladder (explicit map > setting > env > none) with the setting proven untouched and restored on unmap, auto-vs-explicit, one-publisher/stable-subdomain, all three refusals, boot re-assert incl. the failure path, and wiring pins (no inline `agentd.publicUrl` reads remain in server.js or the wiring).

## 2.366.1

- **Published canvases open everywhere, not just on localhost** (owner opened the link I gave them and every artboard hung on "Loading artboard…"; two error storms in their console — `localStorage` SecurityError and extensions dying on `Invalid target origin 'null'`). Root cause, measured against a real canvas on a real LAN address: **`crypto.randomUUID` exists ONLY in a secure context.** VibeSpace is normally reached over plain http on a hostname / LAN IP / Tailscale address, which is not potentially-trustworthy, so `randomUUID` is `undefined` there and the canvas editor — which mints ids with it — hangs every artboard forever. It worked on `127.0.0.1` only because Chrome treats loopback as trustworthy, which is exactly why my own testing (on loopback) proved nothing. Fixes: ① a serve-time **compat prelude** on `/p/` content polyfills `crypto.randomUUID` from `crypto.getRandomValues` (a real v4 UUID; no Math.random) and swaps in an in-memory `localStorage`/`sessionStorage` when the sandbox's opaque origin makes the real ones throw — both only when the capability is genuinely missing, so https/loopback keep the browser's own; the stored snapshot stays byte-faithful. ② `/p/<id>` is now a **shell** on the real origin (our own HTML, no user content) that frames the content at `/p/<id>/raw`; isolation is IDENTICAL (the content still runs under the same sandbox CSP with an opaque origin — never `allow-same-origin`), but the top-level document the browser and its extensions talk to has a real origin. Both routes are gated identically; the shell escapes the agent-chosen page name.
- **Share links are never guessed by the server** (owner: "你怎么知道我用啥地址能访问你？你怎么知道是不是存在反代？"). 2.366.0 remembered "the last browser origin" and handed it to an agent, which put this machine's own hostname in a chat reply. Now an absolute URL comes only from `agentd.publicUrl` or from the Host of the request that is *asking* (correct for browser routes, because that browser will open it); agents get the **relative path**, `vibespace-page publish` prints it with an explicit "do not prefix a hostname", and the chat renderer linkifies `/p/<id>` against `location.origin` — so it works through a reverse proxy, a tunnel, or any hostname the viewer actually uses.
- **The design chip's page list is no longer empty** (owner: chip said "1", the popover only offered to create a new design). `_refillDesignList()` bailed on a detached node — the guard exists for broadcasts that arrive with no popover open, but the initial fill ran *before* the list was appended, so it never populated. Filled after the append now.
- `scripts/test-published-pages.mjs` 60→75: shell/raw split (shell not sandboxed, content still is, both gated, name escaped), the prelude (present, real v4 UUID, and a NEGATIVE control that a browser with its own `randomUUID` keeps it), per-request URL resolution incl. x-forwarded and the relative fallback, and a pin that no origin is persisted.

## 2.366.0

- **Design canvases from the chat view, published to YOUR VibeSpace** (owner request: "可以不发布到 claude.ai 吧，你提供一个替代发布流程然后直接发布到你这里"). Claude Code's bundled `/design` skill is reachable only from the terminal picker — in a chat (stream-json) session `/design <brief>` resolves to the consent command and the Skill tool refuses it ("design is a built-in CLI command, not a skill"). The skill itself is three things: a seeding helper, a ~2 MiB precompiled editor payload, and ~55 KB of instructions. VibeSpace now provides them itself: `src/server/design-kit.js` takes the helper + payload from the CLI's own extraction dir when present (bytes the CLI wrote; sha256-parity-tested) or extracts them from the installed CLI binary (raw bun asset / JS template literals, streaming scan — nothing of Anthropic's is vendored, everything is per-installed-version at runtime), extracts the instructions the same way, and writes a per-CLI-version kit under `data/design-kit/<version>/` whose `SKILL.md` is the VibeSpace ADAPTATION: step 4 "publish with the Artifact tool" and the artifact read-back section are replaced by `vibespace-page publish` (all-or-nothing — missing anchors ⇒ a visible "kit not ready: …" reason, never a half-adapted text). Every kit is validated by seeding a sample artboard with its own helper and running its `--check`. The flow: a **design chip in the chat status bar** (next to the goal chip; SVG) opens a popover — kit status, a brief, a "public link" toggle, Create — which sends a VISIBLE design request to the agent (no hidden injection): `vibespace-page kit` prints the base directory, the agent follows `<dir>/SKILL.md`, publishes with `vibespace-page publish <file> --title "…" [--public]` and replies with the link; the popover then lists this session's published pages with Open / Copy link / Public↔Private. New STATIC agent CLI `data/bin/vibespace-page` (publish/kit/list; vsst_ or jbt_; ships to remote hosts — `kit` mirrors the kit files from the hub when the host has no CLI extraction) + manual `vibespace-docs pages`. Published pages gained content upload (`POST /api/agent/pages/publish`, raw body ≤25 MB), an upsert identity `srcKey = host:path` (re-publishing the same working file keeps the URL, even from a remote host), session attribution (`GET /api/pages?sessionId=`), a browser-origin heuristic for absolute share URLs when `agentd.publicUrl` is unset, and ONE notify point (`onPublished` → `page-published` broadcast) shared by the file-browser dialog and agent publishes. Hosted canvases are view + PNG/PDF export (sandbox CSP; no online Save) — the adaptation says so at handover. Adversarial review (3 lenses, 20 findings, self-verified — the verify agents hit the account's session limit) shaped the shipped version: the adaptation also replaces the skill's "how to talk to the user" section, the "re-run /design" hint and the saving sentence (anchors required, all-or-nothing); the CLI-extraction lookup accepts the SAME CLI version only and only real, owned, non-world-writable directories (we execute what we find there); a failed kit build is retried on view after a minute and the popover offers Retry with Create disabled meanwhile; `replaced` is computed before the upsert (it was always false); visibility/name changes and unpublish broadcast too (other clients' popovers stayed stale); `bySrcPath` matches `local:` keys only (a remote host's page for the same absolute path is not the local file's page); job tokens attribute to the job's owner conversation and a scope-less caller lists nothing; a republish without `--public` keeps the visibility the user set; the chip lists by session OR conversation (a resume mints a new session id); the request names a `designs/<slug>/` working directory so a 2 MB page never lands in a repo root; the new suite assertions were themselves vacuous (argument order) and are now real. Gates: `test-design-kit` (real CLI: extraction + binary parity + helper --check + adaptation negatives + lookup guards) and `test-published-pages` (content publish, notify hooks, origin heuristic, wiring pins).

## 2.365.0

- **Context-full guidance + guarded compaction** (userN incident: a remote session hit "Prompt is too long" on every send; `/compact` answered "Compaction canceled."; the user fell back to a bare "hello" and got the same error). Two facts drove the design: the CLI's ONLY "Compaction canceled." path is an abort signal (interrupt), and a large conversation compacts for 1–2 minutes behind what used to be a bare "thinking…" spinner with an unguarded Stop button. Now: ① a `prompt_too_long` result (`Prompt is too long` / `Input is too long for requested model`) is classified by the normalizer (`errorKind: 'prompt-too-long'`, history and live alike) and renders as a guidance card — what it means (every later send fails identically until compaction), a **Compact now** button that sends `/compact` through the live input, and the escalation path if the CLI answers "Conversation too long" (rewind in terminal mode); view-only windows get the explanation without the button. ② A `/compact` send labels the turn "Compacting context… (1–2 minutes — Stop cancels it)" for every client (server broadcast `streaming-label` now carries `kind`, attach meta carries `streamingKind`, API-retry relabels keep it), and while that kind is active the Stop button is a two-step confirm ("Cancel compaction?" for 4s) instead of a one-click abort. `scripts/test-compaction-ux.mjs` (21) in the gate: real-normalizer classification with negative controls (API 500 / max-turns / interrupted / a success mentioning the phrase → no card) + wiring pins across ws-handler, session-stdout, schema, chat-input, chat-view, renderers, CSS, dictionaries.

## 2.364.1

- **Large chat pastes work again in EVERY session — the wrapper capability gate read the wrong file** (owner: pasted a >1MB screenshot, got "Message too large for this session's long-running wrapper (started before the update) — Terminate + Resume", did so THREE times and updated VibeSpace in between, and every fresh session refused again; had to fall back to terminal mode). The 2.361.1 gate decided "does this wrapper understand `_frame_file` pointer lines" by reading `caps.frameFile` out of `data/session-meta/<sock>.json` — the SERVER's own session record, which never carries caps. The wrapper writes its caps into its SIDECAR, `data/session-buffers/<id>.json`. So every wrapper tested "old", the frame-file bypass was dead for two releases (zero frame files written since the gate shipped), every paste >1MB was refused, and the refusal text blamed the wrapper's age for a session that was seconds old. Fix: `wrapperCaps()` in `src/server/wrapper-files.js` is the ONE capability reader (sidecar, through the same collision-aware resolver every other sidecar read uses); the gate caches only a POSITIVE verdict (a wrapper still booting a huge resume is re-checked on the next paste, never locked out); the refusal now carries evidence (payload size + the wrapper's start time, or "still starting — wait a moment") and leaves a journal line (the refusals were invisible server-side). `scripts/test-chat-frame-guard.mjs` (31) now spawns the REAL wrapper and asserts the server-side reader sees its sidecar (parity), pins old-shape/absent/late sidecars behaviorally, and carries a NEGATIVE control with a caps-less server meta beside the sidecar — the 2.361.1 text pins (`caps?.frameFile` regex) stayed green while the feature was dead; a reader must be tested against the file the writer writes. Invariant: **a capability advertised by a process is read from the file THAT process writes, through its canonical resolver — never from a neighbouring record that happens to share the id.**
- Terminal-mode "API Error: 500" seen by the owner in the same hour is the vendor's API (CLI talks to it directly in terminal mode; VibeSpace is not in that path); it cleared after `/compact`.

## 2.364.0

- **Published pages — the instance takes over the artifact role** (owner request: a `/design` canvas published to claude.ai could not be shared outward). Any local self-contained HTML (design canvases, mockups, reports) can now be hosted BY YOUR INSTANCE at a stable share URL: file explorer → right-click an .html → **Publish page…** → `https://<instance>/p/<id>`. Pages are **private by default** (viewers need a VibeSpace login); a per-page **Public** toggle opens the link to anyone — the same lock model as 2.359.0 path mounts (`/p/` is middleware-exempt, the page store is the only gate). Re-publishing the same source file keeps the same id, so a design you iterate keeps its share URL; the dialog doubles as the manager (republish / unpublish / copy link / open in a browser window). SECURITY, load-bearing: every `/p` response carries `Content-Security-Policy: sandbox allow-scripts …` — published pages execute on an OPAQUE origin with no cookie access and no same-origin API reach, so hosting arbitrary user HTML on the app origin cannot become stored XSS; the design-canvas editor runs fine under it (read-only + PNG/PDF export, exactly like any non-artifact host). New gate suite `scripts/test-published-pages.mjs` (19: real HTTP publish/serve/auth-gate both ways/CSP assertions/upsert/traversal/restart-reload + wiring pins).
- **"Background Work · <job>" senders in peer message cards are clickable now** (owner report: the sender name rendered as a link but did nothing). Job-sourced senders are JOBS, not sessions — the click and the right-click menu now open the Background Work panel instead of a doomed session-name lookup.

## 2.363.2

- **Interactive pages work in Proxy mode again: proxied POST requests no longer hang** (userW incident: a local web app opened through the embedded browser's Proxy toggle rendered fine but every interactive button was dead). Reproduced deterministically in an isolated harness driven by headless chrome: `express.json()` was mounted before the unblocker proxy, so every proxied JSON POST had its body stream CONSUMED by the parser — unblocker forwarded a body-less request and the target server waited on the declared Content-Length until the browser aborted. GETs were untouched, which is exactly why the page rendered ("能看") while every click died silently ("点不动" — the reported app performs a JSON POST per interaction). Fix: the JSON body parser skips `/proxy/` paths so proxied bodies reach unblocker unread; unblocker stays mounted after auth (never an open proxy), and normal routes still get parsed bodies. New gate suite `scripts/test-proxy-post.mjs` (6: proxied GET/JSON-POST/raw-POST round trips through the REAL unblocker module in the server's chain shape + non-proxy parse belt + wiring pins).

## 2.363.1

- **A refused send no longer looks like a dead session** (userW incident: "我给 triage 发消息，它就会直接中断，然后就得 resume" — three attempts, same loop). Forensics: the sends were image pastes >1MB into a session whose long-lived wrapper predates the 2.360.0 frame-file capability, so the server CORRECTLY refused them ("…it was NOT sent. Terminate + Resume the session…") — but the client's per-session error handler treated EVERY `{type:'error', sessionId}` as an attach failure and flipped the LIVE window into the read-only Resume bar, and the refusal text rode `msg.error`, a field that handler never read. The user saw a dead-looking window with no reason; Resume re-attached the (never-broken) session; the next paste repeated the loop. Fix: chat-input refusals now carry `code:'input-rejected'` + the text in both `message` and `error`; ChatView renders coded refusals as an in-chat ✗ notice and leaves the live view alone (the attach-failure rescue is untouched for real attach errors, with an error-field belt); the incident recorder's ws ring captures `msg.error` too (this hunt started from a ring that said `msg:""`). Pins in `test-chat-frame-guard` (24).
- **Background Work `notify` fires no longer copy the user's inbox by default** (owner decision, option A — the previous default mirrored agent-facing reminder text like "扫两邮箱+Lark…" verbatim into the human's inbox on every fire). A notify fire wakes the OWNING CONVERSATION (the 2.361.5 lane, unchanged); add `--notify-user` to also deliver the text to the user's inbox. The agent relays to the user via chat/vibespace-ask when the content warrants it. CLI usage + manual teach the topology; delivery journal reflects exactly the lanes used. `test-jobs-engine` → 52 (default = owner-only; opt-in = both lanes).

## 2.363.0

- **Server-posted messages (Background Work notify, `vibespace-msg`) now render their chat card at DELIVERY TIME — and job `notify` reminders no longer look like they came from nowhere** (owner report: a job's self-reminder fired, the agent woke and did the work, but the receiving chat window showed no incoming message even with 2.362.2). Forensics: deliveries posted by the SERVER reach the CLI as an *unregistered* poster, so the CLI records `origin {kind:'peer', from:'unknown'}` with **no name, no msg_id, and no body** — the JSONL card is generic and the stdout `result.origin` is body-less, leaving 2.362.2's result-mining nothing to mine. But the server IS the poster: it knows the sender and text exactly, so the delivery ladder now renders the peer card the moment a post succeeds (`emitPeerCard` → the session normalizer's `injectPeerCard`; immediate, correctly positioned, works for local, channel, and remote lanes — and deliberately without text-containment dedup, the 2.362.2 review lesson: same-body recurring fires are legitimate). Stash-drained messages (all four sites: agent-msg ×2, job notifications ×2) emit the same card at injection time instead of entering the agent's context invisibly. On rebuilds, `peerDisplayName` now parses the sender out of the server frames (`Message from session "X" (via vibespace-msg…)` → X; `[VibeSpace Background Work] cron "name"` → Background Work · name), and the card body strips the vibespace-msg reply-hint prefix and the "This is a notification, not a user instruction…" conduct tail. `test-peer-msg-card` → 19, `test-agent-msg` → 41.

## 2.362.2

- **Peer messages are now visible in a LIVE-attached chat window** (userW incident: one session messaged another and the receiver's chat showed the agent replying to nothing — no sender, no content). Forensics against real CLI buffers (2.1.233 and 2.1.235): when the CLI drains a cross-session inbox delivery (harness SendMessage / `vibespace-msg` / Background-Work notify), the stream-json stdout NEVER carries the user record with the sender's words — that record is written to the JSONL transcript only; stdout gets `command_lifecycle` + the turn's records + a terminal `result` whose `origin` field carries the full envelope (sender name, msg_id, body). So the peer card (2.349.0/2.361.6) only ever rendered after a restart/resume rebuilt history from the JSONL — live windows showed nothing, which frequent dev restarts had masked. The normalizer now mines `result.origin` and synthesizes the peer card from the envelope: live it lands at turn end (late but visible, sender-attributed, clickable name as before); any rebuild shows it in true position via the JSONL record, dedup'd by `msg_id` across all three peer sites (idle-wake user record, mid-turn queued_command attachment, result mining); `msg_id` is AUTHORITATIVE when present — the text-containment fallback applies only to older msg_id-less records (an adversarial review pass caught the unconditional AND suppressing every repeat fire of a same-body recurring notify and any short body contained in recent typed text; fixed pre-ship with negative controls pinned). Interrupted turns still surface the message (mining precedes the error branch); body-less peer origins (a real record shape) are skipped. New gate suite `scripts/test-peer-msg-card.mjs` (13).

## 2.362.1

- Peer message card quotes in Chinese: fullwidth curly quotes (“…”) render with awkward full-em gaps around the sender name in CJK fonts — the zh strings quoting a session name now use corner brackets (「…」), matching the Japanese dictionary.

## 2.362.0

- **Agent-to-agent messaging — Communication Channels v1** (owner-designed; B-274d + B-dfd2 together). Agents get `vibespace-msg`: `list` shows the sessions they can reach (name · conversation id · group · board state · machine), `send <name|id> "text"` delivers into that session's conversation (idle receiver = a billed turn; the tool teaches the cost). Reach is Task-Group-scoped by a PURE ACL (`src/msg-acl.js`): same group = mutual see+message; other groups closed unless the user opens them — group setting `externalVisibility: none/visible/messageable` (task detail UI) or a per-session widening override (`POST /api/sessions/:id/msg-reachability`, API-first; UI row next). Visible < messageable, max-of-grants, multi-group union, ungrouped sessions are closed singletons; a coordination boundary, not a security one. **Delivery is ONE shared ladder** (`src/server/conversation-deliver.js`, jobs-wiring now consumes it too — its inline twin deleted): channel socket → local CLI inbox → the OWNING MACHINE's daemon via the new capability-gated `peer-post` agentd op (conversation-index names the machine; raw conversation ids work everywhere — agents never learn topology) → durable per-conversation stash (`data/msg-stash.json`, channel-ready envelopes with `source`) drained into the target's next context injection ("Messages that arrived while unreachable"). Flood floors (30s/pair, dup 10min), 16KB cap, uniform not-found errors (no existence oracle). Taught in the session tools intro + `vibespace-docs msg` manual; gated by `scripts/test-agent-msg.mjs` (33: ACL matrix, real delivery-ladder fakes incl. the remote rung, wiring pins). An adversarial review pass caught and fixed four defects pre-ship: the msg stash had no SIGTERM flush (a just-queued message died on the routine restart — flush() now rides the shutdown belt), the stash drain sat inside the jobs-engine-ready gate (a jobs init failure would silently hold promised messages forever — drains are now independent), the remote rung used the unbounded device connect (~2.7min request hang on a down host — now deviceBounded 6s, honest fall-through to stash), and vibespace-msg was taught to remote sessions but missing from AGENT_TOOLS (command-not-found on ssh/dial hosts — now shipped). Peer message cards also gained the owner-requested affordances: the sender name is CLICKABLE (jumps to that session), right-click offers Open/Properties/Copy, and a failed name resolution (renamed/closed sender) shows a toast + logs a telemetry event instead of failing silently.

## 2.361.6

- **Cross-session peer message card: sender NAME instead of the raw unix socket path, and the border is back** (owner report). The card labeled itself "Message from "uds:/run/user/…/….sock"" — origin.from is the transport address, while the sender's session NAME rides right next to it (origin.name since recent CLIs, and the wrapper tag's from-name attribute on older records). New precedence: origin.name → from-name attr → a non-socket origin.from → generic label (a socket path is never a user-facing identity). The missing border was a same-specificity cascade fight: `.chat-msg-system`'s display:flex/centering vs `.chat-peer-message`'s card styles — now a two-class selector (`.chat-msg.chat-peer-message`, display:block + full border + magenta left bar) wins deterministically.

## 2.361.5

- **notify-cron fires now message the OWNER CONVERSATION, and every job carries a delivery journal** (the 设备运维大师 relay + owner monitoring ask). The notify action delivered to the USER inbox/toast only and logged a passive group event — `_notifyOwner` was never invoked for it, so the agent that scheduled its own reminder (the whole dated-obligation pattern) was never woken; urgency/notify-inherit were innocent. Now a notify fire rides the same owner-delivery stack as every job event (toggles → rate floor → live message → stash fallback) IN ADDITION to the user inbox. New `notifyLog` ring (cap 12) journals every delivery ATTEMPT — lane (user-inbox / message / channel / stash / suppressed / off), outcome, target, reason — serialized to the panel ("Delivery log" under Auto-notify) so delivery is monitorable instead of inferred. test-jobs-engine +2 (50).

## 2.361.4

- **The run+echo reminder instinct is now supported instead of silently no-op'ing** (owner call, closing the 79928a2b silent-reminder loop). Scheduling a bare `echo`/`printf` is a natural first way to build a reminder, but scheduled successes don't notify by default — that shape was a permanent silent no-op, and the creation response's "auto-notify: ON — messaged on completion/failure" actively read as "each fire will message me". Now: a scheduled pure echo/printf command (no pipes/chains/substitution) defaults per-fire notify ON with a line explaining it (explicit `--notify-ok`/`--notify off` still wins, `notify-cron` remains the cleaner primitive), and EVERY scheduled task creation states the quiet-success semantics explicitly ("SUCCESSFUL fires are SILENT … add --notify-ok"). Manual updated; wiring-pinned in test-job-model (58).

## 2.361.3

- **`vibespace-job --at` timezone trap defused** (79928a2b's "broken cron notification" hunt): an agent living in UTC transcript timestamps scheduled a "+2 minutes" delivery test by writing the UTC wall time as a bare datetime — `new Date("…")` parses bare strings in the SERVER'S LOCAL timezone, landing the test 7 hours out, and the agent (whose actual cron jobs were firing on time all along — its real earlier bug was run+echo's notifyOk=false success-silence, which it had already fixed itself) was about to chase a phantom broken channel. Fix: `--at` now accepts unambiguous RELATIVE forms (`"+2m"`, `"+1h30m"`, `"+90s"`), creation always echoes the resolved fire time (`next fire: <ISO UTC> (in Xm)` — a mis-parse is visible immediately, not hours later), the error/help text teaches that bare datetimes are server-local, and the agent manual documents the trap. Wiring-pinned in test-job-model (56).

## 2.361.2

- **"Monthly spend limit" rejections now mark the weekly bucket dead** (owner hit it switching a pooled session's creds). The CLI enforces the weekly lane on the OVERAGE-INCLUDED accounting once extra usage exists — its `rate_limit_event` then carries `rateLimitType: seven_day_overage_included`, which the capture mapped to 'other' (surfaced-but-never-marked): a member whose weekly was spent AND whose org monthly spend cap was exhausted (`org_level_disabled_until`) kept showing 7d=0.53 in the cache, so the pool re-picked the hard-dead member (only the banner's short-lived 5h mark kept it out). Now: `seven_day_overage_included` maps to sevenDay — a reject marks the bucket dead until the EVENT's reset (not a 24h guess) and the overage/monthly-cap fields land in the cache; warning-level readings write the enforced-lane utilization. test-rate-limit-capture gained the live-incident cases (30) and joined the release gate (it had never been in `npm run ci`).

## 2.361.1

- **Image pastes into pre-update sessions were silently eaten by the 2.360.0 frame-file bypass — fixed with a wrapper capability gate** (owner's c1206711 lost-image incident, caught same-day). Wrappers are LONG-LIVED: a session created before the 2.360.0 update runs the old chat-wrapper forever, which doesn't understand `_frame_file` pointer lines — it forwarded them verbatim to claude, the CLI dropped the unknown type silently, the message never reached the transcript, and the frame file was orphaned (forensics: two orphaned frames in data/chat-frames/ holding the exact lost message, zero queue-operation records in the transcript for it). Fix: the wrapper now ADVERTISES `caps.frameFile` in its boot meta; the server sends pointer lines only to advertising wrappers. Capability-less (old) wrappers keep the historical raw-stdin path for frames ≤1MB (single screenshots rode it safely for months) and get a VISIBLE "Terminate + Resume, then resend" error above that instead of silent loss. Orphaned chat-frames are swept age-based (48h). Recovery for an affected session needs no update: Terminate → Resume respawns the wrapper from current code. Invariant (the capability-gate law, now applied to wrappers): a server-side stdin protocol upgrade must be gated on what the SESSION's running wrapper understands — same rule as device ops ("old daemons are never asked").

## 2.361.0

- **Per-request billing TRUTH via the CLI's own OpenTelemetry export** (B-345b 终案, owner-approved; the burst under-estimate root cause). Forensics established that pool hot-switches do NOT take effect inside a RUNNING claude process (the mtime-gated credential cache re-reads only on new process/expiry — observed ≥25min stale, with the old org climbing to 95% and rate-limiting from a session whose attribution said three other orgs; 558 mid-session switches / $7.9k post-switch spend in 12 days), so link-intent attribution mis-books storm spend in both directions — poisoning per-org odometers AND the dead-reckoning learning set (the -30~-49% ≥10pt calibration residual; six alternative mechanisms tested and refuted). Since transcripts/statusline/rate_limit_event carry quota VALUES but never identity, the fix consumes the ONLY channel that NAMES the billing org per request: local claude sessions now export the CLI's built-in `claude_code.api_request` telemetry (organization.id + request_id + tokens + cost, prompt content redacted upstream) to a loopback OTLP receiver on this instance — zero vendor calls, the CLI pushes to us. The observed org ① overrides link-intent at ledger BAKE time (rid-exact, `UsageHistory.setTruthLookup`), ② writes corrective attribution records when it disagrees with the current walk (all non-rid consumers converge), ③ lands in an append-only stash (`data/usage-history/otel-truth.ndjson`, boot-replayed) for offline re-derivation. New: `src/otel-truth.js` (pure parser), `src/server/otel-ingest.js` (loopback+per-boot-token gate is the ONLY door; `/otel/*` cookie-exempt), OTEL_* spawn env for local claude sessions (process-env channel, user-set endpoints win), setting `usage.otelTruth` (default on) as kill switch. An adversarial review pass caught and fixed three defects before ship: `'__global__'` is a truthy pseudo-id in identity groups (find(Boolean) would have baked phantom accounts and written bogus corrective records for every global-login session — live on this very machine's cache order), the corrective dedup marker armed on AGREEMENT would have suppressed the correction in the canonical agree→hot-switch→stale sequence (now pair-keyed on the truth→walk transition, with the entry ts bumped past the newest attribution entry so late flushes still dominate), and a per-boot token would have silently 403ed every session surviving a server restart (now persisted at data/usage-history/otel-token, 0600; rejected loopback posts log once + count otel-403). Gated by `scripts/test-otel-truth.mjs` (28: parser fixtures from a REAL captured payload, real-HTTP ingest round trips, a REAL UsageHistory bake with truth override, wiring pins) and a new chat-E2E assert that proves env→receiver→parser on every push's real haiku turn.

## 2.360.1

- **Stop-nudge "every stop" mode (0/0) no longer reverts to 10/30** (inc-mt0mozsp, owner report): the Manage Agents → Agent instructions tab carried a hardcoded pre-2.210.0 copy of the stop-nudge bounds (min 1/2) and coalesced its number inputs with `Number(v) || default` — an explicit 0 (valid since 2.210.0: staleness 0 = always stale, cooldown 0 = no rate limit → nudge on EVERY stop) was erased on Save and both fields silently reverted to 10/30. The dialog now reads bounds/defaults from SETTINGS_SCHEMA (one home, twin deleted; only an empty/non-numeric input falls back to the default) and the condition tooltips document the 0 semantics. Two new arch asserts pin the class: UI code must not re-declare a schema row's numbers inline, and number inputs must never `|| default` (explicit 0 is a value).

## 2.360.0

- **The 38MB conversation-poisoning class fixed end to end** (owner's 设备运维大师 incident: a 5-image chat paste killed the session and blanked its history — the conversation was surgically recovered, nothing was lost). Root cause: a multi-MB single-line frame gets SHREDDED by the pty/dtach stdin channel (mid-line bytes and the newline drop), the shreds glue onto the next message and were wrapped as TEXT into the transcript — a 38MB record that overflows context (every API call rejected) and breaks the huge-session tail window (history renders blank). Three layers, all gated by the new test-chat-frame-guard suite (real wrapper round trips): ① frames >64KB now ride a FILE (`data/chat-frames/` + a tiny `_frame_file` pointer on stdin); the wrapper validates the payload as one frame and DROPS shreds instead of wrapping them; ② a poison guard in formatChatInput refuses huge frame-shaped blobs with a visible error toast instead of writing them into the conversation; ③ **"Rescue transcript…"** on a stopped session's right-click menu — productized surgery: streams the transcript, stubs every oversized record in place (chain/order/count untouched), keeps a byte-preserved backup next to the file, atomic swap, refuses while a writer is live. For any future 暴毙会话: Terminate → right-click → Rescue → Resume.

## 2.359.1

- **Ctrl+G editor fixed (owner report "不好用了")** — broken since the 2.325.0 拆分, ~35 releases: the extracted copy of the editor-helper template turned bash `${PORT}` into `${port}` (case typo during a "verbatim" move; the pre-拆分 server.js was correct). The generated fake `code` script then curl'd `http://localhost:` (empty port → port 80), the POST never reached `/api/editor/open`, and the helper waited on its signal file forever — Ctrl+G looked frozen. Nothing covered generated-script CONTENT, so it sat for weeks. Fixed + the live instance's generated file healed in place; restore-smoke now asserts every generated script's lowercase bash refs resolve to in-script definitions AND the editor URL rides `${PORT}` (both sides fail on the pre-fix content).

## 2.359.0

- **Path mounts can be PUBLIC now** (owner request: sharing a mounted resource with others) — a lock toggle on the mount's address row flips `/svc/<name>/` between login-required (default) and public-shareable; going public requires a danger-confirm that names the full URL, and public mounts wear an amber "public" chip. Security model: `/svc` left the global cookie middleware and auth is enforced PER MOUNT inside the proxy (HTTP and WebSocket upgrade alike) — both sides pinned in test-path-mounts (17): private-without-login = 401 (incl. ws), public-without-login = 200. Exposure is always an explicit act — mounting never defaults to public.

## 2.358.0

- **Fixed frp subdomains** (owner question — yes, frps routes any name under the wildcard): the publish flow now prompts for an optional subdomain (`https://<你起的名字>.<relay域>`); blank keeps the previous/random one. Persisted, so restarts keep it (same slot the broker already used); a taken name fails loudly at the relay. HTTP backends only — https/tcp services stay IP:port mode as before.
- **Main-domain path mounts — `/svc/<name>/`** (owner request: no per-service random subdomains): a new "/" button on each Active forward mounts it under the app's own domain, **behind VibeSpace login** (cookie/Clerk — the thing the public frp URL deliberately isn't). Reverse proxy resolves the forward's live loopback port per request, so mounts survive restarts with zero re-establishment and work for REMOTE machines' services through the tunnel; prefix stripped, `X-Forwarded-Prefix` set, absolute-path redirects rewritten under the mount, WebSockets spliced, honest 404/502. Inherent limit (the dialog says so): apps must tolerate a URL prefix (vite `base`, jupyter `base_url`, code-server natively) — HTML bodies are not rewritten (that's the embedded-browser proxy's job). New gate suite test-path-mounts (14, real http+ws round trips).

## 2.357.0

- **Background Work is sidebar-native now (owner verdict: the window duplicated the rail panel and every sidebar click spawned one).** The rail panel is THE surface: full job list with toolbar (summary / ＋New / ⟳), cards expand INLINE (detail, access controls, notify state, runs, log tail), registry escapes — and a pending interaction's **answer form renders inline in the card** (amber-bordered block). Expanded cards survive the jobs-updated rebuilds. Every entry point (inbox jump, `Open panel`, openSpec replays, gs-menu) lands on the sidebar panel; the old windows remain only as the mobile / activityRail-off fallback. CDP pins: a sidebar card click expands inline and spawns NO window; openJobInteract lands in the sidebar.
- **Job asks/notifications in the inbox are attributed to the OWNER AGENT SESSION, not the job** (owner verdict: a message hanging off a background-task entity was 反直觉 — you think in terms of the agent you were talking to). Items now carry the owning conversation's canonical key so they group with that session's other asks (named "session · job"), with the job noted in the detail line; clicking still opens the answer surface directly (now in the sidebar). Ownerless/user-created jobs keep the old jobs-bucket attribution.

## 2.356.0

- **Process manager UX batch (owner reports):** ① a real **PID column** (dim, right-aligned — PID sort existed with no PID visible); ② an **auto-refresh pause toggle** in the Processes header (⏸/▶ — a row you're reading can no longer be refreshed out from under you; sort/filter/expand keep working on the frozen snapshot, a host switch or kill outcome still refreshes, the count label turns amber while paused); ③ **history charts moved above the process table** (the long table pushed them out of sight); ④ the **memory chart auto-scales to the data** (peak ×1.2, capped at the limit) instead of pinning the axis at the machine total — 20G of use on a 122G machine used to draw as a flat line at the bottom; the "cur / limit" label keeps the absolute context. CDP asserts for all four in test-sidebar-rail; screenshot-verified.

## 2.355.1

- **Process manager: the poll's own `ps` no longer tops the CPU sort at "200%"** (owner report) — ps lists itself, computes %CPU over its own ~10ms lifetime (20ms of CPU across threads = 200%), and gets a fresh pid every poll so the live-delta correction never applied. The shared parser now drops rows carrying our exact probe column string (covers the remote rung's `sh -c` wrapper too; a user's own `ps aux` still shows). Pinned in test-sysinfo-op (28).

## 2.355.0

- **userW's inc-msy27q2e ("重启后只能 resume 当前桌面"): the 2.331.0 fix was NEVER WIRED.** That commit shipped `scanStoppedInDesktopStates` + its unit test — but the `loadAutoSave` call site was never staged, so the pure function sat dead for 24 releases while its test stayed green, and the exact report came back. The call is now in place (non-active desktops' lazy saved states fold into the same resume-all collector, honest against live/stopped/remote identity, home-desktop placement preserved) AND the suite gained a WIRING PIN: layout.js must *call* the scanner, not just define it. test-resume-all-desktops joined the release gate — it was another manual-only suite.
- **userW's inc-msz495u6 ("热切换死了，改完 target 活着的 session 没有切换"): plan C silently demoted the manual pool switch to new-sessions-only.** Per-session links (2.315.0) take precedence in `poolCurrentFor`, but the manual target change only repointed the pool DEFAULT symlink — verified live on the reporting instance: default → new member, all 16 live session links → old member. The user route now sweeps every live per-session link on a hot pool (an explicit pick means "all of it, now", logged as `[pool] manual target → X: repointed N live session link(s)`); the ENGINE's setPoolTarget calls never sweep — its per-session moves are the model-family projections a blanket sweep would clobber. Both semantics pinned in test-account-pool (33).
- The rail CDP smoke joined the release gate at 1/4 its old cost: its in-worktree rebuild was redundant (the gate's own build step already produced the bundle the overlay copies — same rule as client-boot/restore-smoke), 60s → 14s; ports/worktree made pid-unique and CI chrome flags added.
- (Bundle archaeology, already fixed on master: userW's 2.341.1 capture shows `layout: "failed: persistenceRouter is not defined"` — the incident-wiring free identifier the 2.343.2 latent-breakage sweep + test-server-globals acorn gate closed.)

## 2.354.0

- **System panel: full btop-like process manager** (owner request) — the top-8 read-only list becomes an interactive table: every process (350 transported of N, top-by-RSS ∪ top-by-CPU so no hot process is ever dropped; "+ show all" past the 120-row display cap), **live instantaneous CPU%** (successive /proc utime+stime deltas keyed pid:starttime — ps's lifetime average only where sampling is impossible, and the panel says so), sort chips CPU/MEM/PID/Name/**Tree** (ppid forest with indenting), instant filter by name/user/pid, and per-row expand → full command line, pid/ppid/user/state/uptime, **Terminate / Force kill** (confirm dialog), **Pause/Resume** (SIGSTOP/SIGCONT), Copy cmd. Kill outcomes are honest: "terminated" vs "signal sent — still running (try Force kill)"; the server's own row is kill-refused with a pointer to the Update flow.
- **Same manager for every machine (CS one-implementation law):** new capability-gated `proc-list` device op runs the SAME src/sysinfo.js on daemon machines (remote CPU% is live exactly like local — the panel's poll gives the daemon its delta baseline); daemon-less ssh hosts fall to a `ps axo` rung parsed by the shared parser (CPU% = lifetime average, labeled). Signals ride one verdict shell script (dm.runCmd → ssh fallback) with pid/sig validated before any shell string exists; EPERM/ESRCH come back as named errors, not silence. Verified live against a real remote host (old daemon → clean capability-gate fallthrough → 350/885 rows with owners).
- Gates: test-sysinfo-op grew to 26 (op shape parity local↔daemon, live-sampling assert, parser/cap units, review pins); test-sidebar-rail grew system-panel CDP asserts (real rows, search narrows, expand exposes actions) and its stale 9-item rail count (jobs panel made it 10) is fixed; /api/sysinfo/procs joined the restore-smoke route battery; screenshot-verified at ~200px panel width.
- **Adversarial-review batch (10-agent workflow, 5 confirmed real, all fixed + pinned):** ① remote permission-denied kill misreported "no such process (already gone)" — the verdict script probed existence with `kill -0`, which performs the SAME permission check as the signal and fails EPERM identically; now `ps -p` (E2E-verified against a real root process: "permission denied"); ② the transport cap AND CPU sampling were both decided by ps's flatlined lifetime %CPU, so a long-lived low-RSS process that just started spinning was invisible on >350-proc machines — sampling now sweeps the whole table (~7ms/1000 procs) before capping and the cap ranks by max(lifetime, live); ③ a null fetch response (server restarting, auth redirect) crashed the kill handler silently and let Pause/Resume toast false success — guarded; ④ pid/ppid now Number-coerced before touching innerHTML (rows come from remote machines; a compromised daemon reply must not reach the DOM raw); ⑤ search over a truncated table said a definitive "no match" — it now names its scope ("no match among the 350 transported rows of N"). Plus: device-rung signal failures no longer blind-retry over ssh (double-signal risk — honesty over retry), expansion state is host-scoped, zombie chip i18n'd, hostile `max` clamped, mid-copy text selection survives the 5s redraw.

## 2.353.0

- **Port scans: owner-uid labeling for the still-anonymous rows (owner report: 3000/5302/5432 had no detail):** `ss -p` + docker's port table still leave root/other-user listeners nameless. A second enrichment rung reads `/proc/net/tcp{,6}`'s uid column + `/etc/passwd` and labels what's left `user:<name>` (`user:root`, `user:postgres`) — the owner is the best truth available when the process is invisible to us. Same ONE implementation for local and remote scans; docker-rung failure no longer skips it.
- **Scan results survive panel re-renders (owner report: every "new port" toast wiped the list back to blank):** scan results were DOM-only, and any `port-forwards-updated`/`machine-ports-new` broadcast rebuilt the panel. Results now cache per machine (`_portScanCache`) and replay on rebuild with FRESH forward state (forward/publish chips update live); a `machine-ports-new` announcement merges its ports into the cached list, so the panel actually shows what the toast talked about.
- **The repeating "new port 23179" toast rootfixed:** the watch REPLACED its seen-set with each sweep's snapshot, so a port that disappears and comes back (our own reverse-tunnel port churns per session lifecycle) re-toasted as "new" forever. The seen-set now accumulates — a port is news exactly once; regression-pinned in test-port-forward.mjs (churn scenario).
- **B-e342 closed as NOT-a-leak (forensics):** the "3 daemons" on the remote host = 1 detached listener (ppid 1, stdin /dev/null) + 2 per-connection `--stdio` bridges whose parents are live `sshd` sessions — by design, they die with their connections. Tonight's churn was each release's version-mismatch self-upgrade, also by design. (The refuted "beginUpgrade LOCK-window leak" hypothesis is archived in the backlog item.)

## 2.352.0

- **Docker container names on port scans (owner report: AIDev rows had zero detail):** `ss -p` only names sockets your user owns — on a docker host every published container port (root's docker-proxy) scanned anonymous. The scan now consults docker's own port table (`docker ps --format`, no root needed) and names still-anonymous rows `docker:<container>`. ONE implementation enriches local and remote scans alike (CS twin law); verified live against the reporting host's real container fleet.
- **Active-forward rows show the service tag** (owner report: the Background-Work service name only appeared on scan rows) — forwards created by a service carry `label: "service: <name>"`; the Active forwards row now renders it as the same chip.


## 2.351.2

- **MID-TURN peer messages were still invisible (owner: "我announce了怎么没收到" — the agent HAD received it):** an idle wake arrives as a user record (2.349.0 card ✓), but a message queued into a BUSY turn is recorded ONLY as an `attachment/queued_command` with a STRING prompt + `origin:{kind:'peer'}` — nothing on the live stream at all, and the existing queued_command handler (2.88.0, built for the user's own mid-turn messages) filtered for array-of-blocks prompts, so every peer delivery fell through. String prompts now render, and `origin.kind='peer'` gets the same peer card (never a "You" bubble of someone else's words). Live-view caveat (upstream shape): a mid-turn peer message appears on window reopen/history rebuild — the CLI emits no live record for it.


## 2.351.1

- **Job cards show externally-published URLs (owner report: demo-ui's Ports-panel publish was invisible on its card)** — a service whose declared port was forwarded+published manually (instead of `--publish` at creation) now gets the same ↗ URL chip: the user REST responses enrich the serialized snapshot with the matching local forward's publicUrl (`publishedExternally: true`; job records untouched, ports⇄jobs remains registration-first).


## 2.351.0

- **`vibespace-docs [status|ask|task|jobs]` — full manuals for EVERY agent tool + a global index (owner request).** New static CLI (ships to remote hosts with the tool roster); no topic = the index (which tool when, shared rules). Manuals live in docs/agent/*-manual.md, served by the running server (`GET /api/agent/docs/:topic`, vsst_ AND jbt_ accepted — a job's script may read them too; reading docs never depends on tool toggles or engine readiness). Teaching surfaces carry one pointer line each; `vibespace-job docs` remains as an alias.


## 2.350.0

- **`vibespace-job docs` — the full Background Work manual, read on demand (owner design call):** budgeted context teaching now carries ONE pointer line; the complete manual (kinds, notify audiences + toggles, announce, subscription filters, panels, web-UI event-flow pattern with the publish/injection caution, permissions, in-job env, negative space) lives in docs/agent/background-work-manual.md and is served by YOUR server (`GET /api/agent/jobs-docs`), so it always matches the running version. All three teaching surfaces point at it.
- **Inbox: Background Work is its own section** (owner report: it read as a phantom session mixed into the session groups) — distinct header with an icon, always after session groups, no fake session affordance.
- **Answering an interaction panel now clears its inbox entry** (owner report: "提交过了怎么不从inbox里消失") — answerPanel/panel-expiry auto-resolve the needs-your-input item; removing a job clears ALL its inbox items.
- **Real engine edge caught by the new gate pin:** a `stop` racing the wrapper's first act (no pid stamp yet ⇒ kill-by-handle had nothing to kill) silently no-opped — the task kept running with `_stopRequested` never honored. The sweep now delivers the pending kill once the stamp appears.
- Peer-message card uses a third color (`--magenta`, accent fallback) for its bar — visually distinct from assistant/notification bars (owner request).
- **Forwarded-chip fix actually fixed:** the 2.349.0 scan-row match read `f.port` but forward records carry `remotePort` — the chip never rendered (fourth fixture-shape instance; now verified against the live data/port-forwards.json).


## 2.349.0

- **Peer messages are now VISIBLE in the chat (owner report: "announce了但对话框里什么都看不到, 都不知道agent收到了什么")** — a cross-session delivery (Background-Work notify, another session's SendMessage) arrives as a user record with `origin.kind='peer'` + isMeta, which fell into the invisible-meta render path: the woken turn appeared to start from nothing. Forensically pinned from this conversation's own JSONL (`origin:{kind:'peer',from,verifiedPeerPid}`), same provenance law as task-notification (2.229.2: origin.kind is authoritative). Peer messages now render as a distinct accent-bordered card — "Message from another session" (sender-named when attributed), harness boilerplate trimmed, core text prominent.
- **Scan rows now show the already-forwarded state (owner report: 8390 was in Active forwards but its scan row looked untouched)** — a scanned port with an active forward gets a `forwarded`/`published` chip (tooltip carries the public URL) and drops the redundant forward arrow; its controls stay on the Active forwards row above.


## 2.348.1

- **Panel-answer field report (the demo's own feedback loop delivered it): two inbox UX defects fixed.** ① The For you entry for Background Work items displayed "Background Work" as if it were a session name — a phantom session. It now shows the JOB's name ("demo-ui needs your input"). ② Clicking the entry dumped you in the Background Work window to hunt for the card — it now opens the job's Interaction Panel DIRECTLY (todo items carry `jobId`; falls back to the window for items without one, and the panel window degrades to "nothing to answer" when already handled).


## 2.348.0

- **Announce-flood fairness in the passive injection (owner design call):** viewers keep seeing announces passively at their NEXT context injection only (never a wake), but the per-turn update block now coalesces each job's announces into ONE line (`announced ×N, latest: …`) — a chatty watch job can no longer crowd lifecycle events (done/failed/parked) out of the 600B budget. Single announces render plainly; directed message delivery (owner + filtered subscribers) is unchanged.


## 2.347.0

- **Subscription filters (owner request):** `vibespace-job subscribe <id> --filter "SpaceX|Starship"` — a case-insensitive regex over the notification text; only matching messages reach that subscriber (one agent watches a news feed, another subscribes to just its SpaceX items). Re-subscribing updates your own filter in place; invalid regexes are refused at subscribe time and a filter that errors at match time matches nothing (fail-closed). Panel-pattern acceptance rules (≤200 chars, must compile).
- **Full self-inspection (owner request):** `vibespace-job show <id>` prints the complete registration — argv/cwd/env names, schedule + next fire, restart/timeout/until/notify-ok, access + lock, notify state + last delivery, subscriber count + YOUR subscription and filter, context brief, last run. `vibespace-job list --mine` (owned by this conversation) / `--subscribed` (your subscriptions), with ★mine / ✓sub markers; agent snapshots now carry the full creation parameters (env values still never leave the store).
- **All three teaching surfaces updated together** (baseline intro / grouped intro / per-turn reminder — the 2.342.2 twin-set law): agents now learn announce, subscribe --filter, notify-on-completion, and the show/list self-inspection verbs at first contact.
- Gates: engine 46 (filter store/update/refuse, non-matching skipped, case-insensitive match delivered).


## 2.346.0

- **Quiet-success becomes the creating agent's choice, not a law (owner decision):** `vibespace-job run ... --notify-ok` opts a scheduled job's SUCCESSFUL runs into events + owner/subscriber notifications (default stays silent — the 18-card-flood lesson holds as a default, no longer as a rule).
- **`vibespace-job announce "what happened"` — the watch-job verb.** A news-page monitor exits 0 every run; exit codes cannot express "found something". The job process itself (jbt_ token, id implied) — or any session with control access — announces the noteworthy moment: custom text goes to the owner conversation + subscribers over the normal lanes (message / stash), lands in the event ring for injection, rate-floored like everything else. Success/failure vocabulary fully decoupled from process exit.
- **Truncated notification history now points at a readable file (owner ask):** when a drained stash has >2 entries, the untruncated history is appended to `data/job-notifications-read/<conversationId>.md` and every truncated injection form (elided middle, floor line) carries that absolute path — the agent Reads the file instead of losing the elided middle. 256KB head-trimmed per conversation, age-swept with the 14d GC.
- Gates: engine 41 (notify-ok success notifies + emits event; announce reaches owner and cron-parent subscribers; spill file content), model 50 (spill-path in elided + floor forms).


## 2.345.0

- **Context echo in notifications was silently dead — caught by the live E2E (owner question "你测试回调context了吗"):** the notify text checked `typeof job.context === 'string'` but production stores `{payload}` — every real context brief was dropped from every notification since 2.344.0 (the unit fixture used a bare string: the fixture-shape class struck our own test). Fixed for both shapes, pinned with the production shape + a negative control; the `--context` brief now rides completion/failure messages (clipped to 300cp inside the 1000cp cap).
- **Job subscriptions (owner request): any session that can VIEW a job can now subscribe to its notifications** — `vibespace-job subscribe <id|name>` / `unsubscribe` (also POST /api/agent/jobs/:ref/subscribe). Subscribers get the same completion/failure/park/ask messages as the owner over the same lanes (live message when their inbox is reachable, stash-to-resume otherwise), deduped per conversation lineage, capped at 10 per job. Subscribing to a CRON covers its per-fire child runs too. A subscription is its own explicit switch: group/global notify defaults and the owner's --notify govern the OWNER lane only — a subscriber leaves by unsubscribing. `lastNotify` keeps narrating the owner lane; snapshots carry `subscribersCount`.
- Recurring-cron multi-fire callbacks pinned in the gate: a child failing on two consecutive fires notifies each time (engine 36, model 48).


## 2.344.2

- **`vibespace-job notify <id> on|off|inherit`** — change a job's auto-notify override without rm+recreate (field report from the first fleet adopter, which rebuilt four jobs to flip the flag). Owner-only (canEdit); returns a fresh notify preview. User side rides the existing access act (`notify` field). E2E note: the full notify loop was live-verified today — a `sleep 60` task's completion message was delivered to its idle owner conversation via the CLI inbox (lastNotify lane=message) and opened a new turn.

## 2.344.1

- **Post-ship adversarial review of 2.344.0 (3 lenses → refute-verify): seven confirmed fixes.** ① Dead local-only guard: the spawn gate checked `data.host` but every create sender sends `hostId` — channel flags and the inbound-accept setting leaked into remote ssh/dial spawns (the fixture-shape incident class again); both now gate on `data.hostId`. ② **Pre-2.344.0 live sessions could silently lose notifications**: they were spawned without the accept setting, so their bypass-mode inbound HOLDS our unattested messages in a dialog nobody watches (dropped after 5min) — the engine now pushes `crossSessionInbound:"accept"` to every live LOCAL claude chat session over the chat control channel (`apply_flag_settings`, one stdin line, zero inference; two passes after boot for slow dtach re-attaches; terminal sessions rely on the stash lane until respawned). ③ Missed `{at}` cron looped forever: `nextFireAt` stayed in the past, so the missed branch (and its owner message) re-fired every dedupe window — now parks terminally (`desiredUp=false`, revivable with `start`). ④ The 30s rate floor DROPPED distinct events (a fail right after a done never reached the owner) — floored distinct events now go to the stash (surface at next injection); only identical repeats within 10min drop. ⑤ A READ-ONLY engine (second server against a live lock) could flush its stale boot snapshot over the live store via shutdown's dirty-flush — `_save` now refuses in read-only mode. ⑥ `_notifyRate` map never pruned (unbounded per-conversation growth) — bounded at 500 with 10min pruning. ⑦ Panel showed "nothing sent yet" after successful channel-lane delivery (`lane:'channel'` unhandled) + `channel-socks/` now 0700 with a boot sweep of stale sockets. Engine gate grown to 30 (missed-cron terminality, floor-stashes-distinct pinned).


## 2.344.0

- **Background jobs now notify their owner conversation — through Claude Code's own cross-session messaging, not synthetic input (owner-approved B-0bf4).** When a job finishes, fails, gets parked, misses its scheduled time, posts an interaction panel, or has its panel answered, the conversation that created it receives a real peer message on its CLI inbox socket (`src/peer-messaging.js`: registry scan of `~/.claude/sessions/` + published key auth + the CLI's own documented two-frame injection). The CLI does all the delivering: queued mid-turn, a new turn when idle (billed like a typed prompt), its inbound controls and flood throttles fully honored — VibeSpace never writes a session's stdin, so the automation red line stands. Spawns pre-accept via the documented `--settings {"crossSessionInbound":"accept"}` (our bypass-permissions sessions would otherwise hold unattested senders in a dialog nobody sees). Cron quiet-success and agent-initiated stops stay silent; a 30s per-conversation rate floor + identical-text dedupe sit under the CLI's own limits.
- **Default ON, three toggle layers**: global Settings → Integration "Background jobs: notify the owner conversation" (`agents.jobNotify`) > per-group tri-state in the Task Group window (explicit Off wins across groups) > per-job `vibespace-job run --notify on|off`.
- **Closed conversation? Notifications stash and inject at resume** (owner request): undeliverable notifications persist in `data/job-notifications.json` keyed by conversation lineage (30/conversation), and the next SessionStart/resume or prompt injects a `<vibespace-jobs-missed-while-away>` block (≤900B, oldest + newest guaranteed, middle elided with a count) — passive turn-boundary injection, never a fabricated turn.
- **Agents know at creation whether they'll hear back**: the create response + `vibespace-job run` output state auto-notify's mode honestly (live message / stash-until-resume / off, with the deciding layer and reason). **Users see it too**: Session Properties gains a Background Work section (effective state + which layer decided), and the job detail row shows the last notify outcome (messaged / queued-for-resume / skipped-off / suppressed, with age and per-job override).
- **EXPERIMENTAL: VibeSpace as a Claude Code channel** (`agents.vibespaceChannel`, default OFF): new local claude sessions register `data/bin/vibespace-channel.js` (dependency-free MCP stdio server, `claude/channel` capability) via per-spawn `--mcp-config` + the research-preview development-channels flag; job notifications then arrive as structured `<channel source="vibespace">` events (deliver ladder prefers the channel socket, falls back to the inbox lane). This is the foundation for future external chat-tool bridges; the preview's flag/protocol may drift — re-verify on CLI upgrades.
- Gates: new `scripts/test-peer-messaging.mjs` (10, real unix-socket inbox pinning the exact wire frames + dead-socket honesty), test-jobs-engine grown to 27 (deliver lane / stash+drain / toggle-off / preview honesty), test-job-model to 45 (toggle precedence, notify text budget, stash truncation endpoints-survive law). Design: docs/design-background-work.md §12.


## 2.343.4

- **Collapsed cron-run ids now redirect instead of vanishing** (owner-reported agent confusion): the 2.343.3 boot collapse deletes stale per-fire child records, but an agent that noted such an id mid-flight got only the uniform not-found on its next poll — indistinguishable from a permission wall — and had to rediscover by name. The collapse now records id→survivor tombstones (in-memory, this boot's collapse only) and `vibespace-job poll <stale-id>` answers with the surviving consolidated record's id and a one-line explanation. Deliberately NOT a silent alias: the permission model's no-existence-oracle rule stays intact because a tombstone only exists for records the engine itself just consolidated.


## 2.343.3

- **Cron run-record flooding (owner screenshot: 18 identical done cards)** — every cron fire minted a fresh first-class task record with a 14-day GC (a 10-minute cron ≈ 100+ cards/day) and emitted a "cron fired"/"done" event pair that spammed the per-turn injection channel of every group session. Now each cron keeps ONE persistent child record — every fire is a run in its ring (panel shows a ×N runs chip), routine successful scheduled runs are SILENT (quiet-success: ring entry only, no event, no notify — failures and awaiting-user still surface), and boot runs a one-shot collapse of the pre-existing pile (terminal, stamp-verified-dead duplicates only, newest kept). Engine gate extended: one-child-across-fires + quiet-success pinned (19 asserts).


## 2.343.2

- **Owner-requested full sweep for more latent breakage — EIGHT new fixes + a real server-side no-undef gate.** A 3-agent audit of the two dead-code sweep commits + a deps-provision audit of every create(deps) factory, plus deterministic scans (Proxy hazard ops / client mixin unions / destructure-vs-exports), found: ① `classifyCliDeath` free in session-stdout (hoisted to module scope in agent-tool-generators + exported — session death classification/exit reasons were broken); ② `https` never required in cli-env (model registry refresh threw with an API key set); ③ `os` never required in usage-pool-engine (workflow usage tailer never armed — silent catch); ④ `adapterRegistry` free in usage-pool-engine (model-lock repin + stop-on-fallback dead; now injected via deps); ⑤ `ClaudeCodeAdapter` free in session-stdout (get_usage probe parse always null); ⑥⑧ `agentdDeps` ghost binding in mounts-plugins-wiring AND server.js auto-graduation (both now read the agentd.publicUrl setting; ssh→dial auto-graduation had silently never fired); ⑦ incident-wiring read `persistenceRouter` free (incident bundles lost layouts + layout history; now uses injected readLayouts + new listLayoutHistory dep); plus the allow-exit toggle's `hosts-updated` broadcast restored (deleted as collateral of the exits-updated sweep — the exit-node toggle showed stale state and a second click sent the inverted value), the dead ExitProxyManager broadcast dep dropped, and Background Work inbox items now jump to the jobs window instead of a dead-end "session not found" toast.
- **New permanent gate `scripts/test-server-globals.mjs`** (in npm run ci): real acorn scope analysis over all 93 server-tier files — any identifier that resolves to no binding and no known global fails the build (the client has had this since 2.330.1; the server never did, which is why seven of these survived for weeks). Negative-controlled; it caught fix ⑧ by itself on its first full run.


## 2.343.1

- **publish layer 2 (owner report "this._notify is not a function")** — with the Proxy fix in place the call finally reached PluginManager, which exposed an OLDER break: a dead-code sweep (dc37220, the audit batch) had deleted `_notify()` while its 8 call sites remained — every plugin-state broadcast (and the publish tail) has thrown since. Definition restored verbatim. New gate: test-architecture #9 — server-side `this._x()` calls must have an in-file definition (scoped to server tiers; src/lib mixins excluded), with this incident as the motivating case. Lesson re-pinned: a "dead code" deletion must grep BOTH the definition and its call sites (feedback_verify_what_you_commit, third instance).


## 2.343.0

- **CRITICAL latent: port publish dead since the 拆分 (owner report "public URLs not available") — 7th decomposition incident, first PROXY-SWALLOWED-ASSIGNMENT** — src/server/lazy.js's mk() Proxy had a get trap but NO set trap, so mounts-plugins-wiring's `portForwards.plugins = plugins` (decomposition #12, 2.326.0) wrote to the Proxy's dummy target instead of the real PortForwardManager: `publish` threw "public URLs are not available on this instance" on every instance for 17 releases. Fixed with a forwarding set trap (class fix — every extracted `singleton.prop = value` works again) + new `scripts/test-lazy.mjs` gate in npm run ci with the incident as a negative control.
- **Background Work ⇄ port-forwarding sync** (owner request after registering an HTTP-server service): ① a listener on a registered ACTIVE service's declared port is recognized as that service — the Ports panel names it with a service tag and the anonymous "new port" toast is suppressed (registration-first, discovery-second); ② a service registered with `--publish` now automatically gets a port forward + (when the frp plugin is configured) a public URL on reaching `up` — shown as a clickable ↗ chip on its job card and in polls (`publishedUrl`), re-established on boot adoption, torn down (unpublish + unforward) on stop/park. Publish failures never break the service itself.


## 2.342.2

- **Chicken-and-egg teaching gap (owner catch)**: the `vibespace-job` teaching block only existed in the NO-GROUP baseline tools intro — grouped sessions (nearly all real ones) build their tools section in task-groups.js renderContext, which never mentioned the command, so agents in groups could never learn to create jobs (and with zero jobs the digest is deliberately zero bytes — nothing would ever bootstrap). The grouped intro now carries the same one-trigger-sentence + copy-ready example (`--keep-up`/`--every`/`--cron`/`--at` cheat line, dated-obligations→--at pointer), the per-turn micro-reminder lists vibespace-job, and both honor the agents.toolJobs toggle.


## 2.342.1

- **Background Work in the activity rail + visual redesign** (owner feedback "界面也太简单了/为啥不放到rail里"): new rail item with live badge (red `N!` = failed/missed/unverified, amber `N?` = awaiting your input, green count = running) and a compact rail panel (shared renderer with the window); the window gets severity-colored cards (left border green/amber/red), kind-icon section heads with up/total counts, progress/port/group chips, a summary toolbar (`2 running · 1 failed`), a ＋New dialog (user-created jobs via the new cookie-authed POST /api/jobs — schedule floors don't apply to you), and a cleaner expandable detail (payload block, access row + 🔒 lock, run ring, redacted log tail). All strings still textContent-only; glyphs are text symbols (emoji ban).
- **Injection placement fix (owner catch: "resume context里没有")** — the jobs digest had landed in prompt-context (per-turn, context burn) instead of task-context: now the digest rides SessionStart/RESUME (task-context, after group context, under the same 9600B cap) and prompt-context carries only NEW-event deltas. A resumed session rediscovers its background work in its resume context, as designed.
- Screenshot-verified in a worktree instance (window + rail panel, demo jobs incl. failed/running/cron states).


## 2.342.0

- **Background Work — agent-detachable services, long tasks, and cron** (docs/design-background-work.md, owner-approved v3.1; this machine only — cross-machine parked pending owner design). Agents get `vibespace-job`: `run "cmd" --name x --context "brief"` (the context payload is echoed verbatim at every poll — the amnesia-proof brief), `--keep-up` for supervised services (boot replay incl. across pod rebuilds, crash backoff with park-after-6, adopt-first restarts), `--every/--cron/--at` schedules (jittered, 15min agent floor, catch-up-once, missed⇒notify — never a silent skip), `--until "MARKER"` completion, blocking/non-blocking poll (CLI caps --wait at 100s under the harness 120s Bash timeout), `progress`, verified `stop` (services stay down), `rm` that refuses live jobs. Process identity = pid+starttime+bootId written by the wrapper as its FIRST act and re-verified at every adopt/kill (never pattern-kill, never pid-reuse roulette); single-engine lock (a second server against the same data/ goes read-only); engine initializes after listen and can never block boot; store is atomic + broadcast, runtime `_`-keys never persisted.
- **Interaction Panels**: a job (or its agent) posts a declarative widget panel (`vibespace-job ask --form @panel.json` — md/image/input/textarea/choice/checkbox/buttons/progress, validated in the PURE model, 32KB cap, versioned); the user answers in a small `job-interact` window; the job reads replies via `vibespace-job answers --wait` or (with `--stdin-open`) as JSON lines on stdin. Agent markup never touches our DOM.
- **Permissions with no existence oracle**: view/control ∈ session/group/all (agent defaults view=group, control=session), ownership keyed to conversation lineage (resume-proof) with the sessionId+createdAt tuple as fallback; mutation is owner-only (control never grants edit); user locks (🔒 in the panel) refuse agent access changes; invisible ids answer with the identical not-found reply as nonexistent ones; names are scope-namespaced (collisions auto-suffix).
- **Context injection**: session-start jobs digest + per-turn `<vibespace-jobs-update>` deltas — view-filtered at render time, 600B budget with floor-line degradation, never trips Claude Code's 10240B persisted-output wrap (prototype-measured); zero jobs = zero bytes. No automatic agent triggering anywhere (owner red line): cron actions are spawn-task and notify only; poll is the primary interface.
- **§ban-safety guardrails**: job/probe env is credential-stripped, vendor-host/credential-path patterns are refused at create time with a teaching error, recurring schedules carry mandatory jitter and floors — negative-control-tested (test-job-model 36 asserts, test-jobs-engine 16 real-spawn asserts incl. adopt-across-engine-generations, both in npm run ci).
- Jobs window (⚙ → Background Work): three sections, run-history ring with exit causes, context payload, per-job access dropdowns + user lock, log tails (secret-value literal-redacted), read-only listing of hand-rolled systemd/crontab escapes.


## 2.341.1

- **Dial-device ops broken since the 拆分 (userW's mount failure: "Cannot find module './package.json'")** — extraction #13 moved the dial-pairing primitives from server.js (repo root) into src/server/dial-pairing.js and two `require('./package.json')` came along verbatim, now resolving inside src/server/ where no package.json exists. Both sit on hot paths — `deviceForDial` (every dial-device op that constructs a fresh DeviceManager: mounts, terminals, probes) and `ensureAgentdOnHost` (ssh agentd install) — and throw only at CALL time, so no boot smoke, route battery, or free-variable check ever saw it. Sixth lost-binding incident; first of the RELATIVE-PATH subclass (the other five were free identifiers). Fixed to `require('../../package.json')`.
- **New permanent gate**: test-architecture #8 statically resolves EVERY relative require/import under server.js + src/ (any of .js/.json/.mjs/index.js) and fails the build on a dangling one — negative-controlled against the exact pre-fix file. A full-tree sweep found exactly these two sites broken, nothing else.


## 2.341.0

- **File editors/viewers can reload from disk** (owner report: an HTML file changed on disk was unreachable without closing the window). CodeEditor: new ⟳ toolbar button + a freshness watch — the on-disk mtime is baselined at load/save and polled every 15s while the tab is visible (local files; remote ssh hosts check on tab refocus only — no ssh-per-tick polling); a clean editor auto-reloads (scroll/cursor preserved, visible preview re-rendered), a dirty editor shows a "⚠ File changed on disk" chip and reload always confirms before discarding edits — never silently. Viewer windows (image/video/pdf/csv/xlsx/eml/docx/pptx…) get a floating ⟳ that re-renders with a cache-bust param on media URLs (/api/file/raw sends no cache headers, so a same-URL img/video could re-serve stale from the browser memory cache). Preview rendering extracted to `_renderPreviewNow()` shared by the Preview toggle and reload.


## 2.340.3

- **Renderer-freeze self-gap channel** — the rAF-vs-timer stall detector can't see a freeze where BOTH stop together, and the suspend detector needs 45s; the stall watch's own 1s timer now reports its late-fire gap (>4s) as `renderer-freeze`, covering the 5-45s whole-renderer/system band. First fully-instrumented freeze capture (00:43 typing freeze) showed the OPPOSITE shape though: our tab's timers ticked ON TIME through the user-perceived 30s system freeze, longtask max 98ms, zero compositor stalls — the page was healthy while the SYSTEM froze, pointing squarely at host-level GPU/driver or another process on the machine.

## 2.340.2

- **CRITICAL latent: passive rate_limit_event capture dead since the 2.325.0 decomposition** — `parseRateLimitEvent`/`captureRateLimitEvent` were free identifiers in usage-pool-engine.js from extraction #5 onward; recordRateLimitEvent's own try/catch swallowed the ReferenceError into a `[usage] capture failed` log line (48 occurrences since Aug 13, found while diagnosing a stuck session). Fifth lost-binding incident, first LATENT one — the runtime-throw class the boot/route batteries can't see when a catch eats it. Consequences while dead: no limit-banner→pool-eval reflex from rate_limit_events, no rate_limit anchors (part of the scoped-bucket anchor starvation the 2.340.0 audit measured). Import restored.
- Degrade-gracefully lesson re-pinned: the 2.284-era rule — a catch that logs the message VERBATIM is the only reason this was EVER found — now needs its sibling: **grep the journals for "capture failed"-shaped lines after every decomposition.**

## 2.340.1

- **Telemetry survives the server-restart window** — failed sends (exactly the "froze during the update" window the owner keeps hitting) parked events into localStorage (cap 200) and drain on the next boot; the old path silently dropped them. Pagehide keeps best-effort beacon. This occurrence itself produced no data for two now-closed reasons: the tab's bundle predated the 2.339.4 compositor-stall detector (it only arrives via the post-restart reload), and the freeze-window telemetry was dropped by the old send path.

## 2.340.0

- **Dead-reckoning calibration batch (owner audit: burst intervals under-estimated 20-45%)** — four fixes: ① rate-learning pairs require SAME-SOURCE endpoints (cross-channel steps taught phantom rates); ② a ≥5pt Δu with ledger cost under 20% of the prior-implied movement cost is tainted (reading discontinuities / unattributed burn — the 11-13pt/1-minute contamination pairs); ③ org-merged identities union '__global__'-attributed cost under a 14-day stream-recency gate (global-login spend was silently excluded once any named sub existed — deliberate reversal of the 2.263 rule, reassignment concern kept via the gate, both semantics pinned in tests); ④ predictions extrapolate the ~20s un-scanned ledger tail at the trailing rate (lagS knob, idle untouched) and `seven_day_<model>` rate_limit_events now write scopedWeekly readings — the scoped buckets' only passive channel, previously dropped. Suites: usage-estimator 80, rate-limit-capture 25, anchors 12, pool-auto 67. Accuracy re-audit after a 1-2 day observation window.

## 2.339.4

- **Compositor-stall detector (the RTX 5090 verdict)** — the GPU probe answered: ANGLE D3D11 on an RTX 5090, hardware acceleration fully on, main thread idle during the freezes — so the stall is in the driver/DWM pipeline (or GPU contention from another process on that machine), not page raster throughput. New in-page discriminator: rAF is vsync-driven while timers are not, so "timers alive + rAF dead >2s while visible" measures a compositor/GPU freeze directly — duration lands in telemetry (`compositor-stall`) and incident snapshots (`compStalls` ring). The next 卡顿 report carries its own measured freeze windows.

## 2.339.3

- **The Windows freeze is COMPOSITOR/GPU-side, not main-thread (inc-msvadwtt-8ksy, first instrumented capture)** — the 2.339.1 tab caught a 26s freeze while the longtask ring showed a maximum task of 168ms all evening: the main thread was idle, so the stall lives in raster/composite (input is delivered through the compositor, which is why even the OS cursor freezes — and why moving the CHROME window, which forces present-sync against a backlogged GPU process, is a trigger). Fixes: every workspace window gets its OWN compositor layer (`will-change: transform` — moving/overlapping windows now re-composites cached textures instead of re-rasterizing the huge chat DOMs each frame; hidden-desktop windows are visibility:hidden and don't rasterize). Forensics: a GPU-renderer probe (UNMASKED_RENDERER) lands in boot telemetry and incident snapshots — the next report answers "real GPU (ANGLE/D3D11) or SwiftShader software rendering" definitively. Also fixed: incident bundles' clientVersion was always empty (app._version never existed — now BUILD_VERSION).

## 2.339.2

- **Stuck-on-thinking after a server restart, rootcaused (owner report: 设备运维大师/79928a2b)** — two fixes:
  - **Counter-collision sessions restored from the wrong files**: boot-restore reads the wrapper sidecar/buffer as `<socket-derived id>.{json,buf}`, but sessions born in the 2.302.0 counter-collision window carry a DIFFERENT id in their wrapper argv/env — the reads hit nonexistent paths and a catch{} silently dropped streaming state, goal, todos, running-agent watchers and the buffer replay on EVERY restart. New src/server/wrapper-files.js resolves the real pair from the socket's dtach-master argv via /proc when the expected sidecar is missing (test-wrapper-files, 3, incl. a live decoy-process resolution).
  - **Attach-time streaming reconciliation**: the wrapper sidecar flips `streaming:false` the moment the result record flows; if the server still believes a local chat session is mid-turn while the settled (>3s) sidecar disagrees, the attach heals it — a missed result (restart window / parse detach) can no longer show "thinking" forever.
  - The stuck conversation itself: its turn had ENDED cleanly at 20:47:40 (result success, wrapper sidecar streaming:false) — the label was pure state residue; nothing was lost.

## 2.339.1

- **Browser-window drag-resize freeze (inc-msv9aa69-si7p, the third door)** — the incident bundle showed the freeze hit a PRE-2.338.0 page (loaded 7.8h before the fixes shipped), and named a trigger the batch didn't cover: moving/resizing the Chrome window itself. During the drag all windows re-lay out per frame; each chat window's minimap ResizeObserver then read rects after layout and wrote styles (another forced layout per window per frame), and geometry drift fed the extend gates. Fixes: minimap syncBounds is rAF-coalesced, and a cheap per-frame viewport-resize stamp keeps BOTH chat extend branches closed for 400ms around any browser-window resize (same displacement-is-not-intent rule, third entry point).

## 2.339.0

- **"For you" inbox badge grouped by urgency (owner request)** — the single total-count pill (colored by worst urgency) becomes up to three adjacent pills: urgent (red) · high (yellow) · rest (accent), zero tiers hidden, so the high-priority count is readable at a glance. Tooltip lists the breakdown.

## 2.338.0

- **Windows Chrome freeze batch (owner report: typing past 3 lines / new messages / server-update refresh froze the page for seconds-to-30s, self-recovering)** — three audit maps, eleven mechanisms, the big ones:
  - Typing: the chat-input autosize did write→read→write per keystroke (two forced layouts) and every real wrap shrank the scroller, drifting scrollTop via scroll-anchoring with zero user input — and `_extendTop` had no positive-evidence gate, so it paged 50 messages per bounce until history ran out (the round-5 disease through an uncovered door). Autosize is now rAF-coalesced with a no-op skip; extendTop requires recent REAL user input exactly like extendBottom; input-driven container resizes stamp a 250ms displacement guard over both extend branches.
  - New messages: `_forceScrollToBottom` started an independent 10-frame forced-layout chain per create/edit/delta (overlapping chains = N full-document layouts per frame) — now one chain with a refreshed countdown. The full-list runs pass is rAF-coalesced (still pre-paint, no fold flash). Streaming re-parse of the full accumulated markdown is throttled to 150ms. Code blocks: plain (unhighlighted) output skips the span-carry line walk, and per-line DOM is capped at 3000 lines with an honest tail marker (a 300KB Read used to build ~24k nodes in one synchronous innerHTML).
  - Server-update refresh: every chat window used to wipe + re-render its 50-message tail in the same tick (and reconnect catch-up rendered 200×N) — both now stagger 0-500ms per window. Boot restore suppresses the per-window O(all-windows) bookkeeping (taskbar/switcher/overlap) behind a batch flag with ONE pass at the end. WebGL terminal contexts are capped at 12 (past Chrome's ~16 limit the oldest silently died and fell back to the slow DOM renderer; on Windows/ANGLE the creation burst can stall the GPU process = whole-page freeze).
  - Instrumentation: PerformanceObserver longtask ring + ws-type attribution ring; the 45s wake detector now distinguishes real page suspends from main-thread blocks (sum-of-longtasks rule) and its stale "belt resync" (dead code — app.stateSync never existed) actually runs via getStateSync().
  - Regression control: scripts/test-chat-paging.mjs green (scripted wheel paging unaffected by the new gates).

## 2.337.3

- **Usage popup identity note rewritten (owner confusion report)** — the "⚠ CLI config file says X but token belongs to Y — run /login" warning was factually right but semantically wrong twice over: the global config's oauthAccount is stamped by EVERY relocated account login (the flow only relocates the credential store — 2.244.2), so after adding any account it is expected residue, not the machine's login identity; and the /login advice would trigger a needless real global login switch. Now: a neutral note explains the org-merge ("the machine's global CLI login is this same subscription — quota merged") and the residue ("no action needed"). Data and linking (token-derived orgEmail/orgUuid) unchanged.

## 2.337.2

- **Fix client-boot smoke on GitHub runners** — chrome on ubuntu-latest needs `--no-sandbox --disable-dev-shm-usage` (tiny /dev/shm) and a longer CDP cold-start window; the first Actions run with the full gate died on a bare null-target TypeError at 10s while chat E2E itself passed (haiku turn green from the runner). Missing target now fails loudly with chrome's own stderr.

## 2.337.1

- **Chat E2E now also runs in GitHub Actions (owner correction, verified against official docs)** — docs/en/github-actions explicitly documents `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) as a repository secret for subscription-authenticated CI; the previous "never wire the token into Actions" stance over-generalized the ban postmortem (whose datacenter-IP co-factor was about RAW token usage in unofficial shapes, not this sanctioned channel). Workflow installs the claude CLI and passes the VIBESPACE_CI_OAT secret; fork PRs get no secret and the test SKIPs.

## 2.337.0

- **Release gate covers chat INFERENCE end-to-end (owner-directed: long-lived token + haiku)** — new scripts/test-chat-e2e.mjs runs ONE real haiku turn per push through the product's own pipeline: ws `create` → oat account plumbing (seeded via the real AccountManager into the worktree store) → chat-wrapper stream-json spawn → normalizer → ws push, then asserts the reply round-trips (derived magic word, immune to prompt echo), the turn SETTLES (the /compact-class "stuck on thinking" regressions), and the session bills through the seeded account. Token slot: `~/.config/vibespace/ci-oat` (0600) or VIBESPACE_CI_OAT; no token / no CLI → clean SKIP. Deliberately NOT wired into GitHub Actions: a subscription token doing inference from datacenter IPs is a documented ban co-factor — the local pre-push gate runs it where traffic is indistinguishable from normal use. Gate now 24 suites.

## 2.336.1

- **Release gate covers the FRONTEND face of "打不开"** — new scripts/test-client-boot.mjs boots the real app in headless chrome against a worktree server (working-tree overlay) and asserts what the user actually needs after an update: app.ready resolves, the loading screen is GONE (the 2.330.x symptom), the websocket is open, zero uncaught exceptions during boot. Negative-controlled: shipping a 2.330.0-shaped broken bundle makes the probe go red and captures the crash. In `npm run ci` (now 23 suites, ~55s) and the Actions mirror; environments without chrome skip it cleanly (the hook machine and CI both have chrome).

## 2.336.0

- **Mandatory release gate (owner directive: "发版之前能有个强制CI，确保核心工作流能用")** — `npm run ci` (scripts/ci.mjs): build (arch/bundle-globals/ws-contract/session-schema/i18n inside) + the 21 gate suites the routing table names (discovery/remote-shell/usage-walk/ctx-sync/writer-sweep/transcript/sysinfo/local-device/session-brain/agentd-session/migrations/vendor-whitelist + the account/pool/usage batteries) + the worktree boot smoke with its 27-route battery LAST, ~90s total, fail-fast. **Enforced at `git push` by a tracked pre-push hook** (scripts/git-hooks/pre-push, installed via npm postinstall; composes with the global secret-scan guard which chains to it): docs-only pushes skip automatically, `VIBESPACE_SKIP_CI=1` is the emergency bypass. Mirrored in GitHub Actions (.github/workflows/ci.yml) so a bypassed local hook is still caught in minutes. The four lost-binding boot breaks (2.330.0/2.330.1/2.333.0/2.335.0) are the class this exists for — each passed every static gate and died only at boot or route-run time.

## 2.335.1

- **CRITICAL: 2.335.0 could not boot** — `notePoolAuthFailure` was exported by the pool engine and consumed at the session-stdout wiring, but never added to server.js's engine destructure: a free identifier at module load = instant ReferenceError = restart crash-loop. Fourth lost-binding incident; the reviewer caught it pre-release. Structural fix alongside: **scripts/test-restore-smoke.mjs now overlays the WORKING TREE's src/server.js/public into its worktree** — a pre-commit run used to silently test the previous release (worktrees check out HEAD), which is exactly how this one slipped past a green smoke.
- Review hardening batch on 2.335.0: auth-evict throttle is per (member, session) — a member-keyed throttle left every other conversation pinned to the banned account for 60s each; a cold pool's default-link move now restarts every session billing through the default, not just the reporter; the auth-mark self-heal keys on TOKEN MATERIAL change, not creds mtime (repointPoolSymlink utimes-bumps creds on every re-point, clearing an mtime-based mark with no re-login); deleting a pool's LAST explicit member no longer flips the member list to null (= "all logged-in subs") — that silently widened the pool onto deliberately excluded accounts and re-pointed billing there; message-only auth classification requires API-layer context in the text (an agent's own tool output saying "authentication_error" about some third-party system can never evict a member); the resume degrade also clears the dead accountId so keeper-adopt gates open. test-pool-auto 67, test-pool-signed-out 19.

## 2.335.0

- **Pool survives member deletion (owner report ×2)** — `accounts.remove()` of a claude subscription now heals every pool NOW instead of leaving wreckage for a lucky spawn to fix: the id is stripped from explicit member lists, a default symlink that targeted the deleted account re-points to a live member (or is unlinked — the pool reads honestly signed-out instead of dangling), and per-session links that billed to it re-point (or drop when no member is left). test-pool-signed-out grows to 17.
- **Resume survives a DELETED billing account** — resuming a conversation whose stored account id no longer exists degrades to the global login with a server notice, instead of bricking on "unknown account" forever (nothing to re-login — the record is gone). Fresh creates keep the loud failure.
- **Auth-class failures now trigger pool switching (owner report: 封号/欠费/过期从不切换)** — new pure `classifyAuthFailure` (403 immediate; 401 only on retry ≥2 — a lone first 401 is the token-refresh race; ban/credit/oauth-expired messages immediate; 5xx/overload never) feeds `notePoolAuthFailure` from the CLI's own api_retry and error-result records: the failing member is marked (10min TTL, cleared the moment its creds file is rewritten by a re-login), the session's link and the pool default move to the best other member by the same EDF ranking, the user is told, and cold pools get the conversation-restart ask. Quota evaluation and the model chooser exclude marked members. Runs regardless of the pool's `auto` flag — routing around a dead account is healing, not optimization. test-pool-auto grows to 65.

## 2.334.1

- **Fix: ghost host selection bricks Recent/History (fleet report)** — a persisted Recent/History host pick whose host record was later REMOVED left the switcher `<select>` rendering BLANK (a value with no matching option) and both zones stuck on "发现失败: host not found" + 无法连接 forever, with zero affordance hinting the fix. The zones now SELF-HEAL: once the roster has actually loaded, a selection not in it resets to Local (memory + localStorage) with a one-time toast; a transient /api/hosts failure never wipes a valid pick, and a roster load with zero remaining hosts still triggers the heal render. CDP smoke: scripts/test-ghost-host-heal.mjs (7, incl. the negative control).

## 2.334.0

- **auto-cli idle slow rung (owner-directed)** — accounts with NO active burn now also refresh via `claude -p /usage` once their reading is older than a per-tick-RANDOMIZED 30–60min threshold (a wandering threshold, never a fixed metronomic cadence), so the roster never shows week-stale quota; never-read accounts bootstrap their first reading through the same rung. Consecutive failures back off exponentially (5min×2^n, cap ~5h) so an unparseable account can never spawn claude every 5 minutes forever. Drift still outranks stale-idle for the one serialized refresh per tick. Tests: scripts/test-auto-cli-refresh.mjs (10).

## 2.333.0

- **Fix: /api/agent-hooks 500 (Manage-Agents "无法读取 hook 状态")** — `agentHooksStatus` was never exported from the `src/server/agent-tool-generators.js` factory (2.325.0 decomposition casualty; the ReferenceError only fires when the route runs, so every build gate stayed green). Exported + destructured in server.js.
- **Structural guard: GET-route battery in the restore smoke** — `scripts/test-restore-smoke.mjs` now hits 27 cheap read routes on the live worktree server and fails on any 5xx; the lost-factory-export class always presents as a 500 with no boot log. Verified: the battery catches this exact bug on the pre-fix HEAD.
- **Re-login identity guard (owner directive: "orgid不对得自动变成新条目")** — `accounts.reloginResolve(id)`: after an on-this-machine re-login, the fresh login's identity (creds email / dir .claude.json) is compared to the record's. Same → in-place refresh; matches ANOTHER record → credentials move there ("moved", that account refreshed instead); unknown identity → a NEW entry is created and the fresh login moves into it ("split") while the original record stays signed-out with its history/usage attribution intact. New `POST /api/accounts/:id/relogin-finalize`; the re-login watcher toasts all three outcomes. Matrix test: scripts/test-account-relogin.mjs (13).

## 2.332.0

### Added
- **Account ⋯ menu: "Re-login on this machine…"** (user request; until now the only way to refresh a dead login was remove + re-add, which loses pool membership and identity continuity — exactly the dance the Natural Max token-death would have required). `POST /api/accounts/:id/relogin` returns the SAME env-scoped helper command the Add-subscription flow uses, pointed at the account's EXISTING creds dir; the client opens the login terminal and watches finalize. Success is judged by the helper's ATTEMPT id (finalize now reports `loginAttempt`/`loginState`, and the route hands the client a pre-login baseline) — so re-logging a still-logged-in account (rotating to a different login) never reports success before the browser flow actually completes, and a failed attempt surfaces the helper's error instead of polling forever. Signed-out rows show "Log in on this machine…", logged-in rows "Re-login on this machine…"; local Claude subscriptions only (host logins keep the dedicated "Log in on {host}…" path; pools have no login of their own). Suite: scripts/test-account-relogin.mjs.

## 2.331.0

### Fixed
- **The boot resume-all offer now covers EVERY desktop, not just the active one** (real report: "重启后那个批量resume弹窗只会批量resume当前desktop里的窗口"). Mechanism: at boot, restoreState — where the offer's collector lives — runs only for the ACTIVE desktop; every other desktop's windows are lazy saved states that replay on first visit, so their interrupted sessions never reached the popup. `scanStoppedInDesktopStates` (PURE, exported) now scans the non-active desktops' saved window states directly from the same /api/layouts payload, mirroring restoreState's aliveness logic exactly (live sessions skipped; remote windows — which can never match LOCAL discovery — collected from their openSpec identity with hostId). Collection only: the lazy desktops keep their saved states, and each resumed session lands back on its HOME desktop at its saved spot via `winBounds.desktopId` (the 2.295.0 placement); when a lazy desktop is later visited, its replay attaches by serverId and dedups against the already-resumed window. Suite: scripts/test-resume-all-desktops.mjs (9 — active-desktop exclusion, live skip, remote identity, custom names, home-desktop bounds, hostile input).

## 2.330.2

### Fixed
- **A pool with a signed-out target became a hard stop instead of routing around it** (real outage: every session resume failed with `pooled target is not logged in`). Two of the pool's subscriptions had their refresh tokens age out while idle — the CLI clears credentials when a refresh is rejected, leaving a token-less husk — and the pool's default target plus ALL THREE per-session links pointed at one of them. `poolMembers()` had always excluded signed-out accounts, but `resolveForSpawn` only ever THREW when the current target was dead, so the exclusion never got a chance to matter and the UI offered no way forward. Now: a dead target (or a dead per-session link) RE-POINTS to a live member and the session starts, with a loud log + `pool-target-signed-out` telemetry naming both accounts; the quota chooser's pick is validated against credentials before use (quota ranking cannot outrank being signed in — same outage, second door); and a pool whose members are ALL signed out fails with an actionable message naming Manage Agents instead of a bare "not logged in". Suite: scripts/test-pool-signed-out.mjs (9), including the exact husk shape the CLI leaves behind.

## 2.330.1

### Fixed
- **The blank-boot fix was itself incomplete — the deleted import line carried FOUR names, and 2.330.0 restored one.** `reportBootTime` (and `track`/`metric`) were still unbound, so the app still threw on boot. Full line restored. Root discipline failure recorded: I patched the symbol whose error text the user pasted instead of restoring the line the deletion actually removed — the same "fix the visible surface, not the cause" trap the account-semantics chain taught, one release apart.

### Added
- **`scripts/test-bundle-globals.mjs` — the guard that makes this class impossible to ship**, wired into `npm run build` right after esbuild. It exploits a property of the build itself: `esbuild --minify` renames every BOUND name to 1-3 characters, so any of OUR OWN symbols (collected from src/lib/**/*.js + src/client.js exports and declarations) surviving verbatim **in call position** in the minified bundle is a name esbuild could not resolve — a free variable, i.e. used-but-never-imported. A matching-paren test separates real calls from method definitions (esbuild never renames properties), which is what keeps the signal clean. **Negative-controlled against the real regression**: with the import line removed and a genuine rebuild, the guard FAILS naming both symbols; with it restored, it passes. A source-side twin was written and DELETED — deciding "used but not bound" in source needs real scope analysis (destructuring, params, closures) and the approximation produced false positives; esbuild has already done that analysis, and reading its answer out of the output is exact. One check that cannot lie beats two where one does.

## 2.330.0

### Fixed
- **CRITICAL — the app would not boot at all on 2.327.0+ (blank loading screen).** `Uncaught ReferenceError: installTelemetry is not defined`: the 2.327.0 dead-code deletion removed `installOverlapTracer` with a LINE-based regex, and the import it sat on was shared — `import { installTelemetry, installOverlapTracer } from './lib/telemetry-client.js'` — so the whole line went, leaving `installTelemetry()` as an undefined global at the very top of client.js. esbuild happily bundles an unresolved free identifier (it is a legal global reference), so the build stayed green and every gate passed; the first line of app boot then threw and nothing after it ran. Import restored. **Lesson (recorded): a line-oriented deletion regex must be verified against the LINE, not the symbol — and a green build is not evidence that the client boots.**
- **agentd self-upgrade could never converge, and retried forever** (this instance: ~10s cycles for 8h, RSS 20.5GB). The expected daemon version was the SERVER's `package.json` version while the bundle actually shipped is whatever is on disk — the two diverge whenever the repo is rebuilt without restarting (all of dev, plus a few seconds of every update.sh). A daemon that installs the shipped bundle then reports the bundle's version and is judged wrong AGAIN. Two independent fixes: (1) the expected version now comes from the shipped bundle's own baked `VERSION` marker (cached by mtime+size, falls back to package.json, never throws); (2) a LOOP BREAKER — an upgrade that does not move the reported version can never converge, so after 3 attempts the link is kept and used as-is (capability gating already makes an older daemon safe) with a loud one-time log + `agentd-upgrade-stuck` telemetry. Suite: scripts/test-agentd-upgrade-loop.mjs (9, incl. the incident's exact version shape).

## 2.329.0

### Added
- **auto-cli quota refresh (owner-approved, reversing the 2026-08-09 blanket auto-refresh ban for the CLI-panel channel specifically).** New `accounts.onDemandQuotaRefresh` mode **auto-cli**: a background loop ground-truths subscription quotas by spawning `claude -p /usage` — the OFFICIAL binary makes the fetch exactly as if the user typed /usage (ToS "explicitly permit" lane: headless mode + the documented GitHub-Actions subscription flow; this instance still never calls the vendor endpoint itself, vendor-whitelist unchanged). Cadence is **BURN-AWARE, not fixed** (the owner's "30min太慢, workflow快跑容易挂"): the dead-reckoner's own drift signal (estimate vs last reading, ≥4pt on any bucket) triggers a refresh within minutes during a fast burst; active-but-slow accounts refresh at a 45min+jitter staleness cap; **idle accounts are NEVER polled** (activeBurn gate — the ban-postmortem's idle-account-on-a-timer signal stays structurally impossible); 5min per-account floor + one CLI spawn per tick serialize everything. The decision is a PURE function (decideCliRefresh in src/account-pool-auto.js, suite scripts/test-auto-cli-refresh.mjs 7); the refresher (refreshViaCliPanel, extracted from the ⟳ route's rung 2) writes the same per-account cache the statusline uses, so pool switching, estimator anchors and the popup all sharpen automatically. Default stays 'manual'; this instance is switched to auto-cli.

## 2.328.1

### Fixed
- **The "machine CLI login expired" usage-popup notice now says it is NORMAL and warns against /logout (the Natural Max incident's real product lesson).** Round-4 forensics: the user saw the benign 2.266.2 expiry notice, opened claude (the TUI opens with no login wall — "it opened fine" proves nothing about login state), concluded something was wrong, and ran `/logout` as a manual remedy. The /logout was a no-op on everything observable (machine login's refresh chain was alive at 18:05 the same day; a revoked chain cannot refresh) and structurally could never touch Natural Max (cross-account revocation does not exist) — but the notice INVITED a destructive self-remedy on a multi-copy account class where /logout revokes the login everywhere. The wording now says: normal under pooling, no action needed, do NOT /logout to clean up. All three languages.

## 2.328.0

### Added
- **One-shot migration framework, BOTH tiers (owner plan B: "本地和device都跑").** `src/migration-runner.js` (SHARED — the daemon bundles it) = ledger-keyed run-at-most-once semantics: failed migrations log verbatim + retry next boot and never block startup; archive-never-destroy; append-only dated ids. Local registry `src/server/migrations.js` runs at boot before restoreSessions (ledger data/migrations.json) and ships its first real entry — the dormant checklist `plan` arrays (feature removed 2.121.0) are archived to data/archive/task-plans-legacy.json and stripped from the live store. Device registry (`DEVICE_MIGRATIONS` in agentd.js, ledger `$ROOT/state/migrations.json`) runs at daemon boot after the singleton — the sanctioned channel for eventually retiring device-local wire residue (a future entry can rewrite dial.json endpoints; once fleet telemetry shows every daemon past it, the permanent alias can go). Pre-framework one-shots (home-rename, store `.migrated` markers) stay where they are with their own guards. Scope note recorded in the routing table: wire-compat residue on machines we don't control (410 responders, capability gates) is NOT migratable — it retires by fleet-telemetry condition, not by a local run. Suite: scripts/test-migrations.mjs (11).

### Fixed
- **"Natural Max 已登出" forensics (user question — NOT env pollution, direction was the opposite):** the machine login is intact (token refreshed hours later); what died was the HELD COPY in data/subs — wiped to a token-less husk at 14:17, the same minute the pool pointed the VibeSpace Debugger session at it. The user's `/logout` in a terminal revoked/rotated the SAME login's other copy, so our held copy's next refresh was rejected and the CLI cleared it by design — the documented two-copies-of-one-login fork (the exact reason macOS Keychain shadows are never copied and subscriptions don't ship by default). Per-session spawn env (CLAUDE_SECURESTORAGE_CONFIG_DIR) is per-account-dir and structurally cannot leak into ~/.claude. Remedy: re-login Natural Max via Manage Agents; the pool had already routed around it.

## 2.327.0

### Fixed
- **翻页弹跳 round 5 (inc-mspemym2) — two STRUCTURAL gates that don't depend on timing.** The tracer finally captured both bounce shapes end-to-end. ① **PIN GATE**: content-visibility height resolution drifted scrollTop 92→0 over 400ms with `pin=1` and ZERO user input; the scroll handler's `st<100` branch then walked the window up 4 slabs (200 messages) and the pin machinery ping-ponged the view 0→2141→0 against the pager's anchor restore. A pinned view is at the live tail by definition — the scroll handler now NEVER pages it upward; a wheel-up that pages explicitly unpins first (real intent always arrives as wheel-up). ② **POSITIVE-EVIDENCE GATE**: the capture's second bounce fired `extendBottom` 2539ms after the last real wheel — cv resolution OUTLASTS both time-boxed gates (1200ms wheel window, 600ms lockout), and native anchoring then pushed scrollTop into the "near the end" band with every gate expired. While reading history (unpinned, partial window), extendBottom now requires RECENT USER INPUT (wheel/touch/pointer/keyboard ≤1.5s) — displacement is not intent, and absence-of-contrary-evidence is no longer permission. Scrollbar/keyboard readers count via new pointerdown/keydown input taps. Suite: test-paging-collapse-guard (36, both field scenarios pinned as fixtures).
- Three test guards were still reading server.js/ws-handler for code the decomposition moved (test-auto-graduate, test-claude-subscription-login — which CRASHED when run, test-tool-progress) — re-pointed at src/server/mounts-plugins-wiring.js / src/ws-create.js / src/server/session-stdout.js / src/server/account-usage-routes.js.

### Changed
- **`claude -p /usage` becomes rung 2 of the human-gated quota ⟳ ladder** (user-verified channel): session get_usage probe → **CLI panel spawn** → raw token read. The CLI panel is the ONLY no-live-session channel that carries ALL THREE buckets incl. model-scoped weeklies (Fable), the fetch is made by the first-party CLI (identical to typing /usage), zero vendor HTTP from this server, and accounts with no live session — the old "no valid token" dead end — become refreshable. Named subscriptions probe via their own creds dir (CLAUDE_SECURESTORAGE_CONFIG_DIR, session-spawn parity); ambient key/oat env stripped. Parser pinned against a real captured panel: scripts/test-cli-usage-parse.mjs (11, incl. IANA-zone reset-time conversion + year rollover + API-key-mode null).
- **Dead-code deletion batch (9-agent audit workflow, every deletion adversarially verified)**: data/bin/dtach-wrapper.sh (pty-wrapper precursor, zero refs), _showAccountsWizard (105 lines, unreachable since the 2.268.3 menu retirement), installOverlapTracer (2.105.0 temporary diagnostic), the retired .badge-config row-pill JS (superseded by the 2.224.1 config corner dot), CODEX_CHAT_WRAPPER in dial-pairing (never consumed), the consumer-less 'plugins-updated' and 'exits-updated' ws broadcasts, the always-undefined syncHookRegistration vestige export, three orphaned dbg-* scripts. The `mk` lazy-Proxy helper deduped from 8 copies into src/server/lazy.js.
- **Doc-drift pass (audit-confirmed stale present-tense claims)**: docs/architecture-map.md marked HISTORICAL with an executed-plan banner; docs/design-three-tier.md status → EXECUTED (R0–R6 complete, session-brain 1–4 shipped, activation switches remain); docs/device-agent.md flags-premise (default-ON since 2.158.0) + per-instance daemon-root stop instructions; docs/design-cs-unification.md remaining-list markers; docs/mounts.md retired agentd.dataPlane flag reference; stale flag comments in hosts.js/server.js. Legacy-inventory verdict recorded: the remaining "legacy" is 18 keep-forever fallback rungs + 5 flag-gated activation paths — BY DESIGN, not debt.

## 2.326.0

### Changed
- **拆分P2 — the ws-handler contract is EXPLICIT and the create family is its own module.** `src/ws-create.js` holds the 1633-line session-CREATE case verbatim (new/resume/fork, local + ssh/dial/daemon-pipe spawn, account resolution, crash-loop + resume breakers, writer sweep, keeper adoption); the body runs inside `do { … } while (0)` so every case-level `break;` keeps its exact pre-extraction meaning. ws-handler: 2723 → ~1100 lines. `WS_CTX_CONTRACT` names every dependency and registration VALIDATES it — a missing key is a loud boot error naming itself, never an `undefined` surfacing mid-create. New guard `scripts/test-ws-contract.mjs` pins the destructures, every late `ctx.*` access, and server.js's call site to the contract. The remote-shell / writer-sweep / id-race / architecture drift guards were re-pointed to scan ws-create too.
- **拆分P3 — the session blackboard has OWNERS.** `src/session-schema.js` (PURE tier) registers all 47 live-session `_fields` with owner module, persistence home (session-meta / wrapper-meta / in-memory), and a one-line note; `scripts/test-session-schema.mjs` fails any NEW unregistered field write in the server-side session files and any dead schema row. The blackboard can still grow — but never anonymously.
- Both new guards + the architecture suite run inside `npm run build`. **Build-order fix:** the architecture suite now runs AFTER esbuild — it validates the just-built daemon bundle, and a fresh checkout's FIRST build no longer fails on the not-yet-existing artifact (caught by test-attach-rescue's worktree build, which builds from a pristine tree).

## 2.325.0

### Changed
- **拆分P1 COMPLETE — server.js is now BOOTSTRAP + WIRING (6423 → ~1910 lines; 14 modules under `src/server/`).** The whole mechanism layer moved out verbatim behind `create(deps)` factories: agent-tool-generators, goal-sync, sysinfo-wiring, incident-wiring, **usage-pool-engine** (714 lines — fallback belt, pool auto-switch incl. the plan-C per-session pass, get_usage probe, anchors sweep, offline-bias, sealed orders, estimator), **session-stdout** (995 — setupSessionPty/attachToDtach + the session-meta store), **boot-restore** (555 — migrations + restoreSessions + R6 pipe re-open + keeper re-adoption), **session-brain** (parity comparator + sbSeenFirst + claudeSideEffects), **account-usage-routes** (385 — collector ingest + usage-stats + the full accounts route family), **exit-routes**, **ops-routes** (version/self-update/maintenance), **mounts-plugins-wiring** (498 — MountManager/PluginManager/DialSessionBridge/graduateHostToDial), **dial-pairing**, **cli-env** (X display + adapter registry + CLI probes + model registry). Late-created singletons arrive as lazy getters/Proxies (never cached); mutable `let` state (deviceMgr) crosses as an explicit `get*()` — a Proxy would erase its null check.
- **The architecture suite is now also a SIZE RATCHET (40 asserts):** server.js must stay ≤2100 lines and `src/server/` must keep its module count — new server-side mechanisms go in a module per the CLAUDE.md routing table, never back into the bootstrap. The id-race and vendor-whitelist structural guards were re-pointed at the moved code (the vendor allowlist entry for the /v1/models fetch now names src/server/cli-env.js — same gates, new address).
- **New permanent gate: `scripts/test-restore-smoke.mjs`** — a worktree-ISOLATED create→SIGKILL→reboot→reconnect cycle across the decomposition seam. Its first run caught the one real wiring bug of the campaign (session-stdout read the mutable `deviceMgr` binding as a stale capture), which the empty-data boot smoke could not reach. Two more decomposition bug classes found and fixed by loud degrade paths: `require('./package.json')` resolving module-relative after a move (three modules), and a hoisted file-level helper (`ensureDir`) silently traveling away with an unrelated block.
- Smoke discipline hardened: boot smokes now ALWAYS run in a throwaway git worktree with its own empty data/ — running `node server.js` from the repo dir attaches to PRODUCTION dtach sessions (the #127 incident class) and is banned; the restore smoke encodes this in its header.

## 2.324.0

### Changed
- **Physical decomposition campaign STARTED (owner green light: "直接按照终态启动").** server.js begins its march from a 6423-line god-closure to a bootstrap + `src/server/*` modules, with the 2.323.0 architecture conformance suite as the safety net (every extraction step runs inside `npm run build`). Extraction discipline: verbatim code behind a `create(deps)` factory, server.js destructures the SAME names (zero downstream renames), boot smoke + full gates per step. Landed: **#1 agent-tool generators + hook registration** (457 lines → src/server/agent-tool-generators.js; two leaked closure helpers localized, and module-relative `__dirname` corrected to rootDir — inside src/server/ it would have silently pointed the hook-optout file AND the temp-server hook guard at the wrong directory, the exact bug class the red test cannot see but boot smoke caught); **#2 goal-status sync** (82 lines → src/server/goal-sync.js, lazy hosts getter for boot order). server.js: 6423 → 5973 lines. Next: sysinfo-wiring, incident-wiring, then the pool/usage cluster.

## 2.323.0

### Added
- **Architecture conformance suite — the separation is now enforced by a red test, not by documentation** (owner directive: "我需要一个更强有力的手段保证分离架构"). `scripts/test-architecture.mjs` (38 asserts) parses the real require/import graph (incl. `export…from` re-exports) and enforces tier direction: PURE decision modules import NOTHING (not even node builtins); SHARED fact modules never reach up into orchestrator/client/device; the DEVICE tier pulls only shared+pure+its own files; the CLIENT talks to the server over the wire only; the daemon bundle is checked for orchestrator module markers. Deliberate exceptions live in an allowlist WITH reasons, and dead allowlist entries fail the suite (an unused exception hides the next violation behind it) — the vendor-whitelist mechanic generalized to the whole codebase. **Wired into `npm run build` before esbuild**: a re-coupling change cannot even produce a bundle.

### Audit (architect's honest inventory — what is NOT separated yet)
- The import graph is already clean (every tier-direction check passed on first calibration). The remaining coupling is exactly where the graph cannot see: **inside single files**. ① server.js (6423 lines) — pool engine, estimator wiring, session-brain comparator, incident capture, dial pairing, boot migrations share one closure scope; ② ws-handler ctx — a 30-entry implicit interface; ③ the session object as an unowned blackboard (~50 `_fields` written by everyone); ④ the client↔server ws protocol has no schema. These are the physical-decomposition campaign's targets; the conformance suite freezes the boundaries so decomposition can proceed without silent re-coupling.

## 2.322.0

### Fixed / Corrected
- **inc-msp3klen diagnosis CORRECTED — the freeze theory is retracted** (the user confirms the tab was foreground throughout; 证伪归档). Telemetry then cleared two more suspects: `srv-normalizer-msgs` jumped +3402 in the 12:54→12:59 bucket and went flat after — the server parsed and broadcast the reply ON TIME at 12:57:55, so the daemon pty relay and the mux credit flow are innocent too. What remains proven: a complete reply crossed the last mile (server ws → browser onmessage, same connection, heartbeat green both directions) 14.5 minutes late, flushing in an 11ms burst at the moment the user interacted. The remaining candidate seams (a lost `session.clients` registration; a wedged ws send queue with RFC6455 control frames interleaving past it) cannot be distinguished from this capture.
- **Delivery-stall WATCHDOG (self-heal + fingerprint)**: if a chat view believes the model is responding but NOTHING for its session has arrived in 120s (long tool runs emit `tool_progress` heartbeats, so true 120s silence is abnormal), it forces a re-attach — idempotent; the server replies with current history and streaming state, which repairs a lost registration AND re-syncs a wedged view alike. Caps the whole failure class at ~2 minutes instead of "until the user types", and each firing records `chat-stall-reattach` with the silence length — the instrument that convicts the real seam on the next occurrence. At most once per 5 minutes per view; read-only views exempt.

## 2.321.0

### Added
- **Page-suspend wake detector** (inc-msp3klen: "对话一直卡在输出，直到我发下一条消息才突然回复"). Forensics: the transcript proves the reply was COMPLETE at 12:57:55 — then a 14.5-minute hole, and the ws ring shows the whole backlog arriving in an 11ms burst on the SAME connection at the exact moment the user interacted, with zero reconnect markers and all three client rings silent for the window. Best-fit diagnosis: the BROWSER froze the page (Page Lifecycle / energy saver) — ws frames queue in the frozen renderer while the browser's network process keeps auto-answering the server's heartbeat pings, so the server correctly sees a live transport and never evicts. The page cannot prevent the freeze; it now DETECTS the wake (a 5s timer that should never gap — >45s between ticks = we were suspended), reports the gap to telemetry (`page-suspend-wake`), belt-resyncs the versioned stores, and shows an honest labelled toast ("Browser suspended this page for Ns — caught up now") instead of leaving a mystery stall. The hypothesis is deliberately INSTRUMENTED rather than declared: if a future stall recurs WITHOUT the wake event, the freeze theory is refuted by its own instrument and the investigation reopens with better data.

## 2.320.0

### Fixed
- **Remote machine zones looked EMPTY for the first 10–60s after a server restart** (inc-msp2srj2: "AIDev 默认没有 session, 必须手动刷新"). A cold discovery sweep blocks for the whole device-bootstrap / daemon-self-upgrade / ssh-master-rebuild window (12.3s measured on a healthy link, worse at real boot) — and for that whole window the zone rendered nothing, while the persisted last-known list (71 sessions) sat on disk consulted only on FAILURE. Cold calls now serve the persisted list INSTANTLY, stale-marked (measured 12.3s → 1ms), and kick ONE background refresh through the existing dirty→push channel — every client gets the fresh list when the scan lands. An explicit ⟳ still blocks for the real scan: "refresh" keeps meaning refresh.

## 2.319.0

### Added
- **B-47e2 — local session discovery via device #0, flag-gated** (`agentd.localDiscovery`, default OFF): the 5s `/api/sessions` sweep can read its filesystem FACTS (lock files, transcript listing, tail ids) from the device daemon's snapshot — computed in a daemon CHILD process, so a slow or NFS-mounted home can never stall the server's hot path. Everything local stays local (webui-pid mapping, tmux enrichment, claimJsonls, assembly); device lock facts arrive pre-verified (liveness + pidLooksClaude) so the per-lock re-probe is skipped; snapshot failure falls back to the local scan. Proven by scripts/test-local-discovery-device.mjs: output PARITY against the local scan on a synthetic HOME (incl. a live lock claiming its transcript), 44ms latency, and the daemon-down fallback — the test also learned to bust the sweep's own 4.5s TTL cache, without which parity was VACUOUS (the second call was served from cache).
- **B-0f13 — remote terminal sessions get the passive statusline quota capture** local ones have had since 2.60.0, closing #14's last gap. Three legs: `vibespace-usage` ships with the agent tools (per-spawn tar, sha-compared); remote claude TERMINAL spawns inject the statusLine `--settings` (the JSON rides the normal per-arg shq quoting — and the cache-dir env var was deliberately DROPPED after review: `$HOME` never expands inside shq's single quotes, and none is needed because the script's `__dirname/../usage-cache` default resolves to `~/.vibespace/usage-cache` at its shipped location); the `quota-refresh` device op ships the host's passive cache files back alongside its reply (pure file reads, zero extra vendor calls), merged server-side fetchedAt-GUARDED (a stale file never displaces a fresher reading) into the `host-<id>` / host-held account buckets.

## 2.318.0

### Added
- **Session-brain step 4 / R6: local chat sessions via device #0 `session.open` — FLAG-GATED, default OFF** (`agentd.localPipeSessions`, Integration). When enabled, a NEW local claude chat session runs the SAME chat-wrapper with the SAME buffer/meta paths as a daemon PIPE session instead of under dtach — the daemon supervises it (setsid child + offset reattach), so it survives server restarts through the daemon rather than through dtach, and the step-2/3 device streams cover it natively (`keeperSid` = the session id). Adoption-based per the design: existing sessions are never migrated, any daemon failure at spawn falls back to dtach (never worse), kill routes to `kill-pipe-session`, and boot re-opens `agentdPipe` metas by sid with the buffer-size offset (failure degrades to the view-only rescue). The flag stays OFF by the design's own sequencing law — flip it once the step-3 consumer metrics have soaked; the code path being complete is what "done" means here, activation is a one-toggle decision with a structural fallback.

## 2.317.0

### Added
- **Session-brain step 3: side-effect consumers go device-assisted (first-writer-wins).** The daemon's `session-events` stream now carries the RAW records alongside the normalized ops, and the server feeds them into ONE shared consumer implementation (`claudeSideEffects`: served model, usage odometer, rate-limit events, limit banners, fallback belts, TodoWrite/TaskUpdate) through a bounded per-record seen-gate. The parse remains primary and registers every record it processes; the device feed runs the families only for records the parse has NOT seen — it fills relay gaps and beats relay latency (wrapper reconnect windows, a dead relay) and can never double-fire. A session without a device stream behaves exactly as before. TaskCreate stays parse-only by design (its id only exists in the tool RESULT the parse stashes). The normalizer/msg-broadcast path deliberately remains server-owned until R6 — this step moves the FACTS, not the client protocol.

## 2.316.0

### Added
- **Session-brain step 2 (design §session-brain): device-side normalizer double-feed, DARK.** The daemon now runs the SAME bundled normalizer over each of its pipe sessions' stdout (line-aligned incremental tail, start-at-NOW — history replay stays the transcript service's job) and pushes typed ops to the subscribed server (`session-events`, capability-gated). The server keeps its own parse and only COMPARES: content-derived mids (R0) are matched suffix-wise (each normalizer prefixes its own session id — device uses its sid, the server the webui id), with `sb-parity-hit`/`sb-parity-miss` metrics and a throttled divergence log. **Nothing consumes the device stream yet** — step 3 (consumers switch) stays gated until live parity holds at zero misses. Parity is already proven at the harness level: scripts/test-session-brain-dark.mjs (real daemon, 4 asserts) shows byte-identical create mids across the two parses of the same stream.

## 2.315.0

### Added
- **Per-session pool links (B-a612 plan C, user-decided): concurrent conversations on different models can bill to DIFFERENT pool members.** Each local pooled session now gets its own directory symlink (`data/pool-links/<poolId>/<sessionId>` → the chosen member's dir); the pool's default link at `data/subs/<poolId>` remains the state for display and for sessions without a model identity. The credential invariants hold at both granularities (N links over M accounts still leave exactly M credential files, and every link to an account resolves to that account's one refresh lock — pinned in the test).
  - **Placement**: at spawn the chooser ranks members through the SAME estimator-overlaid cache the pool engine reads, PROJECTED to the session's model family (`src/model-family.js` — the vocabulary's first shared home): scoped caps of models the session is not running stop vetoing its placement; 5h/7d always count (nested buckets); an unknown family means no projection, never a relaxation on ignorance.
  - **Model identity** (user's spec): newest of the last assistant message's served model and the last set-model pick, else the spawn model — all three persisted in session meta so restarts keep the ladder.
  - **Per-session auto-switch**: the engine decides per session on the projected view and re-points only that session's link — an opus conversation's spent cap no longer evicts a fable conversation, and vice versa. Cold pools restart only the moved session; per-session dwell keys prevent flap.
  - **Attribution is per-session**: the ledger resolves a pooled request to the SESSION's link target, so per-account $ stays exact when two sessions bill different members. The billing badge shows this session's real target.
  - **Lifecycle**: link created at spawn, dropped at terminate, reconciled at boot (orphan links are unlinked).
  - **Sealed orders carry the per-session link paths**: the daemon matches a limit banner to the SPECIFIC link that session spawned against (longest match) and re-points only it. Old daemons ignore the new field — reduced coverage on skew, never a wrong re-point.
- Tests: scripts/test-account-pool.mjs grew to 31 (link primitives, one-real-dir invariant, independent re-points, sweep, removal safety, family projection).

## 2.314.0

### Changed
- **Machine snapshots (System panel) now share ONE implementation across local and remote** — a missed twin-set from the CS unification: the local panel read cgroups in-process while remote machines ran a separate ssh script, and the two interpretations of "used memory" had already drifted once (the false-100% incident: raw `memory.current` vs working set). The daemon now bundles `src/sysinfo.js` and serves a `sysinfo` op (capability-gated), so the same module runs where the facts live; the ssh script survives only as the fallback rung for daemon-less hosts. Bonus: a containerized remote machine now reports its cgroup limit instead of the host's MemTotal, and macOS gets the vm_stat working-set semantics through the same module. Test: scripts/test-sysinfo-op.mjs (11, real daemon).

### Fixed
- The unknown-stream-type breadcrumb cried "unhandled" for `rate_limit_event`, which has been handled since 2.289.0 — the known-types set lagged the handler and the false alarm misled an incident read.

## 2.313.0

### Fixed
- **The other silent branch of the stuck-pool incident.** 2.312.0 made a stuck pool speak, but only through the `stuck` return. When the candidate gate drops EVERY member the code returns through `no-members` instead — still completely silent, the same "the pool sits on a dead account and the user finds out by hitting a limit" failure down a different path. Every blocked outcome now reports (`stuck`, `no-members`, `no-settleable`), keyed per hour so a recurrence is reported again (`_sentNotices` is a per-boot permanent Set).
- **"Every member is out of quota" was the wrong sentence.** Under the nested bucket model it is usually one *model's* weekly cap that is spent while the 7-day budget still has 40% left — and those point at completely different user actions (wait a week / pay, versus just run a different model). Buckets carry a reporting `label` now, and the notice names exactly what is spent and what is still available: *"spent: Fable 0% (still available: 5h 100%, 7d 39%)"*.

## 2.312.0

### Fixed
- **A pooled account could lock onto a dead member and never leave.** When the current target is genuinely out of quota, the switch picked `ranked[0]` — the EDF choice, i.e. the member whose weekly window resets soonest. That is the right policy while there is still a choice about *when* to burn quota; it is the wrong one when there is no quota at all, because a member whose window just ROLLED has no known deadline and therefore sorts LAST by design. So a fully-fresh account was invisible as an escape hatch: reproduced from a reporter's own usage cache, a pool at 0% with a 100%-on-every-bucket member present returned "no switch" for hot AND cold. Liveness now beats efficiency in the hard-dead branch — prefer the EDF-first member that can actually settle, else the most MEASURED headroom (an unknown-data member's fabricated 50% must never win, or "escape the dead account" becomes "jump onto ignorance").
- **A stuck pool said nothing.** With every member out of quota there is genuinely nowhere to go, but the user only found out by hitting a limit mid-turn. `decidePoolSwitch` gained an opt-in `explain` channel (the historical `null` contract is unchanged for every existing caller) and the engine now emits an hourly notice naming the best remaining member — the state where only the user can act.
- **The System panel read 100% memory on a healthy instance.** A fleet user's panel sat pinned at "32.0 GB / 32.0 GB · 100%" with the OOM warning up, while the processes it listed added up to 2.7 GB and every command inside the container reported plenty free. The panel reported the cgroup's raw `memory.current`, which COUNTS THE PAGE CACHE: reading big files (transcripts, a dataset pass) parks tens of GB of reclaimable cache in that counter and it never falls — the kernel simply reclaims (that instance had 770 reclaim events and zero OOM kills). So the alarm was not merely early, it was permanent, which is worse than useless: a real leak could never stand out from it. Memory is now the WORKING SET (`memory.current − inactive_file`) — the definition `kubectl top` and container eviction use, verified against `kubectl top` on the affected pod (100% → 56%) — with the raw total and cache size named underneath so this panel reconciles with other tools instead of contradicting them. The remote-machine probe already excluded reclaimable cache (`MemTotal − MemAvailable`); this was its local twin having drifted, the class the CS-unification rule exists to prevent. Bare-host installs also stop counting cache. Memory history recorded before this release stays inflated — those points are raw totals.

### Tests
- Liveness, its negative control, the unknown-data guard, and the explain channel are pinned in scripts/test-pool-auto.mjs.
- **The model-scoped bucket semantics are now pinned too** — an adversarial pass found them unpinned despite being load-bearing: every model-scoped weekly is flattened into kind `weekly` and `accountRemaining` is min-across-all, so one spent cap for a model *nobody is using* declares the whole account unusable. That is today's contract; a model-aware version must deliberately update those asserts rather than discover them.

## 2.311.0

### Changed
- **SSH machines move themselves to a ws link.** Graduation has existed since 2.248.0 but was button-only, so in practice every machine stayed on ssh forever — a per-op child spawn per command, banner hangs on lossy paths, and a ControlMaster whose ESTABLISHED flow survives network changes that every NEW connection fails. Once the daemon answers over ssh, the machine is now installed as a service and dials back over WebSocket in the background. Deliberately conservative: only with an operator-declared public URL (never self-publishes this instance to the relay), the machine is still asked whether it can reach that URL before anything is installed, one attempt per machine per 6h, and any failure is reported and leaves it on ssh. Setting `agentd.autoGraduate` (default on) plus a per-machine opt-out; ssh remains the bootstrap and rescue channel forever.

## 2.310.0

### Changed
- **Remote session lists arrive as a PUSH, computed on the machine that owns the facts.** 2.309.0 broadcast a bare "your list is stale" and let each client re-fetch — which puts the trigger for a heavy scan on the orchestration side and multiplies it by the number of connected clients. Now one dirty signal costs one computation (the capability-gated `discovery-claims` op runs the whole claim algorithm on the device, next to the bytes) and one broadcast of the RESULT, whatever the client count; nothing is computed at all when no client is connected. An unreachable machine pushes an error instead, and clients keep their labelled last-known list rather than freezing on a state we know is wrong.

## 2.309.0

### Fixed
- **Remote "Recent" stayed stale after a terminate.** Opening a chat on a remote machine and terminating it left the card showing as live until a manual ⟳. The server dropped its own discovery cache and told nobody, while the client's per-host list has no TTL by design (an ssh scan is expensive) — so the staleness was invisible and permanent. `hosts.invalidateDiscovery` now notifies, and clients re-scan the host they are displaying (other hosts just drop their cached entry — no fan-out of ssh scans for zones nobody is looking at). The notification hangs off the single invalidation entry point rather than each of the ~8 call sites: the bug existed precisely because the `/api/kill-pid` path had a hand-wired refresh and the ws terminate path did not.

## 2.308.0

### Fixed
- **Paging bounce — device-independent direction lockout.** 2.307.0's intent gate needs a recent wheel event, so it does nothing for touch, scrollbar-drag or keyboard readers, or when the reader simply pauses while a batch settles. A structural mutation now stamps its DIRECTION, and for 600ms afterwards only the trigger that continues that direction may fire: a mutation-induced displacement can never be evidence for the opposite direction, whatever the input device.

### Investigated and rejected
- **Native scroll anchoring is NOT the culprit.** The obvious next hypothesis was that the browser's scroll anchoring and our own `_withViewportAnchor` were both compensating for the same event. Disabling it — globally, and then scoped to just our mutation window — made the paging regression suite FAIL (189px oscillations), because `content-visibility: auto` makes every off-screen message's height a moving target and native anchoring is what absorbs that churn. Recorded here so the next person does not spend the same afternoon: the suite is the control, and it says the browser is helping.

## 2.307.0

**The paging bounce, third capture — and this one shows the actual mechanism** (inc-msorcsrl). It was never about the top/bottom edge test. After paging UP, content-visibility resolves the freshly inserted batch and **native scroll anchoring raises scrollTop to keep the view visually stable** — the capture measured 85 → 1466 in 26 ms, which no wheel can produce. The "near the end ⇒ extendBottom" rule read that displacement as *the user scrolling down*, trimmed the top and walked the window back toward the live tail, so a user who was still scrolling up watched the page jump back. My two earlier fixes (2.301.0 scroll guard, 2.306.0 wheel guard) both hardened *edge detection*, which is why the trace kept showing the guards firing while the bounce continued.

- **Intent gate**: a boundary EXTENSION must agree with the user's actual wheel direction. The wheel listener records the direction and its timestamp; `extendBottom` is vetoed while the user's recent wheel was UPWARD, and `extendTop` while it was DOWNWARD. Content-growth displacement has no direction of its own, so it can no longer masquerade as intent. The veto expires after 1.2 s, so keyboard/programmatic scrolling still pages normally.
- `scripts/test-paging-collapse-guard.mjs` (31 asserts) adds the captured geometry: the same position extends when the user really is going down, and a stale direction never vetoes forever.

**Sealed orders: the reflex could fire on a banner from a session that does not bill the pool** (final confirmed finding of the review). `_scan` tails every live pipe session and acted on the first limit banner, so an unrelated session hitting its own limit would re-point the pool off a healthy target and move billing for every live pool conversation mid-turn. The daemon now requires the session's recorded spawn line to reference the pool's credential directory, and refuses (loudly) when it cannot tell. E2E covers both directions.


## 2.306.0

**The paging bounce, actually fixed** (inc-msor3oax — still reproducing on 2.305.0, and the new capture shows exactly why). 2.301.0 guarded the SCROLL handler against collapsed geometry, and the trace confirms that guard firing (`collapsedGeomSkip {sh:755, ch:755}`) — yet the window still got yanked to the live tail about once a second. **A collapsed list emits no scroll events at all**: with `scrollHeight === clientHeight` there is nothing to scroll, so the WHEEL handler is the only path that runs, and its bottom-edge branch was unguarded. With no scrollable range, "parked at the bottom edge" and "parked at the top edge" are the same position, so one downward tick — the momentum tail of the user's own UPWARD gesture is enough — fired `extendBottom`.

- The wheel bottom-edge branch now requires a REAL scrollable range (>50px) before it can believe it is at the end. The 2.193.0 stall fix it exists for keeps working (a genuinely parked-at-the-end list still extends).
- The scroll-handler guard moved from a fixed 200px bar to **"less than one viewport of scrollable range, within 1.5s of a structural change"**. The field data forced this: the incident's landings measured 782, 923 and 997 against a ~755px list, so two of three slipped past 200px; simply widening the bar would make a genuinely short partial window skip decisions forever and paging up would stop working. The settling window makes the skip transient by construction.
- `scripts/test-paging-collapse-guard.mjs` pins both predicates against the captured numbers (26 asserts), including that the skip cannot stick and that a real parked-at-the-end list still pages.


## 2.305.0

**The pool never switched away from an account whose OPUS quota was spent, because the Opus bucket was invisible to it** (inc-msof8i22, "没有自动切换还有opus用量的账号"). Both quota parsers read model-scoped weekly caps from a LIST, and treated the vendor's *named* fields (`seven_day_opus`, `seven_day_sonnet`, …) as a fallback used ONLY when that list came back empty. Every account here reports one list entry (Fable) — so `seven_day_opus` was never read on ANY path, and the pool's exhaustion test saw 5h/7d/Fable all healthy on a target whose Opus was gone. Verified against the live caches: ten usage-cache files, every one carrying a Fable bucket and no Opus bucket, from the ⟳, statusline and get_usage sources alike.

- Named scoped buckets are now MERGED with the list (dedupe by model name, list entry wins) in BOTH the `get_usage` control-channel parser and the on-demand ⟳ REST parser.
- Regression legs pin the merge, the exhausted-Opus survival, list-only and named-only payloads, and that a codename bucket without a reset is still skipped.

**Sealed-orders fixes from the adversarial review** (all three confirmed findings):
- The daemon stored ONE orders object, so with several pools the last push evicted the rest and a limit banner from pool A could re-point pool B while A stayed stranded. Orders are keyed by pool now (legacy file migrates on read), and with more than one pool armed the device REFUSES to guess which pool a banner belongs to rather than switching the wrong one.
- Orders are DISARMED on pool delete and on auto→off, and the boot arm is gated on `auto` like every runtime path — a manual-only pool was being armed once at boot with a snapshot that then froze forever.
- The eval-site push observes its rejection (warn once per boot) instead of leaking an unhandledRejection every tick while the local daemon is down.
- Remote events whose walker rid fell back to `msg.id` now carry `mid`, so the live odometer can retire them — without it such a request counted twice forever (the ring has no age-out).


## 2.304.0

**Root fix for the session-identity crossing: the socket name is now DERIVED from the session id instead of minted independently.** 2.302.0 made both expressions read one captured counter — that patched the day's symptom. The actual defect is older and structural: **a session had TWO identities built by two separate expressions** (`sess-<seq>-<now>` and `cw-<seq>-<now>`), while the session-meta file is keyed by one and everything else by the other. Any divergence — a re-read counter, a millisecond of drift, a future edit to one line and not the other — silently maps two sessions onto one metadata file.

`sockName = 'cw-' + id.slice('sess-'.length)` makes divergence unrepresentable: the meta filename is a pure function of the session id, so a collision would require duplicate session ids, which the counter+timestamp already excludes. The test now pins DERIVATION structurally (a `sockName` expression containing `Date.now()` fails the suite) and models a same-millisecond burst, which the two-expression shape could never survive.


## 2.303.0

**The counter race's consequence, traced end to end in production: sessions carrying ANOTHER conversation's id.** A pool cold-switch restarted ~22 chat sessions in one burst; every one was created with the correct name and the correct resume id (`"D-Triage" resume=c2c951eb`, `"Majordomo" resume=2dfb67bb`, …). Because `sockName` re-read the session counter after the awaits (fixed in 2.302.0), the burst produced colliding socket names — **only 15 session-meta files survived 22 creates, and every survivor held one session's identity merged with another session's conversation id**: the record for `D-Workforce` carried `D-Triage`'s conversation, `Sega-ToB-signing` carried `GPU-insurace`'s, and so on. The sidebar then showed those conversations' names, which is what the report looked like from outside.

This is not cosmetic: a session whose meta names another conversation would RESUME that conversation on the next restart — and those conversations are live elsewhere, i.e. the double-writer hazard.

- `writeSessionMeta` now detects an owner conflict (a meta file already owned by a different webui session) and logs it loudly with a metric — the collision can never again be silent.
- The id-capture merge refuses to INHERIT a foreign meta: spreading a colliding record grafted another session's name/cwd/account onto this one, which is what turned a socket-name collision into a full identity crossing. It also writes `webuiSessionId` explicitly so ownership is always recorded.


## 2.302.0

**Session id / socket-name counter race (found in production data on a fleet instance, 7 of 15 live sessions affected).** `id` incremented the session counter, then `sockName` RE-READ that counter about a hundred lines and several `await`s later (cwd preflight, resume host inference, keeper probe). A burst of concurrent creates — exactly what a multi-agent orchestrator produces — therefore had every session read the counter's LATEST value: four sessions with ids `sess-21/22/31/34` all took socket name `cw-36`, separated only by the `Date.now()` millisecond. **The measured gap between them was 1 ms.** Two landing in the SAME millisecond share a socket path AND a session-meta filename, so one session's metadata — name, claudeSessionId, billing account, task id — silently overwrites the other's.

- One captured `seq` now feeds the id, the socket name and the default session name; the same re-read is fixed in the server-side adopt path. `scripts/test-session-id-race.mjs` pins it structurally (zero bare re-reads allowed) and behaviourally, with a negative control that reproduces the production symptom.
- **Client state-key collisions are no longer silent**: when the key migration maps two stored keys onto one session with different values, one value was being DROPPED with no trace — that is how a session can end up wearing another session's custom name while the rightful owner loses its own. It now leaves an `state-key-collision` breadcrumb in the incident ring plus a telemetry event, so a recurrence is provable from a bundle instead of reconstructed by hand.


## 2.301.0

**Paging bounce-back fixed (inc-mso818ry — the 2.264.0 scroll tracer's first real catch).** Paging up in a busy chat window could bounce back to the live tail every ~1 second: while content-visibility left a freshly inserted batch unresolved, the list's scrollHeight collapsed to about one viewport (trace: `sh 782` on every pathological landing vs `2857+` on healthy ones), making "at top" and "at bottom" SIMULTANEOUSLY true — the pin re-engaged at scrollTop 0, extendBottom yanked the window back to the live tail, and the loop repeated for 50 straight seconds in the captured incident.

- **Collapsed-geometry guard**: with messages outside the rendered window and >10 rendered, a scrollHeight within 200px of clientHeight is INDETERMINATE — the scroll handler makes no boundary decision (no re-pin, no extend either way) and self-documents a `collapsedGeomSkip` trace entry; heights resolve within ~1s and the next event re-evaluates honestly.
- **Top-edge anchoring**: `_withViewportAnchor` captured NO anchor at scrollTop 0 (`if (st > 0)`), so every extendTop while sitting at the top landed un-anchored and clamped into the fresh batch — the previously-first message is now the anchor (it scrolls back to the top edge, where the reader's eyes were). All-collapsed children (offsetHeight 0) also anchor by position now instead of falling to the estimate-skewed delta path.

Verified against the real-browser paging suite (scrollTop-write interceptor, zero anchor-shift jumps), minimap jumps, and sidebar scroll.


## 2.300.0

**Three-tier closure, batch 4: the sealed-orders emergency reflex (design §Pool management) + session-brain step 1.**

- **Sealed orders**: after every pool evaluation (and at boot) the orchestrator pushes the pool's EDF-ranked member snapshot to the holding device (device #0 — pools are local-only). The device executes a LOCAL fallback switch ONLY under the double condition — it observes a hard limit banner in a live session's stdout AND has no orchestrator connection; outside that, policy stays single-brained (verified: with a server connected the reflex never fires). The banner detector is the SAME `parseLimitBanner` the server uses (the adapter is bundled — one implementation, no drift), the symlink re-point is the SAME `account-material` primitive `setPoolTarget` uses, and executions are logged + reported on the next orders push (pushing the report at hello RACED the client's control-routing installation — observed live, moved into the reply). This closes the one failure window pool auto-switching had left: limits hit while the server is down/restarting no longer strand every session on a dead account.
- **EDF ranking shared**: `rankPoolMembers` extracted with the comparator `decidePoolSwitch` uses — the device's fallback order IS the orchestrator's order.
- **Session-brain step 1 (`bufferOwner`)**: every session record now names its buffer's owner explicitly ('server' today); the attach path will route by this field when R6's `session.open` starts producing device-owned sessions — records stop being assumptions.
- Real-daemon e2e `scripts/test-sealed-orders.mjs` (7): single-brain hold, double-condition execution, ranked-fallback re-point, reconnect report + ack-clears-log.


## 2.299.0

**Three-tier closure, batch 3 — R4 COMPLETE: the `usage-events` push stream. The remote ledger goes from pull-with-a-60s-floor to seconds-fresh, with local and remote running the same machinery.**

The owner's question that started this ("why can't monitoring live on the device and stream back in real time?") is now the shipped architecture: the daemon watches its transcript dirs (`~/.claude/projects` + codex sessions), runs the bundled walker incrementally on change, and PUSHES new ledger events to the subscribed server in chan-0 batches. The two-phase cursor discipline survives with the roles inverted — the daemon holds proposed cursors in memory and persists them ONLY when the server acks the batch seq after durable ingest; an unacked batch re-walks and re-emits, and rid dedup absorbs the replay. This covers exactly what the live stdout relay never could: EXTERNAL sessions on the machine and workflow/subagent transcripts (file-only usage). The dirty-kick harvest (60s floor) stays armed as the fallback rung for old daemons and lapsed streams — retirement-order law.

- Daemon: `usage-events-watch`/`usage-events-ack` ops (capability `usage-events`); ≤500-event chunks, final chunk carries the ack seq; walk failures LOG (a degrade path that swallows its own bug hid a routing miss for two debug cycles — 2.284.2 lesson re-learned live).
- Client: `watchUsageEvents(onBatch)` + `ackUsageEvents(seq)`, re-armed on reconnect like the discovery watch; an error-ack THROWS instead of resolving silently.
- Server: batches ingest through the SAME pipeline the pull harvest uses (attribution, rid namespacing, host-bucket honesty), then the estimator invalidates and the pool re-evaluates — remote spend now reaches pool decisions in seconds.
- E2E `scripts/test-usage-events-push.mjs` (7 asserts, real daemon): initial drain, incremental-after-ack, and the loss-window proof — an unacked batch delivers but does NOT advance the cursor.


## 2.298.0

**Three-tier closure, batch 2: the account-management §-obligations (design §Account split / §Quota refresh origin), all previously unimplemented.**

- **`place-secret` device op** — THE sanctioned secret channel: a credential lands as a 0600 file with the mode set AT OPEN, atomically (tmp+rename), confined to $HOME. The old dial path was `fsWrite` **then** `chmod 600` — a mode-race window with the key world-readable on a multi-user device. Both the API-key file and the per-session agent token now ride it; old daemons keep the legacy pair as fallback.
- **`quota-refresh` device op** — the human-gated on-demand quota fetch now executes **on the machine that holds the login** (decision 2026-08-10): the token is used from the same IP its CLI sessions use, and the server never sees it — the token-appears-from-a-foreign-IP signal the server-side fetch carried is gone. Gates: `humanGated` must be explicitly true (no scheduler can reach it), daemon-side 60s throttle **stamped only when a vendor call is actually about to happen** (a failed precondition must not burn the slot — the 2.271.0 lesson), read-only token peek that never refreshes. Both host-refresh branches prefer the op and fall back to the legacy token-peek for old daemons. `scripts/test-vendor-whitelist.mjs` now pins agentd's vendor surface to exactly this one op with its gate markers (23 asserts).
- **`src/account-material.js`** — the data/subs formalization: credential-MATERIAL mechanics (the pool symlink re-point) extracted into one device-tier module the server consumes in-process as device #0; the daemon-side sealed-orders reflex will execute the same implementation.
- Real-daemon test `scripts/test-device-secret-quota.mjs` (12 asserts): 0600-at-creation, $HOME confinement + traversal refusal, humanGated refusal, missing/expired-creds honesty — every gate that PREVENTS a vendor call is exercised live; the call itself never is (§ban-safety: no test may contact Anthropic).


## 2.297.0

**Three-tier closure, batch 1 of the owner's "finish ALL of it" directive: the two highest-risk design obligations that had never been scheduled, plus two of the registered equivalence exceptions.**

- **Vendor-call whitelist guard test** (`scripts/test-vendor-whitelist.mjs`, 19 asserts) — the design's §ban-safety law is now enforced STRUCTURALLY, not by discipline: exactly two files may construct an Anthropic request (with pinned construction counts and their opt-in/throttle/backoff gate markers asserted), the device daemon and its built bundles must carry ZERO vendor endpoints, and the shipped usage tools must import no network primitive. A new vendor call anywhere fails the suite until deliberately allowlisted with its gates. The full-repo inventory behind it found `refreshRateLimit` exported with zero callers.
- **Device-offline bias defenses** (design §Cross-device aggregation, previously zero-implemented — the dangerous-direction bias: with per-account remote attribution landing, the learned rate → 1×, so an ACTIVE machine going dark means missing cost and an UNDERestimate = late pool switches):
  - per-source watermarks (newest ledger event per machine, free on the incremental shard walk) + `hosts.linkState()` (never probes) → **active-dark detection**: recent events + link down;
  - pool decisions dock a dark-tainted account's effective remaining by 8 points on BOTH sides — the current target trips exhaustion earlier AND switching ONTO invisible burn fails the settle bar (test: control moves, docked stays);
  - anchors record `dark:[hosts]` and rate learning VOIDS pairs touching a dark interval (Δu real, cost missing ⇒ falsely hot rate — now excluded, not averaged in).
  - The audit also caught **two live bugs**: resolved remote spend was excluded from the per-account odometer entirely (`if (ev.host) continue` predates 2.294.0 attribution — an account's spend on another machine simply never counted), and a HOST-LOGIN remote session's live stream credited the LOCAL machine login's odometer, so the estimate rose during a remote burn then visibly dropped back when the harvest landed. Both fixed.
- **The local ledger walk IS the shared walker now** (`usage-history.scan()` consumes `src/usage-walker.js` in-process with its cursor store injected; enrichment stays orchestrator-side) — the three-copies-of-one-walk exception shrinks to two, and the remaining shipped scanner is the documented checkout-less fallback, still parity-pinned.
- **Conversation-location index** (R3 tail): `data/conversation-index.json` records which machine owns each conversation from BOTH discovery listings and transcript fetches — the resume host-inference can now locate a conversation the raw cache has never seen (previously only ever-fetched transcripts could infer their host); two live claims stay honestly ambiguous, a week-fresher claim is decisive, claims from removed hosts are ignored.


## 2.296.0

**Incident reports gain the two things the layout-collapse investigation lacked: a trail of what MOVED windows, and a way to put them back** (owner request after the pool-collapse incident: "record more information so future bugs like this are solvable").

That investigation exposed two separate gaps. Diagnosis: the action ring had clicks and the ws ring had message types, but NOTHING recorded the desktop reassignments — the sequence had to be reconstructed by reading code. Recovery, worse: sessions survive, but WHERE they lived does not, and because the damage EMPTIED two desktops even the pre-damage mapping was gone; the only path was hand-editing layouts.json, and the emptied desktops' windows could not be placed at all.

- **Semantic breadcrumbs**: `window.__vsOp(name, data)` feeds a 4th incident ring (cap 300), wired at the three ops that RELOCATE or REPLACE a window/session (desktop-move, pool-cold-restart, resume-place). Names and ids only — the privacy rules are unchanged.
- **Layout rollback points**: `writeLayouts` — the one choke point every layout write passes through — preserves the previous state in `data/layout-history/` whenever the desktop→window SHAPE changes (geometry drags ignored, or one drag would evict the whole ring). ⚙ → **Restore a previous layout…** turns what was JSON surgery into one click, and restoring is itself undoable.
- Incident bundles now carry the window→desktop→session table and the rollback-point index.

An adversarial review pass (4 dimensions, every finding independently verified) caught **two critical defects in this very feature** before it shipped, both of which would have made it silently useless:
1. **Persisted windows carry `winId`, not `id`** (confirmed against a real production layouts.json). The shape signature read `id`, so it was permanently empty and NO rollback point would ever have been written — while the tests passed on a fixture that used `id`.
2. **`readLayouts()` returns the live cache and every production caller mutates it in place**, so the snapshot captured the ALREADY-DAMAGED state: restoring would have re-applied the collapse. Fixed with a detached copy (plus a disk read for the cold-cache case); the test now mirrors the real read-modify-write pattern, and a negative control confirms it catches the bug.

Also from that review: restore now forces a rollback point (an equal-shape restore silently overwrote presets/grids), broadcasts `layout-restored` so another open tab can't write the damaged layout back seconds later, does its IO off the layout-sync hot path, writes atomically with a sidecar header (listing no longer parses 40 whole layouts), keeps the OLDEST entries as well as the newest (a resume storm must not evict the pre-storm state), disambiguates duplicate desktop names, and surfaces a permanently unwritable history dir instead of failing silently. The confirm dialog was being called with a string where an options object was required, so the destructive-restore warning rendered blank.


## 2.295.0

**Pool cold-switch no longer collapses your whole layout onto one desktop** (a fleet user, inc-mso43urh — a pool target switch pulled every session out of every desktop and piled them onto the active one).

A cold pool switch (and cold auto-switch) kill+resumes each affected conversation to re-bill it on the new account. The resume carried the window's geometry but NOT its home desktop — `_snapshotWinBounds` dropped `_desktopId`, so every resumed window landed on whatever desktop was active. A single billing switch was fine (you're looking at that session's desktop), but the pool restart fires against sessions on EVERY desktop at once while one is active, so all of them flattened onto it.

`_snapshotWinBounds` now captures the source window's `desktopId`, and the resume moves the new window back to it — guarded on the desktop still existing (a since-deleted one leaves the window active rather than stranding it) and never onto the Stage. A single switch on the visible desktop is unchanged (home == active, no move). Test: scripts/test-resume-desktop.mjs (13 asserts incl. a simulated multi-desktop pile that must spread back, not collapse).


## 2.294.0

**Remote messages now show the ACCOUNT they billed to, not just the machine** (owner report from a live agentic-search conversation: the message-meta popup could only say "AIDev's machine login").

The data was there all along. VibeSpace records which account it spawned a remote session with — `writeSessionMeta` writes it into `attribution.ndjson` exactly like a local one — but `ingestRemoteEvents` hardcoded every remote event to the host bucket (`acct: hostId, atype: 'host'`), throwing that away. Remote events now resolve their account with the same by-time walk local events use (pool tag included), so a remote reply's billing row names the real account, and per-account cost stops under-counting everything that ran on another machine. This is R4's "remote per-account ledger attribution" deliverable.

The fallback stays honest and is the point of the design: a session VibeSpace never spawned (an external terminal on that machine, or one predating attribution) has no entry and keeps the host bucket — `atype: 'host'` now means what it always claimed, "billed by that machine's own login", instead of "remote, we didn't look". Requests older than the attribution entry are not back-billed (the 2.84.0 grace-window rule). The machine dimension is untouched, so the Usage window's device filter keeps working — and the popup now names both: `account · on <machine>`.

Also corrects the popup's stale "harvested every ~15 min" line (2.287.0 made it event-driven, ~1 min). Test: scripts/test-remote-attribution.mjs (8 asserts, incl. the never-invent-an-account and no-back-billing guards).


## 2.293.0

**The huge-file seek family switches to the device too — atomically** (closes the last carve-out from 2.292.0; R3 is now complete).

2.292.0 deliberately left the seek family (gap info / slabs / full turn map / full-file search) on the local transcript cache, because it speaks in FILE LINE NUMBERS and had no device search op: serving line numbers from the device while search read a cache copy would put offsets on two sources of truth and teleport readers to the wrong place. The daemon now has a `searchFull` op, so the family switches as ONE unit.

Mechanism: `gapInfo` returns an opaque HANDLE instead of a bare path — `device:<host>` when the device serves, else the local file path — and every follow-up (slab, search, turn map) honours it. The route already treated `fp` as opaque (it only checks truthiness and passes it back), so nothing above the service changed and there is no half-switched state. Streaming search over the device degrades honestly to one batch (matches still arrive as NDJSON, just together, and the wire carries matches instead of the whole transcript). Without the capability the whole family stays local — one source of truth either way.

Tests: `test-transcript-switchover` 13 asserts (handle propagation through every follow-up, streaming contract, no-capability path), `test-transcript-parity` 20 (searchFull now byte-identical against a real daemon).


## 2.292.0

**Switchover: remote transcript reads and remote discovery are now served BY THE MACHINE THAT OWNS THE DATA** (owner directive; R3 + R5 of docs/design-three-tier.md go live behind per-op fallback ladders).

- **Remote reads (R3)**: attach history, pagination, turn map, indexed search, chat status and task state for a remote session now run as `transcript-op` on that machine's daemon — the wire carries parsed KBs instead of a multi-MB raw transcript pull. Dark since 2.285.0 with a byte-identical parity suite; capability-gated.
- **Remote discovery (R5)**: `discovery-claims` returns finished session cards computed on the device; the orchestrator only merges across machines. Dark since 2.291.0 with byte-identical parity; capability-gated.

Both switches are **ladders, not replacements** (the design's per-op rule): device op → the previous implementation (transcript cache pull / server-side snapshot interpretation) → the legacy ssh script → stale cache. An un-upgraded daemon is never even asked (capability gate — unknown ops would hang), a link failure degrades with a visible throttled warning rather than silently, and every rung stays exercised by the suites. `scripts/test-transcript-switchover.mjs` (7 asserts) pins the whole ladder.

TWO invariants the switch deliberately preserves:
- **A LIVE session never reads from the device.** The server owns its stdout buffer overlay (the 2.74.0 position-preserving merge) and the live normalizer; asking the device there would drop the not-yet-flushed tail. Only rebuild-from-file reads switch.
- **The huge-file seek family stays on one source of truth.** It speaks in FILE LINE NUMBERS and its streaming full-file search has no device op yet — serving gap info from the device while search reads a local cache copy would put line offsets on two sources and teleport readers to the wrong place. It switches as a whole (with a search op) or not at all.


## 2.291.0

**R5 step 3 (three-tier): `discovery.v2` — the device computes its own session claims** (dark, byte-identical parity proven).

With the claim algorithm extracted in 2.290.0, the second half — snapshot → fact lines — moves into the shared module too (`synthesizeDiscoveryLines`), so the WHOLE chain (snapshot → synthesize → interpret) now runs on the device as one op: `discovery-claims`. The daemon returns finished session cards; the orchestrator's remaining job in the target state is cross-machine merging, not interpretation. Capability-gated via the hello `capabilities` array (unknown ops on old daemons hang the request, never version strings).

DARK by the retirement-order law: no production consumer — `hosts.discoverSessions` keeps synthesizing server-side (now through the same shared function) until this soaks. The parity suite is the only caller and proves the switchover is a transport swap: device-computed claims are **byte-identical** to the server-side interpretation of the same snapshot, cards and all (`test-usage-scan-op`, 24 asserts).


## 2.290.0

**R5 step 2 (three-tier): the discovery claim algorithm becomes one shared function** (docs/design-three-tier.md `discovery.v2`).

`hosts.discoverSessions` interpreted the raw fact lines (LOCK/J/H/N/T/C/HC/K) into resumable session cards inline — ~120 lines of the lock-first claim algorithm (exact-id → tail-id → mtime fallback), keeper adoption, codex rollout cards, and the brand-new-lock case. That logic is extracted verbatim into `discovery-facts.interpretDiscoveryLines(out, { hostId, hostName, claimJsonls })` (the tiny shared module the device daemon already bundles), with `claimJsonls` injected so the module stays dependency-light. Pure refactor — hosts.js calls it and keeps only the cache write; behavior is unchanged.

Why it matters: the interpretation is now runnable WHERE the facts live (the future dark `discovery.v2` op — the device computes its own claims, the orchestrator only merges across machines), with byte-identical logic instead of a fourth reimplementation. New golden-fixture test `scripts/test-discovery-interpret.mjs` (9 asserts) pins the claim algorithm's tricky cases — resumed-session tail-id claim, N-parallel-in-one-cwd (the mis-attribution incident), lock-with-no-transcript, stopped card + shared naming, codex rollout, keeper adoption.


## 2.289.0

**Passive quota capture from the CLI's own `rate_limit_event` records** (B-e5c9 — answers the owner's "can we get usage from `claude -p`?" with something better and safe).

Binary forensics on the 2.1.226 CLI (zero API calls) turned up a first-class stream-json stdout record VibeSpace had always dropped as unknown: `{type:"rate_limit_event", rate_limit_info:{…}}`, documented in the CLI as "emitted when rate limit info changes" — it rides real API responses, so capturing it costs NOTHING extra (§ban-safety: purely passive, unlike the banned auto-`get_usage` or a billable `-p` probe, which must carry a prompt and returns no 5h/7d data anyway).

This closes the long-standing gap where chat/stream-json sessions — which have no statusline — could only show last-known quota. Now:
- **`status:"rejected"`** is a STRUCTURED exhaustion signal (the banner-text parse's typed sibling) → marks the bucket dead + immediate pool re-evaluation.
- **`utilization`** readings write straight into the usage cache and become dead-reckoning **anchors** at the next sweep — so the estimator self-calibrates from live chat activity, exactly like the statusline does for terminal sessions.

`src/rate-limit-capture.js` is ONE shared implementation for local AND remote sessions (remote chat stdout relays through the same server parse; the caller resolves the cache key — a host-login remote session lands on its host bucket, not `__global__`, which also fixes remote limit-banner attribution). It carries the identity-group cache discipline (2.267.0 anti-poison) with one addition: `fetchedAt` bumps ONLY for a real reading (utilization or rejected), so a resetsAt/overage-only event updates bucket fields in place without falsely promoting a stale file to "freshest" for the anchor sweep. All 16 `rate_limit_info` fields decoded; both key casings accepted defensively (2.227.6); unknown bucket types surface rather than drop silently. Test: scripts/test-rate-limit-capture.mjs (20 asserts).


## 2.288.0

**R5 step 1 (three-tier): the discovery snapshot moves off the daemon loop** (docs/design-three-tier.md `discovery.v2`).

The device daemon's `discovery-snapshot` — a readdir over up to 500 project dirs, stat on every transcript, 60 head+tail enrichment reads, plus a codex tree walk — ran INLINE on the daemon loop, i.e. sync filesystem work on the thread holding every session pipe (the exact class the R2 worker rule exists for; on a loaded machine with a slow home filesystem each discovery poll stalled the pipes). It now runs in a CHILD process (single-artifact rule: the daemon re-execs its own bundle with `--discovery-snapshot-child`); child failure falls back to the same function inline, so behavior is identical either way and the wire shape is unchanged — old servers notice nothing.

Also lands the design's **forced-fallback smoke** requirement: fallback lanes rot unless exercised, so `test-usage-scan-op` (19 asserts now) pins the snapshot's inline fallback byte-identical to the child path, and drives the usage harvest's script-SHIP lane (fsWrite + runStream, the degradation path for op-less daemons) end to end against a real daemon.


## 2.287.0

**R4 step 2 (three-tier): push-triggered remote ledger + codex coverage for every walker** (docs/design-three-tier.md `usage.scan`).

- **Push-triggered harvest**: a connected device daemon fs.watches its transcript dirs (`.claude/sessions`+`projects`, and now `.codex/sessions`) and pushes one debounced `discovery-dirty` per change burst; the server rides it with a per-host trailing-debounced harvest kick (60s/host floor unchanged). Any remote activity — mid-turn tool storms, codex turns, external terminals on that machine — now reaches the ledger and the message billing popup within ~a minute, not just at webui turn ends. The same signal also invalidates the host's discovery cache (it previously had NO consumer — the daemon has pushed it since M4, unheard). The client re-arms the watch on reconnect (a restarted daemon starts unwatched — same class as reverse-forward re-own).
- **Codex rollouts in all THREE walkers** (local UsageHistory walk had it; the shipped scanner and the daemon module were claude-only): synthetic rid = cumulative token total (monotonic per thread → replays dedup), model/cwd carried from the preceding `turn_context` and persisted in the cursor, `input − cached` split, rate-limit heartbeats skipped, CODEX_HOME honored. `ingestRemoteEvents` now honors the event's `be` so remote codex usage stops vanishing from the ledger — the "remote codex coverage gap" from the R4 table is closed.
- Parity net extended: `test-usage-walk-parity` (21 asserts) adds the codex three-walker leg with byte-identical scanner↔module events; `test-usage-scan-op` (13) drives the codex event through a real daemon plus the dirty-push e2e (claude AND codex appends each push a dirty; the post-dirty harvest returns exactly the appended deltas).


## 2.286.1

**Index-mode minimap jumps land wrong on tool-heavy sessions** (incident-diagnosed from an owner report — the auto-shipped scroll tracer told the whole story: `jumpToIndex` landed, then the 180ms-debounced run-collapse pass folded the freshly rendered window and content-visibility height resolution yanked the view to scrollTop 0, firing a spurious `extendBottom` on the collapsed heights — the reader ends up ~20 messages BEFORE the one they clicked).

Root cause: the teleport (huge-file) path received the full content-visibility landing machinery in 2.111.x, but INDEX mode (files below the seek threshold — including most remote sessions) kept a single-rAF `scrollIntoView`. Heights keep resolving for ~1s after a window rebuild, so one shot always drifts. Fix: `jumpToIndex` now folds runs SYNCHRONOUSLY before measuring (the fold can no longer move the target post-landing) and lands via the same `_scrollElStable` the teleport path uses (12-frame convergence + timed re-centers through 750ms + the programmatic-scroll guard). This also fixes index-mode search jump landings (same primitive).

New CDP smoke `scripts/test-minimap-jump.mjs`: a real view-only ChatView over a tool-heavy index-mode transcript, three consecutive jumps, asserting the clicked message is on-screen ~centered after ALL settle timers — with the three targets proven distinct.


## 2.286.0

**R4 step 1 (three-tier): the usage-ledger walker moves into the device daemon — with a structurally loss-free cursor** (docs/design-three-tier.md `usage.scan`).

- `src/usage-walker.js` is the walk as a shared module, bundled into the daemon; the `usage-scan` op runs it in a CHILD process (heavy IO never rides the loop holding session pipes) and streams NDJSON events over the count-gated channel. No more per-harvest script ship for daemon hosts — the walker's version rides daemon self-upgrade.
- **Two-phase cursor commit**: the walker never persists its own cursor. The server writes it back over the device link only after the full transfer landed. The shipped script's flush-then-persist model had a real loss window on relayed (dial) paths — child flushed into the local pipe, cursor advanced, link died, those events were gone forever. Now a mid-transfer death leaves the cursor put; the next harvest re-emits and rid-dedup absorbs.
- Capability gating done right: the hello-ack's (previously empty) `capabilities` field now lists per-op capabilities (`probe`, `transcript-op`, `usage-scan`); consumers gate on it and throw fast for old daemons — unknown ops get no reply and would hang the request until its timeout. Version-string parsing rejected.
- `hosts.harvestUsage` prefers the op, falls back to the script-ship path (old daemons), then ssh (daemon-less hosts) — the existing ladder, one rung richer.
- The shipped single-file scanner stays (a checkout-less ssh host cannot require a module) and the parity net now covers all THREE walkers: `test-usage-walk-parity` (15 asserts) runs local walk + shipped script + module over one fixture demanding identical events/mid fields/cursor behavior; `test-usage-scan-op.mjs` (9 asserts) drives the op against a real daemon — byte-identical events vs the scanner, deferred-cursor proof, commit round trip, incrementality, and the fast capability-gate failure.


## 2.285.0

**R3 step 2 (three-tier): transcript ops served by the device daemon — dark, with byte-identical parity proven** (docs/design-three-tier.md).

The daemon now hosts the SAME transcript service the server extracted in 2.283.0 (`src/transcript-service.js` bundles into `vibespace-agentd.js` along with the full parse stack): a `transcript-op` op runs page / turnmap / searchIndexed / status / taskState / gapInfo / gapSlab / fullTurnmap next to the bytes and streams the parsed JSON result over a count-gated byte channel (the read-range contract — never resolve on the done marker, 2.187.0). Client side: `DeviceManager.transcriptOp(method, ref, params)`. The ops are DARK — no production consumer; remote reads keep flowing through the server-hosted service until the parity substrate has soaked (retirement-order law).

`scripts/test-transcript-parity.mjs` (19 asserts) proves the switchover will be a transport swap, not a behavior change: the same fixtures queried in-process and through a REAL daemon return byte-identical JSON — including a >½MB multi-window payload (count-gating actually exercised), a ~36MB transcript's real seek family (line-index gap, mid-file slab, streaming turn scan), the codex parser, multibyte content across chunk boundaries, and honest shapes for unknown methods / missing transcripts. This is what R0's content-derived message ids bought: two independent parser processes now mint identical ids for identical records.

The suite caught a real defect on its first run: the normalizer's hand-rolled tool-message path stamped `ts: Date.now()` instead of the record's own timestamp — every rebuild-rendered tool card (restart, view-only, resume) carried the REBUILD time, so the message-meta popup showed the wrong time for all historical tool calls. Fixed to the `_currentTs` ladder; live records without timestamps keep arrival-time behavior.


## 2.284.4

**Forking a LIVE conversation killed the parent session mid-turn** (real incident on the dev machine, minutes after 2.284.2 rolled out): the pre-resume writer sweep — which SIGTERMs any claude still writing the target conversation's transcript before a resume — ran for FORK creates too. A fork resumes the PARENT's conversation id to branch it, so the sweep found the live parent's claude as a "writer" and terminated it; the parent window died mid-turn while the fork came up fine.

Why now: the sweep's three call sites (local / ssh / dial) never excluded `fork`, but the LOCAL sweep had been silently dead since 2.276.0 (the `shq` scope bug) — 2.284.2 fixed that, making the local sweep actually run for the first time, and this latent hole went live with it. The remote sites carried the same hole for longer (forking a live remote session would have killed it the same way).

The fix is categorical: a fork only READS the parent transcript and writes a NEW conversation id's JSONL — there is never a second writer on any file — so all three sweep gates now skip on `fork`. The resume-already-live guard (2.179.0) already exempted forks for exactly this reason; the sweeps were written under the assumption that guard had filtered live sessions out, which is false precisely for forks. A drift guard in scripts/test-writer-sweep.mjs fails any future sweep call site not gated on `!data.fork`.

## 2.284.3

**Remote ledger harvest goes event-driven** (owner question: "为什么是15分钟？统计不应该实时吗？").

Clarified semantics first: the POOL's control loop never waited 15 minutes — remote CHAT sessions relay their stdout through the server's parse, so every usage record feeds the live estimator (`noteLive` + pool re-evaluation) within seconds, same as local. The 15-minute cadence only governed the PERMANENT ledger (Usage window, per-request $ history, the billing popup's join) for remote machines. Now a remote session's turn END triggers a prompt harvest (60s/host floor; the idle 15-min background cadence remains) — the ledger and the message billing popup lag ~a minute instead of up to 15. Fully real-time per-account remote accounting stays an R4 deliverable (device-side usage events with account attribution).

Also updates the message-popup hint implicitly: remote replies should now resolve in the ledger shortly after their turn completes.

## 2.284.2

**"Everything is stuck on thinking" decoded: the API was erroring and the CLI was silently retrying** (real fleet incident, diagnosed from the incident bundle + session buffers: bursts of `api_retry` records — HTTP 500 server_error plus connection-level failures — with the CLI backing off up to 10 attempts, minutes of apparent freeze; sessions recovered between bursts).

- The `api_retry` system record was an UNHANDLED subtype — dropped silently, so the spinner gave zero indication (the 2.227.5 invisible-record class, caught again). The spinner text now says what's happening: **"API retrying (3/10, HTTP 500)…"**. Deliberately card-less — one transcript card per retry attempt would be spam; the label carries it.
- **Local pre-resume writer sweep actually runs now**: it referenced `shq` out of scope, the ReferenceError was swallowed by its own degrade-gracefully catch, and the sweep silently never ran (spotted in the same incident's console ring: "sweep skipped: shq is not defined"). The degrade path did its job — nothing broke — but the protection was a no-op since 2.276.0.

## 2.284.1

**Per-message billing attributes EVERY reply now — message.id is the join field** (owner follow-up: "为什么没有请求ID就不能跟踪账单了？message id不够吗？").

The facts, corrected: **no billing data was ever lost.** The ledger mines transcripts, where every request has its id and cost. What failed was only the popup's JOIN: live stdout records carry NO `requestId` (CLI behavior — only the transcript copy has it), so replies rendered live couldn't look themselves up, while history-rebuilt ones could (that's why the FIRST message in a freshly-attached conversation attributed and the following live ones didn't). `message.id` is exactly the join field both transports share — the same 2.267.3 rule that fixed the est-2× double count:

- `eventForMid(mid)` joins by the ledger's baked `mid`, by `rid` where the walker fell back to msg.id, and by host-namespaced rids; `/api/usage-stats/rid-info` accepts `mid`; the popup queries with BOTH ids.
- The remote scanner now emits `mid` (field parity with the local walker — the parity suite asserts it on every event, so this can't silently drift), and the remote ingest preserves it.
- Model dropdown baseline labels drop their context-size claims (a `claude-opus-5` session was observed serving 222k/1M under an "(200k)" label — the status bar derives the real window from usage; labels must not assert specs they don't know).

Unit-verified all three join paths (mid field / rid-fallback / host-namespaced) against a real ingest.

## 2.284.0

Field-test feedback batch (ten findings from the owner's first R0–R3 verification pass):

- **Message-metadata billing row is honest in all three cases** (was: remote replies stuck on "not in the ledger yet" forever; records without a request id showed NOTHING). ① Remote sessions: the ledger's host harvest namespaces request ids (`h:<host>:…`) — the lookup now suffix-matches them and says "{host}'s machine login (remote ledger)"; ② not-yet-harvested remote replies say so ("harvested every ~15 min") together with the session's billing identity; ③ records with no request id fall back to the session-level billing identity instead of omitting the row.
- **Opus 5 in the model dropdown**: the passive statusline discovery only ever learns models that served a LOCAL TERMINAL here (the cache held Opus 4.8 but never Opus 5). A known-GA baseline (Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5 full ids) now always rides the list, and every session's SERVED model (chat + remote too) feeds the discovery cache.
- **Account switcher wording**: "logged in on X" vs "uses X's own login" was indistinguishable — now "own login held on {host}" (its own credential dir lives there) vs "is {host}'s machine login (same account)".
- **Customize UI**: the workspace overlay actually dims now (the old `var(--bg)` 55% mix was invisible on dark themes — theme-agnostic black wash); the Taskbar position/visibility pill is BODY-FIXED and measured off the live bar rect, so docking the taskbar to the top no longer hides the pill under the toolbar rows; right-clicking the extra rows (top or bottom) opens the proper bar menu instead of the browser's native one.
- **Extra-row sizing**: `#taskbar-row2` joins the pinned-defaults block — the same element no longer renders at different sizes in the top vs bottom extra row (the bottom row was following the taskbar's drag-resize).
- **UI scale ranges widened**: DPI 60–200% (was 80–130), font 75–175% (was 85–140).

## 2.283.0

**R3 step 1 of the three-tier plan: the transcript read composite becomes ONE service** (`src/transcript-service.js` — pure refactor, zero behavior change; docs/design-three-tier.md).

Reading a conversation was a composite copy-pasted per endpoint: refresh the remote cache (`?host=`) → warm the parse worker → prefer the live session's normalizer (only once `_historyLoaded`) else rebuild from the merged JSONL+buffer → answer page/turnmap/search/status/taskState — three copies of the normalizer dance and two of the host-refresh throttle lived in routes/sessions.js alone. Now `/api/session-messages`, the whole `/api/session-history-gap` seek family (info/slab/full-search/full-turnmap, incl. the NDJSON streaming search), and `/api/session-todos` all flow through `createTranscriptService` — whose method shapes ARE the future `transcript.*` device op schema: when the daemon hosts the same service next to the bytes, the orchestrator keeps calling these exact shapes, locally in-process (device #0) and remotely over the mux.

Verified over the real thing: the chat-paging forensics suite (scroll compensation, teleport, gap slabs) and the attach-rescue suite (view-only, dead-transcript degradation) both green through the rerouted endpoints, plus transcript-worker and the boot smokes.

## 2.282.0

**R2 of the three-tier plan: daemon worker isolation** (docs/design-three-tier.md — THE unlock for every later heavy migration).

The device daemon's fs ops ran SYNC on its main loop — the loop that keeps every session pipe on the machine alive. A hung filesystem path (the dead-FUSE-mount class that motivated SafeFs server-side) could wedge the whole daemon. Now:

- **Embedded worker tier**: heavy fs work runs in `worker_threads` spawned from the SAME single-file bundle (`new Worker(__filename)` + role flag — a second shipped artifact through the installer/versioned-dir/re-exec chain would be a fleet-brick vector, the 2.185.2 class). `FS_ACTIONS` is ONE implementation object: the worker servant runs it, and the inline fallback (worker_threads unavailable) runs the SAME object — no twin to drift.
- **Deadline → terminate → respawn**: a wedged op surfaces as a bounded `fs deadline` error (measured 8 s on a real FIFO wedge) instead of a 30 s transport timeout; the pool kills the stuck worker and respawns it. `read-range` reads in 4 MB worker chunks so a mid-file hang trips the per-chunk deadline; the count-gated byte-channel contract (2.187.0) is unchanged.
- **Loop-lag canary**: the daemon logs if its own loop ever stalls >300 ms — a regression that puts weight back on the loop becomes visible instead of waiting for a field freeze.
- **Found & fixed while building it**: the pool's job id leaked into the mux reply via object spread, overwriting the request id — the reply then answered a request nobody made and the op hung forever. The two id spaces HAPPENED to align until unrelated ops skewed them (which is why simple repros passed and the full suite hung). Pinned in the new test.

scripts/test-agentd-workers.mjs (7 asserts, real daemon): correct fs ops after id-space skew, run-cmd + probe ops answered WHILE an op is wedged on a FIFO, other fs ops served mid-hang by the second worker, bounded deadline, pool self-heal. Full agentd battery green (M0/M1/adopt/bigread/m3m4/local-device/probes).

## 2.281.0

**R1 of the three-tier plan: machine facts come from the machine** (`probe.*` op family; docs/design-three-tier.md).

"Which CLIs does this machine have, how is it logged in, what credential directories does it hold" existed as THREE divergent implementations — the local backend-status route (node), plus two ssh shell scripts with their own grep ladders (the apiKeyHelper blind spot and the same-dialog status contradictions were both probe-twin bugs). Now `src/machine-probes.js` is the ONE implementation:

- Bundled into the device daemon as `probe-cli` / `probe-creds` ops — a remote machine answers about ITSELF (read-only over files; per the §ban-safety whitelist nothing here can originate a vendor call).
- The local route calls the same module in-process (device #0, CS amendment #2 — shared implementation, no socket transit).
- `hosts.backendStatus` / `hosts.accountsStatus` consume op-first with the ssh scripts demoted to fallback (daemon-less hosts and pre-R1 daemons — whose unknown-op silence times the bounded 9s request out — keep working unchanged).

scripts/test-machine-probes.mjs (13 asserts): a fixture home with an expired machine login + console key + apiKeyHelper + a held sub dir + a codex JWT is read IDENTICALLY by the in-process call and by a REAL daemon over the ops — one implementation, two transports, byte-equal facts. Regression: account-verdicts (45), integration-toggle, Manage-Agents CDP suite all green.

## 2.280.0

**R0 of the three-tier plan (docs/design-three-tier.md): content-derived message ids.**

Message ids were `${sessionId}:${counter}` — a per-parser-instance counter, so every rebuild renumbered everything (the reason server restarts force a full chat-view reset, and a blocker for ever parsing transcripts device-side, where self-upgrade restarts are routine). Ids now derive from CONTENT:

- **Tool messages key on their globally-unique toolCallId** (`S:t:toolu_…`) — the same tool_use replayed from any transport (stdout buffer, JSONL rebuild, a future device-parsed history) lands on the SAME id, so replay overlap collapses to one card instead of duplicating.
- Other messages key on `message.id` (stable across the stdout and JSONL copies of one API message) > record uuid (stdout placeholder uuids excluded) > a record-content hash, with a per-key counter for records that mint several messages (block order is the API's content order on both transports, so the suffix is transport-stable).
- Codex ids hash the record's merge-fingerprint shape (volatile `item_id`/`id` stripped — exactly the fields that differ between the wrapper buffer copy and the rollout copy of one item), so cross-transport twins derive identical ids.
- `_normEpoch` full-view reset stays as the belt; it just stops being load-bearing for ordinary rebuilds.

scripts/test-message-ids.mjs (13 asserts) pins the contract: rebuild stability, the stdout↔JSONL id JOIN (the property that lets a device-parsed history merge a server-parsed live stream with no flag day), replay-overlap collapse, keyless-record determinism, streaming re-emit editing in place. Real-browser belts green (attach-rescue, chat-paging) plus the normalizer/regression battery.

Also: eleven test scripts hardcoded the absolute repo path (surfaced by the 2.279.2 hygiene sweep breaking them) — all derive from `import.meta.url` now.

## 2.279.2

**Repository hygiene sweep** (owner directive: no personal information or communication content in the public repo).

- All personal identifiers scrubbed from tracked files (73 files): local usernames and home paths in comments, changelog entries, docs and test fixtures are replaced with neutral placeholders (`/home/<user>`, `owner`, `userL`/`userW`/`userN`, `the devbox`); one debug script renamed accordingly. A UI example string mentioning a personal machine name was generalized (source + zh + ja dictionaries in lockstep — i18n check green).
- The three-tier design document is rewritten as a FORMAL, neutral design record (English, no dialogue framing, decision log incl. the approved account-management split, pool sealed-orders reflex, device-originated quota refresh, offline-bias mechanisms, R0–R6 rounds). Requirement discussions live outside the repository from now on; docs/design-cs-unification.md similarly neutralized.
- The live-relay FRP test no longer hardcodes a private path — it reads `VIBESPACE_FRP_SECRETS` (or `~/.config/vibespace/frps-secrets.env`).
- The push guard's EXTERNAL denylist (outside this repo) now blocks personal identifiers in any future push, so this class is enforced structurally, not by review vigilance.

## 2.279.1

**CS separation round closed out.** scripts/test-local-device.mjs live-proves the 2.276.0 keystone against a REAL daemon (throwaway root, real unix socket): `hosts.device(null)` / `device('local')` / `deviceBounded(null)` all resolve device #0, runCmd/fsWrite/fsReadRange/discovery-snapshot execute for real, and a missing local daemon THROWS instead of pretending. The design doc's metric is refined to what actually matters: branch count stays flat by design (branches *select* transports); **parallel implementations** fell from 9 twin-sets to 0 unjustified (7 unified modules + 2 documented exceptions, each with a drift/parity guard). File ops formally recorded as a justified exception: SafeFs's FUSE-hang isolation is load-bearing and the daemon carries live session pipes — revisit only with daemon-side worker isolation.

## 2.279.0

**CS separation, fourth migration: the five remote spawn command builders are ONE composition** (`buildRemoteExec` in src/remote-shell.js).

Every remote session spawn (ssh terminal / ssh chat via keeper / ssh via agentd pipe / dial pty / dial pipe) hand-assembled the same shell line — `cd → prelude → unset ambient tokens → secret-by-$(cat) assigns → exec env …` — as five drifting copies: two of them included REMOTE_PRELUDE twice, and the B-211a ambient-oat strip (an inherited CLAUDE_CODE_OAUTH_TOKEN silently re-bills every remote session) had to be hand-added to all five in 2.267.0. Now every difference is a NAMED parameter (pre/resolve/tokenAssign/acctEnv/parts/tail), the ambient strip is structural and provably ordered BEFORE the deliberate token assign, and the drift guard in scripts/test-remote-shell.mjs (20 asserts now) fails the build of anyone who hand-assembles an `exec env` spawn line in ws-handler again.

Regression belts all green: integration-toggle, tool-toggles, account-verdicts (45), fallback-policy, m3m4 acceptance.

## 2.278.0

**CS separation, third migration: discovery INTERPRETATION is single-sourced** (`src/discovery-facts.js`; table updated in docs/design-cs-unification.md).

The three fact collectors (local rich sweep / device-daemon snapshot / ssh script fallback) legitimately differ in transport — but the interpretation of the same bytes had quietly forked three ways:

- **Naming had ALREADY drifted**: local named a session from the FIRST LINE of the first real user message; the remote parser whitespace-collapsed the WHOLE message — the same session carried different names depending on which machine it ran on. One rule now (first non-empty line, 80 cap, skip injected `<tag>` context and slash-command echoes), used by session-store, the hosts N-line parser, and (as raw lines) the daemon. The truncated-line fallback also learned to read a string cut before its closing quote — the old regex required one and silently named nothing.
- **Tail-ids had three implementations** (session-store full list / daemon inline uniq+last-8 / ssh `grep|uniq|tail -8`) feeding ONE consumer (claimJsonls) with different mention windows. One `extractTailIds` now; session-store delegates, keeping its null-on-unreadable contract (the no-tail-evidence class).
- **The daemon snapshot gains the PID-reuse guard** it never had: it verified lock-pid LIVENESS only, so a recycled pid on a device surfaced a phantom "running" session — the exact hole the local sweep closed years ago, in the mirror direction of the writer-sweep gap (this time REMOTE lacked what local had). `pidLooksClaude` = /proc on Linux (zero fork), `ps` elsewhere.

The structural point: the agentd bundle is built by esbuild from src/, so — unlike the ssh one-file scanner — it CAN share modules; `discovery-facts.js` is deliberately tiny to ride in it. Tests: scripts/test-discovery-facts.mjs (18 asserts incl. the drift cases) + the m3m4 acceptance suite (its live-lock fixture now spawns a claude-looking process AND asserts a pid-reused lock is filtered; fun fixture trap: `/bin/sleep` can be a uutils multi-call binary that dispatches on argv0 and dies when invoked as `claude`).

## 2.277.0

**CS separation, second migration: ctx-folder sync is ONE implementation** (`src/ctx-sync.js`; table row flipped to UNIFIED in docs/design-cs-unification.md).

The old split was the exact bug class the campaign exists for: ssh ran a bidirectional rsync pair with NO caps while dial ran a per-file hashed sync with a SILENT ≤400-files/≤2MB cap — so a 3MB context file reached every ssh host and never reached a dial device, with nothing anywhere saying so. Now:

- The hashed newer-wins sync (sha-equal ⇒ untouched, so echo can never ping-pong; traversal-guarded pulls; `.vibespace/` excluded) runs over the device link on EVERY transport. ssh degrades to its legacy rsync pair only when the device link is down (the writer-sweep pattern); dial surfaces the device error — it has no second channel.
- Caps raised to 1000 files / 16MB per file, and **a capped skip is REPORTED** — one deduped server notice per file ("Context file X (NMB) exceeds the 16MB sync cap and won't reach <host>"). A bounded sync may refuse a file; it may never lose one silently.
- scripts/test-ctx-sync.mjs (13 asserts): newer-wins both directions, no-ping-pong, traversal guard, the 3MB audit file now syncing, skip reporting, and the per-transport fallback policy.

Also 2.276.1 (earlier today): the usage ⟳ button spun its whole border box — the glyph spins now.

## 2.276.1

- Usage popup ⟳: the spin animation was applied to the BUTTON element, so its border box visibly tumbled with the icon (real report). The glyph now spins inside a static box (`.uref-glyph`); the Agents-panel refresh-all was already svg-scoped and untouched.

## 2.276.0

**CS separation, for real: `hostId` becomes a parameter instead of a branch.** (docs/design-cs-unification.md — the anchor, with a per-area migration table and a counted divergence surface.)

The owner's assessment of the campaign so far was correct: parity tests and shared string modules keep two implementations from drifting, but they do not remove the second implementation. The reason nobody *could* remove it: the local daemon has been a full DeviceManager since 2.158.0 — same binary, same mux, same op surface, transport is the only difference — but it lived in a server.js variable that `hosts.device(id)` could never return, because that method began with a host-record lookup. So every feature was written twice by construction.

- `hosts.setLocalDevice()` + `hosts.device(falsy) → device #0` (deviceBounded inherits it). A consumer can now be written ONCE: `const dm = await hosts.deviceBounded(hostId, 8000)` — null means this machine.
- **First real migration: the pre-resume writer sweep** (`src/writer-sweep.js`). It existed three times — ssh, dial, and **not at all for local**. That gap was never a decision: a claude running in an external terminal holds a transcript exactly the way a remote one does, but the incident that motivated the sweep happened remotely, and *the local twin is the one nobody exercises when fixing a remote bug*. Local now runs the byte-identical script over device #0.
- **A sweep is destructive by design, so it now reports itself**: every kill leg echoes the pid it terminated, and the client toasts "stopped N other process(es) that were writing this conversation" — a terminal that suddenly died elsewhere is explained instead of mysterious.
- scripts/test-writer-sweep.mjs (11 asserts) drives the SAME function against a fake local and a fake remote machine and requires a byte-identical script — a test that is only meaningful because there is now one implementation to drive. It also proves dial never falls back to ssh (it has none), ssh keeps its per-op fallback, local throws rather than pretending, and a non-claude holder of the transcript is never killed.

Remaining divergence is now *counted and tabled* (ws-handler 33 branches · hosts 26 · server 29 · files 18 · sessions 7 · remote-fs 7) with each area marked UNIFIED / TRANSPORT-ONLY / DIVERGENT, so the next migrations are mechanical rather than rediscovered.

## 2.275.0

Phase 4 continued — the remaining hand-synced twins get ONE implementation or a parity guard.

- **The local and remote usage walkers are now proven identical by test.** The remote ledger scanner is a shipped single file (a host has no VibeSpace checkout, so it cannot `require` a shared module), which is exactly why it silently lagged its local twin twice: the 2.265.0 subagents/workflows fix took six weeks to reach it, and the 2.271.0 port was another hand-copy. `scripts/test-usage-walk-parity.mjs` runs BOTH walkers over one fixture tree (top-level + plain subagent + two workflow agents + a journal decoy) and demands identical rid coverage, incremental cursor behaviour, and identical pickup of an append. Negative-controlled: reverting the scanner to its pre-2.271.0 top-level-only walk fails 3 asserts.
- **One session text-filter predicate** (`sessionMatchesFilter` in utils.js) for local AND remote-discovered sessions. There were two hand-synced copies and the remote one lacked the backend/agent fields, so typing "codex" listed every local codex session and not one remote codex rollout — the same query silently meant different things per machine.
- Remote File Properties resolves folder size again (the remote `/api/file/stat` branch emitted `du` while the only consumer read `duSize`), and the remote relative-path `locate` fallback returns an explicit `unsupported:'remote'` marker instead of an empty result that reads as "file not found".

## 2.274.0

Phase 4 (CS unification) of the campaign — start removing the DIVERGENCE that makes remote-only bugs possible, not just fixing their symptoms.

- **The remote shell prelude has ONE definition** (`src/remote-shell.js`). Every remote command — ssh terminal / ssh chat / dial terminal / dial chat spawns, capability probes, agentd stdio bootstrap, agent-tool install/uninstall, the usage-scan harvest — needs the same two fixups first (`~/.local/bin` on PATH; nvm sourced, since a non-login `ssh host cmd` shell loads neither). That string was copy-pasted into **11 sites across two files and the copies had drifted** — the audit found spawn builders running a stale variant, which is precisely how a bug becomes "remote only". Same for the POSIX node finder (2.244.4): 4 copies → one `nodeFinder()`, and two of the old copies were the WEAKER variant that located node but never exported its dir onto PATH (so `#!/usr/bin/env node` agent tools stayed dead on dash hosts).
- New `scripts/test-remote-shell.mjs` (12 asserts) is a DRIFT GUARD, not just a unit test: it fails the moment any file re-inlines the prelude or the finder instead of importing them.

## 2.273.0

Phases 2+3 of the lag/silent-failure campaign — the client stops lying under lag, and the classes get retired by shared primitives instead of point fixes (docs/design-lag-cs-audit.md).

**Shared primitives (build once, retire the class)**
- `api(url, opts)` in utils.js — the THROWING sibling of `fetchJson`. fetchJson never throws (returns null on network failure, hands `{error}` bodies back as ordinary data), so every `try { await fetchJson(…) } catch` in the codebase was dead code and every unchecked result silently claimed success — the single largest finding class (49 of 89). User-action paths now go through api() + one catch + a toast/inline error.
- `hostStateChip(state, {text, age, title})` + `agoText(ts)` — ONE visual language for the three transition states every host-scoped surface needed and most lacked: `checking…` (pulsing) / `as of 12m ago` / `unreachable`.

**Stops lying under lag**
- **The session list no longer wipes itself**: one 500 from the discovery sweep (a project dir deleted mid-readdir, any throw under NFS lag) parsed as `{error}` → `data.sessions || []` → the ENTIRE list vanished for ≥5s and flip-flopped back on the next good poll. The poll now keeps the last good snapshot, and after 3 consecutive failures (~15s) shows a "session list may be out of date · as of X" row that clears on recovery.
- **Batch terminate can no longer claim a kill it never attempted**: manage-mode marks on REMOTE discovered cards were dropped (`if (!s) continue`) while the toast still said "applied" — the remote claude kept running. Marks now resolve against the remote discovery lists too, `killPid` gets its host (the 2.191.0 host-less-kill bug's twin), and unresolvable marks are counted as "N skipped" in the confirm dialog and the result toast.
- **An unreachable machine's cache is labelled as cache**: hosts.discoverSessions already stale-marked last-known results; the client dropped the flags, so an hours-old scan rendered exactly like fresh discovery (including amber "external" cards for processes that may have exited long ago). `stale`/`staleAt` now reach the cards as a "last known · Xm ago" chip plus a zone-header row.
- Remote discovery retry loop (whose only visible state was a permanent "Scanning sessions over ssh…") got a 10s backoff that keeps the cached list; `_ensureHostsData` resets its loading flag in a finally and no longer caches an `{error}` object forever (one failed boot fetch used to kill the host switchers for the tab's lifetime).

**Transition states on the slow paths**
- Window creation/attach carry placeholders ("Starting the session on {host}…" → "Loading history from {host}…"), and the attach timeout wording now splits on whether the server's attach-ack arrived: acked ⇒ "still loading, {host} may be slow"; un-acked ⇒ "it may still be working" (never the old reload-invite).
- Billing switcher / New Session / Session Properties show "checking accounts on {host}…" or "couldn't reach {host} — availability unknown" instead of silently greying accounts; a failed `_warmHostAccountCache` records an error state with a 15s retry TTL instead of stamping a fresh success. Session Properties now reads the server's verdicts (B-f531) like every other surface.
- Explorer navigation got a nav-sequence guard (a slow `?host=` listing can no longer be overwritten by a superseded one) + a loading row after a 300ms grace; drag-copy tracks progress like paste.

**More remote-only bugs killed**
- `/api/session-history-gap` accepts `&host=` and all FIVE client callers pass it — gap slabs, minimap, and the streaming search were reading the LOCAL projects dir for remote conversations (silently empty results).
- A failed remote View Log fetch now says why instead of rendering "no transcript found"; a failed Task Group boot fetch surfaces once instead of leaving the board permanently empty with no retry.
- 227 missing zh/ja translations added (2546/2546 keys).

## 2.272.0

Phase 1 (server-side correctness under lag) of the campaign completed — docs/design-lag-cs-audit.md.

- **A slow host no longer gets your running conversation KILLED.** `findKeeperFor` — the probe that decides "adopt the live claude" vs "sweep + respawn" — swallowed EVERY failure into `null`, which callers read as "no live keeper": on host lag the resume path went straight to the writer sweep and SIGTERMed the perfectly healthy remote claude it should have adopted. It now returns a distinct `{error:true}` sentinel (and its ssh leg honours the documented ≥15s session-establishing bar instead of 10s); all three consumers refuse with a retryable "couldn't verify whether this conversation is still running there" error instead of sweeping. This is the mechanism behind the historical session-disappeared reports.
- **A skipped writer sweep is no longer silent**: when the pre-resume sweep fails (exactly under the lag that makes a second writer likely), the resume still proceeds but the `created` reply carries a warning the client toasts — "couldn't verify no other process is writing this conversation … the transcript may double-write".
- **Terminate on a machine reports the truth**: the dial leg is bounded (`deviceBounded` 8s, was an unbounded `device()`) and BOTH legs check their outcome — an unconfirmed kill emits a serverNotice ("may still be running there") instead of the UI implying a clean stop while the remote claude lives on.
- **One device flap no longer kills remote usage collection until a restart**: `runStream` registered no onClose/onExit, so a mid-stream link death left its `done` promise pending FOREVER — `harvestUsage` hung and `_harvestBusy` stayed true for every host. runStream now settles on link death (plus a 120s deadline) and the busy flag became a 5-minute timestamped lease.
- **Dial chat/terminal can no longer hang blank forever**: `openSession`/`openPipeSession`'s `ready` promise only settled on an explicit daemon reply, so a link death BETWEEN the open request and that reply left the bridge awaiting it eternally (the pre-ready twin of the B-b87b critical). Both now reject `ready` on link death.
- **"No login token on the host" no longer means "the host is down"**: `readRemoteOAuth`/`readRemoteSubOAuth` returned null for both, so the quota ⟳ gave the wrong diagnosis and the wrong remedy; they now throw a tagged `host-unreachable` the route renders honestly, and the 60s throttle is stamped only AFTER a probe actually reached the machine.
- Dial usage harvest rethrows the real device error instead of falling into an ssh branch that throws "is a dial-out device", and resets its 15-min throttle on failure so the next kick retries.

## 2.271.0

Phase 1 of the lag/silent-failure/CS-separation campaign (docs/design-lag-cs-audit.md — 89 audited findings, 5 phases).

- **The remote spawn ladder no longer blocks the event loop**: six `execFileSync` calls (tar ×2, ssh ×4 — tool shipping, account-key placement, creds shipping, writer sweep) and the kill path's `pgrep` ran SYNCHRONOUSLY inside the WS create/kill handlers, so one wedged host froze the ENTIRE server for up to 20s per spawn — the 2.242.0 instance-freeze class, still present on the highest-latency path in the product. All now go through a new `execFileAsync` that keeps execFileSync's throw-on-failure contract (the surrounding catch blocks depend on it) and attaches error listeners on the pipe STREAMS (2.241.1 rule); `remoteAgentSetup`/`remoteAccountEnv` became async with awaited call sites.
- **Remote machines were under-reporting their spend exactly like the local ledger did before 2.265.0**: `data/bin/vibespace-usage-scan` still walked top-level transcripts only, so workflow-agent usage (which exists ONLY in `<sid>/subagents/workflows/wf_*/agent-*.jsonl`) never entered the ledger from a remote host. Ported the local walk — remote workflow runs now bill into the ledger and the estimator like local ones.
- **scripts/test-integration-toggle.mjs has been silently red since 2.225.1** and nobody noticed: the harness boots the server from a /tmp worktree, where the temp-server guard refuses every global-hook write, so its five hook-registration assertions could never pass — i.e. ZERO coverage on that path for ~45 releases. The harness now sets `VIBESPACE_FORCE_AGENT_HOOKS=1` (its HOME is a throwaway dir) and the suite passes again.

## 2.270.0

- **Workflow-burst usage was invisible to the estimator — the 2.266.0 workflow tailer NEVER armed once** (user caught it live: est 30-something vs ⟳ 65 during a 9-agent audit workflow). Forensics: the launch ack carrying `Run ID: wf_…` reaches the parent transcript ~17ms BEFORE the harness creates the run directory (measured on a real run: ack 08:23:06.358Z, dir birth .375), and `armWorkflowUsageWatcher`'s one-shot `existsSync(dir)` precondition therefore lost the race on EVERY run — zero `wf-usage-tailer-armed` telemetry events in a month while sibling event names recorded fine. Workflow agents make their API calls in-process (no stdout to feed `noteLive`), so their spend only reached the estimator via the 180s ledger scan = minutes-stale estimates exactly during the highest-burn scenario. Fix: the tailer is extracted to `src/workflow-usage-tailer.js` and RETRIES until the run dir appears (2s cadence, 3min give-up), then fs.watch (0.8s debounce) + 5s poll drain per-request usage (with cw/cr class splits) into the live ring and kick pool evaluation — burst burn now visible within ~1-6s. Observability so it can never die silently again: `wf-usage-noted` metric + the armed event now fires on first real drain. Rule: anything waiting on a path the harness creates asynchronously must retry, never probe once. Test: scripts/test-workflow-usage-tailer.mjs (9 asserts incl. the race).

## 2.269.0

- **Merged PR #23 (Him188): isolated Claude subscription login works on macOS** — adapted onto current master (the PR predated ~50 releases; 5 files hand-resolved). Claude Code on macOS stores an isolated `CLAUDE_SECURESTORAGE_CONFIG_DIR` login in the Keychain only (service = `Claude Code-credentials-` + `sha256(NFC(dir))[:8]`), which a launchd-started VibeSpace often can't read — the named subscription stayed "not logged in" forever. Add-subscription now runs through `data/bin/vibespace-claude-subscription-login.mjs`: the official `claude auth login --claudeai`, then (macOS) reading the fresh Keychain item IN the interactive terminal's security session and atomically writing only `claudeAiOauth` to the dir's fallback file; a sanitized `.vibespace-login-status.json` lets local finalize and on-host watchers stop on the exact attempt's success/failure instead of polling blind. macOS Keychain-backed subscriptions are marked **local-only**: never config-exported/remote-shipped (two copies fork the rotating refresh token), never auto-merged/renamed (the Keychain service hash includes the dir path). Adaptation beyond the PR: the local-only rule lives in `evaluateOnHost` as its own verdict rung `local-only-mac` (blocked before 'ship', honest reason instead of 'ship-disabled'; held/linked/oat rungs unaffected — B-f531 single-authority), the on-host login watcher keeps the 2.245.0 stacked-surface refresh (no `_agentsHostPref` revival), and the dial fatal-degrade guard keeps the B-211a `_hostSubReady` nuance. Tests: scripts/test-claude-subscription-login.mjs (the PR's, adapted) + 8 new asserts in test-account-verdicts (45 total). macOS end-to-end verification pending on the author's machine.

## 2.268.9

- **Theme editor no longer freezes your live edits into other themes' "defaults"** (B-b2d6, adversarial-review finding): CSS custom properties inherit, and only "dark" defines every var — a partially-defined theme's missing vars fell through to the documentElement, which the live preview covers with inline overrides (and an applied custom theme covers via its stylesheet), so switching Base themes read back your own just-edited values and Save froze the pollution into the new theme. `extractThemeValues` now probes inside a `data-theme="dark"` wrapper that intercepts inheritance — missing vars resolve to real built-in defaults regardless of ambient state (mechanism verified in headless Chrome: polluted rgb(66,66,66) → real default with the wrapper).
- Agents Machines tab: collapsed accordion headers show health at a glance (inbox follow-up) — a connection dot from the dial registry's live truth (dial/graduated machines only; plain ssh has no probe-free signal and never guesses) + the machine login's worst quota bucket as a colored pill from the cached usage snapshot. The expand-time probe stays lazy; zero Anthropic calls.

## 2.268.8

- **Native OneDrive mounts actually work** (user report — first local add failed): rclone's onedrive backend refuses to create the fs without `drive_id`+`drive_type` in config (its interactive `rclone config` resolves them via Microsoft Graph; our guided flow never did, so every FRESH native add died with the cryptic "if you are upgrading from older versions of rclone" error — imported rclone.conf records only worked because the conf carried both). Now: `_resolveOneDriveDrive` (Graph `/me/drive`, region-aware endpoint) runs as a mount-time backstop whenever `driveId` is missing (honest row error on failure — an expired token says "token expired", which also surfaces the re-auth button) and after every re-auth token write-back; an explicit Drive ID is never overridden. Test: scripts/test-onedrive-resolve.mjs (8 asserts, mocked Graph).
- **Re-auth surfaces stop saying "Google Drive" for non-Google mounts** (same report — the OneDrive edit dialog offered "重新授权 Google Drive…"): the two re-auth buttons + the re-auth dialog (hint / sign-in button / sign-in-page status / success toast) are provider-aware via `_oauthProviderNames` (product vs sign-in-provider names: OneDrive/Microsoft, Dropbox, … — brands untranslated). Also fixed: the server's `applyDriveToken` REJECTED onedrive/cloud records outright ("Not a Google Drive connection") — the edit-dialog re-auth button was dead server-side for every non-Google OAuth type; it now writes the token for all of them.

## 2.268.7

- **Agents roster rows show the reset countdown** (user clarification: this surface, not the usage popup): the age cell becomes a two-line micro-column — data age on top (unchanged), and below it the reset countdown of the row's most-constrained bucket (est-aware pick, colored by that bucket's pressure — "when does the tight bucket free up"). Per-donut tooltips and the narrow-width pill tooltip carry per-bucket "resets in …" too. Fixed min-width keeps the donut-column alignment invariant; buckets whose reset already passed are skipped (effectively fresh). Applies to local, host, and pool rows alike (all render via `_acctUsageHtml`).

## 2.268.6

- Quota popup "Resets" stats gain a live countdown suffix — `Tomorrow 3:00 · in 1d10h50m` (user request). Rides the one shared `fmtReset` formatter, so every reset line (5h / 7d / scoped weeklies / codex) gets it with zero new UI elements; suppressed inside the final 45s.

## 2.268.5

- **Account lists sort by TYPE, not add-order** (user request): pools first (the umbrella identities you actually pick), then subscriptions, then API keys, name-sorted within a type — applied consistently to the Manage-Agents roster, the billing switcher, and the New Session account dropdown (divergent ordering between surfaces reads as a shuffle). The codex roster name-sorts for parity (all its entries are logins).

## 2.268.4

- **"登录" and "+ 添加账号…" no longer sit side by side as look-alike primaries** (user report): when named/pooled accounts are carrying the sessions, the backend row's machine-wide "Log in" button disappears and the action moves INTO the Add-account menu as a clearly-labeled "Log in machine-wide (claude /login)…" entry. A machine with no named accounts keeps the primary Log in button (it is the main path there).

## 2.268.3

- "Set up both…" retired from the Anthropic add-account menu (user: 没啥意义了) — the 2.43.0 console+subscription dual-login wizard predates named accounts and pooling; the menu now leads with the actual add paths. The dangling leading separator on non-importable machines is guarded; the wizard method itself stays (onboarding import path).

## 2.268.2

**Per-bucket-kind pool thresholds** (user-designed: what matters is ABSOLUTE headroom, not relative — 1% of a 7d window ≈ $17 vs 1% of a 5h window ≈ $2-5). The single exhaustion threshold split by bucket kind: **5h hot 10% / hard 5%** (unchanged), **weekly (7d + Fable) hot 5% / hard 3%** — a weekly bucket at 88% still holds ~$200+ and is a perfectly healthy target. Exhaustion = ANY bucket under its kind's threshold; candidate gate + settle bar are per-kind too (settle = every bucket ≥ kind's hot threshold + 3). Immediate effect on tonight's roster: Personal Max (Fable 82-88%, sooner weekly deadline) becomes a legitimate EDF target again instead of idling behind Fish — its ~$150 of expiring Fable gets drained before the 8/14 reset. Pool suite rewritten to the per-kind semantics (38, incl. "the Personal case" and the per-kind oscillation pair).

## 2.268.1

**Third class: cache READS are the nearly-free one** (user report: est 60 vs ⟳ 51, minutes after 2.268.0 went live — the incident window's $34.55 held only $1.29 of cache-write; incremental caching makes conversation windows cache-READ-dominated, and 2.268.0's two-class split had lumped cr into "other"). The 5h regression is now 3-class (`byClass {cw, cr, other}`; du = rate_cw·cw$ + rate_cr·cr$ + rate_fresh·fresh$, 3-var least squares, per-class priors $500/$3000/$200 + per-class sanity bounds):

- Real-data fit via the shipped path, three identities in tight agreement: **cr-full $2660-2782** (cache reads nearly free for the bucket), fresh $179-192, cw $190-261. The refined physical picture: the 5h bucket ≈ input-class token count with ~zero weight on cache reads — cw and fresh burn at the SAME token rate, and cw's slightly higher $-implied full is exactly our 1.25-2× cache-write pricing premium. (2.268.0's "cw burns half" was a two-class artifact of cr hiding inside both groups.)
- Tonight's 60-vs-51 window re-predicts **+2.5 points vs actual +3** (two-class said +12, blended +12.3).
- Live ring entries carry `crUsd`; both stream feeders split it out; class pairs need cw AND cr present (older two-class snapshots fall back to blended — the learn-time ledger recompute gives virtually every pair the 3-way split retroactively anyway). Estimator suite 73.

## 2.268.0

**5h token-class regression (B-536b, user-approved)** — the 5h bucket's last big error source was that ONE blended $-rate swung ±2.5× with the hour's cache-write share. The estimator now learns TWO rates per identity for the 5h bucket via 2-var least squares over class-split pairs (du = rate_cw × cw$ + rate_other × other$), seeded by pure-class prior pseudo-pairs (cw $800 / other $250) that real data quickly dominates:

- `costBetweenMulti` splits every window's cost into `byClass {cw, other}` (cache-write component priced alone vs everything else) — and because rate learning RECOMPUTES pair costs from the live ledger, **every historical pair gets its class split retroactively**, no data collection wait.
- Real-data validation across three independent identities agrees quantitatively: cw-full $370-531 vs other-full $180-275 — a cache-write dollar burns the 5h bucket roughly HALF as fast as a fresh/output dollar. Tonight's 53-vs-48 window re-predicted with class rates lands at +4.5 points vs the actual +3 (blended said +9.2).
- Estimation is class-aware end-to-end: the live odometer ring carries `cwUsd` per entry, `_liveDelta` and the ledger cost merge byClass, `estimateBuckets` predicts per component when the source carries the split (blended stays as display value + fallback for degenerate regressions/pre-split snapshots). Sanity bounds (implied fulls within $40-20k, positive coefficients) withhold class rates on absurd fits. 7d/scoped stay blended by design (long windows average the mix out; their calib error is already 0-3 points).
- Estimator suite grows to 72 (recovery of both class fulls from synthetic mixes, class-aware vs blended prediction, no-split fallback, sanity-bound withholding).

## 2.267.4

- **"机器登录闲置失效" no longer over-claims the cause** (user challenge: 一定是闲置吗？): `/api/backend-status` distinguishes a token-less-but-present credentials file (`machineLoginState: 'expired'` — expiry OR logout, worded "已失效") from a machine that NEVER logged in (worded "未配置机器登录"). The header only claims what the evidence shows.
- **Onboarding no longer funnels everyone through the machine-wide login**: the Claude card gains an "Accounts & pool…" button opening Manage Agents as a modal ABOVE the wizard (`forceModal` skips the rail-panel redirect, which would have opened behind it; cards refresh on close), named/pooled accounts count as ✓ ready for the step (`{n} named account(s) in use`), the machine-login button demotes to secondary when named accounts exist, and a tip line says pools/named accounts work without the global login.

## 2.267.3

**The est-2× bug — live-odometer double count, quantitatively confirmed** (user report: est 27% vs ⟳ 9%; arithmetic closes exactly: 2 × $34.73 window cost / $256.5 learned full = 27.1%):

- STDOUT stream records carry **no `requestId`** (measured 0/22 on a live buffer) — the live odometer ring keys entries by `msg.id` (`msg_…`) while ledger events key by `requestId` (`req_…`). The rid-space exclusion (`known.has(rid)`) could therefore **never** fire: once the ledger scan absorbed a request, the ring's copy kept counting on top of it — every streamed request double-counted for as long as a conversation stayed active (the ring deliberately has no age-out). The ledger now bakes `mid` (message.id) alongside `rid` on every claude event, `_loadEvents` maintains a `mids` set, and `_liveDelta` excludes against BOTH id spaces. Rate learning was never affected (it is ledger-only) — this was purely the live display/pool-decision layer.
- Bonus accuracy: the same `msg.id` is emitted up to 3× on stdout with GROWING usage (streaming partials) — first-wins under-counted the not-yet-scanned part; a re-noted rid now upgrades the ring entry to the max.
- Historical shard events lack `mid` (fine — the ring is empty after a restart; new events carry it). Estimator suite grows to 66 with the mid-exclusion + growing-partials regressions.
- Residual gap (13.5% pure-rate prediction vs 9% actual) is the learned 5h rate's multi-device-share bias — it self-corrects as clean per-window pairs accumulate; the display error was dominated by the double count.

## 2.267.2

Hotfix for a 2.267.0 regression the fake-`code` move dragged in: three OTHER generators (vibespace-status / vibespace-hook.mjs / hook-register) and the statusline path were anchored on `EDITOR_DIR` and silently followed the move into `data/bin/editor/` — scattering agent tools OFF the session PATH, pointing the statusline at a nonexistent file, and rewriting the global hook registration to the editor subdir. All re-anchored on the tools dir (`AGENT_BIN_DIR`); only the fake `code` lives in `editor/`. The stray generated files 2.267.1 accidentally committed are untracked again (`data/bin/editor/` gitignored — tracked generated files are the 2.111.26 self-update-blocking class); stale `editor/` copies stay on disk so sessions that snapshotted the interim hook path keep working until their next restart.

## 2.267.1

Pool-display + mobile parity batch (three user reports, same evening):

- **"Claude Code — not logged in" no longer cries wolf**: under full pooling the machine login legitimately idles to token-less, but the Manage-Agents backend header read as "Claude is broken" while 6 named/pooled identities were carrying every session. `/api/backend-status` now counts usable named identities (`namedLoggedIn`); the header says "machine login inactive · N named account(s) in use" (Log in stays offered — it's still how you revive the machine login). A genuinely account-less machine keeps the honest warning.
- **The pool is no longer labeled "· API"**: the billing switcher's pool row now reads `名字 → 当前目标` with the TARGET's usage preview (dead-reckoned est included); on a remote session it's disabled with the local-only reason instead of failing at spawn. The New Session dialog had the same class of bug worse — a pool fell into the API-key else-branch and rendered "— API key …undefined"; it now shows `→ target` locally and "pool (this machine only)" disabled on hosts.
- **Mobile parity**: the phone's worst-of quota chip now includes the model-scoped weekly buckets (the bucket that actually exhausts first under Fable-heavy load was missing from "worst"), estimate-aware like the rest; the mobile window-switcher's billing chip names the pool AND its current target (desktop badge parity). The billing switcher, usage popup est bars, and Manage-Agents pool rows were already shared code and inherit the fixes above.

## 2.267.0

Two halves: the estimator calibration pass (user report: 最近几次刷新预测倾向于高估) and the B-b87b defect batch — all 16 adversarially-confirmed findings from the 31-agent global review, fixed.

**Calibration (the overestimate had a smoking gun, and it wasn't the reset logic):**

- **Bounce-back pair taint** — the systematic overestimate's root cause, caught in the calib stream: a stale sibling cache file briefly promoted to freshest anchored a week-old reading (Personal Max: fable 51%→19%→51% within minutes). The DECREASE pair was already voided as an anomaly, but the RECOVERY pair (du +32% for $1.68) taught a ~30%-hot rate. An anomalous reading now poisons BOTH its incoming and outgoing pair. Re-derived on the real anchor file: fable implied-full $556→$724, 7d $1222→$1521 — tonight's +10.8-point fable overestimate all but disappears, retroactively (raw pairs are kept forever; the fix re-learns from history).
- **Limit-banner marks write through the identity group** — the flap's source: stamping `fetchedAt=now` onto ONE file of an org-merged identity promoted that file (week-stale sibling buckets and all) to "freshest" for the anchor sweep. The mark now bases itself on the identity's freshest file and marks the same bucket dead in every sibling WITHOUT touching their freshness.
- **predictCalib honesty guards** — the calib stream carried p100/a0 rows across 5h rolls and p5/a100 banner rows, drowning the signal it exists to expose (and briefly fooling this investigation): at-cap readings, one-sided resetsAt, and window-length-exceeding spans are now skipped. (The user-facing estimate paths already had these window-roll semantics — the reset handling itself was sound.)
- Estimator suite grows to 64 (taint pair/learned-rate regression + the three calib guards).

**B-b87b defect batch (16 confirmed findings, critical first):**

- **CRITICAL — dial chat froze permanently after any dial-link drop**: the session bridge discarded the pipe handle's transport-death signal (`onExit` no-op'd), leaving the attach client writing input into a corpse. The bridge now tears the loopback down so chat-wrapper's backoff respawns against the re-dialed device.
- **CRITICAL — a tab stopped receiving settings changes forever after its first local edit**: `SettingsManager._save()` never cleared `_saveTimer`, so the echo-revert guard stayed armed permanently and `applyRemote`/`refetch` skipped every future update until reload.
- **user-state clobber belt**: the full-doc last-write-wins POST let a stale tab silently revert stars/renames/configs made in other tabs. The client now diffs against the last server-applied snapshot and PATCHes only changed top-level keys (new merge route); a stale tab's damage is bounded to the key it actually edited.
- **Billing honesty on adopt**: resuming with an EXPLICIT account pick no longer silently adopts a surviving keeper/agentd/dial child (which keeps its ORIGINAL billing under the picked badge) — adoption is skipped so the respawn applies the pick; `_resumeSpawn`/`_sawFirstId` persist in session meta so implicit-fork adoption survives restarts; pooled accounts as the DEFAULT fall back to the host's login on remote creates (explicit pool pick on a remote host refuses with guidance — pools are local-only by design).
- **Remote parity batch**: `/api/file/excel`, `/api/file/csv` (+`docx`) work on remote hosts (bounded fetch to a mtime/size-validated local temp, cached for the CSV pager); the remote archive viewer works end-to-end (one shared listing parser for local+remote — the shape drift crashed `e.name` — + entry extraction off the host, ssh AND dial); **dial devices get real context-folder sync** (per-file newer-wins over the device link, content-hashed so echoes can't ping-pong — dial agents were being taught ctx paths that never existed); remote spawns `unset` an ambient `CLAUDE_CODE_OAUTH_TOKEN` from host profiles (it silently re-billed every remote session, top credential precedence).
- **Teardown/retry correctness**: ssh Terminate of an agentd-ADOPTED session targets the pipe sid (state file was keyed by the webui id — remote claude survived every terminate); pty-wrapper's reconnect cap is monotonic and the delay ladder resets only when a child LIVED ≥30s (ssh's own stderr counted as "link works" and a dead host retried every 1s forever); chat-view's reattach handler stays armed for the whole retry-ladder window (an 'attached' between 30s and ~2min was half-processed into a silently stale view).
- **Smaller**: the fake Ctrl+G `code` helper moved to `data/bin/editor/` — off the session PATH, where it shadowed real VS Code for every local terminal (`code file.txt` hung); remote folder-match in the client strips the display host label so board membership agrees with server-side group belonging; the billing switcher's per-row quota preview reads the dead-reckoned estimate (dash-underlined) instead of contradicting every other surface with a stale reading.

## 2.266.2

- **"Subscription signed out (a Console login replaced it)" was the wrong story** (user question: 为啥提示订阅已登出 — forensics: `~/.claude/.credentials.json` held empty tokens with NO `primaryApiKey` anywhere, i.e. no Console login ever happened). The real mechanism, new to the pooling era: with named/pooled accounts handling every session, nothing ever runs on the bare machine login, so its refresh token ages out (this machine's expired 06:46 today) and the CLI's next failed refresh clears the stored tokens — same signed-out file shape, completely different cause. The detection now derives a cause (`primaryApiKey` present ⇒ console; absent ⇒ idle-expiry, computed once per creds-file change) and the popup shows an honest message for the expiry case: named accounts are unaffected (the linked named account's own token pair is alive and refreshed by the pool), `/login` only needed if you use the bare CLI login. The warning still renders under the linked named account's chip (`showingGlobal` includes the identity link) — that stays, since the machine-login fact belongs to that identity.

## 2.266.1

Three pool-operations fixes from live use (all three user-reported the same evening):

- **⟳ quota refresh resolves tokens through the IDENTITY GROUP** ("现在刷新Personal Max的时候还在提示这个" — correct logic: if the pool can bill a conversation to the account, ⟳ must be able to read its quota). The refresh route's token lookup now walks every account id in the target's identity group (org-merged accounts span `__global__` + the named sub — the named dir's token stays fresh while the machine login idles into expiry, and vice versa), and `probeUsageForAccountKey` matches any live session whose usage key is in the group (pool sessions resolve to the real target, so a pooled conversation can answer `get_usage` for the account it's actually billing). The result is always written to the REQUESTED key's cache. "No valid token" now only appears when the whole identity truly has none.
- **Pool oscillation killed — settle bar + dwell belt** ("一直在Fish Max和Personal Max之间切换…疯狂触发out of cache"): the hot tier's raised exhaustion threshold (est<10%) and the EDF proactive rule pointed in opposite directions once an account sat just under 10% with the sooner weekly deadline — soft-exhaustion moved off it, proactive jumped straight back, every tick, cold-starting BOTH sides' prompt caches. Now every VOLUNTARY move (soft-exhaustion or proactive EDF) must land on a member above the settle bar (`exhaustPct + MIN_GAIN`, i.e. it won't itself trip the exhaustion rule) — applied at candidate SELECTION, so a below-bar EDF-first member is skipped for a later qualifying one; hard-dead (<5%) still takes scraps. Engine belt: after any actual switch a pool holds 180s before the next voluntary move (hard-death exempt). Pool suite grows to 34 with the oscillation regression pair.
- **Message metadata popup shows the billing account** (right-click a message's left strip): a new async row resolves the record's requestId against the usage ledger (`GET /api/usage-stats/rid-info`) — account name, `· via pool "X"` when the request flowed through a pooled identity, honest "not in the ledger yet" before the scan absorbs it. With auto-switching moving billing mid-conversation, per-message attribution is now user-visible.

## 2.266.0

Exhaustion #2 post-mortem (same day: a 31-agent review workflow killed the Fable weekly bucket — anchors show 51%→100% in the final ~4 minutes, faster than any polling cadence could see). Three layers, all addressed:

- **Event-driven pool evaluation + live odometer** (user-designed): every usage record streaming through a session's stdout (main thread AND subagent sidechains) is noted into an in-memory ring (`usageEstimator.noteLive`) the moment it arrives — before the transcript flushes, long before the ledger scan — and kicks a 5s-throttled pool re-evaluation (`kickPoolEval`). Estimates add ring entries the ledger hasn't absorbed yet, rid-deduped against the ledger's own request-id set so nothing ever double-counts once the scan lands. The scan-lag blind window for stdout-visible burns is gone; the timer drops to 30s with a 10s per-pool decision gate (anti-flap lives entirely in the MIN_GAIN margin now, not the cadence).
- **Workflow agents get a file-level "wrapper"** (user question: 拦截workflow agents保证在wrapper下 — they are IN-PROCESS API calls with file-only transcripts, no process to wrap, but tailing is equivalent): the launch ack ("Run ID: wf_…") arms a run-dir tailer (`armWorkflowUsageWatcher` — fs.watch + 5s belt poll, per-file byte offsets, complete-lines-only) that streams every agent's usage records into the live odometer within ~1-2s of being written. rid-dedup makes offset loss harmless; teardown on 30min idle or session death. The last observability corner (this morning's "half the Fable bucket between two ticks") is closed.
- **Org-merged identities read quota through the identity group**: a machine-login-linked account keeps TWO cache files (`__global__` + the named sub) and ground truth lands in whichever one the refresh targeted — during the incident the ⟳ readings (Fable 34%→51%) went to `__global__.json` while the pool decision read the sub's file frozen hours earlier. `readCache` now takes the freshest file across the identity.
- **Third live banner wording**: `You've reached your Fable 5 limit` (no "weekly" word) was mis-marked as the 5-hour bucket (self-heals in 5h while the scoped bucket is dead for up to a week). A model name in the banner now always means the scoped bucket.
- Tests: estimator suite grows to 58 (live-odometer visibility/dedup/account-scoping) + banner suite 21.
- **docs/architecture-map.md** (new): the product of a 31-agent global review workflow (which doubled as the pool stress test) — 9-subsystem index, 41 imperative ownership rules (OR-1…41), 9 cross-file contracts, and a 22-class "where does my change go" decision table, plus a phased refactor plan. 17 adversarially-confirmed defects from the same run are queued as the next fix batch (critical first: dial chat sessions freeze permanently after any dial-link drop — the bridge discards the transport-death signal).

## 2.265.0

The calibration log's first real catch (user report: "最近几次预测都严重高估" — est now 3-4× hot on the 5h bucket; `calib` records pinned it to a $139-implied-full learned rate vs the true ≈$500). Root cause chain, all three links fixed:

- **The usage ledger NEVER mined workflow/subagent transcripts** — the scan read `<proj>/*.jsonl` top-level only, but workflow agents' API usage exists ONLY in `<sid>/subagents/workflows/wf_*/agent-*.jsonl` (~**$205 for one 15-agent review run**, measured). The scan now walks `subagents/` (agent files + workflow dirs; journal files excluded), attributing events to the PARENT session id so account/pool by-time attribution follows the parent; requestId dedup absorbs the parent-sidechain overlap. This also fixes the **Usage window's long-standing under-reporting** of every workflow/ultracode run — historical files backfill on the next scan (per-file cursors start at 0 for newly discovered files).
- **Rate learning now recomputes pair costs from the LIVE ledger** at learn time (10-min rate-cache TTL) instead of trusting the frozen `costSince` snapshot — the sweep records cost against a scan that lags fast burns, so frozen pairs systematically under-counted cost and taught hot rates. The ledger is append-only and eventually complete: late-landing events (like the newly-mined workflow files) retroactively heal every stale pair. A zero live total with a non-zero snapshot (retention gap) falls back to the snapshot.
- **At-cap readings are censored from learning**: a bucket clipped at 100% (the limit-banner mark writes exactly 1; a genuinely exhausted ⟳ reads 100 too) says nothing about how much spend got it there — the incident's 9%→100%-over-$50 pair was the direct poison. Gate/display semantics unchanged.
- Note: the measured Max-20x priors (5h $500 / 7d $1730 / Fable $875) came from the same under-counting ledger and may read slightly LOW once workflow history backfills — the prior is a weak pseudo-observation, so learned rates self-correct; a re-derivation with the complete ledger is worth a look after a few days.
- Tests: scripts/test-usage-scan-subagents.mjs (7 — workflow/subagent mining, parent attribution, journal exclusion, dedup, incremental cursor) + test-usage-estimator.mjs (54, incl. cap-censoring and live-cost override/fallback).

## 2.264.0

- **"Report a problem" now ships chat scroll traces automatically** (user request, straight out of B-21bc: a viewport-jump report arrived with zero scroll evidence — and the documented Ctrl+Shift+J dump turned out to be a dead stub since 2.111.8). The chat scroll tracer is back as an **always-on in-memory ring** per chat window: the pre-existing paging/trim/jump/fold-restore breadcrumbs re-arm, plus a coarse scroll sampler (moves >400px with pin state and time-since-last-user-wheel — the discriminator between a user scroll and a programmatic yank) and an explicit unpin breadcrumb. Positions and op tags only, never message content. The incident snapshot carries each open chat window's ring tail (`chatTraces`), so the next B-21bc recurrence is self-evidencing — nothing for the user to remember.

## 2.263.0

Quota dead-reckoning v2 (B-fcff, user go-ahead: "按照这个作为初步的approximation锚点来实现自动统计切换…随着数据增多内部自动优化estimation"):

- **Estimation engine** (`src/usage-estimator.js`): between ground-truth readings, each bucket's current utilization is estimated as `anchor + learned_rate × ledger_cost_since` — per-identity per-bucket rates derived from the accumulated anchor pairs (weighted least squares through the origin: integer-% quantization noise averages out as data grows; single pairs are ±3× noise and are never used alone) and **re-derived automatically on every new anchor** — no manual analysis needed, ever. Seeded with the measured Max-20x priors from the ProblemFactory odometer study (5h ≈ $500, 7d ≈ $1730, Fable ≈ $875 API-equivalent; blended as a weak pseudo-observation that real data outweighs). Zero API calls anywhere — anchors + local ledger only.
- **Calibration log**: every new anchor now records what the current rates *predicted* vs what the reading *actually* says (per bucket, into the anchor file itself + a Diagnostics metric `usage-est-err-pct`) — the "记录预测值和真实值的差异" half of the design, offline-analyzable forever.
- **Pool auto-switch consumes ESTIMATED views**: the decision no longer sees a reading frozen at the last statusline/⟳ — it sees now. Hot pools additionally treat **est < 10%** as exhaustion (提前切 — switch before a limit interrupts a long-running workflow); cold pools keep 5%. Weekly-window rolls re-base estimates from the reset boundary (7d cadence is fixed; a passed 5h reset abstains — its window start is unknowable).
- **Sweep now groups by identity** (real data bug found in the ProblemFactory analysis): an org-merged login (machine login + named sub = one Anthropic account) was double-anchoring one identity from two cache files, each record's cost missing the sibling's spend. One identity = one anchor stream; cost sums across all its account ids (incl. ids from removed re-added subs).
- **Estimation is VISIBLE (dashed = estimate, user-specified)**: usage popup bars gain a light diagonal-hatch span from the confirmed fill to the estimated value (dashed right edge = the estimate) + an `est N%` stat; taskbar pies and the Agents roster mini-donuts fill the estimated delta as a **light arc** with a dashed outer ring. **Reset-crossing display rule (user-specified): est < reading ⇒ the window rolled — the dark confirmed arc collapses to 0 and the whole value renders light** (a stale dark arc must never exceed the estimate). `/api/usage` carries the new `estimates` field.
- **Pooled accounts no longer render as API keys in Agents** (real report): dedicated pool icon (overlapping circles), no "Show key…" in the ⋯ menu, and the pool row shows its **current target's** usage/estimate donuts.

Live-fire hardening — an 8-minute review workflow burned an entire 5h window mid-development and the pool only switched AFTER 9 agents had already failed (real incident, same session). Three trigger gaps found and closed:

- **The limit banner has TWO live wordings** — the parser only knew `You've reached your …`; the incident's failures said `You've hit your session limit · resets 3am` and the banner path was completely blind to it. Parser + stream gate now accept `reached|hit`, non-anchored.
- **The phrase can arrive inside a task-notification blob** (workflow agent failures never produce a main-stream assistant banner) — the wakeup user record is now scanned for it too, feeding the same immediate pool re-evaluation.
- **Both event triggers (turn `result` + banner) sit at TURN EDGES** — a long turn has zero evaluation points while burning fastest. Every auto pool now re-evaluates on a **60s timer** (ledger freshened first via the self-throttled incremental scan; local reads only, zero API calls — §ban-safety unchanged).

Adversarial-review round (4-lens workflow, verified findings fixed):

- **Estimate memo goes stale against fresher ground truth** (major): a ≤30s-memoized estimate vs an advancing reading falsely tripped the "window reset" display collapse, and — worse — would have MASKED a limit-banner mark (utilization 1) from the pool's immediate switch. The memo now records what it was computed against and busts the moment a fresher cache reading exists; `estDisplayPair` additionally treats est within 2% below the reading as freshness skew (no layer), not a roll.
- **Scoped (Fable) readings carry `asOf`** — they only refresh via ⟳ and are preserve-merged into fresher caches; estimation now accrues cost from when the reading was TRUE, not from the anchor write (fable spend since the last ⟳ silently vanished), and identical-reading pairs are excluded from rate learning (they biased rates low).
- **Pairs are bounded by window length** (a 5h pair spanning >5h has definitionally crossed a reset — covers resetsAt-less partial caches that disarmed the crossing guard) and **`__global__` never joins an identity's ledger union from history** (it's the one reassignable id — a machine `/login` switch would otherwise double-count the new login's spend into the old identity's odometer forever).
- **Exhaustion anti-flap margin** (+3%): two members leapfrogging inside the exhaustion band no longer ping-pong the pool every evaluation tick.
- Second verification pass (the review workflow resumed onto the fixed code — 6 of its remaining findings independently confirmed the mid-flight fixes; 2 more confirmed and fixed): **resetsAt-less buckets** (the statusline hook's defensive `resetsAt: 0` fallbacks) now bound dead-reckoning to one window length and abstain beyond it (verifier reproduced a 3-day-old anchor + $600 of ledger cost rendering a 120% five-hour arc that false-tripped the pool gate), and fabricated `status:'unknown'` placeholder buckets never anchor (a u:0 fabrication paired with the next real reading forged a ~6× rate inflation); **legacy pre-2.263.0 interleaved anchor records** (the org-merge under-counted-cost era) are excluded from rate learning by the grouped-record signature — mixed-id files only learn from marked pairs, single-id history keeps learning.
- Tests: scripts/test-usage-estimator.mjs (51 — pair guards, prior→observation dominance, roll semantics incl. multi-week, normU input classes, asOf, memo-staleness, id-union, resetsAt-0 abstain, legacy filter, overlay, calibration) + test-usage-anchors.mjs (12) + test-pool-auto.mjs (30) + test-get-usage-parse.mjs (20, incl. the incident wording) + dbg-est-shot.mjs (screenshot-verified popup + Agents rendering incl. the rolled case and the pool row/menu).

## 2.262.0

- **Agents surface redesigned into three tabs** (user: 按设备平铺缺分级看着累 + 指令环节孤立): **Accounts** (default — the management home: local roster, local CLI logins, integration), **Machines** (one **accordion card per host**, collapsed by default with the ssh/dial probe running **lazily on first expand** — opening the dialog no longer fans probes to every configured machine; open-set remembered per device; a single host auto-expands), **Instructions** (the agent-injection fields get their own tab instead of dangling collapsed at the bottom). Tab choice persists per device. Modal and rail panel share the layout. The smoke suite navigates the real tabs (accordion fill, per-row refresh errors on both tabs) — and caught a silently-broken 2.258.0 assert along the way (the menu redesign moved the `Fa 41%` spacing from text to CSS gap).

## 2.261.0

- **Quota dead-reckoning data foundation** (user-designed "惯性导航" step 1): every ground-truth usage reading (statusline / ⟳ / get_usage / limit banner) is now recorded as an **anchor** — together with the local ledger's cost consumed since the previous anchor (split by model family, so Fable-bucket rates stay derivable) — into `data/usage-anchors/anchors-<identity>.ndjson`. This is the complete, raw training set: prediction/rate models can be built and re-built **offline forever** from anchor pairs. Zero API calls (a 60s sweep of local cache snapshots).
- **Identity key, not the minted account id** (user requirement): anchors key by `orgUuid > lowercased email > account id`, so a subscription's tracking history **survives remove + re-add** (a re-add mints a fresh `sub-<hex>` id; the same login resolves to the same identity). Note: re-adding the *same login without removing* already merges into the existing record — the identity key closes the remove-first hole.
- v2 (queued): learned per-account/per-bucket exchange rates + estimated-remaining feeding the pool's proactive switch, with the calibration log (predicted vs actual). The empirical study behind the design (a real account's local ledger sees only ~1/7 of its consumption — multi-device — so fixed token→% rates are impossible and per-identity learning is mandatory) is recorded in the shared context.

## 2.260.0

Chat-mode usage freshness WITHOUT new automation (B-7edc/B-292b closed; auto-firing explicitly rejected):

- **Limit banner = the chat-mode passive exhaustion signal** (zero API calls): the CLI already prints "You've reached your … limit" into the chat stream the moment a bucket hits zero — the server now parses it (5-hour / weekly / model-scoped by name), marks that bucket dead in the account's usage cache (keeping a known future reset, else a bounded guess so the marker self-expires), and **immediately re-evaluates the pool auto-switch**. This is what makes pooling work for chat-only accounts — the statusline never runs there. Attribution follows the pool's real target.
- **⟳ prefers the CLI's own `get_usage` control channel**: when a live LOCAL claude chat session is billed to the refreshed account, the quota fetch is now made *by that session's CLI* (first-party client, same as typing /usage there) instead of our bare read-only API call — a strictly better ToS posture. Human-gated as before (the ⟳ click), same 60s throttle, silent fallback to the bare call when no session answers. **Auto-firing `get_usage` was considered and REJECTED** (user decision): a machine-initiated quota check is the automated-access pattern behind the real 2026 account ban, no matter who makes the HTTP call.
- Envelope verified on a real session (zero inference — the CLI answers `get_usage` without any turn): payload nests at `control_response.response.response`; `utilization` arrives as 0-100 integers (parser normalized); there is NO `model_scoped` array — scoped caps ride as named nullable fields (`seven_day_sonnet` etc.) + codename buckets, now parsed with a named-field fallback (no-reset codename buckets skipped). Parse suite: scripts/test-get-usage-parse.mjs (18, incl. the captured live envelope + banner cases).

## 2.259.0

- **Pool auto-switch v3: earliest-deadline-first ranking** (user-designed): quota is a *perishable* asset — the pool now drains the member whose **weekly window resets soonest** (its remaining is use-it-or-lose-it; far-reset quota is storable), instead of the most-remaining member. The decisive fact (user-supplied, cache-verified): model-scoped weekly caps like Fable are **components of the same 7-day window** — identical `resetsAt` — so each account has exactly one weekly deadline and per-account EDF is optimal. The 5h bucket is excluded from ranking (it's a burst limiter refilling ~33×/week — otherwise every account's "soonest reset" is always its 5h and the sort is noise) but stays in the <5% usability gate. Same deadline → more remaining first (equal expiry ⇒ order can't change utilization; fewer switches); accounts with a known deadline outrank unknown-data ones; a fresh-after-reset account (next deadline unknowable from a stale cache) ranks last. **Hot pools additionally switch proactively** toward a strictly-sooner deadline (≥1h margin, never onto unknown data) before exhaustion — hot re-points are free; cold pools keep exhaustion-only switching (each switch restarts conversations). Zero API calls, as before. 26-assert suite: scripts/test-pool-auto.mjs.

## 2.258.0

- **Billing-switcher menu redesign** (real report: "太丑/空白很多/布局不稳定"): the per-account usage preview was one flat inline string (`name — 5h 11% · 7d …`) in an auto-width menu, so rows wrapped at arbitrary points and every row had a different shape. Rows are now a **stable two-column layout** — account name left (ellipsized, dim suffix like `· API`), a **nowrap usage cluster right-aligned into one column** (dim `5h/7d/Fa` unit labels + colored tabular-numeral percentages + dim data age) — and the menu pins to a stable width the moment any row carries usage (`:has()`, so the open-time clamp measures the final box). Screenshot-verified against every row shape (long name, scoped bucket + age, missing usage, API row, ✓ current): scripts/dbg-billing-menu-shot.mjs.

## 2.257.1

- **Add-subscription click did nothing** (inc-mslfbdjv, real report — introduced by the 2.255.0 inc-msl890ua fix): the roster-refresh call added to `_addSubscription` referenced the Agents-dialog's scope-local `refresh` from a standalone method — the ReferenceError killed the flow **before** the login terminal opened, so the click was a silent no-op (the account record was still created server-side, which is why a pending row appeared after reopening). The method now has its own refresh (via the `_agentsRefreshHook`), and the agents-overview smoke drives the REAL flow (method → name dialog → confirm → asserts a terminal window opens + zero JS errors; negative-control-verified: the un-fixed code fails both asserts exactly like the incident).

## 2.257.0

Lock-badge restyle + model-lock semantics v2 + pool members dialog + UI scale/font size (user batch):

- **Locked-model badge restyle** (real report — the colors were off): the orange emoji lock clashed with the accent pill, and the locked text color was an accent-on-accent washout. The lock is now an **SVG in currentColor** (matches the pill's dark text; same fix in the dropdown items), and the badge keeps the base pill colors. Screenshot-verified.
- **Model lock semantics corrected (v2, per user)**: locking does **NOT disable fallback** anymore. A safety-reroute still completes the flagged turn on the fallback model — but at every **turn end** the server re-pins the locked model via `set_model`, so each subsequent message **re-attempts the original model** instead of staying degraded forever (`switchModelsOnFlag` switches the session's model persistently on a reroute; the lock undoes it per turn). The visible trace is the CLI's own "Set model to …" echo in the chat; the badge shows the lock + the amber ⚠ served model while degraded. The locked **target** persists (`meta.lockedModel` + session config) and re-arms on resume; changing the model while locked re-targets the lock; the global `claude.disableModelFallback` setting is fully independent again.
- **Pool members dialog** (user request): the pooled account's ⋯ menu gains **Members…** — a small dialog with a checkbox per subscription plus an **"All subscriptions"** option that means *all current AND future* accounts (the store's dynamic default), not a snapshot. An explicit selection is a fixed narrowed set; picking none is refused (the store would silently treat it as All); narrowing away the current target re-points server-side.
- **UI scale (DPI) + UI font size** (user request): two new per-DEVICE rows in the ⚙ quick settings (like the language — a phone and a 4K desktop want different values, so they live in localStorage, never the synced store; included in config export). **UI scale** (80–130%) = whole-app zoom — `#main-wrapper` compensates (`100dvh / --ui-scale`), terminals refit + clear their atlas on change (100% keeps them sharpest), and **every drag handler divides pointer deltas by the zoom** (window drag/resize, tab drags, resizers, toolbar/taskbar handles — uncompensated, windows outran the cursor by the zoom factor; CDP-verified a 150,90 drag lands 1:1 at 125%). **UI font size** (85–140%) = text-only multiplier on chrome labels — desktop-preview names (the user's example), taskbar item titles, sidebar cards/folder headers, window titles, menus — via `--ui-font-scale` on curated font-size rules. Both vars ride the theme sweep exemption (`LAYOUT_VARS` — the 2.254.0 lesson, re-caught by the smoke). 15-assert CDP smoke + screenshots: scripts/test-ui-scale.mjs.
- **Adversarial-review hardening** (two reviewers, 18 findings — all fixed & re-verified before ship): the DPI sweep's two blind spots were the **proportional-bounds engine** (snap/grid presets/layout restore mixed viewport px into layout px — windows hung off-screen at 125% and captured fractions ÷zoom poisoned layouts.json for every client; all geometry now uses workspace offset dims) and the **shared popover primitives** (menus/popovers/tooltips/toasts rendered at coordinate×zoom — unreachable past ~80% of the viewport; all six primitives + the right-anchored pattern now compensate, clamps compute in viewport space). Also: all `vh/vw` in the stylesheets divide by the scale (an 80vh dialog was 100% of the screen at 125%, clipping its buttons); the scale re-applies on window resize (768px mobile-boundary crossings); theme-editor/customize/explorer-column/PPTX drags compensated (column widths compounded ×zoomⁿ into localStorage). Model-lock hardening: served-model capture + the fallback-interrupt belt are **main-thread only** (a subagent's model both spuriously re-pinned and masked real reroutes); the lock **target travels explicitly** through resume (inferring it from the spawn model re-targeted to the global default); a target-less lock is refused (nothing to re-pin) with a server latch as belt; unlock now reaches other clients; bare-alias targets upgrade to the full id from the CLI's own resolution echo. Pool members: narrowing away the current target now mirrors an explicit switch (attribution re-record + cold restart of affected conversations + honest toast — it silently swapped billing mid-turn before); a selection with zero signed-in members is refused.

## 2.256.0

Per-conversation model lock + pooled usage accounting (user batch #4, #6):

- **Lock a conversation to its model** (user request, and the fix for the "总是变成 opus 4.8" report): the model badge's dropdown gains a **🔒 Lock to this model / 🔓 Unlock** toggle. Locking DISABLES model fallback for that one session — so when a safety-classifier reroute would silently swap the served model (Fable 5 → an older opus is an Anthropic *server-side* decision, not ours), the CLI surfaces the refusal instead of quietly switching. Locked shows a lock glyph + amber-free `LOCKED (fallback off)` on the badge. The lock **persists** across resume and server restart (session config whitelist + `meta.modelLocked`) and re-arms at spawn (`switchModelsOnFlag:false` merged into the one `--settings` flag). Codex sessions ignore it (no fallback mechanism).
- **Pooled accounts are now accounted for in Usage** (user #4): every request billed *through* a pooled pseudo-account is tagged with the pool id — while still attributed to the pool's REAL target account. So the per-account breakdown and the global total stay exactly correct with **no double-counting**, and a new **"By pool"** breakdown (classic view) + **Pool** dashboard dimension show the total that flowed through each pool. Attribution is by-time (a re-point moves subsequent requests), the pool tag is baked at scan for both Claude and Codex transcripts, and the section is hidden when no pool has been used.
- **Adversarial-review hardening** (two reviewers, before ship — all findings fixed & re-verified): (1) the **pivot loop** now carries the same sparse-pool skip as the 1-D dim loop — putting `pool` on a dashboard split-series/pivot axis no longer fabricates a phantom `null` series aggregating all non-pooled spend (confirmed: a `day:pool` / `pool:account` pivot excludes the big non-pooled event, through-pool total stays exact). (2) An unresolvable pool target now falls to **global**, never surfaces the pool pseudo-account as a spender in the account dimension. (3) The **model lock survives a server restart after resume** — the create-time session-meta write now persists `modelLocked` (it was written only by the live toggle, so a resumed lock's badge silently reverted on restart). (4) The lock toggle is **hidden for Codex** (no fallback mechanism there — it was a silent no-op that implied protection) and no longer re-issues a redundant `set-model` echo on every lock. (5) The global `claude.disableModelFallback` toggle now **exempts per-session-locked sessions** when it re-enables fallback (a global off→on flip used to silently defeat a deliberate per-conversation lock).

## 2.255.0

Account display + add-flow fixes (user batch):

- **Pooled account no longer masquerades as an API key** (real report): `sessionAuth` had no pooled branch, so a pooled pseudo-account fell through to the API-key display. It now renders a distinct **pool chip** — title-bar badge + chat status chip — naming the pool AND the real account it currently bills (inline when there's room, always in the tooltip), and the badge re-renders when the pool switches its target.
- **Add-account now updates the page immediately** (inc-msl890ua): adding a subscription — even one you never finish logging into — left Manage Agents unchanged until a manual reopen. The `accounts-updated` broadcast now live-re-renders an open Agents surface, and the add flow refreshes the roster the moment the (pending) account is created.
- **Add a subscription straight as a long-lived token** (user request "why can oat only be added to an existing account"): the + Add account menu gains "Add subscription via long-lived token…" — it creates the record and opens the mint dialog directly (no local login step; the setup-token browser flow decides the account), cleaning up the throwaway record if you cancel without pasting a token.

## 2.254.0

**Toolbar resize reworked into content scaling (userW's `inc-mskxi7zk-mbm6` + the 2-row dead-band report — direction A, user-picked):**

- The toolbar no longer has a resizable fixed height. Its height **auto-fits its content rows** (including a populated `#toolbar-row2`), so there is **never a dead empty band** — the old model stretched only row 1, leaving a large gap on 2-row arrangements.
- The drag handle now drives **content scale** (`--toolbar-scale`, a zoom on `#toolbar` + `#toolbar-row2`, range 0.7–1.25): drag **up = more compact = a visibly larger desktop** (both rows shrink; the workspace absorbs every pixel — measured 565/539/517px workspace across 0.7/1/1.25), drag down = larger chrome. Double-click still resets.
- Migration: a previously saved fixed height (localStorage or synced layout state) converts to the equivalent scale (`height/40`) automatically; old clients in a mixed-version fleet degrade benignly (they ignore the new field).
- Multi-client: the scale rides layout-sync pre-desktop-gate (the 2.252.2 invariant), and an explicit **reset now propagates** (a `null` in the state used to be skipped, leaving other clients scaled forever).
- **Adversarial-review hardening** (before ship): a mixed-version fleet is safe both ways — the new captureState emits a companion legacy `toolbarHeight` (so an old-bundle client tracks + round-trips the size instead of re-echoing its fixed 40 and erasing everyone's scale), and the decode treats a legacy value at the old default (≈40) as no-information, never a reset. A reset (dblclick / drag-to-default) now propagates AND heals at boot: one `_applyToolbarState` decoder is used at every intake — remote sync, remote apply, restore, and a new boot-path heal in loadAutoSave — so a stale localStorage can't resurrect an erased scale on a client that boots later. Spring "Match…" width-pick divides out the toolbar zoom before storing (a matched spring no longer renders scale²-wrong). Handle tooltip is i18n'd; package-lock synced.
- Verified with screenshots at 0.7/1/1.25 on the reporter's real 2-row arrangement + an 18-assert CDP smoke (drag/persist/reload/theme-switch/cross-desktop/legacy-migrate/legacy-default-no-erase/companion-field/clamp/reset-propagation/**boot-divergence via real server round-trip**/no-dead-band).

## 2.253.1

Long-lived-token follow-up — honest framing + real end-to-end verification:

- **Framing corrected (was overstated).** The mint dialog now says the plain truth: a long-lived token is Anthropic's OFFICIAL mechanism (`claude setup-token`, the same one the Claude Code GitHub Action uses) for running YOUR subscription on YOUR remote/CI machines — cross-machine use is by design and safer than shipping the interactive login — but it still bills and is tied to your subscription, and Anthropic recommends an API key when a credential is shared broadly across many contexts. Not "zero-risk anywhere." (Confirmed against code.claude.com/docs/en/github-actions.)
- **Live end-to-end test on real subscriptions** — scripts/dbg-oat-pool-live.mjs (throwaway server, REAL logged-in Max subscriptions, REAL inference turns; 21 asserts, all green): real claude runs THROUGH the pool symlink; a target switch is picked up by a fresh spawn; a normal session and a pooled session on one account resolve to the SAME real credential dir (the shared `.oauth_refresh.lock` invariant, verified with live `/proc`); an oat-only account completes a real turn via the env token; the ambient `CLAUDE_CODE_OAUTH_TOKEN` is stripped from a normal spawn (`/proc`-verified — no silent re-billing). Safety: it only copies subscriptions whose token has >1.5h of life so a short test can never trigger a refresh that would rotate the real single-use token; it never restarts the production instance and only reads its creds.

## 2.253.0

**Long-lived tokens (B-211a)** — a Claude subscription can now hold a `claude setup-token` token (1 year, no refresh, inference-only; mechanism verified against the 2.1.225 binary):

- **What it buys**: the account becomes usable on ANY machine — ssh hosts AND paired devices — WITHOUT shipping its login. The token rides the same 0600-file + `$(cat …)` secret channel API keys use, as `CLAUDE_CODE_OAUTH_TOKEN`; nothing rotates, so local/remote can never diverge and the remote makes zero login traffic (the creds-dir tar dance is bypassed for oat accounts). An account with NO local login but an oat also spawns locally via the env token (macOS keychain bypassed).
- **Where it ranks**: host-held login > email-linked > long-lived token > full-login shipping (evaluateOnHost; the verdict flows to every surface). Locally, a dir login stays authoritative (hot-swap/pooling intact) — the oat only takes over where the login can't go.
- **UI**: Manage agents → account ⋯ → "Long-lived token…" — guided mint dialog (opens a `claude setup-token` terminal; the BROWSER login decides the account, the dialog says so; paste `sk-ant-oat01-…` back). Row tags: `· long-lived token` (amber under 30 days, red when expired); host views say `· via long-lived token`; New Session + billing switcher offer oat accounts with the same labels.
- **Honesty**: an EXPIRED token refuses at create with re-mint guidance (a long-lived 401 has no self-heal); boot notice at ≤21 days; quota ⟳ can't work through an oat (inference-only scope) — passive usage capture is unaffected.
- **Safety**: token AES-GCM-encrypted at rest; `CLAUDE_CODE_OAUTH_TOKEN` has TOP precedence in the CLI, so ambient copies are stripped from every spawned session env (`AGENT_ENV_DROP` + the local spawn env strip).
- **Adversarial-review hardening** (17-finding pass, all confirmed items fixed): mint-terminal now closes the dialog first (it opened unclickable BEHIND the modal overlay); `billing.how` gained an `oat` rung (remote oat spawns mis-stamped as `ship` — reporting the exact action the feature avoids); a host-HELD account that gains an oat keeps host-held precedence at spawn (the oat shortcut used to skip the held-dir probe AND the identity-mismatch refusal); Backup & migrate now carries the token (oat-only accounts imported as dead records) and account-merge keeps it; an EXPIRED token is un-usable in every verdict with its own `oat-expired` reason (before: the switcher offered it → killed the session → create refused → window gone; a DEFAULT account silently flipped billing to the host login the day it expired), while a locally-logged-in account with an expired remote-only oat is no longer hard-blocked locally; host-held dial spawns no longer fail hard on degradable tool-setup errors just because the account also has an oat; the expiry sweep re-runs every 6h (was one-shot); Remove-token surfaces real failures; ⋯ → Test accepts oat-only accounts; Session Properties' on-resume select stops blanket-blocking oat accounts; removing a token also sweeps its 0600 working copies off hosts.
- Tests: scripts/test-account-verdicts.mjs grew to 37 asserts (oat matrix: local/ssh/dial usability, held/linked precedence, spawn shapes, encryption at rest, expiry refusal + expired-verdict reasons).

## 2.252.2

Toolbar-resize follow-up (adversarial review of 2.252.1 found one residual snap-back route + hardening):

- **Cross-desktop stale re-broadcast**: bar heights are GLOBAL chrome but ride PER-DESKTOP layout-sync states — a client viewing ANOTHER desktop only cached the broadcast without applying it, kept rendering the old height, and its next desktop switch captured + broadcast that stale size back, erasing the resize (and its localStorage) on every client. `_handleRemoteSync` now applies `toolbarHeight`/`taskbarHeight` BEFORE the per-desktop gate (fixes the same aged hole for the taskbar too).
- `_applyToolbarHeight` clamps to the drag range 28–96 (a corrupt/foreign state can no longer render 500px or persist it) and no-ops on unchanged values (no storage churn/reflow per echo — symmetry with the taskbar twin).
- `cssVarDefault` preserves a var's `important` priority through its lift-measure-restore round-trip.
- Smoke grew to 12 asserts (non-active-desktop broadcast applies; absurd height clamps).

## 2.252.1

Toolbar resize snapped back to the default (2.250.1 regression, user report) — THREE cooperating legs, all fixed:

- **Mouseup self-comparison**: the drag-end "within 2px of the CSS default ⇒ reset" check read the COMPUTED `--toolbar-height` as the default — but the drag itself sets that very var, so the check compared the dragged height against itself and reset on every release. Same flaw in `_applyToolbarHeight` (restore / layout-sync re-apply of the saved height read as "at default" and cleared it). Both now measure the TRUE stylesheet default via `cssVarDefault()` (utils.js — temporarily lifts the root inline override, reads computed, restores).
- **Theme sweep wipe**: `ThemeManager.apply()` → `_clearInlineOverrides()` removed EVERY inline `--*` var on :root (built for custom-theme preview leftovers) — killing the height override at boot (right after the localStorage restore applied it) and on every theme switch. Layout vars are now exempt from the theme cleanup sweep.
- Smoke: scripts/test-toolbar-resize.mjs (worktree + CDP, 10 asserts — real mouse-event drag sticks after mouseup, survives reload and a theme switch, same-value re-apply is a no-op, dblclick/drag-to-default reset semantics intact).

## 2.252.0

Pooled pseudo-account v2 (B-6217 complete): the `auto` and `hot` switches, per the user's spec.

- **Auto-switch** (⋯ → "Auto-switch when nearly exhausted"): at each claude turn end, if the pool's current target has **under 5% remaining** — taking the MINIMUM across every known bucket (5h, 7d, and each model-scoped weekly like Fable) — the pool re-points to the member with the MOST remaining by the same measure. Decisions read ONLY the passive usage cache (`data/usage-cache/*.json`) — **zero API calls** in this path, §ban-safety intact. A bucket whose reset already passed reads as full (stale readings are normal — the cache updates passively); a member with no data ranks as half-full (wrong guesses self-correct next turn end); an unknown CURRENT target never triggers a switch (no flapping on ignorance). 60s minimum between switches per pool.
- **Hot switch** (⋯ → "Hot switch (no restart)"): switches — manual or auto — only re-point the symlink; the running CLI re-reads the credential file on its next request (mtime-gated, verified against 2.1.222) and the conversation continues uninterrupted on the new account. The cswap outcome via a first-party mechanism: no request interception, no token copying.
- Auto + cold: the server re-points, re-records the ledger's by-time attribution for every live session on the pool, and asks exactly ONE connected client to cold-restart the affected conversations (all clients acting would race duplicate resumes). Headless instances degrade to hot behavior until a client appears — the switch itself never waits on a browser.
- Known seam: a hot re-point leaves a terminal session's statusline attribution env (`VIBESPACE_ACCOUNT_KEY`) on the old target until that session restarts; the ledger is correct either way (attribution re-recorded server-side at switch time).
- Tests: scripts/test-pool-auto.mjs (14, decision logic incl. reset-passed/unknown/min-across rules) + a live engine smoke (2%-left target auto-switched); pool/verdict suites still green.

## 2.251.0

Pooled pseudo-account v1 (B-6217, the user's directory-symlink design). A "pooled" account is one switchable billing identity over your logged-in Claude subscriptions: its creds dir at `data/subs/<poolId>` is a DIRECTORY SYMLINK to the current target's dir, and switching = atomically re-pointing it (symlink-to-temp + rename, then `utimes` on the target so the CLI's mtime-gated credential cache invalidates). Why this exact shape (proven in `scripts/test-creds-symlink-swap.mjs`, 8 asserts): the CLI writes credentials via atomicWrite (tmp+rename) which REPLACES a file-level symlink but leaves a directory-level one intact — so refreshes land in the canonical account dir (ONE credential copy ⇒ Anthropic's rotating refresh token keeps exactly one holder), and `.oauth_refresh.lock` resolves through the symlink to the SAME real lock a normal session of that account takes, so pooled and normal sessions of one account are mutually excluded exactly like two normal sessions — zero new refresh conflict.

- Manage Agents → + Add account… → "Add pooled account…" (needs ≥1 logged-in subscription); the row shows `→ current target · email`; ⋯ → Switch target lists members.
- Switching target COLD-RESTARTS every conversation currently billed to the pool (kill → exited → resume, the billing-switcher machinery) — mandatory, because a running claude re-reads the credential file mid-session and would otherwise silently start billing the new account.
- Members default to ALL logged-in Claude subscriptions; narrowing the member list away from the current target re-points to a remaining member. Deleting a pool unlinks ONLY the symlink (never a real account's dir; `rmSync` on a symlinked dir throws — probed, which is why remove() uses `unlinkSync`).
- Attribution: the passive-usage statusline key and the ledger's by-time attribution both resolve pool → its real target, so quota donuts and the Usage window bill the actual account, never the pool id.
- Linux-only (macOS keychains key on the env STRING, not the resolved path — different symlink paths would get separate entries); pools never ship to remote hosts (`pool-local-only` verdict; billing switcher + New Session render the honest reason).
- Store fields `auto`/`hot` exist but have no UI yet — v2 (auto-switch at turn end when the target drops under 5% remaining across 5h/weekly/scoped, hot re-point without restart) comes next.
- Tests: scripts/test-account-pool.mjs (16) + test-creds-symlink-swap.mjs (8); test-account-verdicts.mjs still green (17).

## 2.250.1

- **Right-clicking a desktop preview that was moved into the top bar showed the wrong menu** (user report with screenshot; 2.250.0 fixed a different, real-but-unrelated issue — the menu *direction* — and left this one). Chrome elements are drag-movable between the bars, but the toolbar's background context-menu handler only exempted `button, select, input` while the taskbar's exempted `.desktop-preview` — so once the previews were dragged up into the toolbar, its "Customize UI…" menu fired too and, because `showContextMenu` removes any existing menu, *replaced* the desktop's Rename/Delete. Fixed at both ends: the preview now stops the event (so it works in whichever bar it was dragged into, without depending on each container's exemption list staying in sync), and the toolbar exempts the same element classes the taskbar does.
- **The top bar can be resized** (user request): drag its bottom edge, double-click to reset; the height persists and syncs to other clients like the taskbar's. It drives the `--toolbar-height` CSS variable rather than an inline height, so every dependent measurement follows for free — the workspace is `flex: 1` and absorbs the delta, and windows re-derive their pixels from proportional bounds. Test: scripts/test-desktop-reorder.mjs (8 CDP assertions incl. the toolbar-menu regression).

## 2.250.0

- **Resume-all after a restart** (user request — clicking Resume on each of dozens of windows was tedious): when the server or a machine restarts, sessions come back as read-only history windows; on the first load after that, a single popup now offers "Resume all N" and bulk-resumes them (staggered). Only offered when ≥2 sessions were interrupted, only on the boot restore (not on desktop switches or soft reconnects).
- **Drag a desktop preview to reorder desktops** (user request): the taskbar desktop previews are now draggable — drop one onto another to reorder; the new order persists and syncs to other clients (server reconciles the id order against its stored set so a stale client can't drop or invent a desktop). Dropping a *window* onto a preview still moves the window, as before.
- **Desktop right-click menu opens the correct direction at a top-docked taskbar** (user report): the menu was unconditionally bottom-anchored, so with the taskbar moved to the top the previews sit near the viewport top and the menu grew straight off the top edge. It now anchors based on which half of the screen the click is in.
- **Window blink + find-flash now show in the Stage desktop preview** (user report): the Stage preview render didn't apply the waiting/flash classes its window rects — only the normal-desktop loop did — so a session finishing (or a find-flash) on a staged window was invisible in its preview. Test: scripts/test-desktop-reorder.mjs (5 CDP assertions).

## 2.249.1

- **Ctrl+K could not find a session by a multi-word name, and silently showed the wrong one** (userW, inc-msjro90z-n6y3: searching "best ever" returned only `BestEver-Vendor-Agreement-Sign`, never the `BestEver-ToB-signing` he wanted). Three faults compounded: the query was matched as ONE literal string, so a space could never substring-hit a CamelCase/hyphenated name; that pushed every multi-word query into a subsequence scan over the WHOLE haystack — name + cwd + three UUIDs — where a shared path prefix supplies almost any letter sequence, so unrelated sessions tied at the same low score; and the `+1000` live bonus then sorted every live session above every stopped one, with only 12 rows kept — so the stopped session he wanted was cut off the list entirely. Now the query is tokenised on whitespace with AND semantics (every token must hit), name matches outrank path/id matches, the fuzzy fallback is confined to the name instead of UUID noise, and live is a tiebreak among equally-good matches rather than a reason to bury a better-named stopped session. Searching by cwd fragment or session id still works. Test: scripts/test-session-palette-search.mjs (11 assertions on his real session data).

## 2.249.0

- **Merging duplicate subscription accounts can no longer silently re-bill a running session** (B-3f8a, from the claude-swap credential study): `accounts.mergeSubscription` copied the survivor's `.credentials.json` and deleted the merged-away dir with no check for live sessions — and the CLI re-reads that file per HTTP request (verified against 2.1.222), so the copy would flip a running session's billing MID-TURN and the delete would yank credentials out from under the other side's sessions. Both merge call sites now pass the set of account ids with a running session; the merge refuses loudly (kept both records) instead of corrupting billing.
- **Session discovery no longer forks `ps` per lock file** (B-2104, closes the 2.242.0 event-loop-stall class at its source): the claude session lock carries `procStart` (= `/proc/<pid>/stat` field 22, verified byte-equal on 6/6 real locks), so identity-verifying an alive pid is now a pure file read; the `ps` fork only runs as the fallback when `procStart` is absent (macOS, which writes a different field — an absent value is never a silent always-true guard).
- **Quota plumbing gains two zero-poll fields** (B-87fe): `src/lib/usage-pace.js` (pure, no I/O) tells whether a weekly bucket is running AHEAD of a linear burn — ported from claude-swap's pace logic with its hard-won guards kept (weekly-only, 24h post-reset suppression, projection stays diagnostic-only) plus a stale-snapshot guard for our on-demand caches; and `extra_usage` (subscription spend/credits) is now parsed off the on-demand refresh and preserved across passive statusline writes like `scopedWeekly`. Both ride the existing quota response — no new Anthropic calls. Tests: scripts/test-usage-pace.mjs.

## 2.248.0

- **An ssh machine can graduate to dial-out** (B-6640): one click installs the VibeSpace daemon as a persistent service on the machine, and from then on it *dials back* to this instance over a WebSocket — our own handshake timeout, heartbeat, reconnect and backpressure — instead of every operation spawning an ssh child. That removes the three structural ssh taxes behind this week's incidents: a banner/kex hang that `ConnectTimeout` doesn't bound (it only covers the TCP connect), a ControlMaster whose established flow survives a route change so health checks read green while every new connection fails, and per-op child processes with their PATH/EPIPE hazards. **ssh is kept, not replaced** — it remains the bootstrap and rescue channel, and every data-plane path still falls back to it the moment the dial link isn't live, so a graduated machine is never worse off than before.
- NAT-aware by construction: the base URL comes from an explicit `serverUrl`, else `agentd.publicUrl`, else the frp relay (`viaRelay`, the same bridge device pairing uses when both sides are behind NAT). Before anything is installed, the **machine itself** is asked whether it can reach that URL — if it can't, graduation aborts and the machine stays pure-ssh rather than silently ending up with a daemon that can never dial in. Removal tears the service and its root down on the machine and always clears the record locally, so a dead machine can't hold the upgrade hostage.
- Verified end to end against a real ssh host (`scripts/test-graduate-dial.mjs`, 10 assertions): graduate → daemon dials in → file ops ride the dial link → remove → plain ssh machine again, with ssh working before and after.

## 2.247.4

- **Card-click flash now actually flashes the desktop preview** (userW's report): `flashWindow`'s cross-desktop branch paints the flash through `_renderSwitcher()`, whose render digest didn't include `_flashingWinId` — a mere click changes nothing else, so the digest matched, the render early-returned, and the preview rect never flashed (the third strike of the 2.151.0 "digest must cover every render input" class). The window sitting on another desktop is exactly the case where the preview flash is the only visible feedback.

## 2.247.3

- **The adopt probe now actually finds surviving claudes** (findKeeperFor rewrite): the ssh leg scanned only the legacy `~/.vibespace/run` store — it never saw agentd pipe sessions at all — and both legs matched by grepping the conversation id in the state json, which only works for RESUMED spawns (the `--resume` arg embeds the id); a fresh-spawned claude's conversation id lives only in its own lock file. One unified scan now covers both stores plus the childPid→`~/.claude/sessions/<pid>.json` lock leg, and returns `{sid, kind}` so the consumer routes the adopt into the right attach transport (agentd attach-cli vs legacy keeper) instead of a binary that has never heard of the sid.

## 2.247.2

- **Explicit-host ssh resumes now adopt a surviving claude too** (the B-218d completion): the dial branch has always probed the device's pipe-session store before resuming; the ssh branch only did so on host-INFERENCE (host-less) resumes — so a plain sidebar resume with the host selected always swept and respawned, killing a healthy surviving claude that one attach-pipe-session away. The ssh branch now runs the same probe first; a hit skips the writer sweep and adopts losslessly.

## 2.247.1

- **B-218d: adopting a surviving remote claude over ssh finally works.** `findKeeperFor` returns agentd pipe-session sids (it scans `~/.vibespace/*/state/sessions`), but the ssh resume branch fed them to the legacy `vibespace-remote-keeper run` — a binary that only knows `~/.vibespace/run` and could never find them, so the "attach instead of spawning a second writer" optimization (2.218.0) silently never worked for modern ssh sessions; every such resume degraded to sweep+respawn, killing the surviving claude (and its in-flight work) that could have been adopted losslessly. Server-derived sids are now tagged `keeperKind: 'agentd'` and the ssh branch adopts them through the attach-cli with a no-spawn-spec config — the exact attach-pipe-session contract the dial branch has used all along. Legacy keeper sids (client-side discovery) keep the old path; provisioning failure degrades to the previous behavior.

## 2.247.0

- **B-fa6f: every read-only/interactive data-plane surface now fails fast on a flapping device link** (the userN incident class, finished): `hosts.deviceBounded(id, connectMs)` — a hard deadline over the device connect ladder (which runs up to ~2.7 minutes) — now guards ~26 call sites: file explorer ops, directory autocomplete, host probes, transcript slab sync, usage harvest, mount setup/heal/restore, port scans/forwards, exit-proxy connections. Each falls through to its ssh fallback or errors honestly in seconds instead of hanging the surface for minutes. Session-ESTABLISHING paths (spawn, adopt-vs-respawn `findKeeperFor`, account verdicts, cwd defaults) deliberately keep the full ladder or get generous 15s bounds — an adversarial 3-lens review confirmed and reverted three sites the first pass had over-bounded (a tight bound there flipped healthy keeper-adopts into kill+respawn and failed slow-but-valid creates). Two crash/latency bugs found on the way: the race's abandoned loser promise was an unhandledRejection (crashes modern Node) — now observed; and every timed-out probe used to stack ANOTHER full connect ladder (fresh ssh spawns ×13) — `device()` now dedupes concurrent connects per host.

## 2.246.2

- **Remote discovery no longer hangs for minutes on a flapping link** (userN's "scan不出来东西"): the sidebar's Recent/History scan prefers the device data-plane, and `device(id)` runs its connect retry ladder to the end — up to ~2.7 minutes — before discovery could reach its own fallbacks (legacy ssh script, then the last-known stale cache). On a lossy path where TCP opens but the ssh banner hangs (`ConnectTimeout` only bounds the TCP connect — verified live), the sidebar sat on "Scanning sessions over ssh…" the whole time while 85 cached sessions were one throw away. The device path now gets a hard deadline (6s connect / 12s snapshot) and falls through; the background connect keeps retrying so a later success still heals the link.

## 2.246.1

- **The chart can pin a workspace against preemption** (`priorityClassName`, empty by default): on a shared cluster that also runs batch/CI, a VibeSpace pod at the default priority 0 is the FIRST thing the scheduler evicts when capacity gets tight — and an interactive workspace that dies mid-session takes the user's live terminal state with it (two instances lost their containers in one day). Set it to a class that outranks those workloads; a class with `preemptionPolicy: Never` is the right shape — it wins a slot without evicting anybody else.

## 2.246.0

- **SSH keys WITH a passphrase can finally be imported** (Remote → Add machine → "Paste or upload my own key…"). Two things were broken: the encryption check was a regex for the word `ENCRYPTED` in the first 3 lines, but a modern `openssh-key-v1` key's armor is **byte-identical** whether or not it has a passphrase (the state lives in the decoded body's `ciphername`/`kdfname`) — so effectively every key ssh-keygen has produced since OpenSSH 7.8 sailed through the check, got stored still-encrypted, and then failed at connect time with a bare `Permission denied (publickey)` that never mentions a passphrase at any `-v` level. And there was no way to supply one anyway. Now: a real decoder (`src/ssh-key-format.js`, shared verbatim by server and browser) classifies openssh-v1 / PKCS#8 / classic PEM / ppk / ssh.com, the dialog reveals a passphrase field when the key needs one, and the server unlocks it once at import via `ssh-keygen -p`.
- **Wrong passphrase is a retry, not a dead end**: the failing request re-opens the key dialog with your key still pasted, the passphrase field revealed and focused, and the reason shown — instead of dropping the whole Add-machine flow. Detection is an affordance only and NEVER blocks submit (a "Key has a passphrase?" toggle is always reachable, so a misjudged format can't become a wall); the server is authoritative and returns a stable error `code` that the client renders in your language.
- **Honest failures, no lookalikes**: `.ppk` and ssh.com keys are refused with the exact conversion command; a truncated paste says "copy the whole file including BEGIN and END". Critically, an askpass helper that can't be exec'd (noexec `/tmp`) makes ssh-keygen report *"incorrect passphrase supplied"* for a perfectly correct passphrase — that case is detected by its `ssh_askpass:` stderr marker and reported as "could not unlock the key on this server" with the local one-liner, never as a wrong passphrase. Missing `ssh-keygen` gets its own message.
- **Where the passphrase goes**: into the `ssh-keygen` child's environment (via a throwaway 0700 askpass helper in a 0700 `mkdtemp` dir) for one exec, then discarded. Never in argv (`/proc/<pid>/cmdline` is world-readable — the 2.126.0 rule), never on disk, never logged, never in the host record. `HOME` is pointed at the temp dir so ssh-keygen can't touch the server's real `~/.ssh`, and the temp dir is removed on every path including throws. **Disclosed plainly in the docs: the STORED key is unlocked** — this removes the passphrase, it does not preserve it. ssh here is always `BatchMode=yes` and can never prompt.
- Fixed alongside: `hosts.add()` checked the duplicate-name collision AFTER writing `data/ssh/<id>.key`, orphaning a key file no record referenced; a passphrase-protected key inside a config-transfer bundle is now skipped with the reason surfaced in the import result (it used to be written and silently produce a host that only failed at connect time); and an error thrown after any Add-machine sub-dialog opened rendered into a detached element (the shared overlay id removes the parent dialog) — those now surface as a toast instead of vanishing.
- Tests: `scripts/test-ssh-key.mjs` (60 asserts — real ed25519/RSA/PEM/PKCS#8 keys, trailing-space passphrase, wrong-passphrase leaves no file, temp-dir hygiene, stubbed askpass/missing-keygen branches, `hosts.add()` + `importBundle`) and `scripts/test-ssh-key-dialog.mjs` (24 asserts, real headless browser — it caught the submit path resolving `null` exactly like Cancel, because `createModalShell`'s `close()` fires `onClose` on every path and the cancel-resolver won the race; the whole paste-a-key flow was dead and no unit or HTTP test could see it).


- **Pairing a device needs NOTHING installed on it — not even Node.** "Install Node ≥18 first" was the biggest thing standing between a laptop and a paired device, so the installer now provisions its own: if the machine has no usable node, it downloads the pinned official build from `nodejs.org/dist`, **verifies it against that release's `SHASUMS256.txt`**, smoke-runs it, and only then moves it into place at `<root>/node`. No root, no system packages, no PATH changes outside the installer — and `rm -rf ~/.vibespace/device@<instance>` still removes everything, runtime included. Both installers (bash + PowerShell).
- **It also stops falsely claiming you have no Node.** `curl … | bash` runs a **non-login, non-interactive** shell, so `~/.bashrc`/`nvm.sh` are never sourced and an nvm-managed node is invisible to `PATH` — the most common "but I have node installed" report. Resolution order is now `--node` override → our own private copy → `PATH` → **newest nvm** → the usual absolute paths → provision. Our copy sits ahead of `PATH` on purpose: the launchd/systemd unit bakes in an absolute interpreter path, and an nvm path breaks at the user's next nvm upgrade.
- **This also fixes the agent tools on a node-free device** (the 2.244.x chicken-and-egg, structurally): the daemon puts its own node dir on every child's `PATH`, so `vibespace-status` / `vibespace-task` / `vibespace-ask` and the claude hook — all `#!/usr/bin/env node` — resolve on a machine that never had node. Verified in a node-free sandbox: the tool dies with `env: 'node': Permission denied` on a bare PATH and runs normally under the daemon's.
- **Honest refusals instead of cryptic breakage**: a musl machine (Alpine/OpenWrt) is told official builds are glibc-only, with both fixes (`apk add nodejs npm`, or the unofficial `-musl` mirror); 32-bit Windows and unknown CPUs say so; a checksum mismatch, an unlisted tarball, or a machine with no `sha256sum`/`shasum`/`openssl` **refuses to install an unverified runtime** (escape hatch `VIBESPACE_NODE_SKIP_VERIFY=1`, loudly announced). Nothing is committed until the download is verified AND smoke-run, so a failed install leaves no half-extracted `node/` and no temp leftovers. `--node-only` resolves/prints the interpreter and exits — the first probe to run when a pairing misbehaves.
- **Devices that can't reach nodejs.org** (corporate egress, CN) retry through the VibeSpace instance itself: `GET /vibespace-node/<version>/<file>`, a read-only disk-cached mirror with a fixed upstream and a strict version+filename allowlist (never a general proxy), auth-exempt because the device has no cookie yet. `VIBESPACE_NODE_MIRROR` points at any other mirror.
- **Windows devices survive a reboot**: the PowerShell installer now persists `state\dial.json` like the bash one and registers a logon scheduled task (best-effort, argless — no token in any task XML), plus TLS 1.2 for PS 5.1 (whose default handshake nodejs.org refuses) and a fixed "log file" path in the closing message.
- **Relay-paired devices got an unreachable install command** (`_fillPairCommandBody`): the dial URL correctly used the public relay base while the installer and bundle URLs were built from `location.origin` — which is exactly the address a double-NAT device cannot reach. All URLs now come from the same `httpBase`.
- Tests: `scripts/test-node-bootstrap.mjs` (19 asserts — a local HTTP fixture stands in for nodejs.org and a `bwrap` sandbox hides every node on the machine: provisioning, checksum-mismatch and unlisted-tarball refusal with no leftovers, re-use without re-download, nvm discovery with a node-less `PATH`, newest-version selection, `--node` override). End-to-end proof on a sandboxed node-free machine: private Node installed and checksum-verified, node-pty built with its npm, daemon started and confirmed running under `<root>/node/bin/node`.

## 2.245.2

- **Roster donut column aligned again** (real screenshot on the machine overview; diagnosed with pixel measurements, not by eye): the donut cluster is right-anchored against the actions column, so any row whose `.acct-key-actions` differed in width shifted its cluster — the CLI-login row's star-only actions sat 26px narrower than the account rows' [★][⋯], and host rows' inline text buttons (⟳ / Log in on host… / Import its key) shifted theirs by 100px+. Fix: every row now carries the same [★][⋯] pair (host actions moved into the ⋯ menu, the 2.178.0 pattern; a CSS `min-width` evens out star-only rows), and the inline refresh error renders as ONE ellipsized line (full text in the tooltip) instead of exploding the row. Regression guard committed: `test-agents-overview.mjs` fabricates mixed-state rows (fresh + scoped bucket / stale + age / no data / inline error / CLI login) and asserts every visible cluster's right edge equal ±1px at panel widths ~460/340/260 plus equal donut sizes (measured spread: 26.0px before → 0.0px after; the ≤340px pill swap stays intact).
- **Billing switcher quota preview: scoped buckets + water-level colors**: the per-row usage hint now includes model-scoped weekly buckets (`Fa 41%`, same 2-char labels as the roster donuts) and colors every percentage by the donut scheme (>95 red / >80 amber / green). Mechanism: `showContextMenu` gained an OPT-IN `labelHtml` field (innerHTML rendering; callers MUST escHtml every interpolated string — enforced in the switcher, covered by a hostile-account-name smoke assert); rows without data and disabled rows keep working unchanged.

## 2.245.1

- **The billing switcher previews each account's quota inline**: every row in the switch-billing menu (title-bar badge / card menu) now appends `— 5h x% · 7d y% · age` from the same per-row source rule as the Agents overview (machine login → host quota cache, host-held → its own held-login cache, otherwise the local passive cache; age shown when the data is older than 5 minutes). Pick with your eyes open instead of switching first and checking quota after.

## 2.245.0

- **Manage Agents is now the machine-sectioned account+quota center**: the host selector is gone — the surface stacks "This machine" plus one section per configured host (`.usage-section-title` headers, sections fill in parallel so slow ssh probes don't serialize the view). Each host section shows the host's own CLI-login row (identity + quota + per-host ⟳) and ONLY the accounts the server says are usable there (B-f531 `verdicts`, usable=true — the client never computes linked/held; the local section stays the FULL roster, the management home for rename/remove/finish-login). Per-row usage follows the verdict: linked accounts show the host's own quota, host-held ones their own host-side snapshot, ship/local the passive cache. An unreachable host says "unreachable" honestly instead of "not installed" + Install buttons. Also fixed in passing: a latent `racct` ReferenceError silently killed the codex roster on every host view (swallowed by the caller's try/catch).
- **⟳ Refresh all**: one header button fans out a per-target on-demand quota refresh — each local subscription, each host's machine login, and each host-HELD account login (`POST /api/usage/refresh {host, account}`, new: the server reads the account's own `~/.vibespace/subs/<id>` token on the host, READ-ONLY, and persists to `usage-cache/host-<hid>-<aid>.json`; served as `/api/usage` `hostAccounts`). Strictly click-initiated (§ban-safety — never a timer; Anthropic calls staggered ~1.5s since the usage endpoint hard-429s on bursts), rows update independently as answers land, and failures render INLINE on their row — never silent.
- **Usage popup slimmed**: the bottom "Remote hosts" section moved into the machine overview; a "Full overview →" door at the popup's tail opens the Agents panel (rail when available, modal otherwise — and no longer collapses the sidebar when the Agents panel is already open).
- Smoke: `scripts/test-agents-overview.mjs` (worktree + headless-chrome CDP, 21 asserts incl. the boot-loader filename disambiguation, the dead-host honest path, and the inline refresh failure).

## 2.244.4

- **The hook fix could never apply itself — the fixer needed node too** (the chicken-and-egg behind "hook still says node: not found"): the remote prelude ran the hook REGISTER with a bare `node`, silently failing on hosts where node is nvm-managed (nvm never loads in the POSIX/dash spawn shell) — so 2.244.2's absolute-interpreter rewrite never executed, and every `#!/usr/bin/env node` agent tool was equally dead there. All four register invocation sites (ssh prelude, dial install, manual Install, Remove) now run a POSIX node finder (PATH → newest nvm install → common locations), EXPORT the found node's dir onto the session PATH (revives the agent tools and any old-format hook entries immediately), and run the register via the absolute path so entries self-heal. Verified live on the affected host: finder located the nvm node, the register ran, and the hook entries now carry the absolute interpreter.

## 2.244.3

- **"Never finished signing in" no longer slanders accounts that ARE signed in — elsewhere**: an account holding its login on one machine (ClaudeLu on Novita) showed "never finished signing in" in the billing menu of a session on a DIFFERENT machine (CW-H200) — the disable was correct (no login THERE), the message read as a broken account. `evaluateOnHost` now distinguishes `not-on-this-host` (logins exist on other machines — named in the message, with the two ways out) from `never-signed-in` (no login anywhere). Matrix test grows to 17 asserts.

## 2.244.2

- **Case closed on "Test shows the wrong account" — the billing was correct, the CLI's display was not** (verified forensically: the Test spawn refreshed the HELD dir's token two seconds after start — proof it authenticated as the held account — while the machine's own credential store sat untouched): claude reads its `/status` Organization/Email from the non-relocated `~/.claude.json`, so a host-held login shows the MACHINE's identity while the TOKEN (= what's billed) is the held account's. The Test now shows a banner saying exactly that before the user reads /status.
- **Agent hooks register with an ABSOLUTE node path** (userN's Novita: "SessionStart hook error — /bin/sh: 1: node: not found"): hooks run as claude children via /bin/sh with claude's PATH — hosts with nvm-style node installs (and claude as a native binary) have no `node` there. Both the remote register and the local registration now use the registering process's own `process.execPath`; existing entries self-heal at the next spawn/boot (the register updates a changed command in place).

## 2.244.1

- **Account rows say "logged in on Novita-H200", not "logged in on host-9835dc80"**: the roster resolved host display names through the sidebar's hosts cache, which is empty until the Remote tab loads — raw host ids leaked into the chips on fresh pages. `/api/accounts` now ships a `hostNames` map (the server always knows them) and the chips read it first.

## 2.244.0

- **One authority for "which account runs where, and how"** (the structural cure after six field incidents in this exact area — every one was a different surface computing its own verdict from its own cache): `accounts.evaluateOnHost()` is now THE single decision function — pure given live host facts, with the incident-derived rules baked in (host-held dir beats email-linked; a held dir whose reported identity mismatches the account is refused loudly; linked works without a local login; dial never ships; API keys always ship). The spawn path (ws-handler create) and every display surface consume the same function: `/api/hosts/:id/accounts-status` and `/api/accounts` now return per-account `verdicts`, and the billing switcher, New Session dialog and Manage-Agents roster render them verbatim (legacy cache-derived checks survive only as fallback while a probe is in flight).
- **The `created` reply carries the POST-FACTO billing truth** (`billing: {accountId, how, name}` — what the spawn actually resolved to): the billing switcher persists the session's on-resume account from THIS, never from the requested intent, so a rescue that lands somewhere else can no longer poison the config or split the badge from reality.
- **The account matrix now runs in CI, not in users' browsers**: `scripts/test-account-verdicts.mjs` exercises every combination that produced a field incident (14 asserts — linked / held / both / identity-mismatch / never-signed-in / ship gate / dial / api-key).

## 2.243.2

- **A rotated machine login can no longer silently bill the wrong account** (userN's screenshot: the Test window's badge said ClaudeLu while `/status` inside showed the machine's new login): the server's email-linked mapping trusts the host's `.claude.json` config email, which goes STALE right after a `/login` switch (the 2.114.1 identity class) — a stale match mapped the spawn onto whatever token the machine actually holds NOW. The host-held creds dir (deterministically the named account) now takes precedence over the email-linked mapping in the explicit-account path, matching the rescue path's existing order.
- **Remote account Test no longer vetoes on cold page caches** ("still says not signed in"): with a host selected, the client guard let stale hostsub/linked flags block the test — the server resolves against live host facts and errors honestly, so the client now only blocks local tests of never-signed-in accounts.

## 2.243.1

- **Manage Agents "Test" now tests the account it says it tests** (userN's inc-msghecvm-5ym8: "Test ClaudeLu" showed a DIFFERENT account signed in): the client mapped a linked account onto the CLI-login sentinel, which spawns on the host's CURRENT machine login — and that login had been switched to another account since the client's cache. Test now always sends the real account id; the server resolves it against live host facts (email-linked → host login only when the emails match NOW; host-held dir → that dir), so a rotated machine login can no longer impersonate the account under test. Fifth surface of the client-side-verdict class — the switcher got the same treatment in 2.241.0.

## 2.243.0

- **System panel: event-loop lag history chart** (the metric that cracked the instance-freeze case now has a face): a third chart under Memory/CPU plots the sampler's per-500ms loop-lag values; the 7d coarse ring records each 15-min window's worst lag going forward. Rows hide on ranges with no lag data (pre-upgrade coarse samples).
- **Billing switch persists the account pick only after the spawn succeeds** (persist-after-verify): a doomed pick (never-signed-in account, host down, shipping blocked) used to be written as the session's on-resume account BEFORE the restart was attempted — every later manual Resume then re-failed with the poisoned config. The pick now rides the create explicitly and lands in the per-session config only when the server confirms the session spawned.

## 2.242.0

- **THE instance-wide freeze root cause, caught red-handed and fixed**: a resident V8 sampling watchdog on the affected fleet pod captured the event loop blocked for 5.1 seconds inside the `/api/sessions` discovery sweep — which ran `execFileSync` end-to-end (pgrep per live webui session + `tmux list-panes` + two `ps` calls per lock file, all sequential, each fork 100-300ms under load with pgrep's 2s timeout bounding the worst sweeps at tens of seconds). With the sidebar polling every 5s and the cache at 4.5s, a connected client froze the whole server every few seconds for as long as the browser stayed open — the "everything is slow while I work, fine when I come back later" pattern (observed 8-33s event-loop stalls). The sweep is now fully async with PARALLEL subprocess probes (wall time = slowest single command, loop never blocks) and concurrent polls coalesce into one in-flight sweep. Lock-entry ordering is preserved (claimJsonls' mtime fallback depends on it).

## 2.241.2

- **The 30s local port watch no longer runs a synchronous /proc sweep on the main thread**: on the slim fleet image (no ss/lsof) `detectLocal` falls back to a /proc/net + per-process fd scan — all `readdirSync`/`readlinkSync`, every 30 seconds, on the event loop. A live CPU profile on the busiest fleet pod (hundreds of processes) showed it as the single largest non-idle main-thread consumer (~0.2-0.5s per pass). Converted to `fs.promises` — same bounded work, now on the threadpool.

## 2.241.1

- **A dying ssh agentd bridge can no longer crash the whole server** (userN's unexplained exit-code-1, 28s after an update restart: the mux heartbeat PING wrote to the ssh child's stdin right as the child died — stdin pipe errors arrive ASYNC as 'error' events, the wrapper only listened on the child process, and the write wrapper's try/catch only stops sync throws → uncaught `write EPIPE`, server down, every session's attach state lost again). stdin/stdout error events are now swallowed; the 'close' event already drives mux teardown + reconnect.

## 2.241.0

- **Billing switch no longer strands the session on "terminated"** (userN's incident ws ring, definitive: kill → exited → the auto-resume create was NEVER SENT). Root cause: `resumeSession`'s "already open in a live window" shortcut trusted `_allSessions`, which refreshes on a poll/broadcast that can be seconds stale — on a loop-blocked instance the just-killed session still matched as "live", and the switch silently ended at focusing the DEAD window. Two guards: the switcher passes the webui id it just killed as `excludeWebuiId` (never trust a stale match on it), and a read-only view (the terminated window's own ChatView, which keeps its sessionId) no longer counts as a live window at all.
- **A LINKED account pick now keeps its identity** ("切换到ClaudeLu后点resume变成标准CLI login"): the switcher passed the CLI-login sentinel for accounts that ARE the host's own machine login, so the persisted on-resume config, the title-bar badge, and the switcher's ✓ all degraded to "CLI login @ host" — a successful switch READ as failed. The switcher now sends the real account id; the server's email-linked rescue (2.240.2) maps it onto the host's own login (zero creds ship, §ban-safety unchanged) while `session._accountId` records the picked account, so the badge and ✓ show the account name.

## 2.240.3

- **Every stale tab now auto-reloads after a server update, not just the first one** (the mechanism behind "updated but still broken": the stale-bundle guard's once-per-version reload key lived in localStorage, which is shared across ALL tabs of the origin — the first tab to reload burned the key and every other open tab silently kept its old bundle against the new server, reproducing already-fixed bugs and eating clicks without a trace). The key moved to sessionStorage: per-tab, survives the reload within the tab, same anti-loop protection where it actually matters.

## 2.240.2

- **Picking a LINKED account in the billing switcher actually works now** (fourth field incident: the pick "never reached the create path" — the New Session dialog and the Manage-Agents Test button both map an account that IS the host's own machine login onto the CLI-login sentinel, but the switcher passed the raw account id, which the server refused as "subscription not logged in" since a linked account has no local creds dir by design). Two-sided: the switcher maps linked picks to the sentinel like every other surface, and the server's create-rescue gains an EMAIL-LINKED branch — when the picked account's email matches the host's own machine login, the spawn proceeds on the host's own login directly (zero creds ship), so even a stale client that passes the raw id succeeds.

## 2.240.1

- **Manage Agents and the billing switcher no longer disagree about who a host's login is** (real report with screenshot: the roster showed one account as the host's own login while the switcher's menu credited a different one — the user had /login'd a NEW account directly on the host, changing the machine identity; the roster probes live but the 2.239.2 switcher cache lived for the whole page, and its stale "uses the host's own login" label was a wrong-BILLING hazard). The switcher's warm cache now has a 2-minute TTL (matching the host auto-test cadence, re-probing on menu open and rebuilding the open menu when fresh data lands), and the Manage-Agents roster write-through shares its fresh machine-login identity into the same store — one fact, one store, freshest write wins.

## 2.240.0

Three fixes from the second field incident (`inc-msfx2fdt-3rbn`, "无法切号" + a hanging Capture button):

- **The billing switcher no longer offers a subscription that never finished signing in.** The user's real blocker: a freshly added account whose OAuth login was never completed (empty creds dir) was pickable (the ship opt-in bypassed the remote gate), so the switch failed at spawn with "subscription not logged in" — and the doomed pick was already persisted as the conversation's on-resume account, breaking every later resume too. Such accounts now render disabled with the honest reason ("never finished signing in — complete its login in Manage agents first"), on local and remote sessions alike.
- **Switch-billing waits for the session to actually EXIT before resuming.** The old flow killed the session and blind-fired the resume 900ms later — a REMOTE session's teardown takes seconds (9s in the captured timeline), so the resume ran while the old session still lived and the duplicate-window guard swallowed it silently: the window just died with no restart, twice, before a third attempt happened to land. Now the resume triggers on the session's `exited` event (+400ms transcript-flush grace, 15s fallback so a lost event can't strand the switch).
- **The Capture button shows progress and failure inline.** The first field click happened mid-server-restart (the user's own in-app update): the request died, the failure toast went unseen, and the dialog looked frozen. The button now reads "Capturing…" while in flight and a failed attempt puts an explanation line inside the dialog.

## 2.239.2

- **Billing switcher no longer greys out every subscription on a fresh page** (diagnosed from the panic button's FIRST real field capture, `inc-msfwgfpd-tlhn` — "不给换号": the action ring showed two badge clicks with no menu interaction and zero errors). `hostSubHeld`/`hostLinked` read per-page caches that only a Manage-Agents visit or a usage ⟳ populated — so right after a reload, accounts whose logins are held ON the host (or ARE the host's own login) rendered disabled with the "can't ship" explanation. The switcher now probes the host's account status itself (the same read-only `accounts-status` probe Manage Agents uses, once per host per page, warmed eagerly on open) and REBUILDS the open menu in place when the answer lands, so the rows un-grey in front of the user.

## 2.239.1

- **The Report-a-problem dialog actually shows its submit button now** (real report: "这个如何提交" — `createModalShell` exposes no `.footer`, so the Capture button's append threw and it silently never rendered; the dialog was note-field-only). The actions row is built explicitly with the standard `.dialog-actions` convention, and the incident smoke now drives the REAL dialog in headless chrome: renders it, types a note, clicks Capture, waits for the `inc-` id, and asserts the bundle carries the typed note (18 asserts total).

## 2.239.0

- **The panic button now FREEZES THE SCENE, not just the UI timeline** (admin's correction: a user hitting a problem will go troubleshoot it themselves — ssh in, resume, kill, restart — and destroy every volatile fact before anyone can look). Capture now copies out, asynchronously and read-only: the full **process table** (dtach/wrappers/claude/codex/agentd — a kill erases the whole tree), **dtach socket** stats, **verbatim copies of every session meta and wrapper meta** (rewritten by each create/kill/id-capture), **claude's own lock files** (deleted the instant a CLI exits), and for every conversation the incident touches — live sessions, the client's visible list, and any id currently blocked by the resume breaker — the **transcript identity: size + mtime + sha256 + a frozen 512KB tail**, so a later manual `--resume` that double-writes or forks is provable rather than guessed. Per referenced machine (ssh AND dial, over the same read-only probe channel as the roster) one bounded remote probe grabs the host's process table, lock files, keeper/agentd state, transcript stat+sha256+last timestamps, project dirs, disk and CLI versions — the "is it actually still running over there" question that took an entire investigation to answer. Everything is bounded (child processes with timeouts, size-capped copies, ≤6 hosts / ≤12 conversations) and individually try/caught, so a dead host or hung mount degrades the bundle instead of failing the capture; an `env.json.pending` marker distinguishes "freeze was cut off" from "nothing to capture". The dialog now says so plainly: capture BEFORE you try to fix things, and afterwards resuming/killing/restarting will not destroy the evidence. Smoke: scripts/test-incident.mjs (16 asserts, incl. proving a frozen meta copy survives its original being clobbered).

## 2.238.1

- Incident bundles additionally capture the **active resume-breaker table** (which conversation ids are currently blocked from resuming, and for how long) and a **remote-discovery cache digest** (per host: how many sessions discovery last believed exist, with id prefixes) — both were load-bearing in the "conversation disappeared" investigation and neither survives anywhere else.

## 2.238.0

- **"Report a problem" panic button — the scene now survives the timezone gap** (admin request: users hit problems while the admin sleeps, and by investigation time the scene is gone). The client keeps ALWAYS-ON bounded ring buffers of the last few minutes — clicks and coarse key events (special keys only; typed text is NEVER recorded, only a per-burst "typing" marker), WS message types both directions (type/sessionId/diagnostic codes, never payload bodies), and console errors/warnings — plus assembles a full state snapshot on demand (windows with openSpec-lite, session digest, ws state, heap). ⚙ → "Report a problem…" flushes all of it to the server, which adds ITS OWN scene (active-session digest with streaming/remoteState flags, 30-min sysinfo history, an in-memory server console ring, hosts digest) and writes `data/incidents/<inc-id>/bundle.json`; a follow-up snapshot auto-attaches 2 minutes later for it's-happening-right-now cases. The user relays only the short `inc-…` id. Newest 30 bundles kept; the note field is the only free text. Contract smoke: scripts/test-incident.mjs (7 asserts incl. traversal rejection + prune).

## 2.237.3

- **Manage Agents → Test no longer claims a LINKED subscription "isn't signed in"** (real report: on a host whose own CLI login IS that account's email, Test refused with "This subscription isn't signed in yet"). A linked account needs no local creds dir and no shipped copy — on that host it IS the machine login — which the billing switcher and the New Session dialog already model (2.208.0); the Test guard was the last place still reading an empty LOCAL creds dir as "not signed in". Linked rows are now marked in the DOM, the guard exempts them, and the diagnostic session spawns with the CLI-login sentinel so it runs on the host's own login (nothing ships — §ban-safety unaffected).

## 2.237.2

- **CephFS mounts no longer depend on the image shipping `modprobe`** (real recurring failure: `mount.ceph` HARDCODES a `/sbin/modprobe` call and treats "command not found" as fatal — the 3.5.0 container image dropped the `kmod` package, so every cephfs connect died "sh: 1: /sbin/modprobe: not found" even though the ceph kernel module was already loaded host-side; a container can never modprobe the shared kernel anyway, and on kmod-bearing images the call always failed harmlessly — exit-127 was the one variant mount.ceph refuses). `_mountCephfs` now ensures a no-op `/sbin/modprobe` shim (sudo, idempotent, container-scoped) before every attempt, so the host's module state — not the image's package list — decides the outcome; the deploy image also gets `kmod` back for good measure.

## 2.237.1

- **Update works again — the 2.235.1 ownership preflight false-positived on every normal repo** (real incident on the first machine to update past it: git makes pack files mode 444 read-only BY DESIGN, so the `! -writable` test flagged `.git/objects/pack/*` and refused the update with the chown advice on perfectly healthy checkouts). The preflight now tests OWNERSHIP (`! -user <current>`), which matches the actual root-run-residue incident class. Instances that already carry the broken 2.235.1–2.237.0 script can't self-heal (the local script blocks before `git pull` — the 2.112.7 class); fix once with a manual `git pull` in the repo, after which the in-app Update works normally.

## 2.237.0

- **The resume-breaker recovery is now an unmissable dialog** (real report: after the resume cooldown armed, the 2.227.3 "Try resuming anyway" bar sat quietly at the bottom of the rescued window and the user concluded resume was broken). When the breaker fires AND the transcript verifiably exists, the client now pops a confirm dialog — "对话还在——现在重试？" — whose confirm immediately re-runs the resume with the cooldown bypassed (same window geometry); declining falls back to the old rescued view + retry bar. The no-transcript branch keeps the previous toast + bar behavior.

## 2.236.1

- **Resume works again after the personalized-username container migration** (real incident: upgrading a long-lived instance to the 3.5.0 image renamed the container user `vibe`→`<name>`; the boot script's `/home/vibe` symlink covers every recorded absolute path, but claude encodes its per-project transcript dirs from the RESOLVED cwd — 57 pre-migration projects sat under `projects/-home-vibe-*` while every resume looked in `-home-<name>-*` → "No conversation found with session ID"). The server now self-heals at boot: when home isn't `vibe` and `/home/vibe` is a symlink, each `-home-vibe-*` project dir is renamed to the new encoding with the old name left as a symlink, so both claude's resolved-cwd lookups and VibeSpace's recorded-cwd lookups keep working. Idempotent; collisions are skipped with a log.

## 2.236.0

- **Picking a subscription account now works on machines with apiKeyHelper configured** (real report: on a host whose settings carry `apiKeyHelper`, every billing pick silently stayed API-billed — the 2.191.0 disassembly showed a configured helper unconditionally overrides claude.ai OAuth, and the switcher could only explain, not fix). VERIFIED by a controlled A/B experiment: an inline `--settings '{"apiKeyHelper":""}'` overrides the file-level helper (`apiKeySource` flips from `apiKeyHelper` to `none` = subscription OAuth; `null` remains unusable — the CLI schema drops it). Every EXPLICIT subscription pick (local or remote, create and resume) now merges the neutralizer into the spawn settings — a no-op on machines without a helper; the bare "CLI login" pick deliberately keeps the machine's own behavior (a helper may be admin intent). Switcher and Manage-Agents explainers updated to say picks work instead of "remove it from settings.json". Contract asserts added to scripts/test-fallback-policy.mjs (single merged --settings with ultracode + fallback + neutralizer).

## 2.235.1

- **update.sh survives root-run-update residue** (real fleet incident: an admin-side update executed as root via `kubectl exec` left `data/.update.lock` — and 252 working-tree files — root-owned; the user's next in-app Update died at the lock with a bare "Permission denied"). The lock is now remove-or-explain when unwritable, and an ownership PREFLIGHT detects non-writable repo files up front and prints the actual fix (`sudo chown -R <user>: .`) instead of letting git fail midway with a confusing error.

## 2.235.0

- **Heavy transcript work moved off the main thread** (the structural follow-up to the 2.234.1 incident: the degradation was single-threaded transcript work — 32MB tail parses on every attach/history load, GB-scale line-index builds, full-file turn scans — saturating the ONE event-loop thread while machine CPU% looked idle). New `src/transcript-worker.js` runs the EXISTING sync implementations inside a persistent worker pool (SafeFs generalized to host other worker scripts; zero logic duplication — the worker simply requires the same modules, whose mtime+size caches now live where the work happens). Worker-backed async variants (`jsonlGapInfoAsync`/`readJsonlLineRangeAsync`/`scanJsonlUserTurnsAsync`/`readJsonlBoundedParsedAsync`) serve the gap/turn-map/slab endpoints, and `warmSessionJsonlAsync` pre-warms the JSONL parse cache before the ws attach rebuild and `/api/session-messages` — the sync machinery then hits a warm cache instead of blocking. Worker down ⇒ automatic sync inline fallback, identical behavior. Measured: main-thread max block 1ms via workers vs 78ms inline on a 39MB fixture (real-world files were 0.6-1s); regression test scripts/test-transcript-worker.mjs (12 asserts incl. a negative control and parity checks). SafeFs also now ref()s a worker while calls are in flight (an idle loop could exit before an unref'd worker replied).
- **Event-loop degradation is surfaced live** (the "everything is slow but CPU looks fine" state was only diagnosable from telemetry after the fact): sysinfo samples loop lag every 500ms; a 3-minute MEDIAN ≥300ms (amber) / ≥800ms (red) broadcasts a `sysinfo-alert kind:'evloop'` — toast says the server is degraded and sessions are NOT dead — with the same 30-min cooldown discipline as the memory watch, and the lag rides the sysinfo history samples for the System panel's data.

## 2.234.1

- **A slow server no longer reads as mass session death** (real fleet incident: an instance degraded for ~2h — event-loop spikes from heavy live sessions + big-transcript re-parses + remote transcript pulls — and every WS reconnect's re-attach missed the old one-shot 20s no-reply timer, flipping ~8 windows to read-only with "The session no longer exists on the server (likely a restart)" while every session, local and remote, was verifiably alive). Two-sided fix: the server now sends a tiny synchronous `attach-ack` the moment an attach arrives (proof-of-life before any slow work — transcript pulls, history rebuilds, payload serialization), and the client's no-reply fallback became a retry ladder: it re-sends the attach while un-acked (the ack's absence means the attach may never have landed), just waits once acked, and only flips read-only after ~2 minutes — with honest messages that distinguish "server alive but slow, session likely still running" from "server may have restarted". The confident "no longer exists" wording is now reserved for the explicit not-found error reply. Contract smoke: scripts/test-attach-ack.mjs.

## 2.234.0

- **Touch devices: the keyboard's enter key now inserts a newline instead of sending** (real report: "点换行之后就发出了" — soft keyboards have no Shift+Enter, so enter was both the only newline key AND the send key, making multi-line messages impossible on phones). Sending on touch is the ▶ button. New setting `chat.touchEnterSends` (Chat, default off) restores enter-to-send for those who prefer it; desktop behavior is unchanged (Enter sends, Shift+Enter newline). Detection uses the central `app.isTouch` (hover:none + pointer:coarse), so touch-primary tablets get the newline behavior too.

## 2.233.2

- **Subagent View Log no longer leaks the PARENT conversation's history above the agent's own log** (real report: scrolling up in an agent viewer showed cards from before the agent existed). `_getSessionIds()` resolves a `sub-*` viewer to its parent session (the openSpec carries the parent's id/cwd for the transcript lookup), and the huge-session machinery keyed only on message count — so when the parent is a huge-JSONL session, the gap probe activated against the PARENT transcript: the viewer got the parent's whole-conversation minimap and the seek sentinel loaded parent slabs above the agent's messages (genuine parent records, rendered as if the agent did them; the position indicator stayed correct because gap messages are excluded from window accounting — which is exactly why it looked so confusing). Gap minimap, seek sentinel, and the turn-map fallback fetch are now gated on `_canPaginate`, the same capability that already excludes sub- viewers from pagination.

## 2.233.1

- **A finished background agent's card no longer says "responding" forever** (real report). The card's live status line is only ever redrawn by incoming subagent messages, so after the agent's last message it kept whatever activity was in flight. Completion now freezes it: the same `<task-notification>` wakeup that 2.233.0 wired into the task tracker also rewrites the line to "N messages · finished" (dimmed) and latches it, so a trailing buffered message can't resurrect the stale activity. Server side, the wakeup now also stops that agent's JSONL watcher and GCs its buffers immediately instead of waiting for the 10-minute idle sweep.

## 2.233.0

**The background-task popup now shows completion — and stops accumulating forever** (user report: 20 rows, no way to tell what finished). Root cause: tasks enter the tracker on `system/task_started`, and the removal path listened for `system/task_notification` — but in the current harness a background command's completion signal is the `<task-notification>` WAKEUP user record (the 2.229.2 discovery), which never touched the tracker. Tasks only accumulated. The wakeup names its `<tool-use-id>` and `<status>`; the normalizer now routes them into the same taskInfo lifecycle, so:

- the status-bar chip counts RUNNING tasks only;
- finished tasks move to a dim **Recently finished** tail in the popup (✓/✗ outcome, last 12) instead of vanishing silently or lingering as fake-running rows.

Unit-tested end to end (task_started → wakeup → completed) in `scripts/test-task-wakeup-card.mjs`.

## 2.232.4

- **The Import button is actually visible now** (2.232.3 shipped the SVG but it still rendered blank — this time verified by PIXELS, not DOM). True root cause, three layers deep: `.session-item-card` is a container-query container (`container-type: inline-size`, from the 2.37.4 responsive-tags work) — inline-size containment makes the card's width INDEPENDENT of its content, so the shrink-to-fit import card collapsed to padding-only width, and the flex layout then squeezed the child (the old text AND the new icon alike) to 0. The forensic tell: the icon's inline `1em` height resolved to 14px (cross axis) while its width resolved to 0px (main axis, flex-shrunk). Fix: the import card opts out of containment (`container-type: normal`) + explicit `min-width` + `flex-shrink: 0` on the icon. Verified with a CDP screenshot of the rendered row this time.

## 2.232.3

- **The task board's Import button is no longer an empty dashed square** (real report). The card rendered its label through `.session-card-name`, whose `flex:1 / min-width:0 / overflow:hidden` semantics are built for the session-card flex row — inside this shrink-to-fit card the text collapsed to 0 width (verified with a live CDP probe: text present in DOM, rendered at 0px). It is now a proper SVG icon button (new `import` icon in the shared library, instant tooltip retained).

## 2.232.2

- Switching `tasks.autoStyleOrder` also live-refreshes any OPEN Task Group detail window (the Auto swatch and texture chip previews show the group's current auto style); board/flat-view already re-rendered live. No per-group action is ever needed on a switch — auto styles are a pure function of the stored order-independent `colorSeq` and the setting.

## 2.232.1

- **The auto-style dimension order is now a setting** (`tasks.autoStyleOrder`, Settings → Sidebar — user: both orders have merit, make it a choice). `interleaved` (default): bands and textures cycle from the first groups, maximum visual difference. `solid-first`: the 36-solid-slots-before-textures layout, cleaner for small setups. The setting reaches the SERVER allocator too — manual-pick masking compares slot renderings, so both sides must sequence identically (order mismatch would let auto colors collide with manual picks). Applies live (board re-renders on change); `colorSeq` values are order-independent.

## 2.232.0

**All four identity dimensions now engage from the very first groups** (user report: "I created 20 groups and saw no texture — is this really done?"). It was implemented but ordered wrong: the sequence filled 36 solid slots (12 hues × 3 bands) before any texture — an aesthetic "keep small setups clean" choice that contradicted the maximize-difference directive. The 12 planes (3 lightness bands × 4 line styles, solid trio first, then dash/dot/diag trios) now cycle every 12 slots: groups 1-3 are the solid band trio, group 4 is dashed, and any two groups within 11 sequence positions of each other differ outright in lightness band or texture; the within-plane golden-angle index still grows without bound (infinite, never-colliding, gracefully densifying — 2.231.2 semantics unchanged). A 97°-step per-plane hue offset keeps consecutive slots apart in hue as well. NOTE: this reorders existing auto colors once (a one-time visual migration; colorSeq values are untouched).

## 2.231.3

- **Creating a Task Group no longer toasts "Task Group not found"** (real report, every create). Classic response-vs-broadcast race: the create flow opened the detail window with the id from the POST response, but the detail window resolves groups from the client mirror — which only updates when the `tasks-updated` WebSocket broadcast lands, and the awaited response beats the broadcast essentially always. The mirror is now upserted synchronously from the API response (create / update / import; delete removes locally) — the later broadcast idempotently overwrites. Same class as the 2.31.0-era `_pendingTaskBinds` note: any UI action chained on a store write must not wait on the echo.

## 2.231.2

**The color sequence is now truly infinite** (the user's theory question — "the sequence should extend forever, later points just packing the existing space ever more densely" — caught a gap: the implementation wrapped at 144 slots, making slot 144 an EXACT duplicate of slot 0). The 12 discrete planes (3 lightness bands × 4 line styles) cycle, but the within-plane golden-angle index now grows without bound: an irrational rotation never lands on the same hue twice, each new point splits an existing gap in the golden ratio, and the min same-plane gap degrades gracefully (measured: 20.1° at 144 slots, 7.7° at 288, 4.7° at 576 — consistently ≥~half the ideal even spacing, per the three-gap bound). Slots below 144 render identically to before, so already-assigned colors are unchanged. The allocator's manual-pick masking also became range-free (tested per candidate slot on the fly instead of a precomputed 144-slot window). Tests: 30 asserts incl. no-duplicate-at-1000-slots and the graceful-degradation ratios.

## 2.231.1

**Auto colors redesigned around the user's formalization: a fixed sequence S_k in the hue × lightness × texture identity space, where every prefix S_0..S_i stays far apart and assigned points NEVER move.** The previous set-aware assignment satisfied a ≥20° floor while letting 3 groups sit visibly close (the reported case), and re-spaced existing colors on insertion. Now:

- **The sequence**: golden-angle hues (sunflower phyllotaxis — any prefix keeps ≥~62% of ideal even spacing, three-gap theorem) interleaved across the 3 lightness bands, textures opening after 36 solid slots; 144 immutable slots total. 3 groups = 3 different bands with well-spread hues; a group's color never changes for its lifetime.
- **The slot** (`colorSeq`) is allocated server-side at creation — lowest free index — and stored on the record. **Deletion frees the slot for the next creation** (S1 deleted → the next group becomes the new S1), keeping the occupied prefix compact so spacing quality tracks the CURRENT group count.
- **Manual picks mask the sequence**: a hand-chosen color/texture blocks the auto slots that render close to it (hue <24°, similar lightness, same texture), so auto assignments never collide with manual ones.
- Renderer-side this collapsed to a pure function (`seqTaskColor(colorSeq)`) — the set-aware map machinery is gone; the generator + allocator live in one shared module (`src/task-color-seq.js`) used by both server and client. Existing groups are backfilled in creation order at boot.

Test suite rewritten to the sequence contract (25 asserts: prefix spacing, immutability, slot reuse on deletion, mask-aware allocation, server create/delete integration).

## 2.231.0

**Texture is now manually selectable per Task Group** (follow-up: 2.230.2 made line-style textures auto-only — the settings dialog still only offered color). The group detail window's Color section gains a **Texture row**: Auto (follow the auto assignment) / Solid / Dashed / Dotted / Diagonal, each chip previewing its line style on the group's current color. A manual pick wins over the auto assignment and works for explicit-color groups too (pick any color AND any texture); `pattern` is a first-class store field (sanitized enum, visual-only — never re-injects agent context). Textures now also render on the task board's left strip via `border-image` (replaces the border color only — the 4px layout is untouched), alongside the flat-view color bars. Note on lightness: the custom color picker always allowed any lightness — pick a darker/lighter shade of the same hue there.

## 2.230.2

**Texture joins the auto-color space as a third dimension** (user suggestion — refined by the follow-up observation that fine fills can't read on a 3px bar): the texture vocabulary is **chart line styles** — solid / dashed / dotted / diagonal-banded — whose variation runs along the bar's LENGTH, so they stay legible at hairline widths (the same reason line charts can encode series identity in 1px strokes). Auto assignment now spans 18 hues × 3 lightness bands × 4 line styles = **216 combinations** under the hard pairwise guarantee (same plane ⇒ ≥20° hue apart; different plane ⇒ lightness or texture visibly differs). Solid planes fill first, so textures only appear past 54 groups; dash/dot gaps are transparent (the panel shows through) for real contrast, and the channel is hue-independent — a color-blind aid wherever it appears. Applied on the flat-view color bars (the one surface with no text label); board rows keep their name as the primary identity. Test grew to 15 asserts incl. the 80-group cross-plane guarantee.

## 2.230.1

**Auto group colors upgraded from probabilistic to GUARANTEED distinct** (fair follow-up objection to 2.230.0: hash-only hues are birthday-bounded — with enough groups some pairs land close no matter how good the hash). Rendering now assigns colors set-aware (`assignDistinctTaskColors`): any two auto colors either differ in hue by **≥20°** or sit in **different lightness bands** (52%/36%/68% — visibly distinct even in a 3px bar). Three bands give hard separation up to 54 groups, then best-effort. Placement is anchor-first: a group whose stable hash-anchor hue is free KEEPS it forever, so colors don't reshuffle when unrelated groups come and go — only colliders get deterministically nudged (test-verified: adding a group to a 40-group set changes ≤3 existing colors). The canonical resolver lives on the sidebar (`getTaskColor`, map lazily recomputed on task-list sync); all consumers route through it. Test grew to 12 asserts including the pairwise hard guarantee, determinism, and insertion stability.

## 2.230.0

**Task Group colors scale to any number of groups** (user request: the fixed 6-swatch palette ran out fast for people with many groups). Three layers:

- **Auto-distinct by default**: a group with no explicit color now gets a deterministic color derived from its id (FNV-1a hash + avalanche mix over the hue wheel) — any number of groups stays visually distinguishable with zero effort, identical on every client and across restarts, nothing new stored. The detail window's color row leads with an "A" swatch showing the group's actual auto color.
- **Any color at all**: a native color-picker swatch next to the presets (the server already accepted arbitrary values; only the UI was limiting). The quick-pick palette also grew 6 → 18.
- **Explicit neutral**: "no color" is now a deliberate choice (sentinel `'none'`) — picking it keeps the group grey instead of auto-colored.

Applied everywhere group colors render: board headers, flat-view color bars, session-card group indicators, Session Properties dots. Unit test: `scripts/test-task-colors.mjs` (determinism, hue dispersion ≥18 12° buckets for 30 groups, sentinel semantics, sanitizer accepts hex/'none' and still rejects CSS injection).

## 2.229.3

- The background-task wakeup card uses the shared SVG clock icon instead of an emoji (project convention: chrome/card icons are SVG, never emoji — `UI_ICONS.clock` added to the icon library for reuse).

## 2.229.2

**Background-task wakeups are now visible in the chat** (user report: an agent kept getting woken by background tasks — a CI watcher, a workflow — with no trace of the task or the wakeup in the conversation). Root cause from the real transcript: the wakeup is a user record with `<task-notification>` content, but the CLI stamps `promptSource:"sdk"` on it — and the typed heuristic (promptSource ⇒ the user's own words ⇒ never demote to a notification card, the 2.88.0 guarantee) made it render as a "You" bubble of sanitized XML, effectively invisible. The record's authoritative marker — top-level `origin:{kind:"task-notification"}` — now wins over promptSource; wakeups render as a dedicated dim card: **"⏰ Woken by background task (completed): Background command "…" completed (exit code 0)"** with the full payload behind an expander. A leading-tag text-shape check covers transports that drop the origin field; genuinely typed messages (including pasted XML mid-sentence) keep their protection. Unit test: `scripts/test-task-wakeup-card.mjs`.

## 2.229.1

**Chat paging no longer jumps** (user report: scrolling up through history leapt a big chunk; scrolling back down jumped too). Reproduced with a committed CDP harness driving a real view-only ChatView over a synthetic 40MB transcript (gap-seek active, wheel-cadence steps both directions) and attributed with a scrollTop-write interceptor that stacks every programmatic write — the recording showed ±4000px oscillations between adjacent frames. Three cooperating defects:

- **A per-message trim storm during batch loads.** `_extendBottom` appends its 50-message batch through `_onCreateMessage`, whose pinned live-path called `_trimTop()` + `_scrollToBottom()` PER MESSAGE — dozens of remove/compensate cycles per batch. Batch loads now skip the live-path trim (`_loadingHistory` gate); the batch caller trims once at the end.
- **Relative delta compensation fought the browser's native scroll anchoring.** `_trimTop`'s `scrollTop -= (before − after)` and the browser's own anchoring both corrected for the same removals — double compensation, visible as the captured oscillation. `_trimTop` is now element-anchored with an ABSOLUTE restore (`_withViewportAnchor`), which converges regardless of what the browser did in between; the delta math survives only as the anchorless fallback.
- **A folded anchor sent callers to the estimate-skewed delta path.** `_withViewportAnchor` reported failure when its anchor element got folded by a run-collapse pass inside the wrapped mutation (much likelier since 2.213.0 widened the collapsible kinds) — callers then fell back to delta math under content-visibility estimate skew. It now restores on the nearest visible sibling (the run header sits exactly where the folded content was — same strategy as `_updateRuns`' own restore).

Committed harness: `scripts/test-chat-paging.mjs` (throwaway worktree server + headless-chrome CDP, 180 scripted wheel steps, per-frame anchor-drift detector + scrollTop-write forensics; negative-controlled — pre-fix code produces 13 jumps, fixed code zero).

## 2.229.0

**Persistent claude installs are now the default** (the userW rollback incident: he ran `claude update`, used Opus 5 for three days, then a pod rebuild silently reverted the image-baked npm-global CLI to its old version — and the `opus` alias back to Opus 4.8 — with zero notice):

- `/api/backend-status` classifies each CLI's install layer (`install: {binPath, userLocal}` — resolved binary under `$HOME` = survives container rebuilds and wins PATH).
- Manage Agents shows an amber warning on a system-location claude ("updates to it are lost when the container is rebuilt") with a one-click **Install persistent copy** (the native installer → `~/.local`; takes over for new sessions after the next server restart).
- The pod entrypoint now defaults to migrating: when the PVC has no `~/.local/bin/claude`, it fetches the native installer in the background at boot (never blocks; offline boot skips harmlessly — the baked copy still works). Opt out with `VIBESPACE_NO_CLI_MIGRATE=1`.

Context for the class of confusion this ends: model aliases (`opus`, `sonnet`) resolve against the registry EMBEDDED in the binary — 2.1.207 maps `opus` → claude-opus-4-8 (and predates Opus 5 entirely), 2.1.220 maps it → claude-opus-5. A silently-reverted CLI therefore silently changes what your configured model alias means.

## 2.228.3

**Sidebar no longer jumps back to the top when you expand a card after scrolling** (recurring report). Three cooperating defects, found by driving the real render/observer machinery in a committed CDP harness:

- **The scroll-preserve anchored on an element that no longer scrolls.** `_render()` preserved `.sidebar-section`'s scrollTop, but in the current layout the scrolling element is `#all-sessions-list` itself (measured 391/7106 vs the section's 443/443) — every "preserved" value read 0, so the whole mechanism had silently rotted into a no-op. Both the per-render and the poll-digest preserve now capture/restore BOTH candidate scrollers (restoring a non-scroller is a harmless no-op), so the anchor can't rot again when CSS evolves.
- **Lazy folders collapsed the scrollHeight during rebuild.** A re-render resets every folder to an empty pending div, so even a correct scrollTop restore got CLAMPED toward the top before the IntersectionObserver (async) could materialize anything. Folders now RESERVE their height while pending — the exact height remembered from the previous render (`_lazyHeights`), or a card-count estimate on first render — cleared on materialization.
- **One bad session record could husk whole folders.** A throwing card build inside the observer callback (real case: a garbage timestamp → `RangeError: Invalid time value` in a date format) aborted the entire batch AFTER the folder's minHeight/content were cleared — leaving empty pending husks. Card builds are now per-card try/caught with a `sidebar-card-render` telemetry breadcrumb; one bad record costs one card, not the sidebar.

Committed smoke: `scripts/test-sidebar-scroll.mjs` (throwaway worktree server + headless-chrome CDP, drives the real `_render`/lazy-folder path with 50 synthetic folders; negative-controlled — pre-fix code fails exactly the two scroll assertions).

## 2.228.2

- **Pending image attachments are now click-to-zoom.** Pasting a screenshot into the chat input shows a ~32px chip preview with no way to verify WHAT you pasted before sending it to the model (user request). Clicking the chip now opens the standard full-screen image overlay (× still removes; zoom-in cursor + tooltip). The overlay builder was deduplicated into `showImageOverlay` (utils.js) — the two inline copies in ChatView (sent-message `chat-img` thumbnails, which were already zoomable) now share it, and it joins the global Escape-close protocol via `data-popover`.

## 2.228.1

userL's contradiction — a session stuck on "host reconnecting (9)…" while the machine row showed green READY — diagnosed to the root and both halves fixed:

- **The machine-row probe was lying.** `hosts.test` (and the sidebar autoprobe through it) rode the multiplexed ControlMaster, whose ESTABLISHED TCP flow survives firewall/route changes — verified live: fresh connections to the host timed out for hours while the mux channel from before the change kept answering, so the row stayed READY while every new session pipe failed. The probe now measures what sessions actually experience: a FRESH connection. When fresh fails but the old channel still answers, the row names the exact situation ("new SSH connections fail … while an already-established channel still responds — the network path changed").
- **"host reconnecting (N)…" now says why.** The chat wrapper records the transport child's last stderr line (e.g. `ssh: connect to host X port 22: Connection timed out`) into `meta.remote.lastError`, forwards it on `_remote_state`, and the status-bar chip tooltip shows it — the difference between "transient blip" and "the host address is dead" is now visible in the UI instead of requiring hand-run ssh. Contract test: `scripts/test-remote-lasterror.mjs`.

The session chip was truthful all along — the "same remote" impression came from two host records pointing at two different machines, one of which had genuinely gone dark for new connections.

## 2.228.0

**Disable model fallback (`claude.disableModelFallback`, Settings → Claude, default off)** — user request: "stop instead of silently becoming opus". Built on the CLI's native controls (found by disassembling 2.1.220; no reactive hacks as the primary path):

- `switchModelsOnFlag:false` — the CLI's own settings key ("When safeguards flag a message … when off, your session will pause instead"). Injected at spawn (merged into the single `--settings` flag alongside e.g. ultracode) and pushed to RUNNING chat sessions the moment the toggle flips, via the same `apply_flag_settings` channel the effort switcher uses (effective next turn; re-enable sends the literal `true` — `null` deletes the key with undocumented layer precedence). With it armed, the server-lane `fallbacks` request param is never sent and the client-lane refusal retry degrades to a clean stop.
- `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` in the spawn env additionally covers **subagents** (the settings key is main-thread-only) for sessions started while enabled.
- A stopped turn is never a silent dead-end: the CLI's `model_refusal_no_fallback` record now renders as a localized notice (both stdout/JSONL key casings) with the refusal category + the CLI's explanation behind an expander — "rephrase and resend to continue".
- Reactive belt for sessions that predate the toggle (their CLI still has fallback armed): a fallback signal on the live stream triggers the standard interrupt + a per-session toast naming the from→to models, once per turn; it also disarms fallback in that CLI for the rest of the session.
- Corrected internal understanding along the way: `{type:'fallback'}` content blocks are SAFETY-CLASSIFIER reroutes (the API `fallbacks` beta triggers on policy declines only — overloads/rate limits never fall back); genuine capacity fallback is a different record (`system/model_fallback`) and only exists when a `fallbackModel` is configured, which VibeSpace never does.
- Contract test: `scripts/test-fallback-policy.mjs` (10 asserts: single-flag merge, env, apply_flag_settings shapes, no-fallback notice both casings).

## 2.227.12

Two reports from one user, one of which turned out to be a credential leak:

- **The server's own runtime env no longer leaks into agent sessions.** A session inherited `process.env` wholesale, so the container's `NODE_ENV=production` made every `npm install` the agent ran silently skip devDependencies (reported: husky "command not found"), and `PORT=3456` — the server's own listen port, baked into the image — was inherited by dev servers the agent started. `npm_*` leaked the same way. **Worse: the helm chart injects `VIBESPACE_PASSWORD` (the instance login password), the S3/CephFS/Google-Drive/frps credentials and the telemetry token — every agent session could read all of them with one `env`.** Sessions now get a sanitized env (`agentEnv`): operational vars and `npm_*` dropped, all `VIBESPACE_*` dropped except the short allowlist an agent legitimately needs (API/session token/task id/remote-transport hints/instance name), which are set explicitly anyway. Applied to all three spawn paths that inherited the raw env; 8-assert unit test.
- **"Task Group operation failed" now says what actually failed.** The toast fell back to that bare string whenever the response body had no `error` key — an HTML 502 from the ingress, a 413, a proxy timeout all looked identical, and the report was undiagnosable (a live reproduction of the same action returned HTTP 200). It now names the HTTP status plus a body excerpt and leaves a `task-api-<status>` telemetry breadcrumb; the network-failure branch names the exception.

## 2.227.11

- **Self-update could abort on a build-dirtied `src/agentd/version.js`.** That file is tracked but REGENERATED by `npm run build:agentd` (it stamps the package version), so any instance that had built left the tree dirty and `git pull --ff-only` aborted with "local changes would be overwritten" — exactly the package-lock.json trap, one file over. Real fleet incident: an instance stuck at 2.162.7 failed to update for this reason. `scripts/update.sh` now resets it per-path alongside package-lock.json.

## 2.227.10

- **"Relay not configured" now says WHICH field is missing.** A user filled in the frp relay address and port but the token stayed blank; the plugin only said "relay not configured on this instance", so there was nothing to act on and the feature looked broken for days. The status carries `missing: ['token'|'serverAddr']` and the panel says "Missing: relay token — fill it in below". Same rule as every other failure path: name the gap, never make the user guess.

## 2.227.9

Two run-collapse reports:

- **Skill cards now participate in the fold.** A "Launching skill: x" card is harness noise of the same class as a Bash line, but `memberKind` returned null for it — so it never folded AND it BROKE the run around it (the cards either side couldn't fold together). Added as its own kind (`skill`, on by default, toggleable in `chat.collapseKinds`).
- **No more visible flash before folding.** The fold ran on a 180ms-debounced MutationObserver pass, so a foldable card painted at full size first and collapsed a moment later. A MutationObserver callback runs at the microtask checkpoint — before the next paint — so pure TAIL APPENDS (live streaming) now fold synchronously in that callback and the card appears already folded. Bulk inserts (pagination, jumps, trims) keep the debounce, where the pass is expensive and one frame of delay is invisible.
- Committed smoke: `scripts/test-run-collapse-fold.mjs`.

## 2.227.8

- **A new top-level CLI stream record can no longer ride the wrong branch in silence.** `tool_progress` did exactly that for weeks (2.227.7), one release after `model_refusal_fallback` did the same thing inside the normalizer (2.227.4) — twice, a user noticed before we did. The server's stream parser now breadcrumbs any unrecognized top-level `type` (name-only, deduped per process, `cli-unknown-stream-type` + a log line), matching the 2.227.5 guard for system subtypes. Both entry points from the CLI now announce upstream additions instead of absorbing them.

## 2.227.7

- **A Bash card showed "14 messages · View Log"** (real report). Newer CLIs stream `{type:'tool_progress', tool_name, parent_tool_use_id, elapsed_time_seconds, heartbeat}` while a long tool runs — and it carries `parent_tool_use_id`, the SAME field subagent messages use. The server's type-blind `if (msg.parent_tool_use_id || msg.isSidechain)` swallowed them: they were buffered as subagent transcript, spun up a sub-normalizer per Bash call, and the client painted the agent status line (message count + a View Log button opening an empty viewer) onto a plain Bash card. Now routed to their own `tool-progress` broadcast and rendered as what they are — a dim "still running · 2m30s" line on the pending card, which yields to the real agent status line when an actual agent owns that card. (`tool_progress` is stdout-only; it never appears in the JSONL, which is why history never showed this.)
- Test: `scripts/test-tool-progress.mjs` (dispatch order, else-if exclusivity, and that the progress line can never grow a View Log button).

## 2.227.6

- **The new safety-fallback notice showed "? → ?" instead of the model names** (real report, one release after 2.227.4): the SAME record is **snake_case on stdout** (`original_model`, `fallback_model`, `api_refusal_category`) and **camelCase in the JSONL** (`originalModel`, …). The handler was written from the JSONL sample, so every LIVE notice lost its models while history rebuilds looked correct. Both casings are now accepted on every field. Bonus: stdout also carries `api_refusal_explanation` (the actual policy reason, absent from the JSONL) — it now leads the details expander.
- Test extended with the stdout shape, so a one-transport handler can't ship again.

## 2.227.5

- **A new upstream CLI record type can no longer become an invisible product gap.** `_processSystem` drops system subtypes it doesn't handle — that is exactly how 39 silent model switches shipped unnoticed until a user asked (2.227.4). Unhandled subtypes now leave a name-only telemetry breadcrumb (`cli-unknown-system-subtype`, deduped per process), so the next CLI addition surfaces in the Diagnostics report instead of waiting for a report. Adding the handler silences it.

## 2.227.4

**The model badge changed mid-conversation with nothing in the transcript to explain it** (real report: "聊到一半就显示 opus-4.8，也没看到 fallback 事件"):

- **Safety-classifier fallbacks were invisible.** Newer CLIs retry a flagged message on a different model and record ONLY a `system/model_refusal_fallback` line — no `fallback` content block (verified in a 343MB transcript: 39 such records, and the switches that puzzled the user had the system record and no block). `_processSystem` dropped unknown subtypes silently, so the served-model badge flipped to Opus 4.8/Opus 5 with zero explanation. Now rendered as a system notice naming both models, the refusal category, and — behind an expander — the CLI's own wording, with the reassurance that the model SETTING is unchanged and later messages return to the chosen model.
- **`noticeKind` was never passed through `_create`** — so the localized renderer branch for the older capacity/overload fallback notice has been dead code since it was written (the notice rendered as raw English). Fixed; both notices now localize.
- Test: `scripts/test-model-fallback-notice.mjs` (real captured record shape, live + history-rebuild paths, plus the revived legacy branch).

## 2.227.3

**The unresumable-conversation breaker no longer tells you to throw away a live conversation** (real incident: a 46MB session that was fully intact on its machine showed "there is nothing to resume — close this window/card; start a new session instead"):

- **Verify before blaming.** The CLI's "No conversation found" only proves it looked in the WRONG PLACE — in this incident a stale display-cwd (`Host: /path`, the 2.225.2 bug, from a pre-fix client) sent claude into the wrong project dir while the transcript sat untouched. The refusal now checks whether a transcript for that id exists anywhere we can see (local project dirs / remote-jsonl cache) and says so: "a transcript DOES exist, the conversation is NOT lost — check the working directory/machine and try again". When nothing is found it still never claims deletion ("nothing has been deleted").
- **Never a dead end.** The refusal rescues the window into view-only history plus a **Try resuming anyway** bar that retries with the breaker bypassed (`ignoreNoConvo`), instead of instructing the user to close the card.
- Structured reply (`code:'no-convo-breaker'`, `transcriptKnown`) so the client can render the right affordance.
- Regression smoke: `scripts/test-resume-breaker.mjs` (7 asserts — both wordings, the bypass, and that the destructive advice can never come back).

## 2.227.2

**Mount hygiene + mountpoint permissions** (two user reports):

- **Leftover empty mountpoint dirs are now actually removed**: the sweep (unmount / mountpoint change / remove) was a ONE-SHOT `rmdir` 1.5s after a LAZY unmount — the kernel often hadn't detached yet, the EBUSY was swallowed, and the husk stayed forever. Now a child-process rmdir with a retry ladder (1.5s → 3.5s → 10s → 30s → 60s); non-empty dirs are still never touched, and a final failure logs instead of vanishing.
- **Changing the mount point to an unwritable path no longer half-breaks the mount**: the new path is created and verified writable BEFORE the live mount is touched — an impossible path now fails the edit dialog immediately with the reason, leaving the mount running exactly as it was (previously the failure only surfaced at reconnect, stuck between old and new paths — and the auto-remount after an edit swallowed its own failure, so the save even looked successful).
- **Auto-escalation for mountpoint creation** (user-approved): when `mkdir` hits a permission error, VibeSpace tries **non-interactive** `sudo -n mkdir -p` + `chown` back to the service user — containers with passwordless sudo (the fleet default; cephfs already relies on it) just work, and everywhere else it falls through to an honest error with the exact manual commands. A pre-existing root-owned dir gets the same chown treatment. `sudo -n` never prompts, so nothing can hang.
- CephFS mountpoint creation had a silently-swallowed mkdir failure — same helper now, error surfaced.

## 2.227.1

Standing rule adopted (user directive): **no user action may fail silently — every failure reports to the frontend.**

- **Read-only window Resume with incomplete identity now says so** (was a silent no-op that read as "VibeSpace is broken"): a toast explains the identity is incomplete and points at the sidebar card path.
- **i18n-check is quote-agnostic**: single-quoted dictionary entries were INVISIBLE to every check (dup/parity/params) — a mixed-quote duplicate of "this machine" shipped without a peep. Keys/values are now decoded before comparison; negative-tested (a mixed-quote dup hard-fails the build).
- CLAUDE.md: documented the create preflight wire contract (`code:'cwd-missing'` / `recreateCwd`), the `server-notice` probe channel, and `exited` reason+detail from classifyCliDeath.

## 2.227.0

- **Recreate-empty-and-resume for a deleted working directory** (B-7812, user-approved as an explicitly DANGEROUS option — born from userL's CRUD-worker session whose ceph folder was cleaned away while the 76MB conversation stayed intact). When a resume hits the 2.226.0 cwd preflight refusal, the window now offers a RED confirm: "Recreate it as an EMPTY folder and resume — every file the agent worked with there is GONE." Decline = the normal view-only rescue. Confirm = the server `mkdir -p`s the directory (local child process / remote probe channel, both hung-mount-safe), resumes, and — the user's hard requirement against silently continuing on a false premise — arms a one-shot `<vibespace-cwd-notice>` delivered to the agent on its next prompt: the directory was recreated EMPTY, files from earlier turns are gone, re-verify premises before acting. The pending notice survives server restarts (session meta). Refusals carry structured `code:'cwd-missing'` + cwd + machine name for the dialog. E2E smoke committed: `scripts/test-cwd-recreate.mjs` (real claude spawn, 10 asserts: refuse → recreate → meta persist → one-shot notice).

## 2.226.3

**System panel: history charts rebuilt + machine switcher + rail unbrick** (real report: charts stopped appearing, and once the System panel was open, no other rail panel could be selected):

- **Root cause — 2.223.1 was committed in a partial state**: the repo held a chart *draw* function with no DOM builder (so nothing ever created the canvases → charts silently invisible) and a `_panelDispose` calling a `_destroyRailSysCharts` helper that never existed — leaving the panel threw a TypeError on every rail click, permanently bricking panel switching. The working Chart.js version verified during that arc never fully made it into the commit.
- **Rebuilt as intended**: interactive Chart.js line charts (hover tooltips, index interaction), 1h/24h/7d range chips, per-chart current-value labels, point decimation (≤400), self-contained `Chart.register` (no dependence on the usage-dashboard module having registered first), and a real `_destroyRailSysCharts`.
- **Rail unbrick guard**: all three `_panelDispose` call sites now catch — a broken dispose logs + emits a `rail-dispose-failed` telemetry event and the switch still proceeds (this class can never freeze the rail again).
- **Machine switcher** (user request): the System panel gets a machine dropdown (This machine + every configured ssh/dial machine). Remote = live snapshot (memory/disk/$HOME filesystem/load/top processes) over the shared read-only probe channel, Linux + macOS handled, ~10s refresh; history charts stay local-only with an explaining note (the sampler runs in this server). `GET /api/sysinfo?host=<id>`.
- Committed regression smoke: `scripts/test-sys-panel.mjs` (worktree + CDP, 8 asserts incl. the switch-away/destroy/re-entry cycle).

## 2.226.2

- **Cloud-OAuth flows now work when the account lives in ANOTHER browser** (real report: connecting a Google Drive whose Google account is signed in in a different browser was impossible — all four OAuth entry points force-`window.open`ed the consent page in the CURRENT browser and never showed the URL). Every flow (Drive connect, Drive re-auth, Gmail, generic cloud providers) now always renders the auth URL as a copyable row ("Account signed in on ANOTHER browser? Copy this link and open it there") — any browser can complete the consent, then the existing paste-back relay (paste the failed 127.0.0.1 address) finishes it. A blocked popup now says so honestly instead of claiming a page opened, and the paste-back hint covers the different-browser case alongside the different-machine one.

## 2.226.1

- **Stopped/tmux/external session cards now carry the full icon corner language** (real report: "stopped session的角标显示都不全" — non-live cards rendered a bare backend glyph with no mode corner). The mode badge (bottom-right) now renders on EVERY card: live sessions show their running mode; tmux/external show terminal (they run in a real terminal); stopped cards show the mode the Resume button will use (the persisted per-session toggle, else `session.defaultMode`) — dimmed (`.mode-implied`, 0.6 opacity) to signal a non-live source, and the icon legend labels it "Mode (on resume)". Config corner dot and the no-dot-when-stopped rule unchanged. CDP-smoked: DOM asserts + screenshot.

## 2.226.0

**Silent-failure probe batch** (user directive "不要老是静默失败" — after two back-to-back incidents where the system knew why something failed and told no one):

- **Spawn-cwd preflight**: an EXPLICIT working directory that doesn't exist used to fall back to `$HOME` silently — for claude/codex that broke resumes ("No conversation found" from the wrong project dir) and misplaced new sessions. The create now fails fast with the honest reason ("Working directory does not exist [on the session's machine]: …"). Local probe = child-process `test -d` (never node fs on a possibly-hung mount, §2.108.3); remote = one bounded `_hostShell` round trip; probe error/timeout proceeds as before (only a definitive MISSING refuses). Shell terminals keep the home fallback. Live-smoked both cases.
- **CLI-death classifier**: known canned errors (not logged in / no conversation found / unknown option / invalid API key / credit balance / command-not-found on exit 126/127) become a machine reason + the matched line, tail-scanned from the buffer. The `exited` broadcast carries the detail — the chat read-only bar shows "Session ended. — <why>" and the terminal exited overlay prints it, instead of a bare dead window. Each classified death emits a `cli-death` telemetry event the admin collector groups fleet-wide. The unresumable circuit-breaker still arms independently of classifier precedence.
- **Agent-hook health probe** (born from the 2-day silent MODULE_NOT_FOUND hook outage): a registration that goes stale mid-run or points at a missing script now self-heals (re-register + regenerate) within 6h and notifies, instead of silently dropping every Stop/SessionStart/UserPromptSubmit delivery. The notice states that already-running CLI sessions pick the fix up only after restart/compaction.
- **`server-notice` channel**: generic probe→user path — server-side probes toast every connected client (+ notification history) and emit a keyed telemetry event, key-deduped per boot; an undelivered notice (no client connected) keeps its key so a later probe run retries.

## 2.225.2

- **Remote session resume failed with "No conversation found" — display cwd leaked into the spawn** (real incident: userL's h200 多轨TTS session): the sidebar merge composes a remote webui session's cwd as the folder-grouping DISPLAY string `"<host name>: /real/path"`; window openSpecs created from those records persisted it into layouts, and a later resume sent it as the spawn cwd — the daemon's `cd 'h200-cpu-02: /home/...'` silently failed, claude ran from `$HOME`, found no transcript in that project dir, exited code=1, and the unresumable circuit-breaker blocked further attempts for 10min. Fix: `stripCwdHostLabel` (utils.js) strips the label iff the remainder is an absolute/home path, applied at the client boundary (createSession/attachSession/viewSession — resume/fork/terminal-here all funnel through) plus a server-side twin at ws-handler create intake, which heals already-persisted polluted openSpecs and not-yet-reloaded clients immediately. The composed string itself stays — it is a load-bearing grouping/archivedFolders key (documented at the composer).

## 2.225.1

- **Throwaway servers can no longer hijack the machine's global agent-hook registration** (real incident, user-noticed as "Stop hooks stopped arriving"): a worktree smoke-test server booted under /tmp with the real HOME, and its startup `ensureAgentHooks` rewrote the hook command in `~/.claude/settings.json` (+ `~/.codex/hooks.json`) to its own `/tmp/vs-rail-smoke/...` path — after worktree cleanup every Stop/UserPromptSubmit/SessionStart hook errored MODULE_NOT_FOUND for two days. Because the claude CLI snapshots hook config per session, healing the file doesn't reach already-running sessions (they need a restart/compaction to re-read). Fixes: (1) `hookRegistrationSafe()` — a server whose code lives under the OS temp dir skips ALL global hook writes (register AND strip; `VIBESPACE_SKIP_AGENT_HOOKS=1` forces skip anywhere, `VIBESPACE_FORCE_AGENT_HOOKS=1` overrides); (2) all four worktree smokes (`test-sidebar-rail` / `test-stage-preview` / `test-stage-overlap` / `test-attach-rescue`) pass the skip env explicitly. Both layers verified live: a /tmp worktree server with no env logs the skip and leaves the global files untouched.

## 2.225.0

- **Icon legend popover** (user request): hovering a session card's backend icon opens a structured mini panel — instantly, no hover delay — decoding every corner badge for THAT session: backend identity, mode (bottom-right), connection state (top-right, with its color), and the custom-config summary (bottom-left purple dot: model/effort/permission/account). Replaces the icon's native title and the scattered per-dot tooltips.
- **Stopped sessions render a clean icon** (real report: the dim connection dot on stopped cards read as a rendering glitch — stopped is the default state and needs no marker). The connection corner dot now renders only for live/tmux/external; both icon variants normalized to a fixed 14px inline box so corner offsets land identically.

## 2.224.1

- **Custom-config indicator joins the icon corners** (user-directed continuation of 2.224.0's corner-badge language): the purple gear pill (~20px of row) becomes a 6px dot at the backend icon's BOTTOM-LEFT — the icon's corners now carry connection (top-right), mode (bottom-right) and custom config (bottom-left); the model/effort/permission/account summary lives in the dot's instant tooltip and stays live-updated on config changes.

## 2.224.0

**Session cards: structural narrow-width redesign** (user-directed — reduce the chrome's intrinsic cost first, hide only as a last resort):

- **Connection status merges into the backend icon** as a top-right corner dot (green live/tmux, amber external, dim stopped — the mode badge already proved the corner pattern at bottom-right). The standalone dot + gap leave the row; the icon tooltip carries the status label.
- **Star/archive stack vertically** in a ~14px left column instead of two side-by-side buttons (~44px) — same visibility and manage-mode mark behavior, roughly 37px returned to the title overall.
- Row gaps tightened 6→5px; ultra-narrow container-query ladder as the final tier (≤190px: icon-mode chips + ellipsized host badge; ≤160px: lowest-value badges drop so the title keeps priority).

## 2.223.4

- **User-state (stars / renames / archives) can no longer black out a tab** (real report: after a mobile round-trip, every rename showed as the first-message name and archived sessions "mysteriously" resurfaced — the server data was intact the whole time). The boot-time `/api/user-state` fetch was ONE-SHOT: failing during a server-restart window left the tab permanently stateless, and `_userStateFetched` was set even on failure, so a later star/rename POSTed the empty full document back over the server's real state (a silent clobber bomb — writes are full-doc). Now the fetch retries with backoff, the flag is set only after a successful apply (writes stay blocked until then), and ws reconnect re-applies the authoritative copy.

## 2.223.3

- **Manage-Agents helper commands survive broken login-shell PATHs** (fleet-wide incident: helper terminals run `bash -l`/`zsh -l`, `/etc/profile` resets PATH, and a home without `~/.local/bin` in `~/.profile` made the Update button's bare `claude update` die "command not found" — reading as "claude 没了" while the install was healthy). `/api/backend-status` now returns the server-resolved absolute `cmdPath` per CLI and local login/update helper commands are prefixed with it; remote hosts keep the bare name. The fleet image's boot script also idempotently ensures `~/.profile` re-adds `~/.local/bin` (PVC homes predate any skeleton).

## 2.223.2

- **Rail highlight/title no longer desync from the default tab on refresh** (real report): the rail restores the last-used panel from localStorage first, then the async `sidebar.defaultTab` one-shot switched the CONTENT only — highlight and header title kept the pre-refresh panel. The one-shot now syncs the rail chrome too. Precedence stays: an explicitly configured default tab wins over last-position; without one, last-position persists as before.

## 2.223.1

- **System history charts are interactive now**: switched to Chart.js (same hover/tooltip model as the Usage window) and split the panel into two lifecycles — the live zone (bars/load/processes) keeps its 5s refresh while the history zone rebuilds only on range change + a slow 60s tick, so the chart is never replaced under your cursor. Chart instances are destroyed before every rebuild and on panel dispose.
- **Top-process rows expand on click** (real complaint: long command paths were unreadable at any sidebar width): click toggles the full wrapped command; expansion state is keyed by pid so the 5s refresh keeps it open; server-side command capture widened 160→400 chars.

## 2.223.0

- **System rail panel: CPU/memory HISTORY charts** (what the 2.222.0 request actually meant — the admin panel's resource charts, in-instance; the token-usage chart it mistakenly added is removed). The instance self-samples container CPU (cgroup usage delta → cores; v2/v1/host fallbacks) + memory on the existing 45s watch into two rings — 24h fine + 7d at 15min — persisted to `data/sysinfo-history.json` (atomic, flushed on shutdown) so charts survive restarts. Panel shows Memory (scaled to the container limit) and CPU (cores) area charts with 1h/24h/7d range chips and current-value readouts. `GET /api/sysinfo/history?range=`. No Prometheus dependency — works identically on self-hosted/Docker.

## 2.222.0

- **Usage history in the System rail panel** (user request): a compact 14-day daily-cost bar chart from the permanent ledger (gap-filled scale, peak label, est. cost + token totals underneath) with an "Open Usage…" click-through to the full window. Hand-drawn canvas — no chart-library lifecycle in the rail; fetched once per panel render so the 5s sysinfo refresh never hammers the ledger scan.
- Rail smoke updated for the 2.216.0 system icon (the "8 items" assert had gone stale).

## 2.221.0

**Restart-survival audit: remaining findings implemented (B-e45a — 25 items across 5 parallel worktree clusters, all self-tested + merged + full smoke battery green).**

- **agentd/dial**: dial chat create honors `keeperSid` (adopts a surviving device-side claude instead of spawning a second writer) + probes the device pipe-session store on host-less resumes; the B-4058 pre-resume writer sweep is extracted into one shared script used by BOTH ssh and dial branches (with a new pipe-session-meta kill leg); per-session `VIBESPACE_API` back-tunnels re-own on every dial-in (persisted `dialReversePort`); `data/agentd/session-*.json` attach configs are unlinked at kill + age-swept at boot; the device daemon gains a keeper-parity pipe-session GC (7d, never touches a live child) and dial TERMINAL reconnects print an honest "this is a NEW session" marker instead of silently impersonating a continuation.
- **port-forward / machine-mounts**: published public URLs re-publish beyond boot's single attempt (heal sweep + onMachineLinked + stale-proxy unpublish on failure); push-mount reverse tunnels are verified end-to-end in the health sweep and re-owned with backoff.
- **in-flight integrity**: copy/move dest writes are staged (`.vs-partial` + rename) so a restart never leaves a truncated file at its final name; interrupted extractions journal to `data/extract-journal.json` and surface on retry; transfer polls that lose their op to a restart say so honestly; paste-image failures toast instead of dying silently.
- **client resilience**: new `WsManager.request()` request/reply helper (self-cleanup, watchdog, gated reconnect re-send) retires the one-time-handler leak class — create/attach/tmux-attach migrated; terminal reconnects repaint from the attach reply's buffer; SyncStore defends against server version rollback (full snapshot instead of a poisoned diff); a chat message sent into a dead ws keeps its draft + toasts.
- **server misc**: backend-id capture chains re-arm for restored sessions; subagent JSONL watchers restart after restore; pending Ctrl+G editor requests survive restarts; orphaned `rclone authorize` children are pre-flight-killed; `update.sh` is flock-guarded; pricing.json writes are atomic; permission answers are appended to the wrapper buffer so restart-rebuilt history keeps resolutions.

## 2.220.0

Backlog-clearing batch 1 (B-8194 / B-b4a2 / B-1525 second half):

- **Stage shared-hero null-key race fixed (B-8194)**: a hero staged before its backend id landed never published the shared-hero record (and nothing re-published later) — other clients' walk-over followed a stale hero. `stage.onIdentitySync()` (called from every identity merge) adopts the key once it exists, re-owns `__pending__` aux bindings, and publishes.
- **Home-rename auto-migration (B-b4a2)**: booting under a NEW `$HOME` (the 3.5.0 personalized-username fleet image) with leftover `-home-<olduser>-*` projdirs now auto-renames them to the new cwd encoding (merge-never-overwrite) and prefix-rewrites recorded paths in mounts/layouts/session-metas/task-groups (with `.pre-home-migrate` backups + a one-shot marker). Every future fleet roll self-heals instead of needing per-user surgery.
- **Boot auto re-adopt of orphaned keeper sessions (B-1525 second half)**: the `.orphan` metas preserved by 2.219.0 are now CONSUMED at boot — for each one whose remote claude is still alive under its keeper, the local transport half respawns attached to the same keeper sid. Attach ≠ create keeps it minimal and safe: no new claude (so billing/tools shipping are irrelevant), the original vsst_ token is reused so the remote agent's tools keep authenticating, and the tools back-tunnel is revived on the SAME port (read from the orphan claude's /proc environ). Capped 8/boot, host-down orphans are left for a later boot.
- Create-time session meta now records the tools back-tunnel port (`remotePort`) for future re-adopts.

## 2.219.1

- **Session cards tell the transport truth** (real confusion: Dallas sessions showed plain LIVE while the machine was unreachable). A remote session whose local wrapper is alive but whose HOST can't be reached now carries an amber dashed "host unreachable" chip (tooltip explains: reconnect retries automatically, sent messages queue and deliver when the machine returns). `remoteState` rides the active-sessions broadcast, updates live on every transport transition, and is restored from wrapper meta across server restarts.

## 2.219.0

Restart-robustness batch 2 — first slice of the 54-finding restart-survival audit (9-agent workflow, adversarially verified) + two live fleet incidents:

- **CRITICAL — dial sessions now survive server restarts**: the dial-bridge restore loop read session meta under a cw-stripped filename that NEVER matched, so no bridge was ever re-listened — every paired-device session died on any restart (wrapper reconnecting forever against a dead port). Fixed the key + the bridge is registered under the recorded webui id so terminate can find it.
- **Implicit-fork adoption** (userL's "对话在 compact recap 里有、窗口里不展示"): resuming a conversation still LOCKED by another live claude makes the CLI silently fork to a new session id; the 2.156.1 hijack guard vetoed the change, so VibeSpace kept tracking the old id while claude wrote the new file — live stream showed the turns, every rebuilt history lost them. An id change on the first id-bearing line of a RESUME spawn is now adopted (mid-stream changes stay vetoed).
- **Failed-resume window rescue**: resume closes the old read-only window before creating; a failed create left a spec-less "Create failed" shell that evaporated on refresh — silently losing the window from the layout (how "Mega Fish 训练" vanished). The shell now flips into view-only history + Resume with a real viewSession openSpec.
- **Transport flags survive restarts**: `agentdSession` + `forkRequested` persisted in session meta and restored; the ssh chat terminate script is now mechanism-agnostic (tries both the agentd state-file kill and the keeper stop — a restored agentd session's terminate used to no-op silently, leaving the remote claude running).
- **B-1525 first half**: dead-socket cleanup preserves REMOTE sessions' metas as tagged orphan files instead of deleting the only local record of their keeper/dial identity.
- Atomic `writeSessionMeta` (tmp+rename — the most-written store was the only non-atomic one); crash-path (`uncaughtException`) now runs the same flush belt as clean shutdown; telemetry flush added to shutdown.
- Restart continuity smalls: agent todo list + `/goal resume` state restored from metas; reconnect refetches maintenance state + settings (broadcast-only stores went stale across an outage); reattach safety timer 5s→30s (huge-transcript attaches lost their catch-up); unknown-prior-epoch reattach does a full view reload (silent message drops); read-only windows skip reattach.

## 2.218.0

Restart-robustness batch 1 (real fleet incident — host-less resumes of remote conversations):

- **Resume host inference**: a host-less claude resume whose transcript is NOT local but lives in the `data/remote-jsonl` cache under exactly one registered host now resumes ON that host automatically (pre-hostId-era window specs and rescued view-only windows used to spawn a doomed LOCAL `claude --resume` — four consecutive "No conversation found" deaths in the wild while the host was reachable).
- **Live-keeper double-writer guard**: before such an inferred remote resume spawns anything, `hosts.findKeeperFor` probes the host's `~/.vibespace/run` metas — if a keeper still holds a LIVE claude child for the conversation, the create ATTACHES to it (`keeperSid`) instead of starting a second writer on the same JSONL.
- **Unreachable-host memo (60s)**: with a session's host machine down, every view-only attach ate a full ~15s ssh timeout before the stale-cache fallback — a desktop of three such windows read as "blank/gone". After one timeout the transcript fetch serves the cache instantly for 60s; any successful probe clears the memo.

## 2.217.1

- **"Create failed" windows identify their session** (real report: a resume refused by the 2.207.1 no-transcript circuit breaker left an anonymous error shell — the user couldn't tell which conversation it was for). The failure fires before the window gets an openSpec, so the error path now stamps the attempted session name (or conversation-id prefix) into the title and prints the full conversation id + cwd in the body.

## 2.217.0

**Dead-session windows rescue into saved history (the 12-blank-windows class).** After the server loses its sessions (OOM kill, pod recreation), every saved-layout chat window replayed a stale serverId, the attach errored **before any ChatView existed**, and the one-time handler silently dropped — leaving bare blank window shells (real fleet report). Now:

- `attachSession`'s error path flips the window into the view-only pipeline in place (`_viewIntoWindow`, shared with `viewSession`): saved history renders + Resume bar. Works host-less — the server's transcript finder scans the `data/remote-jsonl` cache, so a remote session's history shows even with its host machine **down**.
- ChatView-side `_tryViewOnlyRescue` covers the reconnect-time variants (server restarted while the tab was open; 20s no-reply fallback).
- `syncSessionIdentity` now backfills `openSpec.hostId` from the live entry's `host` field (it read the nonexistent `hostId` key — a remote session's spec NEVER got its host recorded, so post-mortem fetches went host-less).
- `hosts.fetchSessionJsonl`: unreachable host + cached transcript → serve the stale cache instead of throwing (stale history beats none).
- Smoke: `scripts/test-attach-rescue.mjs` (worktree+CDP, 8 asserts — local-transcript rescue, host-less cached-remote rescue, no-transcript degradation).

## 2.216.0 — 2026-07-21
**OOM-kill prevention** (userL's instance hit its 32Gi pod limit — the kernel killed the whole pod, taking EVERY dtach session, with zero warning):
- **System rail panel** (new gauge icon): container memory bar (cgroup-aware used/limit/%), workspace disk bar, load average, and the top processes by memory — refreshes every 5s while open. The rail icon carries a % badge from 80% (amber) and turns red at 92%.
- **Proactive memory alerts**: the server polls the container limit every 45s and broadcasts a warning toast at ≥80% (error-styled at ≥92%) naming the top consumer — cooldown 30min per level, instant on escalation; also logged to opslog + a memory-pressure telemetry event. Kill the culprit BEFORE the kernel kills everything (orphaned dev servers already have a Kill button in Ports).
- Run-collapse polish: while pinned to the live tail, only the LAST run keeps an opened state — an accidentally/deliberately expanded run used to inherit the open flag as it grew and stay expanded forever. Reading history (unpinned) never auto-collapses.

## 2.215.3 — 2026-07-21
- **MCP tool calls join run-collapse** (user ask): a sixth kind in Card-kinds-that-collapse — any `mcp__*` tool card folds with the rest of the working noise (default ON; the browser-automation navigate/click/fill bursts were the reported pattern). The fold summary counts them ("8 次 MCP") and names the server when a run is single-server ("8 MCP (chrome-devtools)"). Approval-waiting MCP cards still never fold; failures still surface as the ✗ count.

## 2.215.2 — 2026-07-21
- **MCP tool cards de-uglified** (user report: `mcp__chrome-devtools__navigate_page` as a card header): MCP ids split into the SHORT tool name (underscores → spaces) plus a small server pill ("navigate page \[CHROME-DEVTOOLS\]") — applied to pending/completed/error card headers and the typing indicator ("running navigate page · chrome-devtools"). The raw identifier stays in the card tooltip.

## 2.215.1 — 2026-07-21
**userW's push-mount saga root-caused** (the new 2.214.1 error surfacing did its job — the retry showed rclone's real "Daemon timed out"):
- **Loop guard**: he was pushing `vibespace-machines/<Machine>-Downloads` — the PULL-mount mirror of that same Mac's Downloads — back onto the Mac. Every IO would cross the device link twice, so rclone's daemon can never come up. mountPush now refuses folders under any pull-mount mirror with the real story ("it already lives on that machine — open it there directly").
- **The original 502 explained and fixed**: mountPush's folder check was `fs.existsSync` — on a FUSE-backed folder with a stalled backend (his first attempt: a storage-mount path) that SYNC call blocks node's event loop, freezing the whole server → proxy 502 with zero logs (the 2.108.3 never-node-fs-on-mountpoints class). The check now runs in a child process with a 6s guard and distinguishes missing / unreadable / "backing storage stalled — reconnect it first".

## 2.215.0 — 2026-07-21
- **File copy/move gets live progress** (user report: a big — especially cross-machine — paste had zero feedback): pasting now runs as a polled server op with a progress row in the file explorer (same machinery as uploads/extraction: inline row + button ring + percentage + transferred bytes + cancel). Cross-machine relays count bytes directly on the stream; local and same-host copies poll the destination size; totals pre-computed via du (BSD fallback included). The row only appears if the operation outlives 400ms — small pastes look exactly like before. Conflict handling (confirm-once overwrite) unchanged. Verified live: 300MB local + 120MB cross-machine to a real ssh host with accurate byte progress.

## 2.214.1 — 2026-07-21
- **Machine-mount operations are observable and bounded** (userW's "HTTP 502" push-mount report — forensics found ZERO server-side trace of the attempt: mountPush/mountPull logged nothing and had no overall deadline, so any unforeseen stall in the device-link chain hung the HTTP handler forever and the proxy answered 502). Both now log the request, key milestones and the outcome with timing, emit machine-mount-push/pull-failed telemetry events, and race a 150s hard deadline — a stalled chain returns a real, actionable error ("device link may be stalled — wake the machine and retry") instead of a proxy 502.

## 2.214.0 — 2026-07-20
- **Memory file operations get their own card face** (user ask): a Write/Edit/Read recognized as an agent-memory file (via the per-backend memoryPathRe) renders as **记忆更新 / 记忆读取 <name>** — verb swapped, path display shortened to the file name (the full path stays behind the link: click still copies, Ctrl+click still opens). Applies to completed cards, pending (running) cards, Edit diffs, and Patch per-file changes.

## 2.213.3 — 2026-07-20
- **Codex memory paths recognized** — correcting 2.213.2's "codex has no memory feature" (wrong: a truncated directory listing). Codex 0.144.0 DOES have Memories (config-gated `[memories]`, developers.openai.com/codex/memories): background jobs distill rollouts into files under `~/.codex/memories/` (MEMORY.md, memory_summary.md, raw_memories.md, rollout_summaries/ — paths verified in the binary). File ops there now classify as the 'memory' collapse kind via `BACKEND_META.codex.memoryPathRe`.

## 2.213.2 — 2026-07-20
- Memory-path detection generalized: the agent-memory pattern moved from a chat-view constant into per-backend metadata (`BACKEND_META.<backend>.memoryPathRe` in agent-meta.js, unioned at use). Claude matches its auto-memory dirs (~/.claude/projects/<proj>/memory/ and ~/.claude/memory/); Codex 0.142.x has no memory feature so no entry; a future backend with a memory dir is ONE metadata line.

## 2.213.1 — 2026-07-20
- **Generic tool-card headers localize** (user report: TaskCreate/TaskUpdate read as unlocalized chrome): ~20 harness built-in tools get curated display names (创建任务/更新待办/网页搜索/…) in the card header AND the typing indicator's "running …" label; the raw tool name stays as the card tooltip. MCP/unknown tools keep their identifier; Bash/Agent/Workflow stay as-is.
- **Agent-memory file operations are their own collapse kind** (user ask: reads, writes and memory files are each a distinct concern): a new "memory" entry in Card-kinds-that-collapse covers reads AND writes under the agent's memory directory — housekeeping, folded by default (project-file writes stay visible by default), counted separately in the fold summary and still listed as memory/<name>.

## 2.213.0 — 2026-07-20
- **Run-collapse is now kind-configurable** (user request): new Chat setting "Card kinds that collapse" (`chat.collapseKinds`) — thinking / Bash / file reads / file writes each toggle individually (default: thinking+bash+read; writes stay visible — diffs are usually worth seeing). Enabled kinds still fold TOGETHER as one interleaved group (think → read → edit → run is the real work pattern).
- **The fold header keeps the information** (user ask): per-kind counts ("3 段思考 · 2 条 Bash · 4 次读取"), the touched FILE NAMES (✎ marks writes and lists them first; files under the agent-memory directory show as `memory/<name>` to distinguish them from project files; deduped, capped at 4 + "+N"), a `N ✗` failure count so errors never vanish silently into a fold, and the existing running… indicator. Toggling the collapse settings now re-folds open chats immediately (the observer only fired on new messages before).
- Fix: **the Stop-hook feedback card now obeys "Show hook cards in chat"** — the setting's description always promised stop reminders were covered, but the card never carried the hook class, so the toggle silently didn't apply (real report). Goal-check cards stay visible (goal progress is signal).
- Fix: **toggling compact mode re-renders open chats** — compact vs bubble is a per-message DOM structure decided at render time, so flipping the class alone corrupted already-rendered cards (real report: broken Update card after the switch).

## 2.212.1 — 2026-07-20
- Chat tool cards: the **Write** and **Read** card verbs were raw English next to Edit's translated 更新 (real report — a Write card and an Edit card of the same file rendered "Write" / "更新" side by side). Both now localize, incl. the pending (running) file-op cards.

## 2.212.0 — 2026-07-20
- **Title-bar right-click is now a full window menu**: the old direct overlap-switcher popup became its "Switch window" SUBMENU, with a new setting (Window → Title-bar "Switch window" scope) choosing what it lists — windows overlapping this one (classic, default), every window on the current desktop, or ALL windows across desktops (entries name their desktop; picking one switches there — tab-chain/stage/desktop aware via the new goToWinId). Session windows additionally get **Rename…** and a **Task Groups** bind/unbind submenu (same semantics as the session-card menu, incl. folder-derived entries shown disabled), plus the usual Move/Minimize/Move-to-Desktop/Close. The □ title-bar button keeps the classic overlap popup.
- **Taskbar window menus gained Rename… + Task Groups too** (taskbar items, grouped items, window-list rows — the shared menu).
- Fix: context-menu SUBMENU entries now honor `disabled` — a disabled submenu item used to fire its action anyway (the card menu's folder-derived Task-Group entries were never actually disabled).
- **i18n hygiene** (user ask — the accumulating build warnings): deduped 8 duplicate dictionary keys, two of which were REAL translation overrides shipping for weeks ("Vendor" 服务商→供应商, "Machine" 远程主机→机器 — in a JS object the later key silently wins everywhere); new `scripts/i18n-check.mjs` runs first in `npm run build` and HARD-FAILS on duplicate keys (zh/ja parity + lost-placeholder checks as warnings), so the warning pile can never re-accumulate. Menu strings fully translated (zh/ja).
- New CDP smoke: `scripts/test-window-menu.mjs` (13 asserts through the real menu paths).

## 2.211.0 — 2026-07-20
**Per-feature Integration toggles** (user request: inject shared context but withhold ask/progress). Four new settings under Integration, all default ON, applying only while the master switch is ON:
- `agents.contextInjection` — Task Group context payloads/diffs into agents (the per-group "Inject context" checkbox remains the finer grain). OFF falls back to the baseline tools intro.
- `agents.toolStatus` / `agents.toolAsk` / `agents.toolTask` — each agent tool individually. A disabled tool is neither TAUGHT (the injected tools section, baseline intro, per-turn reminder and stop-nudge steps all rebuild from the enabled set — teaching a command whose endpoint refuses would train agents into dead ends) nor SERVED (its write endpoints refuse with "disabled in settings — skip this step and continue; do not retry"). Turning off vibespace-status also silences the stop-time bookkeeping nudge (it is keyed on status staleness); reading group state (`vibespace-task show`) stays available while context injection is on.
- New route smoke: `scripts/test-tool-toggles.mjs` (21 asserts); existing prompt-context/context-diff/group-admin suites re-run green.

## 2.210.0 — 2026-07-20
- **`vibespace-task progress` success output now reminds the agent to say it in chat** (the vibespace-ask 2.111.21 pattern): real agents logged a deliverable (a URL, a path, a result) into the activity log and ended the turn without putting it in the reply — the log is agent-facing and invisible in the user's chat flow. The reminder states that anything the USER needs must also appear in the chat reply.
- **Stop nudge can now fire on EVERY stop**: `agents.stopNudgeStaleMinutes` / `stopNudgeCooldownMinutes` accept an explicit 0 (0 stale = board always considered stale; 0 cooldown = no per-session rate limit). With 0/0 the bookkeeping nudge fires after every turn — still capped at ONE mini-turn per user turn by the existing loop guards (claude stop_hook_active, codex nudgeTurnActive). Defaults unchanged (10/30).

## 2.209.0 — 2026-07-20
**Stage pile-at-slot rootfix** (userW's 超级重叠: Stage → normal desktop → Stage stacked every stage-born session at the hero slot, one more per round trip; reproduced 16/16 in a new CDP smoke before fixing, then all green):
- **enter() re-shows only the live workspace** (the remembered hero + aux bound to it). The old blanket re-show of every `_hiddenByStage` window resurrected every slot-parked ex-hero — sessions materialized while staged get parked hidden AT SLOT GEOMETRY by `_deactivateHero` and accumulate for the whole staged lifetime.
- **`_borrowHero` always snapshots a real home before applying the slot.** A window born while staged has no gridBounds at the synchronous creation-tail borrow, so the old `&& win.gridBounds` guard skipped the snapshot → hand-back kept the SLOT as the window's only geometry → the next borrow snapshotted the slot AS home (permanent degeneration, and the slot leaked into normal-desktop records). Now: pixel capture first, cascade fallback; `_handBackHero` additionally refuses to hand back slot-degenerated bounds (heals pre-fix field state).
- **`dm.switchTo` is stage-aware**: while staged every switch routes through `stage.leave()`, and `'__stage__'` is never a switch target (routes to `enter()`). A raw switchTo (add-desktop +, command-mode d/D, move-window, remote desktop updates) captured the stage's window set under `desktops['__stage__']` — lazily replayed later as REAL windows at slot bounds — and desynced `stage._active` from the active desktop. Client boot and the server's layout-sync handler both refuse new `'__stage__'` records and scrub persisted residue.
- **Remote desktop updates no longer disturb the stage**: stage-owned windows are exempt from deleted-desktop reassignment (any desktop create/rename/delete from another client used to retag the whole stage — placeholder included — onto a normal desktop), and a staged client is no longer force-switched off the stage.
- Belt fixes: a queued materialize aborts after leave(); leave() falls back to a live desktop when the remembered previous desktop was deleted remotely.
- New committed smoke: `scripts/test-stage-overlap.mjs` (16 asserts: slot-pile, accumulation, geometry degeneration, desktop leak, `__stage__` poisoning).

## 2.208.0 — 2026-07-20
- **New Session dialog lists subscription accounts for remote machines** (the START of userN's bootloop chain: with a host selected the account dropdown hid every named subscription, so the workflow became create-with-defaults → immediately switch billing → kill+resume of a conversation whose transcript never flushed → bootloop). The dialog now applies the billing switcher's exact semantics (2.198.0/2.199.0): an account email-LINKED to the host's own login or with a login dir HELD on the host is offered directly (suffixed "uses {host}'s own login" / "logged in on {host}", zero creds shipped), ship-opt-in accounts stay offered when enabled, and unusable ones render DISABLED with "not logged in on {host}" instead of silently vanishing — the omission is what taught users the doomed workaround.
- **Host-held subscriptions now spawn on DIAL devices too** — the dial guards (terminal + chat) rejected ANY non-key account with a misleading "shipping not implemented" error even when the device itself held the account's login dir (~/.vibespace/subs/<id>, minted by an on-device login). A held account now rides a shell prefix assignment pointing CLAUDE_SECURESTORAGE_CONFIG_DIR at the device-side dir — nothing ships, §ban-safety untouched.

## 2.207.1 — 2026-07-20
- **Unresumable-conversation circuit breaker** — the 2.207.0 tooling caught its first live bootloop within minutes of shipping (tombstones nailed the cause in one read: `No conversation found with session ID` — a remote session killed 9 seconds after creation never flushed a transcript, so every resume died in ~2s and an automated recreation fed the loop 5× in 2 minutes). Teardown now stamps a conversation whose buffer carries that canned error; further resumes are refused for 10 minutes with the honest explanation ("no saved transcript on its machine — nothing to resume; close this window/card") instead of another guaranteed death. `resume-refused-no-transcript` telemetry event + opslog warn.

## 2.207.0 — 2026-07-20
**Debuggability telemetry batch** (user ask, scoped to exactly what blinded tonight's three investigations; all names/enums only — never content — flowing into ⚙ Diagnostics + fleet forwarding):
- `session-created/exited/killed` events (mode/backend/remote/resume; exited carries the CHILD's exit code — both wrappers now keep their final meta WITH `childExitCode` instead of unlinking it, and the server reads it at teardown into the lifecycle log + event).
- **Crash-loop detector**: ≥3 creates of the SAME conversation within 10 minutes fires `session-crash-loop` + an opslog warn — the userN incident (4 restarts in 3.5 min) would have flagged in real time.
- CLI error classes: `cli-usage-limit` (a "You've reached your … limit" turn) and `cli-model-fallback` (from→to) — frequency data for capacity-night triage.
- `perm-mode-refused` (the CLI refused a mid-session mode switch) and `host-probe-failed` (ssh/dial) — the silent failure modes behind two of this week's "looks like a data bug" reports.

## 2.206.2 — 2026-07-20
- Hotfix: the 2.206.1 tombstone referenced a nonexistent DATA_DIR constant inside its try/catch — it would have silently never written (the exact silent-failure class it exists to catch). Path corrected + logic unit-verified.

## 2.206.1 — 2026-07-20
- **Exit tombstones**: on real session teardown the buffer's last 64KB is kept for 7 days in `data/exit-tombs/<id>.tail` before the buffer is unlinked — a crash's stack trace/stderr lives ONLY in the buffer, and deleting it on exit blinded three "why did this session die" investigations in one night (forensics upgraded the black-window incident to a claude that CRASH-LOOPED 4× in 3.5 minutes — config-backup + MCP-log startup timestamps prove the restarts; OOM ruled out via cgroup counters — with zero process-level evidence left). Correction to the 2.206.0 note: the usage-limit error was the last turn's visible symptom, NOT the exit cause; the exit overlay + lifecycle logs + tombstones together make the next occurrence diagnosable.

## 2.206.0 — 2026-07-20
- **A terminal session whose process exits no longer leaves a dead BLACK window** (real report, forensically reconstructed: a TUI claude hit "You've reached your Fable 5 limit", exited, and cleared its alternate screen on the way out — the window was pure black with one invisible dim line, the session vanished from ACTIVE, and the only path forward was noticing the stopped entry in the sidebar; no VibeSpace data was lost — the resume worked perfectly). Terminal windows now show a prominent **end-of-session overlay** ("Session ended — the process exited") with a one-click **Resume this session** (openSpec identity, geometry kept; plain shells get the message only) — parity with chat's resume bar. Applies to live exits AND the reconnect-found-dead path.
- **Session lifecycle reaches the ops log** — `[session] created/exited/killed` lines with name/mode/backend/host/account/resume: tonight's forensics twice found ZERO trace of a session death in opslog; incidents need at least this breadcrumb.

## 2.205.0 — 2026-07-20
- **Same-account auto-recognition** (the "这个不能自动识别吗" ask): a login whose identity email matches an EXISTING subscription record is the SAME account — records now merge automatically instead of duplicating. Two triggers: the local add-flow's finalize (fresh creds fold into the existing record, which keeps the newest login; toast says "recognized as existing account — merged"), and every host identity probe (a host-side per-account dir whose email matches a different record renames the dir to the survivor and folds the records — so an existing duplicate like the reported ProblemFactory pair SELF-HEALS the next time the machine's roster is opened). Learned dir emails also backfill records that never declared one (enabling the =host-login link). Survivor = the older record; union of host logins; merge is best-effort per dir (a failure keeps both records rather than losing anything).

## 2.204.0 — 2026-07-20
Closing the per-host login loop (user's A/B comparison: the ⋯ "Log in on \<host\> as this account…" path displayed perfectly, the "+ Add account" host path duplicated an existing account and read "not logged in" on the local view):
- **The add menu (machine selected) offers EXISTING subscriptions first** — "Log in on \<host\> as \<name\>…" per account not already on that machine (never mints a duplicate record), then "New subscription — log in on \<host\>…" for genuinely new accounts.
- **Host logins are remembered on the account record** (`hostLogins`, written through from every host identity probe, cleared when a probe stops listing the account) — so the LOCAL view (which probes no host) now shows "logged in on \<host\>" instead of a bare "not logged in" for host-only accounts.

## 2.203.0 — 2026-07-20
- **Host-held subscription logins actually spawn now** (the 2.199.0 flow's missing last mile, caught live: the roster proudly said "logged in on the devbox" while picking the account for an the devbox session failed with "subscription not logged in" — `resolveForSpawn` throws on the EMPTY local dir before the hostSubs mapping ever ran). The create handler now catches that specific failure for remote spawns, probes the host, and on a hostSubs match builds the spawn against the host-side dir directly. UI follow-ups: a host-held account no longer shows the contradictory local "not logged in" next to "logged in on \<host\>" (the host tag carries the state), and Test works for host-held accounts (the local-loggedIn guard exempts them).

## 2.202.1 — 2026-07-20
- The API-key "master copy" tag reads **"master held by VibeSpace"** — the bare tag rendered in EVERY machine view (the roster is one shared list), which read as one master per machine ("俩主副本是吧"). The reworded tag states the view-independent fact.

## 2.202.0 — 2026-07-20
Account roster polish (user's 4-point list):
- Provenance + note tags move to their OWN second line under the identity (`.acct-key-extra`, flex-basis wrap) — inline they squeezed the tail into an ellipsis mush.
- API-key rows carry a dim **"master copy"** tag (tooltip: VibeSpace holds the master; sessions get derived working copies on their machines, swept on removal) — makes the copy model visible where it matters.
- **"Show key…"** in the ⋯ menu reveals the decrypted key value (GET /api/accounts/:id/key, cookie-authed — the mounts-config trust model) with a one-click Copy: the store is the master copy and the Anthropic Console can never re-show a key, so users need a sanctioned way to save it elsewhere.
- (The 2.201.2 removal-confirm translation applies on a page refresh — the screenshot in the report predated the fixed bundle.)

## 2.201.2 — 2026-07-20
- The API-key removal confirm is translated (the 2.201.1 string missed the dictionaries — straight-vs-curly quote mismatch between the code key and the dict key, the §16 class) and its wording no longer contradicts the account model: it now says the roster deletes the **master** copy held by VibeSpace AND sweeps the per-session **working copies** placed on hosts — "one copy" and "copies on machines" were both true at different layers, which read as a contradiction.

## 2.201.1 — 2026-07-20
- **Removing an API-key account warns with the real stakes** (real incident, minutes after 2.201.0: the rescued Console key was removed "from the local view" — but the roster is ONE shared list, so it vanished from every machine's view, and Anthropic's Console never re-shows an existing key's value; recovery relied on a rotating CLI config backup that was hours from expiring). The confirm now states: the stored copy is deleted everywhere, the Console cannot re-show it, save it elsewhere first. Subscription removals keep the milder wording (their creds dirs are re-creatable by logging in again).

## 2.201.0 — 2026-07-20
- **Account provenance is visible** (real ask: a key imported from a host read as "shared from the devbox" with no marker). Host key imports now stamp `originHost`, rendered as a dim **"from \<host\>"** tag whose tooltip states the real semantics: an independent COPY held in VibeSpace, not live-linked to the machine it came from, usable anywhere. Every account also gets a free-text **note** (⋯ → "Set note…", ≤120 chars) rendered as a small tag — e.g. "from laptop backup" on a rescued key. Management stays enabled everywhere deliberately: the record is a store-owned copy, and locking it to a machine would re-introduce the confusion the tag resolves.

## 2.200.0 — 2026-07-20
- **"Add subscription" with a machine selected now logs in ON that machine** (the actual root of today's "my subscription got moved to the local machine" confusion, caught from the user's terminal-title screenshot: with the devbox selected, "+ Add account… → Add subscription" quietly opened the login terminal LOCALLY with the LOCAL store path — the account the user believed they were logging in "on the devbox" landed in the local store, tagged this-machine-only). The menu item now reads **"Add subscription (log in on \<host\>)…"** and runs the login on the host into the account's per-host creds dir (the 2.199.0 mechanism — token minted on the host, never leaves it; the account record still lives in VibeSpace as the machine-independent identity). The login watcher picks up the landing and the account immediately shows "logged in on \<host\>". No-host-selected keeps the classic local flow.

## 2.199.0 — 2026-07-20
- **Per-account subscription logins held ON a machine** — the multi-subscription isolation model, extended to hosts (real ask: "Fish Max was logged in on the devbox too — I want it usable there", where the machine's single global login can only BE one account at a time). A subscription's ⋯ menu (with a machine selected) gains **"Log in on \<host\> as this account…"**: an on-host terminal logs the account into its own isolated creds dir (`~/.vibespace/subs/\<id\>` — the token is minted ON that machine and never leaves it, the same §ban-safety-clean pattern as the machine's own login; the machine's global login is untouched, the two coexist). Once landed (the login watcher detects it): the roster tags the account "logged in on \<host\>", the billing switcher enables it, and spawns point the CLI at the host-side dir (`CLAUDE_SECURESTORAGE_CONFIG_DIR`) with zero credential shipping — the server re-verifies the dir live at spawn. Clarifies the whole account model: a NAMED account is an identity; its logins are per-machine and each token stays where it was born.

## 2.198.0 — 2026-07-20
- **A named account that IS the machine's own login is now usable on that machine** (real report ×2: "I logged this exact account in ON the host, yet the roster still says this-machine-only / the switcher greys it"). Same-account detection by email (named account's email — or its email-shaped name — vs the host's own login identity, reliable since 2.197.0): the Manage-Agents rosters (Claude AND Codex) tag such an account **"= \<host\>'s own login"** instead of "this machine only", the billing switcher enables it with a "uses \<host\>'s own login" note, and the SERVER maps the pick at spawn — an explicitly-chosen subscription on a remote host without the ship opt-in now probes the host identity and, on a match, runs on the host's own login directly (zero credentials shipped, §ban-safety unchanged; a non-matching account still errors with guidance). Also covers Test and the global default on linked hosts.

## 2.197.0 — 2026-07-20
- **Host identity probes were blind on indented configs — fixed.** `hosts.accountsStatus`/`cliPrimaryKey` grepped `"primaryApiKey":"…"`/`"emailAddress":"…"`/`"id_token":"…"` with NO space after the colon, but the CLI writes `~/.claude.json` (and codex's `auth.json`) as INDENTED JSON on most machines — so for months the Manage-Agents host roster reported `cliKey: absent`, `email: null`, codex identity null on such hosts. Field consequences now explained: "Import its key" never appeared for a Console-logged-in host (one user's Console key was later orphaned by an OAuth `/login` switch — recovered from the CLI's own `~/.claude/backups/` rotation, which keeps ~5 six-hourly config snapshots), and host CLI-login rows showed no email even when the config had one (part of the "old identity" confusion fixed in 2.195.0). All patterns now tolerate `": "` (grep + parse sides); verified live on a real ssh host — email/codex-plan/key detection all light up. Transcript-JSONL greps are unaffected (stream records are compact by construction).

## 2.196.0 — 2026-07-20
- **Helper terminals no longer get their auto-typed command mangled** (real report: "Log in on the devbox" typed `claude /login`, oh-my-zsh's rc-time "Would you like to update? [Y/n]" ate the first char → `laude /login: command not found`). The ShellAdapter has had a `DISABLE_UPDATE_PROMPT` guard for exactly this since it was written — but the client's create message NEVER sent `initialCommand` to the server, so the guard was dead code on every machine. The field now rides the create → `buildSessionArgs`, and the env pairs reach REMOTE shells too via the `exec env` spawn prefix (ssh and dial).
- **"Log in on \<host\>…" now confirms before switching the machine's login** (real report: the button reads like "add account", but it runs the CLI's `/login` ON the machine and REPLACES its current login). The confirm dialog spells out the semantics and points at "+ Add account…" for the add-an-account intent; if the machine currently holds a not-yet-imported Console API key, confirming imports it into VibeSpace FIRST so the swap can't orphan it. Codex host-login gets the same confirm.

## 2.195.0 — 2026-07-20
Three field reports from one remote-host user (Novita-H200/CW-H200), root-caused with live CLI 2.1.215 experiments:
- **Mid-session permission-mode switching is honest now.** Live testing: `set_permission_mode` works mid-session for default/acceptEdits/plan and acks success — but the CLI REFUSES switching a running session to `bypassPermissions` unless it was LAUNCHED bypass-capable (clean error control_response), and 2.1.215 emits a fresh `system/init` on EVERY user message re-stating the effective mode. VibeSpace's fire-and-forget switch swallowed the refusal, so the optimistic badge flipped back on the next message and the user read "switching is broken; only global-default + restart works". Now: the switch is TRACKED (request id → the CLI's verdict); success adopts + persists the mode server-side (`session._permissionMode` + meta — attach/chatStatus/resume stay truthful; it also persists as the session's per-session permission so resume respawns with it) and the refusal reverts the badge + offers the working path in one click: **"Restart in bypassPermissions?"** (kill + `--resume` with the mode as launch flag, geometry kept — the billing-switcher dance). The per-message init's `permissionMode` is also harvested as a server-side self-heal. Test: `scripts/test-permission-mode-ack.mjs`.
- **Manage Agents no longer jumps to another machine mid-flow.** Root cause: `Sidebar._render()` wiped the list BEFORE dispatching to the rail panel, defeating `_renderRailPanel`'s renders-once guard — every session-list digest change (e.g. the login helper terminal appearing/exiting) rebuilt the Agents panel with a fresh closure and reset the Machine dropdown. The dispatch now runs before the wipe (the panel survives digest churn — also preserves unsaved Agent-instructions drafts), and the machine pick persists app-level (`_agentsHostPref`, roster-validated) so every reopen/rebuild restores it.
- **Logging in ON a host is now visible + usable.** Verified on the reporter's actual host: the "Log in on \<host\>…" flow DID run remotely and the OAuth login DID land (creds written 25s after the terminal opened; token's org confirmed as the new account) — but no surface ever said so: the roster kept showing the OLD identity because the cached roles-derived `orgEmail` (a pre-login quota-⟳ snapshot) beat the live probe indefinitely (and the host's own `~/.claude.json` carries no email after a login — the 2.114.1 class), so the user assumed the login failed and went on to "Add subscription" — which by DESIGN runs locally and produces a "this machine only" account, whose disabled rows + toasts then read as "logged in yet unusable". Now: a login watcher (read-only ssh probe, no API calls) detects the on-host login landing and brings the Agents surface back **on that machine**; the cached identity is only trusted until a detected login, after which the row shows an amber "login changed — ⟳ to confirm" with a per-row ⟳ (the same single human-gated on-demand roles/quota call — deliberately anchored on the LOCAL detection stamp, not creds mtime, which the CLI rotates on normal token refresh and which clock-skews); `accountsStatus` reports creds mtimes (GNU-else-BSD stat) for the watcher's change detection. The billing switcher's disabled-subscription reason and the Manage-Agents toasts now say the succeed-path out loud: *if you've logged this account in on the host, pick "CLI login @ \<host\>" — that uses the host's own login.*
- Review hardening (2 adversarial reviewers, 6 confirmed findings fixed): the permission ack is broadcast — only the INITIATING client (optimistic pick in flight) pops the restart dialog / acts on refusals, so a second tab never offers an unsolicited restart (double kill+resume flap); rapid re-picks can't corrupt the revert baseline (prev captured once per in-flight pick, cleared on any authoritative set); a successful mid-session mode is deliberately NOT persisted as the launch override (the CLI moves modes itself — plan → acceptEdits on approval — and a frozen 'plan' override would relaunch every resume into plan); the login watcher baselines on its first successful probe (a transient probe failure or the login terminal's own startup token refresh no longer false-fires "login updated"), respects a machine the user explicitly switched to meanwhile, and forces the refreshed surface onto the login's machine (not whatever the dropdown last showed); the Ports panel rebuilds on `hosts-updated` now that the renders-once guard is real (pair/unpair while open used to heal only via the incidental digest rebuilds this release removed).

## 2.194.0 — 2026-07-20
- **A PDF Read no longer bursts N bare "notification" cards into the chat** (real report: a 10-page Read → 10 empty "通知" rows). Root cause reproduced against a live claude 2.1.x stream: the CLI ships the extracted pages into model context as image-only user records — LIVE as one `isSynthetic:true` event PER PAGE (each classified as a notification and, having no text, rendered as the bare fallback label), in the JSONL as one `isMeta:true` record with N image blocks (which the history rebuild rendered as a giant "You" bubble — also wrong). The normalizer now coalesces consecutive CLI-injected page records into ONE `imageAttachment` message (create + edit ops, no turnIndex bump — it's not a conversation turn, so no minimap marker either) and both live and rebuilt paths render a single compact collapsible **"Attached pages (N)"** card: pages show as 300px thumbs on expand (scroll-capped body), click-to-zoom via the standard image overlay. Real user image pastes (typed / unflagged) are untouched. Regression test: `scripts/test-page-attachments.mjs` (13 asserts: live burst coalesce, edit-op re-render gate, history single-record, paste immunity, run boundary).

## 2.193.0 — 2026-07-19
The four remote gaps parked by the 2.192.0 audit, now built (user: 全部解决):
- **Image paste into a REMOTE terminal works** (was a silent no-op — the server set ITS OWN X clipboard, which the remote CLI can never read). /api/paste-image now resolves the session's host server-side: the image lands on the host at `~/.vibespace/paste/paste-<ts>.<ext>` via RemoteFs and the client types the shell-escaped remote path into the PTY (the drag-drop model) instead of sending Ctrl+V.
- **Ctrl+G split-pane editor works in REMOTE terminal sessions**: the fake `code` helper ships per-spawn to `~/.vibespace/editor/` (deliberately OUTSIDE the PATH dir — its basename must be `code` for claude's GUI-editor check, but shadowing a real vscode `code` would hang any `code …` shell command); the remote env sets `EDITOR` + `CLAUDE_WEBUI_PORT=<reverse-tunnel port>` + `CLAUDE_WEBUI_SESSION_ID`, so the helper's POST rides the existing tunnel with vsst_ auth; /api/editor/open resolves the session's host and the client editor reads (`/api/file/content?host=`), saves (`/api/file/write` host) and signals (`/api/editor/signal` → RemoteFs writes the signal file on the host) the right machine. ssh AND dial covered. Integration master switch OFF ⇒ no tunnel ⇒ remote Ctrl+G degrades to the CLI's default (documented trade).
- **Codex remote sessions are discoverable and viewable**: discovery (ssh script AND the dial daemon snapshot) now lists `~/.codex/sessions` rollouts (GNU-else-BSD portable) with head-cwd enrichment → stopped codex sessions reappear as resumable cards (they used to vanish forever when they ended); `hosts.fetchCodexJsonl` (the `_fetchRemoteByFind` core with a parameterized root) pulls a thread's rollout into `data/remote-jsonl/<host>/codex/` and `findCodexSessionJsonlPath` scans that cache — view-history/resume-load work remote; ws attach + viewOnly + /api/session-messages prefetch are backend-aware. Verified live: the devbox exposed 32 real codex rollouts with cwds, a 16.5MB rollout fetched end-to-end, finder resolves the cache.
- **Restart dedup uses a real liveness signal for remote conversations**: the /proc fd scan can't see a claude on the host, so among duplicate sockets of one remote conversation the wrong one could be retired — remote entries now use the local dtach-socket owner check (the transport survived) as their alive bit.

## 2.192.0 — 2026-07-19
**Local-vs-remote parity sweep** (user-requested audit of the 2.191.0 bug class: 5 parallel auditors, 29 findings → 15 fixed here, 4 parked). The fixed gaps, worst first:
- **Resume/Fork of a remote session no longer runs on the WRONG machine**: the terminated-window Resume bar, Fork (incl. fork-from-message), the Ctrl+K palette (keeperSid), Task-board Resume-all, the explorer folder menu's session submenu, and layout-restore's dead-session fallback all dropped `hostId` — each spawned a local `claude --resume <remote-id>` (double-writer class) or silently lost the window. All thread host/keeperSid now.
- **Chat Stop button can no longer kill a remote session's transport**: the 2s SIGINT fallback fired at `_childPid`, which for remote sessions is the LOCAL ssh-keeper pipe / agentd bridge — not claude. Remote sessions now rely on the protocol interrupt alone.
- **macOS/BSD ssh hosts work**: remote discovery + the file explorer listing used GNU-only `find -printf` (errors swallowed by `2>/dev/null` → empty history / every folder "empty"); RemoteFs info/stat used GNU `stat -c`/`du -sb` (size 0, binary files as mojibake); the B-4058 pre-resume orphan sweep was /proc-only (silently swept nothing). All now probe GNU once and fall back to `stat -f`/`lsof`+`ps` (verified with a BSD find/stat shim + real-ssh GNU regression).
- **Explorer upload retry keeps the host** (the resilient per-file retry after a failed multipart posted to the LOCAL server at the remote path — silent wrong-machine landing).
- **File links in view-only/terminated remote chat windows resolve on the right machine** (the renderers' live-list lookup lost host+cwd for `view-…` windows; they now use ChatView's openSpec-backed identity).
- **Session Properties "Agent steps" works for remote sessions** (/api/session-todos gained ?host= transcript prefetch).
- **/goal met-detection for remote chats** kicks a throttled (30s) transcript refresh so goal_status attachments are seen.
- **`~/…` upload dirs land correctly on ssh hosts** (a single-quoted `~` never expands — files went to a literal `~` directory; path quoting is now tilde-aware across write/mkdir/rename/copy/info/stat).
- **Explorer→terminal drag refuses cross-machine paths with a toast** (typing a remote-A path into a local terminal handed the agent a plausible nonexistent — or wrong same-named — file).
- Host bootstrap tries Homebrew for dtach on Macs before the Linux package managers.
Parked (backlog): remote-terminal image paste (upload+type-path design), remote Ctrl+G editor, codex remote-session discovery, restart-dedup's remote liveness signal.

## 2.191.0 — 2026-07-19
Three remote-session gaps from one field report (CW-H200):
- **"Logged in with OAuth but the session says API billing — apiKeyHelper" is now explained everywhere it appears** (root cause verified by disassembling the CLI 2.1.211 binary: a configured `apiKeyHelper` in the merged settings UNCONDITIONALLY disables claude.ai OAuth auth — fresh valid creds or not — so the badge was truthful and the Manage-Agents "logged in" was the misleading surface). `backendStatus`/local `/api/backend-status` now report helper presence as an INDEPENDENT flag instead of the last rung of an elif ladder; Manage Agents (backend row + host roster row) shows an amber "⚠ apiKeyHelper overrides this login" with the unset-guidance whenever both are present; the billing switcher labels the CLI-login entry "· apiKeyHelper (API)" and adds a why-row explaining that no switcher pick can override the CLI's own precedence. Remedy on such a host: remove `apiKeyHelper` from `~/.claude/settings.json`, then resume the session.
- **View Workflow works for REMOTE sessions** (was "workflow not found" — /api/workflow only scanned the local ~/.claude/projects). `hosts.fetchWorkflowState` = one read-only compound probe over the machine link (ssh multiplexed / dial runCmd; GNU-else-BSD stat so macOS devices work; nonce-delimited payload; 2s TTL cache under the viewer's 2.5s live poll; payload capped under dial's 1MB stdout slice), feeding the same decision tree as the local path via shared pure cores (`journalAttemptsFromText`/`liveWorkflowFromParts`); host rides the openSpec/status-chip poll/stage replay probe. Per-agent **View Log** also works remotely: `hosts.fetchAgentJsonl` (the fetchSessionJsonl cache/invalidation core, generalized into `_fetchRemoteByFind`) pulls the agent transcript into the local cache and the `sub-agent-` attach reads it. Verified: probe e2e against a real ssh host, full parse against real workflow artifacts (targeted + find-fallback tiers), refactored fetchSessionJsonl regression (4.2MB real transcript re-pull), route-level local regression on a throwaway server.
- **Terminate finally works on remote EXTERNAL sessions** — the server-side remote kill (killRemotePid, 2.161.0: cmdline-verified, dial/ssh, cache-invalidating) was unreachable because remote discovery DROPPED the pid; the confirm dialog ended in a silent no-op (neither `webuiId` nor `pid` present). The lock's pid now rides discovery → card session; on success the client force-refreshes that host's sidebar zone so the card flips to STOPPED without a manual ⟳. Verified: the devbox discovery now carries pid.

## 2.190.1 — 2026-07-19
- **Integration master switch scope corrected to AGENT-VISIBLE integration only** (user decision: "不会被agent看到的消息不算集成"). The passive usage statusline is model-INVISIBLE plumbing — it renders in the TUI and writes data/usage-cache locally, the model never sees it — so it is no longer gated by the switch (usage meters keep working while OFF; the 2.190.0 "statusline residue" caveat is gone because there's nothing to residue). Billing/account env was already exempt. The switch's contract is now crisp: OFF removes exactly what the MODEL could see or use (hooks/context injection/agent tools/task reads); model-invisible plumbing (statusline, billing env, Ctrl+G editor, session persistence, remote transport) works identically in both states. Setting description + docs reworded accordingly.

## 2.190.0 — 2026-07-19
- **Settings gains a dedicated "Integration" section with a MASTER SWITCH for the whole VibeSpace agent integration** (`agents.vibespaceIntegration`, default ON; user request — verify CLI behavior with zero VibeSpace involvement, e.g. when investigating whether an injection/hook affects the model). OFF = pristine claude/codex: the hook registration is stripped from `~/.claude/settings.json` + `~/.codex/hooks.json` IMMEDIATELY (restored on re-enable — unless the hook was removed manually in Manage Agents, that narrower opt-out still wins; a settings flip while the server is down converges at next boot), new sessions spawn with **no `VIBESPACE_API`**, no agent-tools PATH (ssh prelude AND dial shellCmds), no statusline usage injection, no remote tools/hook-register/reverse-tunnel (the transport keeper still ships for remote CHAT — persistence is not integration; remote TERMINAL ships nothing), and already-running sessions go pristine mid-flight too: task-context / prompt-context / stop-check return empty (pending status-override notices are consumed-and-dropped, not deferred) and `GET /api/agent/task` refuses (it carries the same steering substance — `vibespace-task show` must not bypass the switch). Known residue: a terminal session spawned BEFORE the flip keeps its spawn-time statusline until restarted (documented in the setting text). `VIBESPACE_SESSION_TOKEN` deliberately stays in the spawn env: `data/bin/code` (Ctrl+G) authenticates with it, it is never model-visible, and every agent tool/hook/wrapper guards on api+token so token-alone is inert. All existing `agents.*` settings moved into the new Integration category. Manage Agents: local row shows "Disabled — master switch is off"; the HOST row still shows the on-host state (residue visibility) but withholds Install and keeps Remove as cleanup; BOTH install routes (local + `/api/hosts/:id/agent-tools/install`) refuse with guidance. An 8-angle adversarial review of the diff drove the mid-flight gates, the dial-PATH fix, the host-row/route parity, and a `syncHookRegistration()` single convergence rule for boot + live toggle. E2E: `scripts/test-integration-toggle.mjs` (throwaway worktree server + fake $HOME — hook register/strip/re-register live + at boot, spawn argv in both states, empty deliveries + task-read 403 for a pre-toggle token).

## 2.189.1 — 2026-07-19
- **Maintenance mode shows LIVE troubleshooting progress** (user request — a frozen banner still leaves the user anxious about what's happening). `POST /api/maintenance {update:"…"}` appends a progress line: the banner shows the latest one (pulsing in as it changes, so the work visibly moves), a "N updates ▾" button expands the full timestamped timeline, and each update EXTENDS the auto-expiry (≥1h from the update, hard cap 24h from start — active troubleshooting can't expire mid-work). Timeline caps at the newest 50.

## 2.189.0 — 2026-07-19
- **Maintenance mode** (user request): when an operator/support agent is actively connected to an instance troubleshooting it, a persistent amber strip across the top says so — transparency for onsite debugging. `GET/POST /api/maintenance` (cookie-authed): `{on:true, message?, by?, hours?}` sets it (default 2h, max 24h, **auto-expires** so a forgotten toggle can't linger), `{on:false}` clears; state persists in `data/maintenance.json` (survives the server restarts troubleshooting tends to involve) and broadcasts live (`maintenance-updated`). The strip is a normal flex child of `#main-wrapper`, so the workspace reflows under it. Verified e2e on a throwaway server (enable → banner with message + since-time on a fresh page load; disable → gone).

## 2.188.3 — 2026-07-19
Residual-observations sweep (real reports from the day's sessions):
- **A remote session card's machine prefix can no longer vanish from its path line** (real report: one CW-H200 card showed "CW-H200: /path" and its sibling just "…/userN/mega-fish" — was it local?). The Active-zone card path ran `abbrevPath` over the host-prefixed cwd string, eating the "CW-H200: " prefix on deeper paths; and its baked "…/" never un-truncated when the sidebar was widened. The host now renders as its own never-truncating span and the path left-truncates via pure CSS (rtl, same trick as `.session-card-cwd`), so width changes re-evaluate naturally.
- **A chat window whose session silently vanished across a server restart flips to read-only + Resume bar** instead of sitting with a live-looking input that answers nothing: if a reconnect re-attach gets neither `attached` nor `error` within 20s (the create-in-flight-during-restart case holds an id the new server never answers for), the window resolves itself.
- **Local-command echoes strip ANSI** ("Set model to `[1m`opus`[22m`" rendered the raw escape codes as text).
- **Usage window "By billing type" knows `remote-host`** (rendered as a raw key with default styling since 2.128.0).

## 2.188.2 — 2026-07-19
- **Scrolling back DOWN through chat history no longer stalls at the rendered window's edge** (real report: content wouldn't advance downward — only jiggling up/down loaded "a little more" each time, until scrolling far enough up and clicking the pin-to-bottom button). Once parked at max scrollTop, `scroll` events stop firing while `wheel` events keep coming — the exact mirror of the long-fixed top-edge (`scrollTop=0`) case. The wheel handler's bottom-edge branch only covered teleport mode; the normal window-mode `_extendBottom` is now triggered there too, so downward pagination chains smoothly.

## 2.188.1 — 2026-07-19
- **A truncation-poisoned remote-transcript cache for a STOPPED session now heals too.** The 2.187.0 self-heal relied on the remote file CHANGING (size/mtime mismatch → refetch); a pre-2.187.0 256KB stump stamped with full-size meta over a transcript that never grows again passed the size/mtime check forever and kept serving ancient history. The cache-valid short-circuit (slab + legacy ssh paths) now also requires the cached FILE to actually hold `meta.size` bytes — a stump fails the check and refetches completely. (Field verification on the reporting instance: both big transcripts' caches are byte-complete and the display API serves same-day messages.)

## 2.188.0 — 2026-07-18
Remote multi-account coherence batch (all six gaps from the 4-way audit) + live email identity:
- **Remote session windows now say WHOSE login they bill.** `sessionAuth` carries the session's machine (`hostName`): a remote host-login session's badge reads "CLI login @ \<host\>" (tooltip names the machine) instead of being byte-identical to a local one; remote TERMINAL sessions no longer show "KEY?" forever (the `remote-global` spawn state maps to the host's own login — `apiKeySource` is chat-stream-only and the /proc backfill probes the local ssh wrapper, so terminal sessions could never resolve). Session Properties' Billing line and the mobile chip get the same qualifier.
- **The billing switcher and Session Properties no longer offer accounts the server must reject** (fail-late poisoning: the pick was persisted as the on-resume account BEFORE the spawn error, wedging every later resume). Subscription accounts render disabled with the reason (dial: never ships; ssh: needs the "Ship subscription logins" opt-in); the CLI-login entry names the host.
- **Manage Agents host view is coherent for every auth shape and for dial devices.** `accountsStatus` learned the API-key auth shapes (`primaryApiKey` reads as *logged in · API key*, `apiKeyHelper` recognized — it contradicted the 2.186.7-fixed backend row in the same dialog) and returns the host login's identity (claude config email + codex auth.json JWT email/plan, decoded server-side). All host probes (`backendStatus`/`accountsStatus`/`agentToolsStatus`/`cliPrimaryKey`/`readRemoteOAuth`) run through a shared `_hostShell` that routes dial devices over the device link — a selected paired device no longer shows "not installed"/"unreachable" everywhere (its integration section shows status with a "managed automatically at spawn" note instead of the ssh-only Install buttons; the quota-popup ⟳ works for devices too). The host CLI-login row also shows its own-login quota donuts when a snapshot exists.
- **Starring a "this machine only" subscription while a host is selected now explains itself** instead of silently setting a global default that host can never use.
- **Email displays prefer the token-derived identity everywhere.** The quota ⟳ already bakes `/api/oauth/claude_cli/roles` `orgEmail` (per account AND per host); Manage Agents now prefers it over the staleable config-file email for the CLI-login row, named subscription rows, and host rows (codex needs nothing — its email comes from the auth.json JWT, which can't disagree with the token). The usage endpoint itself doesn't return identity; the roles ride-along on the same human-gated click is the mechanism.

## 2.187.1 — 2026-07-18
- **The Set-up dialog's "All done" button actually closes the dialog now** (real report: clicking did nothing). The Start button is disabled for the run and was never re-enabled — the terminal "All done" label sat on a dead disabled button. Completion re-enables it as a close button; a thrown failure re-enables it as "Retry" (re-runs the bootstrap) instead of a dead "Failed".

## 2.187.0 — 2026-07-18
- **Remote chat history no longer freezes at an ancient snapshot** (real report: a session resumed in VibeSpace showed months-old history while `claude --resume` over ssh was current). Root cause was a device-plane protocol flaw: the mux control channel is credit-EXEMPT, so `fs-done` could OVERTAKE transcript data still queued behind the 256KB credit window — `fsReadRange` resolved with exactly 256KB for any bigger read, and the transcript cache stamped a 256KB prefix of a 45MB file as "complete" (every later attach served the stump = the conversation's very beginning). Same class hit `runStream` (`stream-exit` overtaking queued stdout of a fast-exiting producer: truncated usage harvests / streamed downloads) and device-plane file reads >256KB (a truncated read + save could have destroyed the file tail). Fix: both primitives are now COUNT-GATED (resolve only when the counted bytes actually arrived; daemon reports `sent` in `fs-done`/`stream-exit`, exits on `close` not `exit`, and paces/pauses under window pressure instead of ballooning memory); `fetchSessionJsonl` refuses to stamp meta for bytes it didn't receive (short read → legacy ssh fallback) and caps on FETCHED bytes (delta) rather than total size, so a growing transcript keeps incrementing past 64MB. Poisoned caches self-heal on the next attach (the stump is a valid prefix; the fixed delta append completes it). In-field daemons pick the fix up via self-upgrade on next connect; the client-side count gate works against OLD daemons too (the ack's `sending` count was always there). Test: `scripts/test-agentd-bigread.mjs` (real daemon, 9 asserts: 3MB full/delta reads byte-exact, fast-exit `cat` streams intact, no-hang error path); mux/agentd/m3m4/socks suites green.

## 2.186.8 — 2026-07-18
- **A fresh instance with zero local sessions can now reach its remote machines' sessions** (real report: the sidebar showed only "No sessions" — no host switcher anywhere — while the configured remote machine held hundreds of sessions). The "No sessions" early-return fired before the workbench (whose Recent/History host switchers are the only path to remote sessions) ever rendered; same class as the 2.125.1 remote-search fix. With any remote host configured the workbench now renders its zones (empty hints + switchers) instead; a truly host-less fresh instance keeps the clean "No sessions" state. Committed smoke: `scripts/test-sidebar-empty-remote.mjs` (worktree server + empty fake HOME + fake host, 5 asserts incl. the /api/hosts-in-flight self-heal).

## 2.186.7 — 2026-07-18
- **API-key-authed Claude logins are now recognized** (real report: a remote machine ran claude fine via an `apiKeyHelper` in `~/.claude/settings.json`, but Manage Agents said "not logged in" — the detection only checked for the OAuth `.credentials.json`). Both the local `/api/backend-status` and the remote host probe now recognize all four auth shapes: OAuth creds (token grep, not mere file existence — a console-wiped `{}` no longer counts), a console-managed `primaryApiKey` in `~/.claude.json`, an `apiKeyHelper` in settings.json, and (remote) a macOS Keychain entry. The Manage-Agents row shows the method for API-key styles ("logged in · API key" / "apiKeyHelper"), mirroring the CLI's own "API Usage Billing" statusline. Verified against the reporting host: probe returns `key-helper`.

## 2.186.6 — 2026-07-18
- **An unreachable ssh machine now shows WHY under its row** (real report: a user added a server with a typo in the address and got only a red dot — the probe error, e.g. "ssh: connect to host …: Connection timed out", lived only in the status dot's hover tooltip, invisible on touch and undiscoverable on a 6px target). Machine rows reuse the storage rows' red error line (`.mounts-errline`): a failed connectivity probe renders "Couldn't connect: <error>" under the row (full text in title), so a bad address/port/key is self-explanatory. Dial devices already say "offline — run the install command" and are unchanged.

## 2.186.5 — 2026-07-18
- **Clicking a link in a proxy-mode embedded browser no longer escapes the proxy** (real report: the page loaded, but any link → "This site blocked iframe embedding (X-Frame-Options)"). The proxy (node-unblocker) leaves in-page links RELATIVE and relies on the document base, so when you navigate to a bare origin (`http://host:port`, no trailing slash) the iframe's base has no `/` and a relative link resolves UP A LEVEL — dropping the host, landing off-proxy → the X-Frame overlay. `navigate()` now normalizes a pathless origin to a trailing slash (`http://host:port/`), so relative links resolve to `/proxy/http://host:port/subpath` and stay inside the proxy. Verified against a real proxied directory listing.

## 2.186.4 — 2026-07-18
- **A "This machine" forward to a LAN/Tailscale IP now actually works** (real report: `本机 → 100.87.42.107:9983` gave a blank browser, was misdetected as TCP, and published an empty port). The `__local__` path short-circuited assuming the target was on the instance's own loopback — so an `ip:port` target that the instance reaches over its network (e.g. Tailscale) was never proxied. It now binds a real local proxy that `net.connect`s to `targetHost:remotePort` directly; the proto probe and frp publish follow the real proxy port. (Bare-port local forwards — a service on the instance's own loopback — are unchanged.) Test: `scripts/test-port-forward.mjs` (local LAN target binds a real proxy + pipes bytes to targetHost:port).

## 2.186.3 — 2026-07-18
- **Port forwarding can now target another machine on the device's LAN** (user request). The ports UI's manual box accepts `ip:port` / `host:port` (not just a bare port), so a paired machine becomes a jump host into its internal network — e.g. forward `10.0.0.5:8080` reachable from the device but not from here. The daemon's `tcp-connect` gained an optional target host (defaults to loopback — the mount/VNC/port-forward shape is unchanged); a bare-port and a LAN-target forward for the same port are distinct records; the proto probe follows the LAN target too. Added to the rail Ports panel (per-machine manual box) and the ports dialog; active forwards show the `host:port` they target. Test: `scripts/test-port-forward.mjs` (LAN-target record, pipe-through, distinct-from-bare, host validation).

## 2.186.2 — 2026-07-17
- **File links in a REMOTE session's chat now open the file (right-click → Open / Ctrl+click)** (real report: they did nothing). The link handlers resolve + open against the SESSION's host, but the actual `openFile`/`openFileExplorer` calls dropped the host — so a remote file opened a nonexistent LOCAL path. The relative-path handler probed with `&host=` correctly but opened without it; the absolute/markdown-path handler wasn't host-aware at all. Both now thread the session host through the probe AND the open (viewer/explorer get `?host=`), so remote-chat file links open the remote file.

## 2.186.1 — 2026-07-17
- **Dragging a window onto a desktop preview no longer lands it one desktop to the right** (real report). The drop resolved the target desktop by DOM index into `querySelectorAll('.desktop-preview')` — but the Stage preview also carries `.desktop-preview` and sits before the real ones, so the index was off by one whenever the Stage was active. Each real preview now carries `dataset.desktopId` and the drop resolves by that id, never by index. Smoke: `scripts/test-desktop-drop.mjs` (reproduces the off-by-one, proves the id fix).

## 2.186.0 — 2026-07-17
- **On-demand egress: an agent can borrow a paired machine's network for a single command** (new). When a request needs a specific machine's network position (a region, an internal/VPN network, a fixed source IP), the agent reaches for it deliberately — it does NOT route the whole session. Two tiers via the new `vibespace-exit` CLI (on every session's PATH, distributed to remote hosts like the other agent tools):
  - `vibespace-exit use <machine>` / `url <machine>` — the machine's daemon serves a zero-dep in-daemon **SOCKS5** proxy on its loopback; the server reaches it over the existing agentd tunnel (`tcpForward`) and binds a local `socks5h://127.0.0.1:<port>`. The tool runs locally, only its egress is the remote machine (proxy-aware TCP: curl/git/http libs). The loopback-only tunnel boundary is preserved — the SOCKS server is the one sanctioned egress point, inside the machine owner's own network.
  - `vibespace-exit run <machine> -- <cmd>` — run the command natively ON the machine (`runCmd`). The universal fallback for what SOCKS can't carry: ICMP (ping/traceroute), UDP, proxy-unaware tools, and that machine's own DNS.
  - `vibespace-exit list` — the machines the user enabled.
- **Opt-in per machine** (default off — turning a paired machine into an egress is a real capability: SSRF into its LAN, abuse). Enable via the Remote tab → a machine's ↗ "Exit node" toggle (`hosts.allowExit`); agent routes + the CLI enforce it. Agents are taught (session-tools intro): go direct by default, use an exit only for the command that needs it, and `run` when `use` (SOCKS) can't carry the traffic.
- Daemon: `serve-socks`/`unserve-socks` ops (SOCKS5 CONNECT, IPv4/IPv6/domain, no-auth, DNS-on-exit), closed on disconnect. Tests: `scripts/test-agentd-socks.mjs` (real daemon, CONNECT egress + domain + refused + teardown), `scripts/test-exit-proxy.mjs` (gating, resolution, byte pipe, lifecycle).

## 2.185.3 — 2026-07-17
- **Duplicate session cards for one conversation are collapsed on restart** (real owner report). A plain `claude --resume` REUSES the conversation id, so resuming a session whose claude had already died (the 2.179.0 live-guard sees no live session to block) minted a SECOND dtach session for the SAME `claudeSessionId`; both surviving sockets were re-adopted on every server restart → two cards (and, if both claude were alive, two writers on one JSONL — userW's double-writer class). `restoreSessions` now dedups by conversation: it keeps ONE socket per `backend:host:claudeSessionId` (a live claude beats a dead husk, then newest-created wins) and retires the older husk (SIGTERM its dtach + clean socket/buffer/meta) before adoption. Detection is fd-based (a live claude always holds its transcript open) and fails safe — it can never retire a working session. Pure helper `dedupWebuiSockets` + `scripts/test-dedup-sockets.mjs` (8 cases incl. live-beats-newer-dead, different-hosts-not-a-dup, three-husks).

## 2.185.2 — 2026-07-17
- **Dial-device link no longer wedges after a daemon self-upgrade** (real owner↔Mac outage). The device daemon's upgrade re-exec spawned the new bundle with **no arguments**, but the dial transport reads `--dial <url> --dial-token <t>` from argv — so a re-exec'd DIAL device came up in default LISTEN mode: it stopped dialing the instance AND held the singleton lock so launchd couldn't relaunch the real `--dial` daemon. Usually the launchd relaunch won the race (so it recovered), but rapid successive server upgrades lost the race and the link stayed down. The re-exec now preserves the full original argv (`src/agentd/reexec.js`, `reExecArgv`); regression test `scripts/test-agentd-reexec-argv.mjs`. This is the root cause behind the userW-class "dial device silently goes offline after updates."

## 2.185.1 — 2026-07-17
- **Port-forwarding button icon fixed** (real report: "这个电源开关是端口转发…图标太奇怪了"). The 🔌 button on machine rows used the IEC **power on/off symbol** (a vertical line through an open arc), so users read it as a power switch and couldn't find port forwarding. It now uses a plug/connector icon (prongs + body + cord) matching the Ports panel — the "Connect a storage mount" action keeps the power symbol, where on/off actually fits. Verified the whole flow works on a phone viewport (`scripts/dbg-mobile-ports.mjs`: mobile mode → Remote tab → ports dialog fits the screen and sits above the sidebar overlay → forward → open through the proxy).

## 2.185.0 — 2026-07-17
- **Ports UI shows the detected protocol and lets you override it** (user request). Every scanned port and active forward carries an http/https/tcp chip: local ports are probed directly, remote ports through a fresh device-tunnel stream (`probeHostPort`, 5-min cache; scan probes are budgeted — cached rows are free, up to 12 uncached rows probed per scan with a 3.5s overall cap, so big hosts fill in progressively). The Publish button's tooltip now states the OUTCOME per protocol (HTTP → trusted `https://` subdomain; HTTPS → `https://ip:port` passthrough; raw TCP → `tcp://ip:port`).
- **Click the chip to force a protocol** (Auto / HTTP / HTTPS / TCP) when detection guesses wrong — e.g. share a websocket-only server as HTTP, or a weird binary-over-HTTP service as raw TCP. The override persists on the forward record (`protoOverride`, `POST /api/port-forward/:id/proto`) and wins over detection at publish time; an already-published forward is transparently RE-published in the new mode (URL shape changes accordingly; the stored subdomain is kept so flipping back to HTTP restores the same public URL). Overridden chips render with an accent ring + `*`.
- **Workflow viewer: a resumed run no longer freezes on "Killed"** (real report). `resumeFromRunId` REUSES the runId (verified from real transcripts), so the killed run's terminal snapshot shadowed the live resumed run — `/api/workflow` now treats the snapshot as stale when the run dir's journal/agent transcripts are meaningfully newer (15s margin vs the ≤0.1s completion skew) and serves the live view with a "resumed after an interruption" tag; the viewer also keeps a slow 15s re-check on killed/failed runs so an already-open window notices the resume instead of stopping its poll forever.
- Tests: `scripts/test-port-forward.mjs` (+9 asserts: local/remote probing, detect enrichment, override persistence + validation), `scripts/test-frp-plugin.mjs` (probe refactor, live vs the real relay).

## 2.184.1 — 2026-07-17
- **CRITICAL: server updates no longer kill remote chat sessions** (real userL outage — every update since 2.175.0 finalized the device-daemon chat sessions dead and orphaned their claude processes). Root cause: a remote chat child is spawned as `sh -lc '… exec env … claude …'`, so after the execs its cmdline no longer contains the recorded argv0 (`sh`); when a daemon upgrade re-exec forced re-adoption, the identity check misjudged the LIVE claude as a recycled pid and synthesized a `_remote_exit code:143 crashed` sentinel — the wrapper finalized the session while claude ran on, orphaned (double-writer risk). The same misjudgment made terminate's `kill-pipe-session` a silent no-op. Fix: process identity now uses the **exec-proof start time** (`/proc/<pid>/stat` field 22; `ps -o lstart=` on macOS) recorded at spawn; legacy metas fall back to a claude/codex-aware cmdline match. Adopted children (spawned by a previous daemon incarnation) also get a **liveness watcher** that writes the exit sentinel when they eventually die — a daemon can't `wait()` a process that isn't its child, so before this an adopted session's natural end was never reported (keeper parity). Regression test: `scripts/test-agentd-adopt.mjs` (old code fails it on both counts, verified).

## 2.184.0 — 2026-07-16
- **Public-URL publishing now detects the backend protocol and terminates TLS server-side** (real design review). A published port is probed first: a plaintext **HTTP** dev server becomes a browser-**trusted** `https://<random>.<domain>/` (the relay terminates TLS with a real wildcard cert and forwards plaintext over the tunnel — **no cert on any instance**); an **HTTPS**-native backend keeps its own cert served at `https://<ip>:<port>` (passthrough); a **raw-TCP** service (Postgres/Redis/VNC/SSH — no Host/SNI to route on) is exposed as `tcp://<ip>:<port>` instead of being wrongly wrapped as HTTP. Before this, everything was blindly published as `https2http`, which broke non-HTTP and served a self-signed cert.
- The device dial for double-NAT pairing now rides the trusted cert too (default TLS verification passes), so a paired device connects cleanly through the relay subdomain.
- `frpPublish` returns the detected `proto`; the forward record + `/api/port-forwards` carry `publicProto` for the UI. Probe covered by `scripts/test-frp-plugin.mjs` (http/https/tcp on real servers).

## 2.183.0 — 2026-07-16
- **frps subdomain broker is LIVE + double-NAT device pairing** (B-0b60/B-5c1e). The relay now serves per-publish `https://<random>.<domain>` subdomain URLs (SNI/vhost), so a forwarded port publishes to a clean shareable link instead of `IP:port`. And the big one: **both sides can now be behind NAT** — the Pair-a-device dialog gained a "This instance is behind NAT — reach it through the public relay" option (shown when the frp plugin is configured). Checking it publishes the instance's own port to the relay and hands the device a public subdomain to dial; the relay bridges both NATs, so a home/laptop VibeSpace can pair a device that's also behind its own NAT. The bundle download AND the dial websocket both route through the public subdomain. Verified end-to-end from outside the cluster (instance UI 200 + device-dial WS reaches the server through the relay). The self-publish subdomain is persisted so re-pairs/reconnects keep the URL stable.

## 2.182.0 — 2026-07-16
- **Legacy/dead-code sweep** (5-agent audit, every deletion adversarially grep-verified for zero live references; ~300 lines removed, no behavior change). Highlights: dead pre-flat-connections mount REST routes (`/api/mounts/my-storage-config` ×3, `/api/mounts/my-storage`, `/api/mounts/share`, `/api/mounts/:id/duplicate`) + their now-orphaned `mounts.addMyStorage`/`clearMyStorageConfig`/`duplicate`; the never-fed `agentdDialWaiters` dial-in scaffolding; a duplicate `MessageManager` import and unused ws-handler ctx params (`PERMISSION_MODES`/`META_DIR`/`sessionStatus`/`sessionStatusKey`/`CODEX_CMD`/`getTasks`) left by the 2.92–2.175 refactors; triplicate/duplicate `effort` object keys; an unused `ws-handler.safeJsonParse`; `remote-fs.uploadBuffer`; the `SSH_BASE_OPTS` export; `DeviceManager._tokenId`/`_backoffIdx` write-only fields; adapter registry `list()`/`has()`, all `get name()` getters, and dead codex exports (`CODEX_PERMISSION_MODES`/`getJsonlLineIndex`/`resolveCodexPermissionMode`); dead client methods/getters (`chat-view._deriveTypingLabel`/`_syncTypingIndicator`, `file-explorer._bookmarkCurrent`, `file-types.getFileType`, `settings.isSet`, `themes.isBuiltIn`, 5 chat-input/status-bar readback getters); unused icons (`PENCIL`×2, `MI.copy`, 4 `UI_ICONS`); and ~70 orphaned CSS rule-blocks across style/chat/viewers (old Manage-Agents roster hooks, the pre-Chart.js `udash-*` chart renderer, removed HTML viewer, checklist/My-storage/task-status remnants). Full suite + rail CDP smoke + server-boot verified.

## 2.181.1 — 2026-07-16
- **Workflow viewer labels retried agent attempts** (real confusion report: several agents read "interrupted by user" with nobody interrupting). The harness re-spawns an agent whose API stream aborted — same journal key, new agentId — and the dead attempt's log dead-ends in the CLI's canned "[Request interrupted by user]". The viewer now derives retry chains from the journal (a key's non-newest attempts without results) and shows those attempts as **"retried — replaced by a newer attempt"** instead of a bare interrupt, in the live view AND the finished snapshot. Verified against a real in-flight run (5 dead attempts tagged, all matching the interrupted transcripts).

## 2.181.0 — 2026-07-16
- **Per-panel sort option** (user request): the dashboard panel editor gained a Sort select — Default (axis order for sequential dims, value ↓ for categorical), Axis/name order, Value high→low, Value low→high. Applies to plain panels AND split-series charts; Top-N still cuts by value (it's a ranking), the survivors then display in the chosen order.
- **Usage ⟳ works when the account's own token is momentarily stale** (real report: "Personal Max" errored while a session was actively running on it). A named subscription's dir token only refreshes while a session runs on that dir and can lapse between refreshes — when the machine's global CLI login is the SAME Anthropic account (email link), its token is used as a fallback (and vice versa for the global chip). Still read-only + user-initiated (§ban-safety unchanged).

## 2.180.2 — 2026-07-16
- **Usage dashboard: the hour/weekday axes are in axis order again** (real screenshot report — the 按小时 panel's bars ran 18, 21, 2, 16, …). The server sorted EVERY dimension's groups by cost, and the dashboard deliberately keeps sequential dims in server order — so the hour axis came out cost-sorted. Sequential dims (day/hour/weekday) now sort by key server-side; the client also sorts them itself (belt for old servers), **gap-fills the closed scales** (24 hours / 7 weekdays — a missing bucket read as a mislabeled bar, not "no data"), and the weekday panel shows Sun–Sat names instead of raw 0–6.

## 2.180.1 — 2026-07-16
- **Steps/TODO no longer shows long-completed tasks as in-progress** (real report, reproduced on a 589MB transcript). Two cooperating causes: the huge-session tail-only window can miss a task's completing update entirely, and **compaction re-appends the retained records — with their ORIGINAL timestamps and uuids — after the whole history**, so a task's create/in_progress got replayed while its completed update (summarized away) did not; even a full file-order scan would end on the stale replay. The task-tool scan (`scanTaskEventsFull`) now streams the WHOLE file (substring pre-filter, byte-safe line splitting, incremental byte cursor — 1.6s cold / <100ms warm on 589MB), dedups replay copies by uuid, and applies events in TIMESTAMP order. This also retires the old "stub entry with empty subject" tail-window caveat.
- Family preference is by LATEST USE: an ancient TodoWrite snapshot no longer shadows the newer TaskCreate/TaskUpdate list over full history (caught on the first real transcript — the "prefer TodoWrite when present" rule meant "ever used" once the scan went full-file).
- Regression test: scripts/test-task-scan.mjs (synthetic compaction replay + uuid-less stale replay + family preference + incremental append, fake-HOME isolated).

## 2.180.0 — 2026-07-16
- **Orphaned dev-server detection (B-16d9)**: a listener whose working directory was DELETED is a zombie — a session started `next dev`/`vite` in a throwaway worktree and removed the directory without killing the process (real case: two forgotten next-servers eating 12GB for a day). Local port scans now flag them (`/proc/<pid>/cwd` ends " (deleted)"), the port watch announces each one once (error-toast, even on the baseline sweep — garbage is garbage whenever it appeared), and both ports UIs show an `orphan` tag with a **Kill** button. The kill endpoint re-verifies the deleted-cwd condition at kill time, so it can never be pointed at a healthy process.
- Port scans now carry the listener's pid (ss `-p`, lsof column 2, and the /proc fallback's inode scan).
- E2E-tested with a real listener spawned in a deleted directory (detection, healthy-process refusal, kill).

## 2.179.1 — 2026-07-16
- **Agents panel: rail-native redesign, width-verified** (real report ×2 — the 2.178.0 panel overflowed horizontally). Root causes closed: the modal's `min-width: 380px` leaked into the panel via a descendant selector that should have been a compound one; and the panel's flat-section rule put `flex-wrap` on the COLUMN rosters, where `align-items: stretch` then fills the flex line (widest content) instead of the container — every child pinned wider than the panel. In the sidebar the panel is now FLAT (vscode-style hairline sections, quiet uppercase titles); the modal keeps its card layout.
- **Width-adaptive usage readout**: ≥340px shows the donut cluster; below, a container query swaps in ONE pill showing the TIGHTEST quota bucket (e.g. `7d 55%`, full breakdown in the tooltip) so account rows stay single-line at any sidebar width. Name/email and the roster header shrink with ellipsis instead of forcing intrinsic width; the Agent-instructions textareas are fluid.
- Verified with headless-chrome screenshots + numeric overflow audits at 260/340/460px (0 overflowing elements at all three; donut↔pill swap confirmed).

## 2.179.0 — 2026-07-16
- **Resume guard — the duplicate-session double-writer is closed** (userW's real incident: TWO live claude processes both `--resume` of the SAME conversation id, same cwd — two identical sidebar cards, one JSONL with two writers). A plain claude resume REUSES the conversation id, so the server now refuses to spawn a resume whose id is already LIVE on the same machine and hands the existing session back; the client attaches it instead of opening a second copy (forks are exempt — they mint a new id; codex resume forks a thread id by design).
- **Kill resolves by conversation id when the webui id went stale** (the suspected chain behind userW's duplicate: the billing switcher's kill silently no-op'd on a stale server id, then its respawn double-resumed). The billing switcher passes `backendSessionId` with its kill and the server falls back to it.

## 2.178.0 — 2026-07-16
- **A published forward now shows its address** (real report: 发布到公网后没有地址可以复制): the Ports panel renders the public URL under the forward as a clickable link with a Copy button (the old tooltip-only 🌐 left nothing to copy). The machine 🔌 dialog already had this.
- **Manage Agents redesigned** (real report: 界面严重需要重新设计). One stylesheet + a container query now serve the modal AND the sidebar rail panel — the account rows no longer crush at narrow widths. Each account row is `icon · name/email · usage donuts · ★ · ⋯`; Test / Rename / set-email / Remove moved into the ⋯ overflow menu (four inline buttons were what overflowed, modal and panel alike), and the four Add… buttons collapsed into one "+ Add account…" menu on the roster header. Backend status is a single line (the redundant "(Claude Code)" version suffix is stripped). CJK button labels no longer wrap into a vertical pile.
- CDP smoke extended (agents-panel redesign asserts: roster header add-menu, no inline Test button, overflow menu present, add-menu opens).

## 2.177.0 — 2026-07-16
- **The rail persists through a sidebar collapse** (`sidebar.railPersistent`, default ON — user directive 常驻可调): collapsing leaves the 44px icon strip on screen (vscode behavior); clicking any icon expands back to that panel. Off = collapsing hides everything, as before.
- **Panel layout fixes for the narrow sidebar** (real screenshot report): the header title now names the active panel (Ports / Agents / Plugins / …) instead of always saying "Sessions", and the Agents panel content no longer overflows — its modal `min-width: 380px` is lifted and account rows wrap (usage donuts drop to a second line under the name instead of crushing it).
- **Publish is no longer a silent no-op without the frp relay** (real report): the Ports panel probes the frp plugin — unconfigured ⇒ the publish button is dimmed with an explanatory tooltip and clicking says why; every ports action (publish/unpublish/stop/forward/scan) now surfaces server errors as toasts (`fetchJson` never throws — a 4xx came back as `{error}` and was dropped; the mounts 🔌 dialog had the same bug incl. a "Public URL: undefined" toast).
- **Port scans identify the process and fold system listeners** (vscode-style, user request): `ss -tlnpH` for process names, and the `/proc/net` fallback now resolves socket inodes → process names via a bounded `/proc/*/fd` scan; known non-web daemons (sshd/dns/cups/rpc/smtp/frp/tailscale/VNC + this instance's own port) are flagged `hidden` — both ports UIs fold them behind a "+N system listeners" expander and the new-port watch never notifies about them. DB servers stay visible (forwarding one is a real use case).
- Ports action buttons use mono stroke SVG icons (the color 🌐 emoji clashed with the chrome icon style — real report).

## 2.176.0 — 2026-07-16
- **Sidebar activity rail (vscode-style), default ON** (`sidebar.activityRail`; docs/design-sidebar-rail.md): a ~44px vertical icon strip replaces the 3-tab bar — content panels (Folders / Task Groups / Remote / **Ports**) + management panels (Agents / Plugins, same renderers as the modals via a `{container}` mode) + pinned launchers (Diagnostics / Settings). Re-click the active item to collapse the sidebar (vscode behavior); ⚙-menu Agents/Plugins entries focus the rail panel instead of opening a modal while the rail is on. Badges: Task Groups ⚠ attention, Remote = offline dial machines, Ports = active forwards, Diagnostics = last-day error count. Turning the setting off live-restores the classic tab bar + modal dialogs; mobile keeps its own nav (rail never renders there). Mirrors with `sidebar.position`.
- **New PORTS panel** — the vscode PORTS view analogue and the new-port toast's landing place: active forwards across all machines + this instance (open through the app proxy / publish–unpublish on the frp relay / stop), plus per-machine on-demand port scans with one-click "forward here". Live-refreshes on forward changes and new-port announcements.
- **Settings echo-revert race fixed**: the server broadcasts `settings-updated` to ALL clients including the sender — toggling a setting off→on within the 500ms save debounce got permanently reverted by the stale echo of the first save (the rail smoke caught it live). `applyRemote` now skips the echo while a local edit is pending save.
- CDP smoke: `scripts/test-sidebar-rail.mjs` (throwaway worktree server + headless chrome, 14 assertions through the real build/panel/toggle paths).

## 2.175.1 — 2026-07-16
- **Ghost terminal windows are gone**: when a reconnect re-attach answers "unknown session" (the session died WITH the server — pod recreation / hard restart kills dtach), the terminal window now flips to the same honest exited state as a live exit ("Session ended while disconnected — resume it from the sidebar") instead of keeping its frozen content and looking alive while the sidebar truthfully showed 0 running (real report: 左右不匹配).

## 2.175.0 — 2026-07-16
- **CS-refactor flags GRADUATED — the toggles are gone.** `agentd.sessions`, `agentd.remoteSessions` and `agentd.dataPlane` are removed from Settings; the device-daemon paths are unconditional (local sessions through the daemon, remote chat as daemon pipe sessions, data plane over the device link). The legacy paths that the flags selected are deleted; what remains are FAILURE fallbacks only (local pty on daemon error, per-op ssh on device error, keeper for pre-existing keeper sessions).
- **`agentd.publicUrl` is cluster-injectable**: helm now injects `VIBESPACE_PUBLIC_URL=https://<instance-host>` as the default; a user-set value in Settings still overrides, and the Settings field shows the injected address as its placeholder ("cluster default: …").
- **PostHog integration removed entirely** (code, settings, helm) — per product decision; local diagnostics/telemetry are unaffected.

## 2.174.2 — 2026-07-16
- **The REAL blank-shell-terminal root cause, probe-confirmed and closed:** dtach greets every attaching client with a clear-screen preamble (`\e[H\e[J`) as its redraw kickoff — a TUI repaints right after (SIGWINCH), but a plain SHELL repaints nothing, so every server restart / daemon re-exec wiped attached shell terminals live AND left the clear as the session buffer's LAST bytes (a pod-internal attach probe showed the buffer ending in `\e[H\e[J` — so every later attach ALSO rendered blank with the cursor home). The first output chunk within 2s of an attach now has a leading clear burst stripped (a pure-clear chunk is swallowed); later clears are real program output and untouched.
- Toolbar-hosted desktop previews obey `taskbar.desktopPreviewRatio` (they were hardcoded to 34×20 — the setting had no effect once previews were moved out of the taskbar; real report). Derived from the toolbar's fixed height, label never below 6px.

## 2.174.1 — 2026-07-16
- **The new-port notification actually fires now** — two independent holes (real report, twice): the client toast handler was only registered after the Remote tab's first render (never opened the tab → never any toast; now registered at page load), and fleet container images ship NEITHER `ss` NOR `lsof`, so local detection was silently blind on every pod — `detectLocal` now falls back to parsing `/proc/net/tcp(6)` directly (ports without process names; kernel-level, always present on Linux).

## 2.174.0 — 2026-07-16
- **Local terminals survive a device-daemon self-upgrade (the blank-terminal fix).** Two root causes closed (real report, three times in one evening — every release makes the local daemon self-upgrade + re-exec): (1) when the daemon link died, the server's pty handles never learned it — the mux teardown fired `onClose` but session handles wire `onExit`, so the auto-reattach path never ran and terminals froze; (2) even a successful reattach showed NOTHING — dtach replays no history and a plain shell never repaints. Now a dead link fires `onExit` on every open session handle (bounded auto-reattach kicks in within seconds), and the RE-attach pushes a clear + buffer-file replay to attached clients — the upgrade becomes visually seamless. Regression-guarded: the M1 suite kills the daemon under a live session and asserts the handle exits.

## 2.173.3 — 2026-07-16
- **Bidirectional machine mounts are visually unambiguous** (real report: two sibling rows both said "→ path" with no hint which side the path was on). Every mount row now shows the full journey with each side labeled — `Mac:/Users/me/Downloads → here:/home/me/vibespace-machines/Mac-Downloads` (pull) vs `here:/home/me/project → Mac:/Users/me/vibespace-remote/project` (push) — and the badges carry direction arrows (⬇ from machine / ⬆ on machine).
- Pairing installer: the post-start verification checks the daemon by its LOCK pid + ps command instead of `pgrep -f <path>` — the daemon rewrites its process title, so the path pgrep never matched a HEALTHY daemon and every successful install reported "exited immediately" followed by hours-old log lines (real report, twice). A real failure now shows only THIS run's output.

## 2.173.2 — 2026-07-16
- **Shell terminals on a paired device run the DEVICE user's login shell** (zsh on a stock Mac) — they used to exec the basename of the POD's shell (bash), greeting Mac users with Apple's "default shell is now zsh" nag (real report). Resolution order: `$SHELL` → macOS `dscl UserShell` → linux `getent passwd` → zsh/bash fallback; started as a login shell. Server-side only — the device daemon is untouched (deliberately no daemon version bump: three self-upgrades in one evening were severing live local-terminal attaches).
- Known issue filed: a daemon self-upgrade re-exec can blank ATTACHED local terminals until the page reloads (the buffer survives on disk) — root fix (reattach-with-replay after re-exec) is queued.

## 2.173.1 — 2026-07-16
- Machine mount dialogs: the machine-side mount point (push) autocompletes against the MACHINE's filesystem over the device link, and the local mount point (pull) autocompletes locally (real report: the field was blind).
- Pairing installer: the node-pty check now SPAWNS a real pty instead of just require()ing the module — a broken spawn-helper loads fine and then fails every terminal with `posix_spawnp failed` (real Mac report, node 25 + node-pty stable); on failure it auto-falls back to `node-pty@beta` (the line VS Code ships, with the macOS spawn fixes) and verifies again.

## 2.173.0 — 2026-07-16
- **Port auto-discovery covers THIS instance (machine #0).** A dev server started in a local terminal (`python3 -m http.server 8032`, `npm run dev`, …) now toasts within ~30s — the 2.172.0 watch only covered external machines, and the instance itself is the primary workspace (real report: a local http.server got no notification). The "This machine" row gains a 🔌 ports dialog: local services open directly through the app's proxy (no tunnel needed) and publish to the internet via the frp relay. Infra listeners (frpc/tailscaled/VNC/…) are excluded from notifications.
- **Push mounts are honest about being unmounted on the machine** (real report: the user `umount`ed a pushed folder ON their Mac — the row stayed green with no way back). The health sweep now asks the machine's own mount table; a vanished mount flips the row to amber "gone on machine" with a ↻ that re-creates it (same folder/mountpoint/mode; the old record+token are replaced — raw tokens are unrecoverable by design). `remount` now works for push mounts too.
- **Re-pair installer: silence the supervisor before replacing the daemon** (bootout/systemctl stop first — killing a KeepAlive-managed daemon just respawned it into a fight), and an UNKILLABLE old daemon (wedged in an uninterruptible syscall, typically a dead network mount) is no longer a failure: the new pairing is on disk and a 2.170+ daemon adopts it by itself — the installer says so and exits cleanly instead of spawning a doomed rival (real report: repeated "already running" spam while the re-pair had actually succeeded).

## 2.172.0 — 2026-07-16
- **VS Code-style port auto-discovery.** Linked machines (paired devices / connected ssh hosts) are swept every ~30s; when a service STARTS listening (dev server, database, …) a toast announces it — "New port on <machine>: 3000 (node)" — and the machine's 🔌 dialog (which live-refreshes while open) forwards or publishes it. The first sweep per machine is a silent baseline; ephemeral ports (>32767) and already-forwarded ports are ignored; nothing is ever connected JUST to watch (dial machines only while dialed-in, ssh only over an existing device link). Setting `ports.watchNew` (default on) turns it off. Covered in `test-port-forward.mjs` (baseline-silent / diff-notify / ephemeral+forwarded exclusion / no re-announce).

## 2.171.1 — 2026-07-16
- deviceForDial retries ONCE internally when a connect dies to a transient `stopped` (a manager stopped mid-connect by a concurrent re-dial cleanup) — the FIRST op right after a device re-dial no longer surfaces an error before self-healing (seen live during the userW verification: one failed test probe, everything green after).

## 2.171.0 — 2026-07-16
- **Re-pair is now a first-class action — no unpair needed.** Every paired device row has a ↻ Re-pair button: it rotates the pairing credentials on the SAME record (machine row, mounts, port forwards, session history all kept) and shows a fresh installer command. If the device is dialed-in at that moment, the rotated config is **pushed to it in place over the live link** — nothing to run on the device at all (the daemon adopts it within ~30s; 2.170.0). The "Pair a device" dialog with an existing name does the same rotation (it always did server-side — now the UI says so instead of leaving unpair-first as the apparent path, which is exactly the sequence that orphaned userW's daemon). `dbg-pair-smoke` asserts the rotate + in-place push against a real dialed daemon.

## 2.170.0 — 2026-07-16
- **Device re-pairing (identity rotation) now actually works — the userW-incident class is closed.** Un-pairing + re-pairing a device rotated its tokens, but the device's running daemon read its identity ONCE at startup: it kept dialing with the dead pairing forever (rejected every 30s), held the singleton lock so the new daemon exited "already running", and launchd respawned that failure every 10s (the "lots of processes" report). Three layers fixed: (1) the daemon re-reads `dial.json` on EVERY dial attempt and the host-token file on EVERY hello — a re-pair now takes effect on a RUNNING daemon within one retry (~30s), no restart, nothing to clean up; (2) the installer takes over: a running daemon for the same root is verified by command line and replaced (the old bundle can't self-adopt); (3) the macOS singleton check verifies the lock pid via `ps` (no `/proc` on darwin — a recycled pid used to read as "already running" forever). The "already running" message now names the pid + root and says what to do. Pairing dialog states the semantics: re-running the command REPLACES the pairing; pairing one device with several instances is supported (one daemon per instance). Regression-guarded: `test-agentd-dial.mjs` rotates both tokens under a LIVE daemon and asserts adoption.

## 2.169.0 — 2026-07-15
- **Paired device stuck "offline" while actually dialed-in and healthy (real userW outage, hours):** a cached DeviceManager that had been `stop()`ed (re-dial/unpair races) was reused forever — its connect loop throws `stopped` on sight, so every op (test/files/sessions/mounts) failed while `/api/hosts` said online. `deviceForDial` now treats a stopped manager exactly like a stale stream (evict + rebuild) and never leaves a failed manager in the cache. One failed op self-heals instead of wedging until the next re-dial.
- **Terminating a dial-device CHAT session now stops the device-side claude** — the remote teardown was ssh-only and silently threw for dial machines, orphaning claude on the device; a later resume then raced it (two writers on one transcript, the classic resume-loses-messages shape). Dial terminate now kills the daemon pipe session + removes the per-session agent token over the device link.
- **Port forwarding hardening (review findings):** a dial machine's forward no longer dies permanently after a re-dial (the device link is resolved per connection instead of captured once); unpairing a machine unpublishes its public URLs from the relay (they used to stay live pointing at a freed port with no way left to remove them); removing an SSH machine drops its forward records; re-publish after a server restart REUSES the same public subdomain/port (shared links survive; new `preferSub`); a browser abort while the tunnel opens no longer leaks a device channel.
- **frp plugin:** `loginFailExit=false` (a relay blip at boot no longer permanently downs the default-ON plugin — frpc retries); the relay-token override can now be CLEARED from the UI back to the cluster default (the mask guard made it unclearable); helm renders the frp env only when addr AND token are both set (addr alone produced a pod-killing dangling secretKeyRef).
- **Dial devices: file download / image / PDF viewing now works** — `downloadTo`/`downloadZipTo` were ssh-only and hung the request forever for dial machines; they now stream over the device link (`run-stream`).
- **Device daemon:** terminal (pty) sessions get the same missing-cwd→$HOME fallback as chat sessions (a deleted cwd killed the session at chdir); serve-folder confinement handles a root of `/` (subpaths 403'd — the `'/'+sep` double-slash edge).
- Machine-mounts store: one-time normalization strips trailing slashes off legacy pull records (they never dedup-matched a re-add, producing duplicate records that cross-tore-down one mountpoint).
- i18n: missing zh/ja entry for the frp "relay not configured" hint.
- **"agentd" purged from every user-visible surface** (the rename's last leftovers): server log prefixes (`[agentd]`/`[agentd-dial]` → `[device]`/`[device-dial]`), pairing command now renders `/api/device-dial` (old `/api/agentd-dial` stays a permanent alias — in-field daemons keep dialing it), pair-mint route aliased to `/api/device/dial-pair`, settings descriptions (also corrected the stale "opt-in, default off" claims — the flags are default ON since 2.158.0), storage-row hint, error strings, and the device install root env (`VIBESPACE_DEVICE_ROOT` preferred, `VIBESPACE_AGENTD_ROOT` honored forever for in-field installs). Internal identifiers/wire paths stay as the documented compat layer.

## 2.168.0 — 2026-07-15
- **A machine→VibeSpace (pull) mount 403'd on every file when the shared path had a trailing slash** (real userW report, Mac→VibeSpace): the daemon's serve-folder confines requests with `root + path.sep`, so a root ending in `/` (e.g. `/Users/me/Downloads/`) made the prefix a DOUBLE slash (`…Downloads//`) that no real subpath matches — the root listing worked but **every file/subfolder returned 403**, so rclone reported "couldn't list files: 403 Forbidden" and the mount never came up. (The reverse direction, VibeSpace→machine, was unaffected because `mountPush` runs `path.resolve()` which strips trailing slashes.) Fixed by stripping the trailing slash in three places: `mountPull` (intake), `_up` (so an existing record heals without a device-daemon update), and the daemon's serve-folder itself (defense). `scripts/dbg-pair-smoke.mjs` now pulls with a trailing-slash path so its file-read assertion guards this regression.

## 2.167.0 — 2026-07-15
- **frp plugin: user-configurable + cluster-default + SNI/subdomain broker.** The relay's address/port/token are now editable in ⚙ → Plugins → "Public URLs" (the cluster's env-injected values are the *defaults*; the user can override any of them, clearing a field falls back to env). When the cluster injects the relay env the plugin is **default-enabled** (auto-installs frpc + connects on boot); the user can turn it off. Set a **Subdomain host** and a publish gets a random `https://<random>.<host>` URL (TLS SNI routing via the relay's vhost, the double-NAT-friendly broker) instead of an IP:port. The shared frps relay now listens on 80/443 for HTTP + HTTPS-SNI vhost routing — ready the moment a domain + wildcard DNS land (relay specifics live in the private runbook). Verified: `scripts/test-frp-plugin.mjs` (11 checks: config override, default-enable, subdomain-mode switch, real relay round-trip).
- **Daemon identity says "vibespace-device", not "agentd"** — the device daemon's own startup log + singleton messages were still printing `agentd …`, contradicting the rename; they now say `vibespace-device`. The singleton self-check also matches the process title (it overwrites /proc/cmdline on Linux). Internal wire routes/paths (`/api/agentd-dial`, `~/.vibespace/agentd/`) stay for compatibility with already-deployed daemons (served under `/vibespace-device*` aliases).

## 2.166.0 — 2026-07-15
- **Public URLs for a machine's ports (B-0b60, the frp half — completes the item)**: a new **frp** plugin (⚙ → Plugins → "Public URLs") runs frpc on the instance and connects to a shared frp relay, so any forwarded machine port can be **published to the public internet** as a shareable preview link. In the Remote tab's 🔌 ports dialog, an active forward gets a "Publish public" button → a `http://<relay>:<port>/` URL (copy / open). Verified end-to-end against a real relay (`scripts/test-frp-plugin.mjs` + the dial e2e's publish step: install → connect → publish → **round-trip over the public internet** → unpublish). The relay's address/port/token are injected via env (`VIBESPACE_FRPS_ADDR/_PORT/_TOKEN`) — fleet infra, never in the repo; absent, the plugin reports "relay not configured" and does nothing. This is the public-exposure counterpart to 2.165.0's private tunnel forwarding; the two compose (a machine port → private server-loopback forward → optionally published publicly via frpc).

## 2.165.0 — 2026-07-15
- **Port forwarding — open a machine's dev servers here** (B-0b60, tunnel path): the Remote tab's machine rows gained a 🔌 action that scans the machine's listening TCP ports (over the agentd data plane — `ss`/`lsof`, works for dial AND ssh machines) and forwards any of them. A forward binds a local port on the server and pipes it through the existing agentd tunnel to the machine's `127.0.0.1:<port>` (the same primitive VNC/device-mounts use — NAT-proof, no public exposure), then opens it through the embedded browser's proxy so it's reachable from your browser. Detected ports + a manual box; active forwards persist and re-establish when the machine relinks / on boot; unpairing a machine drops its forwards. Verified end-to-end (`scripts/test-port-forward.mjs` unit + `scripts/dbg-dial-session-e2e.mjs` against a real dialed daemon: detect → forward → byte round-trip → list → unforward). This is the private/tunnel half of B-0b60; frps-style PUBLIC exposure remains a separate future path that needs the reverse-proxy server infra.

## 2.164.1 — 2026-07-15
- **Dial-session review fixes** (9-finding adversarial pass on the 2.163/2.164 diff, all confirmed):
  - **Terminal-on-dial leaked a live claude on the device** (HIGH): the DialSessionBridge never killed the device pty on attach-transport death or on terminate — pty-wrapper respawns the attach on every link flap, so each reconnect orphaned another claude. The bridge now tracks the pty handle and kills it in `onDead` (attach died) and `close(sid)` (terminate); pipe/chat sessions stay untouched (keeper model).
  - **A device-child exit looped instead of ending the terminal**: a nonzero exit (claude not on PATH → sh 127, `exit 1`, crash) was misread by pty-wrapper's reconnect logic as a dropped link and respawned up to 120×, never showing the real cause. attach-cli pty mode now exits 0 on any `session-exit`/permanent error (auth-fail/proto-mismatch/session-error → printed once then clean exit); only a genuine transport death reconnects.
  - **Terminal-dial billing**: an explicitly-selected subscription account is now rejected with the same §ban-safety message as chat (was silently ignored → device's own login), and an API-key placement failure now fails the create instead of silently degrading to the wrong billing identity.
  - **File Properties / stat on a macOS device**: `stat -c`/`du -sb` are GNU-only and errored on BSD; `stat()` now has a device fast path (fsStat + POSIX `du -sk`).
  - **New Session cwd hint**: switching to an offline/paired device no longer leaves the stale local-home placeholder (reset to a neutral hint before the async /api/home), and the recent-cwds paint is guarded against host re-selection (a slow fetch could paint another host's remote paths over the current selection).
  - **Dial pty resize race**: a SIGWINCH that arrived while the device open-session was still opening is now applied once the session is ready (was dropped).

## 2.164.0 — 2026-07-15
- **TERMINAL sessions on a paired device now work** (B-0d70): opening a terminal on a dial machine used to reject with "not supported yet". It now runs claude/codex in a real device-side pty (the daemon's node-pty `open-session`), proxied through the DialSessionBridge in pty mode, with the local side being `dtach → pty-wrapper → vibespace-agentd-attach` in a new raw-tty mode — the exact `ssh -t` shape, over the dialed link. Keystrokes, TUI rendering and window resize all propagate to the device (verified end-to-end in `scripts/dbg-dial-session-e2e.mjs`: real pty, device cwd, keystroke echo, SIGWINCH resize). Resize needed a `setImmediate` deferral — reading `process.stdout.columns` synchronously in a SIGWINCH handler races Node's own size refresh and forwards the stale size. The pairing installer now best-effort installs node-pty on the device (prebuilt for mac/linux/win — chat/files/mounts never need it, so a failure just makes terminal report a clear message); the daemon resolves node-pty from the agentd root too.
- **Codex CHAT on a paired device fails fast with a clear message** instead of blanking — the codex-chat-wrapper speaks JSON-RPC to a local app-server, not the pipe-relayed device one (same limitation as ssh hosts, B-0588). Codex TERMINAL on a device works (TUI over the pty path); claude chat works.

## 2.163.0 — 2026-07-15
- **Dial-device CHAT confirmed end-to-end + the #1 blank-chat root cause fixed** (B-0d70): the server defaulted a session's cwd to ITS OWN `os.homedir()` (`/home/<user>` on the pod) and shipped it as the device spawn cwd. On a Mac that path doesn't exist, and `child_process.spawn` with a nonexistent cwd emits an async `'error'` event — with no listener that **crashed the whole device daemon**, so every session went blank. The daemon's pipe-session now resolves cwd to a real directory (falls back to `$HOME`) and attaches an `'error'` listener that turns any spawn failure into the normal exit sentinel — a bad cwd or missing binary can never take the daemon down again. Verified with a real daemon + a bad cwd in `scripts/dbg-dial-session-e2e.mjs` (12 asserts: crash-survival, stream-json relay, buffer bytes, device-home fallback).
- **A remote/dial session with no explicit cwd now defaults to the DEVICE home, not the local one** — ws-handler resolves `hosts.homeDir(host)` (dial-aware: over the device link) for the default; the New Session dialog also shows the device home as the cwd placeholder when a machine is selected.
- **`/api/file/info?host=<dial>` and `/api/home?host=<dial>` work** (was ssh-only → always 400 "it has no ssh", so the New Session preflight reported every existing device dir as nonexistent — the "/Users/<user> 不存在" report). RemoteFs `info`/`home` gained a device fast path, and `_run` routes over the device link for dial hosts so `stat`/`rename`/`copy`/`move`/archive metadata ops work on paired devices too. A genuine "not found" on a dial device now surfaces as an error (so the preflight offers to create it) instead of the misleading ssh message.

## 2.162.7 — 2026-07-15
- **Personalized-user pods could not be UPDATED — git "dubious ownership"** (real regression from the 3.5.0 personalized-username image): the container now starts as root and drops to the instance user via runuser, so the admin's `kubectl exec` update/restart path runs git as ROOT against the uid-1000-owned PVC repo, which git refuses ("detected dubious ownership"). update.sh now trusts its own repo (`safe.directory`) up front, and boot-root.sh sets `safe.directory '*'` system-wide each boot. Already-broken pods were healed live with the same git config.

## 2.162.6 — 2026-07-15
- **Dial-device CHAT went blank because the `__VS_OFFSET__` placeholder was never substituted** (real owner report; smoking-gun: the agentd-attach child ran with a LITERAL `--offset __VS_OFFSET__`). The chat-wrapper only substituted the placeholder + tracked the byte offset when `VIBESPACE_REMOTE_SID` was set (the keeper path); dial sessions use the agentd-attach bridge which honors the SAME contract but didn't reliably carry that env, so the attach child got offset=NaN and relayed zero bytes → blank. New `OFFSET_MODE` (REMOTE_SID OR any arg containing `__VS_OFFSET__`) drives the substitution, offset tracking, input queue and reconnect — a strict superset that can't affect the keeper path. NOT yet end-to-end confirmed on the Mac (there are further dial-session issues — see backlog B-dial).

## 2.162.5 — 2026-07-15
- **Opening a TERMINAL on a paired device no longer shows a blank window** — terminal mode isn't wired for dial devices yet (only chat rides the DialSessionBridge), and the rejection was sent WITHOUT a reqId so the client never matched it to the pending window (real report: Mac terminal 空白). It now carries reqId + a clear message pointing to chat mode.

## 2.162.4 — 2026-07-15
- **Paired-device sessions were blank because the daemon's child PATH had no node/claude** (the real owner root cause, on top of 2.162.3's stale-stream fix): launchd (macOS) / systemd (Linux) start the device daemon with a MINIMAL PATH; the daemon runs on node fine (full path) but every subprocess it spawned — the chat pipe-session running `claude`, the terminal pty, run-cmd, run-stream — inherited that minimal PATH and could not find node or claude, so `claude` never started and the session stayed blank (the tools probe on the Mac reported node:false/claude:false despite the daemon running on node v25). New `spawnEnv()` prepends the daemon's own node dir + ~/.local/bin + /opt/homebrew/bin + /usr/local/bin to PATH for all four spawn sites. Same class as the systemd baked-PATH incident. Rebuild the daemon (it self-upgrades) for the fix.

## 2.162.3 — 2026-07-15
- **Paired-device sessions/fs go blank while the device shows ONLINE — root cause** (real owner report, chat AND terminal on the Mac blank): after the device's daemon self-upgrades and re-execs it re-dials with a FRESH ws stream, but the server's cached DeviceManager stayed bound to the DEAD old stream (its `status().connected` lagged true), so every fs op, mount heal and session bridge silently talked to a closed socket — the fs path even fell through to the ssh branch and threw "it has no ssh". Fixes: `deviceForDial` tracks the stream its mux bound to and REBUILDS when the live stream differs; a re-dial proactively drops the stale cached DeviceManager (both the dial cache and `hosts._devices`) so the next op reconnects over the new stream.
- **`agentd deps not wired` boot race fixed**: the data-plane deps were wired 1s after boot via setTimeout; a device dialing in during that window failed its mount heal. Wired synchronously now (the functions are hoisted, `hosts` already exists).

## 2.162.2 — 2026-07-15
- **Mount tokens carry a structured `kind` + `owner`, not a name-prefix hack** (user directive: 用名字来匹配是不是太抽象了, 为啥不直接弄个类型或者来源字段): a reverse-mount token is minted with `kind:'reverse-mount', owner:<hostId>`; a user's share link is `kind:'share'`. Orphan GC and the UI classification both key off `kind` now — pre-2.162.2 records back-fill their kind from the old `host:<id>` name on read (no data rewrite). A user share named anything (even literally `host:…`) can never be mistaken for a reverse-mount token.

## 2.162.1 — 2026-07-15
- **Reverse-mount tokens stop piling up as garbage** (real report: 7 indistinguishable 反挂载令牌 rows, 6 of them duplicates from one bad afternoon): a FAILED push-mount now revokes the token it minted (every failed attempt — offline device, rclone error — used to leak one), unmounting already revoked, and a boot GC revokes any `host:*` token that no mount record references (clears the pre-existing pile on the next restart). Migration guard grew the assertion.

## 2.162.0 — 2026-07-15
- **Device daemons are PERSISTENT now** (user question after the dead-Mac incident: 那mac上是不是应该自动做持久化? — yes): the installer registers a supervisor instead of a one-shot detached process — **macOS: launchd LaunchAgent** (RunAtLoad + KeepAlive: starts on boot, auto-restarts on crash/upgrade hiccup), **Linux: systemd user unit** (Restart=always + best-effort linger), fallback to the old detached start where neither exists. The dial config is persisted to `state/dial.json` by the installer, so the supervised daemon starts ARGLESS — no tokens in any unit file or process list. Verified on Linux: kill -9 the daemon → systemd brings it back in 5s. Re-running the pairing command migrates an existing install to the supervised form.
- Pairing dialog note updated accordingly (no more "rerun the command after a reboot").

## 2.161.3 — 2026-07-15
- **Operations against an OFFLINE dial machine fail fast with a clear error** (real report: create卡住/terminal空白/mount打不开 — the Mac's daemon had died after a self-upgrade re-exec and every operation HUNG): `deviceForDial` errors immediately when the device isn't dialed in instead of retrying forever; session create / mounts / test all surface "device offline — rerun the install command" within a second. The pairing e2e now asserts the fast-fail.
- **Push-mount rows stop lying about a dead machine** (the 薛定谔的连接 report): the dot was hardcoded green — reads "worked" off rclone's dir-cache while writes silently died. For dial machines it now follows the live link state, with an honest tooltip (tunnel down, heals on reconnect).
- **Rejected dial-in attempts are logged** (accepted ones already were) — a silently-401'd redial was indistinguishable from "no attempts" while diagnosing the dead Mac.
- **B-ee6d: rclone install on a dial machine rides `runStream`** (unbounded) instead of the daemon's 30s `run-cmd` clamp — the ~20MB download on a slow uplink was killed mid-fetch and could never converge; ssh machines keep the plain path.

## 2.161.2 — 2026-07-15
- **The "workspace pushed down" root cause — the workspace itself was being SCROLLED** (live-tracer diagnosis on the reporter's machine, three instrument iterations): `#workspace` is `overflow: hidden`, and hidden containers are still *programmatically* scrollable — when focus lands inside a window that extends past the workspace bottom (freeform windows legally can), the browser's focus-scrolling scrolls the whole workspace (captured live: scrollTop stuck at 239, every window shifted by exactly that amount, no scrollbar to undo it). Correlated with bottom-edge right-clicks, which is why it looked like the context menu did it. Fix: `overflow: clip` (unscrollable by spec) + a scroll-snapback listener as the belt. A stuck workspace heals on reload even without the fix.

## 2.161.1 — 2026-07-15
- **The file explorer's context menu is the one that ran off-screen** (follow-up to 2.161.0 — that fixed `showContextMenu`, but the explorer has its OWN menu builder that predates it and had NO clamping at all): item/background menus now clamp into the viewport, over-tall menus cap + scroll, submenus flip/shift at the edges, and Escape closes them like every other popover.
- **双向挂载用语统一为「本 VibeSpace」** (user feedback: 一会 VibeSpace 一会工作区): push = 把本 VibeSpace 的文件夹挂载到"{机器}", pull = 把"{机器}"的文件夹挂载进本 VibeSpace — tooltips, dialog titles and field labels all agree now.

## 2.161.0 — 2026-07-15
- **Pairing installer 401 fixed** (real Mac report): the 2.154.x rename added the `/vibespace-device-install.sh|.ps1|/vibespace-device.js` routes but not their auth exemptions — every auth-enabled instance rejected the NEW pairing command with 401 (only the legacy `/agentd-install.sh` names worked). All six path generations are now cookie-exempt (the bundle is not secret; dial-in is gated by the per-device token).
- **Remote Terminate actually terminates** (real report: terminate一直不成功): the sidebar's Terminate for an EXTERNAL/tmux session on a REMOTE host sent the pid to the LOCAL kill route, which silently failed forever (and a colliding local pid could even have passed the claude check). `/api/kill-pid` is host-aware now — `hosts.killRemotePid` validates the pid is a claude/codex process ON the machine (device link first, ssh fallback) before SIGTERM, invalidates that host's discovery cache, and the client shows a success/failure toast instead of nothing.
- **Context menus stay on screen**: hover-opened submenus clamp into the viewport like the touch path always did (bottom-of-screen "Sessions ▸"/"Add to task ▸" ran off-screen), and a menu taller than the viewport gets capped + scrollable instead of leaving its tail unreachable.
- **Mount tooltips name the machine** (user suggestion): 挂载按钮悬浮提示由泛称改为具体 — "Mount a folder from this VibeSpace onto "Mac"" / "Mount a folder from "Mac" into this workspace".
- **Debuggability telemetry from the stale-tab incident retrospective**: client events now carry the BUNDLE's baked version (the server used to stamp its own, which made a stale tab invisible in telemetry — the exact blind spot of tonight's incident); `stale-bundle-reload` event when the auto-reload fires; attach/create REPLY WATCHDOGS — a request that gets no reply within 12/15s raises a visible toast and a `ws-reply-timeout:*` telemetry event instead of leaving a silently blank window.

## 2.160.1 — 2026-07-15
- **Stale-tab auto-reload (root fix for tonight's "更新后所有session都挂了" fleet incident).** A browser tab left open across a server update keeps its OLD bundle and silently misbehaves against the new server — attach/create sends vanish without a trace while the sidebar's HTTP polls keep working, so every window looks blank and "all sessions died" (they never did: every claude/codex/keeper process was alive the whole time; verified live on the affected instance — server attach returned full history, a fresh page rendered everything). The tab that RUNS the update reloads itself; other tabs never did. Now the bundle bakes its own version at build (`src/lib/build-version.js`, generated+gitignored) and compares it with `/api/version` on every ws (re)connect — mismatch → toast + one reload per server version (loop-guarded for dev rebuilds without a bump).
- macOS Finder shows a push-mount as an opaque `vsdav{hash}` volume (real report: 名字不太对) — rclone mounts now carry `--volname "VibeSpace <folder>"` on macOS.

## 2.160.0 — 2026-07-15
- **B-f3e8: ONE machine model — dial devices and ssh hosts are no longer two systems** (user architecture insight: the row-by-row feature inconsistencies were symptoms of an unfinished merge). A machine is a host record with `transport ∈ {ssh, dial}`; everything keys off `hostId`:
  - **Identity**: the pairing credential lives ON the dial host record (`dialTokenHash`) — `dial-tokens.json` is migrated losslessly at boot (`hosts.migrateDialTokenFile`, renamed `.migrated` only after every hash landed; devices in the field keep dialing in). Unpairing = `DELETE /api/hosts/:id` (full teardown: mounts, token file, live stream). Pairing survives config export/import with the host records.
  - **API**: `/api/agentd/devices` (roster/test/unpair) retired — the roster is `GET /api/hosts` (dial records carry live `online`, the hash is redacted), test is the unified `POST /api/hosts/:id/test` (dial branch probes over the mux and reports daemon identity + tools). `hosts-updated` broadcasts on pair/unpair/dial-in/dial-out flip the UI live.
  - **Mounts**: `HostMounts` + `DeviceMounts` collapsed into **`MachineMounts`** (src/machine-mounts.js; records carry `dir: push|pull`; one store `data/machine-mounts.json`, both legacy stores migrated + renamed). BOTH directions work on BOTH transports — pull rides `hosts.device(hostId)` (ssh daemon or dialed link), push rides the reverse-forward tunnel. One route set `/api/machine-mounts*`; `onMachineLinked` heals pulls AND re-owns push tunnel ports on (re)dial-in; the 90s pull health sweep stays.
  - **UI**: ONE `_buildHostRow` renders every machine (dial branches only where capability differs), ONE `_buildMachineMountRow` child row for both directions, ONE pull dialog for both transports — **with REAL remote-path autocomplete** (`hosts.dirComplete` now rides the device link, so dial machines complete their OWN folders — real report: it completed local ones); ssh machines keep a read-write escape (SFTP). The Machines section shows **This machine** first (local = device #0, the CS-graduation architecture made visible). Manage-Agents' machine dropdown labels dial devices correctly (was `undefined@undefined`).
  - Migration guard `scripts/test-machine-migrate.mjs` (13 asserts incl. real-store dry-run against production copies) + `dbg-pair-smoke` re-pointed at the unified APIs (22 asserts, real daemon dial e2e) + local-session guard — all green.
- **Review-hardened (8-agent adversarial pass, 3 confirmed findings fixed pre-release):** config-bundle import merge-preserves `dialTokenHash` when the incoming record lacks one (a pre-2.160.0 bundle would have wholesale-replaced the roster and locked every paired device out — raw tokens only exist on the devices); the mount-store migration saves STRICTLY + re-parses before renaming the legacy files, per-file (an ENOSPC boot or one corrupt store can no longer lose the other's records — false-success log fixed too); ssh-host removal keeps the OLD preserve-as-orphan mount semantics (the confirm dialog promises "nothing on the remote machine is touched", and remove+re-add is the only way to edit a host's address — only dial unpair tears mounts down); `mountPull` expands `~/` (the dialog's own autocomplete suggests those); the pull health sweep also retries recorded-but-never-lived pulls with 5-min backoff (ssh machines have no dial-in event to heal on); corrupt `hosts.json`/`machine-mounts.json` are backed up `.corrupt-<ts>` before proceeding empty (hosts.json is now the sole holder of pairing credentials); `setDialToken` errors honestly on a sanitized-name collision instead of a null-deref.
- **Push-mount to a Mac fixed** (real report: "rclone mount failed:" with an empty error). Three stacked bugs: macOS has no `setsid` (the mount one-liner died at command-not-found — same trap as the installer, 2.152.1; now conditionally prefixed), macFUSE was probed via the SERVER's `/dev/fuse` (always present on Linux pods — a macFUSE-less Mac was sent down the rclone path instead of native `mount_webdav`; now probed ON the Mac), and the rclone error went to the remote log file the fd-redirect points at (now pulled back into the dialog message).

## 2.159.0 — 2026-07-15
- **Dial-device rows reach parity with ssh host rows** (user request): a paired device now has BOTH mount directions — pull (📥 mount a folder FROM the device into this workspace) AND push (📤 share a folder from this instance onto the device, over the device tunnel via HostMounts) — plus a **New session on this device** button. The New Session dialog's host dropdown labels a dial device as "(device)" instead of "undefined@undefined". Sessions and reverse-mounts on a dial device route through the device link (the ws-handler dial branch + HostMounts' device data-plane) — no ssh needed.

## 2.158.1 — 2026-07-15
- **Device mounts self-heal after the device's daemon re-execs** (real Mac report: the Downloads mount opened, then every listing hung after the Mac daemon auto-upgraded 2.153.3→2.157.0). A re-exec kills the serve-folder the mount was pointed at, but the record still thought it was live — so the tunnel pointed at a dead port. Two fixes: (a) `onDeviceDialedIn` now TEARS DOWN the stale live handle before remounting (the old code's `_up` no-op'd because it still saw a live handle); (b) a 90s health sweep child-process-`ls` probes every live device mount and re-mounts any whose listing hangs — so an already-settled stale mount heals on its own too (a hung fuse mount is never probed with node fs — §2.108.3 threadpool lesson). Immediate recovery without updating: unmount (×) and re-mount the folder.

## 2.158.0 — 2026-07-15
- **CS graduation: the device agent is ON by default.** `agentd.sessions`, `agentd.remoteSessions`, and `agentd.dataPlane` now default to true — local sessions run through the standing daemon (survive server restarts), remote sessions use the persistent daemon session, and remote fs/discovery/transcript/usage ride the device data-plane (one connection, incremental sync). Every path keeps its automatic ssh fallback, and a `dbg-local-session-smoke` regression guard proves normal local sessions still spawn byte-identically. (Soaked on the u-vstest instance with all flags on.)
- **Account billing on dial devices (B.3 tail): API keys yes, subscriptions no** (user directive: "oauth 默认禁止搬运，api key 可以"). A selected API-key account ships its value via `fsWrite` into a 0600 file on the device (referenced by `$(cat …)`, never in argv); a selected SUBSCRIPTION login is refused with a clear error (§ban-safety — a subscription token live from a device IP is an impossible-travel/abuse signal), same as the ssh path — log in on the device or use an API key. The wrong-billing case fails the create loudly instead of silently falling back to the device's own login.

## 2.157.0 — 2026-07-15
- **Agent tools work on dial-device sessions (slice B.3).** A chat session created on a paired device now gets the full agent prelude, ported from the ssh path to the DEVICE LINK: `vibespace-status`/`vibespace-task`/`vibespace-ask` + the per-session token ride `fsWrite` into `~/.vibespace/bin` (token 0600), the hook is registered with `runCmd`, and **`VIBESPACE_API` is a reverse-forward** — a loopback port bound ON the device whose bytes tunnel back to the server (the same NAT-proof primitive host-mounts uses), so the tools reach the server with no inbound access. Reverse tunnel is torn down on kill. Degrades to a bare-env session on any setup error (the session still runs). New `scripts/test-device-agent-setup.mjs` proves every primitive over a real dialed daemon incl. the VIBESPACE_API round-trip. Account-key shipping over the device link is the remaining B.3 tail (the device's own claude login is used until then).

## 2.156.2 — 2026-07-15
- **Remote sessions can no longer steal a LOCAL session's id** (found by the full id-adoption trace after the userL incident): the local lock-file capture wasn't gated on locality — a remote session with the same cwd as a local one could false-match the local lock and adopt the WRONG claude session id. Lock capture is local-only now; remote sessions get their id from the stream parser's unconditional first-capture (2.156.1), which every stream-json line feeds — existing null-id sessions self-heal on their next activity, no belt needed.

## 2.156.1 — 2026-07-15
- **Root cause of the "remote session goes permanently blank" incident (userL, tonight): session-id FIRST-capture was impossible.** The stream parser's only `session_id` adoption was gated behind the fork flag (`_forkRequested`, the 2.x fork-adoption guard) — so a session created with `claudeSessionId: null` could NEVER learn its own id from the stream. Local sessions were silently rescued by lock-first discovery (local lock files visible), which masked the hole; REMOTE keeper sessions had no rescuer — meta kept `null` forever, and any later re-attach died prefetching the transcript with a bare path error → the window stayed blank while the remote claude kept running fine. Fix: **first capture (no tracked id yet) is unconditional** — hijack-safety is intact because with no tracked id there is nothing to hijack, and a CHANGED id still requires the fork flag. (Also removed a duplicated `effort:` line in the same meta write.) The incident pod was healed by hand (meta patch from the keeper's own record + in-place respawn, zero data loss — recipe in the fleet ops notes).

## 2.156.0 — 2026-07-15
- **Sessions on dial-out devices (slice B.2, first cut — chat).** Creating a chat session on a paired device now works: the session runs as a persistent pipe session in the device's own daemon; the local chat-wrapper's attach child reaches it through the server's loopback mux proxy (DialSessionBridge; per-session port, token-gated, persisted in session meta and re-owned on server restart so surviving wrappers reconnect; bridge closed on kill). First cut is minimal-env: the device's OWN claude login is used — account shipping / vibespace-tools distribution / pre-resume orphan sweep are ssh-coupled preludes that port to device fs ops next (B.3). Terminal mode on dial devices stays gated. The ssh path is structurally untouched (wrapped, byte-identical).

## 2.155.1 — 2026-07-15
- **Slice B.2 groundwork (inert until wired): sessions on dial devices.** `vibespace-agentd-attach` gains a loopback-TCP transport (`cfg.tcp.port` — everything else identical to the ssh mode), and a new `DialSessionBridge` (src/dial-session-bridge.js) lets the server proxy the attach protocol onto a dialed-in device's single mux link (hello/open/attach-pipe-session/data/credit; per-session 127.0.0.1 port, token-gated, port pinned for restore). Not yet reachable from the create path — ws-handler wiring + e2e land next; the dial-host create error message stands until then. M1/M2 session suites re-verified green.

## 2.155.0 — 2026-07-15
- **Graduation slice B (first half): a paired device IS a machine in the hosts model.** Pairing now creates a real host record (`transport: 'dial'`, no ssh fields; unpair removes it; existing pairings are backfilled at boot) — so dial devices appear everywhere machines are listed. **Files on the device work through the standard `?host=` dispatch** (RemoteFs is FORCED onto the device fs path for dial hosts — they have no ssh fallback), and **session discovery answers over the dial link** (the device raw-facts snapshot, same forced gate). `hosts.sshArgs` throws an honest error for dial hosts, so every legacy ssh path fails loud instead of weird. Running SESSIONS on a dial device is the second half (needs a server-side attach bridge — the dialed link lives inside the server process); the create dialog says so cleanly instead of erroring cryptically. E2E grew to 21 assertions (host record on pair, device-path file listing, discovery answer, record removal on unpair).

## 2.154.1 — 2026-07-15
- **Rename slice A (graduation): everything user-facing says `vibespace-device`.** Fresh installs save and run `vibespace-device.js` (dial-out roots at `~/.vibespace/device@<instance>`), the served endpoints are `/vibespace-device.js` + `/vibespace-device-install.sh|.ps1` (the old `/agentd*` URLs stay as PERMANENT aliases so existing docs/pairings keep working), the pairing dialog emits the new commands, and the daemon's self-upgrade now re-lands under **its own current filename** (a hardcoded `agentd.js` would have silently renamed fresh installs back on their first upgrade). Existing installs keep running untouched — they'll show as `vibespace-device` in process listings after their next self-upgrade (process.title), and adopt the new filename whenever re-paired. Internal source/flags rename (src/agentd/, agentd.* settings) lands with the hosts-model merge (slice B).

## 2.154.0 — 2026-07-15
- **Both mount directions on every machine row** (user request): next to "share a folder onto this machine" (push icon), hosts now have "mount a folder from this machine into this workspace" (pull icon) — a one-field shortcut that creates and connects an SFTP mount prefilled with the host's address/user/port/key.
- **Bridge tokens say what they're for** (user report: `host:host-2c4517af` 语义不明): a reverse-mount's token now reads "Reverse-mount token — \"frps-server\" accesses /home" with "Read-write · revoking breaks that machine's mount"; tokens of removed machines are labeled as such; hand-minted share tokens keep their given names.

## 2.153.4 — 2026-07-15
- **Remote rclone install works on bare Debian** (real report on frps-server: `sh: 1: unzip: not found`): the reverse-mount's remote installer falls back unzip → busybox unzip → python3 zipfile, and only then fails with an actionable "apt install unzip" hint.
- **Reverse-mount folder field accepts `~`** and gives a real error: a literal `~` used to resolve against cwd and die with a bare "root does not exist"; now tilde-expands and reports "folder does not exist on this instance: <abs>".
- **Honest ssh key provenance** (real report: an imported private key was labeled "using VibeSpace key"): host records carry `keySource` (imported / app / default); the row sub-line now says "using imported key" / "using VibeSpace key" / "using system ssh keys" accordingly (older records show a neutral "using stored key").

## 2.153.3 — 2026-07-15
- **Three folder icons, three meanings — now visually distinct** (user feedback): push-to-machine (folder + outgoing arrow, host rows' "share onto this machine"), pull-from-device (folder + incoming arrow, device rows' "mount into this workspace"), plain folder (open in Files).
- **Stale device mounts self-heal AND have a hand-back.** rclone is spawned detached, so it survives a server restart while its tunnel bridge dies — the mountpoint stayed claimed by a dead orphan and the dial-in heal's fresh mount failed forever (real report: device online, mount row stuck gray with no reconnect option). `deviceFolderMount` now PRE-CLEANS (lazy-unmount + kill the exact orphan rclone by /proc cmdline) before mounting, and non-live mount rows show a ↻ **Remount** button (`POST /api/device-mounts/:id/remount`).

## 2.153.2 — 2026-07-15
- Device machine rows match ssh host rows exactly: action icons sit on the TOP line's right side (they were stacking on a second line — actions belong INSIDE `.mounts-row-top`), plus the same style sub-line ("dial-out device · connected/offline"). Daemon processes now show as `vibespace-device` in process listings (`process.title`; the full rename is graduation slice A).

## 2.153.1 — 2026-07-15
- Device mount child rows use the real child-row language (`mounts-row-child` indent + accent border, folder basename + "from device" badge, full paths in the tooltip) — the first cut used a nonexistent class and rendered as a full-width sibling that read as another machine (real report).

## 2.153.0 — 2026-07-15
- **Paired devices are MACHINES now** (user feedback ×4 on the 2.152.1 first cut: ugly centered blob, no actions, "也不被算作远程机器，那配对的意义是？"). Devices render inside the Remote tab's machines list with the same row language as ssh hosts (status dot + name + DEVICE badge) and REAL actions: **⚡ test** (mux hello + daemon identity), **📁 mount a folder FROM the device** into this workspace (the full device-folder-mount chain: serve-folder WebDAV → dial tunnel → rclone, read-only — your NAT'd Mac's folder appears as a local dir with zero ssh/public address), **× unpair**. Mounts persist (`data/device-mounts.json` + `src/device-mounts.js`), auto-heal when the device re-dials, child rows with open-in-Files/unmount. Sessions-on-device is the next CS milestone (dial devices joining the hosts model fully).
- **Pairing dialog got per-OS commands** (user request): macOS / Linux (bash installer) / **Windows (EXPERIMENTAL)** — a new PowerShell installer (`/agentd-install.ps1`, PS 5.1-compatible) plus a win32 named-pipe control socket in the daemon.
- **One machine can pair to SEVERAL VibeSpace instances** (user request): a dial-out install now keys its root by the instance's address (`~/.vibespace/agentd@<host>` — own daemon, tokens, self-upgrading bundle each), so instances never clobber each other's `state/token`.
- E2E smoke (17 assertions): pair → REAL agentd dials in → online flip → test → mount → file readable through the mount → machine row + child row render → Windows command → unmount → unpair.

## 2.152.1 — 2026-07-14
- **macOS device install actually starts the daemon.** The installer ran `setsid node …` unconditionally — **macOS has no setsid(1)**, so on a Mac the daemon never started, the error went into the redirected `agentd.out`, and the script printed ✓ anyway (real report: paired a Mac, ran the command, nothing appeared). Now: `setsid` where available, `nohup … &` otherwise, and the script VERIFIES the process survived before claiming success (on failure it prints the last lines of `agentd.out` and exits 1).
- **Paired devices are now visible: Remote tab "Paired devices" section.** A paired dial-out device previously had zero UI presence (the pairing dialog even claimed it would "appear wherever machines are offered" — it didn't; text fixed too). Each pairing renders a row with a live dot (green = its daemon is dialed in right now), and an unpair button (revokes the dial token, drops the live link). New `GET /api/agentd/devices` + `DELETE /api/agentd/devices/:id`. Smoke-verified end-to-end: pair → offline row → REAL daemon dial flips it online → Remote tab renders it → unpair removes it. (Deeper integration — sessions/files ON a dialed device from the machines pickers — is the parked CS-productization step.)

## 2.152.0 — 2026-07-14
- **URGENT fix: closed windows resurrected on every desktop round-trip** (real report, minutes after updating: "所有窗口都关闭不了" — close, switch desktop, switch back → the window reappears, often as a view-history copy). Root cause: 2.141.1's switchTo merge-preserve (protecting slow lazy-replaying windows from being dropped on fast switches) keeps any openSpec-backed record that isn't in `wm.windows` — which is **indistinguishable from "the user closed it"**, so a closed window's stale `_savedStates` record was carried forward forever and lazily replayed on return. Fix: `wm.closeWindow` now calls `desktopManager.purgeClosedWindow(id)` — an explicit close (detach and terminate alike) removes the window from EVERY cached desktop record. Verified by a new CDP smoke covering close on plain desktop / stage enabled / on-stage / post-stage-leave AND the exact open→round-trip→close→round-trip resurrect repro.
- **Device pairing UI (B-e5e7): Remote tab → "Pair a device (no ssh — it dials out)".** Names the device → `POST /api/agentd/dial-pair` → shows the exact one-line installer command (copy button) including `--bundle-url`, the quoted dial URL, `--dial-token` AND `--host-token` (the docs' command previously omitted `--host-token` — without it the device dials in but rejects every server command, since that token is what the daemon verifies our mux hello against). CDP-verified end-to-end (dialog → pair → command with both tokens → server-persisted sha256). i18n zh+ja. Machines reachable over ssh don't need this (Add machine installs the agent at first use).
- **Group manager works now, and manages ALL groups** (user directives ×3):
  - **Session Properties "Group manager" toggle never saved** — `setSessionConfig`'s field whitelist silently dropped `groupManager` (third strike of the documented 2.43.0 'account' bug class; the checkbox reverted on the echo re-render). Whitelisted.
  - **Manager scope = every group, not just belonging**: the group-admin verbs (list/create/update/bind/unbind) were already all-groups; now the REGULAR verbs (`show`/`progress`/`backlog-*`) also accept ANY group via `--group <id>` for a designated manager (`resolveAgentGroup` bypass; unknown id → 404 with a `group-list` pointer; non-managers keep strict belonging enforcement).
  - **The manager LEARNS its powers in context**: a one-shot `<vibespace-group-manager>` block (task-context for claude, prompt-context for codex — same seen-flag) teaches `group-list/create/update/bind/unbind` + the any-group `--group` rule + the roots limit; the per-turn micro-reminder carries a short manager clause. Previously NOTHING told a designated session it was a manager — it could only find out by tripping over a 403.
  - test-group-admin.mjs grew 8 assertions (cross-group progress + attribution, 404 pointer, non-manager still 403, intro one-shot, reminder clause, non-manager gets neither).

## 2.151.0 — 2026-07-14
- **Device-folder-mount read stall ROOT-CURED: the device serves WebDAV, not plain HTTP.** rclone's `http` backend requests a fixed 128MB range per read and then waits ~6s on the keep-alive connection after the clamped 206; its `webdav` backend requests sane ranges and reads instantly. `serve-folder` (agentd) is now a minimal read-only WebDAV subset (OPTIONS / PROPFIND Depth 0-1 / HEAD / GET+Range; zero deps, mirrors `src/webdav.js`) and `device-mount.js` mounts it with the `webdav` backend. Verified: PROPFIND listings + ranged GETs through the tunnel byte-exact (`test-agentd-devicemount`), real FUSE mount reads a device file in **7ms** (`test-device-mount-rclone`). Second bug found while verifying: the acceptance test DEADLOCKED ITSELF — sync fs on the mountpoint blocks the event loop of the very process hosting the tunnel bridge, so the FUSE read can never be served (same class as the 2.147.0 sync-exec-with-in-process-/dav lesson; `ls` "worked" only because rclone's dir-cache answered without bridge IO). All mount IO in the test now runs in async child processes with a 10s watchdog + an explicit read-latency assertion. Production is unaffected by construction (bridge lives in the server; reads come from other processes / safe-fs workers).
- **Stage preview ghost REALLY fixed (second report).** The 2.134.0 fix read `win._stageHomeBounds?.gridBounds`, but `_stageHomeBounds` IS the flat `{left,top,width,height}` object — the condition was always undefined, so a stage-borrowed hero kept painting at the stage SLOT position on its home desktop's preview. Now reads the flat shape: the hero draws at its HOME bounds.
- **Stage → desktop switch no longer leaves the target's preview blank.** `leave()`'s `setGrid` fired an intermediate preview render while every target-desktop window was still hidden; the render digest didn't cover the hidden flags, so the blank render was cached and the post-show render early-returned — the preview stayed white until you visited another desktop and back. The digest now covers `_hiddenByDesktop`/`_hiddenByStage`/`_onStage`, and `leave()` mirrors `switchTo`'s delayed `refreshSwitcher()` retries (covers lazily-replayed windows whose geometry lands in a 500ms timeout). Both fixes verified by a NEW committed CDP smoke — `scripts/test-stage-preview.mjs` (throwaway git-worktree server + headless chrome, 9 assertions through the REAL materialize/leave paths; no more ephemeral stage harnesses).
- **Gmail sync freeze fixed (real report: incremental stuck ~3h at zero progress).** `history.list` reports messages ADDED since the cursor; some are deleted again by fetch time (spam auto-purge — guaranteed on an unfiltered mailbox, which includes spam/trash). The per-message `messages.get` 404 failed the WHOLE pass, and since the cursor only advances after a complete pass, every 120s retry re-listed and re-404'd the same dead id forever. Gone messages are now skipped (`_writeGone404`, both seed + incremental paths); every Gmail API/token fetch is also bounded (60s/30s `AbortSignal.timeout`) so a wedged connection errors into the existing backoff instead of hanging a pass. Mock e2e gained the regression case (dead id in history → pass completes, cursor advances past it). Existing stuck mounts self-heal on the first pass after updating.

## 2.150.0 — 2026-07-14
- **Remote-host files now open in every viewer, the editor, and the hex viewer.** They were reading the LOCAL filesystem (opening a remote-host file showed `ENOENT`) because the host id was never threaded into the `/api/file/*` fetch URLs — the server routes already dispatch on `?host=`. Fixed 100% client-side across `FileViewer.open`/`renderInto` + every `_render*` helper (raw/csv/excel/docx/media/archive), `HexViewer`, `CodeEditor` (content / write / serve base href), the `openFile`/`openEditor` openSpec, the explorer's open sites + preview panel, `replayOpenSpec`, and layout restore. The window title carries a `<host name>: ` prefix so a remote file is visibly not local — resolved via a new app-level host-name cache (`app.hostName`/`_ensureHostNames`, lazily loaded from `/api/hosts` and refreshed on `hosts-updated`) so it shows the machine name, not the raw host id.
- **Device-folder-mount mechanism + dial-in device consumption** (the two CS wirings): a dialed-in NAT'd device becomes drivable server-side (`DeviceManager` `stream` transport + `deviceForDial`), and a device can serve a folder over a minimal in-daemon HTTP server (`serve-folder`) that the server tcp-forwards and rclone-http-mounts — NAT-proof, no public address. The tunnel path is proven byte-exact end-to-end (`test-agentd-devicemount`). NOT yet a user-facing mount type: the real rclone binary stalls ~6s per read (it requests a 128MB range on a small file, gets a clamped 206, and waits on the connection before finalizing — reads succeed but slowly), an rclone http-backend interaction still to resolve.
- **SMB/NAS mount** — the intermittent `Input/output error` on listing no longer flashes a false "access denied / revoked" banner (the 2.149.0 re-confirm + neutral-message fix covers it; root cause is an intermittent FUSE/SMB IO error on the mount root, not auth).

## 2.149.0 — 2026-07-14
- **Root-cause fix: `agentd.remoteSessions` multi-writer on cold resume.** A remote chat under `agentd.remoteSessions` runs claude setsid-detached in the remote daemon, which SURVIVES a local pod rebuild. A later sidebar cold resume spawned a fresh `claude --resume` WITHOUT killing the survivor (the keeper path does `keeper stop`; the agentd path had no equivalent), so multiple claudes wrote one transcript → "resume does nothing / the session ends" (real incident: 3 concurrent writers on a live the devbox session). The pre-resume sweep is now **mechanism-agnostic** — it scans `/proc/*/fd` and SIGTERMs any claude holding `<sessionId>.jsonl` open regardless of how it was spawned (bare / keeper / agentd). Validated on the real host: scoped to the exact transcript, never touches `history.jsonl` or other sessions.
- **SMB/NAS mount stops falsely reporting "access denied".** A fully-accessible SMB mount kept flashing *"connected but access denied — the share may have been revoked or its credentials changed"* (user report). Three fixes: `_probeBackendAccess` now returns `unknown` (not `denied`) for non-auth `lsf` failures — SMB fails to enumerate the server root while the mounted share lists fine; a new `_accessErrorFor` re-confirms (re-probe the mountpoint AND the backend) before surfacing, so a single non-zero `ls` or a transient no longer cries wolf; and the message is type-aware — "revoked / credentials changed" only for an **imported** share (there's a token to revoke), while a backend you configured (SMB/NAS, SFTP, own S3) gets a neutral "couldn't list the folder — the server may be busy" message.
- **Folder right-click "Share this folder…" is now a submenu**: *Create share link* (the WebDAV bridge link, as before) + *Mount to `<machine>`* for each configured host (flattened) + a picker that fetches machines fresh. Mounts the folder onto the remote over the agentd tunnel (2.148.0). i18n zh+ja.
- **Review-hardening (self-audit of 2.148.0, 4 confirmed defects fixed):** the tunnel's `mux.onDead` destroys the local `/dav` sockets it opened (were leaking on every link drop); disowned daemon listeners get reaped after a 10-min grace; chat uploads route `?host=` so **remote-session uploads land on the host**, not the local server; orphan reverse-mounts (host removed) render in their own unmountable section; preset-loaded browser windows keep proxy mode.

## 2.148.0 — 2026-07-14
- **Reverse-mount rides the agentd TUNNEL — no public address / Tailscale / VPN.** (User directive: "不应该通过 tailscale 处理吧，我们本来就要测试内网穿透能力".) The remote reaches our `/dav` over the device link itself: a new mux primitive (`tcp-listen`/`tcp-accept`/`tcp-unlisten`) makes the daemon bind a loopback port ON THE DEVICE whose accepted connections push back over the mux into our own `127.0.0.1:<serverPort>`. `HostMounts._davBase` mounts `http://127.0.0.1:<port>/dav` — NAT-traversal by construction, `agentd.publicUrl` is now only the fallback for device-less hosts. The daemon keeps the port bound across link drops so a reconnecting server re-owns it (mount heals in place, no remount); `restore()` re-owns ports for surviving mounts after a server restart. Backpressure on both TCP paths (credit-after-drain).
  - **Reverse-mount UI**: the Remote tab's host row gains "share a folder onto this machine"; active reverse-mounts render as child rows (folder → mountpoint, tunnel/address badge, unmount) and live-refresh on `host-mounts-updated`.
  - **Proven end-to-end on a real host with `/dav` bound to `127.0.0.1` ONLY** (no external address can reach it): the devbox still mounted our folder and read files + multibyte filenames purely over the ssh-stdio device link. `scripts/test-agentd-tunnel.mjs` (primitive: round-trip, bidirectional/multibyte, HTTP-through-tunnel, **link-drop → port survives → reconnect re-owns**, 2 MB flood doesn't starve, unforward) + `scripts/test-host-mounts-tunnel.mjs` (real host, 127.0.0.1-only /dav).
- **Window sync/persistence gaps closed** (user report):
  - **Browser windows** now persist and sync PROXY mode (was a local closure var — always reset to Off on refresh/other clients) and reliably persist the navigated URL (navigation calls `scheduleAutoSave`, gated so replay can't echo).
  - **Usage window** always records its openSpec — the replay path previously dropped it, leaving a synced usage window transient (never re-syncing onward, never closing on later diffs) on the receiving client.
  - **Desktop window** was already correctly wired (2.107.1 generic-openSpec restore + remote replay) — no change; confirmed, not a regression.
  - **Architectural safeguard**: `captureState` now breadcrumbs (deduped telemetry) any non-transient window persisted without an openSpec, so a future window type added without one surfaces in Diagnostics instead of silently failing to sync — retiring the whole "new window type vanishes on refresh/other clients" bug class.
- **Configurable upload destination** (`chat.uploadDir`): files dropped or attached in chat land in the session's working directory by default, or in a fixed folder you set — absolute (`/…` or `~/…`, the server expands `~` to its home) used verbatim, or a name (e.g. `Downloads`/`uploads`) taken relative to the working directory. For remote sessions the path is on the remote machine. The drop-overlay hint reflects the setting. i18n zh+ja.

## 2.147.0 — 2026-07-14
- **互挂云盘 (mutual cloud-disk mounting) + standalone device agent.**
  - **Reverse mount** (a remote machine mounts THIS VibeSpace's storage): new `src/host-mounts.js` (HostMounts) mints a scoped `/dav` WebDAV token and mounts it on the remote, OS-aware — Linux rclone/FUSE (fallback davfs2), macOS rclone/macFUSE or built-in `mount_webdav` (no FUSE), Windows rclone/WinFsp or built-in `net use`. rclone auto-installed on the remote when missing; orchestrated via the device agent when the data-plane flag is on, else ssh. Routes `/api/host-mounts` (list/mount/unmount); setting `agentd.publicUrl` (or request-derived). Forward direction (VibeSpace mounts a remote) is the existing SFTP mount. **Verified end-to-end on a real host** (the devbox over Tailscale): file appears in the remote mountpoint, content + multibyte filename readable, unmount clean.
  - **Standalone device agent**: run ANY machine (Mac/Linux) as a VibeSpace device without a full server. `scripts/vibespace-agentd-install.sh` fetches the bundle, provisions the token, runs the daemon — standing (reachable) or **dial-out** (NAT'd laptops/Macs dial the instance over wss). Served publicly at `/agentd.js` + `/agentd-install.sh` (auth-exempt; auth = per-device dial/host token at connect). `POST /api/agentd/dial-pair` mints device id + dial token + command. Docs `docs/device-agent.md`. **Verified end-to-end**: the installer set up a daemon that dialed into a running instance and registered as a device.
  - Hygiene: HostMounts uses async exec (a sync exec blocked the event loop so the in-process /dav couldn't serve the remote's mount requests — real e2e catch); detached rclone redirects all fds (frees the ssh ControlMaster).

## 2.146.0 — 2026-07-14
- **CS refactor: the data-plane consumer switchovers are wired** (flag `agentd.dataPlane`, default OFF; every path falls back to classic ssh automatically on any failure). With the flag on, remote operations run through the standing device agent over ONE persistent connection instead of ssh-per-operation:
  - **Remote files** (RemoteFs list/readText/readBinary/write/mkdir/remove) go through device fs ops — verified against a real host with the device output cross-checked item-by-item against the legacy ssh output.
  - **Session discovery**: the daemon's raw-facts snapshot (live-filtered locks, jsonl inventory, tail ids, head cwd, first-user-lines) is synthesized into the exact line format the ssh script emits and fed to the UNCHANGED parser — zero interpretation drift (real-host check: identical session sets, 6/6).
  - **Remote transcripts**: incremental slab sync — transcripts are append-only, so a cached prefix fetches ONLY the [cachedSize, size) delta via read-range instead of re-pulling the whole file (real-host check: byte-identical after a remote append). The whole-file remote-jsonl pull remains only as the fallback.
  - **Usage harvest**: the scanner ships via device fs write and runs via the new `run-stream` primitive (byte-channel stdout — NDJSON outputs exceed run-cmd's buffer), same cursor semantics.
  - The daemon's discovery snapshot gained the raw-facts enrichment (tailIds/headCwd/userLines, bounded to the newest 60 files) and a `run-stream` op. `hosts.device(id)` is the shared per-host DeviceManager registry (auto-install + reconnect).
  - Acceptance: scripts/test-agentd-switchover.mjs — all four switchovers against a REAL remote host, with legacy-vs-device cross-checks. 12/12 suites green.

## 2.145.0 — 2026-07-14
- **CS refactor M3–M5 device-side primitives, acceptance-tested end-to-end** (internal; nothing routes user traffic yet): M3 — fs ops (stat/list/write/mkdir/rm + read-range streaming on a byte channel = the transcript-slab primitive, byte-exact across multibyte splits), session-discovery RAW FACTS (live-filtered locks + jsonl inventory; the claim algorithm stays server-side per invariant #2) with fs.watch dirty PUSH; M4 — run-cmd (argv-only bounded exec with stdin, the clipboard shape) and tcp-connect (loopback-only byte-channel forward, the VNC-bridge shape), Ctrl+G shape proven as write→device-edit→read-back; M5 — the mount-class device process lifecycle (persistent pipe session + health probe + teardown). 18-scenario acceptance suite (scripts/test-agentd-m3m4.mjs); design doc gained a milestone status record. With M0–M2 + both transports already shipped, the PROTOCOL and DEVICE side of every CS milestone is now implemented and tested — remaining work is flag-gated consumer switchovers in the server subsystems.

## 2.144.0 — 2026-07-14
- **CS refactor Transport B: dial-out for devices you can't ssh into** (M4-lite, internal — endpoint live but nothing routes user traffic through it yet). A NAT'd/firewalled device's agentd can now DIAL OUT to the server: `agentd --dial wss://…/api/agentd-dial?device=<id> --dial-token <t>` maintains an outbound websocket served by the SAME connection handler as every transport (the dial config persists; the daemon re-dials with backoff forever — the device keeps itself reachable). The daemon bundle gained a hand-rolled zero-dependency RFC6455 client (binary frames, masking, ping/pong, fragmentation reassembly — including the classic `head` bytes-with-the-101 trap, which ate the server's first frames on fast reconnects until the e2e caught it). Server side: an `/api/agentd-dial` branch in the single upgrade dispatcher (gated by a per-device dial token, sha-stored; real protocol auth stays the in-mux vsht_ hello) + `POST /api/agentd/dial-pair` mints device pairings. e2e (scripts/test-agentd-dial.mjs): dial-in, hello auth, pipe session over the dialed transport, AUTO-REDIAL after a drop with a fresh handshake, and bad-token refusal at the gate. So the architecture's answer to "为什么一定要 ssh": it never was — ssh is one transport; this is the other.

## 2.143.0 — 2026-07-14
- **CS refactor M2 wired (opt-in, default OFF): remote chat sessions can run inside the standing device agent.** Setting `agentd.remoteSessions` (needs `agentd.sessions` too; both default off, restart to apply) routes remote chat through the daemon architecture: the session runs as a persistent PIPE SESSION inside the remote vibespace-agentd (installed/refreshed automatically at spawn — bundle + host `vsht_` token over ssh stdin, one round trip per version), and the local chat-wrapper spawns the new **vibespace-agentd-attach** bridge instead of `ssh … keeper run`. The attach bridge is a drop-in for the keeper-run contract (raw bytes on stdout, `__VS_OFFSET__`, sentinel passthrough, exit-after-sentinel) so the wrapper's reconnect machinery is untouched. The full wired chain is e2e-proven (scripts/test-agentd-wired.mjs): the REAL chat-wrapper over the attach bridge → daemon → child; a killed bridge auto-reconnects with the consumed offset (no tick lost or duplicated); the child's real exit finalizes the wrapper with its code. Existing spawn-time shell semantics (account-key file reads, agent-tools prelude, reverse tunnel) are preserved by running the child under `sh -lc` in the daemon session and carrying the tunnel on the bridge's ssh. Both flags off = byte-identical keeper path; keeper remains the default until this graduates.

## 2.142.2 — 2026-07-14
- **CS refactor M2: adversarial robustness verification** (scripts/test-agentd-robustness.mjs) — the ssh-bridge + persistent pipe-session model proven under stress: (1) BIDIRECTIONAL round-trip (child requests → server answers → child continues, the codex-approval shape); (2) 40KB binary + multibyte UTF-8 round-tripped byte-exact both ways; (3) NETWORK JITTER — 5 mid-stream bridge drops, byte-offset reattach each time, stream reassembles perfectly contiguous with ZERO loss and ZERO duplication (confirmed to the exit sentinel); (4) IO LATENCY — 120ms/chunk transport delay, all chunks delivered in order, credit flow control never deadlocks, offsets stay exact; (5) CONCURRENCY — a 2MB flood on one session does not starve another sesion'''s pings (per-channel credit fairness). Green locally, inside the fleet test pod (real node + cephfs), and on a real remote host over genuine ssh.

## 2.142.1 — 2026-07-14
- **CS refactor M2: remote agentd install + real-ssh verification.** `hosts.installAgentd()` ships the daemon bundle + provisions the host `vsht_` token (0600) into `~/.vibespace/agentd/<ver>/` over ssh stdin (one tar, nothing secret in argv), symlinking `current` — the same distribution pattern as the agent tools. Verified end-to-end on a real remote host (the devbox) over genuine ssh (scripts/test-agentd-real-ssh.mjs): install → handshake+auth over the ssh stdio bridge → persistent pipe session spawned on the host → session child SURVIVES the ssh bridge dropping (confirmed by an independent host-side `kill -0` probe) → reconnect over a fresh ssh bridge → byte-offset reattach with no replay → exit sentinel. All four in-repo agentd suites (mux / M0 / M1 / M2) also pass INSIDE the fleet test pod (real node, cephfs PVC). Still internal — not wired into the live remote path (that final step retires the remote keeper + lands codex remote chat B-0588 in the daemon).

## 2.142.0 — 2026-07-14
- **CS refactor M2 groundwork: the device-agent protocol now runs over an ssh stdio bridge + persistent chat-class sessions** (design-remote-cs.md M2; still internal — not wired into the live remote path yet, zero user-facing change). The daemon gained a `--stdio` bridge mode (`ssh host -- node agentd.js --stdio` reaches the STANDING remote daemon, spawning it setsid-detached if needed, then pipes stdin/stdout ↔ its unix socket — an ssh drop kills only the bridge, the daemon + sessions survive: the keeper's persistence, now in the daemon architecture). DeviceManager gained a transport abstraction (local unix socket vs `ssh` stdio) and `openPipeSession()` — persistent, daemon-owned chat-class sessions with the full keeper semantics INSIDE the daemon: child spawned setsid-detached with stdout→buffer file + stdin←O_RDWR fifo, byte-offset reattach, `_remote_exit` sentinel, and drain-only-never-respawn on an exited session (the B-0343 law). Verified e2e (scripts/test-agentd-remote.mjs): bridge reaches/spawns the daemon → handshake+auth over stdio → pipe session SURVIVES the bridge dying → offset reattach replays nothing → exit sentinel → reopen-after-exit is drain-only. This is what M2's later half (retiring the remote keeper, landing codex remote chat B-0588 in the daemon) will build on.

## 2.141.3 — 2026-07-14
- **Tailscale plugin card no longer falsely shows "managed by the system"** (real report, kernel mode): in kernel mode tailscaled runs under a `sudo` wrapper AND forks a child, so `pgrep -x tailscaled` returns pids that differ from the pidfile — the system-daemon check compared pids and mis-flagged our OWN child process as a foreign system tailscaled, graying out the whole card (Install/Start/mode controls hidden) even though our tailscale was running fine. Now our processes are recognized by their cmdline referencing our own `--socket`/statedir; only a genuinely foreign tailscaled (default socket, e.g. a dev machine's system daemon) is reported as system.

## 2.141.2 — 2026-07-14
- **Tailscale plugin: networking-mode selector + custom `tailscale up` flags.** A **Networking** dropdown (Auto / Kernel / Userspace) lets you override the auto-detection — pick Userspace to keep tailscale as a localhost SOCKS5/HTTP proxy that never touches the pod's routing table (kernel mode installs a `tailscale0` tun + routes for tailnet ranges in the pod's own netns — pod-scoped, only tailnet-destined traffic, not all egress). Switching mode while running restarts tailscaled into it (login persists in the statedir). A **`tailscale up` flags** field passes extra flags (`--advertise-routes`, `--exit-node`, `--hostname`, `--ssh`, …) applied on the next login; flags we manage (`--socket`/`--tun`/`--accept-routes`/proxy) are filtered out so they can't be overridden.
- **Helm: `tun.enabled` now defaults to a hostPath mount** (`tun.mode: hostpath`) — mounts the host's `/dev/net/tun` + adds NET_ADMIN directly on the pod, no cluster device-plugin needed (single-pod, sticky across helm upgrades). `tun.mode: device-plugin` keeps the resource-request path for clusters that prefer it.

## 2.141.1 — 2026-07-14
- **Tailscale plugin login link no longer vanishes** (real report): clicking "Log in…" filled the auth-URL box, but the button wrapper's post-action re-render immediately rebuilt the dialog and wiped it (flashed once, gone). The login button now skips the auto-re-render (the poll timer re-renders on its own when the tailnet connects); a "Waiting for the sign-in page…" state covers the slow-auth-URL case.
- **Virtual desktops: windows no longer vanish on rapid switching** (real report): a desktop switch requested while another was in flight was silently DROPPED, leaving the user's actual position out of sync with the saved active id, so a later capture could persist the wrong desktop's window set over another's. Fixes: (1) latest-wins switch queue — a mid-flight switch is remembered and run when the current one finishes, so fast clicks all land; (2) merge-preserve capture — when saving a desktop's state, windows that were in its prior saved state (openSpec-backed, still lazy-replaying: chat re-attach, disk restore) but not yet in the DOM are carried forward, so a fast switch-away never persists a desktop MINUS its slow windows.

## 2.141.0 — 2026-07-14
- **CS refactor M1 (opt-in, default OFF): local sessions can run through the device agent.** Setting `agentd.sessions` (Session category, default off, restart to apply) routes LOCAL terminal sessions through the standing vibespace-agentd daemon over the device mux protocol instead of the server process: the daemon owns the pty (a `dtach -a` attach runs INSIDE agentd and relays bytes over a credit-flow-controlled byte channel), so sessions are unaffected by a server restart and survive a dropped connection (verified: a dtach session created through the daemon survives the connection dropping and reattaches — invariant #1). The daemon gained the session primitive (open-session/resize/kill; node-pty loaded lazily so the M0 bundle stays zero-dep, resolved via VIBESPACE_NODE_MODULES on localhost); DeviceManager gained openSession() returning a node-pty-shaped handle; server.js's attachToDtach branches to it ONLY when the flag is on, with a local-pty fallback on any daemon failure. **Default off = the daemon is never instantiated and attachToDtach is byte-identical to before — zero impact unless you opt in.** Tests: scripts/test-agentd-session.mjs (pty relay both ways, resize, exit, dtach-survives-drop). Remaining CS milestones M2-M5 (ssh transport, discovery/fs/transcript/usage relocation, dial-out, mounts) build on this.

## 2.140.0 — 2026-07-14
- **Plugin system + Tailscale** (B-2d44): a generic mechanism for host-level capabilities — install step, PERSISTENT state under `~/.vibespace/plugins/<id>/` (the per-user PVC in fleet deployments: a container rebuild keeps the identity), boot-time replay of enabled plugins, guided setup, live status. ⚙ → Plugins…. First plugin: **Tailscale** — dual mode: kernel (when `/dev/net/tun` + NET_ADMIN are available; full tunnel, SMB/NFS to tailnet hosts) or userspace (`--tun=userspace-networking` + SOCKS5 on localhost:1055 — no root, works in any container); a SYSTEM tailscaled is detected and reported, never managed (own `--socket`/`--statedir` coexist). Login mirrors the guided Drive-OAuth flow: `tailscale up`'s auth URL is captured and surfaced with copy + status polling; the node key lives in the statedir so a pod rebuild reconnects WITHOUT re-login. Helm gained an optional tun device (`tun.enabled` → NET_ADMIN + a device-plugin resource, default squat.ai/tun); without it plugins fall back to userspace automatically. Verified end-to-end inside a real fleet pod (install → userspace start → NeedsLogin → auth URL captured → stop).

## 2.139.0 — 2026-07-14
- **Codex remote chat** (B-0588): codex chat sessions now run on remote hosts through the same keeper persistence layer as claude — the keeper is a content-agnostic byte pipe, so the app-server's bidirectional JSON-RPC (including approval requests) rides it and byte-offset replay redelivers missed traffic exactly once across ssh drops. codex-chat-wrapper gained the full remote feature set: `__VS_OFFSET__` substitution per (re)spawn, Buffer-based line splitting (byte-exact offsets, no multibyte splits), transport-death reconnect with backoff, outbound JSON-RPC queueing while the pipe is down (the old `send()` silently DROPPED approvals), `_remote_exit` sentinel finalization, `_remote_state` chips — and the HANDSHAKE runs once per wrapper lifetime (re-initializing on reconnect would fork the remote thread; e2e-asserted). The remote spawn no longer force-appends claude's stream-json flags into codex argv (what killed it opaquely pre-2.129.1). Known limits: remote-host codex thread discovery + transcript fetch for externally-created threads are not included (CS refactor M2/M3 scope); sessions created through VibeSpace work end-to-end.
- Deployment note: from this release the agent ships fixes to git only — running instances update on their own schedule via ⚙ → Update (never auto-rolled while sessions are active).

## 2.138.0 — 2026-07-14
- **Remote-session resilience trio** (B-0343 + B-4058 + B-0845, the pod-rebuild/daemon-death class):
  - **keeper 2.0** (B-0343): claude now runs SETSID-DETACHED under the remote keeper with stdout/stderr as DIRECT file fds and stdin from an O_RDWR FIFO — a daemon SIGKILL no longer harms claude at all (the old pipe relay lost buffered bytes and EOF'd claude's stdin, killing it moments later). A reattach finding a dead daemon + live claude starts a TAKEOVER daemon over the same fifo/buffer (verified live on a real host: SIGKILL → survival → adopted input/output → clean sentinel); dead daemon + dead claude + no sentinel now appends a synthetic `crashed` exit sentinel — the session ends honestly and Resume recovers the conversation, instead of the old silent fresh restart that minted a BLANK claude under the old history (real incident). All pid checks are /proc-cmdline-verified (pid reuse made liveness lie and `stop` could hit an innocent process); keeper meta records the full argv + sniffed claude session id.
  - **Pod-rebuild recovery** (B-4058): remote discovery now reports keeper-managed claudes (their run-dir metas ride the discovery scan) — after a pod rebuild these sessions show as RESUMABLE and Resume ADOPTS the surviving remote process via keeper-attach (full-replay, nothing killed, mid-turn work continues). A plain resume of a non-keeper external session first SIGTERMs any orphan claude holding the same session id and stops stale keeper remnants on the host (cmdline-verified) — no more double-JSONL writers and "resume did nothing".
  - **Bare-session warning** (B-0845): a remote chat session created before the keeper existed (2.124.0) shows an amber "no disconnect protection" chip in the status bar with rebuild guidance — upgrades can't retrofit protection into a live pipe, but they can now say so.

## 2.137.1 — 2026-07-14
- **Generic OAuth cloud drives get the friendly treatment** (B-2bbf): Dropbox, Box, pCloud, Yandex Disk, Jottacloud and HiDrive are now a first-class "Other cloud" connection type — provider picker, guided "Connect" sign-in (the same no-terminal flow as Google Drive/OneDrive, remote paste-back included), folder field, optional custom OAuth client — instead of raw rclone key=value params. Existing rclone-typed records of these providers migrate to the friendly type automatically (fresh migration wave — the old `_cloudUnified` guard predates this and would have skipped them); rclone.conf imports normalize on add; re-auth "Fix" appears on token-expiry errors; config export/import carries the provider.

## 2.137.0 — 2026-07-14
- **Terminal web fonts are now SELF-HOSTED** (public/fonts/, all SIL-OFL licensed): fonts.googleapis.com is unreachable for users behind national firewalls, so the Google-hosted CSS never arrived and the first terminal rendered with the canvas fallback FOREVER — no amount of client-side font polling could heal it (recurring onboarding reports; the 2.105.x/2.111.12 fixes only covered slow-but-reachable routes). The five families (Fira Code, JetBrains Mono, Source Code Pro, IBM Plex Mono, Inconsolata; latin+latin-ext, 400/500) now ship with the product (~512KB) and load same-origin — the existing registration-polling + loadingdone machinery stays as the residual-race healer.
- **Gmail sync cap removed**: "Messages to sync" 0 now means the truly whole mailbox (the old hard 200,000 ceiling is gone — real mailboxes exceed it; the seed is streaming + checkpointed so size only costs time), and an explicit N is honored exactly.

## 2.136.6 — 2026-07-14
- **Backlog viewer visual pass** (follow-up report — 2.136.5 left the status icon orphaned on its own line): the status circle now leads the top row; the attribution line is QUIET (plain dim text, no pill chips — pills made every row shout); the common self-claim (parker == claimant, since parking auto-claims) collapses into a small `⚑ ×` after the parked-by instead of repeating the same session as two chips; row actions (✎ ✓ ⊘ ×) sit flush right and fade in on hover (always visible on touch).

## 2.136.5 — 2026-07-14
- **Backlog rows re-laid-out** (real report — text crammed with actions/attribution): in the Task Group detail window the ✓/⊘ actions now sit in a right-aligned cluster separated from the item text; in the Backlog log viewer each item is now TWO rows — the item text + actions on top, the parked-by / claimed-by / resolved-by attribution chips wrapping on a second line below — instead of one flex row where long session names squeezed the text into a one-character-per-line column.

## 2.136.4 — 2026-07-14
- **Gmail sync shows the real total again** ("N / total" with a determinate bar), restored after the streaming-seed rewrite dropped it. The total now comes cheaply from `users.getProfile` (whole-mailbox `messagesTotal`) or the label's `messagesTotal` (label filter) — captured once at seed start and persisted, so it survives restarts and the progress bar stays determinate through the whole seed (only a free-text query, which has no cheap total, stays indeterminate). This also fixes the card looking "stuck at Checking for new mail" — with a total it renders proper progress instead.

## 2.136.3 — 2026-07-14
- Gmail storage card now shows **"Downloading · N so far…"** during the seed/large download instead of the misleading "Checking for new mail…" (real report — it was clearly downloading but the card didn't show the count). The count updates live; "Checking for new mail…" is now reserved for the quick incremental check with nothing to download.

## 2.136.2 — 2026-07-14
- **Gmail seed resume is now robust against new mail arriving between restarts** (user insight): the mid-seed checkpoint switched from a `messages.list` pageToken to a **date cursor** — Gmail's pageToken is only stable within one run (new mail arriving between runs can shift or expire it, silently skipping OLD mail the incremental pass never back-fills). A restart now resumes from the oldest already-downloaded message's date (`before:<sec>`) and pulls strictly-older mail; new mail (newer date) is left to the seed-start historyId incremental; the same-second boundary re-lists a few already-seen ids that dedup skips. pageToken remains a within-run optimization only.
- **Gmail "checking for new mail" progress bar no longer stutters** (real report — it jittered in the first third): indeterminate progress broadcast every download, rebuilding the card and restarting the bar's one-way slide animation every ~400ms so it never got past a third. Indeterminate broadcasts are now throttled to 2.5s and the bar is a symmetric pulse (a mid-animation rebuild is invisible).

## 2.136.1 — 2026-07-14
- **Gmail sync now resumes a mid-seed restart from a checkpoint** (real report: every server restart re-scanned the whole mailbox). The first full sync used to persist its cursor only AFTER downloading everything, so a restart during a large seed (especially "sync everything") re-listed the entire mailbox from scratch. The seed is now streamed page-by-page: each page is downloaded and its `messages.list` pageToken persisted, so a restart continues from the last page instead of re-listing. The incremental-anchor historyId is captured at seed START (persisted) so mail arriving during a long seed is still caught. (Incremental syncs already resumed from historyId — this fixes the seed phase.)

## 2.136.0 — 2026-07-14
- **Native OneDrive** (new mount type, alongside native Google Drive): connect a Microsoft OneDrive with guided sign-in (no terminal — same loopback flow as Drive, remote paste-back supported), pick Personal / Work-School / SharePoint account type, an optional folder and Drive ID (for a specific or shared drive), optional own Azure OAuth app. rclone.conf import maps a `onedrive` remote to the native type; existing rclone-onedrive records migrate on load (lossless, guarded). First-class fields, edit dialog, submounts (per-folder), and guided re-authorize — no more raw rclone params for OneDrive.
- Groundwork for the generic OAuth-cloud friendly layer: `rclone authorize` is generalized to any backend (drive/onedrive/dropbox/box/pcloud/…), so the guided sign-in button is reusable. (Full friendly-field editing for the other backends is a follow-on.)

## 2.135.4 — 2026-07-14
- **One Google Drive, no more "rclone version vs native version"** (user request): every `rclone`-backend-`drive` mount (rclone.conf import / custom-added) is now MIGRATED to the native `drive` type on load — its client/token/scope/folder carried over from the raw params into the first-class fields, any non-drive tuning params preserved as extra options. rclone.conf import and custom-add both normalize a `drive` backend to the native type up front. The rclone-drive-specific edit/submount UI branches are retired — there is a single Drive concept and code path. Migration is idempotent and lossless (guarded by a one-time marker).

## 2.135.3 — 2026-07-14
- **rclone-backed Google Drive mounts are now first-class Drives** (real report: an imported/custom `drive` rclone remote had an incomplete edit dialog — no OAuth client picker, and its submounts had no cloud-side source): a mount whose rclone backend is `drive` now gets the SAME controls as a native Drive record — OAuth client preset picker, cloud-side scope (My Drive / Shared with me / Shared drive), the **List shared drives** picker, and single-folder `root_folder_id` — in both the edit dialog and the "New submount" dialog. Existing records migrate transparently (the scope is inferred from the stored rclone params, then edited via the friendly fields which take over). Preset selection resolves to the instance's env clients, so the secret never lands in the record.

## 2.135.2 — 2026-07-14
- Fixed the Gmail edit dialog showing a blank (placeholder 200) after you saved "Messages to sync = 0": zero is a valid value (= everything) but was treated as empty, so it round-tripped to blank on reopen. It now prefills 0 correctly.

## 2.135.1 — 2026-07-14
- **Edit dialogs now actually show the stored Drive/Gmail settings** (real report: "why does my OAuth client say custom?" — the config endpoint the edit dialog reads never included the drive scope fields or ANY gmail fields, so every select fell back to its default no matter what was stored; an earlier fix had landed in the config-BUNDLE exporter instead). Cloud-side scope, shared-drive id, OAuth preset, sync count, labels, grouping — all prefill correctly now, for submounts too.
- **Changing a Gmail mount's sync scope (labels filter / query / message count) now forces a reseed**: the persisted history cursor kept the sync incremental, so newly-in-scope OLD mail (e.g. clearing the INBOX filter to pull archived mail) never arrived. The reseed is cheap — the directory is the dedup index, existing files are skipped.

## 2.135.0 — 2026-07-14
- **Gmail can now sync the WHOLE mailbox** (user report "why only 981?" — the default INBOX label filter was the cap; archived mail carries no INBOX label and spam/trash are API-excluded by default): the labels filter now defaults to EMPTY = everything (archived + spam/trash included), and **Messages to sync = 0 means everything** (hard cap 200k, quota-paced with the live card progress).
- **Label-folder layouts**: new "By label, then month/day" grouping files each mail under `Inbox/ Archive/ Sent/ Spam/ Trash/ Drafts/` (Gmail's own precedence — "archived" = not in the inbox) with date folders inside. Default for new Gmail mounts.
- **Labels picker**: "List labels" in the add AND edit dialogs pulls the account's real labels (system + user) — click to build the comma filter, no more guessing label ids.
- **Edit dialogs de-text-boxed across storage types**: OAuth client preset and Gmail folder-grouping are real dropdowns, big JSON tokens moved to textareas, WebDAV vendor became an editable select (it wasn't even patchable server-side before).

## 2.134.4 — 2026-07-14
- **Submounts are now the first-class way to attach Shared Drives / shared-with-me** (user insight — that's where zero-reauth lives: ONE authorized Google credential, N children each pointing at a different cloud-side scope): the "New submount" dialog under a Drive connection gets the **List shared drives** picker (over the parent's stored credentials, no token pasting), scope-conditional fields (the Shared-drive row only shows for that scope), and the single-shared-folder **Folder ID** field.

## 2.134.3 — 2026-07-14
- **Shared-drive picker items now actually apply on click** (real report: "clicking a listed drive does nothing") — the menu items used the wrong callback key for showContextMenu (`onClick` instead of `action`), so selecting a drive threw silently.
- **Editing an EXISTING Google Drive mount can now really change the cloud-side scope** (real report): the edit dialog's scope field was a raw text input demanding magic strings — it's a proper My Drive / Shared with me / Shared drive dropdown now, and the edit dialog gained the same **List shared drives** picker as the add dialog (works for submounts too, resolving credentials through the parent). Saving still auto-reconnects the mount with the new settings.

## 2.134.2 — 2026-07-14
- **Fixed "undefined" painted over every .eml filename** in the file explorer (real report): the .eml registration referenced a FILE_ICONS key that doesn't exist, so the literal string "undefined" rendered into the icon slot. Emails now get a proper envelope icon.
- **Gmail sync progress count no longer truncates** ("53/979…" — the label now never ellipsizes; the bar shrinks instead).
- **Date grouping option for Gmail mounts** (user request — a flat directory with 10^5+ emails hurts every file tool): synced mail lands in `YYYY-MM/` (default for new mounts) or `YYYY-MM-DD/` subfolders, or flat. Dedup spans subfolders and pre-grouping flat files, so switching it on mid-life re-downloads nothing; existing mounts keep their current flat layout unless edited.

## 2.134.1 — 2026-07-14
- Gmail storage cards now say what they ARE (a sync, not a live mount) and show it live: a **progress bar on the card** while a pass downloads ("Syncing 37/200…", server broadcasts throttled updates as it moves), an indeterminate shimmer while checking for new mail, and "Synced — N emails · time · account" when idle; stopping the sync says the synced emails stay. The add dialog states the sync semantics up front.

## 2.134.0 — 2026-07-14
- **Gmail as a folder** (new mount type): connect a Gmail account (guided sign-in, no terminal; uses the instance's preset OAuth clients or a custom one — gmail.readonly scope) and the newest N messages (+ everything new, incrementally) sync into the mount folder as `.eml` files — open them in the new built-in **email viewer** (subject/from/date card, text↔HTML toggle with the HTML part fully sandboxed, attachment downloads). Read-only archive by design: unmounting stops the sync but keeps the files; deletions in Gmail never delete files. Filters: label list and a full Gmail search query. Engine deliberately NOT a filesystem mount — sync-to-folder is the proven design (GYB); the directory itself is the dedup index (message id in the filename), so state can never drift.
- **Dynamic-desktop fixes** (two user-reproduced bugs): ① activating a stage hero no longer paints a phantom window at the SLOT position on its home desktop's preview (previews now draw staged windows at their home geometry); ② a session card's **GoTo** while the stage is active now materializes the window as the hero instead of switching desktops out from under the stage (which left the preview stuck on the stage while the actual desktop changed).

## 2.133.0 — 2026-07-14
- **Preset Google OAuth clients** (e.g. one Internal client per organization + one published-external for everyone else): `VIBESPACE_GDRIVE_CLIENTS` env (JSON `[{key,label,clientId,clientSecret},…]`, helm `gdrive.clients`) injects instance-preset clients; the Drive add-dialog gets an **OAuth client picker** (presets / rclone built-in / custom id+secret), a mount stores only the preset KEY — secrets never persist app-side and rotating the env rotates every mount. Authorize flow, shared-drive lister, and re-auth all resolve presets. Legacy single `VIBESPACE_GDRIVE_CLIENT_ID/SECRET` still works as the `default` preset.

## 2.132.0 — 2026-07-14
- **Manager-agent Task Group administration** (issue #21, userW's majordomo flow): a session the user designates as **Group manager** (new toggle in Session Properties) can create and configure Task Groups from its CLI — `vibespace-task group-list / group-create / group-update / group-bind / group-unbind`. Double-gated and off by default (new setting **"Allow agents to manage Task Groups"** must ALSO be on); contextDir/auto-include paths are restricted to allowlisted roots (setting, default = home); every operation lands in the group's activity log attributed to the acting session, so the board shows exactly what the majordomo did. Organize-only by design: no delete, no spawning, no agent-loop control — the same config operations the user performs in the UI. Route `/api/agent/group-admin`; smoke test scripts/test-group-admin.mjs.

## 2.131.0 — 2026-07-14
- **Google Drive mounts can now target "Shared with me" and Shared Drives** (user request): every Drive mount (and every SUBMOUNT — each runs its own rclone daemon, so children under one credential can each pick a different scope) gets a **Cloud-side scope** selector (My Drive / Shared with me / Shared drive), a Shared-Drive picker (**List shared drives** button → `rclone backend drives` server-side), and an advanced **Folder ID** field — the confirmed pattern for mounting ONE folder someone shared with you (`root_folder_id`; it deliberately wins over the shared-with-me flag, which rclone guidance says must not be combined with it).
- **Instance-default Google OAuth client** (`VIBESPACE_GDRIVE_CLIENT_ID`/`_SECRET`, helm `gdrive.clientId/clientSecret`): admin-injected via env, used by Drive authorize + mounts whenever the user doesn't supply their own client, never persisted in instance data. Timely: Google is retiring rclone's shared client during 2026, so a default client stops every user needing their own GCP project.

## 2.130.0 — 2026-07-13
- **`vibespace-task backlog-edit <id|#|text> [--text …] [--detail …]`** (agent CLI + `/api/agent/task-backlog` `edit` verb): edit a parked backlog item IN PLACE — the stable `B-xxxx` id stays, so references elsewhere (docs, memory, other agents' notes) survive and the change surfaces to claimants as a "reworded" diff, not a drop+new-id churn. `--detail ""` (or `-`) clears the detail. Fills a real gap: agents previously could only drop+re-add to change an item, minting a fresh id and orphaning every reference (the B-55e2→B-5052 churn that motivated this).
- **Onboarding/Manage-Agents guided login terminal no longer clipped on the right** (real report — the "Log in to Claude Code" modal cut off the auth URL and status text): the width was a `min-width` on the dialog BODY, but `.dialog` is a fixed `width:440px; overflow:hidden`, so the wider body (and the terminal box inside it) overflowed and got clipped at the dialog edge. Width now sits on the dialog itself (`min(760px, 94vw)`, the same pattern the accounts dialog uses); the status line wraps instead of overflowing.

## 2.129.1 — 2026-07-13
- Creating a **Codex CHAT session on a remote host now fails fast with an honest error** instead of silently spawning a broken session (the remote-chat branch force-appends claude stream-json flags — into codex argv they just killed the spawn opaquely). Terminal mode on the host and local codex chat are unaffected; full remote codex chat support stays parked (backlog B-0588 — needs the keeper/offset machinery in the codex wrapper + remote thread discovery).

## 2.129.0 — 2026-07-13
- **Manage Agents shows the VibeSpace footprint on a remote host** (transparency follow-up to the 2.126.0 argv incident, backlog B-34bb): selecting a machine now renders a "VibeSpace integration on <host>" row — per-tool state under `~/.vibespace/bin` compared against the LOCAL copies by content hash (current / outdated / absent; per-tool detail in the tooltip), hook registration in the HOST's own Claude/Codex configs, node availability, and keeper session files — with explicit **Install/Reinstall** (same tar-over-stdin channel the per-spawn distribution uses; registers the hook) and a danger-confirmed **Remove** (unregisters ONLY our hook entry from the host's CLI configs via the register script's new `--uninstall` mode, then deletes exactly our tool files; per-session token files are left alone). The row says plainly that creating a remote session re-installs everything automatically (per-spawn distribution is the zero-drift design). Probe is one read-only ssh round trip (`GET /api/hosts/:id/agent-tools`); verified live: outdated detection → install → uninstall (both harnesses' hooks cleanly unregistered, foreign hooks untouched) → reinstall.

## 2.128.0 — 2026-07-13
- Usage window: remote hosts moved OUT of the Account chips into their own **Device** filter row (user directive — hosts are devices, not accounts): All / This machine / each remote host, gating the ENTIRE view (totals, panels, breakdowns) top-level via a new `host` param on /api/usage-stats. Selecting a remote device hides the local Account row (its usage is the host's own login); host buckets no longer appear as account chips. Host rows in the ledger's host dimension now carry the device's display name.

## 2.127.0 — 2026-07-13
- **Usage now covers remote hosts** (v1, claude transcripts): opening the Usage window kicks an incremental ledger HARVEST over ssh — a scanner ships to each host (stdin, never argv), walks its `~/.claude/projects` with remote-side byte cursors, and returns per-request NDJSON events that merge into the local ledger as a per-host bucket (`atype:'host'`, billing category `remote-host`, labeled with the host's name). The window's existing Account chips then switch to the host like any other account; server-throttled 15min/host, first pass scans everything, later passes only新增. Host events keep their baked attribution (the local attribution log knows nothing about remote sids and used to re-bucket them to global — guarded). Interrupted transfers lose nothing: the remote cursor only advances after a fully flushed send, and rid-dedup absorbs re-emissions.
- **The quota popup gets a "Remote hosts" section**: each configured host's OWN login quota (5h/7d bars + reset times), fetched ONLY by the per-host ⟳ — a single human-gated request using the host's own login token read over ssh (READ-ONLY, never refreshed — §ban-safety; hosts with no/expired token get an honest "log in / run claude there first"). Snapshots persist in `data/usage-cache/host-<id>.json`.

## 2.126.0 — 2026-07-13
- **SECURITY / hygiene: remote spawns no longer put secrets or blobs in the command line.** The remote-session prelude used to inline ~300KB of base64 tool blobs AND the per-session `vsst_` token into the ssh inner command — argv is world-readable via /proc/cmdline on the remote host, so any local user could `ps` the token and impersonate the agent through the reverse tunnel (and the wall of base64 looked outright alarming — real user report). Now the tools + token ship over ssh STDIN as one tar stream into `~/.vibespace/bin` (token = 0600 dotfile, removed at kill), and the inner command references the token via a `VAR="$(cat …)"` shell prefix assignment — the same never-in-argv rule the account-key path has always followed. The visible remote process line is now a short PATH/hook-register prelude.
- i18n dictionaries rebuilt deduplicated (duplicate keys accumulated by earlier bulk merges caused esbuild warnings in every self-update log; last-occurrence values kept — identical runtime behavior).

## 2.125.1 — 2026-07-13
- Fixed (for real this time) searching a remote session by id showing "No sessions": the sidebar's zero-local-matches empty-state RETURNED before the workbench ever rendered — the 2.124.0 remote-search fixes lived downstream of that return and were unreachable whenever the query matched nothing local (exactly the session-id case). With a search active the workbench now always renders (selected-host zone without the 7-day cutoff + cross-host Remote matches). Applies to desktop and the mobile sidebar alike (both share the workbench).

## 2.125.0 — 2026-07-13
- **SSH connection reuse (ControlMaster)** for every short-lived per-op ssh (remote discovery, remote file browsing, transcript fetch, rsync): the first op pays the handshake, the next ~10 minutes ride a persisted shared master — per-op latency drops from ~1s to tens of ms and auth storms disappear. Deliberately NOT applied to session pipes (a session becoming the master would couple unrelated sessions to its lifetime). Masters live under a short per-uid tmp dir (`/tmp/vs-cm-<uid>/`) — the deep data-dir path overflowed the ~104-char unix-socket limit on the first attempt.
- **Reconnect state is visible**: while a remote chat session's ssh pipe is down, the chat status bar shows a pulsing amber "⟳ host reconnecting (n)…" chip (tooltip explains the session keeps running on the host); it clears the moment bytes flow again. Rides a `_remote_state` line from the wrapper → `remote-state` WS broadcast + the attach payload (survives refresh).
- codex remote chat (through the same keeper) parked in the backlog — the path was never wired for codex; 2.124.0 covers claude.
## 2.124.0 — 2026-07-13
- **Remote session stability overhaul** (user directive — the "remote chat goes blank on an ssh blip" class; a full C/S rearchitecture is parked in the backlog, this is the resilient transitional layer):
  - **Remote CHAT sessions now persist on the host, independent of ssh** (`data/bin/vibespace-remote-keeper`, distributed to `~/.vibespace/bin` like the other tools): claude runs DETACHED (setsid) under a keeper daemon — stdout appends to a buffer file, stdin arrives via a unix socket. An ssh drop kills only the pipe; the local chat-wrapper reconnects with backoff (1s→30s), substituting the byte offset it has consumed, and the keeper replays exactly the missed bytes. Input typed while disconnected is queued and flushed after reconnect. The session ends only when claude itself exits on the host (a `_remote_exit` sentinel travels through the buffer; the keeper never restarts an exited session). Verified live against a real host: ssh SIGKILL'd mid-session → remote process survived → offset reattach with zero replay → clean exit sentinel.
  - **SSH keepalive everywhere** (`ServerAliveInterval=15`, `CountMax=4`, `TCPKeepAlive`): half-open pipes from silent network drops now die within ~60s so the reconnect layers can act — previously they lingered for the whole TCP timeout looking "alive".
  - **Remote TERMINAL sessions auto-reconnect too**: pty-wrapper respawns a non-zero-exit ssh with backoff (the remote `dtach -A` reattaches the surviving CLI); a yellow "[vibespace] connection lost — reconnecting…" line shows in the terminal. Clean exit 0 still ends the session.
  - **Kill really kills**: terminating a remote chat session now also stops the keeper + claude on the host (best-effort ssh stop).
  - **Discovery state sync**: remote session discovery results persist to disk (`data/remote-sessions-cache.json`) — after a reload or while a host is unreachable the sidebar shows the last-known list (marked stale) instead of an empty zone; the per-host cache is invalidated right after a remote create/kill so the list updates on the next poll instead of after the TTL.
  - **Parity fix (sidebar search)**: searching now covers EVERYTHING on the selected host — the Recent zone's 7-day cutoff hid older remote sessions from an id search, and the cross-host "Remote matches" section deliberately skips the selected host, so those sessions were findable nowhere. (History zone suppresses the would-be duplicates while searching.)
## 2.123.1 — 2026-07-13
- Claiming a backlog item now WARNS about co-claimants (user question surfaced the gap): the claim ack echoes the item and lists the OTHER sessions already holding it — the CLI prints "note: ALSO claimed by … — coordinate to avoid duplicate work"; re-claiming your own item says so instead of silently succeeding. (Multiple simultaneous claims are by design — that's the two-sessions-take-one-item flow; the resolution notification reaches every claimant.)
## 2.123.0 — 2026-07-13
- Backlog **claim model** (user directive, same day as 2.122.0): every item now has a **stable short id** (`B-xxxx`) and a `claimedBy` list of sessions. Parking an item auto-claims it. **Change notifications are TARGETED**: a backlog event (parked/resolved/dropped/claimed/unclaimed/reworded/removed) is injected only into sessions that **created or claimed** that item — e.g. two sessions claim one item, one resolves it, the other is notified; everyone else keeps just the one-line count pointer. The injected reminder block is now "items CLAIMED by this session" (was "parked by"). The id is designed to travel: **click it in the viewer to copy**, paste it to ANY agent of the group ("看一下 backlog B-ab12") — that agent runs `vibespace-task backlog B-ab12` to see the full item (creator, claimants, detail — works for resolved items too) and `backlog-claim B-ab12` to take it. New CLI: `backlog <id|#|text>` (show one), `backlog-claim`, `backlog-unclaim`; all refs accept id / open-list number / unique text. Viewer upgrades: id chip (copy on click), claimants shown per item with per-claim remove ×, "unclaimed" marker, parked/resolved attribution retained; task-detail rows get the id chip + claim tooltip. Diff matching switched from occurrence-indexed text to the stable ids (text edits now read as "reworded" instead of REMOVED+NEW). Ids round-trip through repo-file export/import (`- [ ] [B-xxxx] text`) and config bundles; existing items get ids + creator-auto-claims backfilled once at boot.
## 2.122.0 — 2026-07-13
- Task Group **Backlog** (user decision, replacing yesterday's removed checklist with a DIFFERENT concept): the group's parking lot for **non-immediate** items — decisions the user deferred ("以后再说/等我决定"), work they said comes later. Explicitly NOT agent work steps (those stay on each session's own todo/Steps). Items carry status open/done/dropped + who parked/resolved them. Agents get `vibespace-task backlog` (list) / `backlog-add "item" [--detail]` / `backlog-done <n|text>` / `backlog-drop`, and are taught to park items when the user defers something and to never start parked items unasked. **Injection is summary-only (user directive): the hook never dumps the backlog** — a session sees a short reminder block for the open items IT parked (so it re-surfaces them to the user), plus a single "N open parked items — `vibespace-task backlog`" pointer line otherwise; backlog CHANGES ride the normal diff updates as one-line events (PARKED/RESOLVED/DROPPED, occurrence-indexed like the retired checklist diff). Full backlog lives in TASK.md, `show`, and the UI: a Backlog section in task-detail (open items + ✓ done / ⊘ drop / park input) and a Backlog tab in the log viewer (status filter, attribution chips, inline edit, reopen). Repo-file export/import round-trips it (`- [ ]`/`- [x]`/`- [-]`). One-time migration: the 2.121.0-dormant checklist's UNCHECKED items seed the backlog as open items (checked history stays dormant).
## 2.121.0 — 2026-07-13
- REMOVED: the Task Group checklist/backlog (user decision — a group-level backlog never made sense: agents don't care about other agents' backlogs; work items live at the SESSION level, i.e. the agent's own native todo list already surfaced as each card's Steps). Cut across every surface: the task-detail Checklist section, the log viewer's Checklist tab (now a pure Activity-log viewer), the `vibespace-task plan-check/plan-uncheck/plan-add` subcommands (now print a redirect; the server answers old CLI copies — e.g. on remote hosts — with 410 + guidance), the injected context's Checklist section + `plan-check` teaching line, the diff-update's Checklist deltas, TASK.md, and repo-file export. Legacy `## Checklist`/`## Plan` sections in existing exported files are still recognized as section stops on import (content dropped). Stored `plan` arrays are kept DORMANT in data/task-groups.json — nothing is destroyed, the data is just never rendered or written again; config-bundle import passes it through.
## 2.120.0 — 2026-07-13
- Injected activity log: per-entry char cap so one very long progress note can't starve the rest (user directive). Three layers now: at most 12 newest entries, each note truncated to 200 chars (overflow flagged † and recoverable via `show --full`), then the byte budget, then the route's final 9600-byte inline hard-cap. Result: you see MORE history lines rather than a couple of long ones eating the whole budget. Applied to both the full-context and the diff-update activity rendering. (The per-entry truncation uses a clean char slice — an earlier word-boundary regex gutted CJK notes, which have no spaces.)
## 2.119.0 — 2026-07-13
- Agent context injection now stays INLINE: the prompt-context route hard-caps the final `additionalContext` at 9600 bytes. Binary-search established that Claude Code wraps a hook's additionalContext into a `<persisted-output>` 2KB-preview + on-disk file at EXACTLY 10240 bytes (10 KiB) — below that it's fully in the model's context, at/above it the agent must Read a file (the 2.68.0 "never learned the tools" failure mode). The cap tail-truncates the oldest activity-log lines at a UTF-8-safe newline boundary and appends a `vibespace-task show --full` pointer, so the tools-first head is always inline and nothing critical is lost. (Corrects the old "~2KB truncation" belief — there was never a 2KB cap.)
## 2.118.0 — 2026-07-13
- Blank-window telemetry: the chat view now emits diagnostic events for the un-debuggable "session window blank" class — `chat-view-blank-with-content` (server reports the session has messages but nothing rendered), `chat-view-blank-persistent` (a deferred 2.5s check finds the DOM still empty despite claimed content), and `chat-attach-failed` (attach errored → read-only). Each carries NON-CONTENT debug context only (backend, local-vs-remote + host, read-only/streaming/ws-off flags, window bounds, session id — never message text), so a user's "it went blank" report arrives with enough to reproduce. Surfaces in the admin Investigate/breakdown by event name.
## 2.117.0 — 2026-07-13
- Session naming: sessions whose first turn is an injected `<vibespace-task-context>`/`<system-reminder>` (or a slash-command echo) no longer fall back to the directory name — both local and remote discovery now SKIP synthetic first-turn records and take the first REAL user message. Remote discovery previously grep'd only ONE user record (`-m1`) and gave up on a `<`-tag; it now scans the first several and picks the first real one (matches local naming). (VibeSpace names from the first user message; it does not read claude's own session summary/title, which older CLIs don't write anyway.)
- Sidebar search now covers ALL remote hosts: with an active filter query the Folders workbench loads every configured host on demand and shows a "Remote matches" section across hosts (not just the one selected in the Recent/History switcher). Deduped against live sessions.
- Ctrl+K palette now matches on session id (backendSessionId/claudeSessionId/sessionId), not just name/cwd/host.

## 2.116.0 — 2026-07-13
- Remote session sidebar: fixed a duplicate card after resuming a remote session — the same session showed BOTH live (in Running, as a webui-managed session) AND stopped (in Recent, from the independent remote ssh-discovery path, which reports remote CHAT sessions as stopped since they have no remote dtach lock). The Recent/History remote zones now dedup discovered sessions against the live webui list by session id (`_wbFilterRemote`).
- Ctrl+K session palette now searches REMOTE sessions too (it previously only saw local + live-remote sessions, never remote stopped ones). It merges already-discovered remote sessions, kicks a one-time ssh scan of every configured host on open (results stream in), and resumes a remote pick with its `hostId` so `--resume` runs on the right machine.

## 2.115.0 — 2026-07-13
- Optional persistent ops log (`src/opslog.js`, env-gated no-op by default): with `VIBESPACE_OPSLOG_DIR` set the server tees its console output to daily-rotated files (`server-YYYY-MM-DD.log`, retention `VIBESPACE_OPSLOG_KEEP_DAYS`, default 30d) plus boot/exit/crash markers — typically pointed at a path-scoped CephFS subtree shared with a fleet admin, so instance logs survive pod recreation and are centrally scannable without any logging infrastructure (no per-node agents, no log database). `VIBESPACE_OPSLOG_CEPHFS_*` env makes the server kernel-mount the subtree itself (same mechanism as My storage). Hung-mount-proof: async writes behind a 10s circuit breaker (one stuck write disables the logger; the app is never blocked — the 2.108.3 threadpool lesson). Helm: `opslog.{enabled,secretName,dir,keepDays}` (secret carries mons/fsName/client/key/path; name defaults to `u-<user>-opslog`).

## 2.114.1 — 2026-07-13
- Usage popup: multi-subscription identity un-confusion (real report: the "CLI login" entry looked like two accounts had swapped quotas). Root cause: `~/.claude.json`'s recorded identity (oauthAccount) goes STALE after a `/login` account switch — the config file said one account while the login token actually belonged to another, so the on-demand ⟳ fetched the other account's quota under the wrong label. Fix: the human-gated ⟳ refresh now also captures the token's TRUE identity (org uuid/name via the CLI's own roles endpoint — one extra read-only call per click, never scheduled); the global↔named account link prefers org-uuid equality over the config email (and a proven-different org BREAKS a stale email match); the popup labels the CLI login with the token-derived identity and shows an amber warning when it contradicts the config file (with the /login remedy). The statusline hook preserves the captured identity through passive writes, like scopedWeekly. New smoke: `scripts/test-usage-link.mjs` (9 checks).

## 2.114.0 — 2026-07-13
- Observability integrations (both optional, env/settings-gated, off by default): (1) **PostHog product analytics** — set `posthog.host` + `posthog.key` (settings, or `VIBESPACE_POSTHOG_HOST/_KEY` env / helm `posthog.*`) and the client loads posthog-js with autocapture and FULLY MASKED session recording (all inputs and all text hidden — interaction shapes only, in line with the names-only telemetry philosophy); disabled whenever local diagnostics (`telemetry.enabled`) are off. (2) **Prometheus metrics exporter** — `VIBESPACE_METRICS_PORT` (helm `metrics.enabled`) serves a hand-rolled `/metrics` on a SEPARATE non-ingress port (RSS/heap/event-loop/live-sessions/ws-clients/leak canaries + version info), scraped in-cluster via standard `prometheus.io/*` pod annotations.

## 2.113.1 — 2026-07-12
- Diff injection: SEVERAL Task Groups changing on one turn now deliver as ONE combined `<vibespace-task-update>` block whose header line enumerates every changed group with a phrase summary ("工作: 3 new activity · 个人项目: 1 checklist change + 3 new activity"), per-group sections following smallest-first (user directive: stacked per-group blocks meant the ~2KB truncation preview could hide the very fact that a second group changed). Same rule extended to every multi-block delivery: the manifest now names EVERY block (diff groups, full re-deliveries, newly-bound groups), not just kinds.

## 2.113.0 — 2026-07-12
- Agent context injection: Task Group UPDATES now deliver as DIFFS (user request — the full re-injection was several KB of repetition per change). Each session snapshots what it last saw per group; a mid-session change injects a compact `<vibespace-task-update>` block listing only the actual deltas: added/checked/unchecked/removed checklist items (with who), objective/title edits, changed shared-context files, and the new activity entries — with `show --full` pointers and a ~5KB cap. Full context still goes out on first contact and after a server restart; no-op edits (e.g. re-saving an unchanged objective) now inject nothing at all. Toggle: Settings → Session → "Task Group updates as diffs" (default on).
- Agent context injection: several first-time groups arriving on one prompt (the codex first-prompt path) now deliver as ONE layered multi-group context instead of N full payloads each repeating the tools section.
- Diff delivery hardening (10-finding adversarial review, all fixed or documented): duplicate-text checklist items pair by occurrence (a check on the 2nd duplicate was silently lost / phantom lines repeated forever); designating or changing a group's shared context folder mid-session falls back to a FULL delivery (the file index + conventions must be taught); `|` in filenames no longer shears the file-change parse; remote sessions no longer get a dead TASK.md pointer; mixed deliveries (a newly-bound group's full context + other groups' diffs) are manifest-headed with the small diffs first so the ~2KB truncation preview can never hide one part entirely; oversized combined deliveries always lead with the persisted-output rescue line.

## 2.112.7 — 2026-07-12
- Self-update: fixed a recurring "update failed — package-lock.json local changes would be overwritten" abort. update.sh reset the generated files with a COMBINED `git checkout -- package-lock.json data/bin/vibespace-status`; on instances where data/bin/vibespace-status is untracked (generated + gitignored), that whole command aborts on the bad pathspec and resets NEITHER file, so package-lock.json stayed dirty and the ff pull aborted. Now each path is reset independently (package-lock.json alone; tracked data/bin helpers per-path), with a stash-and-retry belt.

## 2.112.6 — 2026-07-12
- Window manager: stage-hidden windows are now invisible to every "visible windows" filter (close-time auto-focus-next, layout presets, overlap switcher/indicator) — closing the hero used to auto-focus a stage-hidden previous hero and yank every staged client back to it
- Stage: the ACTIVE HERO is now SHARED across clients (user directive — the walk-over scenario: a device left idle on the stage mirrors what you do on another device, so walking over shows the current workspace). Staged clients follow hero switches live (deferred while you're mid-drag); closing the hero shows the placeholder everywhere; ENTERING the stage adopts the shared hero. Which tab is staged at all remains per-tab, like the active desktop.

## 2.112.5 — 2026-07-12
- Stage MULTI-CLIENT: fixed a data-loss bug — materializing a session that had no local window created a stage-owned copy under a fresh winId; leaving to the desktop that (per other clients) held that session's window then broadcast a state without it, CLOSING the window on every client ("窗口A两个客户端都看不到了"). Materialization now ADOPTS the desktop record's identity (rekey to its winId + home desktop + geometry + maximize state), with a leave-time retry for late-arriving session ids. Reproduced and verified with a two-browser-client harness.
- Stage: maximized heroes handled first-class — borrow un-maximizes onto the slot, hand-back restores home geometry BEFORE re-maximizing (so a later un-maximize lands at home size, not slot size)
- Stage live sync across clients: slot moves, stage grid changes, and the active hero's workspace set (aux open/close/move) now mirror to other staged clients in real time; which view a tab shows (staged or not, which hero) stays per-tab like the active desktop

## 2.112.4 — 2026-07-12
- Stage: leaving the stage returns the hero window to its normal desktop at its HOME geometry (it kept the stage slot size before); temporary leave + re-enter re-borrows the slot seamlessly
- Stage: grid config set while on the stage now persists (stage SyncStore `grid` key; desktop autosave stays suppressed)
- Stage: window drags between the stage and normal desktops are blocked in BOTH directions (previews are not drop targets across the boundary); the placeholder can no longer escape onto a normal desktop (guard + self-heal + never captured into desktop records)
- Settings live-apply: the Dynamic desktop toggle takes effect immediately (stage preview appears/disappears; disabling while staged returns to the previous desktop) — no page refresh
- Settings live-apply: session-card settings (click behavior, click-to-copy, visible fields, detail truncation) re-render the sidebar immediately — no page refresh

## 2.112.3 — 2026-07-12

- **Fixed the Stage slot never persisting** (real report: the placeholder "never moved" — it dragged fine but every materialization landed back top-left). `stage.init()` ran BEFORE `initStateSync()` in the app constructor, so the 'stage' SyncStore was never registered and every slot/workspace write was **silently dropped** (StateSync.set no-ops on unknown stores). Init reordered + a lazy store-registration guard on every stage read/write. CDP-verified closed loop: drag → slot persists across page loads → placeholder AND materialized hero land at the persisted position.

## 2.112.2 — 2026-07-12

- **Stage workspaces: full replay audit across every window type** (design §4b matrix covers all 17 openSpec actions). New guards: `openEditor` replays validate the file first; **editors with unsaved changes are never LRU-evicted** (CodeEditor now exposes dirty state on the window record — closing one silently lost the edits); task detail/log replays skip when the task group was deleted (the window used to open then immediately self-close); workflow-detail replays probe `/api/workflow` and skip on 404.

## 2.112.1 — 2026-07-12

- **Stage workspaces: restoration conditions per window class** (design §4b). Files opened from INSIDE an archive now record their recipe (`via: archive+entry`) — a replay whose temp file is gone re-extracts it fresh. Replays pre-validate their target (file/info probe); unrecoverable windows (dead blob pages, recipe-less temps, deleted files) are skipped with one summary toast instead of opening broken viewers, and temp/blob-backed windows with no recipe are exempt from LRU eviction (closing them would lose them forever).

## 2.112.0 — 2026-07-12

- **NEW: Dynamic desktop ("Stage")** — settings toggle `desktop.dynamicEnabled` (default off). A special desktop at the LEFT of the strip (separated preview with the slot outline): sessions can't be placed there directly; while it's active, ANY switch-to-session action materializes that session into a shared, freely draggable/resizable SLOT, together with its own recorded workspace of helper windows (file explorers, viewers, editors… bound automatically while that session is the hero, replayed via openSpec + stage geometry on return, scroll offsets/live explorer path restored). Closing the hero returns the placeholder; switching heroes hides the previous workspace (LRU keep-alive, setting `desktop.stageKeepAlive`, default 3 — beyond it aux windows close and replay on demand; session windows are never closed by the stage). The incoming hero stacks at the BOTTOM so a moved slot never covers a workspace's aux windows. Same window can live on a normal desktop and the stage (one window, two geometries). Ctrl+Alt+Left from the leftmost desktop enters; Right leaves. Design: docs/design-dynamic-desktop.md. CDP smoke-verified 12/12 on an isolated instance.
- **Update dialog no longer contradicts itself** (real report: "Latest version" badge above v2.111.30's changelog): `/api/version`'s `latest` and the changelog are cached separately and can disagree — the dialog now trusts whichever source names the newer version.

## 2.111.30 — 2026-07-12

- **Update detection no longer lags hours behind** (real report: an instance on 2.111.25 said "no update" while .29 was out). The latest-version + changelog fetches were cached 6 hours server-side; now 15 min, and the gear menu / update dialog pass `?fresh=1` (60s floor) so opening them always checks properly.

## 2.111.29 — 2026-07-12 (P0)

- **Fixed a syntax error that broke the entire `vibespace-status` CLI** on any instance running 2.111.24–2.111.28. The 2.111.24 "reason + detail required" help text used a shell line-continuation backslash (`… \`) at the END of a single-quoted JS string in the generator template — the `\'` escaped the closing quote, so every regenerated `data/bin/vibespace-status` failed to parse and `vibespace-status <anything>` exited with a SyntaxError. The example is now a single line with no trailing backslash. The file regenerates correctly on the next server start; a live instance can also just re-run its Update.

## 2.111.28 — 2026-07-12

- Follow-up to 2.111.26: the `.gitignore` entry for the generated `data/bin/vibespace-status` had an INLINE comment (`path  # ...`) — .gitignore has no inline comments, so the whole line became the pattern and never matched, letting `git add -A` re-track the file. Comment moved to its own line; verified `git check-ignore` now ignores it and `git add -A` no longer picks it up.

## 2.111.27 — 2026-07-12

- **When SSO (Clerk) is configured, the onboarding password step is skipped** — login is handled by the identity provider, so a local password is redundant. The step shows a short "SSO is configured, no password needed" note + Continue instead of the password inputs. On config import, an included `vsPassword` record is now IGNORED under SSO (the import row is disabled with an "ignored — this instance uses SSO login" note, and the server reports `vsPassword: skipped (SSO configured)`). New `auth.ssoEnabled` surfaced through `/api/home`.

## 2.111.26 — 2026-07-12

- **Fixed self-update failing with "Your local changes to data/bin/vibespace-status would be overwritten"**. That file is REGENERATED on every server startup by createStatusHelper() but was also tracked in git, so each boot dirtied the working tree and blocked `git pull --ff-only`. It's now untracked (.gitignore, like data/bin/code) and update.sh resets it — plus any other regenerated tracked file under data/bin/ — before pulling. One-time manual unblock for an instance stuck on the old update.sh: in its shell run `cd ~/vibespace && git checkout -- data/bin/vibespace-status && git pull --ff-only` (or just discard it, then re-click Update).

## 2.111.25 — 2026-07-12

- The injected context's "Reporting back" section now shows COPY-READY complete invocations (fenced one-liners with `--detail`, and `--reason` + `--detail` on the status sample) — the first call an agent copies is already the valid form, instead of learning the required flags via rejection.

## 2.111.24 — 2026-07-12

- Waiting states now require the COMPLETE reason: `blocked`/`needs-input`/`review` must carry BOTH `--reason` (one line for the board chip) AND `--detail` (full context: options, what was tried, the recommendation) — rejected at CLI pre-flight and the agent route otherwise. Same-state records already carrying both still accept reason-less tweaks (urgency bumps). The status CLI usage spells the requirement out.

## 2.111.23 — 2026-07-12

- **`vibespace-status blocked/needs-input/review` without a reason is now REJECTED** (CLI pre-flight + server-side, matching error text) — a bare waiting state on the board tells the user nothing. The error teaches the fix: `--reason "…" ` + say it in chat + mirror with vibespace-ask. Grace: tweaking (e.g. `--urgency`) a same-state record that already carries a reason still passes.

## 2.111.22 — 2026-07-12

- **Self-update dialog now reliably auto-reloads** (real report: it didn't). It keyed the reload on the version NUMBER changing, so re-running the update while already on the latest never reloaded. Now it detects the restart itself — the server going unreachable then reachable again (or a version bump) — cache-busts `/api/version`, and reloads on that. Non-zero exit / genuine no-op / timeout are distinguished, with a manual "Reload now" fallback button always available.
- **Agent tool injection slimmed to a discovery layer**: the per-session `<vibespace-task-context>` "how to report back" block is now a compact list (each tool + when to reach for it) instead of the full ~2.3KB rules dump — detailed syntax/caveats moved to each CLI's own output (run with no args) and to point-of-use reminders. `vibespace-status` prints a "you're waiting on the user — say it in chat + mirror with vibespace-ask" reminder when set to blocked/needs-input/review; its usage carries the honesty guidance.

## 2.111.21 — 2026-07-12

- **Onboarding CLI login/install now runs in an EMBEDDED terminal modal** (user directive: no more "opens a detached terminal, hides the wizard, never comes back"). The wizard stays on screen; the modal polls `/api/backend-status` and closes itself with a ✓ the moment the login/install lands, refreshing the status cards.
- **Update VibeSpace is now a UI progress dialog** — the update runs as a detached server op streaming its log into the dialog; the dialog survives the service restart and **reloads the page automatically** once the new version answers. Failure shows the exit code + log. No more terminal that "runs for a while then just sits there".
- **Unmount / mountpoint change / remove now sweep the leftover mountpoint directory when it is empty** (never recursive — non-empty dirs are left alone).
- `vibespace-ask` now reminds the agent, in its own output, to ALSO post the full question in the chat reply (real pattern: agents filed the inbox item and ended the turn silently).

## 2.111.20 — 2026-07-12

- **Usage meters no longer vanish on instances without captured data** (real report: k8s instances with showUsage on showed nothing). Chat sessions never produce the passive statusline feed, so a fresh chat-only instance had zero usage cache and the meter row was skipped entirely. A machine with a CLI login now renders gray "no data yet" donuts + a popup note explaining where data comes from (terminal sessions, or the on-demand ⟳).
- **New setting `layout.presetOneShot`**: layout buttons arrange windows once and return to free-form, instead of keeping the grid armed for every future drag (default remains the persistent grid).
- **Settings window scroll-spy**: the left category nav highlights the section currently in view as you scroll.
- **Gear menu regrouped by nature**: ① Customize UI / Language ② Manage agents / Usage / Diagnostics ③ Backup / Password / Update ④ Welcome tour / Sign out; Diagnostics got its own pulse icon (was sharing Usage's chart icon).

## 2.111.19 — 2026-07-12

- Desktop availability probe retries with backoff (3s→90s, 5 attempts) when it fails — a page loaded during a server-restart window now self-heals without an F5 or a WebSocket reconnect (the button vanished repeatedly for a user during an update storm).

## 2.111.18 — 2026-07-12

- **Archive extraction shows a persistent progress bar** (user request: big archives looked frozen for minutes). Extraction now runs as a server-side op — a streamed listing pass counts total entries, then unzip/tar verbose output drives a live per-entry counter — polled by the client and rendered through the same machinery as uploads: inline progress row in the file list, upload-button ring, popover entry, with cancel. Remote-host extraction keeps the plain synchronous path. Also fixed skip-existing tolerance for modern tar ("File exists" vs "already exists" — the old sync path mis-reported success as an error too).

## 2.111.17 — 2026-07-12

- **Dragging a FOLDER onto the file explorer now works** (real report: "dragging a folder from the Mac always fails"). The explorer's OS-drop handler used the flat `dataTransfer.files` list, which represents a dragged folder as one unreadable pseudo-File — the upload always failed. It now recurses the tree via the entries API (`collectDroppedFiles`, shared with the chat drop path, which already did this correctly) and recreates the folder structure at the destination. Server round-trip verified with CJK names, spaces, and deep nesting.

## 2.111.16 — 2026-07-12

- **Mac Finder can now WRITE into mounted shares** (real report: userW's Finder mount was read-only). Finder requires WebDAV class 2 (locking) to mount read-write — with class 1 it silently mounts read-only regardless of permissions. /dav now advertises `DAV: 1, 2` and implements advisory LOCK/UNLOCK (fake single-writer locks, nginx-dav_ext-style) + accept-and-ignore PROPPATCH; read-only tokens reject LOCK (403) so Finder correctly shows them read-only. Verified: OPTIONS/LOCK/PUT/PROPPATCH/UNLOCK green, rclone Bearer path unaffected.
- Share dialog also emits a ready-to-paste **rclone config section** (webdav + bearer_token) next to the Finder info.

## 2.111.15 — 2026-07-12

- "Share a local folder" now also shows the Finder/Explorer connection info (dav URL + raw token) so a Mac can mount the share natively without decoding the bridge link.

## 2.111.14 — 2026-07-12

- **/dav accepts Basic auth with the mount token as the password** — macOS Finder (Cmd+K) and Windows Explorer can now mount a shared folder natively: server `https://<instance>/dav`, any username, password = the `vsmt_…` token from "Share a local folder". rclone Bearer unchanged.
- **Storage dialogs fully localized** (real report: Share a local folder / Import rclone config / Import share link / Connect storage were English-only) — 82 strings wrapped, zh+ja dictionaries +98 entries each.

## 2.111.13 — 2026-07-12

- **Desktop feature no longer vanishes for the whole page session** when the page happens to load during a server restart (real report: userW onboarded mid-update and the Desktop button was "disabled"). The `/api/vnc/status` availability probe ran once at startup with failures swallowed; it now re-probes on every WebSocket reconnect until it succeeds.

## 2.111.12 — 2026-07-12

- **Terminal wide-spaced font (FOUT) can no longer get stuck permanently** (hit during userW's onboarding). The 2.105.0 fix polls for the web font's registration for only 20s — on a slow route to Google Fonts (cold-cache first visit, cross-border) the CSS lands after the cap, the repaint never fires, and the terminal keeps fallback-measured wide cells with web-font glyphs forever. Added an event-driven backstop: `document.fonts` `loadingdone` (no time limit) triggers the atlas-clear + refit whenever the font finally arrives; watchers are de-duplicated on re-entry and cleaned in dispose. Immediate user workaround on an affected session: reload the page (warm cache paints correctly) or nudge the font size.

## 2.111.11 — 2026-07-12

- Removed the temporary code-block overlap diagnostic probe (2.111.10 fix user-verified on device).

## 2.111.10 — 2026-07-12

- **Code-block line overlap: the REAL fix, proven by construction.** `renderCodeBlock` split `hljs.highlight()` output by `\n`, but hljs emits spans that CROSS newlines (markdown emphasis paired `_` from `min_size`…`max_bytes` across lines). The split left one line with an unclosed `<span>` and a later line with a stray `</span>`; embedded in the per-line template, that stray close ended `.chat-code-text` EARLY, dumping the rest of the line as extra anonymous flex items — `flex:1 + min-width:0` squeezed the real span to ~47px and its `white-space:pre` text painted OVER the siblings (overprint when unwrapped, a ~7-char narrow column when wrapped). Byte-exact match with the on-device probe (82-char span at 47.4px, layout rows clean). Fix: `splitHighlightedLines()` carries open spans across line fragments (close at line end, re-open at next start) — every row self-contained and balanced; also applied to `rehighlightCodeBlock`. Verified: the previously-corrupt real document renders 60 rows, 0 anomalies, in headless Chrome at mobile width. (2.111.8's content-visibility and 2.111.9's text-size-adjust theories were both refuted by the probe — kept as hygiene, documented as not-the-cause.)

## 2.111.9 — 2026-07-12

- **Actually fixed the mobile code-block text overlap** (2.111.8's content-visibility theory was refuted by an on-device probe). Real cause: `text-size-adjust` was never set, so Android Chrome's text autosizer (font boosting) inflated/rewrapped the 11px code font — rewrapping `white-space: pre` lines into narrow columns painted over adjacent rows while layout stayed clean (probe: rows perfectly stacked, one 82-char span squeezed to 47.4px vs 353.2px siblings). Fix: `html { -webkit-text-size-adjust: 100%; text-size-adjust: 100% }`. The on-device diagnostic probe stays one release for verification.

## 2.111.8 — 2026-07-12

- **Fixed chat code blocks painting overlapping lines (long-standing, root-caused)**. `.chat-msg` uses `content-visibility: auto` with `contain-intrinsic-size: auto` — which REMEMBERS the last-rendered height. A code block's height is width-sensitive when wrapped (narrower → more wrapped rows → taller), so a message first rendered at desktop width cached a short height; scrolling it off then back on a narrower viewport (mobile, or a window resize) reused that stale short height, making the box shorter than its content and the code lines paint over each other. This exactly explains why it was persistent, never self-healed on scroll, and never reproduced on a fresh narrow-width first render. Code-block messages are now carved out of the content-visibility height cache (`:has(.chat-code-block)`), so their height is always measured live. Also removes the scroll tracer added in 2.111.4-5 (the scroll-jump fix is verified).

## 2.111.7 — 2026-07-11

- **Direct CephFS subtree sharing (bypasses the WebDAV proxy)**. Sharing a folder from a CephFS "My storage" now mints a PATH-SCOPED cephx key via an in-cluster minter and produces a `vibespace-cephmount:` link; the receiver kernel-mounts the subtree directly at full flash bandwidth instead of relaying every byte through the source instance's Node process. The minted key is scoped to exactly the shared subpath (verified: `mds allow r path=…`), listed under "Shares I created", and Revoke deletes the key cluster-side. Env-gated (`VIBESPACE_CEPHMINT_URL`/`_TOKEN`) — without a minter, sharing falls back to the WebDAV bridge as before. Cross-cluster/external sharing still uses the bridge.

## 2.111.6 — 2026-07-11

- **Inbox readability (user request)**: every item gets a ⤢ viewer — a dedicated dialog with the text+detail rendered as markdown, fully selectable, with a Copy button. Item text in the popup is selectable now too (a real selection no longer triggers the jump-and-close). And the agent guidance is strengthened everywhere (session intro, per-turn reminder, stop nudge, CLI usage, group context): the inbox is a NOTIFICATION MIRROR — the full content must also appear in the chat reply, never only in the inbox.

## 2.111.5 — 2026-07-11

- **Paging up no longer jumps / slams to the top (root fix, tracer-diagnosed)**. The scroll compensation used scrollHeight DELTAS — but under `content-visibility: auto` a freshly inserted batch measures at its ~80px per-message ESTIMATE while the trimmed batch had REAL heights, so the delta could go NEGATIVE: the tracer caught an insert-50/trim-50 page SHRINKING scrollHeight by 312px, the compensation clamping scrollTop to 0 (slammed to the very top), and the top sentinel then load-looping at the clamp. All four paging paths (extend-top, trim-top-adjacent flows, gap slab loads, gap trims) now preserve position by ANCHORING the topmost visible element and restoring its offset after the mutation — layout ground truth regardless of estimated heights. The scroll tracer stays in for verification.

## 2.111.4 — 2026-07-11

- **Sidebar localization pass (user reports)**: the Folders tab zone headers (Active / Recent / History), "No running sessions" and the other workbench empty states, and the Remote tab's action rows (Add machine / Connect storage / Import share link / Import rclone config / Share a local folder), Bridge tokens section, Revoke buttons+confirms, and the footer notes are now translated (zh/ja).
- **Storage rows**: dropped the `→` arrow between the type tag and the mount path (user request) — the line is now `[Type] /path`.
- **TEMPORARY: chat scroll-jump tracer.** Paging up in chat still occasionally jumps; every scroll-affecting path (extendTop/Bottom, trims, run-fold anchor restores, gap slabs, jumps) now records into a per-view ring buffer, and an unexplained scrollTop jump (>600px with no recent wheel and no expected compensation) ships the buffer to telemetry as `chat-scroll-jump` (kind `trace`, 64KB detail). Zero overhead beyond object pushes; remove after diagnosis.

## 2.111.3 — 2026-07-11

- **Update dialog on the latest version now shows this version's changelog** instead of an empty "already latest" line (user request): the `/api/changelog-diff` endpoint returns the current version's own entry when nothing newer exists, and the dialog renders it under "What's in this version" with a *Latest version* tag.
- **In-container Desktop: Chromium wouldn't launch after a pod restart** (real report). Chromium's profile `SingletonLock` (persisted in the PVC) records the pod hostname+pid; after a pod recreation it points at a dead pod and Chromium refuses to start ("profile in use on another computer"). The entrypoint now clears the stale lock on every boot.
- **Desktop panel launchers bind directly to their apps** (`xfce4-terminal` / `thunar` / `chromium` / `xfce4-settings-manager`) instead of `exo-open --launch <Category>`, which silently no-ops without a registered preferred app (user directive: bind the browser straight to Chromium). Image-level; carried on the next image build.
- **Default pod resources raised to 8 CPU / 32 GiB memory** (limit) in the Helm chart.

## 2.111.2 — 2026-07-11

- **In-container Desktop: the panel "Settings" button did nothing (real report)**. The stock XFCE panel generated on first desktop boot ships an EMPTY 4th launcher — a button with no command — plus Terminal/File-Manager launchers that use `exo-open --launch <Category>`, which silently no-ops when no preferred app is registered. The deployment image now bakes a curated XFCE default (`/etc/xdg/xfce4/…`): the empty launcher becomes a real Settings Manager launcher, and `helpers.rc` registers Terminal=xfce4-terminal / Files=Thunar / Browser=chromium so all the panel buttons work. Applies to FRESH desktops; an already-generated user config is repaired with a one-line fix (see the private deploy README). Image-level change — carried on the next image build.

## 2.111.1 — 2026-07-11

- **In-container Desktop stopped opening ("Too many security failures", real report)**: TigerVNC blacklists a source host after a few unauthenticated connect-then-drop attempts — but EVERY desktop connection comes from 127.0.0.1 (the cookie-authed WS bridge), and VibeSpace's own `portListening` health probe connects and immediately closes the socket, which TigerVNC counts as a failed attempt. A handful of status polls poisoned the blacklist and locked the desktop out. The VNC server now launches with `-UseBlacklist 0` (safe — the bridge is the only route in and it already authenticates; the blacklist protected nothing and only self-DoSed). Restart the desktop once (kill the stale Xtigervnc / redeploy) to clear an already-tripped blacklist.
- **Update-confirm dialog was clipped**: the changelog dialog set its width on the BODY, but `.dialog` is a fixed 440px `overflow:hidden` box, so the wider body overflowed and cut off the action buttons. Width now goes on the dialog shell (`minWidth`).

## 2.111.0 — 2026-07-11

**Noticeable notifications (user reports: the floating toast had no background and went unseen; error toasts too)**

- All toasts — inbox items, errors, confirmations — are now **cards anchored next to the inbox button**: real background, colored edge, shadow, close button. (Root cause of the invisibility: the old style referenced undefined CSS tokens, so the background resolved transparent.)
- Toast duration is configurable: Settings → *Notification popup duration (seconds)* (default 6).
- The inbox popup has **two pages**: the real Inbox (default) and **Notifications** — the recent popup history (messages only, kept locally, live-updating).

**Update flow: changelog confirmation (user directive)**

- Clicking ⚙ *Update VibeSpace…* no longer updates immediately — a dialog lists **every changelog entry between your running version and the latest**, and the update runs only after you confirm (`GET /api/changelog-diff`; offline-safe). Per-patch changelog discipline continues.

**Storage rows decluttered (user directives)**

- The connection-type tag ([S3], [Drive], [OneDrive]…) moved off the name row into the detail line: `[Type] → /mount/path` — and now shows for every type including S3.
- The confusing plug/download **Connect icon is now a text chip** ("Connect"), only shown on deliberately-disconnected rows (adds auto-connect and 2.110.0's supervision keep mounts up otherwise).
- The **duplicate-mount button is gone** (superseded by submounts) and **Remove moved into the Edit dialog** (fewer per-row icons; still confirm-guarded, still refuses while a credential has children).

**Read-only mounts explain write failures (user report: "创建文件失败" said nothing)**

- Creating/renaming/deleting files inside a read-only mount now says WHY: the server appends "“<name>” is connected READ-ONLY…" when the failing path is under an RO mount (generic read-only note for other EROFS), and the file explorer surfaces the server's reason instead of a bare "failed" toast.

## 2.110.1 — 2026-07-11

- The ⚙ *Update VibeSpace…* row is now two lines (user request): action label on top, `vCURRENT → vLATEST` below (highlighted when an update is available; just `vCURRENT` when up to date).

## 2.110.0 — 2026-07-11

**Hardened rclone mounts: read/write caching + auto-recovery (user directive: 最稳定、性能最好、自动恢复)**

- **`--vfs-cache-mode full`** on every rclone mount: reads cached chunk-wise on local disk, writes land locally and upload in the background. The cache is **persistent per mount** (`data/vfs-cache/<id>`; `VIBESPACE_VFS_CACHE_DIR` overrides the root) — dirty writes survive a daemon crash and resume uploading on reconnect (verified: SIGKILL the daemon 0.5s after a write, auto-remount, object lands). Bounded IO (`--timeout 60s --contimeout 15s` + retries) so a flaky backend degrades instead of hanging; new setting `mounts.vfsCacheMaxSizeGB` (default 10). Flags are gated on the installed rclone knowing them (an old system rclone falls back to `writes` mode).
- **Auto-reconnect supervision**: a mount whose daemon died or whose IO hung (torn down by the hung-mount defense) now self-heals — the health watchdog remounts it with backoff (1→2→5→10 min cap), surfacing "auto-reconnecting (attempt N)". Auth-class failures (revoked/expired) are excluded — they need the user and keep their actionable error. Only an explicit Unmount stops supervision (`desired` now only ever reflects USER intent; internal teardowns keep it).
- **rclone binary NFS trap fixed**: executing the 57 MB pinned binary from a network filesystem demand-pages it through the mount on every run (~22 s wall, measured). `rcloneBin()` now copies it once to `~/.cache/vibespace/` (keyed by size+mtime) and execs the local copy — 22 s → 0.03 s.

**Containers: in-place update + restart (user report: "miku cc里部署的instance不能自动更新+重启")**

- The pod entrypoint now runs the server under a **respawn supervisor** instead of `exec` — `scripts/update.sh` (⚙ → Update VibeSpace…) kills the server pid and the loop respawns it on the new code; dtach agent sessions share the PID namespace and **survive the restart**. The server writes `data/server.pid`; `VIBESPACE_SUPERVISED=1` advertises the restart path (also exported by `run.sh`). Needs one new image rollout; after that, updates are fully in-place.

**Version visibility**: the ⚙ menu's *Update VibeSpace…* row now shows the running version, and highlights `vX → vY` when the canonical repo has a newer release (`GET /api/version`; latest checked lazily, cached 6 h, offline-safe).

## 2.109.5 — 2026-07-11

Three chat-card bugs (all user-reported):

- **Scrolling up through history no longer jumps / load-loops on collapsed Bash runs.** The run fold ran on a 180ms-debounced observer — AFTER `_extendTop` had already compensated the scroll position — so freshly loaded Bash cards folded out from above the viewport, the view yanked, and the top sentinel re-triggered another load in a loop ("翻不回来"). `_updateRuns` now anchors the topmost visible element across every pass (any timing path stays still, including opening/closing search), the pagination paths fold new cards in the same task as their scroll compensation, and the open/closed memory of a run is keyed by ANY member instead of the first — prepending older members onto a run no longer re-collapses the one being read.

- **A tool card waiting for permission approval no longer folds into a run-collapse group.** The thinking/Bash run fold used to swallow a Bash card whose Allow/Deny buttons were pending — the turn stalled with no visible prompt. An unresolved permission now breaks the run and stays visible; it folds back after resolve. (The permission overlay is injected in place, which the runs MutationObserver can't see — the permission edit path re-evaluates the fold directly.)
- **An answered AskUserQuestion questionnaire can no longer resurrect as awaiting-input.** Cooperating gaps closed: (1) the `control_response` only ever lived in server memory (it goes to claude's stdin; the wrapper's `.buf` tees stdout only) so a restart-rebuilt history was request-without-response — the normalizer's tool_result merge now auto-resolves an unresolved permission (a result proves the question was answered), and the reverse replay order can no longer flip a settled card back to pending (the error→pending restore now applies only to interrupt-flushed tools); (2) is_error alone is NOT read as denial — an approved tool that then fails keeps "✓ Allowed"; only the CLI's canned user-rejection text marks "✗ Denied"; (3) `activePendingPermissions()` judged "resolved" from only the last 100 records — a session that kept working pushed the answer out of the window and every attach re-advertised the stale request (same class as the old chatStatus 200-record scan bug; now scans all records); (4) the client-side attach injection now skips tools that already completed. Verified against the real stuck session's JSONL+buffer plus a 9-order replay matrix through the actual rebuild pipeline.
- **Chat windows no longer rebuild their run folds in a permanent 180ms loop** — the `_runsMutating` flag never actually suppressed the MutationObserver's self-trigger (callbacks deliver on a microtask after the flag resets); the pass now drains its own records via `takeRecords()`.
- **An opened run fold no longer snaps shut when its tool completes** — the open/closed memory is keyed by element, and the completion re-render swaps the element (`replaceWith`); membership now transfers across the swap (review-confirmed: a single-Bash fold opened to watch live output re-collapsed the moment the result landed).

## 2.109.4 — 2026-07-11

- **Env-provisioned My storage unmounted on first boot**: `mounts.pathGuard` was mis-nested INSIDE the broadcast callback, so a construction-time broadcast (env-import add→_notify→broadcast) hit the mounts-const TDZ and threw out of `add()` before it set desired=mounted — the root cause behind the cephfs/S3 first-boot glitch.
- Helm: nil-safe s3/cephfs/fuse conditionals (`--reuse-values` on an instance without an s3 block nil-pointered).

## 2.109.3 — 2026-07-11

- **Env-provisioned CephFS My storage self-heals to desired=mounted on every boot** — a first-import race / pre-cephfs-code boot could leave it permanently unmounted.

## 2.109.2 — 2026-07-11

- **CephFS health-probe tolerance**: the native cephfs mount gets a longer probe window (12s — an MDS session on a cold mount can spike a first `ls`) and requires TWO consecutive hangs before the watchdog auto-disconnects a trusted deployment mount (a single blip won't tear it down).

## 2.109.1 — 2026-07-11

**Native all-flash CephFS "My storage" (user-approved, replaces the slow RGW S3)** — a new `cephfs` mount type does a kernel `mount -t ceph` via sudo (the container has passwordless sudo + SYS_ADMIN + AppArmor Unconfined). Env-provisioned (`VIBESPACE_CEPHFS_MONS/NAME/PATH/USER/SECRET`) as "My storage", taking precedence over S3 when both are set. Per-user quota is enforced on the CephFS subtree (`ceph.quota.max_bytes`), shown as the filesystem size. Editable name + mount point, connection env-locked (like the S3 My storage). Helm: `cephfs.*` values + a widened securityContext gate (fuse OR cephfs); image adds `ceph-common`. Verified live on a deployed instance: mounts at boot, survives both health sweeps, 1T quota, writable, server stays responsive. No CSI driver needed — the pod's kernel ceph client mounts the scoped subtree directly.

## 2.109.0 — 2026-07-11

**Structural IO isolation (user directive "把IO隔离，不用重写")** — every LOCAL user-path filesystem op in the file routes now runs in a dedicated `worker_threads` pool (`src/safe-fs.js` + `src/safe-fs-worker.js`, 4 workers, each with its own libuv threadpool) with a per-op deadline and kill+respawn on a stuck worker. A hung mount can no longer starve the main event loop / shared pool — the structural fix behind today's tactical guards. Path resolution / traversal checks stay in the main process; the worker only executes the already-resolved absolute path. `?host=` remote ops are untouched. Verified: during a 6.3s dead-mount connect, 41 concurrent good listings (max 7ms) + 41 logins (max 6ms) stayed fast, zero failures.

**Revoked/expired share now surfaces to the receiver (user-flagged: "revoke了token接受方如何提示")** — a fuse mount to a revoked share still "mounts" and a cached mountpoint `ls` lies about it, so the health probe is now 3-state (ok / error / **hung**) and revocable mounts (imported shares, VibeSpace bridges, expiring credentials) get an uncached BACKEND re-auth probe that catches a 401/403. The row shows "connected but every file errors — the share may have been revoked…" instead of a green mount whose files all error; it clears automatically if access is re-granted. Non-revocable mounts (your own S3/Drive) skip the extra round-trip. Verified e2e across mount-of-already-revoked and revoke-while-mounted.

**Storage Edit dialog prefills real values** — `GET /api/mounts/:id/config` returns the decrypted connection config so the Edit dialog shows the actual tokens/keys/params (user directive: no "blank = keep" placeholders). Save diffs against the fetched original (unchanged secrets aren't re-encrypted; an emptied rclone param is removed). Env-provisioned records return no secrets.

Verified against two password-auth instances end to end: bridge shares (RO/RW, RO-write rejected at fuse AND /dav), path-traversal rejection, self-mount refusal, garbage-link errors, credential/submount unmount lifecycle (unmount one submount leaves siblings + credential intact; remove-credential-with-children refused; mountpoint left empty & re-mountable), and source-instance-frozen keeping the receiver responsive.

## 2.108.8 — 2026-07-11

- **`window.closeBehavior` default is now DETACH** (user directive — no per-type exception): closing a session window keeps the session alive in the sidebar for re-attach. Automation helper terminals still always terminate. (Replaces the 2.108.7 shell-only default.)
- **Edit dialog prefills real values**: `GET /api/mounts/:id/config` returns the fully decrypted connection config (tokens/keys included) so the storage Edit dialog shows the actual current values instead of "blank = keep" placeholders (user directive). Env-provisioned records return no secrets (connection is deployment-owned).

## 2.108.7 — 2026-07-11

**Shell terminals detach on close by default (user report: "创建terminal关闭就没了，这是预期吗？")** — it WAS the documented default (`window.closeBehavior: terminate`), but it's the wrong default for plain shells: an agent session resumes from its transcript, a shell has nothing to resume — terminate destroys it irrecoverably. Now, until the user sets closeBehavior explicitly, shell terminals DETACH on window close (dtach keeps them alive, they stay in the sidebar's LIVE list, restarts don't kill them — tmux semantics) while agent sessions keep the terminate default. An explicit setting overrides both. New `SettingsManager.isSet()` distinguishes user-set from schema-default (get() can't). Automation helper terminals (Log in / Update) still always terminate. Verified e2e: open → close → session alive + listed → reattach works.

## 2.108.6 — 2026-07-11

**Robustness, phase 1 (user directive: "让后端稍微robust一点")**
- **Threadpool canary**: every 10s a stat() of the server's own package.json must round-trip through the libuv pool within 5s — the wedge class that took an instance down twice today is INVISIBLE to event-loop-lag metrics (the loop stays idle while the pool starves). Three consecutive breaches log loudly, record a `srv-threadpool-wedged` telemetry event, and kick the mount health sweep immediately instead of waiting its 60s timer. Detects ANY future pool-wedge cause, not just mounts.
- **K8s livenessProbe** (helm): a SUSTAINED unresponsive instance (up-but-wedged livelock — crash-restart never fires) now self-restarts after ~5min of failed probes. Deliberately generous: a restart kills in-pod dtach sessions, so only a truly dead instance trips it.

## 2.108.5 — 2026-07-11

**Self-mount guard (real incident: "test-share 打开就卡住")** — a VibeSpace bridge share minted by an instance and then imported back into the SAME instance mounts its own `/dav` through fuse: every file op becomes fuse → HTTP → the same node process → threadpool → waiting on fuse — a self-referential loop that deadlocks under a couple of concurrent ops. Bridge tokens are minted locally, so the check is trivial: a bearer token found in OUR OWN token store means the link points back at us. Refused in all three places with "open the shared folder directly instead": add, share-link import, and mount() of pre-existing records (the user's imported test share now shows the explanation instead of freezing).

## 2.108.4 — 2026-07-11

**Hung-mount defense, part 2 — close the pile-up window.** 2.108.3's watchdog reclaims a dead mount, but during the ~6s connect-probe window an open file-explorer window pointed at the mountpoint could still stuff the libuv threadpool with never-returning fs ops — the server then degraded for minutes while they drained (real follow-up incident: user clicked Connect on the unreachable-host mount, instance stalled again). Now:
- **Path circuit breaker**: the whole connect window (block before the fuse mount is spawned, release on probe pass) and any detected-hung mount root fail EVERY file-route op under them fast with 503 "storage is connecting or not responding" — verified: 8 concurrent listings against a dead mountpoint mid-connect all return in 0.0s, server stays at 1ms.
- **libuv threadpool 4 → 32** (`UV_THREADPOOL_SIZE`, set at the top of server.js): headroom so a handful of stragglers can't starve every async fs/dns op server-wide.

## 2.108.3 — 2026-07-11

**Hung-mount defense (real incident: the owner instance went unreachable)** — an SMB mount whose host only resolves on the user's home LAN stayed fuse-"mounted" while every IO on it hung; node's libuv threadpool filled with stuck fs ops, `/login` took 130s, the readiness probe (1s) failed and the pod dropped out of the Service. The main event loop was IDLE the whole time (`ep_poll`) — the threadpool was the choke point. Two defenses, both e2e-verified against a reproduced dead-SMB mount:
- **Post-mount IO probe** (`mount()`): after the fuse mount appears, list the mountpoint from a CHILD process with a 6s guard — a hang unmounts immediately, kills the rclone daemon, persists `desired: unmounted`, and reports "storage connected but IO hangs (host unreachable from this machine?)". An error exit (EIO) counts as responsive — only a stuck child trips it.
- **Health watchdog** (`startHealthWatchdog`, 60s + one sweep 15s after boot): covers mounts ADOPTED at boot (restore() skips mount()'s probe) and mounts that die later — same child-process probe, same auto-disconnect ("storage stopped responding … auto-disconnected to protect the server"). One bad mount can never take the server down again.
- Daemon teardown matches by exact `/proc/*/cmdline` argv (a wedged rclone survives lazy unmount and dial-retries forever; `pkill -f` can't safely quote arbitrary mountpoint paths).

## 2.108.2 — 2026-07-11

**Storage submounts — the "credential" concept dissolved (user directive after testing 2.108.0):**
- EVERY top-level storage row can now hold submounts (＋ on S3/rclone/Drive/SFTP rows — `remote:path` children under any connection, not just converted credentials). Children still resolve connection through the parent, so a token refresh heals all of them.
- Root-unmountable records (auto-detected bucket-scoped S3/R2 tokens) are now marked **credential-only with a key ICON in place of the status dot** — no text badge, and **no Connect action** (its root is known dead; submounts carry the mount state). The row shows the remote source instead of a meaningless local path.
- Auto-heal: if a credential-only record's token later CAN open the root (rescoped), the next mount attempt clears the flag.
- Submounts can't nest (clear error), duplicate (⧉) stays top-level-only.

**Instance image 3.2.0** (deploy): the instance user gets passwordless sudo (user request — in-terminal apt installs; rootfs is ephemeral, persistent setup belongs in `~/.vibespace-init.sh` which can now sudo). Live on the owner instance.

## 2.108.1 — 2026-07-11

Three long-open bugs fixed by parallel root-cause agents, each verified end-to-end in isolated instances:

- **Discovery misclaim with parallel same-cwd sessions** (real incident: 4 external sessions read as 5; killing one flagged the WRONG id stopped; resuming it collided with a live session): lock→JSONL claiming no longer trusts mtime. New shared pure `claimJsonls` (unit-tested, `scripts/test-claim-jsonls.mjs`): exact id → tail scan (a resumed session writes its CURRENT id into the ORIGINAL-named file; last-tail-id = current writer) → mtime only over no-evidence files (brand-new sessions). Local `/api/sessions` AND remote ssh discovery share it; a lock with no transcript yet lists under its own id instead of stealing one. Full 5263-session sweep: 780ms.
- **Externally-started remote sessions opened BLANK in chat mode**: the resume history fetch never passed `?host=`, so a remote transcript nothing had ever cached came back empty (VibeSpace-started sessions only worked because attach/view had warmed the cache). Every history consumer (resume load, pagination, turn map, search) now carries the host; `view-<uuid>` ids are no longer misparsed as `view-<backend>-…` (that broke remote View-History pagination/search); zero-message transcripts say so instead of rendering a silent blank pane.
- **Thinking runs never folded** ("只有Bash折叠了"): real thinking cards are structurally never adjacent — the adjacent pairs are EMPTY thinking stubs (redacted/zero-length; 1383 pairs in one real 442MB transcript), and those invisible stubs also broke Bash-run adjacency. New `chat.hideEmptyThinking` (default ON, instant toggle) hides empty thinking cards, and hidden cards (empty thinking, hidden hook cards) are now TRANSPARENT to run collapsing — they neither count nor break adjacency. Corrected the stale `collapseRuns` setting description.

## 2.108.0 — 2026-07-11

**Storage: credentials as first-class items (user request — the rclone `remote:path` model)**
- A **credential** is the remote before the colon (connection settings only); **mount points** nest under it as `remote:path` rows (↳ indented, key badge on the parent). One credential backs any number of mounts, and refreshing its token/keys heals all of them at once (children resolve connection through the parent at mount time).
- **Auto-detection**: mounting a pathless S3-family record whose token can't list the account root (bucket-scoped R2/S3 tokens — the FishR2 trap: fuse mount "succeeds", every IO returns EIO) probes first, converts the record to a credential, and says exactly what to do. A credential whose token CAN list root (Google Drive, account-wide keys) mounts normally — no artificial restriction.
- **AccessDenied with a path now fails fast with guidance** ("check the bucket name — S3 buckets are lowercase letters/digits/hyphens") instead of mounting a dead folder. Root-caused live: `Example_Prod_Data` is the display name; the actual bucket is `example-prod-data` (S3 names can't contain uppercase/underscores).
- New: `POST /api/mounts/:id/children`, `POST /api/mounts/:id/convert`; credential delete refused while mount points exist; export/import carries kind+parent links (re-linked by name on the target instance).
- **Full parameter editing for non-env mounts** (user directive: only env-provisioned connections are locked): every type's edit dialog now exposes ALL its connection fields — custom-rclone per-parameter rows (blank = keep, `-` = remove, add-new pair), Drive token/client, WebDAV/SFTP hosts+secrets. Server PATCH branches for sftp/webdav actually write the right fields now (they set unused keys before).
- **Google Drive re-authorization**: when Google reports `invalid_grant` (revoked/expired token — real case on a deployed instance), the error line and the edit dialog offer "Re-authorize Google Drive…" — the guided OAuth flow runs with the mount's own client creds and writes the fresh token back into the record (and its children), then reconnects. `POST /api/mounts/gdrive-auth/start {mountId}` + `POST /api/mounts/:id/drive-token`.
- Import-rclone-config dialog layout fix: `.dialog-body label` (0,1,1) crushed the remote checkbox rows into columns — same specificity clash class as `label.cfg-row`.

**Codex: duplicate assistant messages fixed (user report)**
- Newer Codex serializes the SAME assistant message differently in the wrapper buffer (`item_id`) vs the rollout JSONL (`id` + a metadata passthrough object) — the merge fingerprint missed the twins AND the normalizer's stream-key missed the in-place update, so every buffered assistant message rendered twice after attach/restart. Both layers fixed; verified on the reporter's real 2GB rollout (3 duplicated texts → 0).

## 2.107.1 — 2026-07-11

- **openSpec windows survive page refresh**: restoreState's typed branches ended at `browser` — settings/desktop/usage/task-detail/workflow windows silently VANISHED on reload (real report). A generic fallback now replays any saved openSpec (verified: settings window save→reload→restored).
- **Env-provisioned storage: connection locked** (user directive): endpoint/bucket/keys come from the deployment env (a change re-imports) — editing them in-app is refused server-side; name and MOUNT POINT are editable (custom mount point field added to the edit dialog for all mounts).

## 2.107.0 — 2026-07-11

**Storage: edit + derive (user request — a mis-pathed mount had no fix but delete/re-add)**
- ✎ **Edit** on every mount row: name, and per-type connection fields (S3 endpoint/bucket/prefix/keys with blank-keeps-secret; custom-rclone remote path — the FishR2-class fix; Drive folder). A connected mount reconnects with the new settings. Renaming is refused while a bridge share points into the mount (its chroot path would silently break).
- ⧉ **New mount from this connection**: same credentials, different bucket/path/prefix — one imported R2/S3 credential can back any number of mounts (PATCH /api/mounts/:id + POST /api/mounts/:id/duplicate).
- Env-provisioned "My storage" can no longer be deleted in-app (deployment-managed; a changed provisioning re-imports it) — edit/rename/unmount only, per user directive.

## 2.106.5 — 2026-07-11

- **Run collapse, tuned live with the user**: thinking + Bash fold as ONE mixed group; ANY Bash starts a fold immediately (single included, pending/running included — the bottom streaming indicator shows activity, and a running member adds "· running…" to the fold header); pure-thinking folds at ≥2; the newest-message exemption is gone. Fold headers carry the assistant color bar in border mode.
- **User vs assistant role bars distinguishable in every theme**: the user bar was `--accent` — TEAL by default, visually adjacent to the assistant's green (worse in green-accent themes, surfaced by the new theme chips). User bar is now blue.

## 2.106.4 — 2026-07-11

- **Remote tab broken on a fresh instance (real report: "remote 功能直接坏了")**: with ZERO sessions, the sidebar's no-sessions early-return fired before the mounts dispatch — the Remote tab rendered the Folders empty state ("+ New Session" / "No sessions") instead of machines+storage. Latent since the tab existed; invisible on any instance with sessions. The mounts branch now dispatches first (it doesn't depend on the session list at all).

## 2.106.3 — 2026-07-11

- **VIBESPACE_S3_* env import works on existing instances**: the one-shot `_envImported` flag burned on the very FIRST boot even with no env set, so a managed instance that gained the S3 env later (helm upgrade) never imported its personal storage. Import is now keyed by the env's endpoint|bucket|prefix SIGNATURE — set/changed env imports on next boot, a user-deleted mount stays deleted while the signature is unchanged.

## 2.106.2 — 2026-07-11

- **Remote session with NO account picked no longer fails on the default subscription (real report)**: resuming/creating on a remote host without specifying an account resolved the LOCAL default (a subscription) and died on the §ban-safety shipping gate. When the account came from the default (not an explicit pick) and could only reach the host by shipping subscription creds, the spawn now falls back to the HOST's own CLI login. An explicitly chosen subscription still errors with guidance; an opted-in shipSubscriptionToRemote still ships.
- **Regression fixes from 2.106.0/1 (both user-reported within the hour)**: (1) the wizard backend-card polish leaked into Manage Agents — `.ob-backend` is SHARED, and the unscoped nowrap/ellipsis blew the dialog open horizontally while the edit orphaned the row background/padding; original rule restored, polish scoped under `#welcome`. (2) Run-collapse didn't actually hide anything: `.chat-compact .chat-msg { display: block }` (compact is the DEFAULT) out-specified the bare `.chat-run-collapsed` — verified by COMPUTED display this time (9/9 none), not class presence.

## 2.106.1 — 2026-07-11

- **Sidebar scroll no longer breaks on refresh (real report)**: EVERY `_render()` now preserves the list scroll — broadcast-triggered re-renders (tasks-updated / session-status-updated / user-state-updated, fired constantly by agents' vibespace-task/status calls) used to reset it to top; only the 5s-poll digest path preserved it. A view change (tab / board sub-view / mobile drill-down) still resets deliberately.
- **Top bars no longer follow the bottom taskbar's drag-resize (real report)**: the adaptive size vars live on :root for cross-bar hosting — they're now pinned to defaults inside #toolbar and #toolbar-row2.
- **Taskbar sizing is recoverable (real report: "margin grows after one resize, never returns")**: the JS-derived size vars never matched the CSS defaults even at the same height, and nothing cleared the inline override. Double-click the resize handle to reset; a synced height at the CSS default is applied as a reset too.

## 2.106.0 — 2026-07-11

**Chat: TUI-style run collapse (new setting, default ON)**
- `chat.collapseRuns`: three or more consecutive thinking-only messages (or Bash tool cards) fold behind a clickable "N × …" line, like the Claude Code TUI. Decoration-only (a MutationObserver re-decorates on appends/edits/trims — nothing reparents, so virtual scroll/gap-seek/index mapping are untouched); the newest message never collapses (live progress stays visible); an open search bar expands everything (reveal must reach members); user-opened runs stay open across rebuilds (WeakSet by first member).
- `chat.reducedMotionSpin` (opt-in): keep the activity spinner ROTATING under prefers-reduced-motion instead of the default opacity pulse (the pulse read as "blinking" — user request).

**Onboarding**
- Log in / Install from the wizard no longer abandons the tour (real report: "clicking Log in skips onboarding") — the wizard PAUSES (not marked done) and a floating "↩ Back to setup" pill re-enters at the same step.
- Backend card layout polish: name+version ellipsize on one line, actions no longer squeeze.

**Settings window syncs across clients** (user request): it now carries an `openSpec` like every other window — persisted in the layout and replayed on other clients (was deliberately transient since 2.53.0).

**Deploy image**: Chromium launches in the container now (`/etc/chromium.d/99-container`: `--no-sandbox --disable-dev-shm-usage` — the sandbox can't work unprivileged and /dev/shm is tiny; acceptable in a single-user container).

## 2.105.2 — 2026-07-11

**Remote-host session blank on other clients (real report) — three cooperating fixes**
- ROOT CAUSE 1 (pollution): `syncSessionIdentity` and `captureState` wrote the WEBUI server id into `backendSessionId` whenever the CLI hadn't reported its real id yet — remote spawns stay in that state for a long time (the id only arrives via remote discovery). Other clients then re-resolved the openSpec against that bogus id, missed, and opened a BLANK view-only window. All three sites now refuse to bake a webui id (`match.sessionId === match.webuiId` guard).
- ROOT CAUSE 2 (race): a layout-sync replay can arrive BEFORE the receiving client's session list knows a just-created serverId — `replayOpenSpec` treated that as "session dead" and fell to viewSession-with-bogus-id. It now attaches directly by serverId (the server is authoritative; a genuinely dead session's attach errors into the read-only path anyway) and treats a bsid equal to the serverId (legacy polluted autosaves) as no bsid. Same legacy guard in `restoreState`.
- `hostId` now rides in attachSession openSpecs (create + attach + identity sync) and is threaded to the dead-session viewSession fallbacks, so a remote session's history view resolves over ssh after the session dies.
- Bonus (found reproducing): a REFUSED create (e.g. the remote subscription-shipping policy) left a permanently blank window with no feedback — the create handler now surfaces the server's error in the window + a toast.
- Verified by controlled repro: polluted spec + session-unknown race on a second client → was a blank viewOnly shell, now a live chat with input.

## 2.105.1 — 2026-07-11

- **First-terminal ugly font, the OTHER half (still reproduced on managed instances after 2.105.0)**: the font LIST builds asynchronously (queryLocalFonts + /api/fonts, which runs fc-list server-side — slow on a container's first call). A terminal created before it resolves fell back to bare `monospace` and KEPT it forever — the reported "switch fonts and it heals" is exactly that. A fallback-created terminal now upgrades to the real default the moment the list lands (atlas rebuild + refit + the 2.105.0 FOUT watcher re-armed for the new family). The 2.105.0 registration-polling half was verified on a true cleared-cache run: faces registered-but-unloaded at terminal open → poll → load() pulls the binaries → repaint.
- **Codex login is always `--device-auth`** (user directive): plain `codex login` starts a localhost:1455 callback server on the machine running the CLI — unreachable from the user's browser on remote hosts AND managed/container instances. Device auth (URL + one-time code) works everywhere; wizard + Manage Agents updated.

## 2.105.0 — 2026-07-11

**Terminal font FOUT: the real fix (registration polling)**
- 2.100.6's fix didn't survive a COLD-CACHE first visit (real report from a fresh managed instance): before the Google Fonts CSS itself loads, EVERY fonts API lies — `document.fonts.load(spec)` resolves empty immediately (no face registered), `fonts.ready` resolves early ("no loads pending" ≠ "my font arrived"), and `check(spec)` returns TRUE for an unregistered family (verified live — it only returns false for a registered-but-unloaded face). Both old triggers fired before the font existed.
- The one honest signal is REGISTRATION: the family appears in `document.fonts` only once its CSS has landed. `_refreshOnFontReady` now polls for that (500ms × 40), then `load()`s for real and rebuilds the texture atlas when faces actually deliver. Warm cache = zero work; system/local fonts = no repaint needed (first paint was already correct). Verified deterministically: late-injected font CSS → repaint 513ms after it lands; warm path → 0 spurious repaints.

**Onboarding: theme choice on step 0 (user request)**
- Theme chips (all 6 built-ins, with color dots) next to the language chips — applied LIVE via ThemeManager (per-device, like the ⚙ picker), the wizard itself recolors as immediate feedback.

**TEMPORARY: code-line overlap tracer**
- A long code-block line painting its wrapped continuation over itself (Chrome/mac, persistent, scroll doesn't heal; a fresh rebuild of the same card measures clean). `installOverlapTracer` (telemetry-client.js) samples visible code lines every 10s and ships one geometry+computed-style diagnostic when sibling rows overlap or a row paints taller than its box. Removed once diagnosed — same playbook as the 2.100.3 drag tracer.

## 2.104.1 — 2026-07-11

- Clerk login page: clerk-js v5 from the CDN self-bootstraps `window.Clerk` as an INSTANCE via the `data-clerk-publishable-key` script attribute — constructing it threw "window.Clerk is not a constructor" (real report from the first deployed test). The loader now sets the attribute and accepts both shapes.
- Deploy image: seed the PVC checkout with `git reset --hard $VIBESPACE_REF` instead of `git checkout` — a SHA ref left the seed (and thus every user's ~/vibespace) on a detached HEAD, breaking `git pull` self-update.

## 2.104.0 — 2026-07-11

**In-container desktop via integrated noVNC (deployment queue ④) — single login, no second password**
- New `desktop` window type: noVNC renders a LOCALHOST-bound VNC server through the cookie-authenticated `/api/vnc` WebSocket bridge (websockify semantics, backpressure-paused TCP). The ⚙ menu gains a **Desktop** entry only where a VNC stack exists (one startup probe).
- `src/vnc.js` VncManager: lazy lifecycle — nothing runs until the first desktop window POSTs `/api/vnc/start`; Xvnc + XFCE session spawn DETACHED so an app-only VibeSpace restart doesn't kill the desktop, and an already-listening port is ADOPTED (also the bring-your-own-VNC/KasmVNC path). `-localhost -SecurityTypes None` is safe because the cookie-authed bridge is the only route in.
- noVNC ships as a SEPARATE ESM bundle (`public/novnc.js`, dynamic-imported on first use) — it uses top-level await, which can't live in the IIFE main bundle; non-desktop users never download it.
- Deploy image: TigerVNC + XFCE + Chromium + Noto CJK fonts (lazy — zero cost for users who never open a desktop).
- **Fixed a latent WS bug found on the way**: `ws`'s `WebSocketServer({server, path:'/ws'})` upgrade listener `abortHandshake(400)`s EVERY non-matching upgrade — it had been silently killing `/proxy/` site WebSockets, and killed the VNC bridge on arrival. The main wss is now `noServer` and ONE upgrade dispatcher routes `/ws`, `/proxy/`, `/api/vnc` (each cookie-authed) and destroys the rest.
- Verified E2E locally (adopt path): status→start→bridge→RFB handshake→1280×800 framebuffer canvas, reconnect overlay, clipboard both ways wired.

## 2.103.0 — 2026-07-11

**Clerk SSO (deployment queue ③) — optional, env-gated, zero new dependencies**
- `VIBESPACE_CLERK_PUBLISHABLE_KEY` turns the login page into a dual-mode page: password form (when a password is set) + "Sign in with SSO" via Clerk's hosted UI (ClerkJS loaded from the Clerk frontend-API host derived from the publishable key). With no password set, Clerk alone enables auth.
- `POST /api/clerk-login`: verifies the Clerk session JWT against Clerk's JWKS (RS256 via pure node:crypto — kid lookup with rotation refetch, exp/nbf ±60s, issuer check, alg pinned), gates on `VIBESPACE_CLERK_ALLOWED_EMAILS` (comma list, `@domain` entries allow a domain, EMPTY rejects everyone — authn ≠ authz on a per-user instance), then issues the SAME cookie token as password login — middleware/WS/agent tokens all unchanged. No Clerk secret key needed anywhere.
- Already-signed-in-at-Clerk visitors are exchanged automatically on page load; a 403 (wrong account) offers a "Switch account" sign-out link. The email claim requirement (dashboard: session-token custom claims or a `vibespace` JWT template) is surfaced as an actionable error.
- `Auth` grew a `passwordEnabled` (vs `enabled`) split so Clerk-only instances behave: set-password needs no "current" when none exists, remove-password keeps auth on under Clerk, token store initializes without auth.json.
- Helm: `clerk.publishableKey/allowedEmails` values → env. Verified by unit tests (signature/expiry/issuer/alg-none/unknown-kid attack cases) + route-level E2E (Clerk-only 401 gate, exchange→cookie→authed, allowlist 403, missing-claim hint).

## 2.102.0 — 2026-07-11

**Onboarding for managed deployments (deployment queue ②)**
- Wizard step 0 gains language chips (Auto / English / 中文 / 日本語) — picking one reloads into that language; since `vs-onboarded` isn't set yet, the wizard re-enters in the picked language.
- One-click **Install** for a missing CLI: wizard step 1 and Manage Agents both show an Install button when a backend is `not installed` (claude → official native installer `curl …/install.sh | bash`, user-local ~/.local/bin, no root; codex → `npm install -g @openai/codex@latest`), run in a visible shell terminal like Log in/Update.
- Wizard step 2: when a password is already set (managed instances arrive with a preset env password), a **Change password…** button opens the standard password dialog so a new user can claim the instance with their own password.
- Deploy image: codex now pre-installed next to claude; the npm global tree is chown'd to `vibe` (root-owned /usr/local is why `npm i -g`/`claude update` EACCESed in-container); `~/.local/bin` on PATH (native-installer CLIs land on the PVC and survive image rebuilds).

## 2.101.0 — 2026-07-11

**Fleet telemetry: any instance can be the central collector (deployment queue ①)**
- New `POST /api/telemetry/ingest`: enabled only when `VIBESPACE_TELEMETRY_INGEST_TOKEN` is set (the shared Bearer token is both the on-switch and the gate, timing-safe compare; cookie-auth exempt — senders have no cookie). Forwarded batches land in per-month `central-YYYY-MM.ndjson` shards, each record stamped with the sender's anonymous instance id, original timestamps/versions preserved (clamped to a sane window). Same privacy model as local events: names/stacks/metrics only, never content.
- Forwarding now sends `Authorization: Bearer <token>` (new setting `telemetry.forwardToken`); `telemetry.forwardUrl`/`forwardToken` fall back to `VIBESPACE_TELEMETRY_FORWARD_URL`/`_TOKEN` env vars so a managed deployment configures the whole fleet via helm/compose without touching per-user settings (user setting still wins).
- ⚙ → Diagnostics report grows a **Fleet** section on a collector instance: per-instance events/errors/versions/last-seen table + errors grouped across instances (`GET /api/telemetry/central-summary`).
- Helm chart: new `telemetry.forwardUrl/forwardToken/ingestToken` values → env (tokens via the instance Secret).
- Verified E2E: forward→ingest with correct token lands (inst id + remote version + original ts preserved); wrong/missing token rejected; instance id sanitized.

**Terminal query-response junk (`^[]11;rgb:ffff/ffff/ffff^[[3;1R` echoed at the prompt — real report)**
- Root cause: with dtach every attached browser client is a full terminal emulator, so an app's terminal query (OSC 11 background color, `\e[6n` cursor position, DA…) was answered by EVERY attached client — the app consumes one answer and the tty ECHOES the extras as literal junk. Buffer replay on re-attach re-answered the stored queries the same way.
- Server fix (ws-handler `input`): pure query-response chunks are forwarded from ONE designated client only (the size owner, else the oldest attached) when >1 client is attached. Known accepted collision: modified-F3 (`\e[1;2R`) from a non-owner client in a multi-client session.
- Client fix (terminal.js + session-lifecycle.js): while restored buffer content replays, xterm.js's auto-answers to stored query sequences are dropped (`_replaying` flag) — they were answered live long ago.

## 2.100.6 — 2026-07-11

- Terminal font FOUT: on a fresh page load the web fonts (Fira Code etc.) can finish loading AFTER the terminal's first paint, which already cached the fallback glyph in the WebGL texture atlas — so the terminal stayed on an ugly fallback font until a manual font switch rebuilt the atlas (real report: "ugly until I switch fonts a few times"). `_refreshOnFontReady` now explicitly `document.fonts.load()`s the configured family + awaits `document.fonts.ready`, then `clearTextureAtlas()` + refits (with a settle pass) so the terminal repaints in the real font automatically.

## 2.100.5 — 2026-07-11

- Chat links: a local filesystem path opened as an http URL. A **markdown link to a local file** (`[doc](/home/x/y.md)` → `<a href="/home/x/y.md">`) reached the click handler as a URL and `window.open('/home/…')` made the browser resolve it to `http://<host>/home/…`. Now any link whose href is an absolute (`/…`) or home (`~/…`) path that isn't a real URL scheme is reclassified as a file path and opens in the file viewer (centralized in `_linkTargets`, so Open/Copy labels are right too). Bare (non-markdown) absolute paths already classified correctly — this covers the markdown-link case.

## 2.100.4 — 2026-07-11

- Removed the temporary drag tracer (2.100.3's coordinate-space fix confirmed by the user). The viewport→workspace conversion invariant is documented in CLAUDE.md for future drag code.

## 2.100.3 — 2026-07-11

**Drag drift: the REAL fix (coordinate-space mixup, diagnosed from a live trace)**
- 2.100.2's stale-dx fix was correct but not the reported bug. A temporary drag tracer (frames shipped via telemetry from the user's own drag) showed the tracking math was perfect — in the wrong coordinate space: every "center on cursor" re-anchor wrote **viewport** `e.clientX/Y` into **workspace-relative** `style.left/top`. With the sidebar open the window landed a full sidebar-width (~260px) away from the pointer the instant it left its snap, then tracked parallel at that offset — invisible with the sidebar closed, which is why it survived so long.
- Fixed by converting the cursor into workspace space at all seven re-anchor sites: window.js un-snap, un-maximize, merge-ghost leave, desktop-preview leave; tab-group.js tab detach, cursor-follow, merge-leave (tab drag-out had the same parallel-offset bug).
- The diagnostic tracer stays in this build for one confirmation round (snapped/maximized drags only, auto-ships frames on mouseup); removed next release.

## 2.100.2 — 2026-07-11

**Desktop-preview staleness + snapped-window drag drift**
- **Blank preview after switching desktops** (report): lazy-replayed windows get their `gridBounds` from async capture timers AFTER the switcher's last render, and nothing re-rendered it — the newly active desktop's preview stayed white until the next unrelated interaction. `switchTo` now schedules digest-invalidating refreshes (+400ms/+1300ms); verified across a full 3-desktop round trip.
- **Preview rect frozen mid-drag after re-snapping to the same zone** (report): the drag path live-mutates the active preview's rects DIRECTLY, which the switcher's change-digest cannot see — a drag ending on identical bounds skipped the rebuild and the stale rect persisted forever. Every `_captureGridBounds` (drag end, snap timers, resize, applyLayout) now triggers a debounced digest-invalidating `refreshSwitcher()`.
- **Snapped window drifting away from the pointer while dragged** (report): `processMove` computed the drag delta against `startX` BEFORE the un-snap branch re-anchored `initL/startX` mid-frame, then applied the stale delta on top of the new anchor — the window rode at a constant offset equal to the pointer's first-frame sweep (large under rAF coalescing). Position now derives from the current anchor at application time; the un-maximize drag path had the same defect and is fixed by the same line.

## 2.100.1 — 2026-07-11

**Backup & migrate dialog layout fixed**
- The section checkboxes rendered ABOVE their labels (one tall stack per row, endless scrolling — real report): `.dialog-body label`'s `flex-direction: column` out-ranked `.cfg-row` by specificity. Rows are `label.cfg-row` flex-row now, laid out in a **two-column grid** (one column on phones) — the whole dialog fits without scrolling.
- Phone: `createModalShell`'s wide-variant inline `min-width: 440px` overflowed 390px screens past the `width: 95vw` clamp (width and min-width are separate properties) — the mobile dialog rule now forces `min-width: 0 !important`, fixing every wide modal on phones.

## 2.100.0 — 2026-07-11

**Config export covers everything recent (centralized-deployment migration review)**
- Reviewed every store the recent feature era added against Backup & migrate. Already covered (settings section): dashboard panels, agent instructions, stop-nudge thresholds, telemetry toggles, per-session billing configs (userState). Fixed the gaps:
- **Billing accounts now export/import** (sensitive, passphrase-encrypted): API keys are decrypted out of the machine-local store for transport and re-encrypted under the TARGET machine's own key on import; each Claude subscription's creds dir (`.credentials.json`/`.claude.json`) and each Codex account's `auth.json` travel as whitelisted files, recreated 0700/0600 with the codex shared-home symlinks reseeded. Existing ids are never clobbered; defaults carry over only if unset locally. Verified end-to-end on an isolated instance: both subscriptions arrive `loggedIn:true` with correct identities; wrong passphrase rejected.
- **Task Groups were silently unexportable** — the server supported the section since 2.53.0 but the export dialog never had the row, and the import dialog's label map skipped unknown sections. Both fixed (checklists + activity logs + context-dir config ride along).
- **Usage pricing table** (model rates + per-account discounts) is a new export section.
- **clientPrefs** now include language, usage-view account choices, quota-refresh ack and the onboarding flag (gather + import write-back share one key list).
- NOT in the config file by design: the usage **ledger** (data/usage-history/, ~80MB — copy the directory during migration to keep analytics history), session statuses & the For-you inbox (runtime state), caches (usage-cache, remote-jsonl, codex-models-seen).

## 2.99.3 — 2026-07-11

**Dashboard split-series panels (two-dimensional analysis: day × account etc.)**
- A panel can now cross its main dimension with a second one: the editor's new **“Split series by”** select turns a line chart into one line per split key and a bar chart into **stacked bars** — `总 tokens · 按天 × 账号` (per-account daily token burn, the motivating ask), cost per day per model, requests per hour per project, whatever combination. Top-6 split keys by volume keep their own series, the tail folds into “Other”; account/session keys resolve to their display names.
- Server side: `UsageHistory.aggregate` accepts `pivots` (pairs of dimension keys) and returns `pivots['a:b']` rows whose cells carry the same finalized bucket shape as group rows — one pass over the event cache, no extra scans. `GET /api/usage-stats?pivot=day:account,day:model` (validated, ≤6 crosses).
- The window's single fetch requests exactly the pivots the saved panels need (`panelPivots`); an edit or preset that introduces a new cross refetches instead of rendering a hole. The **Account reconciliation preset** now leads with day×account stacked tokens + day×account cost lines.
- Chart.js gotcha fixed in the process: datasets not bound to a configured scale (`yAxisID`) make Chart.js mint a phantom default axis alongside the real one.

## 2.99.2 — 2026-07-11

**Mobile navigation coherence + usage window horizontal-scrollbar elimination**
- **Sidebar now auto-yields on mobile whenever a window opens or gets focused** (real report: card menu → Properties looked like a no-op — the window landed BEHIND the full-screen sidebar overlay). Centralized in `wm.createWindow`/`wm.focusWindow` (`_mobileYieldSidebar`, guarded by `layoutManager._restoring` so boot restore / remote layout-sync never yank the sidebar mid-browse) instead of per-call-site patches — covers Properties, task detail/log, file explorer, View History, viewers, cross-desktop Go-to-window, everything. `_showDialog` closes it too (the `#dialog-overlay` dialogs sit below the sidebar; fork/new-session had per-site patches, now central). Audited the rest: utils dialogs (z 99998) and context menus/popovers (z 99999) already render above the sidebar (z 90000) — no change needed.
- **Mobile window-switcher billing chip no longer strands its menu** (report: tapping the chip closed the window list, leaving the switcher menu floating context-less). The list now stays open underneath — its outside-tap close follows the app's chained-popover rule (taps inside `[data-popover]` / dialogs are child interactions, not dismissals).
- **Usage window: horizontal scrollbars eliminated across sizes** (report: adaptivity was still insufficient). The whole class of blowouts was grid items' default `min-width:auto`: `.udash-grid` tracks are now `minmax(0,1fr)`, panels are `min-width:0` + `container-type:inline-size` (content can never dictate panel width), stat numbers scale with the panel (`font-size: clamp(14px,10cqw,30px)`), tables scroll inside their panel body, `.usage-seg` segments wrap, classic view's `minmax(340px,…)` floors at `min(340px,100%)`, and `.usage-body` is `overflow-x:hidden` as the final guarantee. Verified zero overflow at 420–1100px in both dashboard and classic views.

## 2.99.1 — 2026-07-11

**Current-session billing switcher on mobile + dashboard window-width adaptivity**
- **切换当前会话的 sub**: mobile windows have no title bars, so the desktop's identity badge (the current-session switch entry) simply didn't exist there. Two stand-ins: a **billing chip in the chat status bar** (account name pill next to model/effort, mobile-only — desktop keeps the title-bar badge; fed by the same `syncSessionIdentity` broadcast, click → the switcher menu) and a **billing chip on every mobile window-switcher row** (tap title → each session window shows its account; tap chip → switcher).
- **Usage dashboard now adapts to the WINDOW's width, not the screen's** — `.usage-body` is a `container-type: inline-size` container and the panel grid folds to one column under 700px container width, so a narrow usage window on a wide desktop reflows too (Chart.js re-fits via its own ResizeObserver). The phone media query stays as a no-container-query fallback.

## 2.99.0 — 2026-07-10

**Mobile adaptation of the recent feature batch (usage, quota, multi-account)**
- **Mobile nav gained two entry points** the phone never had (the taskbar — quota pies, inbox, gear — is hidden ≤768px): a **⚙ gear** opening the full gs-menu (Usage window, Manage agents, Diagnostics report, Settings, Backup…) and a **worst-of quota donut chip** (max utilization across all Claude/Codex buckets, usual green/amber/red coloring) opening the usage popup — 剩余用量 + the per-account switcher chips now fully reachable on phones.
- Usage popup + global-settings popover render as full-width sheets under the nav bar on phones (stylesheet `!important` clamps deliberately beat the JS anchor's inline position).
- **Usage dashboard: one panel per row on phones** — the 2-col grid pushed the right column off a 390px screen. Also fixed `.udash-add` forcing an implicit second grid track via `grid-column: span 2` (→ `1 / -1`, correct at any column count), which kept the whole grid at 712px even in 1-col mode.
- **Billing switcher from the session card context menu** (right-click / long-press → “Switch billing…”): `showBillingSwitcher` now accepts a session object + `{x,y}` anchor — no window needed, which is what phones require (no title bars → no identity badge). A stopped session's “current” account is its saved on-resume config. Desktop badge path unchanged.
- Verified on a 390×844 viewport: task-log viewer, Manage Agents dialog (account rosters + donuts), and the Diagnostics report already render well full-screen — no changes needed there.

## 2.98.0 — 2026-07-10

**Dashboard: ONE chart engine for everything (Chart.js v4, modular)**
- Replaced uPlot + homegrown bars/donut with Chart.js across all chart types — line, bar and doughnut now share ONE interaction model: hover tooltips with per-metric formatting, clickable legends (toggle series), subtle animations, uniform theming from CSS tokens. uPlot removed (it can't do donuts; two chart engines was the inconsistency being complained about). Modular registration keeps the cost at ~150KB.
- Bars auto-orient: sequential dimensions (hour/weekday/day) render vertical, categorical (model/account/project) horizontal; multi-metric bars get per-unit dual axes like lines.
- Chart lifecycle managed: instances destroyed before every re-render and on window close (Chart.js keeps a global registry + per-chart ResizeObserver — undisposed instances leak).
- Fixed a black-charts regression: color resolution probed computed styles in a detached DOM tree — panels now attach to the document before charts render.
- **Richer presets** (5 now): Cost overview (8 panels incl. hour-of-day cost), Token throughput (cache read/write/fresh-input grouped bars, hit-ratio+requests dual line), Account reconciliation (multi-metric table + grouped bars), Time patterns, NEW Model comparison (cost/requests donuts + 4-metric table + output-vs-input bars).

## 2.97.0 — 2026-07-10

**Dashboard: multi-metric panels on uPlot**
- Adopted uPlot (~50KB, the time-series engine Grafana's ecosystem uses) for line charts — the one place a focused library beats hand-rolled canvas. Donut/bars/stat/table stay dependency-free.
- A panel now takes MULTIPLE metrics (`metrics: []`, editor = checkbox grid; old single-metric configs migrate transparently): line charts render one series per metric with **automatic dual axes by unit** (cost $ left, requests count right — mixing units Just Works), live legend with hover readouts and per-series toggling, and resize-aware fitting.
- Grouped bar rows (per-metric bars normalized to their own max + mini legend), stat panels render a row of big numbers, tables use the selected metrics as columns. Default presets show it off (cost+requests dual-axis trend; total+output tokens).

## 2.96.0 — 2026-07-10

**Usage window: configurable panel dashboard (Grafana/Posthog-style)**
- A panel = METRIC × DIMENSION × CHART: 9 metrics (est. cost, requests, total/output/fresh-input/cache-read/cache-write tokens, cache hit ratio, sessions) × 11 dimensions (total, day, model, account, billing, project, mode, host, hour, weekday, session) × 5 chart types (big-number stat, bar rows, line, donut, table). All panels feed off the single existing /api/usage-stats fetch.
- Per-panel ✎ editor (metric/dimension/chart/top-N/width) and ⋯ menu (move, half/full width, remove); "+ Add panel"; four presets (Cost overview / Token throughput / Account reconciliation / Time patterns) under the Panels… menu; the pre-2.96 fixed layout survives as "Classic view".
- Layout persists in settings (`usage.dashboard`) → synced across clients like all settings. Charts are dependency-free (canvas line, conic-gradient donut, DOM bar rows) and fully theme-tokened.

## 2.95.0 — 2026-07-10

**Telemetry: full observation-point sweep**
- Client: `ws-outage-ms` (per reconnect — verified capturing a real 9.7s restart outage), `gap-slab-load-ms` (huge-session scroll slabs, both directions), `history-render-ms` (chat attach render), `chat-search-ms` (streaming full-file search), `session-create-roundtrip-ms` (create → created), `upload-mbps` (>1MB uploads).
- Server 5-min sampler additions: `srv-ws-clients`, `srv-subagent-watchers` + `srv-normalizer-msgs` + `srv-buffer-files` (leak canaries for the exact classes the 2.81–2.91 audits kept finding), rolling HTTP window (`srv-http-reqs-5min` / `avg-ms` / `max-ms`) with slow-request events (>1.5s, route sanitized to 3 path segments — user paths never enter the ledger), `srv-usage-scan-ms`, and `srv-jsonl-parse-ms` (slow tail re-parses >200ms, via a zero-coupling global hook).
- First real finding on day one: the server event loop blocks for seconds during boot (restoreSessions' synchronous scans) — now measured instead of anecdotal.

## 2.94.0 — 2026-07-10

**Telemetry: performance metrics**
- Client (passive, numbers-only): `boot-to-ready-ms` (nav start → workspace restored), `js-heap-mb` + `dom-nodes` + `open-windows` sampled at +30s then every 10 min (the long-lived-tab leak signals), and long-task jank aggregated per minute (`longtask-count/max/total`) via PerformanceObserver. Metrics have their own 500-sample budget so periodic sampling can't eat the error cap.
- Server: `srv-rss-mb` / `srv-heap-mb` / `srv-evloop-max-lag-ms` (1s-probe max drift) / `srv-live-sessions` every 5 min.
- Diagnostics report gains a Performance metrics table: n / p50 / p95 / max / latest per metric. Aggregation lives in `Telemetry.summary()` (`kind:'metric'` records carry a numeric `value`).

## 2.93.0 — 2026-07-10

**File-split backlog closed — every named split landed**
- server.js → src/agent-routes.js (`setupAgentRoutes`, 375 lines: user-todo / session-status / task-context / prompt-context / stop-check / task CRUD endpoints + injection helpers) on top of 2.92.0's usage-cluster split; server.js 3306 → 2578 lines.
- file-explorer.js → file-explorer-uploads.js (upload popover/batches/history/ring) + file-explorer-ops.js (context/background menus, clipboard, rename/delete/duplicate, archive ops, properties); 1668 → 1113 lines.
- app.js → setup-flows.js (onboarding wizard, Backup & migrate, password dialogs, diagnostics report); 2082 → 1817 lines.
- Every extraction verified with the free-identifier lint (eslint no-undef) + a live boot/dialog smoke — the class of silent boot crash that bit the 2.82.0 and 2.92.0 splits (esbuild and node --check both pass free identifiers).

## 2.92.0 — 2026-07-10

**Design-audit backlog: ALL six deferred items closed**
- Full i18n for the file explorer, file/hex viewers and the workflow detail window (+171 keys, zh/ja complete, params/orphans audited; `tc('table','Columns')` disambiguates table columns from grid column count).
- Menu-label casing standardized (review menu Title Case → sentence case; `Custom...` unified to `Custom…` everywhere; dictionary keys migrated in lockstep).
- Modal shells deduplicated: one `createModalShell` helper in utils.js now backs 8 formerly hand-rolled overlays (−62 lines; per-site close-lifecycle side effects preserved; deliberately NOT data-popover — the global Escape blind-remove would skip onClose side effects).
- path-autocomplete dedup verified already done (stale backlog entry — all 7 consumers route through setupDirAutocomplete).
- CSV/XLSX/PPTX viewers restyled from inline styles onto viewers.css classes with theme tokens (virtual-scroll offsets/slide transforms stay inline — genuinely dynamic); CodeMirror light theme accent-derived via color-mix into light surfaces.

**Splits (perf backlog, part 2)**
- chat-view.js gap-seek machinery (17 methods, ~390 lines) → src/lib/chat-view-seek.js prototype mixin.
- server.js usage/rate-limit cluster (536 lines) → src/usage-routes.js setupUsage() (verified with a stub-eval harness after two free-identifier boot crashes — esbuild/node --check don't catch those).

**Fixes**
- Telemetry-captured gap-seek crash: `_extendTop`'s insertion anchor used a bare `.chat-msg` selector that can match a NESTED element → NotFoundError; now `:scope >` + validated fragment insert.

## 2.91.0 — 2026-07-10

**Audit round-3: all 10 remaining verified findings landed** (each adversarially verified against real data before fixing)
- Server: `_lastAttrib` capped (cap-only — delete-on-kill would re-append duplicate attribution lines on resume); remote-transcript cache cleaned on host removal + 30-day boot sweep for orphans; rclone mount logs drop to NOTICE (the INFO vfs heartbeat grew logs unrotated for weeks and polluted the failure diagnostic tail).
- Leaks: host-bootstrap dialog's ws handler (TDZ + orphan-removal path, now self-unregistering); CodeEditor's document-level theme MutationObserver (now tied to the window's abort signal — the onClose chain missed closes during the initial async load); Google-Drive OAuth token poll dies with its dialog instead of running 10 more minutes.
- Hot paths: chat minimap visible-range scan breaks at the viewport edge and resumes from the last frame's index (was getBoundingClientRect on EVERY rendered message per scroll frame); taskbar Move mode is rAF-coalesced like every other drag path; sidebar merge builds a webui Map once instead of an Array.find per system session (O(n×m) on 5000-entry lists per 5s poll); minimap live-turn append is incremental (was a full marker rebuild per message).

## 2.90.1 — 2026-07-10

- Layout-sync hardening: the user-dirty send gate now EXPIRES 60s after the last real input. A client whose dirty bit stuck (an idle tab left open, a stray automation client) used to echo STALE window positions after every remote apply — reverting other clients' fresh drags and replaying old layouts after drag end (observed as "multi-client sync broken: drags don't propagate, then old drags replay"). The echo carries a fresh seq, so the anti-ping-pong seq guard can't catch it; expiring the dirty bit closes the hole at the source.

## 2.90.0 — 2026-07-10

**Deleting the active desktop no longer wipes the adjacent desktop's layout (real report)**
- `deleteDesktop` on the active desktop hand-rolled its switch: it only un-hid windows already IN THE DOM. A target desktop never visited since page load keeps its windows only in saved state (they lazy-replay on first `switchTo`) — so it presented EMPTY, and the closing autosave then persisted that emptiness over the target's real layout. Repro: create a desktop → switch to it → delete it → the previously-last desktop's layout wiped (and its taskbar preview went blank). The delete now runs the FULL `switchTo` pipeline (lazy window replay + grid restore), waits out an in-flight switch (whose re-entry guard would otherwise leave the active pointer on a deleted desktop), and falls back to the old path only if the switch bails.

## 2.89.3 — 2026-07-10

- Manage Agents → Agent instructions is now a collapsed-by-default advanced section grouped with the VibeSpace integration row (summary shows "customized" when any field is set). Layout redone: labelled field per injection surface, and the stop-nudge conditions read as complete sentences with the number inputs embedded inline (they used to wrap one word per line).

## 2.89.2 — 2026-07-10

**THE restart history-truncation bug (root cause of "重启之后消息都没了")**
- A 2.80.0 typo in the hook-card normalizer (`output` instead of `raw.output`, message-manager.js) threw a ReferenceError on EVERY `system/hook_response` record. The live path swallowed it per-line, and hook_response exists only in the stdout buffer (never in the JSONL), so it hid for 9 releases — but the attach-time HISTORY REBUILD after a server restart crashed at the first buffered hook record, amputating everything after it: later replies missing, stale user message pinned at the end, pending tool cards gone. Adversarially root-caused with an offline reproduction over the affected session's real data (3,946 messages restored vs 3,883 truncated).
- Hardening so this class can't recur: `convertHistory` isolates each record (a malformed record skips, never amputates), and `_historyLoaded` is set only AFTER a successful rebuild (set-before-work turned one crash into a permanently truncated view because re-attaches skipped the rebuild).

## 2.89.1 — 2026-07-10

**Restart data-loss hardening (real incident chain)**
- The 30s-post-boot orphan sweep (2.83.0) keyed on activeSessions — a live dtach session the restore didn't re-adopt in time had its buffer UNLINKED while the wrapper kept writing the deleted inode: live streaming looked fine, but every later restart rebuilt history without the buffer. Sweep is now AGE-BASED (only files untouched for 7 days; dead buffers stop being written, so age is race-free by construction).
- Session-meta tombstones: teardown deletes the meta, but debounced/straggler writers could fire after the delete and resurrect the file from a partial object — sockNames are unique per spawn, so writes to a tombstoned name are now dropped.

## 2.89.0 — 2026-07-10

- **Stop-nudge firing conditions configurable**: `agents.stopNudgeStaleMinutes` (default 10, clamp 1–240) and `agents.stopNudgeCooldownMinutes` (default 30, clamp 2–720) — editable inline next to the stop-nudge text in Manage Agents → Agent instructions, and in Settings.
- Tab groups no longer show a stray "global" billing badge left of the tabs (the host's pre-merge standalone badge survived the merge); badges now live ONLY on tab items while grouped, and the last remaining window gets its standalone badge back immediately when a group dissolves.

## 2.88.1 — 2026-07-10

- Billing badges on tabbed windows: tab-bar rebuilds (switch/merge/detach/drag) destroyed the badge span while the identity-keyed no-op guard prevented re-insertion until the billing identity changed — badges randomly vanished on grouped windows. The guard is now self-healing (verifies the badge actually exists before skipping), tab-bar renders re-apply all tabs' badges immediately, and a detached window's standalone title bar gets its badge back.

## 2.88.0 — 2026-07-10

**Mid-turn user messages no longer vanish from history (real data-visibility loss)**
- Messages sent while the agent is working are recorded in the JSONL ONLY as `queued_command` attachments — never as user records. The normalizer dropped every non-hook attachment, so any history rebuilt from the JSONL (server restart, resume under another account, view-only) silently ERASED the user's own words — 211 records in one real session. Now rendered as normal user messages (typed-flagged, echo-deduped against the live buffer copy).

**Per-hook agent instruction customization (Manage Agents → Agent instructions)**
- The single preamble box is now three fields, one per injection surface, each with its own cadence and cost profile: **Session context** (once per session + on edit, ≤4000), **Per-turn reminder** (rides at the very top of EVERY prompt — even on prompts that carry a bigger delivery, and even with the standard tool reminder off; ≤500), **Stop nudge** (prepended to the end-of-turn bookkeeping reminder; ≤500). Settings keys: `agents.injectPreamble` / `agents.perTurnExtra` / `agents.stopNudgeExtra`.

## 2.87.0 — 2026-07-10

**Server-side settings reads were ALL broken (real config bug)**
- 9 server code paths read settings via `getSyncStore('settings')` — the dormant, EMPTY migration-target store — instead of data/settings.json where /api/settings actually persists. Every server-honored setting silently behaved as its default no matter what you configured: `accounts.onDemandQuotaRefresh` (off/auto modes never applied), `accounts.activeUsagePolling`, `accounts.shipSubscriptionToRemote` (could never be enabled), `agents.perTurnToolReminder` / `agents.stopBookkeepingNudge` (couldn't be turned off), `telemetry.enabled` / `telemetry.forwardUrl`, `chat.hideEmptyHooks`. New `serverSetting()` reads the real store (persistence.js exposes its cached `readSettings`); all sites migrated and E2E-verified.

**Custom agent instructions (Manage Agents → Agent instructions)**
- A user-configured preamble injected at the TOP of every VibeSpace hook delivery (`<vibespace-user-instructions>` block) — customize fleet-wide agent behavior (reply language, house rules). Delivered once per session and re-delivered when edited (sha-gated), never per turn. Textarea in Manage Agents; also a Settings entry (`agents.injectPreamble`, ≤4000 chars). Works for claude (SessionStart) and codex (prompt-context) alike.

**Fixes**
- Billing switch / resume no longer teleports the conversation into a default centered window: the old window's geometry (bounds, pre-snap size, maximized) is snapshotted before kill and applied to the resumed window; plain resume of a terminated read-only window inherits its geometry the same way.
- A user message that happens to START with hook-ish text (e.g. pasting "Stop hook feedback: …") is no longer misclassified as a dim notification card: provenance now beats text shape (CLI's promptSource marker / our _fromWebui flag → real user message; isSynthetic → notification).
- Stop-hook block reasons and other tagged notifications were hard-truncated at 80 chars with no way to read the rest — now full text behind the expander (generic Stop hook feedback gets its own labeled card).
- Perf (audit round 3, adversarially verified): subagent fs.watch handles + double-buffered transcripts leaked for agents that never emit task_notification (interrupted turn / CLI death) — 10-min inactivity sweep at turn end; /api/usage codex fallback no longer walks the entire ~/.codex/sessions tree every 30s (date-pruned to 14 days) and the session-meta account map is TTL-cached 60s.

## 2.86.0 — 2026-07-10

**Checklist items get the summary+detail split (matching Activity entries, 2.69.0)**
- A checklist item now carries an optional `detail` (≤6000 chars: acceptance criteria, paths, background) next to its one-line text — no more cramming full context into one line.
- Log viewer checklist tab: items with detail expand in place (†), every item has ✎ **inline edit** (text + detail) and the add-row has a † toggle for attaching detail to new items; attribution tooltips show full timestamps; markdown export includes details as blockquotes.
- End-to-end: `vibespace-task plan-add "text" --detail "..."`; `show` marks † and `show --full` prints them; TASK.md renders details as blockquotes; the injected context stays dense († marker only, budget-safe) and teaches agents to read details via `show --full` before picking an item up; repo export/import round-trips details.
- task-detail compact editor: † on detailed items expands in place (full editing lives in the ⧉ viewer).

## 2.85.0 — 2026-07-10

**Task Group log viewer (Checklist + Activity outgrow the detail editor)**
- New full-window viewer (`src/lib/task-log.js`, window type task, openSpec `openTaskLog`): two tabs — **Checklist** (open/done sections, write-through checkboxes, add/delete) and **Activity log** (all entries newest-first, grouped by day with per-day counts, † details expand inline). Text search, per-session filter dropdown, "Copy as Markdown" of the current filtered view.
- **Session attribution everywhere**: activity rows show the filing session as a chip (resolved to its display name; click a chip to filter to that session); checklist items now record who queued them (`addedBy`/`addedAt` — agent session key or `user` for UI adds) and who ticked them (`by` existed, `doneAt` new). Older items simply have no chips.
- Entry points: ⧉ buttons on the Checklist and Activity sections in task-detail, and "Checklist & activity…" in the board header context menu.

## 2.84.0 — 2026-07-10

**Observability (for team rollout iteration)**
- Local-first telemetry: client global error capture (window.onerror / unhandledrejection / App-constructor boot crashes — installed BEFORE App so the "silent blank page" class is caught), coarse feature events (window opened, session created — names only, never content), server fatals. Appends to `data/telemetry/events-YYYY-MM.ndjson`; nothing leaves the instance unless `telemetry.forwardUrl` is set (team deployments: batches POST with an anonymous per-instance id).
- ⚙ → Diagnostics report…: grouped recent errors (with stacks), events/day chart, by-event and by-version tables — rendered in the embedded browser.
- Settings: `telemetry.enabled` (default on, local-only), `telemetry.forwardUrl` (default empty).

**Usage ledger attribution fix (real data bug)**
- A newly added subscription showed usage from BEFORE it was registered: `_acctAt`'s "request predates the first attribution entry" fallback billed pre-binding history to the account's earliest entry, and the meta-account fallback did the same for the initial backfill (the ledger shipped 2.61.0 and scanned week-old transcripts AFTER accounts were attached). Fixed: pre-binding requests → global (10-min grace for spawn-ordering skew); one-time rebake re-attributed 20,304 baked events (94% of one account's total was misattributed).

**Fixes**
- Embedded browser: `blob:`/`data:` URLs no longer get an `http://` prefix (blank iframe) — this had silently broken the chat html Preview button too.

All notable changes to this project will be documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project uses [Semantic Versioning](https://semver.org/).

## [2.83.0] — 2026-07-10

### Performance — audit round 2 (6 agents: server + cross lanes, 4 verifications)
Server, weeks-uptime class:
- Killed sessions leaked every subagent fs.watch/retry-timer/normalizer (the
  kill path deleted the session before onExit's teardown could run — teardown
  now runs inside the kill case); completed agents' buffered messages are
  freed 60s after task_notification (previously retained twice, unbounded).
- Codex sessions were renamed on EVERY tool call (function_call payload.name
  is the tool name) — two sync meta writes + two broadcasts each, forever.
  Names now come only from session_meta/wrapper_meta.
- /api/sessions: cache TTL 2s→4.5s (every 5s poll used to miss), per-session
  blocking pgrep now 15s-cached, codex /proc fd-walk 10s-cached. Measured:
  0.36s sweep → 0.011s cached poll.
- Unbounded maps capped: _lastAttrib, _sessionMetaCache, _realCwdCache.
Client, days-uptime class:
- Live pinned chats now trim their DOM (verified: trim previously ran only on
  pagination — a streaming chat open for days grew without bound).
- Desktop switcher no longer rebuilds all previews on every window
  mousedown/focus/blink (digest guard); Session Properties debounces its
  full re-render off the 5s broadcast storm; sidebar text filter debounced;
  session-status broadcasts skip identical snapshots; workflow-detail and
  read-only-view polls back off while the tab is hidden; usage pies/popup
  skip identical HTML; syncSessionIdentity indexes sessions once per merge;
  language-picker list memoized; terminal fit-timer/paste-pad cleaned on
  dispose; onboarding keydown released on finish; taskbar hotzone listeners
  no longer stack; fork/create pending-name maps cleaned on window close;
  subagent viewer attach handler self-guards (documented invariant).

## [2.82.0] — 2026-07-10

### Refactor — app.js split into prototype mixins (3,861 → 2,045 lines)
Three cohesive clusters extracted verbatim (AST-based, acorn) into
install-mixins following the existing sidebar-*.js pattern: manage-agents.js
(accounts dialog/rosters/wizard), usage-meter.js (quota pies + popup +
on-demand refresh), session-lifecycle.js (create/attach/resume/fork/view/kill
+ billing switcher + openSpec replay). Zero call-site changes — everything
still runs as App methods. Smoke-verified live: window restore, badges,
usage popup, shell terminal create/close, Manage Agents rosters.

## [2.81.0] — 2026-07-10

### Performance — long-session leak fixes (multi-agent audit, round 1)
- FileExplorer gained a real dispose(): its ws handler + ResizeObserver +
  in-flight upload XHRs used to outlive the window and pin the whole instance
  (detached DOM included) forever. Verified: handler count returns to baseline
  on close.
- Terminal scroll-up output queue is capped (4MB→keep 2MB): a busy agent left
  unpinned for hours grew one giant string toward hundreds of MB that xterm
  discarded at repin anyway.
- Upload history pruned to the newest 100 entries (grew forever, synced to
  every client on every load).
- Server: session buffer/wrapper-meta files now unlink on real teardown + a
  boot sweep removes orphans (193 files / 28MB swept on first run).

### Added — running workflows visible in the chat status bar
Dynamic-workflow launches show a live chip (name + done/agents, 8s poll while
running) in the session's status bar; click opens the live workflow detail
window. Chips re-arm after refresh from the loaded history tail.

## [2.80.1] — 2026-07-10

### Fixed — title-bar billing badges vanished on fresh page loads
Identity sync (badges, title metadata) was gated behind the sidebar's
change-digest; 2.72.0 made the digest so stable that a freshly loaded page —
whose windows restore after the first merge — never got badges at all. The
sync now runs on every merge (it is internally no-op-guarded).

### Changed — hook cards: full content, standard toolbars
Hook outputs are never truncated anymore (20000/600-char caps removed). The
expandable body starts word-wrapped, carries the standard Wrap/Copy toolbar,
and the summary row gains an Editor button that opens the full payload in a
temp editor.

## [2.80.0] — 2026-07-10

### Fixed — injected hook context is now actually visible
The context a hook injects rides its own attachment type
(hook_additional_context) which the 2.77.0 renderer didn't handle — so
context injections never showed. They now render as "✓ Hook context:
<tag>" cards with the full payload expandable, deduped against the same
hook's stdout copy by content.

### Added — hook visibility settings
`chat.showHookCards` (default on): hide ALL hook cards — a pure CSS toggle,
applies to open chats instantly. `chat.hideEmptyHooks` (default on): hooks
with no output render no card; turn off to see every hook event (applies to
newly loaded history).

## [2.79.2] — 2026-07-10

### Fixed — "N hooks ran" dumped raw shell scripts inline
hookInfos often carries no name, only the command — which can be an embedded
~1KB shell script (claude-mem's is), and 2.76.0's "name the hooks" change
pasted it inline. The summary now shows short script names ("3 hooks ran
(vibespace-hook.mjs, bun-runner.js, hook.mjs)") with the full commands behind
the expandable card body.

## [2.79.1] — 2026-07-10

### Fixed — empty hook cards flooding the chat
2.77.0 rendered a card for EVERY hook attachment; hooks like PostToolUse fire
per tool call with no output (or just the {"continue":true} protocol ack) and
flooded the view. Successful hooks now render only when they produced real
content (protocol-ack JSON unwrapped to its additionalContext; stderr-only
warnings from successful plugins ignored); failures always show.

## [2.79.0] — 2026-07-10

### Added — stop-time bookkeeping nudge (with teeth)
When an agent finishes a turn while its board state is stale (no vibespace-
status update in 10 minutes), it now gets one short follow-up — set your
status, mirror open questions to the inbox, log finished work — and then
stops. Claude: a blocking Stop hook (stop_hook_active-guarded, never loops).
Codex: the wrapper fires the same server arbiter at turn/completed and runs
one synthetic bookkeeping turn (the app-server has no blockable Stop in
JSON-RPC mode). At most once per 30 minutes per session; setting
`agents.stopBookkeepingNudge` (default on) disables it.

## [2.78.0] — 2026-07-10

### Added — per-turn tool micro-reminder for agents
Every prompt you send now carries a one-line (~330 byte) reminder of the
vibespace tools (status / ask / task) when no bigger context is being
delivered — the full rules injected at session start scroll out of the
agent's working context over long sessions and tool usage decays. Setting
`agents.perTurnToolReminder` (default on) turns it off. Claude receives it
via the UserPromptSubmit hook, Codex via the wrapper's per-turn inject.

## [2.77.0] — 2026-07-10

### Changed — multi-group injection is layered, and truncation is now recoverable
Per-group blocks meant group 1's activity log could push groups 2..N entirely
out of a truncated view. The payload is now layered: every group is named on
line 1, then the tool rules once, then all identities, all shared folders,
all activity logs (budget-converged; 3 groups = 8.1KB vs 10.2KB before).
Verified empirically how the CLI handles oversized hook context (30KB marker
probe): it persists to disk and shows a 2KB head preview that NAMES the full
file — so both payload shapes now open with one line teaching agents to Read
that file first. Truncation degrades by layer and is self-rescuing.

### Added — hook details visible in chat history
Hook attachments in the transcript (name + full output, including injected
context) now render as expandable ✓/✗ Hook cards in history replay, and the
"N hooks ran" summary names the hooks. Live/replay double-render deduped.

## [2.76.1] — 2026-07-10

### Changed — vibespace-ask semantics: mirror every chat question
Per user directive: agents must file an inbox item WHENEVER they ask the user
something in chat (or end a turn waiting on decision/input/review) — not only
for "things that specifically need the user" — because the user is often not
watching that window. And the moment the user answers anywhere (chat counts),
the agent resolves the item itself. Rewritten in all three teaching surfaces
(no-task intro, task-group context, the CLI usage text). Payload budgets
re-measured: single 7.4KB, 2-group 7.2KB, 3-group 10.2KB (tools still first).

## [2.76.0] — 2026-07-10

### Fixed — multi-group sessions could never learn the vibespace tools
A session in 2+ Task Groups got the "How to report back" section repeated per
group (2 groups = 9.8KB, 3 = 15.7KB) — past the hook persist threshold, so
those agents saw only a ~2KB head preview and never learned vibespace-ask /
shared-context (the 2.68.0 failure, back through a different door). Now the
tools section is emitted once, FIRST (byte ~158), and per-group log budgets
shrink until the total fits: 2 groups = 6.9KB inline, 3 = 10.0KB with the
rules still inside any preview.

### Fixed — localization audit (user-requested)
Full sweep of today's 8 releases: coverage-gap + param/tag parity checks were
clean except 'Preview'; a multi-agent review of every changed file found three
unwrapped tooltip/label strings (billing-badge 'Console login' / 'API key',
metadata popup 'uuid'). All wrapped, dictionaries complete (zh/ja 1126 keys).

### Fixed — `vibespace-ask --help` filed "--help" as a user todo
Observed in real data. help/-h/--help (and any flag-looking first argument)
now print usage instead of filing an item.

## [2.75.2] — 2026-07-10

### Fixed — account roster donut columns misaligned
The "last refreshed" age label only rendered when >5 min old, so a freshly
refreshed row's right-aligned donuts shifted 28px relative to its neighbors.
The age slot now always renders at a fixed min-width (and switches to hours
past 99 min); measured: donut and star columns identical across all rows.

## [2.75.1] — 2026-07-10

### Fixed — relative-path links now find files deeper than the session folder
Clicking `SCRIPTS.md` failed when the file actually lived at
`cwd/default_voice_examples/SCRIPTS.md`. After the direct candidates miss, the
resolver now runs a bounded server-side search under the session cwd (depth 5,
deps/VCS pruned, 3s cap): a single hit opens directly, several hits show a
picker. Verified on the exact conversation that prompted the report.

## [2.75.0] — 2026-07-10

### Fixed — CRITICAL: sessions created after the service migration died on every restart
systemd's default KillMode=control-group killed every dtach session spawned by
the service on each restart (pre-migration sessions lived outside the cgroup
and survived — which is why only newly-resumed sessions kept "terminating").
The unit now uses KillMode=process: only the node server is killed; dtach
masters survive. Verified: a freshly resumed session's master lived through a
restart and reconnected.

### Added — relative-path linkify + click-time resolution
Agents reference files as `SCRIPTS.md`, `generate.py`, `B2BTasks/x/final/` —
absolute-only linkify missed all of it. Backtick code spans that look like a
relative path or filename are now clickable: Ctrl+click resolves against the
session cwd (direct join, overlap-merge on a shared segment, cwd parent; first
existing candidate opens in the right viewer/explorer, host-aware). Injected
session context now also teaches agents to write absolute paths. ```html code
blocks get a Preview button (renders in the embedded browser).

## [2.74.0] — 2026-07-10

### Added — per-message metadata popup
Right-click a chat message's left color strip (long-press on touch) to see
everything known about that record: serving model, token usage (input / cache
read / cache write / output), service tier, stop reason, request ID, message
ID, uuid, transcript line — with click-to-copy ids and a Copy-as-JSON button.

### Added — one-step update
`./scripts/update.sh` pulls, installs, builds, and restarts the service in one
go; ⚙ → "Update VibeSpace…" runs it in a shell terminal (which survives the
restart thanks to dtach). The systemd unit also gained the PATH fix (hotfix)
so spawned CLIs resolve claude/codex under systemd's minimal environment.

### Fixed — tool calls no longer show "Interrupted" after a server restart
A long-running tool survived the restart fine (dtach), but the history replay
appended every stream-json-only record (earlier turns' `result`s) after the
whole JSONL — so a stale result replayed after the still-pending tool_use and
flushed it to ✗ Interrupted. The JSONL+buffer merge is now position-preserving.

## [2.73.0] — 2026-07-10

### Added — systemd user service
`./scripts/install-service.sh` installs VibeSpace as a systemd user service
(`vibespace.service`): Restart=always (verified surviving SIGKILL),
OOMScoreAdjust=-500, unlimited start retries for late-appearing network
mounts, lingering enabled so it runs without an active login. Manage with
`systemctl --user restart vibespace`, logs via `journalctl --user -u
vibespace`. The service runs a prebuilt tree — build at deploy, then restart.

## [2.72.0] — 2026-07-10

### Added — on-demand quota refresh is now configurable, with a warning
New setting "On-demand quota refresh": Manual (default — ⟳ button only),
Auto (also once on popup open when scoped data is >30 min stale), or Off
(never contact Anthropic; the server refuses too). The first ⟳ click shows a
one-time explainer of exactly what the call is. The setting description spells
out the risk model: user-initiated /usage-equivalent traffic vs the background
polling that has gotten accounts banned.

### Fixed — sidebar re-rendered every few seconds (Remote tab / expanded cards flicker)
The change-digest was order-sensitive while discovery orders sessions by
transcript mtime — with several busy sessions the array reshuffled on nearly
every 5s poll with zero content change (measured live: 5058 entries, 0
changed), fully re-rendering the sidebar. The digest is now order-insensitive;
25s instrumented after the fix: 0 re-renders.

## [2.71.0] — 2026-07-10

### Added — billing identity on every window title + in-place switching
Every Claude/Codex window now carries a billing chip in its title bar
(subscription account name / CLI login as a neutral chip, API keys amber,
codex accounts included). Clicking it opens a switcher: pick another account,
confirm, and the session restarts on it with the conversation continuing via
resume (a true in-process swap is impossible — the account is spawn env). The
choice persists as the session's per-session config, and it also works on
already-terminated read-only windows.

### Fixed — terminated windows lost their identity
After a sidebar terminate, the read-only window's Resume button silently did
nothing and focusing the window no longer highlighted the session in the
sidebar — the live-list entry is gone at that point. Both paths now fall back
to the identity captured in the window's openSpec.

## [2.70.0] — 2026-07-10

### Fixed — Fable weekly quota back in the usage popup
The passive statusline feed only ever carries the 5h/7d windows (verified
against the CLI 2.1.206 payload builder) AND each passive write clobbered the
stored model-scoped buckets to [] — so Fable vanished with 2.60.0. Now: the
statusline hook preserves scoped data, and a new user-initiated
`POST /api/usage/refresh` (popup ⟳ / auto on open when >30min stale, ≥60s per
account, honors 429 backoff, never scheduled) fetches the full window set —
the human-gated equivalent of running /usage in the CLI. Scoped bars show
their own "as of" age.

### Changed — Manage Agents usage readouts are mini donuts
Per-account usage in the rosters is now compact conic-gradient donuts
(5h / 7d / scoped), same visual language as the taskbar quota pies, replacing
the wide label+bar+percent rows.

### Performance — Usage window no longer re-reads the ledger per request
/api/usage-stats re-read + re-parsed every shard on every request — seconds of
CPU at 218k events, and 18s observed while a concurrent full-disk scan was
saturating IO (contention, not baseline storage latency). Events are now
cached in memory with append-only incremental reads, scan() is throttled
(15s), session-meta reads are TTL-cached, and the ledger warms at boot.
18s → ~0.3s under load; also immune to future background-IO contention.

## [2.69.1] — 2026-07-10

### Fixed — "For you" inbox: details viewable, origin session visible
Item details now render behind a collapsed "detail" expander on BOTH open and
resolved rows (previously resolved rows showed no detail at all). Resolved
rows also name the session that filed them and jump to it on click, same as
open rows. Expander clicks no longer bubble into the jump-and-close.

## [2.69.0] — 2026-07-10

### Added — summary + detail split for agent reports
`vibespace-task progress` and `vibespace-status` now take a one-line summary
plus an optional `--detail "full context"`. Everything inline shows only the
summary — board rows, status chips, and the injected context (entries with
detail carry a `†` marker) — so the byte-budgeted injection fits far more
history without losing information. Details are on demand: `vibespace-task
show --full`, click-to-expand rows in the Task Group window, a "detail"
expander in Session Properties, and indented blockquotes in TASK.md.

## [2.68.0] — 2026-07-10

### Fixed — agents never learned the vibespace tools (hook payload truncation)
Field report + forensics from an agent: Claude Code persists an oversized hook
context to disk and shows the agent only a ~2KB head preview — and our payload
put a ~24KB Activity log FIRST with the tool instructions LAST, so agents saw a
pure-log preview and never discovered `vibespace-task/-status/-ask` (observed:
almost no tool usage fleet-wide). The injected context is now ordered
identity → objective/checklist → **tool instructions** → shared folder →
Activity log last, and the log is byte-budgeted (whole payload ≈8KB, stays
inline; newest entries win, with a "last N of M" pointer). Multi-group
sessions split the budget. Real-data check: 27.5KB → 7.9KB with instructions
starting at byte 557.

## [2.67.4] — 2026-07-10

### Fixed — the Ctrl+G "blank terminal" was a scroll bug, not a renderer quirk
Investigation (buffer forensics on two identically-spawned sessions) disproved
the earlier "fullscreen renderer" explanation: neither session ever used the
alt screen and both had identical env — the content was there all along, but
the editor-open path called `fit()` WITHOUT the follow-up `scrollToBottom()`
(the close path had it), so the shrunken viewport could park in the blank
region below the content — randomly per window, which is why two windows
"behaved differently". Now the open path scrolls to bottom; the centered
explainer remains only as a fallback for genuinely empty buffers, with honest
neutral wording.

## [2.67.3] — 2026-07-10

### Fixed — Ctrl+G editor toolbar buttons were never styled
The split-editor's Wrap/A-/A+/Theme buttons had NO CSS rule at all — raw
browser-default buttons (thick borders, wrong font), which the design pass
missed because `external-editor.js` sat in no auditor's file list. They now use
the canonical secondary-button recipe. A follow-up sweep for other JS-built
buttons with no CSS rule confirmed this was the only one.

## [2.67.2] — 2026-07-10

### Fixed — Ctrl+G polish: no more mouse-garbage or mystery blank pane
While the CLI waits on the Ctrl+G editor its fullscreen TUI leaves the alt
screen (blank terminal half) and the tty sits in cooked+echo mode with mouse
tracking still enabled — so moving the mouse over the terminal echoed literal
`^[[<55;26;14M` junk (and buffered it as input for the CLI). Mouse reports are
now suppressed for that window while the editor is open, and the blank half
carries a hint pill ("Editing below — Save & Close to hand the file back").

## [2.67.1] — 2026-07-10

### Fixed — terminal image paste + Ctrl+G editor
Two long-standing breakages, both environmental:
- **Ctrl+G** broke the moment password auth was enabled: the `code` helper
  script's POST to `/api/editor/open` has no cookie and there was never an
  exemption — 401, and claude hung on "Save and close editor to continue…".
  The script now authenticates with its per-session token (same trust model as
  the agent endpoints), validated by the route.
- **Image paste** died when the compositor restarted (Xwayland mints a NEW
  auth-cookie file; every running session keeps the old path → "Invalid
  MIT-MAGIC-COOKIE-1"). The server now merges the working cookie into
  `~/.Xauthority` and hands sessions that stable path, so future rotations heal
  via a re-probe (the paste route retries through it once) — no respawns
  needed. Existing sessions were healed in place by merging the new cookie into
  the old file.

## [2.67.0] — 2026-07-10

### Changed — new default accent: teal (goodbye AI-indigo)
The Dark and Light themes' default accent moves from the ubiquitous
AI-product indigo (#6366f1) to a modern teal — vivid `#2dd4bf` with dark
foreground text on Dark (the contemporary dark-on-vivid treatment, ~8:1
contrast), deep `#0f766e` with white text on Light (5.9:1). Deliberately
distinct from the semantic green/blue/yellow/red so badges stay readable.
Carried through everywhere the old indigo was hardcoded: terminal cursor and
selection colors, CodeMirror caret/cursor/fold (now theme-var driven — fixes
the audit backlog item), the favicon/splash logo gradient and loading bar, and
the login page. Dracula/Nord/Solarized/Monokai and custom themes keep their own
accents; the theme editor can restyle everything as before.

## [2.66.1] — 2026-07-10

### Fixed — waiting blink reaches tabs and window lists
When windows are grouped or stacked, the "agent replied" blink only lived on
the (hidden) window titlebar — the tab headers didn't blink, and neither did
the rows in the taskbar stack popup, the window-list popup, or the overlap
switcher, so you couldn't tell WHICH window wanted attention. Now: tab headers
carry the blink (kept live through the same update funnel as the taskbar) and
all three list popups blink the exact row (group rows aggregate their tabs).
Switching to a waiting tab acknowledges the blink.

## [2.66.0] — 2026-07-10

### Changed — one design language across every window
A 6-surface design audit (86 findings) drove a consistency pass over all
windows, dialogs, popups and toolbars — density preserved (this is a pro tool),
divergence removed:

- **One button system**: primary = accent fill + `--accent-fg` text + accent-hover
  (fixes white-on-pastel text on Dracula/Nord/Monokai; no more opacity/brightness
  hover tricks), secondary = one compact recipe with the accent border+text hover,
  plus a proper `.danger` variant (was a red fill inside an accent border).
- **One popover chrome** for every dropdown/menu/panel (bg, border, radius,
  shadow) — chat's four hand-rolled dropdowns join the app-wide spec and now
  dismiss on Escape like everything else.
- **Theme correctness**: ~40 hardcoded palette colors (badge tints, status chips,
  chat tier colors, workflow states, diff/permission tints, scrollbar hover,
  CSV zebra) now flow through theme vars / `color-mix` — custom themes and all 6
  built-ins render them correctly; Firefox gets themed thin scrollbars.
- **Conflicting duplicate rules fixed**: `.usage-note` (warnings amber via a new
  `.usage-warn`, info notes back to neutral), `.usage-section-title` (one
  canonical section-title spec: 11px caps for titles, child spans keep their
  casing — emails/account names never uppercase), `.usage-bar-fill`.
- **Scales normalized**: radii on the `--radius`/`--radius-sm`/pill(999px)
  tokens, integer type scale (9/10/11/12/13), one toolbar spec across
  explorer/media/editor/hex/archive, one section-title + micro-label spec,
  aligned empty states, 6px state dots, onboarding aligned with the dialog spec.

## [2.65.2] — 2026-07-10

### Fixed — inbox/usage popups follow their buttons
The "For you" inbox and usage-pies popups were pinned to the bottom-right by
CSS, so moving their buttons (customize mode — another bar, left alignment,
top-docked taskbar) left the popup opening far away from the icon. They now
anchor to the button's live position on open: flip above/below by screen half,
align to the button edge, clamp into the viewport, and grow away from the
button so live re-renders stay glued to it.

## [2.65.1] — 2026-07-09

### Fixed — New Session custom names now stick in the sidebar
A name typed in the New Session dialog showed on the window title but the
sidebar silently replaced it with your first message: sidebar names come from
the transcript's first user message unless a **custom name** exists, and the
dialog's name was never persisted as one. It now becomes the session's custom
name once the backend session id is adopted (same mechanism as fork titles);
a manual rename done in the meantime wins.

## [2.65.0] — 2026-07-09

### Added — the "For you" inbox (global user-facing TODO list)
Agents can now file things that need **you** — a decision to make, input only
you can give, something to review — with the new `vibespace-ask` CLI (taught to
every VibeSpace session, local and remote). Each item belongs to its session
(your "task"); the new **taskbar inbox** merges every session's items into one
list, grouped by session, sorted urgent-first, with a count badge, a toast when
a new item arrives, and **one click to jump to the owning session** to handle
it (✓ done / ✕ dismiss / ↺ reopen; agents can also resolve their own items once
you answer in chat). This is the inverse of the agent's own todo list — it's
the queue of what the fleet is waiting on *you* for. Persisted in
`data/user-todos.json`; re-filing the same open question refreshes instead of
duplicating; a per-session open cap keeps a looping agent from flooding you.

## [2.64.1] — 2026-07-09

### Fixed / clarified — Usage window vendor separation
- **Codex "cache writes 0" was misleading**: codex rollouts do not report
  cache-write token counts at all (verified against records written minutes ago
  by 0.144.0 — the usage struct has no such field), so a codex-only view now
  shows **"— · not reported by Codex"** instead of a fake 0. (Historical
  context: cache writes were also free on GPT-5.5-era OpenAI billing; 5.6+
  bills them 1.25× but the data still isn't reported, so cost estimates can't
  include it.)
- **Account chips follow the Backend filter** — Backend=Codex no longer shows
  Claude accounts (and vice versa); an account selection from the other backend
  is cleared instead of yielding a permanently empty view.
- **Vendor logos everywhere identities/models mix**: account chips, By-account
  rows, By-model rows, and the Pricing editor's account list all carry the
  Claude/Codex brand mark.
- **Pricing editor listed only what the current filter left visible** (e.g. a
  codex-filtered dashboard shrank it to one row) — it now lists every account
  from the unfiltered union.
- **Top sessions show session names** (from session-meta; sessions not created
  in VibeSpace keep the id).

## [2.64.0] — 2026-07-09

### Added — Codex multi-account parity (Usage window + quota pies)
The 2.62/2.63 account features only handled Claude — Codex accounts were
invisible (user-reported):
- **Ledger**: the two CLIs' machine logins were conflated into one bucket — now
  split (`Claude CLI login` vs `Codex CLI login`, separate billing categories),
  and the Usage window's Account chips list both plus every named ChatGPT
  account, with the same email-linked merge (machine login == named account →
  one chip).
- **Quota pies**: codex rate-limit snapshots are now bucketed **per account**
  (live sessions report their own account; recent rollout tails attribute via
  the thread's session-meta), and the codex popup section gained the same
  account switcher chips as Claude — Auto (default account) / CLI login / each
  ChatGPT account, with email-linked dedupe and newest-wins merge.
- **Manage Agents**: the Codex roster now shows the machine login's email, a
  `= "Name"` hint when it IS a named account, per-account 5h/7d usage bars,
  and "set email…" for API-key-mode logins whose identity isn't in the token.

## [2.63.0] — 2026-07-09

### Added — Codex usage in the ledger (it was never mined)
The Usage window's ledger only scanned Claude transcripts — Codex sessions
never produced a single event and the Backend=Codex filter was always empty.
The scanner now also mines **Codex rollouts** (`~/.codex/sessions`): each
`token_count` event's `last_token_usage` is one request (fresh input = input −
cached; output includes reasoning), deduped by a synthetic id built from the
thread's strictly-monotonic cumulative total; model/cwd come from the preceding
`turn_context` and persist in the scan cursor. Account attribution works the
same as Claude (codex-subscription accounts split correctly). Ships **real
OpenAI pricing tiers** (GPT-5.6 Sol $5/$30 · Terra $2.50/$15 · Luna $1/$6,
GPT-5.5 $5/$30, 5.4 $2.50/$15, 5.4-mini $0.75/$4.50, 5.3-codex $1.75/$14;
cached input at 10%) — tier matching is now data-driven (longest key in
pricing.json wins), and the Pricing editor lists every tier. Scanning is
**chunked** (a 1.9GB rollout exceeds Node's string limit) — first pass over
2.3GB ≈ 8s, incremental after.

### Added — Usage window: account filter + custom date range
The dashboard gained an **Account** chip row (All / each account / CLI login) —
the whole window (tiles, trend, every breakdown) follows the selection. When
the machine's CLI login IS a named account (email link), the two buckets render
as **one** chip covering both. And the Range control gained **Custom…** with
from/to date pickers.

## [2.62.0] — 2026-07-09

### Added — per-account usage switching
The taskbar usage pies (and their popup) can now show **any** Claude account,
not just the default: the popup gained a chip row — **Auto** (follow the default
account, the old behavior), the machine's **CLI login**, and every named
subscription (★ marks the default). Per-device preference. When the CLI login
**is** one of the named accounts (same email), the two render as **one** entry
and their passively-captured usage merges **newest-wins** in both directions —
no duplicate/conflicting pies for the same real account. Accounts whose login
flow didn't record an email (identity is unknowable from creds alone) get a
**"set email…"** affordance in Manage Agents so you can declare the identity and
enable the merge; the Manage-Agents CLI-login row also says `= "Name"` when linked.

### Added — create missing folders from New Session
Typing a nonexistent path in the New Session dialog now offers to **create the
folder** (works for remote hosts too) instead of failing opaquely at spawn time
("terminated" locally, silent $HOME fallback remotely). A file path is rejected
with a clear message; cancel keeps the dialog open.

### Fixed — shell/codex terminals died instantly ("terminated")
Since 2.60.0 the passive-usage statusLine injection appended `--settings` to
**every** local terminal spawn — but only the claude CLI understands that flag,
so plain shell terminals (including the Manage Agents **Update/Log in** helpers)
and local codex terminal sessions exited immediately. The injection is now gated
on the claude backend.

### Added — GPT-5.6 (Sol/Terra/Luna) support
Codex reasoning-effort options are now **dynamic per model** from the CLI's own
models cache instead of a hardcoded ladder — GPT-5.6 Sol/Terra expose the new
**max** and **ultra** efforts (ultra = multi-agent), Luna up to max, and the chat
status-bar effort dropdown offers exactly what the session's current model
supports. The server also keeps a **union** of models seen across cache rewrites:
a still-running old codex CLI re-fetches the (version-gated) cache and would
otherwise erase the 5.6 entries minutes after they appeared. The 5.6 models
themselves arrive via the codex CLI (≥0.144.0) — use Manage Agents → Update
(fixed above), then start a new codex session.

## [2.61.1] — 2026-07-09

### Changed — real Anthropic prices + per-account pricing
Cost estimates now use the current official API prices (researched + verified):
**Fable 5 is $10/$50 per Mtok** (it's a published price, not a placeholder), and
a bug where Opus used the *deprecated* $15/$75 instead of the current **$5/$25**
was fixed — estimates were ~3× too high. Pricing is now **per-account**: give any
API-key account its own **discount %** or full rate override (different keys bill
differently) via the new **Pricing** editor in the Usage window; subscriptions
use the default as the API-equivalent reference.

### Fixed — Usage tiles now reconcile
"Total tokens" is dominated by cached reads (usually >95%), which wasn't shown as
its own tile — so it looked like the numbers didn't add up. Cached reads / cache
writes / fresh input / output are now peer tiles that visibly sum to the total.

### Changed — snappier usage refresh
`/api/usage` is a cheap local read now (passive capture, no Anthropic call), so
the taskbar pies refresh every **8s** (was 30s; 30s when the tab is hidden) and
the passive statusline write throttle dropped 25s → 8s — usage reflects a
just-finished turn within seconds, still zero Anthropic calls.

## [2.61.0] — 2026-07-09

### Added — Usage window (permanent per-request token ledger)
New **⚙ → Usage** window with a full analytics dashboard over your token usage.
A permanent, append-only ledger (`data/usage-history/`) is mined from Claude
Code's own JSONL transcripts — **works for both terminal and chat sessions**
(the transcript is mode-independent) — and keeps the atomic facts forever, so it
survives transcript rotation/deletion and any future report can just read it.

Each record is one API request, **deduped by requestId** (a single request
appears on 2–3 transcript records with identical usage — summing raw records
would multi-count). Scanning is incremental (per-file byte cursor), so even
hundreds of MB of history scan in a few seconds.

**Accurate account attribution (no mixing):** every request records WHICH
account it billed to and its billing **type**, so **subscription usage and
API-key usage are never conflated** (they're covered by your plan vs real $).
Attribution is per-request **by time** — a session resumed under a different
account is split correctly — via a permanent attribution log; unattributed
sessions (the CLI's own global login) are their own clearly-labeled bucket.

The dashboard shows: headline tiles (est. API-equivalent cost, total tokens,
cache-hit ratio, requests/sessions, fresh input, cache writes), a daily trend
chart, and breakdowns **by billing type, account, model, project, mode, cache
efficiency, hour-of-day and weekday activity, and top sessions** — with a
range/backend filter and **CSV export**. Cost is an estimate (API-equivalent;
subscriptions are plan-covered) from an editable price table
(`data/usage-history/pricing.json`).

## [2.60.2] — 2026-07-09

### Changed — the taskbar usage pies now follow your DEFAULT account
The 5h / 7d pies used to always show the machine's global login. If you'd starred
a named subscription as your default (so new sessions bill to it), running a
session on it appeared to do nothing — its usage updated in Manage Agents but not
the taskbar. Now the pies follow the **default account** (the popup shows its
name + "refreshes when you run it in a terminal session"), falling back to the
global login when nothing is starred.

### Added — passive model discovery
The model dropdown now **learns the full model IDs of models you actually run**,
harvested from the same status-line hook — no `/v1/models` API call. Built-in
aliases (fable/opus/sonnet/haiku[+1m]) are always present; used models add their
exact dated IDs. (Claude Code keeps no local model cache and stream-json doesn't
emit the model list, so this is the only zero-call way to grow it.)

### Fixed — account roster on a remote host reflects the local-only rule
With a remote host selected, subscription rows are now dimmed with a "· this
machine only" hint and their Test button explains the situation instead of firing
a create the server rejects; the section note says API keys ship to the host
while subscriptions are local-only (unless you enable the opt-in). Matches the
2.60.0 default.

## [2.60.1] — 2026-07-09

### Added — active usage polling as an explicit opt-in (default off)
The old OAuth-based usage auto-refresh is back, but only as a clearly-labeled
opt-in: **Settings → "⚠ Actively poll subscription usage (automation risk)"**
(default **off**). Off (the default) means VibeSpace never contacts Anthropic on
its own — usage stays passive (captured from your live terminal sessions).
Turning it on restores the background poll (global login ~5 min + one named
subscription per 90 s) and pops a **danger confirm dialog** spelling out that
this off-CLI, fixed-cadence traffic is what can get a Pro/Max account flagged as
automated and banned. Use it only if you accept that risk (e.g. to see live
usage for chat-only or idle accounts).

The hourly `/v1/models` fetch with a subscription OAuth token is gated behind the
**same** toggle (it's the same off-CLI background pattern). Off by default, the
model dropdown falls back to the built-in CLI aliases; an API key is always used
when present.

## [2.60.0] — 2026-07-09

### Changed — subscription usage is now captured passively (no background API polling)
VibeSpace no longer calls Anthropic's usage endpoint on a timer with a
subscription's OAuth token. A fixed-cadence, 24/7 background call using a
subscription token — for accounts that may be idle, from a server — is exactly
the "automated / non-human access outside the official client" pattern that can
get a Pro/Max account flagged and banned (Consumer Terms §3.7; the 2026-02-20
OAuth clarification). Instead the **5h / 7d usage bars are captured passively**:
a new status-line hook (`data/bin/vibespace-usage`) reads the rate-limit figures
the CLI **already** receives during a real interactive session and caches them —
**zero extra API calls**, and only for accounts you're actually using. Terminal
sessions refresh usage this way; chat (stream-json) sessions have no status line,
so a chat-only account shows its last-known value. Idle accounts are never
contacted.

### Changed — subscriptions no longer ship to remote hosts by default
Running a subscription (Pro/Max or ChatGPT) on a **remote host** is now **off by
default**. Putting a subscription's login on another machine (often a datacenter
IP) is both outside the spirit of a personal subscription and an
impossible-travel / datacenter signal that can look like account abuse. The
recommended path is now to **log in on the host itself** ("Manage agents → select
host → Log in on host…"), so the work bills to that machine's own login.
**API-key accounts still ship to remote hosts** (that's the sanctioned path for
server/automation use). To opt in for subscriptions anyway, enable **Settings →
"Ship subscription logins to remote hosts."** The server enforces the gate — a
blocked attempt fails with a clear message rather than silently shipping creds.

### Docs
New **[docs/accounts.md](docs/accounts.md)** now includes a "Staying within
Anthropic's terms" section documenting these design choices; README and CLAUDE.md
reworded to describe multi-account support as switching between **your own**
logins (like signing in/out), using the official CLIs interactively.

## [2.59.1] — 2026-07-09

### Changed — account scoping made unambiguous in Manage agents
Picking a remote host used to silently change what the accounts section meant —
it was unclear whether a login would land in VibeSpace or on the host. Now ONE
unified roster with explicit scoping: the first row is always the **selected
machine's own CLI login** (pick the devbox → "CLI login on the devbox", with a
"Log in on the devbox…" button that clearly acts ON that machine, plus an inline
"Import its key" when the host has an unimported Console key). Every named
account below is **stored in VibeSpace** — machine-independent, usable by
sessions on any machine (credentials ship per session) — and no longer
disappears when you switch machines. The note under the list spells out the
split. The ChatGPT/OpenAI roster gets the same treatment (remote login uses
`codex login --device-auth` — a plain `codex login` would open a callback
server on the host, unreachable from your browser). Test buttons run ON the
selected machine.

### Changed — "远程主机" terminology (zh)
Remote machines are now consistently called **远程主机** in the Chinese UI
(was the ambiguous 主机): sidebar Remote-tab section header, New Session row,
session Properties, filter labels. The Manage-agents machine dropdown (which
includes 本机) is labeled 机器. The sidebar Remote-tab section headers are now
translatable (they were hardcoded English).

### Fixed — remote creds shipping is concurrency- and rotation-safe
Shipping a subscription's creds dir to a host no longer `rm -rf`s the remote
copy (a concurrent session of the same account on the same host would have had
its creds yanked mid-run). Extraction is per-file **newest-wins**
(`tar --keep-newer-files`): OAuth refresh tokens rotate, so after a remote
session refreshes, the host copy holds the live token — re-shipping the stale
local copy over it would have broken the account on that host.

## [2.59.0] — 2026-07-08

### Added — multiple ChatGPT (Codex) logins, switchable per session
Codex now supports the same multi-account model Claude Code got in 2.56–2.58:
hold **several ChatGPT logins at once** and pick one per session. Each account
gets its own isolated `CODEX_HOME` whose `sessions/` and `config.toml` are
symlinks to the shared `~/.codex` — so **auth is isolated per account** while
your **threads and settings stay unified** (one session list, one config). Add
one via **Manage agents → ChatGPT / OpenAI accounts → Add ChatGPT account…**; it
opens a terminal running `codex login --device-auth` (a URL + one-time code, so
it works even when your browser is on a different machine). Star an account to
make it the default for new Codex sessions; pick a specific one in the New
Session dialog or the card ⚙.

### Added — subscriptions on remote hosts
Named subscription accounts (both Claude and Codex) can now be picked for a
**remote-host session**. The account's creds dir ships to the host per session
over an ssh-stdin **tar stream** (channel-encrypted, lands in a 0700 dir) and
the CLI is pointed at it (`CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CODEX_HOME`) — the
same process-env-only, never-argv discipline as the API-key path. For Codex the
host's `sessions/` + `config.toml` are symlinked so threads/settings stay shared
on the host. (Previously subscriptions were local-only.)

### Changed — accounts grouped under their CLI in Manage agents
The account rosters now render **directly under their backend**: Anthropic
accounts under **Claude Code**, ChatGPT/OpenAI accounts under **Codex** — instead
of one Anthropic-only section at the bottom. Each backend keeps its own default
account. Row columns (icon · name · usage · actions) are grid-aligned so the
CLI-login peer row lines up with the richer account rows.

## [2.58.0] — 2026-07-08

### Added — per-subscription usage in the account manager
Each subscription row in **Manage agents → Anthropic accounts** now shows a
compact **5h / 7d usage readout** (mini bars + %, green/amber/red by level), so
you can see at a glance which account has quota left before switching to it. The
CLI global-login row shows the same from the main usage poll. Data is the
per-account poll (server round-robins it, read-only token); idle accounts show
last-known with a "Nm ago" staleness note (their usage isn't changing anyway).

## [2.57.1] — 2026-07-08

### Fixed — account identity no longer clobbered; global login shown as a peer
- Adding a subscription/Console account no longer overwrites the GLOBAL login's
  displayed identity in `~/.claude.json`. The login now runs with BOTH
  `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` pointed at the
  account's own pre-seeded dir (seeded with onboarding-complete flags, so no
  first-run screen), isolating creds AND identity. `~/.claude` is untouched.
  NOTE: this isolation is LOGIN-only — running a session on an account sets only
  `CLAUDE_SECURESTORAGE_CONFIG_DIR`, so `.claude.json`/settings/projects stay
  SHARED across all accounts (config never reverts on switch).
- The CLI's own global (~/.claude) login is now a **peer row** in the account
  list with the same star toggle, instead of a separate status line — it's the
  default whenever no named account is starred.
- The Manage Agents **Test** session is now ephemeral (closing its window always
  terminates it, never leaves a detached test session).

## [2.57.0] — 2026-07-08

### Changed — account manager polish (multi-subscription)
- Accounts now read as **peers**: every row carries the same controls, and the
  "default for new sessions" is a single **star toggle** (filled = default,
  click to set/clear) instead of an asymmetric "Set default / Unset default"
  button.
- **Rename** any account (subscription or API key) — a pencil button per row.
- Manage Agents account rows use **SVG icons** (crown / key / star / pencil / ✕)
  instead of emoji.
- The session card's subscription billing badge shows a crown SVG + just the
  account's **first character** (full name in the tooltip), so it stays compact.

## [2.56.3] — 2026-07-08

### Fixed — terminal paste broke non-TUI prompts (root cause of the login failure)
Pasting text into a terminal ALWAYS wrapped it in bracketed-paste markers
(`\x1b[200~…\x1b[201~`), even when the running program hadn't enabled
bracketed-paste mode. For a plain (non-TUI) stdin prompt like `claude auth
login`'s "Paste code here", the markers landed in the input as literal bytes
(and there's no submit newline), so the paste looked dead and then failed the
code exchange. Now paste goes through xterm's `terminal.paste()`, which emits
the markers ONLY when the app set `\x1b[?2004h` (TUIs do; plain prompts
don't) — correct in both cases. Fixed across desktop paste, the clipboard-API
path, and the mobile paste pad. This is what blocked the add-subscription /
add-Console login.

## [2.56.2] — 2026-07-08

### Fixed
- Subscription/Console login FAILED — 2.56.1 used `claude /login`, but that TUI
  slash-command errors from a shell ("/login isn't available in this
  environment"). Now uses the real subcommand `claude auth login --claudeai`
  (subscription) / `--console` (Console account), which prints an OAuth URL to a
  hosted callback + a paste-code prompt (works headlessly), with
  CLAUDE_SECURESTORAGE_CONFIG_DIR only (no onboarding).
- Testing a not-yet-signed-in subscription opened a blank window (the server
  correctly rejects the spawn). Now it shows a clear message instead, and
  not-logged-in subscriptions are hidden from the New Session account picker.

## [2.56.1] — 2026-07-08

### Fixed
- Add-subscription / add-Console-account login opened with an empty
  `CLAUDE_CONFIG_DIR`, which triggered Claude's first-run onboarding ("weird UI")
  and broke the OAuth code paste (no echo → 400). The login now sets ONLY
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` (config dir stays `~/.claude`, no onboarding)
  and uses `claude /login` (the proven flow). Credentials are still isolated;
  the global login's tokens stay untouched.
- Added a standalone **"Add Console account…"** entry (its API key is captured in
  an isolated login so your subscription creds aren't wiped by the console
  `/login`).

## [2.56.0] — 2026-07-08

### Added — multiple Claude subscriptions, switchable per session
You can now hold several Claude Pro/Max logins at once and pick which one bills
each session — the counterpart to per-session API-key switching. **Manage agents
→ Anthropic accounts → "+ Add subscription…"**: name it, and a terminal opens to
sign in with that account; the login is captured into its own isolated store, so
it does NOT disturb your current/global login. Each account then appears in the
New Session dialog, the card ⚙, and Session Properties account pickers (👑), and
a session's card shows 👑<name> so you never burn the wrong plan. The usage popup
tracks each subscription's 5h/7d quota (idle accounts show last-known).

Mechanism (verified against claude 2.1.205): each subscription is a real dir
holding only its `.credentials.json`, read by the CLI via
`CLAUDE_SECURESTORAGE_CONFIG_DIR` — this relocates the credential store ONLY, so
transcripts, session discovery and settings stay shared in `~/.claude`. Local
Claude sessions in this release (remote hosts + Codex are later phases). Holding
your own paid accounts and driving the official CLI per-account is Anthropic's
acknowledged "accepted" pattern (not the banned third-party-OAuth-proxy path).

### Changed
- Chat hook notices show their FULL detail — the 500-char truncation is gone
  (the output stays inside the collapsed disclosure, height-capped with a scroll).

## [2.55.3] — 2026-07-08

### Fixed
- The model auto-fallback chat notice ("⚠ Model auto-fallback: X → Y …") was
  hardcoded English — it's built server-side in the normalizer, so client
  t() never saw it. The structured from/to now ride the message and
  renderSystemMsg localizes it client-side (en/zh/ja). The status-bar
  fallback tooltip was already localized.

## [2.55.2] — 2026-07-08

### Added
- Session right-click menu: **Open working directory** — opens the file
  explorer at the session's cwd (host-aware: a remote session's folder opens
  on its host).

## [2.55.1] — 2026-07-08

### Fixed — i18n homograph collision ("Plan")
The usage popup labeled the Codex subscription plan "规划模式" — the
English-string-as-key design collided the permission mode "Plan" with the
billing "Plan". Added pgettext-style contexts: `tc(ctx, str)` looks up
`ctx::str` and falls back to English (never the un-contexted translation).
The usage popup now uses `tc('billing', 'Plan')` → 套餐 / プラン. Swept every
short key used in multiple files for further homograph collisions — "Plan"
was the only one.

## [2.55.0] — 2026-07-08

### Added — create a session for a Task Group from the flat Tasks view
The Task Groups tab's flat **Tasks** sub-view now has a "+ New session in a
Task Group…" card at the top: it opens a group picker (color-marked, board
order) and launches the pre-filled New Session dialog for the chosen group
(first auto-include folder as cwd, group folders pinned in the chips) — no
more switching back to the Groups board just to spawn into a group.
Right-clicking a session card's group color bar also opens that group's full
action menu (New session in this task…, Details, Rename, …).

## [2.54.3] — 2026-07-08

### Fixed
- Path chips showed the `~` at the END (`/workspace/vibespace~`): the rtl
  front-truncation trick reorders leading bidi-neutral characters to the
  visual end. Added the LTR-mark anchor (same as session cards) to the New
  Session cwd chips, Task-Group chips, mount paths, and the Ctrl+K palette
  paths.

## [2.54.2] — 2026-07-08

### Fixed
- Model / effort status-bar dropdowns sometimes "did nothing" on click (a
  faint dark sliver, then nothing): the dropdown box was created EMPTY and
  populated by an async fetch whose failure silently removed it. Now a
  Loading… row shows immediately, and on fetch failure the dropdown falls
  back to the client-side ladder (effort: low…max + ultracode; model: CLI
  aliases + Custom…) instead of vanishing. Also guards against a
  non-positioned popup container re-anchoring the dropdown off-screen.

## [2.54.1] — 2026-07-08

### Changed — injected context reframes the shared context folder
The per-turn Task Group injection now describes the context folder as the
group's **shared memory between agents** (documents/records passed session ↔
session), explicitly *not* a place to publish deliverables for the user — and
instructs agents to proactively curate knowledge there when other sessions of
the group will need it (conventions, gotchas, decisions with reasons,
cross-role details — e.g. a dev session writing up technical specifics a
compliance session depends on), preferring consolidation over piling up new
files. Both local and remote (live-synced copy) variants updated.

## [2.54.0] — 2026-07-08

### Added — Task Group folders pinned in the New Session quick-fill chips
When a Task Group is selected in the New Session dialog, the click-to-fill
directory chips under Working Directory now **pin the group's linked folders
first**, marked with the group's color dot. For folders with "subfolders"
enabled, nested folders that **already contain sessions** are suggested too —
group folder `/a` plus sessions at `/a/too` yields chips for both `/a` and
`/a/too` (tooltip shows the session count; symlinked checkouts match via the
real path). Chips re-render when you change the Task dropdown. (This is the
chip row — distinct from the autocomplete dropdown, which already floated
group folders.)

### Fixed
- Task Group detail: Activity log entries now have a subtle divider between
  them (multi-line notes visually ran together), and rows can no longer
  compress/overlap inside the scroller.

## [2.53.0] — 2026-07-08

### Changed — Settings is now a non-blocking window
The settings page opens as a normal, same-level workspace **window** instead
of a blocking modal overlay — drag it aside, resize it, and change a setting
while watching the effect on your workspace live. It's a singleton (opening it
again focuses the existing window) and transient (not persisted in the layout,
not restored on refresh, not synced to other clients).

### Added
- **Configurable shake duration**: how long you must shake a window before grid
  snap turns off is now a setting (**Toolbar & Layout → Shake duration
  (seconds)**, `layout.shakeBypassSeconds`, default 1s, range 0.3–3s). It's
  re-read at the start of each drag, so changes apply immediately — pair it with
  the now-windowed Settings to dial it in live.

## [2.52.0] — 2026-07-08

### Added — shake to bypass grid snap
Shaking a window vigorously for about a second while dragging now latches
"grid/edge snap off" for the rest of that drag — a mouse-only alternative to
holding **Alt**. A "Grid snap off" badge follows the cursor and the window
gets a dashed outline while active; it re-enables automatically on the next
drag. Detected by counting per-frame direction reversals (≥3 in a 500ms
sliding window = vigorous) sustained for ~1s, so a couple of accidental
jiggles never trigger it. New setting **Toolbar & Layout → Shake to bypass
snap** (`layout.shakeBypassSnap`, default on). Scoped to the title-bar move
drag (not resize). Fully i18n'd (en/zh/ja).

## [2.51.0] — 2026-07-08

### Added — full-UI i18n (English / 中文 / 日本語)
The entire human-facing UI now switches language: ⚙ menu → **Language**
(Auto / English / 中文 / 日本語; per-device, stored in localStorage — a
Japanese phone and an English desktop can share one server). Gettext-style
design: the English string IS the dictionary key (`t('New Session')`),
missing entries fall back to English, switching reloads the page.
`src/lib/i18n.js` runtime + `i18n-zh.js`/`i18n-ja.js` dictionaries (869
entries each, generated from 880 extracted keys — brands/model ids stay
English by design). Covered surfaces: index.html chrome (data-i18n), sidebar
+ session cards + context menus, app dialogs (New Session / Manage Agents /
accounts wizard / backup / onboarding / usage popup), Task Group detail,
Session Properties, chat chrome (tool cards / permissions / search /
minimap / status bar / input), full settings schema + dialog. Agent-facing
injected context and docs remain English. `scripts/i18n-extract.mjs`
extracts all keys for dictionary audits (key exactness, {param} and HTML-tag
preservation checks).

### Added
- **Agent tool cards show the model**: a chip next to the description —
  declared `input.model` at render, upgraded live to the actually-serving
  `message.model` from the subagent stream.

### Fixed
- Subagent live status ("N messages · View Log") rendered OUTSIDE the tool
  card for background agents (instant tool completion skipped the pending
  anchor), and completed cards got a duplicate View Log button.
- The generic tool-card "wrench" icon read as an eyedropper/color picker —
  redrawn as a real open-end wrench; Bash/shell tools (incl. Codex
  exec_command) now use a dedicated terminal icon instead.
- Task Group detail window no longer scrolls back to the top after every
  edit (color, toggles) — scroll position is preserved across re-renders.
- Session Properties "Agent steps": rows compressed and overlapped inside
  the 180px scroller (flex-shrink) — fixed; open steps now list first and
  completed ones collapse to the last 2 with an expandable "N more" row.
- `vibespace-status` CLI tolerates the `set` prefix alias and a positional
  reason argument (both observed agent misuses; the reason was silently
  dropped before).

## [2.50.0] — 2026-07-08

### Added — mobile flat Task View
The mobile Task Groups tab now has the same **Groups | Tasks** sub-views as
desktop: Groups keeps the two-level drill-down; Tasks is the flat
urgency-sorted 活儿 list (same renderer as desktop — group color bars, cwd on
cards, untagged actives at the bottom with a stopped-count pointer). The sort
menu button works on mobile there too; the header filter menu's State section
applies as on desktop. Back from a group drill-down restores the sub-tab bar.

## [2.49.1] — 2026-07-08

### Fixed (mobile)
- Mobile Task Group cards showed "undefined ·" in the meta line — leftover
  `task.status` read (removed in the 2.39.0 refactor); shows "archived" now.
- Mobile "Untagged" drill-down would render EVERY stopped session (thousands,
  since 2.47.0 stopped narrowing the tasks tab) — now lists active ones only
  with a stopped-count pointer to Folders, matching the desktop Task View.
- The sort button no longer shows on the mobile Task Groups tab (its Task View
  sort menu has no effect there — mobile keeps the drill-down list).

## [2.49.0] — 2026-07-08

### Added — session right-click menu + Properties window
- **Right-click a session card** (long-press on touch) for quick actions
  without expanding: focus/resume (chat/terminal), view history, fork,
  star/archive/rename, set status, Task Groups submenu (toggle membership;
  folder-derived marked), copy ID/path, find/go-to/move window, Properties,
  terminate.
- **Properties window** (also a button in the expanded card): the full
  reference sheet for one session — identity (ID/agent/mode/machine/cwd/
  started/connection), current state with a Change button + the status history
  timeline, billing (this run's identity + the on-resume account selector),
  saved config overrides, Task Group membership toggles, and the agent's todo
  steps. Live-synced; replays across clients and layout restores.

## [2.48.4] — 2026-07-08

### Fixed
- **Terminate from the sidebar left the session's window looking alive** (no
  read-only flip): the kill handler removes the session from activeSessions
  before the PTY's async onExit runs, and onExit's stale-PTY guard (from the
  2026-06 review batch) then returns without ever emitting 'exited'. The kill
  handler now broadcasts 'exited' (reason: terminated) itself,
  deterministically. Verified with a live create→kill reproduction.

## [2.48.2] — 2026-07-07

### Fixed
- The per-session **Account** override (card ⚙) never saved: `setSessionConfig`
  whitelisted only model/effort/permission and silently dropped the `account`
  key. Picking an API key in the gear now persists, shows in the config badge,
  and applies on every resume path.

## [2.48.1] — 2026-07-07

### Added
- The billing key also shows in the **window title bar** (and on tabs in a tab
  group): amber key on API-billed sessions, dashed "?" on unknown ones —
  synced live from the same per-session auth source as the card badge.

## [2.48.0] — 2026-07-07

### Added — per-session billing identity (who's spending what)
Every Claude session now carries its billing identity, so sessions that keep
burning API money after you re-login to the subscription stay visible:
- Amber key badge on **every API-billed session** — via a chosen API key OR a
  Console global login at spawn (tooltip says which). Subscription sessions
  stay quiet. Pre-tracking busy sessions show a dashed "?" badge (their init
  record scrolled out of the buffer) and self-resolve on the next resume.
- Truth source: the CLI's own init record (`apiKeySource`: none=subscription,
  '/login managed key'=Console, ANTHROPIC_API_KEY=env key), captured live and
  persisted; falls back to the spawn-time global-login state (marked
  "estimated"). Backfill on restart from the session buffer + /proc env probe.

### Added — remote host account status
- Manage Agents with a host selected now shows the HOST's Anthropic login
  state (subscription / console key), a "Log in on host…" terminal button, and
  one-click **Import host key** into the central store.

### Changed — one control row on the Task Groups tab
- The flat Tasks view's embedded Sort/Filter toolbar is gone: the header's
  sort button is context-aware (opens the urgency/status/recent/name menu
  there), and the session-state filter became the first section of the unified
  filter menu. Search + Filter + Sort now live side by side in one row, and
  the search box narrows ALL sub-views of the tab.

### Fixed
- Usage popup: no longer stretched by the signed-out note (max-width + wrap),
  and each backend section shows its OWN "Updated X ago" — a stalled Claude
  poll no longer makes Codex's data look stale.

## [2.47.1] — 2026-07-07

### Fixed
- 2.47.0 wrongly hid the unified filter button on the Task Groups tab: despite
  its "backend filter" name it holds FOUR dimensions (connection status /
  backend / machine / agent kind), and three of them still apply there — they
  kept filtering silently with no visible control. The button now shows on both
  session tabs, and the menu hides its (genuinely inapplicable) Status section
  on the Task Groups tab.
- Naming: the sidebar text input now says "Search..." — it clashed with the
  Task View "Filter" button (two things labeled filter).

## [2.47.0] — 2026-07-07

### Changed — sidebar per-tab cleanup + defaults
- **One filter/sort story per tab**: the Folders tab keeps the full global set
  (text/backend filter, sort, quick tabs); the Task Groups tab now shows only
  the text filter + manage mode (its views carry their own sort/status-filter
  toolbar — the duplicated global controls are hidden there); the Remote tab
  hides all of it.
- **Default view settings**: `sidebar.defaultTab` (open the app on Folders /
  Task Groups / Remote) and `sidebar.defaultBoardView` (Task Groups tab opens
  in Groups or the flat Tasks view). In-session switching stays transient; the
  setting is the persistence (synced across clients).
- **Task View now respects stars**: ★ is the tiebreaker right after the
  primary sort key (urgency/status/recent modes), matching the Folders sort
  precedence (urgency first, then ★, then recency). Name sort stays purely
  alphabetical. (The Groups view already respected stars via the shared
  session sort.)

## [2.46.0] — 2026-07-07

### Added — the agent's own TODO list, surfaced on the board (活儿的步骤)
The session-level checklist was already there all along — the agent's native
TodoWrite (Claude) / plan tool (Codex) / the newer TaskCreate-TaskUpdate family
(CLI ≥2.1.2xx). VibeSpace now OBSERVES it instead of inventing a parallel store:

- Session cards show a **progress pill** (`3/7` + current step in the tooltip)
  while steps are underway (hidden when all done); the expanded card shows the
  full **Steps** list (works for stopped sessions too, read from the transcript
  via a new `GET /api/session-todos`).
- Live capture rides the existing stream parse for both backends; the
  TaskCreate/TaskUpdate family is replayed CRUD-style (the created id only
  appears in the tool RESULT text).
- The Task Group **Checklist is repositioned as the group's BACKLOG** of work
  items (UI hint + injected guidance): the user queues work items, any session
  picks one up and ticks it off; agents keep their working steps in their own
  session TODO — which the board now shows.

## [2.45.0] — 2026-07-07

### Added — remote context-folder auto-sync
Remote sessions now get their Task Groups' **context folders auto-synced onto
the host** (`~/.vibespace/ctx/<groupId>`, bidirectional rsync, newer file wins,
no deletes, `.vibespace/` excluded), and the **injected file index is
path-translated** to the remote copy — a remote agent can actually read (and
write back) the group's shared files. Sync triggers: session spawn, every 60s
while a live remote session belongs to the group, and whenever an injection
delivers fresh context. Remote artifacts sync back → the local signature
changes → every member session re-injects next turn.

## [2.44.0] — 2026-07-07

### Changed — task-system review fixes
- **One membership rule everywhere**: the Groups board now matches folder
  membership by cwd OR symlink-resolved realCwd, via the same helper Task View
  and the expanded card use (`_sessionFolderMatch`) — mirroring the server.
- **Content-gated re-injection**: only edits an agent actually sees (title /
  objective / checklist / activity / context folder) re-inject a group's
  context. Binding a session, changing color, toggles etc. no longer blast a
  full "was UPDATED" context to every member agent (`contentUpdatedAt`).
- Sessions whose Task Groups are ALL injection-off now still get the one-time
  `vibespace-status` intro (they could never learn to self-report before).
- **Stale state decay**: a stopped session's declared working/needs-input no
  longer shows as a live chip or bumps sorting (a dead card advertising
  "working" was misinformation); done/review/blocked persist but render dashed.
  `done` sessions sink to the bottom of the Folders sort.
- Injection hot path: realpath + context-folder-signature caches (the signature
  walk ran per prompt per group on the hook's 3s-timeout path).

### Added — API accounts on remote hosts
- Per-session account switching now works for **remote sessions** too: the key
  ships to the host over **ssh stdin** into a mode-600 file and the spawn
  command references it via a shell prefix assignment — the key value never
  appears in any argv on either machine (verified end-to-end on a real remote
  host via /proc: remote CLI env has the key, zero cmdline leaks both sides).
  The Account selector now shows for remote Claude sessions; deleting an
  account best-effort removes its key file from all hosts.

## [2.43.1] — 2026-07-07

### Fixed
- Manage Agents dialog: widened to 560px and the accounts section switched to a
  column layout (buttons no longer truncate/wrap at the 440px default width).

## [2.43.0] — 2026-07-07

### Added — Anthropic account switching (subscription ↔ API, per session)

The CLI's `/login` is mutually exclusive — logging into a Console account wipes
the subscription OAuth (and vice versa), switching everything globally.
VibeSpace now keeps API keys in its own encrypted store and injects
`ANTHROPIC_API_KEY` into a session's spawn environment, so both identities
coexist and **every session picks its own billing account**:

- **Manage Agents → Anthropic accounts**: subscription login status, saved API
  keys (add / import the key a Console login minted / rename / delete / set
  default / Test), and a **"Set up both…" wizard** that walks ordinary users
  through the one-time choreography — Console login first (its key is captured
  automatically), then log back into the subscription. Login steps open a
  terminal; VibeSpace detects completion and continues by itself.
- **Per-session choice**: Account row in the New Session dialog and in the
  card's ⚙ config popover (persisted; applies to every resume path — resuming
  with a different account is how you move a conversation's billing, e.g. when
  the subscription weekly cap is hit).
- **Visibility**: API-key sessions show an amber key badge (name + key tail in
  the tooltip); the usage popup explains when the subscription is signed out
  and that API sessions never appear in the quota pies.
- Keys are AES-256-GCM encrypted at rest (mode-600 files) and travel only via
  the process-env channel — never argv (verified: zero /proc/cmdline leaks).

### Fixed
- Five `writeSessionMeta` callers rebuilt session meta from hardcoded field
  lists, silently dropping later-added keys (`agentToken`, `taskId`,
  `accountId`) on id-capture / rename / fork-adoption. All now merge into the
  existing meta.

## [2.42.0] — 2026-07-06

### Changed — session card / Task View
- The expanded card's **Task Groups** field now lists folder-auto-include
  membership too (marked "(folder)"), not just explicit tags — it was showing
  "None" for folder-derived members.
- Task View shows a session's group membership as **left color bars** (one per
  group, hover for the name/objective, click to open) instead of a badge row
  below the card — saves vertical space; multiple groups stack multiple bars.
- **Urgency defaults to `normal`** for any session that has a state (live or
  agent-declared), so it's no longer blank; the agent/user can still raise it.
  Sorting treats missing urgency as normal too.
- **Card background is tinted by urgency** in Task View (urgent → red, high →
  amber, normal → faint blue, low → faint grey; subtle).

## [2.41.1] — 2026-07-06

### Fixed
- Task View wrongly showed sessions as **untagged** when they belonged to a Task
  Group via an **auto-include folder** (not an explicit tag). Task View now uses
  the same membership rule as the Group board (`_getSessionTaskGroups` = explicit
  tag ∪ folder match), so a group's folder members appear under it.
- **Symlinked cwd**: a session opened under a symlinked path (e.g.
  `claude-code-webui` → `vibespace`) now matches a folder set on the real path.
  Discovery stamps a resolved `realCwd`; both the client membership check and the
  server's context injection (`groupsForSession`) match cwd or realCwd.

## [2.41.0] — 2026-07-06

### Changed — Task View follow-ups
- The **Groups | Tasks** switch is now a proper sub-tab bar under the
  Folders/Task Groups/Remote tabs (same visual language), not a segmented pill.
- Task View shows **all** sessions: tagged ones sorted on top, **untagged sunk
  to a labeled section at the bottom** (live/active untagged listed; the count
  of stopped untagged is surfaced with a pointer to Folders instead of piling
  thousands of historical sessions here).
- Added a **sort** control (Urgency+status / Status / Recent / Name) and a
  **status filter** (show only chosen states) above the list; both persist.
- The Tasks tab is no longer narrowed by the live/stopped status filter or the
  quick-view tabs — a Task Group's members (often stopped) always show. The bare
  **New Session** card is gone from the Tasks tab (it has New Task Group).

## [2.40.0] — 2026-07-06

### Added
- **Tasks tab — Groups | Tasks view toggle.** *Groups* is the existing board
  (Task Groups/岗位 with their member sessions). *Tasks* is a new flat view of
  every session tagged into a Task Group (活儿), sorted by urgency then status
  (blocked/needs-input float up, done sinks), each card showing its cwd and the
  group(s) it belongs to (click a group badge to open it). Choice persists.

### Fixed
- Session-state chip icon (working/done/…) was slightly low and a different size
  from the config-gear badge. Both icons are now a uniform 10×10 and the chip
  centers them (inline-flex); the state icon no longer hard-codes its own size.

## [2.39.0] — 2026-07-06

### Changed — Task Groups (岗位/活儿 concept refactor)

Aligned the task system to the intended model: a **Task Group** (岗位) is a
persistent role; a **session** is the unit of work (活儿); **status lives on the
session**, not the group.

- **Session status** gained `done`. A Task Group has no status — only archived
  (a role never "completes"). Removed the `vibespace-task status` subcommand and
  the `/api/agent/task-status` endpoint; `done` is reported via `vibespace-status done`.
- **Many-to-many, live belonging**: a session belongs to 0..N Task Groups,
  derived live (explicit tag / auto-include folder / spawned-into group). A
  UI bind/drag/folder change reaches the agent on its next turn with no respawn.
  Removed the single `session._taskId` and the `VIBESPACE_TASK_ID` spawn env —
  belonging is resolved server-side from the session token.
- **Injection** now covers every belonged group and re-injects a group whenever
  it changes — a UI edit, another session's `vibespace-task`, or files the user
  hand-writes into the group's context folder.
- **`vibespace-task --group <id>`** with enforced isolation — a session may only
  read/write Task Groups it belongs to.
- **Per-group injection toggle** (`injectContext`) — opt a group out of context
  injection while keeping it on the board and reportable via vibespace-task.
- **Checklist ↔ session** loose link: ticking a step records which session did it
  (informational, shown in the detail window).
- **Rename**: `TaskManager` → `TaskGroupManager`, `src/tasks.js` →
  `src/task-groups.js`, `data/tasks.json` → `data/task-groups.json` (migrated
  forward automatically on first boot; the legacy file is left in place).
  User-visible UI now says "Task Group". Wire names (JSON fields, API paths, the
  `tasks-updated` event, CLI command names) are kept for data/contract compatibility.

## [2.38.0] — 2026-07-06

### Added

- **Every VibeSpace-managed session now learns to report its status — not just task-bound ones.** Previously a session only got injected context (and thus only learned about `vibespace-status` / `vibespace-task`) if it was linked to a task; a plain session's agent had no idea it could report its state, so the board couldn't reflect what it was doing unless you'd bound a task. Now every VibeSpace session gets a small baseline injection at start teaching it `vibespace-status` (working / needs-input / blocked / review + urgency). Task-bound sessions still get the full task context (which already covers both tools). Injected once per session. This is delivered through the harness's own SessionStart/UserPromptSubmit hook — no message rewriting — and works without a task because session status is stored globally (`data/session-status.json`), independent of any task or context folder.

### Changed

- **Session-status disk writes are debounced.** The in-memory state and the live UI broadcast update immediately (as before), but the write to `data/session-status.json` is now coalesced (500ms) and content-compared, so a burst of status reports from many sessions no longer does a synchronous full-file write per update; flushed on exit. (Correctness was never at risk — single process + synchronous writes have no read-modify-write race — this purely cuts redundant I/O now that more sessions report status.)

## [2.37.5] — 2026-07-06

### Changed

- **The status-tag text↔icon switch measures against the title's DISPLAYED area**, not its full text. The name is flexible and its shown width shrinks as the tags grow, so a card collapses its status chip to an icon when the tags reach the *currently displayed* title width (`clientWidth`) — the accurate "the tags are out-widthing the visible title" signal. (2.37.4 compared against the untruncated text width, which was off once the title itself got squeezed.)

## [2.37.4] — 2026-07-06

### Changed

- **The status-tag text↔icon switch is now per-card and content-driven** (was a fixed sidebar-width threshold, which felt arbitrary). A card collapses its status chip to an icon only when its tags are as wide as the title, so tags never out-width the name. Re-measured per card on any width change.

## [2.37.3] — 2026-07-06

### Changed

- **Session cards back to two rows** (three wasted vertical space). Row 1 = a **connection-status dot** (LIVE/TMUX green, EXTERNAL amber, STOPPED dim, left of the name) + name + tags; row 2 (Tasks view) = the session's cwd. The intrinsic connection state is now that colored dot instead of a LIVE/STOPPED text badge — its label shows on hover and in the expanded card.
- **Status tags adapt to the sidebar width**: the working / needs-input / blocked / review chip shows its text on a wide sidebar and collapses to just an icon when the sidebar is narrow (CSS container query). Config stays a gear icon.
- **Instant hover tooltips**: icon-only badges (config gear, narrow status chips, the connection dot, host) show their label the moment you hover, via a custom tooltip — no more ~1s native-title delay.

### Fixed

- **Adding a folder to a task now refreshes the list immediately.** The task detail window used to skip re-rendering whenever any field was focused (to avoid clobbering what you were typing); it now skips only while a field actually has text, so an emptied add-field (right after you add a folder or step) refreshes and re-focuses for the next entry.

## [2.37.2] — 2026-07-06

### Changed — roomier card layouts

- **Session cards are now up to three rows** so the name is never crowded off: row 1 = the name alone; row 2 = its tags (role, a config gear, host, the status chip, and the connection badge); row 3 — in the **Tasks view** only, where a task's sessions can live in different directories — the session's own **working directory**, left-truncated so the meaningful tail is visible. Fixes the squeeze the always-on status chip introduced in 2.37.0 (names had collapsed to a single character).
- **Per-session custom config is a single gear icon**, with the model/effort/permission details in its tooltip (it used to print the full model id inline, e.g. "claude-opus-4-8", eating the row).

## [2.37.0] — 2026-07-06

### Task system review — status visibility, clarity, safer agent tools

- **See each session's status at a glance.** Every live session card now shows a status chip — working / waiting for input / blocked / review — synthesized from what VibeSpace already observes (the agent's own report if it made one, otherwise the idle/active signal). Chips the agent or you set are solid; ones VibeSpace inferred are dashed. **Urgency drives the sidebar order**: sessions the agent flagged urgent/high (or that are blocked / waiting for you) float to the top.
- **Recursive folders, now configurable.** A task's linked folders each have a "subfolders" toggle — on (default) auto-includes sessions anywhere under the folder; off restricts to sessions whose directory is exactly that folder.
- **New sessions recommend the task's folders.** Starting a session in a task floats its linked folders to the top of the working-directory suggestions (highlighted).
- **Clearer task detail.** "Plan" → "Checklist" and "Progress" → "Activity log" everywhere (the UI, the generated TASK.md, and the context injected into agents), each with a one-line explanation. "Repo file" is now "Export / Import" (with an Import button and a clearer description). The context-folder field no longer says "coming in P2" — it describes what it does. Task colors are now clearly visible on the board (a bold color bar + tinted title) instead of a 2px edge.
- **Agents are less likely to misuse the reporting tools.** `vibespace-task` / `vibespace-status` now print usage AND the current state when run with no arguments, list the valid subcommands on a typo, and catch the common "task status vs this session's state" mix-up with a corrective hint. The injected context spells out that the commands are already scoped to the agent's own task (no task id to pass), disambiguates the two enums, and tells the agent to self-check by running a command bare. The injected activity log is capped at the last 30 entries with a pointer to the full log.

## [2.36.1] — 2026-07-06

### Added

- **Workflow viewer now works while a run is in progress.** Previously "View Workflow" only worked after a dynamic workflow finished (the rich snapshot is written once at the end) — opening it mid-run showed "snapshot not found". It now falls back to a **live view** built from the run's journal + agent transcripts: a pulsing "Running" chip, an "N agents · M done · running…" line, and one row per agent (running/done) with a live-updating transcript via View Log. The panel polls every ~2.5s and automatically switches to the full phase/label/token view the moment the run finishes. (Phase names, labels and token totals only exist in the end-of-run snapshot, so the running view shows agent count + per-agent state + transcripts.)

## [2.36.0] — 2026-07-05

### Added

- **Workflow detail viewer (dynamic-workflow / ultracode observability).** When Claude runs a dynamic workflow in chat, its tool card now has a **View Workflow** button. It opens a panel showing the run's phases, every agent with its state (queued/running/done/error), model and the run's token/tool totals — and each agent has a **View Log** that opens its full transcript in the read-only viewer. This is a *post-hoc* view: Claude Code writes the rich phase/agent snapshot once, when the run finishes (live progress is a TUI-only render layer with no file or stream to read — verified empirically and against the third-party claude-view tool, which reaches the same conclusion). Killed/failed runs show their frozen mid-run state.

## [2.35.0] — 2026-07-05

### Added

- **Task updates reach the agent on its next message.** When a task changes (its objective, plan, progress, or status — edited in the UI or reported by another session), the agent gets the refreshed task context injected on its very next turn, marked as an update. It stays quiet when nothing changed. Works on both Claude (via its UserPromptSubmit hook) and Codex.
- **Codex chat now receives task context natively.** Previously Codex's app-server ignored the hook output, so Codex sessions didn't get auto-injected task context. VibeSpace now delivers it through Codex's own `thread/inject_items` (a developer-role message appended to the thread), verified end-to-end. Codex sessions started in a task now know the task — and get the same on-next-turn updates as Claude.
- **`run.sh` supervised launcher.** Starts the server and automatically restarts it if it exits (e.g. an out-of-memory kill under system memory pressure) — dtach sessions survive, so agents aren't lost. Bare `node server.js` stays down after a kill; `./run.sh` brings it back.

### Fixed

- **Ultracode effort in the chat effort menu.** The effort dropdown (and the per-session config) now offer **ultracode** (and the previously-missing xhigh). Researched the real mechanism from the CLI: ultracode isn't an effort *level* but a separate mode (xhigh + dynamic-workflow orchestration), so it's wired via the CLI's own `ultracode` settings key rather than as a bogus effort value.

## [2.34.0] — 2026-07-05

### Changed

- **Task context is now delivered ONLY through the harness's native hooks — never by rewriting your message.** The earlier approach of prepending context to the user's first message (for Codex and remote sessions) was removed: modifying the input stream bypasses the CLI's own mechanisms and is unstable. `vibespace-hook.mjs` now registers for **both** `SessionStart` (task context) and `UserPromptSubmit` (status-override notices, and first-prompt context where SessionStart doesn't fire), for both Claude Code and Codex.

### Added

- **Remote sessions get the full task integration (P3 remote).** Spawning a session on a remote host now opens an ssh reverse tunnel so the remote agent's tools and hook reach VibeSpace, distributes the `vibespace-status` / `vibespace-task` tools + the hook to `~/.vibespace/bin` on the remote, and registers the hook in the remote's own Claude/Codex config. Verified end-to-end on a real remote box: the agent received the task's context and reported progress back through the tunnel.
- **Repo task files (P4).** A task can be exported to a committable markdown file (YAML frontmatter + objective + plan + progress) from the task detail window, and imported back from such a file via the board's "Import…" card. The structured store stays authoritative — the file is a shareable projection, not a live-parsed source.

### Hardened (adversarial review before release)

- Remote spawn: the task id is now validated to the `T-…` shape and env values are shell-quoted before interpolation into the ssh command (closes a command-injection vector on the taskId).
- Task-context is strictly scoped to the session's own task (a per-session token can't read another task's context).
- Hook management: the "Remove" button is now durable (a persisted opt-out stops startup from re-registering); the status endpoint no longer errors on a hand-edited/malformed hooks file; config writes use a compare-and-swap to avoid clobbering a concurrent CLI write.
- Repo import tolerates CRLF files and preserves the progress log and objectives that contain markdown headings.

### Known limitation

- **Codex chat sessions do not yet receive auto-injected task context.** Codex's app-server (JSON-RPC) mode runs hook *commands* but does not inject their returned context into the model (verified empirically against codex-cli 0.142.5); the hook is registered and will work if/when Codex adds app-server hook-injection. Claude sessions (terminal + chat, local + remote) are fully covered.

## [2.33.0] — 2026-07-05

### Added

- **Hook management in Manage Agents** — the task-context hook now has a visible home: **⚙ → Manage agents…** shows a "VibeSpace integration" row with plain-language per-CLI status (installed / not installed / needs update / config unreadable) and one-click **Install / Reinstall / Remove**. It still installs itself automatically at server start; the dialog exists so non-engineers can see that it's working and fix it if it isn't. Removal only ever touches VibeSpace's own entry — other hooks are never modified.
- **`vibespace-task` — agents report task progress** — sessions started from a task can now write back to the board with their ordinary shell tool: `vibespace-task progress "what I did"` (timestamped, session-tagged), `plan-check <step>` / `plan-add "step"`, `status <active|paused|blocked|done>`, and `show`. Writes are validated and scoped server-side to the session's own task; the task detail window, board, and `TASK.md` update live. The injected task context teaches agents these commands automatically.

## [2.32.0] — 2026-07-05

### Added

- **Task context injection (P2)** — a session started or resumed **in a task** now begins with the task's context already injected: objective, plan, recent progress, an index of the context folder's files (the agent reads what it needs), and the working rules (don't touch the generated `.vibespace/`, share artifacts in the folder, report with `vibespace-status`).
  - **Claude**: via Claude Code's native SessionStart hook — registered automatically (idempotent, non-destructive to existing hooks), a no-op for any session not started from a VibeSpace task. Works for terminal and chat sessions, and re-fires on resume.
  - **Codex**: no session-start hook exists in current Codex, so the context rides on the session's first message (shown as a collapsible dim block).
  - VibeSpace now also generates `<contextDir>/.vibespace/TASK.md` — an always-current markdown mirror of the task state, kept in lockstep with every task change (the program is its only writer).
  - Verified end-to-end on both backends with a codeword placed only in the task objective — both models answered it.

## [2.31.0] — 2026-07-05

### Added

- **Session status indicators** — every session can carry a state (`working` / `needs-input` / `blocked` / `review`) + urgency (`low`→`urgent`) + reason, shown as a colored chip on the session card (urgent pulses). **Agents set their own status**: sessions now spawn with a `vibespace-status` CLI on PATH (per-session token auth) so an agent can report `vibespace-status blocked --urgency high --reason "…"` from its normal shell tool. **You can overwrite it** from the chip's popover — and if you change or clear an agent-set status, the agent is told in a note attached to your next message, so it learns your preference. Blocked sessions feed their tasks' ⚠ attention badges alongside idle-waiting.
- **New session in a task** — the New Session dialog gained a **Task** dropdown; the task board's + button and context menu open the dialog pre-filled (task selected, working directory = the task's first auto-include folder) while you confirm all parameters. The session is tagged to the task automatically and spawned with `VIBESPACE_TASK_ID` in its environment (groundwork for context injection).

### Changed

- **Your existing groups are now full tasks** — the migrated groups (kind `group`) were upgraded to kind `task` (status/objective/plan/progress available); fresh migrations now produce tasks directly.

## [2.30.0] — 2026-07-05

### Added

- **Task system (P1)** — the Groups tab grew into a **task board** (design: `docs/design-task-system.md`; tasks ⊃ groups, existing groups migrated automatically and behave exactly as before):
  - A task tags sessions across directories (many-to-many) and can carry a **status** (active/paused/blocked/done), **objective**, **plan checklist**, and **progress log** — all stored server-side in `data/tasks.json` (authoritative for everything the board shows, synced to every client live).
  - **Task detail window**: structured editor for all of the above, plus bound sessions (with unbind and dim "via folder" rows), auto-include folders with path autocomplete, a **context folder** designation (its content will be injected into bound sessions in an upcoming release), and a board color.
  - **Attention**: when a bound agent finishes and waits for input (the same idle detection that blinks window titles), the task header shows a blinking **⚠ N** and the Tasks tab itself lights up — a board-level "which agents need me" view. Observation only; VibeSpace never drives the agent.
  - Bind from the session card (Tasks ▾ checklist), by dragging a card/folder onto a task header, from the file explorer ("Add to task"), or via folder auto-include. Right-click a task for Details / Rename / Status / Convert to task / Linked folders / Delete.
  - Legacy `sessionGroups`/`groupFolders` in user-state migrate once into `kind:'group'` tasks and stay dormant; tasks are included in config export/import.

### Fixed

- **Archived folders now cover future sessions** — "Archive project" records the folder itself (`archivedFolders` in user-state), so a session created in that folder later starts archived instead of popping the project back into Recent (the final piece of the "archive didn't stick" saga). The same button unarchives the whole project; unarchiving a single session dissolves the folder rule into per-session archives so it sticks.

## [2.29.1] — 2026-07-05

### Added

- **Model auto-fallback warning** — when the harness silently swaps models mid-session (e.g. Fable overloaded → served by Opus; the CLI writes a `fallback` marker), the chat now surfaces it: the status-bar model badge turns amber with ⚠ and the actual serving model (tooltip explains; click to re-pick), and a dim system notice appears in the stream. Clears automatically when the requested model is served again. Alias-tolerant ("fable" vs "claude-fable-5" is not a false positive).
- **Mid-session model/effort picks persist** — choosing a model or effort from the chat status bar now saves it as that session's per-session config (the same store as the Resume gear popover), so the next resume starts with the same choice.

## [2.29.0] — 2026-07-05

### Changed

- **Storage is now one flat list of connections** — the special "My storage" card is gone. Every place your files live (S3, Google Drive, Nextcloud/WebDAV, SFTP, an imported share, another VibeSpace) is an equal row in one list; **Connect storage** adds any type and connects it in one step. This removes the confusing split where S3 had a privileged card while everything else lived in a separate list (and the "is my Google Drive "My storage"? how do I mount it?" confusion).
- **Sharing moved onto the connection** — instead of a global "share" button tied to the special slot, each S3 connection that holds your own full credentials shows a **share** button on its row that mints a down-scoped link for a subfolder. It reads the credentials straight from that connection, so no separate owner-key config exists. Imported shares and non-S3 types don't show it (they can't mint).
- Legacy `VIBESPACE_S3_*` / earlier `myStorage` config auto-migrates to a normal S3 connection named "My storage" on first boot. Verified end-to-end (mint from a row → import → read a real MinIO object).

## [2.28.7] — 2026-07-05

### Fixed

- **“Archive project” now archives the WHOLE folder** — the Recent-zone project archive button only archived the sessions it showed (the last 7 days, capped), leaving the folder’s older sessions un-archived. Those reappeared later (surfaced by History or a fresh discovery after a server restart), which looked like the archive hadn’t stuck. It now archives every session under that working directory. (Session archive state itself was always persisted correctly — server-side in `data/user-state.json` and client-side in localStorage — verified surviving a restart + refresh.)

## [2.28.6] — 2026-07-05

### Changed

- **Plain-language storage actions** — the primary buttons now say **Connect** / **Disconnect** instead of “mount”/“unmount” (footer “Connect storage”, per-row Connect/Disconnect, “Import & connect”); “mount” remains only in tooltips and advanced contexts. The two share buttons are now symmetric — **Share a cloud folder** (from your S3 storage) vs **Share a local folder** (a folder on this machine, over the bridge) — so the difference is obvious.

## [2.28.5] — 2026-07-05

### Fixed / Added

- **Share a folder from the file explorer** — folder right-click and the background menu gain “Share this folder…”, which opens the bridge-share dialog with the path prefilled (local explorers only). Previously sharing was reachable only from the Storage tab.
- **File-explorer submenu no longer sticks** — hovering a plain menu item now dismisses an open sibling submenu (e.g. the “Sessions ▸” flyout) instead of leaving it floating.
- **Properties opens instantly** — the dialog appears immediately with the fast info filled in and the recursive folder size streams in afterward (“calculating…”), instead of the click hanging for seconds on a big folder’s `du` and popping up later.
- **Machines connectivity auto-checks** — hosts are probed automatically on the Remote tab (and re-probed when older than 2 minutes), updating each dot in place, so status is meaningful without clicking the link button.
- **Remote tab no longer flickers** — the session poll no longer rebuilds the whole Storage/Machines panel every few seconds; it repaints only on real changes (and even then keeps the old panel up until the new one is ready).
- **Advanced options fields fixed** — the collapsed “Advanced options” inputs were rendering at ~half width because they’d dropped out of the dialog’s flex layout; they’re full-width again. The label no longer says “rclone”.
- **Path fields get autocomplete** — the bridge-share folder, SFTP key/remote paths, and custom mount path now have the same Tab/type-ahead directory completion as the file explorer’s path bar (SFTP remote path completes over the chosen host).

## [2.28.4] — 2026-07-05

### Changed

- **Storage/Mounts UI made non-engineer friendly** (from a full UX audit). S3 fields now explain themselves ("Server address (endpoint)", "Bucket (storage container)", "Access key — from your provider's Access Keys page", etc.) with a where-do-I-get-this hint on each; source types read in plain language ("Cloud storage (S3 / MinIO)", "A server over SSH (SFTP)"); RO/RW render as "Read-only"/"Read-write"; share descriptors say "expires in 7 days" / "no expiry" instead of "STS"/"revocable". Advanced knobs (extra rclone options, custom mount path) collapse under an "Advanced options" disclosure. "Mint"→"Create", "Bootstrap"→"Set up", "Host"→"Machine"; the empty state and notes no longer mention `VIBESPACE_S3_*`, `mc`, or `STS`. Section headers gained one-line descriptions, and the SSH-key picker and public-key instructions now explain what a key is and what to do with it. Mount errors are prefixed "Couldn't connect:".

## [2.28.3] — 2026-07-05

### Added

- **Import an rclone config file** — Storage → *Import rclone config* takes a pasted `rclone.conf`, previews every remote in it (name + backend type; wrapper remotes like `crypt`/`alias` shown greyed as unsupported), and imports the ones you tick as mounts. Verified end-to-end against real MinIO.

### Fixed

- The Cloudflare Accept-Encoding signing fix (and V2-auth probe) now applies to **any** s3-backed mount — custom-rclone and rclone.conf-imported s3 remotes, not just the native S3 type — so object reads through a proxied endpoint no longer hang.

## [2.28.2] — 2026-07-05

### Added

- **Custom rclone backends** — a new *Custom (any rclone backend)* mount type takes any rclone backend name (dropbox, b2, azureblob, mega, …) plus its config as `key = value` lines, so anything rclone supports can be mounted without waiting for a dedicated type. Verified end-to-end (S3 backend via the generic path).
- **Extra rclone options on every type** — an advanced `key = value` field merged into the rclone config of any mount (custom API keys, tuning flags like `chunk_size`, provider quirks).
- **Custom Google Drive OAuth client** — optional client ID/secret fields (your own Google Cloud project, avoids rclone's shared quota); the guided Connect flow uses them too.

All custom param values are AES-256-GCM encrypted at rest like every other secret.

## [2.28.1] — 2026-07-05

### Added / Changed

- **No terminal needed for mounts.** Google Drive now connects with a guided **Connect Google Drive** button — VibeSpace runs the OAuth handshake (server resolves the real Google consent URL; same-machine browsers complete hands-free, remote deployments paste the redirect address back) and fills the token automatically. No more `rclone authorize` on the command line.
- **One-click rclone install** — if rclone isn't present, the Storage section offers an **Install rclone** button that downloads the official pinned binary into `data/bin` (no package manager). All mounts use it automatically.
- **SFTP prefill from registered hosts** — pick a host in the SFTP add-mount form and its address/user/port/key are filled in.
- Per-field help text in the add-mount dialog (e.g. where to find a Nextcloud WebDAV URL).

## [2.28.0] — 2026-07-05

### Added

- **Multiple mount source types** — the Storage section's **Add mount** now supports S3/MinIO, **Google Drive** (paste the `rclone authorize "drive"` token), **WebDAV / Nextcloud**, **SFTP** (ssh host + key/password), and **another VibeSpace** — one dialog, per-type fields. All secrets AES-256-GCM encrypted at rest; rclone-obscured passwords are obscured only at mount time. Verified SFTP end-to-end against a real host (read + write).
- **VibeSpace-to-VibeSpace mounting (WebDAV bridge)** — **Share via bridge** mints a scoped mount token (`vsmt_…`) + `vibespace-mount:v1:…` link for a folder of this machine; another instance imports it to mount that folder RO/RW. Tokens are stored hashed, carry a chroot root + ro/rw enforced on every request (traversal and symlink escapes rejected), and are revocable. The bridge is standard WebDAV (`/dav`, Bearer auth), so rclone/Finder/phone file managers can mount it too. Verified loopback: RO write-block, scope enforcement, RW round-trip.
- **My storage configured in-app** — the personal S3 store (and share-minting owner key) is now set in the UI (Storage → Configure S3… / Edit), encrypted in config. `VIBESPACE_S3_*` env vars are imported once on first boot for backward compatibility, then the in-app config is canonical and rides in config export/import. Env vars are no longer required.

## [2.27.2] — 2026-07-04

### Fixed

- **Mobile rendered desktop chrome customization** — a custom arrangement (e.g. desktop previews moved into an extra toolbar row) was applied on phones too, drawing the extra row on top of the mobile UI. Arrangement/springs are now desktop-only (mobile keeps its own chrome), plus a media-query guard hides the extra bar rows on small screens outright.

## [2.27.1] — 2026-07-04

### Fixed

- **Mounts through Cloudflare-fronted MinIO** — proxies that rewrite the `Accept-Encoding` header broke rclone's SigV4 signature (`SignatureDoesNotMatch`; reads silently retry-looped, looking like a hang). Mounts now add `--s3-use-accept-encoding-gzip=false` when the installed rclone supports it (1.63+), and a one-time signing probe falls back to V2 signatures for permanent-credential mounts on rclone builds where the flag doesn't help (≥1.70, aws-sdk-go-v2). STS shares on such builds fail with an explanatory error instead of hanging. Verified end-to-end against a real Cloudflare-fronted MinIO: RW mount, STS share mint → import → RO read/write-block, server-restart adoption, revoke.

## [2.27.0] — 2026-07-04

### Added

- **Host color strips** — session cards and project headers carry a second, inner 3px strip in a stable per-host color next to the outer project strip (no inner strip = this machine), so mixed local/remote sessions in the Active zone separate at a glance.
- **History has its own host switcher** — independent of Recent's: browse one host's recent work while digging through another's (or Local's) history. Explicit host-scoped empty states ("No sessions older than 7 days on the devbox") so an empty zone reads as data, not breakage; picking a host auto-expands the zone.

## [2.26.0] — 2026-07-04

### Added

- **Remote session history over ssh** — the server fetches a remote session's JSONL into a local cache (invalidated by remote size+mtime; one ssh stat when fresh) whenever you view or resume it. Pre-resume history now renders in the chat window (verified: 342-message remote transcript), View History works for remote sessions, and pagination/search/minimap all operate on the cache like a local transcript. This also removes the failure mode where a live reply could be lost on a history-less remote attach.
- **Remote cards are now full session cards** — same card as local sessions: real name extracted from the first user message during discovery (string- and block-form content), host badge, star/archive, expand panel with details, View History and Resume buttons. The stripped-down two-line remote card is gone.

## [2.25.0] — 2026-07-04

### Added

- **Recent + History host switcher** — the sidebar's Recent section can switch from Local to any registered remote host (one switcher scopes both zones: Recent = that host's last 7 days, History = its older sessions, same time split as local): sessions on that machine are discovered live over ssh (lock-first, cached 15s, no background polling), grouped by project with per-host colors, and stopped ones resume **on that host** with one click (verified end-to-end: same session id, full model context restored, live replies). Running remote sessions show a REMOTE badge. Includes a re-scan button; the selection persists per browser.
- Remote discovery hardening: works when the remote login shell is zsh (an unmatched glob previously aborted the whole scan → "0 sessions"), skips subagent transcripts, and extracts each session's real cwd from the JSONL head (the encoded project dir name is ambiguous).

### Fixed

- `/api/active` and the on-connect WebSocket session list both dropped `host`/`hostName` — remote sessions lost their host badge and host-prefixed grouping after every refresh/reconnect until the next broadcast.

## [2.24.0] — 2026-07-04

### Added

- **Terminal host picker** — the toolbar Terminal button lists Local + registered remote hosts when any are configured (direct local shell otherwise); "Open Terminal Here" in a remote explorer opens the shell on that host in that directory.
- **Host-aware bookmarks** — bookmarks record the host they were created on: remote bookmarks show a host badge, and clicking one switches the explorer to that host and navigates. Dedup, drag-to-bookmark, and "Open in new window" are all host-aware.
- **Explorer host persistence** — file explorer windows restore their host across page refreshes, layout sync, and presets (an `the devbox: /tmp` window no longer comes back as a local `/tmp` window).

## [2.23.2] — 2026-07-04

### Added

- **Cross-host folder transfer** — folders now copy/move between hosts directly (drag between explorer windows, or copy/paste): the source streams a `tar` of the tree through the server into a `tar` extract on the destination. No temp archive; permissions, executable bits, and symlinks preserved. Renaming during transfer works, existing destinations return a conflict prompt, and cross-host *move* removes the source after a successful transfer.
- **Cross-host copy/paste** — the file clipboard now remembers which host it was copied from, so Copy on one host + Paste on another transfers the items (previously the paths were misread as belonging to the destination host).

## [2.23.1] — 2026-07-04

### Added / Fixed

- **Cross-host drag between file explorers** — drag a file from one explorer window to another on a different host and it transfers automatically (same host = remote cp; cross-host or host↔local = streamed through the server). Verified both directions against a real remote.
- **Project colors clarified** — the per-project color now appears at project level: Recent headers carry a colored dot naming each project's color, and both Active and Recent cards of the same project share that color's left strip, so a running session ties to its Recent siblings at a glance.
- **Fixed:** the per-terminal ⚙ settings popover was invisible (missing `position:fixed` laid it out off-screen) — clicking it now shows the theme/font controls under the gear.

## [2.23.0] — 2026-07-04

### Added (collaboration)

- **Files across hosts** — the file explorer gains a host dropdown next to the path bar: browse and *edit* files on any registered ssh host with full parity (list / open / create / rename / delete / upload / download / compress / extract / properties), each op one ssh command reusing the host's key. Drag or copy a file between two explorer windows on different hosts and it transfers automatically (same host = remote cp; cross-host or host↔local = streamed through the server). See [docs/files-cross-host.md](docs/files-cross-host.md).

## [2.22.0] — 2026-07-04

### Added / Changed (remote + session management)

- **Remote hosts, verified against a real box.** Register an ssh host (paste/upload a private key or reuse `~/.ssh`), one-click connectivity test (latency + which of dtach/node/claude/codex are installed → toast + READY badge), and a **Bootstrap** dialog with a live streaming log that idempotently installs the missing tools.
- **Remote sessions everywhere they make sense.** New Session gets a Host dropdown and a **Terminal (plain shell)** backend (the form adapts — no model/permission rows for a shell); choosing a host re-sources the working-directory autocomplete and recent-path chips over ssh. Manage Agents gets a Machine dropdown so you can check/log-in/update a CLI on a remote host.
- **Batch session management.** A manage-mode toggle in the sidebar lets you *mark* running sessions to terminate and/or archive without the list reshuffling; a top bar shows the count and applies everything at once.
- **Automation terminals are throwaway.** Login/update helper terminals now always terminate when you close them, instead of lingering as detached shells.
- Mobile uses the same three-zone workbench; the oh-my-zsh update prompt no longer eats the first character of auto-typed commands.
- **Archive a whole project in one click** — each Recent-zone project header has an archive-all button, for folders full of throwaway sessions.
- **Config export/import now covers remote hosts and S3 mounts** (opt-in, encrypted): migrating to a fresh instance carries your ssh hosts + uploaded keys and your mount definitions + credentials, not just settings.

### Changed (session list redesign)

- **Three-zone workbench** — the Folders tab now renders ACTIVE (every running session as a two-line card: name + badges, dim abbreviated path below, per-project colored strip, starred first, same-project adjacent) / RECENT (stopped in the last 7 days, grouped by project, capped at 5 per project with expanders — session floods can't bury the list) / HISTORY (collapsed + search-first; typing in the filter searches it, expansion pages 60 at a time). A dozen live agents are now one glance instead of a scroll through thousands of stopped cards.
- **Ctrl+K session palette** — fuzzy switcher over every session (name/path/host; live first). Enter focuses a live session or resumes a stopped one; typing a `/path` or `~path` offers "new session here". Works everywhere except inside terminals.
- **Unified filter** — Status / Backend / Location / Agent sections in ONE popover behind the funnel button; the separate live-filter button and its row are gone.

## [2.21.0] — 2026-07-04

### Added (collaboration P2)

- **Remote hosts** — the sidebar tab (renamed **Remote**) gains a Hosts section: register ssh machines (your `~/.ssh` keys, or an app-generated ed25519 key with the public key surfaced for `authorized_keys`), one-click **connectivity test** (latency + which of dtach/node/claude/codex are installed → READY / NEEDS SETUP badge), and **Bootstrap** — a step-progress dialog with an expandable live log that idempotently installs dtach, Node.js (nvm) and the Claude CLI on the target.
- **Remote terminal sessions** — the New Session dialog has a Host dropdown; the session runs as `local dtach → ssh -t → remote dtach → claude`, so network drops and local server restarts never kill the remote agent. Remote sessions mix into the main session list grouped under a `host:` prefix with a host badge.
- **Location filter** — the backend-filter popover gains a Location section: show only Local sessions or only those on chosen hosts.
- **Remote chat sessions** (P3 core) — the Host dropdown works for chat mode too: stream-json flows over a clean `ssh -T` pipe through the existing chat-wrapper/normalizer stack (the full chat UI — permissions, tools, status bar — against a remote agent). Trade-off vs terminal mode: an ssh drop ends the remote process (the transcript survives on the remote and is resume-able); terminal mode keeps the remote agent alive through drops via remote dtach.
- Remaining for later: resuming remotely-discovered stopped sessions, merging remote discovery into the main list, remote transcript search.

## [2.20.0] — 2026-07-04

### Added (collaboration P1)

- **Mounts tab** (sidebar, next to Folders | Groups) — rclone-backed shared S3 storage:
  - **My storage**: instances provisioned with `VIBESPACE_S3_*` env get a one-click mount of their bucket prefix.
  - **Share a folder**: mint a *down-scoped* credential for any folder under your prefix with your own key — permanent revocable MinIO service accounts when `mc` is available (bundled in the Docker image), STS AssumeRole temporary credentials (≤7 days) otherwise. Revoke from the "Shares I created" list.
  - **Import share link**: paste a `vibespace-share:v1:…` link → the folder mounts read-only/read-write as granted. Links embed the credential — treat them as secrets.
  - Mounts survive server restarts (detached rclone, adopted on boot + auto-remount), credentials are encrypted at rest and never appear in argv, mount base configurable (`VIBESPACE_MOUNT_BASE`, default `~/vibespace-mounts`) with per-mount custom paths. See [docs/mounts.md](docs/mounts.md).

## [2.19.0] — 2026-07-04

### Added

- **Config export / import (Backup & migrate)** — ⚙ menu → Backup & migrate… exports the whole instance configuration to a single JSON file: settings (incl. Customize-UI arrangement), custom themes, layouts & virtual desktops, session metadata (stars/renames/groups/per-session configs), file bookmarks, and this browser's preferences. **Sensitive items are opt-in and always encrypted** (AES-256-GCM under an export passphrase): the VibeSpace password record and Claude/Codex CLI credentials — so migrating to a fresh container can carry your logins without ever writing them in plaintext. Import (same dialog / the onboarding wizard) shows the file's contents with per-section checkboxes; each selected section replaces the current data. Login tokens are never exported.
- **In-app password management** — ⚙ menu → Set/Change password…: set a password (enables auth), change it (requires the current one), or remove it (disables auth). Setting or changing **logs out every other device**; the acting browser keeps a fresh session. A password set (or removed) in-app always wins over `VIBESPACE_PASSWORD` at the next boot.
- **Onboarding wizard: "Protect this workspace" step** — set a password, generate a random one, or skip; plus an "Import a config file" entry so a new container is password-protected and fully configured in one step.
- **⚙ menu reorganized** — grouped with separators (workspace tools / data & security / help) after the flat list grew too long; export+import merged into one tabbed "Backup & migrate" dialog.

## [2.18.0] — 2026-07-04

### Added

- **Customize mode** — a Firefox-style edit mode replacing settings-list hunting for chrome customization (⚙ menu → **Customize UI…**, or right-click empty toolbar/taskbar space). The workspace dims and every customizable element is outlined *on the real UI*: click an element to hide/show it (hidden elements stay dimmed on the canvas while editing, so nothing ever disappears), hover for a what-is-this tooltip, and segmented pills float next to the bars they control — taskbar position (Bottom/Top) + visibility (Show/Auto-hide/Hidden), sidebar position (Left/Right). Bottom panel: Reset / All settings… / Done; Escape exits. Everything writes the existing settings keys, so persistence and multi-client sync are unchanged.
- **Drag elements between bars** (in Customize mode) — every customizable element can now be *dragged* to reorder it within its bar or move it to a different bar entirely: toolbar center, toolbar right, or the taskbar tray. A ghost follows the cursor, target zones light up, and an insertion marker shows exactly where it will land. The flagship workflow: drag the desktop previews and usage donuts into the toolbar, then hide the whole taskbar — nothing is lost. Arrangement persists (`chrome.arrangement`) and syncs across clients; Reset restores the stock layout. Core anchors (☰, ⚙, the window-item strip) stay put by design; New Session is movable but never hideable.
- **Move from the sidebar** — session cards' expand panel gains a **Move** button that starts window Move mode (window follows the cursor, click to place), switching to the window's desktop first. This is the recovery path for a window accidentally dragged off-screen with no grabbable title bar.
- Toolbar **Terminal** and **Presets** buttons are now hideable too (`toolbar.showTerminalButton`, `toolbar.showPresetsButton`).
- The taskbar right side is now a **tray** (`#taskbar-tray`): desktop previews, usage meters, and the window counter sit in one horizontal row (previously usage/count were stacked in a fixed column) — each independently hideable, orderable, and movable.
- **Alignment controls** (in Customize mode) — mini alignment chips appear next to each alignable area: window items left-aligned or centered (Windows-11 style), toolbar-center content left/center/right, and the tray at the taskbar's left or right end. Persisted as `chrome.zoneAlign`, synced, covered by Reset.
- The window counter is now a **compact chip** — a window-stack icon + bare count (tooltip carries the full "N windows — click for window list" label) instead of a wide text label that wasted tray space.
- **Springs (flexible space)** — the "+ Spring" button in Customize mode inserts an invisible flexible spacer (macOS-toolbar style) that pushes its neighbors apart; drag it between elements for justify-between layouts (previews centered, usage pushed right, etc.). Springs show as hatched ↔ bars while editing; click one to remove it.
- **Extra bar rows** — two optional full-width rows (below the toolbar, next to the taskbar) that appear when you drag elements into them and vanish when emptied. E.g. give the layout presets their own row under the toolbar.
- Fixed: desktop preview labels disappeared when previews were moved into the toolbar — they now shrink to fit instead of being hidden.
- **Configurable springs** — click a spring to open its config popover: **Flexible** with a strength weight (1–9; two springs at 1× and 3× split the leftover space 1:3) or **Fixed** width in px (a rigid spacer — e.g. mirror the "☰ VibeSpace" section's width at the start of an extra row so both rows' centered content lines up on the same axis), plus Remove. Live-applied, persisted (`chrome.springs`), synced.
- Fixed: the window-list popup always opened upward — off-screen when the window-count chip is hosted in the top toolbar. It (and the tab-group list) now flips below the anchor when there's no room above; the per-window right-click menu likewise opens downward when invoked in the top half of the screen instead of being bottom-anchored.
- Window-list rows are now **right-clickable** with the same per-window menu as taskbar items (Move / Minimize / Move to Desktop / Close). The list stays open under the menu (right-clicking used to dismiss it, which felt jarring) and refreshes in place after the action.
- **Spring width sources** — fixed springs now take px or **% of screen width** (unit toggle converts in place), and the **Match…** button enters a width-pick mode: click any bar element (e.g. the "☰ VibeSpace" section) to copy its width into the spring, keep clicking to sum several elements, Done/Escape to finish. One-click recipe for aligning an extra row's center with the toolbar's: spring at row start → Match → click the VibeSpace section. While picking, the config popover parks mid-screen so it can never cover the element you're trying to click.

### Fixed

- **Disconnected chat input is no longer frozen.** While the server connection is down, the input box used to be disabled with pointer-events off — you couldn't even select the text you'd already typed to copy it. Now the input stays fully interactive offline: select, copy, keep drafting (drafts sync after reconnect); only *sending* is blocked, with a toast and your draft kept intact. The send button dims to show the state.

## [2.17.0] — 2026-07-03

### Added (team deployment)

- **Password authentication** (optional — off unless configured). Set `VIBESPACE_PASSWORD` or let the container generate one. Guards all pages, APIs, WebSockets, and the browser proxy; login sessions are HttpOnly-cookie tokens persisted server-side (survive restarts, 180d), per-IP rate limiting on the login form, Sign out in the ⚙ menu, automatic bounce to `/login` when a token expires mid-session.
- **Docker deployment**: `Dockerfile` + `docker-compose.yml` — dtach/zip/git/Claude CLI included, runs as non-root (required for bypassPermissions), volumes for data / Claude credentials / workspace, and a **random workspace password generated + printed on first boot**. See [docs/deployment.md](docs/deployment.md).
- **UI chrome customization** (Settings → Toolbar & Layout): taskbar docked top or bottom, sidebar docked left or right, and show/hide toggles for the taskbar itself, desktop previews, usage donuts, the window counter, layout presets, and the Browser/Files toolbar buttons — all live-apply, all synced across clients.
- **Fixed: messages frozen after a server restart** (the status label kept updating but no new messages appeared). Message IDs are a per-normalizer counter; a server restart rebuilds the normalizer and the new numbering collides with what the client already rendered — new messages were silently swallowed by duplicate detection. The attach payload now carries a normalizer epoch; when a client reconnects across a restart it detects the epoch change and reloads the whole view from the fresh payload instead of incrementally catching up. Verified live: restart → epoch change → history intact → new message renders without refresh.
- **Toolbar polish**: all toolbar buttons are now a uniform 26px with truly centered icons (inline SVGs were baseline-aligned, sitting low next to their labels; the text-only New Session button computed a different height). New Session gains a matching plus icon.
- **Shell terminals** no longer show zsh's stranded inverse-video "%" artifact at the top (PROMPT_EOL_MARK suppressed in the spawn env — the width-mismatch between PTY spawn size and client replay size left it visible).
- **Manage Agents dialog** (⚙ → Manage agents…) — one place for CLI lifecycle: per-backend install/version/login status, **Log in** and **Update** buttons (claude update / npm upgrade for Codex), Re-check. All actions run visibly in a terminal window. Replaces the separate login menu entries.
- **Fix**: the New Session dialog's Working Directory input was ~half the width of its sibling fields (the autocomplete wrapper had no width rule).
- **First-run onboarding wizard** — a fresh instance greets new users with a 3-step tour: what VibeSpace is → live Claude/Codex install+login status with one-click in-product login → pick a folder and start the first session. Re-runnable anytime from ⚙ → "Show welcome tour". New `GET /api/backend-status` reports CLI install/version/login state.
- **Plain shell terminals** — a Terminal toolbar button (and "Open Terminal Here" on any folder) opens your login shell in a normal window: same dtach persistence, multi-device sync, and window management as agent sessions, no AI attached. Great for git, builds, and one-off commands without leaving the workspace.
- **In-product CLI login** — ⚙ menu → "Log in to Claude" / "Log in to Codex" opens a shell with the CLI already started, so non-terminal folks can complete the OAuth flow without knowing any commands (a fully guided wizard is on the collaboration roadmap).
- **Auto-hide taskbar respects the sidebar** — it previously spanned the full viewport width and slid underneath the open sidebar; it (and its reveal hotzone) now inset by the sidebar's live width on the correct side, following opens/closes/resizes with the same animation.
- **Taskbar auto-hide** — `taskbar.visibility`: always visible / auto-hide (slides off-screen, reveals when the pointer touches the edge) / hidden.
- **Right-click customization** — right-click empty taskbar or toolbar space to toggle chrome elements in place (the same settings, one click closer), the pattern desktops and browsers use.
- **Hardening**: a malformed client WebSocket message can no longer crash the server (found when an array reached a string-expecting handler — the whole process died; the dispatch is now isolated per message).
- **Fix**: the new enum settings (positions) rendered as blank dropdowns — options were plain strings where the settings UI expects value/label pairs.
- **Collaboration & remote-session design** ([docs/design-collaboration.md](docs/design-collaboration.md)): multi-host gateway architecture, shared-storage recipes (NFS / JuiceFS-on-S3 / rclone), team memory conventions, cross-host session migration ("a session is one JSONL file"), identity/presence roadmap.

## [2.16.0] — 2026-07-03

### Fixed

- **Chat status bar survives refresh/restart properly.** Two gaps: (1) the context%/cache/usage lookup only scanned the newest 200 records, but hundreds of stdout-only system records (which never dedup against the transcript) sit at the end of the merged history — the scan missed every assistant usage record and the context pie vanished on refresh (scan depth now 2000); (2) the reasoning-effort badge was only kept in memory — now persisted in session metadata (like the permission mode) at create/resume and on every mid-session effort change, so it survives server restarts. Sessions started before this fix show `effort: ?` until their next effort change or recreation (the CLI never reports effort back).
- **Minimap/search jumps no longer drift away ~1.5s after landing.** Re-enabling content-visibility after a jump collapses off-screen elements *asynchronously*; the old one-shot scroll compensation measured before the collapse (and delta-tracking fought the browser's own scroll anchoring — observed scrollTop yanked to 0). The restore now simply replays the landing: re-centers the jump target (or the exact search match range) with the proven multi-frame convergence, skipped if you already scrolled away.
- **Reconnect polish**: while the server is down, each failed 2s retry appended another "Disconnected from server" marker to every chat window — now exactly one Disconnected/Reconnected pair per outage. Reconnect catch-up also clamps its window accounting (server totals can shift across restarts), fixing a drifted position indicator.

### Added (File Explorer overhaul)

- **Archives**: right-click files/folders → **Compress to Archive** (.zip / .tar.gz / .tar / .tar.xz, multi-select supported); double-click a .zip/.tar.* → **contents preview** (entry tree with sizes, filter box, "N files · X MB uncompressed" summary); click an entry inside the archive to open it with the normal viewer (code, images, PDF — extracted on demand, nothing else touched); **Extract Here / Extract to Folder…** on archive files and **Extract All** in the preview (existing files are never overwritten). Folders get **Download as Zip** (streamed, no temp file).
- **Multi-select**: Ctrl/Cmd+click toggles, Shift+click selects a range, Ctrl+A selects all; right-click a selection for bulk Compress / Copy / Cut / Delete.
- **Copy / Cut / Paste**: full clipboard for files and folders (context menu or Ctrl+C/X/V), works **across explorer windows** — cut items show dimmed until pasted; pasting into the same folder auto-renames ("name (copy)"); name conflicts ask once whether to overwrite. Plus one-click **Duplicate**.
- **Background right-click menu**: Paste, New File, New Folder, Select All, Refresh, Copy Path, Properties (previously right-clicking empty space did nothing).
- **Properties dialog**: type, size (recursive for folders via du), item count, modified/created times, permissions — for any file, folder, or the current directory.
- **Keyboard**: Delete key deletes the selection (with confirm); icon view now supports the same right-click menu as list view.

## [2.15.0] — 2026-07-03

### Security

- **Fixed stored XSS in six UI surfaces.** Session working-directory paths (sidebar folder headers), layout-preset names/themes, drag-ghost window titles, the Codex plan badge, and the image-zoom overlay all interpolated user- or peer-controlled strings into `innerHTML` without escaping. Because these values sync across all connected clients, a session in a directory named `<img onerror=…>` (or a maliciously-named preset) could run script in every browser that rendered it. All are now escaped; the image overlay is built by DOM property assignment (defeating the decoded-`data:`-URL escape).
- **Fixed CSS injection via custom-theme keys.** The theme sanitizer only stripped `{}` from values, not keys — a variable named `--x:red} *{…` broke out of the rule to inject arbitrary CSS on every client. Keys are now validated as `--custom-property` names and values reject CSS-breaking chars, on both the client and the server.

### Fixed

- **CRITICAL: sessions spawned by a server that was itself (re)started from inside a Claude Code session silently never persisted their conversations.** The server inherited the parent session's `CLAUDE_CODE_CHILD_SESSION=1` env var and passed it to every CLI it spawned; that single variable puts Claude Code into child-session mode — no lock file, no project transcript. Conversations looked fine live, but terminate + resume (in the WebUI **or** in the CLI itself) lost everything after that point. The server now strips the inherited Claude session env at startup (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_EFFORT`, stale `CLAUDE_WEBUI_*`) and, on restart, names any still-running sessions that were spawned poisoned (they stay transcriptless until recreated). Verified end-to-end: terminal conversation → terminate → resume in chat now shows the terminal turns.
- **A session could become permanently un-openable.** Closing a chat/view window while its attach was still in flight (common on huge sessions) leaked the one-time handler and left a phantom session entry, so the window's "focus existing" path returned true forever and the session couldn't be reopened until reload. The attach handlers now drop themselves when the window is gone or the server replies with an error (matching the create path).
- **Scroll-up pagination could lock permanently.** A failed history fetch (e.g. server restart mid-scroll) left the `_loading` flag stuck `true`, blocking all further pagination. Wrapped in try/finally.
- **One buggy handler no longer drops WebSocket messages app-wide.** The client WS dispatch now isolates each handler in try/catch, so a throwing (e.g. disposed) handler can't abort delivery of `layout-sync`/`settings-updated`/`editor-open` to everything after it.
- **Search: pressing Escape right after typing no longer leaves stuck highlights.** The debounced search timer is now cancelled on clear.
- **Jumped-to history browses in both directions.** After jumping into old history, scrolling *down* now seek-loads newer messages continuously (previously only scrolling up worked — downward was a dead end until you clicked "return to latest"). The browse DOM is capped (far-away slabs are dropped and transparently re-loaded when you scroll back), so long browsing stays smooth. A search hit that's already on screen just scrolls to it instead of replacing the view, and the stale position indicator is hidden while browsing history.

## [2.14.0] — 2026-07-02

### Changed

- **Terminal rendering rebuilt on the WebGL renderer.** The old DOM renderer laid rows out with browser-rounded letter spacing while the size calculation used the unrounded cell width — the accumulated fraction is what clipped the rightmost column. WebGL renders device-pixel-aligned cells (integer cell metrics), eliminating that entire class of bugs, and repaints far faster (less TUI flicker). Falls back to the DOM renderer where WebGL is unavailable.
- **No more "terminal smaller than the window" look.** The sub-cell remainder around the character grid is now painted in the terminal theme's own background instead of window-chrome color, so it blends in. Cell metrics also refresh automatically on browser zoom / monitor changes (device-pixel-ratio watcher).
- **Claude Code's flicker-free fullscreen TUI integrated.** New setting Claude → **Terminal TUI renderer**: "Fullscreen (flicker-free)" starts terminal-mode Claude sessions with the alternate-screen renderer + virtualized scrollback (`CLAUDE_CODE_NO_FLICKER=1`, same as `/tui fullscreen`); "Classic" forces the main-screen renderer; "Auto" follows the CLI's own saved preference. The WebUI's scroll-freeze machinery now detects alternate-screen TUIs and writes through instead of queueing frames (correct behavior for the fullscreen renderer, vim, htop, …).
- **Multi-client terminal fixes.** (1) Refreshing a page no longer leaves the terminal garbled: a freshly attached client whose window fits the same size as the PTY got no SIGWINCH, so the TUI never repainted and the client was stuck with a partial buffer replay — the server now nudges the PTY one column down and back on a client's first fit (same trick as dtach's `-r winch`), forcing a clean repaint. (2) When another, smaller client caps the terminal size, the unused area now shows a tmux-style hatched boundary plus a badge ("80×20 — limited by a smaller client") instead of the terminal just being mysteriously small. (3) **Take over from a bigger screen**: the badge has a "Use my size" button that forces the PTY to this window's size (e.g. working outside while a small window at home stays attached) — the smaller client's view is blocked behind a "Resume here" overlay that takes the size back with one click; ownership follows the owner's live resizes and auto-releases when the owner disconnects.
- **Fable's separate weekly limit in usage details.** Anthropic added model-scoped weekly caps (currently Fable); they ride in the usage API's `limits[]` as `weekly_scoped` entries and now show as their own bar ("Fable weekly limit") in the usage popup.
- **5h vs 7d usage distinguishable at a glance.** The taskbar usage pies are now donuts with the window label (5h / 7d) in the hole, instead of two identical circles.
- **Mobile terminal keyboard rebuilt.** The key row grows from 9 to 15 keys: Esc, Tab, ⇧Tab (cycle permission modes), a **sticky Ctrl** (next typed letter becomes Ctrl+letter — soft keyboards have no Ctrl), all four arrows with hold-to-repeat, 📋 **paste** (text *and images*: async Clipboard API on HTTPS, or a long-press paste pad over HTTP that feeds the same pipeline as desktop Ctrl+V), and ^C ^G ^R ^Z ^D ^\. Ctrl+G (split-pane editor) works from the key row.
- **Fixed: switching model left the chat stuck on "thinking…".** The CLI's `set_model` confirmation echo is a user record with no turn behind it; the streaming tracker treated any user record as a turn start and waited forever for a result. Local-command echoes no longer count as turn starts.
- **Change reasoning effort mid-session in chat mode.** The effort badge next to the model is its own dropdown (low/medium/high/xhigh/max + reset). Claude has no documented effort switch in stream-json — `/effort` is blocked non-interactively — but the CLI's own remote transport uses `apply_flag_settings {effortLevel}`, which we verified live changes thinking depth ~9x between max and low and even overrides a spawn-time `--effort` flag. Codex applies it from the next turn (per-turn param). Since Claude never reports effort back, the badge shows the last *commanded* value and its tooltip says so; a fresh chat shows `model: ?` / `effort: ?` until real values exist.
- **Change model mid-session in chat mode.** The model badge in the chat status bar is now a dropdown (like the permission mode): pick any available model or type a custom ID. Claude switches instantly via the stream-json `set_model` control request; Codex applies it from the next turn. The badge shows the model the CLI actually resolved (from its own confirmation echo), not the alias you clicked.
- **Honest model/context display.** The status bar no longer guesses: the model badge always renders — showing the CLI-reported value or an explicit `model: ?` when nothing has been reported yet; the `[1m]` suffix is no longer stripped; and when the context-window size is unknown the bar shows `<used>/?` instead of a percentage computed against an assumed 200k window (which was wrong by 5x on 1M sessions).
- **Clipboard image paste fixed (Linux).** The server trusted the inherited `DISPLAY` blindly — a stale value (e.g. `:99` with no X server behind it) silently broke every xclip call, and under XWayland the compositor's `XAUTHORITY` cookie is also required. The server now probes for a *working* display at startup (all X sockets × all auth cookie candidates) and uses that pair for its own clipboard calls and for spawned sessions. The startup log reports the detected display, or says clipboard paste is unavailable — instead of failing silently.

## [2.13.0] — 2026-07-01

### Changed

- **Huge sessions now scroll like small ones — pure streaming seek, no truncation notice.** Sessions whose transcript is too large to hold in memory (hundreds of MB) previously loaded as a head + tail with a visible "Session history truncated" seam card in the middle, and jumping into the elided middle was unreliable. Now the chat loads the recent tail only and treats the entire earlier history as one continuous virtual scroll: scrolling up transparently seek-loads older messages (by byte offset) all the way back to the first message, with no seam marker and nothing to click.
- **Search and minimap jumps are now precise on any session size.** Every jump (search result, minimap marker) teleports to a slab seek-loaded around the target's absolute file position, then locks onto the exact match with iterative, content-shift-proof centering. This is immune to the index drift that made jumps miss on very large and actively-growing sessions. A "return to latest" affordance (the scroll-to-bottom button) brings you back to the live conversation.
- Full-file search already covered the whole transcript; it now lands correctly on the match instead of near it, and the highlighted result stays highlighted as the view settles.
- **Jumps are fast and land in one click.** The byte-offset index used for seeking now extends incrementally (scanning only newly-appended bytes) instead of re-reading the whole file, so jumps stay ~150ms even while a session is actively being written. Each jump loads a smaller slab, forces stable element heights, and scrolls to the target before the first paint — so it lands exactly centered instead of doing a big scroll, missing, and needing several clicks.
- **Search results are now unmissable.** Jumping to a match scrolls it fully into view even when it's buried inside a long card that has its own scrollbar (code blocks, tool output) — previously the outer list scrolled but the match stayed hidden inside the card. The current match is a solid high-contrast highlight (distinct from the other dimmer hits) and a pulse briefly flashes right on it, so you can tell exactly where it is.
- **Full-file search streams results progressively** (`less`-style). Instead of blocking until the whole (hundreds-of-MB) file is scanned, matches now stream in as they're found: the counter shows a live `N… searching` that climbs and finalizes to the total when done, and the first match is jumped to immediately. The scan reads the file asynchronously so it no longer blocks other requests, and starting a new search cancels the previous one.

## [2.12.0] — 2026-06-28

### Fixed

- **Multi-client sync stability** — operations on one client no longer get undone and replayed by stale echoes from other clients. Layout broadcasts are sequence-stamped (stale ones dropped), clients only re-broadcast state the user actually caused, inbound state is deferred while you're mid-drag, and proportional bounds are quantized so clients with different window sizes converge instead of ping-ponging forever.
- **Window drag performance** — all drag/resize mousemove work (snap highlight, merge hit-tests, preview updates) is now coalesced to once per frame instead of running at raw pointer rate (up to 1000Hz); resizing a terminal no longer re-fits xterm per event. Sidebar session polling pauses in hidden tabs.
- **Font dropdown showed blank** when the stored font matched no option — now shown as "(current)".

### Added / Improved (UX review follow-ups)

- **Folder bulk operations** — right-click a sidebar folder header: archive all stopped sessions at once, new session here, copy path. Folders with >100 sessions and nothing live start collapsed.
- **In-app dialogs everywhere** — every native `prompt/alert/confirm` (rename, group ops, file create/rename/delete, terminate, review targets, theme editor, settings reset, command-mode grid) replaced with themed dialogs (Enter confirms, Esc cancels, destructive actions get a red confirm).
- **Escape closes overlays** — context menus and popovers first, then the open dialog (except while typing in a terminal).
- **Global toasts** — one consistent notification stack; file operation failures now surface instead of failing silently.
- **New Session dialog** — recent working directories as one-click chips; Enter submits.
- **Density & mobile** — thinking blocks are slimmer (runs of consecutive blocks no longer drown content); the mobile chat status bar is one swipeable line instead of wrapping into 2-3 rows.
- **Discoverability** — taskbar items get full-title tooltips (groups list every tab), the cache-ratio badge explains itself, and command mode (`Ctrl+\`) shows its key map while armed.

## [2.11.0] — 2026-06-26

### Added

- **Fork sessions** — fork a chat session into an independent branch that shares the history so far; the original is left untouched. Clicking Fork opens a popup with an editable **Title** and a **first message** (sending that message is what makes the branch actually diverge — the agent mints the fork's new id on its first turn). The chosen title sticks on the window and in the sidebar, even after the fork stops or the page reloads.
- **Fork from any message** — each assistant message in chat shows a fork (GitHub repo-forked) icon next to "open in editor"; it branches a new session truncated to the conversation up to and including that message, then continues from your first message (`claude --resume … --resume-session-at <uuid> --fork-session`).
- **Stacked tab-group taskbar items** — grouping windows into tabs now shows ONE stacked taskbar entry (the unique tab icons offset like a card stack + a count badge) instead of hiding the grouped windows. Click it to expand a list of the tabs and jump to any of them; the active tab's title is shown; right-click acts on the whole group.

### Fixed

- **A Claude fork behaved exactly like a resume** — the WebUI never adopted Claude's stream-json session id, so a forked window shadowed the original and the fork's transcript was orphaned. The chat parser now adopts the fork's new id on its first turn (guarded so a normal resume can't be hijacked).
- **Editor highlight covered the selection** — the current-line highlight hid the selection on the first/last selected line. Suppressed while a selection exists; the fix now also survives the editor losing focus (uses the CodeMirror `editorAttributes` facet instead of a DOM class, which CodeMirror rebuilds on focus change).
- **Splitting a tab out of a group froze the drag** and left the grid snap-preview dashed area stuck — the drag listeners were torn down mid-drag by the tab-bar re-render. They're now scoped per-drag.
- **Editor window/taskbar title now front-truncates** the file path (`…/dir/file.js`) like the file explorer, so the filename stays visible.
- **Office file icons unified** — Excel and PowerPoint now match Word's folded-document look; the Python file icon is the clean official logo.
- **Chat loading spinner no longer freezes under OS "Reduce Motion"** — it pulses instead of stopping, so it still signals activity without the rotation reduced-motion suppresses.

## [2.10.0] — 2026-06-24

### Added

- **Chat file/folder upload** — drag-drop onto a chat (desktop) or a paperclip button → Files/Folder menu (mobile): files/folders are saved into the session's working directory and the path(s) inserted into the input box. Backend-agnostic; reuses `/api/upload`.
- **Colored file-explorer icons** — each file/folder icon is tinted by category (`fic-<category>`: folders amber, images purple, video red, audio cyan, code green, …) so types are distinguishable at a glance.
- **Non-invasive usage monitoring** — usage now comes from the non-billable `GET /api/oauth/usage` with a **read-only** OAuth token (never refreshed). Stops consuming quota to measure quota and stops rotating Claude Code's refresh token, fixing the macOS daily-re-login (#20). Polls ~5 min with 429 backoff + keep-last-known.
- **Cache-busting** — `index.html` is served with `?v=<mtime>` on every local js/css asset + `Cache-Control: no-cache`, so updates land on a normal refresh (no hard-refresh needed).

### Fixed

- **Sidebar jump-to-session** now auto-expands a collapsed/lazy folder before scrolling (previously did nothing when the target was hidden).
- **Sidebar no longer re-renders on every poll** — `startedAt` (an active session's file mtime) was in the change-digest, so the list churned + lost scroll while browsing. Dropped it; scroll position preserved across re-renders.
- **Remaining colorful emoji → SVG** (🎯 goal, ⏳ hourglass, 🪙 budget, ⏸/⛔ goal status, ⚡ cache ratio).
- **Chat drag-upload overlay was permanently visible** — the new overlay toggled a `.hidden` class but this project has no global `.hidden` rule, so it was never hidden. Added the scoped rule; overlay shows on drag, hides on a dragover-idle timer.
- **userW's reports**: URL double-escape of `&` in chat links (#16), and silent resume failure from a 32KB session-meta read truncating past an early large attachment (#18).

## [2.9.0] — 2026-06-22

### Changed

- **Renamed the project to VibeSpace** (was "Claude Code WebUI"). This is a branding change only — the underlying Claude Code / Codex CLIs it manages are unchanged. Display name, page title, console banner, `package.json` name (`vibespace`), default install directory (`~/vibespace`) and the GitHub repo (`github.com/ProblemFactory/vibespace`) all updated.
- **Repositioned as backend-agnostic.** Docs (README, getting-started, docs index, CLAUDE.md overview) no longer center on Claude Code — VibeSpace is a workspace for *any* coding agent / agent-harness CLI, driven through a `BackendAdapter`. Claude Code and Codex are the supported backends out of the box; adding another is a single adapter. The installer now requires **at least one** backend (`claude` and/or `codex`) instead of hard-requiring Claude.

### Migration (seamless for existing installs)

- **No data migration needed.** All persisted state — `data/` (layouts, session metadata, dtach sockets, buffers, drafts, settings), browser `localStorage`, and dtach session sockets (`cw-` prefix unchanged) — is independent of the project name. An in-place `git pull` keeps every session, layout and setting intact.
- **`install.sh` adopts a pre-rename install automatically**: if `~/claude-code-webui` exists and `~/vibespace` doesn't, the installer updates it in place (keeping the folder name and all data) instead of cloning a fresh copy, and points the git remote at the renamed repo. The folder is deliberately **not** renamed — dtach session sockets are bound to absolute paths, so moving the folder would orphan running sessions. Rename the folder yourself later (after stopping the server) if you want it to match.
- GitHub redirects the old repo URL, so a manual `git pull` from an existing clone also keeps working unchanged.

### Added

- **Markdown tables scroll horizontally** (`.chat-table-wrap`): wide tables in chat now scroll instead of overflowing — essential on mobile, where off-screen columns were previously unreachable.

## [2.8.2] — 2026-06-09

### Added

- **Persistent goal entry point in the chat status bar**: a dim 🎯 is always shown when no goal is active — clicking it opens a set-a-goal popup (condition input + "Resume previous"). Active goals show status icon + elapsed + objective as before.
- **Codex status bar parity**: reasoning effort next to the model badge, sandbox policy in the permission tooltip, cumulative session token usage (in/cached/out/reasoning) in the context-pie tooltip, and Codex's plan tool (`update_plan`) now drives the same TODO display above the input that Claude's TodoWrite does.

### Fixed

- **Spontaneous terminal shrink + apparent disconnect mid-use**: `resizeSessionToMin` min'd over all clients while ghost/placeholder entries sat at a hardcoded 120×30 (the attach placeholder, or a subagent View-Log window registered into the parent session). Compounded by no WS heartbeat, so half-open connections lingered. Now only genuinely-fitted terminal clients drive PTY size (`real:true`), subagent viewers never participate (`viewer:true`), a 30s ping/pong heartbeat evicts ghosts, and terminals re-fit on reconnect.
- **Status bar empty until the first reply after resume/attach**: model and context window were derived only from `result.modelUsage` / system-init records, which are stream-json stdout-only and never in the JSONL. Now falls back to `assistant.message.model`, infers the context window from observed usage (>190k ⇒ 1M beta), and restores the permission mode from the session's launch args. Codex unaffected (rollout JSONL carries it natively).
- **Codex resume showed no goal for the whole first turn**: resuming a thread with an active goal auto-continues by Codex design, but the wrapper only emitted a goal event at turn end. It now emits `goal_updated` right after the startup `thread/goal/get`. Replacing an active goal (`/goal B` over A) now also saves A to `_prevGoal` for resume.
- **Codex live token% / rate limits were dead paths**: the `thread/tokenUsage/updated` notification's v2 shape (`{tokenUsage:{total,last,modelContextWindow}}`) was read with nonexistent field names, and rate limits were looked for on the wrong notification — both now parsed correctly (`account/rateLimits/updated` carries the limits).

### Changed

- **Claude `/goal` uses the CLI's native goal mechanism** (parity with Codex; superseded the wrapper simulation + 200-iteration cap from 2.8.0). The CLI's Stop hook drives continuation and met-detection; the server tails the JSONL for `goal_status` attachments (stdout-gap) to sync state. Requires CLI ~2.1.1xx (`/goal` `supportsNonInteractive`).

## [2.8.1] — 2026-06-09

### Changed

- **Claude `/goal` switched to the CLI's native goal mechanism** (parity with Codex). CLI ~2.1.1xx added `supportsNonInteractive` to `/goal`, so it now dispatches as a real command in stream-json (verified live on 2.1.170) — the wrapper forwards `/goal <text>` / `/goal clear` instead of simulating continuation. The CLI's Stop hook drives both auto-continue and **met-detection** (which the simulation never had), so the v2.8.0 200-iteration safety cap is gone — goals terminate when their condition is met, with `reason`/`iterations`/`durationMs`/`tokens` reported.
- `goal_status` attachments are JSONL-only (not emitted on stream-json stdout — same gap class as subagent messages #8262), so the server tails the session JSONL after each turn to sync goal state, broadcasts `Goal met: …` with the hook's reasoning, and writes the cleared state back to the wrapper meta so restarts don't resurrect a finished goal.

## [2.8.0] — 2026-06-09

Full-project code review release: 8 parallel review agents audited every subsystem (server, wrappers, WS/stores, routes, window manager, sidebar, chat UI, viewers, CSS), followed by five fix batches covering ~120 findings.

### Added

- **Fable 5 model tier**: `fable` / `fable[1m]` aliases in all model lists; model discovery switched to `/v1/models` with OAuth Bearer (the bootstrap endpoint's `additional_model_options` now returns null), so new full model IDs appear automatically.
- **Per-session config persistence**: model/effort/permission overrides from the gear popover are now stored in user state (`sessionConfigs`, key `backend:backendSessionId`), synced multi-client, applied by ALL resume paths (card click, resume-all, chat resume bar, layout restore), and surfaced as a purple gear badge on session cards (tooltip shows the full config).
- **Hex viewer**: auto-loads chunks on scroll; offset gutter shows real file offsets after a jump; jump scrolls to its target.
- **Accessibility**: pinch-zoom re-enabled (was `user-scalable=no`), hover-revealed controls visible on touch devices, chat minimap non-interactive on touch, `prefers-reduced-motion` support.
- **Theme system**: per-theme `--accent-fg`/`--magenta`/`--cyan`/`--hover-overlay` variables; hardcoded indigo/green/red follow the theme accent via `color-mix`; Nord/Monokai accent-background buttons now readable; Light-theme scrollbars/hovers visible.

### Fixed (highlights)

- **Claude thinking content rendered empty** — the normalizer read `block.text` but Claude sends `block.thinking`. All thinking blocks now display.
- **Sidebar lazy rendering never fired** — the IntersectionObserver was created *after* `observe()` calls registered on its disconnected predecessor; the Groups tab rendered permanently empty and off-screen folders stayed blank.
- **Codex AskUserQuestion always declined** — questionnaire answers (`toolInput.answers`) never reached the wrapper; the adapter now translates them to `responseData.{decision,answers}`.
- **XSS hardening** — `escHtml` escapes quotes (attribute-context injection); DOMPurify sanitizes all markdown rendering; file paths/error messages escaped in hex viewer, external editor, browser overlay, explorer/editor error cards.
- **Zombie sessions after attach-PTY death** — stale PTY exits no longer null a freshly re-attached PTY or tear down live subagent watchers/normalizer listeners; dead attach PTYs auto-re-attach with bounded retries.
- **Data-loss windows closed** — all persistence JSON writes are atomic (tmp+rename); SyncStores and layouts flush on shutdown; user-state migration no longer POSTs a stale localStorage cache over other devices' changes; CodeEditor/external editor surface write failures instead of reporting "Saved".
- **Window manager leaks** — per-window/per-tab document listeners released on close (previously leaked the full window DOM per close); ChatView removes its settings listeners; `_messages` no longer grows unboundedly with duplicates.
- **Concurrent create cross-wiring** — `create`/`created` correlate via reqId (group resume-all could bind a ChatView to the wrong session); tmux view windows get an openSpec so remote layout-sync stops closing them.
- **Performance** — Codex thread metadata cached by mtime with head-only reads (sidebar polls re-parsed every session file); user-state writes skip the Codex tree scan when no legacy keys exist; Codex history conversion no longer O(n²); taskbar updates in place on focus changes; streaming markdown re-renders coalesce per frame; waiting/find blink animates composited opacity instead of repainting box-shadow; `/api/sessions` gets a 2s response cache.
- **Logic** — WebUI goals re-check state before auto-continuing and cap at 200 turns (paused, resumable); CSV viewer parses quoted fields and estimates totals correctly (large files were capped at ~10k rows); upload names are confined to the destination directory; upload failures no longer record success; goal status icons show for Codex (case mismatch); AskUserQuestion multi-select can't submit empty; ~340 lines of verified dead code/CSS removed (the typo'd notification-card selector now styles correctly).

### Removed

- Dead `/api/session-groups` CRUD routes (7 endpoints, unreachable, conflicting data shape that corrupted state if invoked). Groups remain managed through `/api/user-state`.

## [2.7.0] — 2026-06-02

### Added

- **`/goal` command in chat mode (Claude + Codex)**: set a session-scoped objective the agent auto-continues toward until met.
  - **Claude**: `/goal <text>` sets the goal; wrapper auto-sends a continuation message after each `result` (turn end) so the model keeps working. CLI's own `/goal` (Stop hook) is also detected — `goal_status` attachments in stream-json sync `session._goal`. `/goal`, `/goal clear`, `/goal resume` semantics match the CLI.
  - **Codex**: uses the app-server's **native** goal loop via `thread/goal/set` RPC (objective stored in Codex's SQLite, auto-continues with developer messages). Wrapper queries `thread/goal/get` on startup and after each `turn/completed` to sync authoritative state (`objective`, `status`, `timeUsedSeconds`, `tokensUsed` — note camelCase). Resuming a thread with an active goal auto-continues by Codex design.
  - **Status bar goal indicator**: 🎯 + status icon (▶ active / ⏸ paused / ✓ complete) + elapsed time + truncated objective. Click for popup with full text, elapsed/status, Continue (when not active) and Clear buttons. Elapsed comes from protocol (`timeUsedSeconds`), not a wall clock — updates per turn.
  - Goal state persisted in wrapper meta + session, survives server restart (read in `restoreSessions`), broadcast to all clients via `goal-updated`.
- **Interactive AskUserQuestion UI**: `AskUserQuestion` tool calls (via `control_request` `tool_name === 'AskUserQuestion'`) render as a paginated questionnaire — one question per page with ← → navigation, selectable option cards, a custom-answer input per question, and a Submit enabled only when all are answered. Response uses `approved: true` + `toolInput.answers` keyed by question text.
- **Fork button on session cards**: branches a session from its history. Claude uses `--fork-session`; Codex uses the app-server's `thread/fork` RPC (confirmed to return a new thread with `forkedFromId`). Fork name auto-generated: "Name (forked)", "(forked 2)", etc.
- **Hook event rendering**: `hook_response` → collapsed "✓ Hook: name" card (expand for output); `stop_hook_summary` → "N hooks ran". `hook_started` ignored.
- **CLI command notification cards**: `<command-name>`, `<local-command-stdout>`, `<system-reminder>`, `<task-notification>`, and goal Stop-hook directives render as compact dim notification cards instead of raw XML user messages.

### Fixed

- **Session history lost after server restart**: attach only loaded JSONL when `normalizer.total === 0`, but PTY `processLive` could populate partial buffer data first, skipping the full history (e.g. 4367 messages → 63). Now uses a `_historyLoaded` flag and re-creates the normalizer from full JSONL + buffer on first attach.
- **Duplicate Codex messages from JSONL/buffer overlap**: JSONL records carry an `item_id` that buffer records lack, so `JSON.stringify(payload)` fingerprints differed and dedup failed. Now strips `item_id`/`itemId` before fingerprinting.
- **Resume opening a second window for a terminated conversation**: clicking Resume in the sidebar while a terminated (read-only) window for the same session was still open created a duplicate stuck window. `resumeSession` now closes any window whose `_openSpec.backendSessionId` matches the target before creating the resumed window.
- **File explorer Copy Path over HTTP**: `navigator.clipboard` is undefined in non-HTTPS contexts, so the optional chain silently skipped the fallback. Replaced inline code with the shared `copyText` utility.
- **Codex `apply_patch` Update cards expanded by default**: `renderPatchDiff` had `open` on the diff `<details>`. Now collapsed like other tool cards.

## [2.6.1] — 2026-05-09

### Fixed

- **Mid-stream attach showed `isStreaming: false`**: `_isStreaming` was only set from PTY output (user message echo), causing a timing gap where a second client attaching mid-stream would see the session as idle. Now set to `true` immediately when the server sends `chat-input` to the PTY, before waiting for the round-trip echo. Verified with multi-client sync test.

## [2.6.0] — 2026-05-09

### Added

- **Codex fork history merge**: Codex `thread/resume` always creates a new thread ID (fork by design). Now tracks `forkedFrom` chain on the session: when `backendSessionId` changes, the old ID is appended. `CodexSessionMessages` loads the full chain (oldest → newest) with fingerprint dedup, so resumed sessions show their complete history. Forked-from threads hidden from sidebar to avoid duplicates. Persisted in metadata, survives restarts. Supports multi-level forks (A → B → C).
- **Explicit server-side streaming state**: replaced the fragile heuristic that derived `isStreaming` from normalizer message statuses with an explicit `session._isStreaming` flag. Tracked from deterministic protocol signals: Claude (`result`/`compact_boundary`/`user`), Codex (`task_started`/`task_complete`/`turn_aborted`/`task_failed`). Initialized from wrapper metadata on restore, cleared on exit. Eliminates the race condition where `processLive` created stale streaming entries before `convertHistory` finalized them.

### Fixed

- **`/compact` leaving chat stuck on 'thinking'**: after `/compact`, stream-json emits `user` messages (compact summary) but no `result`, leaving the normalizer with stale streaming assistant messages. `MessageManager._processUser` now calls `_finalizeStreaming` on new user message arrival. Wrapper also treats `compact_boundary` system message as end-of-stream.
- **Stale streaming messages causing permanent 'responding' indicator**: `_finalizeStreaming()` broke at first non-streaming message, leaving interleaved stale ones. Now scans to `role==='user'` boundary. `_deriveTypingLabel` also stops at user messages to ignore stale turns.
- **`isStreaming` in attach response**: was `sm.isStreaming || hasStreamingMsg` — stale wrapper meta overrode normalizer's correct state. Changed to normalizer-first: prefer `hasStreamingMsg` when normalizer has messages, fall back to wrapper meta only when empty.
- **Broken pty stdin false positives**: buffer-growth check failed for opus[1m] (10-30s before first token). Wrapper now writes `_stdin_ack` to stdout immediately on stdin receipt; server checks for ack. Fallback to buffer growth for old wrappers without ack support.

## [2.5.0] — 2026-05-08

### Added

- **View-only fallback on server restart**: when a chat/terminal session's dtach process died (full server/machine restart), layout restore now opens it as view-only (JSONL history + Resume button) instead of silently dropping the window.
- **Auto-detect broken pty stdin**: after server restart, if a chat-input write produces no buffer output within 5s, the pty is re-attached automatically and the message re-sent. Uses buffer growth check (not just meta.streaming) to avoid false positives from slow API responses.

### Changed

- **Folder '+' opens dialog**: clicking '+' on a folder header now opens the New Session dialog with cwd prefilled, instead of immediately creating with defaults.
- **captureState saves cwd**: layout auto-save now persists `cwd` for both terminal and chat windows (needed for view-only fallback).
- **restoreState fetches /api/sessions**: stopped session lookup no longer depends on sidebar._allSessions being loaded (race condition fix).

### Fixed

- **Codex thinking messages lost during/after tool calls**: `_finalizeStreaming()` prematurely cleared `streamingReasoningMessages` map on every new text stream, and `_processReasoningItem()` created duplicates. Now reasoning is only finalized on turn-end events, and finalized items update existing streaming messages in-place.
- **Lazy folder rendering empty folders**: IntersectionObserver only handled `'placeholder'` state, not `'pending'` (initial state for off-screen folders). Folders below the fold never rendered their cards.
- **Broken pty stdin false positive**: previous detection only checked `meta.streaming` which races with debounced meta writes. Now checks buffer length growth as primary signal.
- **Thinking/streaming state not syncing across clients**: `isStreaming` in attach response only read wrapper meta (can lag). Now also checks normalizer messages for `status==='streaming'`. `_reattach()` now calls `_syncTypingIndicator()` after fetching missed messages.

## [2.4.0] — 2026-04-25

### Added

- **Mobile UI overhaul**: comprehensive responsive redesign tested on Pixel 10 Pro XL via ADB.
  - **Two-level sidebar navigation**: folder list (level 1) → session list (level 2) with back button. Replaces the single giant scrollable list (~1600 DOM nodes → ~20). Both Folders and Groups tabs use this pattern.
  - **Window switcher**: tap the nav bar title to see all open windows, switch or close them. Includes desktop tabs when 2+ virtual desktops exist (tap to switch desktop, list updates in-place).
  - **Close button** (✕) in nav bar to close the active window. Auto-focuses the most recently used window after closing.
  - **Image upload button** in chat input area (mobile only) — opens system file picker for images since Ctrl+V paste isn't available on mobile.
  - **Edge swipe gesture**: swipe right from left edge opens sidebar, swipe left closes it.
  - **Folder/group icons**: folder 📁 and people 👥 SVG icons on mobile navigation cards.
  - **Lazy folder rendering**: IntersectionObserver defers rendering session cards until their folder group enters viewport (desktop optimization too).
- **Effort combobox**: effort setting (both global and per-session) now has "Custom..." option for typing values like `xhigh` that the CLI may not list but models support.
- **Per-session config Custom...**: all three rows (Model, Effort, Permission) in the per-session config popover now support free-form Custom... input, not just Model.
- **Auto-detect effort levels**: server parses `--effort` options from `claude --help` and serves via `GET /api/session-options`. Frontend updates dropdowns dynamically.

### Changed

- **Mobile architecture split**: extracted `mobile-nav.js` (MobileNav class) and `sidebar-render-mobile.js` (mixin) from app.js and sidebar-render.js. Centralized `app.isMobile` flag replaces scattered `matchMedia` checks.
- **Mobile CSS**: `100dvh` for keyboard-aware layout, sticky nav bar, full-screen fixed sidebar (z-index 90000), larger touch targets (32-44px), 16px font in chat input, rounded input corners, folder path middle-truncation.
- **Mobile link handling**: tap opens directly (file viewer / new tab) instead of copying. Desktop Ctrl+click behavior unchanged.

### Fixed

- **Background tasks accumulating** (40+ stale "running" tasks in status bar): stream-json rarely emits `task_notification` for background Bash commands. Now tasks are deleted from wrapper meta on completion, and command-type tasks are cleaned up on turn end (`result` message).
- **Mobile nav bar not showing**: CSS source order issue — `#mobile-nav { display:none }` defined after `@media` block.
- **Mobile sidebar behind windows**: z-index 1000 vs window z-index 5000+.
- **Star/archive icons too small on mobile**: inline `style="width:12px"` overridden with `!important`.
- **Filter buttons not toggleable on mobile**: re-click created new popover instead of closing.
- **Groups tab empty on mobile**: wrong `_getGroupSessions` call signature.
- **Drill-down reset on session click**: `_render()` lost drill-down state. Fixed with `_mobileDrilldown` state tracking.
- **No focus transfer after closing window**: closed active window left blank screen on mobile.

## [2.3.0] — 2026-04-22

### Added

- **Per-session model/effort/permission config**: Gear button (⚙) in the Resume split button group opens a popover with Model, Effort, and Permission overrides. Each row has a checkbox — unchecked = greyed out (use global default), checked = per-session override active. Model supports "Custom..." for specific model IDs. Overrides are passed to `claude --resume --model X --effort Y --permission-mode Z`.
- **"Not logged in" detection + login helper**: When a session exits because the CLI's OAuth token expired, the chat window shows a dedicated login bar with "Open Login Terminal" (opens a terminal to run `/login`) and "Retry" buttons, instead of a blank read-only window.

### Fixed

- **Session config was inline panel taking too much space**: Changed to a compact popover anchored to a gear button.
- **Config gear icon was a sun**: Replaced with actual gear SVG.

## [2.2.1] — 2026-04-20

### Fixed

- **Resume/new session broken on older Claude CLI**: Claude Code <2.1.98 doesn't support `--name`, causing immediate exit code 1 and read-only window. Server now parses `claude --help` at startup to detect supported flags and only passes `--name` when available.
- **Startup banner showed hardcoded "v2.0"**: Now reads version from package.json dynamically.

## [2.2.0] — 2026-04-18

### Added

- **Upload redesign**: Upload button now opens a Chrome-style popover menu with "Upload Files", "Upload Folder" (webkitdirectory), upload history list (last 10, click to reopen), and "Clear History". Active uploads show with spinner + cancel in the menu.
- **Inline upload progress**: Uploading files appear as real file-list rows with a Mac Finder-style progress bar (accent fill in the size column area), percentage label, and cancel button. Survives folder navigation — rows re-render via `_renderItems`.
- **Upload button ring progress**: SVG circle ring on the upload button fills during active uploads (Chrome download-button style). Hidden when idle.
- **Upload history persistence**: Stored via SyncStore `uploads` — persisted to disk, broadcast to all clients in real-time.
- **Folder upload**: `webkitdirectory` input preserves relative paths; server creates nested directories via `mkdirSync({recursive: true})`.
- **Combobox model selector**: Model settings now show a dropdown of known aliases plus a "Custom..." option that reveals a text input for typing specific model IDs (e.g. `claude-opus-4-6-20250414`). Works for both Claude and Codex.
- **Opus and WMA audio formats** added to file type registry.
- **Path-based file serving route**: `GET /api/file/serve/*` maps URL paths to filesystem paths, enabling `<base href>` for HTML preview.

### Changed

- **OAuth token auto-refresh**: Server stores full OAuth credentials (accessToken + refreshToken + expiresAt). Expired tokens are automatically refreshed via `platform.claude.com/v1/oauth/token` using the same client_id as Claude Code. Both model discovery and rate limit polling use the async token getter.
- **Model discovery via bootstrap API**: OAuth users now fetch models from `/api/claude_cli/bootstrap` (supports OAuth, same endpoint Claude Code uses) instead of `/v1/models` (API key only). Falls back to `ANTHROPIC_API_KEY` + `/v1/models` when OAuth unavailable.
- **HTML preview uses `<base href>` + `allow-same-origin`**: Relative paths (CSS, images, fonts, JS) now resolve correctly via the path-based serve route. Live editing still works via srcdoc.
- **HTML preview re-renders on resize**: ResizeObserver triggers debounced srcdoc rewrite so JS-computed layouts recalculate at new dimensions.
- **Popover/context menu viewport clamping**: All popovers and context menus now check bounds after render and nudge back on-screen if clipped by viewport edges.

### Fixed

- **Upload progress bar not filling**: Fill element was `display:inline` (span default) — width/height had no visual effect. Fixed with `display:block`.
- **Upload popover had no background**: Missing `background/border/box-shadow` CSS.

## [2.1.0] — 2026-04-16

### Added

- **Resume button on read-only chat windows**: every read-only ChatView (view-history, terminated, exited) now shows a "Resume this session" button in place of the input area. Click resumes via `app.resumeSession()` and closes the read-only window — unifies the three read-only scenarios so users never have to go back to the sidebar just to continue chatting. Subagent viewers (`sub-*`) are excluded since they can't be resumed.
- **Tab drag-out merge**: dragging a tab out of a tabbed window can now merge into another window's tab bar or icon (including the original group), in addition to becoming standalone.
- **Shared tab-merge hit-test helper** (`_detectTabMergeTarget` on tab-group mixin): unifies window.js titleBar drag, icon drag, and tab drag-out. All three use `elementFromPoint` (not `getBoundingClientRect`) so occluded icons never match.
- **Stacked Workspaces app icon**: replaced the ⚡ emoji favicon + loading splash with a custom SVG — three layered window rectangles (representing virtual desktops) with mini tiled window thumbnails in the front pane, using the brand indigo gradient.
- **CHANGELOG.md**: this file. Past changes are best tracked via `git log` and CLAUDE.md's "Bug Fixes Applied" section.

### Changed

- **Interrupt uses delayed-fallback instead of dual-interrupt**: sending Stop now issues the `control_request` interrupt immediately and schedules SIGINT 2 seconds later. Before firing, the wrapper meta is re-read — if `streaming:false`, SIGINT is skipped. Sending a new chat message during the window also cancels the pending SIGINT. Avoids the "Stop kills the whole session" problem in newer Claude Code versions that exit on SIGINT instead of just interrupting the turn. Historical SIGINT was kept as a safety net for bugs #17466 and #3455; the delayed approach keeps the safety net without its side effects.
- **Tab drag-out follows titleBar-drag pattern for merge zones**: the detached window itself acts as the cursor-following preview in empty space (with snap highlights). Entering a tab merge zone collapses it to a small `.tab-ghost` preview (window `display:none`). Leaving restores the window. Previously the detached window stayed visible while merge target was indicated only via `.tab-drop-target` — confusing, since it wasn't clear merging would occur.
- **Icon drag auto-hides source window**: source window is set to `visibility:hidden` once drag threshold is crossed, since the ghost represents it. Restored on mouseup.
- **Detached tab window raised to front**: calling `focusWindow` right after `_detachFromChain` so the cursor-following preview is never hidden behind the original chain host or other windows.
- **Version bump**: 2.0.0 → 2.1.0 (minor: new user-visible features, all backward-compatible).

### Fixed

- **Dragging a window's icon onto itself made the window disappear**. Root cause: `getBoundingClientRect`-based hit-test matched a stacked window underneath whose iconSpan rect happened to overlap the cursor. Fixed via the new `_detectTabMergeTarget` helper (uses `elementFromPoint`, skips the dragged element).
- **Hit-test on tab bar drops never worked**: window.js queried `.tab-bar` (wrong class — actual is `.tab-bar-tabs`). Now works.
- **Tab drag-out mini preview invisible when hovering the original tabbed window**: the detached window was being hidden on merge-target hover, but it *was* the preview. Restored window + swapped to titleBar-drag pattern (hide only when a ghost takes over).

### Notes for future changelogs

- Keep entries user-visible and short. One-liners are fine.
- For internal refactors without behavior change, use a single line under "Changed" — readers can always check `git log` for commit-level detail.
- CLAUDE.md's "Bug Fixes Applied" is the authoritative long-form technical log; CHANGELOG is for release notes.
