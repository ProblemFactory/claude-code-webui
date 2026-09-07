/**
 * WS 'create' handler (拆分P2): the session-CREATE case family — new session /
 * resume / fork, local + remote (ssh/dial/daemon pipe), account resolution,
 * crash-loop + resume breakers, writer sweep, keeper adoption. Extracted
 * VERBATIM from src/ws-handler.js's switch; the body runs inside a
 * `do { ... } while (0)` so every case-level `break;` keeps its exact
 * pre-extraction meaning (inner loops' breaks are untouched).
 */

const { MessageManager } = require('./message-manager');
const { capsOf } = require('./backend-caps');
const { get: harnessOf } = require('./harnesses'); // S9: store-side fork (opencode serve) before the spawn
const { createMessageManager } = require('./normalizers');
const { listCodexThreads } = require('./codex-session-store');
const { findCodexSessionJsonlPath, extractCodexThreadMeta } = require('./adapters/codex'); // the per-turn model/effort readers reach ws-create through the harness descriptor's store hooks (B-6b6d)
const { cwdToProjectDir, findSessionJsonlPath, warmSessionJsonlAsync } = require('./session-store');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { REMOTE_PRELUDE, buildRemoteExec, nodeFinder } = require('./remote-shell');
const { sweepWriters } = require('./writer-sweep');
const { resumeSpawnPick, applyOriginHint, continuityLogLine } = require('./resume-continuity');

function createWsCreateHandler({ ctx, agentEnv, crashLoopRef, noConvoRef,
  execFileAsync, pickCodexThreadCandidate, getSessionKey, normalizeComparablePath }) {
  const {
    activeSessions, WS_OPEN, broadcastActiveSessions, broadcastToSession, resizeSessionToMin,
    setupSessionPty, refreshWebuiPids, deleteSessionMeta, writeSessionMeta, readSessionMeta,
    readLayouts, writeLayouts, getSyncStore, serverSetting, integrationEnabled, agentdRemote, dialBridge,
    sessionCounterRef, createSessionMessages, poolChooser, sbNoteServerOp,
    SOCKETS_DIR, BUFFERS_DIR, PTY_WRAPPER, CHAT_WRAPPER,
    NODE_CMD, DTACH_CMD, ENV_CMD, CLAUDE_CMD, EDITOR_CMD, AGENT_BIN_DIR, PORT, X_ENV,
    adapterRegistry, pty, path, fs, os, execFileSync, ensureDir, hosts,
    accounts, scheduleCtxSync, activeSessionsPayload, otelEnv,
    USAGE_STATUSLINE_CMD, userStatuslineCmd, serverNotice, autoResume,
  } = ctx;
  return async function handleCreate(ws, data, attachedSessions) {
    do {
          const backend = data.backend || 'claude';
          const adapter = adapterRegistry?.get?.(backend) || null;
          if (!adapter) {
            ws.send(JSON.stringify({ type: 'error', message: `Unknown backend "${backend}".` }));
            break;
          }
          if (adapter.installed === false) { // ACP harness whose executable is not on this machine (S8): refuse loudly BEFORE any spawn/dtach work
            ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: `${backend} is not installed on this machine (no "${adapter.config?.commandName || backend}" on PATH — install it or set ${String(backend).toUpperCase().replace(/-/g, '_')}_CMD).` }));
            break;
          }
          // Writer-sweep options per backend (P1 codex double-writer, see
          // writer-sweep.js): the codex legs get the webui ids of the LIVE
          // codex sessions on the TARGET machine as a protect list — a codex
          // app-server holds every rollout of its thread tree open (sub-agent
          // threads included, for its whole lifetime), so without it a resume
          // of a finished sub-agent thread would SIGTERM a healthy live
          // session's app-server (the 2.284.4 class). Live sessions are the
          // resume-already-live guard's business; the sweep reaches
          // external/orphaned writers only.
          const sweepOpts = (hostId) => backend === 'codex'
            ? { backend, protectSids: [...activeSessions].filter(([, es]) => (es.backend || 'claude') === 'codex' && (es.host || null) === (hostId || null)).map(([eid]) => eid) }
            : { backend };
          // Resume guard (2.179.0, userW's duplicate-session incident): a
          // plain claude --resume REUSES the conversation id — spawning it
          // while the original session is still LIVE puts TWO claude
          // processes on ONE JSONL (transcript double-writer class) and
          // duplicates the sidebar card. Refuse and hand the LIVE session
          // back; the client attaches it instead. Forks mint a new id (skip).
          // CODEX TOO (P1): the wrapper's `thread/resume` REUSES the thread
          // id (only `thread/fork` mints a new one — the old "codex resume
          // forks a new thread id" exemption was FALSE for the current
          // wrapper), so a second app-server on one rollout is the same
          // B-4058 double-writer class; match on backendSessionId (the live
          // thread id, kept current by session-stdout on every meta record).
          // Gated on the harness CAPS row (every chat harness with a stream
          // protocol — claude/codex/opencode…), never an id list: the S9
          // OpenCode serve store lists sessions this instance may already be
          // driving through a live acp-wrapper, and a plain resume from a
          // stale card would spawn a second `opencode acp` on one session.
          if (capsOf(backend).streamProtocol && data.resume && data.resumeId && !data.fork) {
            let existing = null;
            for (const [eid, es] of activeSessions) {
              if ((es.backend || 'claude') !== backend) continue;
              const liveId = backend === 'claude' ? (es.claudeSessionId || es.backendSessionId) : es.backendSessionId;
              if (liveId !== data.resumeId) continue;
              if ((es.host || null) !== (data.hostId || null)) continue;
              existing = [eid, es]; break;
            }
            if (existing) {
              ws.send(JSON.stringify({
                type: 'error', code: 'resume-already-live', reqId: data.reqId,
                existingId: existing[0], existingName: existing[1].name || '',
                existingCwd: existing[1].cwd || '', existingMode: existing[1].mode || 'chat',
                message: 'This conversation is already running in a live session — opening that instead of starting a second copy.',
              }));
              break;
            }
          }
          // Unresumable-conversation circuit breaker (2.207.1, real bootloop:
          // a remote session killed 9s after creation never flushed a
          // transcript — every resume died in ~2s with the CLI's "No
          // conversation found", and an automated recreation fed the loop 5×
          // in 2 minutes). Refuse further resumes for 10 minutes with the
          // honest explanation instead of another guaranteed death.
          if (data.resume && data.resumeId && !data.ignoreNoConvo) {
            const hit = noConvoRef.map.get(data.resumeId);
            if (hit && Date.now() - hit < 600000) {
              // VERIFY BEFORE BLAMING (2.227.3, userN's 46MB "修轮子"): the
              // CLI's "No conversation found" only proves claude looked in the
              // WRONG PLACE — a stale display-cwd ("Host: /path", the 2.225.2
              // bug) made it search the wrong project dir while the transcript
              // sat intact on the machine. The old text told the user to CLOSE
              // THE CARD AND START OVER, i.e. discard a live conversation.
              // Now: if a transcript for this id EXISTS anywhere we can see
              // (local project dirs OR the remote-jsonl cache), say the truth —
              // we know it exists, the last attempt looked in the wrong folder
              // — and let the client offer a retry instead of a dead end.
              const known = (() => { try { return !!findSessionJsonlPath(data.resumeId, data.cwd || ''); } catch { return false; } })();
              global.__vsEvent?.('resume-refused-no-transcript', known ? 'transcript-exists' : 'transcript-absent');
              ws.send(JSON.stringify({
                type: 'error', reqId: data.reqId, code: 'no-convo-breaker', resumeId: data.resumeId, transcriptKnown: known,
                message: known
                  ? 'The last resume attempt failed: the CLI could not find this conversation in the folder it was started from — but a transcript for it DOES exist, so the conversation is NOT lost. Check the session\'s working directory / machine, then try again (further attempts are paused for a few minutes to avoid a crash loop).'
                  : 'The last resume attempt failed with "no conversation found", and no transcript for it turned up on this machine or in the cache. It may have ended before anything was written — or it lives on a machine this instance can\'t see right now. Further attempts are paused for a few minutes; nothing has been deleted.',
              }));
              break;
            }
          }
          // Resume HOST INFERENCE (2.218.0, real incident): pre-hostId-era
          // window specs resumed REMOTE conversations host-less — a local
          // `claude --resume` of an h200 transcript died "No conversation
          // found" four times in a row while the conversation's home host was
          // reachable the whole time. If a host-less claude resume has no
          // LOCAL transcript but the remote-jsonl cache holds the
          // conversation under exactly ONE registered host, resume it ON that
          // host — and when the host still runs a live keeper child for the
          // conversation, ATTACH (keeperSid) instead of spawning a second
          // writer onto the same JSONL.
          if (data.resume && data.resumeId && !data.hostId && (data.backend || 'claude') === 'claude'
              && hosts && /^[\w-]+$/.test(data.resumeId)) {
            try {
              const projectsDir = path.join(os.homedir(), '.claude', 'projects');
              let local = false;
              try { local = fs.readdirSync(projectsDir).some((d) => fs.existsSync(path.join(projectsDir, d, data.resumeId + '.jsonl'))); } catch { }
              if (!local) {
                const cacheRoot = path.join(__dirname, '..', 'data', 'remote-jsonl');
                const owners = [];
                try {
                  for (const hd of fs.readdirSync(cacheRoot)) {
                    if (hosts.get(hd) && fs.existsSync(path.join(cacheRoot, hd, data.resumeId + '.jsonl'))) owners.push(hd);
                  }
                } catch { }
                // conversation-location INDEX first (R3 tail, 2.297.0): the
                // cache scan only knows conversations whose transcript was
                // already pulled once — the index also knows DISCOVERY-listed
                // ones. When both sources answer they must AGREE (disagreement
                // = ambiguous ⇒ refuse to infer, exactly like owners.length>1).
                const idxOwner = hosts.conversationOwner?.(data.resumeId) || null;
                if (idxOwner && !owners.length) owners.push(idxOwner);
                else if (idxOwner && owners.length === 1 && owners[0] !== idxOwner) owners.push(idxOwner); // force ambiguity
                if (owners.length === 1) {
                  data.hostId = owners[0];
                  console.log(`[session] resume host inferred: ${data.resumeId.slice(0, 8)} → ${owners[0]} (host-less resume of a cached remote conversation)`);
                  if (!data.keeperSid) {
                    try {
                      const k = await hosts.findKeeperFor(owners[0], data.resumeId);
                      // findKeeperFor scans ~/.vibespace/*/state/sessions = AGENTD pipe
                      // sids — tag them (B-218d): the ssh branch must adopt via the
                      // attach-cli, NOT the legacy keeper binary (which only knows
                      // ~/.vibespace/run and can never find these sids).
                      // k.error = the probe FAILED (host lag) — refuse rather than
                      // sweep+respawn onto a possibly-live claude (2.271.0 T1-1).
                      if (k?.error) {
                        ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, code: 'keeper-probe-failed',
                          message: `${owners[0]} isn’t responding — couldn’t verify whether this conversation is still running there. Retry in a moment.` }));
                        return;
                      }
                      if (k) { data.keeperSid = k.sid; data.keeperKind = k.kind; console.log(`[session] live ${k.kind} session ${k.sid} holds ${data.resumeId.slice(0, 8)} — attaching instead of spawning a second writer`); }
                    } catch { }
                  }
                }
              }
            } catch { }
          }
          // ONE counter value for BOTH the id and the socket name (a fleet user's
          // 2026-08-11 incident, proven in production data): sockName re-read
          // `sessionCounterRef.value` ~100 lines and several AWAITS later
          // (cwd preflight, host inference, findKeeperFor), so a burst of
          // concurrent creates — exactly what a multi-agent orchestrator
          // produces — had every session read the counter's LATEST value:
          // four sessions with ids sess-21/22/31/34 all took sockName cw-36,
          // differing only in the Date.now() millisecond. Two landing in the
          // SAME millisecond share a socket path AND a session-meta file, so
          // one session's metadata (name, claudeSessionId, account, taskId)
          // silently overwrites the other's — the state-crossing class.
          const seq = ++sessionCounterRef.value;
          const id = 'sess-' + seq + '-' + Date.now();
          // cwd default: a REMOTE/DIAL session with no explicit cwd must land
          // in the DEVICE's home, NOT this server's (B-0d70: the pod's
          // /home/<user> doesn't exist on a Mac → `cd` failed and, on the
          // pipe-session path, a nonexistent spawn cwd crashed the daemon).
          let cwd = data.cwd || '';
          let cwdRecreated = false; // B-7812: set when the missing cwd was rebuilt on user confirm
          // Server-side twin of the client's stripCwdHostLabel (utils.js): the
          // sidebar's folder-grouping display cwd "<host name>: /path" leaked
          // into persisted openSpecs, and a resume that `cd`'d into the literal
          // label fell back to $HOME — claude then said "No conversation found"
          // (real incident, userL h200). Strip iff the remainder is a real
          // absolute/home path; heals old clients + already-persisted layouts.
          {
            const m = /^[^/~]+: (?=[/~])/.exec(cwd);
            if (m) { console.warn(`[session] stripped display host-label from cwd: ${cwd}`); cwd = cwd.slice(m[0].length); }
          }
          if (!cwd) {
            if (data.hostId && hosts) {
              try { const hh = hosts.get(data.hostId); cwd = (hh && await hosts.homeDir(hh)) || ''; } catch { }
            }
            if (!cwd) cwd = os.homedir();
          } else if ((data.backend || 'claude') !== 'shell') {
            // Spawn-cwd preflight (2.226.0, user directive "不要静默失败"): an
            // EXPLICIT cwd that doesn't exist used to fall back to $HOME
            // silently — for claude/codex that broke resumes ("No conversation
            // found" from the wrong project dir) and misplaced new sessions.
            // Fail fast with the honest reason. BEST-EFFORT: only a definitive
            // MISSING refuses; a probe error/timeout proceeds as before.
            // (Shell terminals keep the home fallback — a terminal in $HOME is
            // usable; a transcript-coupled session in the wrong dir is not.)
            let missing = false;
            let hostName = '';
            try {
              if (!data.hostId) {
                // Child-process probe, NEVER node fs (§2.108.3 hung-mount
                // doctrine: a wedged FUSE path blocks sync fs / eats a
                // threadpool slot; a stuck child just gets killed by timeout).
                missing = await new Promise((resolve) => {
                  execFile('test', ['-d', cwd], { timeout: 4000 }, (err) => resolve(!!err && err.code === 1));
                });
              } else if (hosts) {
                const hh = hosts.get(data.hostId);
                if (hh) {
                  hostName = hh.name || hh.host || '';
                  const q = cwd.replace(/'/g, `'\\''`);
                  const out = await Promise.race([
                    hosts._hostShell(hh, `[ -d '${q}' ] && echo __VS_DIR_OK__ || echo __VS_DIR_MISSING__`, { timeoutMs: 5000 }),
                    new Promise((r) => setTimeout(() => r(''), 5500)),
                  ]);
                  missing = String(out).includes('__VS_DIR_MISSING__');
                }
              }
            } catch { /* probe failure must never block a create */ }
            // Recreate-empty-and-resume (B-7812, user-approved DANGER path):
            // only on the client's EXPLICIT flag (set after a red confirm that
            // spells out the files are gone). The resumed agent is told the
            // dir was recreated empty via prompt-context (_cwdRecreated) — the
            // user's hard requirement against silently continuing on a false
            // premise.
            if (missing && data.recreateCwd === true) {
              let made = false;
              try {
                if (!data.hostId) {
                  made = await new Promise((resolve) => {
                    execFile('mkdir', ['-p', cwd], { timeout: 8000 }, (err) => resolve(!err));
                  });
                } else if (hosts) {
                  const hh = hosts.get(data.hostId);
                  const q = cwd.replace(/'/g, `'\\''`);
                  const out = hh ? await hosts._hostShell(hh, `mkdir -p '${q}' && echo __VS_MKDIR_OK__`, { timeoutMs: 8000 }) : '';
                  made = String(out).includes('__VS_MKDIR_OK__');
                }
              } catch { }
              if (made) {
                missing = false;
                cwdRecreated = true;
                global.__vsEvent?.('spawn-cwd-recreated', data.hostId ? 'host' : 'local');
                console.log(`[session] recreated missing cwd (user-confirmed): ${cwd}`);
              } else {
                ws.send(JSON.stringify({
                  type: 'error', reqId: data.reqId, code: 'cwd-mkdir-failed',
                  message: `Could not recreate the directory${hostName ? ` on ${hostName}` : ''}: ${cwd}`,
                }));
                break;
              }
            }
            if (missing) {
              global.__vsEvent?.('spawn-cwd-missing', `${data.hostId ? 'host' : 'local'}/${data.resume ? 'resume' : 'new'}`);
              ws.send(JSON.stringify({
                type: 'error', reqId: data.reqId, code: 'cwd-missing', cwd, hostName: hostName || undefined,
                message: `Working directory does not exist${data.hostId ? " on the session's machine" : ''}: ${cwd}` +
                  (data.resume ? ' — the folder may have been moved or deleted; restore it or start a new session in a valid folder.' : ''),
              }));
              break;
            }
          }
          // ROOT FIX (2.304.0): the socket name is DERIVED FROM THE ID, not
          // minted independently. A session had TWO identities built from two
          // separate expressions (`sess-<seq>-<now>` and `cw-<seq>-<now>`);
          // any divergence between them — a re-read counter, a millisecond
          // drift, a future edit to one and not the other — silently maps two
          // sessions onto one session-meta file. Deriving makes them ONE
          // identity: the meta filename is now a pure function of the session
          // id, so a collision requires duplicate session ids, which the
          // counter+timestamp already excludes.
          const sockName = 'cw-' + id.slice('sess-'.length);
          const socketPath = path.join(SOCKETS_DIR, sockName);
          const sessionMode = data.mode === 'chat' ? 'chat' : 'terminal';
          // Shell-style tokenization: quoted segments stay one argument
          // (plain split broke e.g. --append-system-prompt "two words")
          const extraArgs = Array.isArray(data.extraArgs) ? data.extraArgs.map(String)
            : data.extraArgs
              ? (String(data.extraArgs).trim().match(/"[^"]*"|'[^']*'|\S+/g) || []).map(t => t.replace(/^(["'])(.*)\1$/, '$2'))
              : [];
          // S9 (B-03f2): a harness whose STORE forks server-side (opencode:
          // POST /session/:id/fork on the serve API) mints the NEW conversation
          // id BEFORE the spawn — the session then resumes THAT id (the wrapper's
          // session/load), nothing to adopt later. The user asked for a fork:
          // any failure (not installed / serve parked / no fork endpoint / 404)
          // is refused LOUDLY here, never degraded into a plain resume (that
          // would put two writers on the parent — the B-4058 class).
          if (data.fork && data.resume && data.resumeId && !data.hostId && typeof harnessOf(backend).store?.forkSession === 'function') {
            let forked;
            try { forked = await harnessOf(backend).store.forkSession(data.resumeId, { cwd }); }
            catch (e) {
              ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, code: 'fork-failed', message: `Fork failed: ${e.message}` }));
              break;
            }
            console.log(`[session] ${backend} fork minted ${forked.id} from ${data.resumeId}`);
            data.forkedFromId = data.resumeId;
            data.resumeId = forked.id;
          }
          // ── RESUME CONTINUITY LADDER (B-6b6d, owner ruling 2026-09-07) ──
          // explicit pick > the CONVERSATION's own last value > instance
          // default (logged). The rule and the reason it is not two `||`
          // chains live in src/resume-continuity.js; the per-harness READER is
          // the descriptor's `store.lastTurn<Knob>` hook, whose presence IS the
          // "this harness can answer" declaration (codex: model+effort from its
          // rollout's turn_context; claude: model from the transcript's last
          // assistant record, and NO effort source at all — nothing claude
          // writes records it, so a claude resume with no pick commands none).
          // The client stopped filling the instance default on resumes in the
          // same change: it is a NEW-session default, and filling it there is
          // what suppressed this ladder and resumed an `ultra` conversation at
          // `xhigh` (2.369.62's known residue).
          {
            const isResume = !!(data.resume && data.resumeId);
            const hstore = (() => { try { return harnessOf(backend).store || {}; } catch { return {}; } })();
            const prefix = (() => { try { return harnessOf(backend)?.settingsPrefix || backend; } catch { return backend; } })();
            const instDefault = (key) => { try { return serverSetting(`${prefix}.${key}`) || ''; } catch { return ''; } };
            const fromConversation = async (hook) => {
              if (!isResume || typeof hook !== 'function') return '';
              // A conversation whose records cannot be read is a MISSING FACT,
              // never a silent zero: it degrades to the instance default one
              // rung down, and the reason is logged verbatim (the swallowed-
              // degrade lesson).
              try { return (await hook(data.resumeId, cwd)) || ''; }
              catch (e) { console.warn(`[session] resume continuity: could not read ${backend} ${String(data.resumeId).slice(0, 8)} — ${e.message}`); return ''; }
            };
            // An explicit pick wins inside the ladder anyway, so do not pay for
            // a store read whose answer cannot be used (an opencode read talks
            // to the serve; a transcript read hits the disk, on the spawn path).
            // `explicit` is forwarded UNTOUCHED: only the ladder may decide what
            // `''` means, and on a NEW session it means a STATED "Auto (model
            // default)" rather than silence (r2 review — normalising it here is
            // how the dialog's explicit Auto became `codex.defaultEffort`).
            const pickKnob = async (explicit, hook, key) => {
              const stated = explicit !== undefined && explicit !== null && String(explicit).trim() !== '';
              const conversation = stated ? '' : await fromConversation(hook);
              return resumeSpawnPick({
                explicit, conversation, instanceDefault: instDefault(key),
                resume: isResume, hasSource: typeof hook === 'function',
              });
            };
            const picks = {
              model: await pickKnob(data.model, hstore.lastTurnModel, 'defaultModel'),
              effort: await pickKnob(data.effort, hstore.lastTurnEffort, 'defaultEffort'),
            };
            // …and on a NEW session the client already ran the same ladder to
            // fill its own chip, so a resolved `<prefix>.default*` arrives here
            // as a bare string indistinguishable from a pick. `spawnOriginHint`
            // is the client saying which it was; applyOriginHint may only turn
            // OUR 'chosen' into 'instance'/'harness' and never touches the value
            // (round 3 — src/resume-continuity.js carries the whole argument).
            const hint = data.spawnOriginHint || {};
            picks.model.origin = applyOriginHint(picks.model.origin, hint.model);
            picks.effort.origin = applyOriginHint(picks.effort.origin, hint.effort);
            // Every downstream reader (the spawn, the pool chooser's declared
            // model, _spawnModel, the lock's implicit target, session._effort)
            // must see the value this session ACTUALLY starts with — one
            // resolved fact, not the request's intent.
            data.model = picks.model.value || undefined;
            data.effort = picks.effort.value || undefined;
            data._modelOrigin = picks.model.origin;
            data._effortOrigin = picks.effort.origin;
            // PLACEMENT IS NOT COMMANDING (round 3). The pooled-spawn chooser
            // downstream wants a model FAMILY ('fable'/'opus'/'sonnet' —
            // src/model-family.js, coarse by construction: no point release, no
            // `[1m]` variant) to project each member's model-scoped weekly cap.
            // A claude resume now deliberately commands NOTHING, so `data.model`
            // is undefined there, `familyOfModel(null)` is null and the chooser
            // short-circuits BEFORE decidePoolSwitch — the session lands on the
            // pool's current target with no placement evaluation at all, even
            // when that member's scoped weekly bucket is spent (the 2.305.0
            // class), and a claude pool switch does not reach a running CLI for
            // ~25min (2.361.0) so the spawn-time placement is the one that
            // counts. This restores exactly the input master had (the client
            // used to fill `claude.defaultModel` into every resume) as a
            // PLACEMENT-ONLY hint: it never reaches data.model, the spawn spec,
            // the argv or session._spawnModel — that field records what the
            // spawn COMMANDED, and this spawn commanded nothing, so putting the
            // hint there would leak a value we never sent into session-meta,
            // the attach payload, the restart chip and sessionModelFor's floor.
            // Unset setting ⇒ null ⇒ master's behaviour when it was unset (the
            // chooser's default target).
            data._placementModelHint = data.model || instDefault('defaultModel') || null;
            if (isResume) console.log(continuityLogLine(backend, data.resumeId, picks));
          }
          const sessionSpec = adapter.buildSessionArgs({
            cwd,
            model: data.model,
            permissionMode: data.permissionMode,
            resumeId: data.resume && data.resumeId ? data.resumeId : null,
            fork: data.fork || false,
            sessionName: data.sessionName,
            effort: data.effort,
            // client value wins; else the instance default (covers every create
            // path uniformly — resume, layout restore, billing switch)
            // RESPONSE STYLE (2.369.58): client value wins; else the
            // instance default for THIS harness's settings family
            // (`<prefix>.outputStyle` — never the hardcoded claude key, which
            // would have handed a codex spawn "Concise"). A value outside the
            // harness's own vocabulary is dropped here so it never reaches a
            // spawn: the caps row is the ONE enum.
            outputStyle: (data._effOutputStyle = (() => {
              const rs = capsOf(backend).responseStyle || { closed: true, values: [] };
              let prefix = backend; try { prefix = harnessOf(backend)?.settingsPrefix || backend; } catch { /* unknown id: caps are empty anyway */ }
              const want = data.outputStyle || (() => { try { return serverSetting(`${prefix}.outputStyle`) || ''; } catch { return ''; } })();
              // A CLOSED vocabulary (codex Personality) is validated here so an
              // out-of-enum value can never reach a spawn; an OPEN one (claude,
              // whose ~/.claude/output-styles/*.md are real user-defined styles)
              // passes through — `values` there is only what the picker offers,
              // and filtering on it would silently eat the user's own style.
              return (!rs.closed || rs.values.includes(want)) ? want : '';
            })()),
            extraArgs,
            initialPrompt: data.initialPrompt || '',
            mode: sessionMode,
            tuiRenderer: data.tuiRenderer || '',
            // Server-side read (covers every create path uniformly — resume,
            // layout restore, billing switch); only the claude adapter
            // consumes it (codex has no model-fallback mechanism).
            disableModelFallback: (() => { try { return serverSetting('claude.disableModelFallback') === true; } catch { return false; } })(),
            // Shell helper terminals auto-type this — the adapter arms the
            // DISABLE_UPDATE_PROMPT guard (oh-my-zsh's rc-time [Y/n] eats the
            // first typed char: "claude /login" → "laude"). 2.196.0: the field
            // never reached the server before, so the guard was dead code and
            // the mangling hit REMOTE shells (env rides the exec-env prefix).
            initialCommand: data.initialCommand || undefined,
            // Background-job owner notify (2.344.0): our sessions run bypass-
            // permissions, whose inbound default HOLDS an unattested peer
            // message — pre-accept via the CLI's documented --settings knob so
            // job notifications actually deliver. Follows the same global
            // toggle that gates sending; repo/managed settings can tighten.
            // LOCAL spawns only (the remote field is data.hostId — a data.host
            // guard was a dead check, caught by the 2.344.0 review): accept
            // only where our peer-messaging can actually deliver, and never
            // ship channel flags to a machine that lacks the script.
            acceptPeerMessages: (() => { try { return !data.hostId && serverSetting('agents.jobNotify') !== false; } catch { return !data.hostId; } })(),
            // EXPERIMENTAL VibeSpace channel (default OFF; local claude only —
            // the channel script + socket live on THIS machine)
            vibespaceChannel: (() => {
              try {
                if (serverSetting('agents.vibespaceChannel') !== true || data.hostId) return null;
                const sockDir = path.join(__dirname, '..', 'data', 'channel-socks');
                fs.mkdirSync(sockDir, { recursive: true, mode: 0o700 });
                return { script: path.join(__dirname, '..', 'data', 'bin', 'vibespace-channel.js'), sock: path.join(sockDir, id + '.sock') };
              } catch { return null; }
            })(),
          });
          // For codex resume: inherit forkedFrom chain from old session's JSONL.
          // MODEL CONTINUITY (2.369.32) and EFFORT CONTINUITY (B-21e4 item 4)
          // used to sit HERE, as two `if (!sessionSpec.env.CODEX_WEBUI_*)`
          // post-fills. They now run BEFORE the spawn spec, for every harness,
          // through the resume-continuity ladder above — the post-fill could
          // only ever fire when the client sent nothing, and the client sent
          // the instance default on every resume (B-6b6d), so the fallback the
          // env test was guarding was unreachable exactly when it was needed.
          if (backend === 'codex' && data.resumeId && sessionSpec.env) {
            const oldPath = findCodexSessionJsonlPath(data.resumeId);
            const oldChain = oldPath ? (extractCodexThreadMeta(oldPath).forkedFrom || []) : [];
            if (!oldChain.includes(data.resumeId)) oldChain.push(data.resumeId);
            sessionSpec.env.CODEX_WEBUI_FORKED_FROM = oldChain.join(',');
          }
          const codexThreadBaseline = backend === 'codex' && !data.resumeId
            ? new Set(listCodexThreads({ activeSessions }).map((entry) => entry.backendSessionId || entry.sessionId).filter(Boolean))
            : null;

          ensureDir(SOCKETS_DIR);
          ensureDir(BUFFERS_DIR);

          // Billing identity (Claude: subscription ↔ API/console account; Codex:
          // ChatGPT subscription via an isolated CODEX_HOME). Local sessions get
          // the auth via the spawn process env; REMOTE sessions get an API key
          // via an ssh-stdin-shipped 0600 file + shell prefix assignment (see
          // remoteAccountEnv — subscription accounts stay local-only). Resolved
          // BEFORE the session object so a bad account aborts the create cleanly.
          let spawnAccount = null;
          // A LINKED account (same email as the host's own login) spawns via
          // the host's login (spawnAccount nulled below) but the PICKED
          // identity must survive onto session._accountId — else the badge
          // and the billing switcher's ✓ degrade to "CLI login @ host" and a
          // successful switch reads as failed (2.241.0, userN's report).
          let linkedAccountId = null;
          // ADOPT vs explicit billing pick (B-b87b): an adopted session keeps
          // the SURVIVING child's original billing — the requested account
          // would be stamped on the badge but never take effect (billing lie,
          // exactly what the switcher exists to change). With an explicit
          // pick, skip adoption entirely: fall through to the writer sweep +
          // respawn so the pick is real. Adoption probes below carry the same
          // !data.accountId gate.
          if (data.accountId && data.keeperSid) {
            console.log(`[session] explicit account pick ${String(data.accountId).slice(0, 12)} — skipping keeper adopt of ${data.keeperSid} (respawn applies the pick)`);
            delete data.keeperSid; delete data.keeperKind;
          }
          if ((backend === 'claude' || backend === 'codex') && accounts) {
            try {
              // Plan C (2.315.0): a LOCAL pooled session gets its own link,
              // chosen by the session's declared model (deps.poolChooser reads
              // the usage caches with the estimator overlay — the store never
              // does). Remote pools stay refused upstream; non-pool accounts
              // ignore the opts entirely.
              // The model here is a FAMILY hint for placement, NOT the spawn's
              // command — a claude resume commands nothing (B-6b6d) and
              // `familyOfModel(null)` skips the whole evaluation, so
              // `_placementModelHint` (set with the ladder above) carries the
              // instance default in as the family guess master used to get.
              spawnAccount = accounts.resolveForSpawn(data.accountId, backend, data.hostId ? {} : {
                sessionKey: id,
                chooseMember: () => poolChooser?.(data.accountId || accounts?._state?.defaultAccountId, { model: data.model || data._placementModelHint || null }),
              });
            }
            catch (e) {
              // Host-held subscription (2.199.0): an account whose login lives
              // ONLY on a host has an EMPTY local dir — resolveForSpawn throws
              // "not logged in" before the hostSubs mapping below ever runs
              // (real report: picking the account for a session on that very
              // host failed). Probe the host before failing the create; the
              // spawn then points at the host-side dir, nothing ships.
              let rescued = null;
              // DELETED billing account on a RESUME (2.335.0, real report):
              // the stored accountId no longer exists — nothing to re-login,
              // so a hard throw bricks the conversation forever. Degrade to
              // the global login and SAY so; a fresh create keeps the throw
              // (the user just picked that account — failing loud is right).
              if (data.resumeId && /unknown account/.test(String(e.message))) {
                try { serverNotice?.(`resume-acct-gone-${id}`, `The billing account this conversation used was deleted — it resumed on the default login instead. Pick a new account in its billing switcher if needed.`, { level: 'warn' }); } catch { }
                console.warn(`[session] resume ${id}: stored account ${String(data.accountId).slice(0, 16)} no longer exists — degrading to global login`);
                rescued = { id: null, kind: null, _acctGone: true };
                data.accountId = null; // the dead id must not hold the keeper-adopt gates closed downstream
              }
              if (!rescued && data.hostId && hosts && backend === 'claude'
                  && typeof data.accountId === 'string' && /^sub-[\w-]{1,40}$/.test(data.accountId)
                  && /not logged in/.test(String(e.message))) {
                try {
                  // SINGLE-AUTHORITY verdict (B-f531, 2.244.0): the same
                  // evaluateOnHost that feeds every display surface decides
                  // the rescue — held dir first (deterministic creds), then
                  // email-linked; and a held dir whose REPORTED identity
                  // mismatches the account is refused loudly instead of
                  // billing whoever's creds sit in it.
                  const rs = await hosts.accountsStatus(data.hostId);
                  const facts = { ...rs, hostId: data.hostId, transport: hosts.get(data.hostId)?.transport === 'dial' ? 'dial' : 'ssh' };
                  const v = accounts.evaluateOnHost(accounts.get(data.accountId), facts, {});
                  if (v.reason === 'held-identity-mismatch') {
                    ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: `Account error: the login held on the host for this account actually belongs to ${v.dirEmail} — re-run "Log in on host as this account" to fix it` }));
                    return;
                  }
                  if (v.usable && v.how === 'host-held') {
                    rescued = {
                      id: data.accountId, kind: 'subscription', _hostSubReady: true,
                      remoteCreds: { dirName: 'subs/' + data.accountId, envVar: 'CLAUDE_SECURESTORAGE_CONFIG_DIR' },
                    };
                  } else if (v.usable && v.how === 'host-login') {
                    rescued = { id: null, kind: null, _useHostLogin: true };
                  }
                } catch { /* probe failed — fall through to the original error */ }
              }
              if (!rescued) {
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: 'Account error: ' + e.message }));
                return;
              }
              spawnAccount = rescued;
              // email-linked rescue resolves to the host's own login = the
              // same null the 'subscription' sentinel produces downstream
              if (spawnAccount && spawnAccount._useHostLogin) { linkedAccountId = data.accountId; spawnAccount = null; }
              if (spawnAccount && spawnAccount._acctGone) spawnAccount = null; // deleted-account degrade = plain global login
            }
            // REMOTE + the account came from the DEFAULT (nothing specified) +
            // it could only reach the host by shipping subscription creds →
            // fall back to the HOST's own CLI login instead of failing the
            // spawn later with the shipping-disabled error (real report:
            // resuming a remote session with no account picked errored).
            // An EXPLICITLY chosen subscription still errors with guidance,
            // and an opted-in shipSubscriptionToRemote still ships.
            if (spawnAccount?.pooled && data.hostId) {
              // Pools are LOCAL-ONLY (the symlink dir lives on this machine;
              // its path in a remote spawn env is meaningless — the session
              // would silently bill the host's own login while badged as the
              // pool, B-b87b). Default-picked pool → fall back to the host's
              // login honestly; explicitly picked → refuse with guidance.
              if (data.accountId) {
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: 'Account error: pooled accounts are local-only (the pool switches a credentials directory on THIS machine) — pick a real account for remote sessions, or the host’s own CLI login' }));
                return;
              }
              spawnAccount = null; // = the host's own login
            }
            if (spawnAccount?.remoteCreds && !spawnAccount.secret && data.hostId && !data.accountId) {
              let allowShip = false;
              try { allowShip = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch {}
              if (!allowShip || spawnAccount.remoteCreds.shippable === false) spawnAccount = null; // = the host's own login (an oat-bearing account keeps its secret channel instead; macOS Keychain-backed logins never ship — PR #23)
            }
            // EXPLICITLY-chosen subscription on a remote host without the
            // ship opt-in: when the account IS the machine's own login (same
            // email — the identity probe is reliable since 2.197.0), run on
            // the host's login directly instead of failing (real report: "I
            // logged this exact account in ON the machine, yet picking it
            // says this-machine-only"). Zero creds ship — §ban-safety
            // unchanged; a non-matching account still errors with guidance.
            if ((spawnAccount?.remoteCreds || spawnAccount?.oatOnly) && data.hostId && data.accountId && hosts) {
              let allowShip = false;
              try { allowShip = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch {}
              // oatOnly always probes: a host-HELD login outranks the oat
              // (full capability, same identity) and the held-identity-
              // mismatch refusal must not be skippable by adding a token.
              // shippable===false (macOS Keychain-backed, PR #23) probes too —
              // held/linked still work there; only shipping is off the table.
              if (!allowShip || spawnAccount.oatOnly || spawnAccount.remoteCreds?.shippable === false) {
                try {
                  // SINGLE-AUTHORITY verdict (B-f531, 2.244.0) — same
                  // evaluateOnHost as the display surfaces and the rescue
                  // path above. Precedence lesson (2.243.2): host-held beats
                  // email-linked (the dir's creds are deterministic; the
                  // host's config email goes stale right after a /login
                  // switch — the 2.114.1 class — and a stale match billed
                  // the machine's ACTUAL new login under the picked badge).
                  const rs = await hosts.accountsStatus(data.hostId);
                  const facts = { ...rs, hostId: data.hostId, transport: hosts.get(data.hostId)?.transport === 'dial' ? 'dial' : 'ssh' };
                  const v = accounts.evaluateOnHost(accounts.get(spawnAccount.id), facts, {});
                  if (v.reason === 'held-identity-mismatch') {
                    ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: `Account error: the login held on the host for this account actually belongs to ${v.dirEmail} — re-run "Log in on host as this account" to fix it` }));
                    return;
                  }
                  if (v.usable && v.how === 'host-held') {
                    spawnAccount._hostSubReady = true;
                    // oatOnly shape carries no remoteCreds — the held-dir
                    // pointer paths need one (dirName/envVar only, nothing ships)
                    if (!spawnAccount.remoteCreds) spawnAccount.remoteCreds = { dirName: 'subs/' + spawnAccount.id, envVar: 'CLAUDE_SECURESTORAGE_CONFIG_DIR' };
                  } else if (v.usable && v.how === 'host-login') {
                    linkedAccountId = spawnAccount.id; // identity survives the host-login mapping
                    spawnAccount = null; // = the host's own login (same account)
                  }
                } catch { /* probe failed — keep the explicit-account path (errors later with guidance) */ }
              }
            }
          }

          const session = {
            mode: sessionMode,
            pty: null, clients: new Map([[ws, { cols: data.cols || 120, rows: data.rows || 30 }]]),
            cwd, name: data.sessionName || `Session ${seq}`, // seq, not a re-read — two concurrent creates otherwise BOTH default to 'Session N'
            createdAt: Date.now(),
            // Per-session bearer for the agent-facing API (vibespace-status):
            // spawned into the CLI's env, scopes writes to this session only
            agentToken: 'vsst_' + crypto.randomBytes(12).toString('hex'),
            // Task Group this session was spawned INTO (from the New-session
            // dialog). Belonging is otherwise LIVE-derived server-side from the
            // session token; this only covers the window before the async UI
            // bind lands. VALIDATED to the id shape (metachar-free — kept as
            // defense-in-depth even though it's no longer shell-interpolated).
            _initialGroupId: (typeof data.taskId === 'string' && /^T-[\w-]{1,60}$/.test(data.taskId)) ? data.taskId : null,
            // Billing identity badge (the key itself only lives in the spawn
            // env); a linked account spawns via the host's login but IS that
            // account — keep its identity (2.241.0)
            _accountId: spawnAccount?.id || linkedAccountId || null,
            // HOW the billing resolved (B-f531): rides the created reply so
            // the client persists/displays the POST-FACTO truth, never the
            // pre-facto intent
            _billingHow: spawnAccount?._hostSubReady ? 'host-held'
              // oat rung BEFORE remoteCreds: a logged-in+oat account carries
              // BOTH, but remote spawns use the SECRET channel (env token) —
              // stamping 'ship' told the client its rotating login was tarred
              // to the host, the exact action the oat exists to avoid
              : (spawnAccount?.secret?.var === 'CLAUDE_CODE_OAUTH_TOKEN' && (data.hostId || spawnAccount?.oatOnly)) ? 'oat'
              : (spawnAccount?.remoteCreds && data.hostId) ? 'ship'
              : spawnAccount ? 'local-env'
              : linkedAccountId ? 'host-login'
              : 'cli-login',
            // Billing intent at spawn: without an env key the CLI follows its
            // GLOBAL login — record what that was RIGHT NOW so the badge can
            // warn about API-billed sessions even after the user re-logins to
            // the subscription. The stream's init record (apiKeySource) later
            // CONFIRMS/overrides this guess (chat sessions).
            _authAtSpawn: (spawnAccount?.kind === 'subscription' || spawnAccount?.kind === 'codex-subscription') ? 'subscription-acct'
              : spawnAccount ? 'env-key'
              : backend !== 'claude' ? null
              : data.hostId ? 'remote-global'
              : (accounts?.subscriptionStatus?.().loggedIn ? 'subscription'
                : (accounts?.cliPrimaryKey?.().present ? 'console' : 'unknown')),
            backend,
            backendSessionId: data.resumeId || null,
            claudeSessionId: backend === 'claude' ? (data.resumeId || null) : null,
            sourceKind: data.sourceKind || null,
            agentKind: data.agentKind || 'primary',
            agentRole: data.agentRole || '',
            agentNickname: data.agentNickname || '',
            parentThreadId: data.parentThreadId || null,
            // Permission mode is not recoverable from the JSONL (init records
            // are stdout-only) — remember what this session was started with
            // so attach can restore the status bar immediately
            _permissionMode: data.permissionMode || null,
            // Effort is never reported back by claude — remember the commanded
            // value (spawn flag now, set-effort later) for the status bar
            _effort: data.effort || null,
            // WHICH FACT the spawn's model/effort came from (B-6b6d):
            // 'chosen' (a pick for this session) / 'conversation' (its own last
            // turn) / 'instance' (the <prefix>.default* setting) / 'harness'
            // (nothing sent — the agent's own config decides). Session
            // Properties SAYS this instead of guessing it from the value, which
            // cannot be done: a conversation's own value and the instance
            // default are frequently the same string.
            _modelOrigin: data._modelOrigin || null,
            _effortOrigin: data._effortOrigin || null,
            _modelLocked: !!data.modelLock,  // #6 lock v2: re-pin the target model after any fallback (turn-end)
            // EXPLICIT target only (review-caught): inferring it from data.model
            // re-targeted the lock to claude.defaultModel on any resume whose
            // saved config had no model. No target ⇒ the server latches the
            // first main-thread served model instead.
            _lockedModel: data.modelLock ? (data.lockModel || data.model || null) : null,
            // Claude --fork-session mints a NEW session id at startup; this arms
            // the stdout parser to adopt it (so the fork becomes its own session
            // instead of shadowing the parent). One-shot, cleared on adoption.
            _forkRequested: !!data.fork && !!capsOf(backend).fork, // per-harness (codex thread/fork since 2.369.21)
            // resume spawn marker (2.219.0): lets the parser adopt claude's
            // IMPLICIT fork (locked-conversation resume mints a new id)
            _resumeSpawn: backend === 'claude' && !!(data.resume && data.resumeId),
            sockName, socketPath, buffer: '',
          };
          if (codexThreadBaseline) session._codexThreadBaseline = codexThreadBaseline;
          if (sessionMode === 'chat') {
            session._normalizer = createMessageManager(backend, id);
            session._normEpoch = Date.now();
            session._normalizer.onOp((op) => {
              try { if (session.host && session.keeperSid) sbNoteServerOp?.(session.host, session.keeperSid, op); } catch { } // session-brain step-2 dark tap
              broadcastToSession(session, id, { type: 'msg', sessionId: id, ...op });
            });
          }

          // Use appropriate wrapper inside dtach:
          // - Terminal: pty-wrapper.js (spawns claude with PTY for TUI mode)
          // - Chat: chat-wrapper.js (spawns claude with --output-format stream-json)
          const bufFile = path.join(BUFFERS_DIR, id + '.buf');
          const metaFileW = path.join(BUFFERS_DIR, id + '.json');
          const wrapper = sessionSpec.wrapper || (sessionMode === 'chat' ? CHAT_WRAPPER : PTY_WRAPPER);
          // Remote session (collaboration P2, terminal mode): the LOCAL dtach+
          // pty-wrapper machinery stays (buffer/restore all work unchanged) but
          // the wrapped command becomes ssh -t … dtach -A on the REMOTE — a
          // network drop doesn't kill the agent; reattach = re-ssh.
          let spawnCmd = sessionSpec.cmd || CLAUDE_CMD;
          let spawnArgs = sessionSpec.args || [];
          let spawnEnvPairs = Object.entries(sessionSpec.env || {}).map(([k, v]) => `${k}=${v == null ? '' : String(v)}`);
          // B-0f13: REMOTE claude terminal sessions get the SAME passive
          // statusline capture local ones have had since 2.60.0 — the script
          // ships with the agent tools (per-spawn tar), the cache lands in
          // ~/.vibespace/usage-cache on the host (VIBESPACE_USAGE_CACHE — the
          // host has no data/ layout), and the quota-refresh read path merges
          // it back (fetchedAt-guarded, zero vendor calls). The --settings
          // JSON rides the normal rargs quoting (each remote arg is shq'd),
          // which is the whole quoting hazard handled in one place. Local
          // sessions keep their existing injection below, untouched.
          if (backend === 'claude' && sessionMode === 'terminal' && data.hostId) {
            try {
              let settingsObj = {};
              const si = spawnArgs.indexOf('--settings');
              if (si >= 0 && spawnArgs[si + 1]) { try { settingsObj = JSON.parse(spawnArgs[si + 1]) || {}; } catch {} }
              settingsObj.statusLine = { type: 'command', command: '"$HOME"/.vibespace/bin/vibespace-usage', padding: 0 };
              const sjson = JSON.stringify(settingsObj);
              if (si >= 0) spawnArgs[si + 1] = sjson; else spawnArgs = [...spawnArgs, '--settings', sjson];
              // Spawn-fixed BY CONSTRUCTION on a remote host (no VIBESPACE_
              // ACCOUNT_LINK twin, unlike the local branch below): a host gets
              // the credentials TARRED to it at spawn and the engine's
              // re-points skip host sessions (`s2.host` ⇒ continue), so there
              // is no later switch for this key to be wrong about.
              const acctKey = spawnAccount?.poolTarget || spawnAccount?.id || '__global__';
              spawnEnvPairs.push(`VIBESPACE_ACCOUNT_KEY=${acctKey}`);
              // NO cache-dir env: env pairs are shq-quoted (a $HOME inside
              // single quotes never expands), and none is needed — the script
              // defaults to __dirname/../usage-cache, which at its shipped
              // location ~/.vibespace/bin resolves to ~/.vibespace/usage-cache
              // exactly. The env override exists for tests only.
            } catch { }
          }
          let spawnCwd = cwd;
          // Integration master switch (agents.vibespaceIntegration, 2.190.0):
          // OFF ⇒ this spawn carries nothing AGENT-VISIBLE — no VIBESPACE_API,
          // no agent tools on PATH, no remote tools/hook-register/reverse-
          // tunnel. Model-invisible plumbing is EXEMPT by design (2.190.1,
          // user decision): the usage statusline, billing env, and
          // VIBESPACE_SESSION_TOKEN (Ctrl+G editor auth; inert without the
          // api var — every consumer guards on both). Read per spawn = live.
          let integrationOn = integrationEnabled ? integrationEnabled() : true;
          // A remote Add-subscription helper terminal needs this one transport
          // utility even when agent-visible Integration is OFF. It handles the
          // host's own Keychain/file login only and exposes nothing to agents.
          const needsClaudeLoginHelper = backend === 'shell'
            && String(data.initialCommand || '').includes('/vibespace-claude-subscription-login.mjs');
          // Remote agent enablement (P3): a remote session can't reach the local
          // API at 127.0.0.1:<PORT>, and the vibespace-status/-task tools don't
          // exist on the remote box. So for any remote session we (1) open an
          // ssh REVERSE tunnel (remote 127.0.0.1:<rport> → this server) and (2)
          // write the two tools into ~/.vibespace/bin on the remote + prepend
          // PATH. Returns pieces spliced into the ssh inner command. Node's
          // base64 is unwrapped (no newlines) so the blob is a single safe word.
          const remoteAgentSetup = async () => {
            // Base PATH/nvm exports — the terminal branch relies on the prelude
            // alone to find node/claude on the host (chat branches re-export
            // inside their inner command), so this part is UNCONDITIONAL even
            // when tool shipping fails below.
            let prelude = REMOTE_PRELUDE; // ONE definition (src/remote-shell.js) — copies drifted between builders
            let tokenAssign = '';
            // ONE ship list, parameterized by the Integration master switch:
            // ON  → all agent tools + hook + keeper + the per-session vsst_
            //       token (over ssh STDIN — 2.126.0, argv is world-readable
            //       via /proc/cmdline on the remote; secrets ride stdin into
            //       0600 files, the inner command references the token via a
            //       `VAR="$(cat …)"` shell prefix so the value never enters
            //       any argv), then hook-register + tools PATH in the prelude.
            // OFF → pristine agent spawn: ship only model-invisible transport
            //       utilities as needed — the keeper for CHAT persistence and
            //       the Claude login helper for an explicit Add-subscription
            //       shell. No hook-register, token, tools PATH, or VIBESPACE_API
            //       reverse tunnel. A hook a PREVIOUS spawn registered on the
            //       host stays inert (it guards on env we no longer pass) —
            //       Manage Agents → host → Remove strips it.
            // + the fake `code` editor helper (remote Ctrl+G, B-2de8) — moved
            // OUT of the PATH dir after extract: its basename must be `code`
            // (claude's GUI-editor check) but shadowing a real vscode `code`
            // on the host's PATH would hang any `code …` shell command.
            const names = integrationOn
              ? [...require('./hosts').HostManager.agentTools(), 'code'] // static tools + plugin shims (Ph4)
              : [
                ...(sessionMode === 'chat' ? ['vibespace-remote-keeper'] : []),
                // A remote Add-subscription helper terminal needs this one
                // transport utility even when agent-visible Integration is
                // OFF (PR #23) — it handles the host's own login only.
                ...(needsClaudeLoginHelper ? ['vibespace-claude-subscription-login.mjs'] : []),
              ];
            // tools live in AGENT_BIN_DIR; the fake `code` moved to its own
            // editor/ subdir (B-b87b, local-PATH shadow fix) — tar it from
            // there via a second -C so the remote layout is unchanged
            const toolDir = AGENT_BIN_DIR;
            const dirFor = (n) => (n === 'code' ? path.dirname(EDITOR_CMD) : toolDir);
            const present = names.filter((n) => { try { return fs.statSync(path.join(dirFor(n), n)).isFile(); } catch { return false; } });
            if (needsClaudeLoginHelper && !present.includes('vibespace-claude-subscription-login.mjs')) {
              throw new Error('Claude subscription login helper is unavailable on the VibeSpace server');
            }

            if (present.length) {
              try {
                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-tok-'));
                try {
                  const tokName = `.tok-${id}`; // id is [\w-] — shell-safe
                  const tokArgs = [];
                  if (integrationOn) {
                    fs.writeFileSync(path.join(tmpDir, tokName), session.agentToken, { mode: 0o600 });
                    tokArgs.push('-C', tmpDir, tokName);
                  }
                  const tarArgs = ['-c', '-C', toolDir, ...present.filter((n) => n !== 'code')];
                  if (present.includes('code')) tarArgs.push('-C', path.dirname(EDITOR_CMD), 'code');
                  const tar = await execFileAsync('tar', [...tarArgs, ...tokArgs], { timeout: 15000 });
                  const h2 = hosts.get(data.hostId);
                  await execFileAsync('ssh', [...hosts.sshArgs(h2, { multiplex: true }), '--', 'umask 077; mkdir -p "$HOME/.vibespace/bin" "$HOME/.vibespace/editor"; tar -x -C "$HOME/.vibespace/bin"; chmod +x "$HOME/.vibespace/bin"/vibespace-* 2>/dev/null; [ -f "$HOME/.vibespace/bin/code" ] && { mv -f "$HOME/.vibespace/bin/code" "$HOME/.vibespace/editor/code"; chmod +x "$HOME/.vibespace/editor/code"; } || true'],
                    { input: tar, timeout: 20000 });
                  if (integrationOn) {
                    // NODE FINDER (2.244.4, userN's Novita — the chicken-and-egg
                    // behind "hook still says node: not found"): the spawn shell is
                    // POSIX sh (dash on Debian), where nvm never loads — a bare
                    // `node` resolves to NOTHING there, so the register (which
                    // rewrites hook entries to an absolute interpreter) could never
                    // run, and every `#!/usr/bin/env node` agent tool was dead too.
                    // Locate node POSIX-portably (PATH → newest nvm → common
                    // locations), EXPORT its dir onto PATH (revives tools + any
                    // old-format hook entries immediately), then run the register
                    // with the absolute path so entries self-heal to execPath.
                    // tools on PATH + the POSIX node finder (ONE definition in
                    // src/remote-shell.js), then self-heal the hook entries.
                    prelude += 'export PATH="$HOME/.vibespace/bin:$PATH"; ' + nodeFinder()
                      + `[ -n "$VS_NODE" ] && "$VS_NODE" "$HOME/.vibespace/bin/vibespace-hook-register.mjs" 2>/dev/null; `;
                    // EDITOR needs $HOME expansion → shell prefix assignment
                    // (envPairs are shq'd); PORT/SESSION_ID are static values.
                    tokenAssign = `VIBESPACE_SESSION_TOKEN="$(cat "$HOME/.vibespace/bin/${tokName}")" EDITOR="$HOME/.vibespace/editor/code" `;
                  }
                } finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
              } catch (e) {
                // Ordinary agent-tool shipping is best-effort; the explicit
                // login terminal's helper is required and must fail closed.
                console.error('[remote] tool distribution failed:', e.message);
                if (needsClaudeLoginHelper) throw e;
              }
            }
            if (!integrationOn) return { prelude, envPairs: [], tokenAssign: '', reverse: null };
            // Wide range → per-host collision (two sessions picking the same
            // port) is negligible; a collision only degrades the loser's tools
            // (ssh -R bind warns, session still runs), never breaks the session.
            // VIBESPACE_API is not a secret; the token rides tokenAssign only.
            // CLAUDE_WEBUI_PORT = the reverse-tunnel port: the remote `code`
            // helper POSTs /api/editor/open through it (remote Ctrl+G, B-2de8).
            const rport = session._remotePort = 20000 + Math.floor(Math.random() * 40000);
            return {
              prelude,
              envPairs: [`VIBESPACE_API=http://127.0.0.1:${rport}`, `CLAUDE_WEBUI_PORT=${rport}`, `CLAUDE_WEBUI_SESSION_ID=${id}`],
              tokenAssign, reverse: `${rport}:127.0.0.1:${PORT}`,
            };
          };
          // B.3: the same agent prelude for a DIAL device, over the device
          // link (no ssh). Tools + the 0600 token ride fsWrite; VIBESPACE_API
          // is a REVERSE-FORWARD (device binds a loopback port whose bytes
          // tunnel back to our server port — the same NAT-proof primitive
          // host-mounts uses); the hook is registered with runCmd. Returns the
          // same shape as remoteAgentSetup ({envPairs, tokenAssign}) minus the
          // ssh-only prelude/reverse fields. Degrades to bare env on any error
          // (the session still runs; tools just aren't present).
          const deviceAgentSetup = async (h, sid) => {
            // Integration OFF ⇒ tools/token/hook-register/back-tunnel are all
            // skipped — the device pipe/pty session itself is transport (the
            // daemon IS the persistence layer). Only BILLING (an API-key file)
            // still needs device round trips; with no key either, there is
            // nothing to place at all.
            if (!integrationOn && !spawnAccount?.secret && !needsClaudeLoginHelper) return { envPairs: [], tokenAssign: '' };
            const dm = await hosts.device(h.id); // dial → deviceForDial
            const home = String((await dm.runCmd('sh', ['-c', 'printf %s "$HOME"'], { timeoutMs: 8000 }))?.stdout || '').trim() || '/root';
            const bin = `${home}/.vibespace/bin`;
            const tokName = `.tok-${sid}`;
            let rf = null;
            if (integrationOn || needsClaudeLoginHelper) {
              await dm.fsMkdir(bin);
              const toolDir = AGENT_BIN_DIR;
              const names = integrationOn
                ? require('./hosts').HostManager.agentTools() // static tools + plugin shims (Ph4)
                : ['vibespace-claude-subscription-login.mjs']; // PR #23: the login helper ships alone when Integration is OFF
              for (const n of names) {
                try {
                  const buf = fs.readFileSync(path.join(toolDir, n));
                  await dm.fsWrite(`${bin}/${n}`, buf);
                } catch (e) {
                  if (needsClaudeLoginHelper && n === 'vibespace-claude-subscription-login.mjs') throw e;
                }
              }
            }
            if (integrationOn) {
              // fake `code` editor helper (remote Ctrl+G, B-2de8) — OUTSIDE the
              // PATH dir so it can't shadow a real vscode `code` on the device
              try {
                await dm.fsWrite(`${home}/.vibespace/editor/code`, fs.readFileSync(EDITOR_CMD));
              } catch { }
              try { await dm.placeSecret(`${bin}/${tokName}`, Buffer.from(session.agentToken)); }
              catch { await dm.fsWrite(`${bin}/${tokName}`, Buffer.from(session.agentToken)); }
              // chmod: tools executable, token 0600, then register the hook in
              // the device's OWN claude/codex configs (its local CLI fires it)
              await dm.runCmd('sh', ['-c',
                `chmod +x "${bin}"/vibespace-* "${home}/.vibespace/editor/code" 2>/dev/null; chmod 600 "${bin}/${tokName}"; `
                // same POSIX node finder as the ssh prelude (2.244.4 — a bare
                // `node` is unresolvable in dash/non-login shells on nvm hosts)
                + nodeFinder()
                + `[ -n "$VS_NODE" ] && "$VS_NODE" "${bin}/vibespace-hook-register.mjs" 2>/dev/null || true`], { timeoutMs: 12000 }).catch(() => {});
              // VIBESPACE_API back-tunnel: a loopback port ON THE DEVICE whose
              // accepts ride the dial link back into our own server port.
              const net = require('net');
              rf = await dm.reverseForward({ port: 0, connectLocal: () => net.connect(PORT, '127.0.0.1') });
              session._dialReversePort = rf.port;
            }
            // Account billing over the device link (B.3 tail, user directive
            // 2026-07-15: "oauth默认禁止搬运，api key可以"). Mirrors
            // remoteAccountEnv: an API KEY value ships via fsWrite into a 0600
            // file on the device, referenced by $(cat …) so the value never
            // enters any argv; a SUBSCRIPTION's OAuth creds are NEVER shipped
            // by default (§ban-safety — a sub token live from a device IP is an
            // impossible-travel/abuse signal), gated behind the SAME setting.
            // API key only (subscriptions are rejected upstream at the dial
            // branch). The value rides fsWrite into a 0600 file; $(cat …) keeps
            // it out of every argv.
            let acctAssign = '';
            if (spawnAccount && spawnAccount.secret && !spawnAccount._hostSubReady) {
              await dm.fsMkdir(`${home}/.vibespace`); // integration-OFF path skipped the bin mkdir
              const kf = `${home}/.vibespace/${spawnAccount.id}.key`;
              // place-secret op (2.298.0): atomic 0600 at open — the old
              // fsWrite-then-chmod pair left a mode-race window with the key
              // world-readable. Old daemons keep the legacy pair.
              try { await dm.placeSecret(kf, Buffer.from(spawnAccount.secret.value)); }
              catch {
                await dm.fsWrite(kf, Buffer.from(spawnAccount.secret.value));
                await dm.runCmd('sh', ['-c', `chmod 600 "${kf}"`], { timeoutMs: 6000 }).catch(() => {});
              }
              acctAssign = `${spawnAccount.secret.var}="$(cat "${kf}")" `;
            }
            if (!integrationOn) return { envPairs: [], tokenAssign: acctAssign };
            return {
              // home is concrete here, so EDITOR can ride envPairs (shq-safe);
              // CLAUDE_WEBUI_PORT = the device back-tunnel (remote Ctrl+G)
              envPairs: [
                `VIBESPACE_API=http://127.0.0.1:${rf.port}`,
                `CLAUDE_WEBUI_PORT=${rf.port}`,
                `CLAUDE_WEBUI_SESSION_ID=${sid}`,
                `EDITOR=${home}/.vibespace/editor/code`,
              ],
              tokenAssign: acctAssign + `VIBESPACE_SESSION_TOKEN="$(cat "${bin}/${tokName}")" `,
            };
          };
          // Remote account key distribution: the env-pair channel is OUT for
          // secrets (the inner command is argv on BOTH sides — local ssh proc +
          // remote sh -lc — and /proc/cmdline is world-readable). Instead ship
          // the key over ssh STDIN into a 0600 file on the remote, and have the
          // inner command reference it via $(cat …) — the command text carries
          // only the PATH, never the value. Returns the raw (pre-quoted) env
          // assignment to splice into the inner command, or '' when no account.
          // Throws on write failure — silently billing the wrong account is
          // worse than failing the create.
          const remoteAccountEnv = async (h) => {
            if (!spawnAccount) return '';
            // Host-side subscription login (2.199.0): the host already holds
            // this account's creds dir — minted ON the host, never shipped.
            // Point the CLI at it and skip the ship gate entirely (nothing
            // crosses machines; the §ban-safety concern doesn't apply).
            if (spawnAccount._hostSubReady && spawnAccount.remoteCreds) {
              return `${spawnAccount.remoteCreds.envVar}="$HOME/.vibespace/${spawnAccount.remoteCreds.dirName}" `;
            }
            // API key: ship the single value to a 0600 file, reference via a
            // shell prefix assignment (the VALUE never enters any argv). API
            // keys are the SANCTIONED programmatic path — always shippable.
            if (spawnAccount.secret) {
              const kf = `$HOME/.vibespace/${spawnAccount.id}.key`; // id shape acct-/sub-<hex>, metachar-free
              await execFileAsync('ssh', [...hosts.sshArgs(h), '--', `umask 077; mkdir -p "$HOME/.vibespace"; cat > "${kf}"`],
                { input: spawnAccount.secret.value, timeout: 15000 });
              return `${spawnAccount.secret.var}="$(cat "${kf}")" `;
            }
            if (spawnAccount.remoteCreds?.shippable === false) {
              throw new Error('this macOS Keychain-backed subscription login cannot be copied to another machine because OAuth refresh tokens rotate. Log in as this account on the host instead, or use an API-key account.');
            }
            // §ban-safety GATE: shipping a SUBSCRIPTION's OAuth creds to a remote
            // host means that subscription token is live from a (likely
            // datacenter) IP different from where you normally use it — an
            // impossible-travel / datacenter-ASN signal that helped get a Max
            // account banned. OFF BY DEFAULT: the user must instead LOG IN ON
            // THE HOST (the host's own login bills there). Opt in via
            // Settings → accounts.shipSubscriptionToRemote only if you accept
            // the risk. API keys (above) are unaffected.
            let allowSubRemote = false;
            try { allowSubRemote = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch {}
            if (!allowSubRemote) {
              throw new Error('shipping a subscription login to a remote host is disabled (it risks the account — a subscription token from a datacenter IP looks like abuse). Log in on the host instead (Manage agents → select the host → "Log in on host…"), or use an API-key account. To override: Settings → "Ship subscription logins to remote hosts".');
            }
            // Subscription (Claude securestorage dir / Codex CODEX_HOME): ship
            // the account's creds DIR to the host over an ssh-stdin tar stream
            // (channel-encrypted, lands in a 0700 dir), symlink the shared
            // subdirs, and point the env var at the remote copy. NEWEST WINS
            // per file (tar --keep-newer-files, GNU; verified exit 0): OAuth
            // refresh tokens ROTATE, so after a remote session refreshes, the
            // HOST copy holds the live token — blindly re-shipping the stale
            // local copy would invalid_grant the account there. No rm -rf
            // either: a concurrent session of the same account on the same
            // host must not have its creds dir yanked mid-run.
            const rc = spawnAccount.remoteCreds;
            if (!rc) throw new Error('this account cannot run on a remote host');
            const files = (rc.files || []).filter(f => { try { return fs.statSync(path.join(rc.srcDir, f)).isFile(); } catch { return false; } });
            if (!files.length) throw new Error('account creds unreadable');
            const tar = await execFileAsync('tar', ['-c', '-C', rc.srcDir, ...files], { timeout: 15000 });
            const rdir = `$HOME/.vibespace/${rc.dirName}`; // dirName = subs/<id> | codex-subs/<id>, metachar-free
            const links = Object.entries(rc.symlinks || {}).map(([n, tgt]) => `ln -sfn ${tgt} "${rdir}/${n}"`);
            // Poison-heal: a remote primary creds file that LOST its validity
            // marker (a Console /login inside a remote session wipes it to {}
            // with a fresh mtime) would win newest-wins forever — delete it
            // first so the valid local copy restores it. Known residual risk:
            // clock skew between machines can misorder newest-wins when both
            // sides refreshed within the skew window (NTP makes this ~ms).
            const heal = rc.probe
              ? [`if [ -f "${rdir}/${rc.probe.file}" ] && ! grep -qE '${rc.probe.marker}' "${rdir}/${rc.probe.file}"; then rm -f "${rdir}/${rc.probe.file}"; fi`]
              : [];
            // GNU-tar-only flag; no `|| tar -x` fallback — the first tar already
            // consumed the ssh stdin stream, a fallback would extract nothing
            // and silently spawn with missing creds. Non-GNU hosts fail LOUD.
            const script = [`umask 077`, `mkdir -p "${rdir}"`, ...heal, `tar -x --keep-newer-files -C "${rdir}"`, ...(rc.ensureTargets || []), ...links].join('; ');
            await execFileAsync('ssh', [...hosts.sshArgs(h), '--', script], { input: tar, timeout: 20000 });
            return `${rc.envVar}="${rdir}" `;
          };
          // Host-held subscription on a DIAL device (2.208.0): the device
          // already holds this account's creds dir (~/.vibespace/subs/<id>,
          // minted by an on-device login — 2.199.0) — a shell prefix
          // assignment points the CLI at it. NOTHING ships, so the §ban-safety
          // dial guards below must not reject it (they used to, with a
          // misleading "shipping not implemented" error). Empty otherwise.
          const dialAcctAssign = (spawnAccount?._hostSubReady && spawnAccount.remoteCreds)
            ? `${spawnAccount.remoteCreds.envVar}="$HOME/.vibespace/${spawnAccount.remoteCreds.dirName}" ` : '';
          if (data.hostId && hosts && sessionMode === 'terminal') {
            let h;
            try { h = hosts.get(data.hostId); }
            catch { ws.send(JSON.stringify({ type: 'error', message: 'Unknown host: ' + data.hostId })); return; }
            const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            // TERMINAL-on-dial (B-0d70): the device runs claude/codex in a
            // node-pty via the daemon's open-session, proxied through the
            // DialSessionBridge (pty mode). Locally it's dtach → pty-wrapper →
            // vibespace-agentd-attach (pty/raw mode) — the exact `ssh -t`
            // shape, but over the dialed link. Live pty (no offset/replay);
            // pty-wrapper's REMOTE_RETRY respawns the attach on a link drop.
            if (h.transport === 'dial') {
              if (!dialBridge || !agentdRemote) { ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, sessionId: id, message: 'dial sessions not wired on this server' })); return; }
              // Account billing on a device: API keys ship (below); a
              // host-HELD subscription uses the device's own creds dir (no
              // ship — dialAcctAssign); any OTHER subscription can't be
              // honored on a device (OAuth ship is off by default,
              // §ban-safety) — fail LOUD, don't silently bill the device's
              // own login (mirror the chat-dial guard).
              if (spawnAccount && !spawnAccount.secret && !dialAcctAssign) {
                let allowSub = false; try { allowSub = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch {}
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, sessionId: id, message: allowSub
                  ? 'subscription creds shipping to dial devices is not implemented — use an API-key account, or log in on the device'
                  : 'the selected account is a subscription login — shipping it to a device is disabled (§ban-safety). Use an API-key account, or log in on the device itself.' }));
                return;
              }
              // shell terminal: run the DEVICE user's own login shell, not the
              // basename of OUR spawn command (the pod's $SHELL is bash — a Mac
              // zsh user got bash + Apple's chsh nag, real report). $SHELL may
              // be absent under launchd → fall back to the account's UserShell
              // (macOS dscl) → zsh → bash. S0 is resolved in the shellCmd
              // preamble; rcmd0 just execs it.
              const rcmd0 = backend === 'shell' ? '"$S0"' : (spawnCmd.includes('/') ? path.basename(spawnCmd) : spawnCmd);
              const shellResolve = backend === 'shell'
                ? `S0="\${SHELL:-}"; [ -n "$S0" ] || S0="$(dscl . -read ~/ UserShell 2>/dev/null | awk '{print \$2}')"; [ -n "$S0" ] || S0="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f7)"; [ -x "$S0" ] || S0="$(command -v zsh || command -v bash || echo sh)"; `
                : '';
              try {
                const bridgePort = await dialBridge.ensure({ sid: id, deviceId: h.deviceId });
                // A tool/tunnel setup error degrades to bare env, EXCEPT when
                // an API key must be placed — a swallowed failure would run the
                // session on the device's own login = wrong billing (review).
                const da = await deviceAgentSetup(h, id).catch((e) => {
                  if ((spawnAccount?.secret && !spawnAccount._hostSubReady) || needsClaudeLoginHelper) throw e; // held billing rides dialAcctAssign — only a real key placement failure (or the required login helper, PR #23) is fatal
                  console.warn('[dial] agent setup degraded:', e.message); return { envPairs: [], tokenAssign: '' };
                });
                // tools PATH only while integrated — leftover tools from an
                // earlier ON spawn must not be name-resolvable in a pristine one
                const shellCmd = buildRemoteExec({
                  cwd, shq,
                  pre: REMOTE_PRELUDE + (integrationOn ? 'export PATH="$HOME/.vibespace/bin:$PATH"; ' : ''),
                  resolve: shellResolve, tokenAssign: da.tokenAssign, acctEnv: dialAcctAssign,
                  parts: [...da.envPairs.map(shq), ...spawnEnvPairs.map(shq), rcmd0, ...(backend === 'shell' ? ['-l'] : spawnArgs.map(shq))],
                });
                const cfg = {
                  tcp: { port: bridgePort },
                  hostToken: agentdRemote.agentdHostToken('dial-' + h.deviceId),
                  sid: id,
                  version: require('../package.json').version,
                  pty: { cmd: 'sh', args: ['-lc', shellCmd], cwd, env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, cols: 120, rows: 30 },
                };
                ensureDir(agentdRemote.agentdDir);
                const cfgFile = path.join(agentdRemote.agentdDir, 'session-' + id + '.json');
                fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
                spawnCmd = NODE_CMD;
                spawnArgs = [agentdRemote.attachBundle, '--config', cfgFile];
                spawnEnvPairs = [];
                spawnCwd = os.homedir();
                session.host = h.id;
                session.hostName = h.name;
                session._agentdSession = true;
                session._dialDeviceId = h.deviceId;
                session._bridgePort = bridgePort;
                session._agentdCfgFile = cfgFile;
              } catch (e) {
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, sessionId: id, message: `dial terminal failed: ${e.message} (is the device online?)` })); return;
              }
              // fall through to the shared pty-wrapper/dtach spawn tail
            } else {
            // locally-resolved binary paths mean nothing on the remote
            const rcmd = spawnCmd.includes('/') ? path.basename(spawnCmd) : spawnCmd;
            const ra = await remoteAgentSetup();
            let acctEnv = '';
            try { acctEnv = await remoteAccountEnv(h); }
            catch (e) { ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: 'Failed to place the account key on ' + h.name + ': ' + e.message })); return; }
            // acctEnv rides as a SHELL PREFIX ASSIGNMENT before exec — the shell
            // setenvs it internally, so the VALUE never appears in any argv
            // (an `env KEY=$(cat …)` argument would expand into env's argv).
            const inner = buildRemoteExec({
              cwd, shq, pre: ra.prelude, tokenAssign: ra.tokenAssign, acctEnv,
              parts: ['TERM=xterm-256color', 'COLORTERM=truecolor', ...ra.envPairs.map(shq), ...spawnEnvPairs.map(shq), rcmd, ...spawnArgs.map(shq)],
            });
            spawnCmd = 'ssh';
            spawnArgs = [...hosts.sshArgs(h, { tty: true, reverse: ra.reverse }), '--', `dtach -A /tmp/vs-${id} -r winch sh -lc ${shq(inner)}`];
            spawnEnvPairs = [];
            spawnCwd = os.homedir(); // remote cwd rides inside the ssh command
            session.host = h.id;
            session.hostName = h.name;
            }
          } else if (data.hostId && hosts && sessionMode === 'chat') {
            // 2.139.0 (B-0588): codex remote chat rides the SAME keeper —
            // it's a content-agnostic byte pipe, so app-server JSON-RPC
            // (bidirectional incl. approvals) replays fine by byte offset.
            // Claude's stream-json flags are claude-only (they killed codex
            // spawns opaquely pre-2.129.1 — keep them gated).
            // Remote CHAT (P3): ssh -T gives a CLEAN pipe — stream-json must
            // NOT cross a remote dtach/pty layer (echo + CRLF corrupt JSON).
            // Local dtach still keeps the pipeline across server restarts; an
            // ssh drop ends the remote process (transcript survives remotely,
            // resume-able). Stream flags ride INSIDE the remote string; the
            // wrapper's appended flags land as harmless sh -lc positionals.
            let h;
            try { h = hosts.get(data.hostId); }
            catch { ws.send(JSON.stringify({ type: 'error', message: 'Unknown host: ' + data.hostId })); return; }
            const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
            // ── B-4058 writer sweep script, SHARED by the ssh AND dial resume
            // paths (audit #11/#47 — it was ssh-only, so a device-side orphan
            // claude raced every dial resume as a second JSONL writer). The ONE
            // invariant before a resume: no other process may still be writing
            // this conversation's transcript. Legs: fd scan (kills ANY claude
            // holding <RID>.jsonl open — /proc on Linux, lsof on macOS/BSD),
            // lock-file scan, agentd PIPE-SESSION metas (both the ssh-agentd
            // root and per-instance device@/agentd@ roots — their setsid claude
            // survives pod recreation), keeper run-file bookkeeping (harmless
            // no-op on devices without the keeper).
            const rcmd = spawnCmd.includes('/') ? path.basename(spawnCmd) : spawnCmd;
            const rargs = [...spawnArgs];
            // EXPLICIT backend check (P4 hazard fix): `!== 'codex'` appended
            // claude stream-json flags to ANY future backend's remote spawn —
            // the gemini-as-claude fallthrough class.
            if (backend === 'claude') {
              for (const fl of [['--output-format', 'stream-json'], ['--input-format', 'stream-json'], ['--verbose'], ['--permission-prompt-tool', 'stdio']]) {
                if (!rargs.includes(fl[0])) rargs.push(...fl);
              }
            }
            if (h.transport === 'dial') {
              // Graduation B.2/B.3: the session runs as a persistent PIPE
              // SESSION in the DIALED-IN device's daemon; the attach child
              // reaches it through the server's loopback mux proxy
              // (DialSessionBridge) — the dial link lives inside this process,
              // unreachable to a child directly. B.3 ports the ssh-coupled
              // agent prelude to DEVICE FS OPS: tools + token via fsWrite, the
              // VIBESPACE_API back-tunnel via reverseForward, hook registration
              // via runCmd — so vibespace-status/task/ask work on the device.
              if (!dialBridge || !agentdRemote) { ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: 'dial sessions not wired on this server' })); return; }
              // Codex CHAT over a byte pipe is not wired (B-0588, same as the
              // ssh path): the codex-chat-wrapper speaks JSON-RPC to a local
              // codex app-server, not to the pipe-relayed device one. Fail
              // LOUD rather than blank. Codex TERMINAL on dial works (TUI over
              // the pty path); claude chat works.
              if (backend === 'codex') { ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, sessionId: id, message: `Codex CHAT on a paired device isn't wired yet — use TERMINAL mode for codex on "${h.name}", or codex chat on an ssh host. Claude chat works on devices.` })); return; }
              // A selected SUBSCRIPTION account can't be honored on a device
              // (OAuth shipping is off by default — §ban-safety) — fail loudly
              // rather than silently billing the device's own login (the ssh
              // path fails the same way). API keys are shippable (below);
              // host-HELD logins use the device's own creds dir (dialAcctAssign).
              if (spawnAccount && !spawnAccount.secret && !dialAcctAssign) {
                let allowSub = false; try { allowSub = !!serverSetting('accounts.shipSubscriptionToRemote'); } catch {}
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: allowSub
                  ? 'subscription creds shipping to dial devices is not implemented — use an API-key account, or log in on the device'
                  : 'the selected account is a subscription login — shipping it to a device is disabled (§ban-safety). Use an API-key account, or log in on the device itself.' }));
                return;
              }
              // pipe-ATTACH (B-4058 dial edition, audit #11/#47): the card
              // carried a live device pipe sid — reattach to the SURVIVING
              // device-side claude from byte 0 (full replay rebuilds the view)
              // instead of spawning a second writer onto the same JSONL. No
              // spawn spec in the cfg ⇒ attach-pipe-session (never spawns).
              let dialKeeperSid = data.keeperSid && /^[\w-]+$/.test(data.keeperSid) ? data.keeperSid : null;
              // Dial discovery carries no pipe sids, so a plain sidebar resume
              // never arrives with keeperSid — probe the device's pipe-session
              // store directly and ADOPT a surviving claude over respawning.
              if (!dialKeeperSid && data.resume && data.resumeId && !data.accountId && /^[\w-]+$/.test(data.resumeId)) {
                try {
                  const k = await hosts.findKeeperFor(h.id, data.resumeId);
                  if (k?.error) {
                    ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, code: 'keeper-probe-failed',
                      message: `${h.name} isn’t responding — couldn’t verify whether this conversation is still running there. Retry in a moment.` }));
                    return;
                  }
                  if (k?.sid) { dialKeeperSid = k.sid; console.log(`[dial] live pipe session ${k.sid} holds ${data.resumeId.slice(0, 8)} — attaching instead of spawning a second writer`); }
                } catch { }
              }
              // Pre-resume writer sweep over the DEVICE LINK — the ssh-only
              // cleanScript never ran for dial, so a pod-recreation-orphaned
              // pipe-session claude (setsid-detached, survives everything the
              // daemon does) raced every later resume as a second JSONL writer.
              // Never runs for pipe-ATTACH (we adopt, not respawn) and
              // NEVER for a FORK (2.284.4, real incident: forking a LIVE
              // conversation SIGTERMed the parent's claude mid-turn — a fork
              // only READS the parent transcript and writes a NEW id's JSONL,
              // so a live parent writer is legitimate, not a corruption risk;
              // the resume-already-live guard exempts forks for the same
              // reason, which voids the "can only reach external writers"
              // assumption these sweeps were written under).
              if (data.resume && data.resumeId && !data.fork && !dialKeeperSid && /^[\w-]+$/.test(data.resumeId)) {
                try {
                  const r = await sweepWriters(hosts, h.id, data.resumeId, { shq, execFileAsync, ...sweepOpts(h.id) });
                  if (r.swept.length) session._resumeSwept = { host: h.name, pids: r.swept };
                  hosts.invalidateDiscovery(h.id);
                } catch (e) {
                  console.warn('[dial] pre-resume cleanup failed (continuing):', e.message);
                  session._resumeWarning = `Couldn’t verify no other process is writing this conversation on ${h.name} — if it was still running there, the transcript may double-write. Watch for duplicated messages.`;
                }
              }
              try {
                const bridgePort = await dialBridge.ensure({ sid: id, deviceId: h.deviceId });
                // Tool/token/tunnel setup degrades to bare env on error (session
                // still runs); the API-key ship inside is NOT degradable — a
                // write failure throws out of the try and fails the create.
                // Skipped entirely on pipe-ATTACH: the surviving claude keeps
                // its original env, and a fresh reverseForward here would leak
                // an unused device port per attach.
                const da = dialKeeperSid ? { envPairs: [], tokenAssign: '' } : await deviceAgentSetup(h, id).catch((e) => {
                  if ((spawnAccount?.secret && !spawnAccount._hostSubReady) || needsClaudeLoginHelper) throw e; // wrong billing / a required login helper must fail, not silently degrade (held rides dialAcctAssign — placement can't fail)
                  console.warn('[dial] agent setup degraded:', e.message); return { envPairs: [], tokenAssign: '' };
                });
                // tools PATH only while integrated (see the pty branch note)
                const shellCmd = buildRemoteExec({
                  cwd, shq,
                  pre: REMOTE_PRELUDE + (integrationOn ? 'export PATH="$HOME/.vibespace/bin:$PATH"; ' : ''),
                  tokenAssign: da.tokenAssign, acctEnv: dialAcctAssign,
                  parts: [...da.envPairs.map(shq), ...spawnEnvPairs.map(shq), rcmd, ...rargs.map(shq)],
                });
                const cfg = {
                  tcp: { port: bridgePort },
                  hostToken: agentdRemote.agentdHostToken('dial-' + h.deviceId),
                  sid: dialKeeperSid || id,
                  version: require('../package.json').version,
                  // cwd runs ON THE DEVICE — send the resolved device cwd, not
                  // this server's homedir (a path absent on the device). The
                  // daemon also falls back to HOME if it still doesn't exist.
                  ...(dialKeeperSid ? {} : { spawn: { cmd: 'sh', args: ['-lc', shellCmd], cwd } }),
                };
                ensureDir(agentdRemote.agentdDir);
                const cfgFile = path.join(agentdRemote.agentdDir, 'session-' + id + '.json');
                fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
                spawnCmd = NODE_CMD;
                spawnArgs = [agentdRemote.attachBundle, '--config', cfgFile, '--offset', '__VS_OFFSET__'];
                spawnEnvPairs = [];
                spawnCwd = os.homedir();
                session.host = h.id;
                session.hostName = h.name;
                session._agentdSession = true;
                session._dialDeviceId = h.deviceId;
                session._bridgePort = bridgePort;
                session._agentdCfgFile = cfgFile;
                // the pipe sid the kill path must target (attach-adopted
                // sessions keep the SURVIVING sid, not the fresh webui id)
                session.keeperSid = dialKeeperSid || id;
              } catch (e) {
                ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: `dial session failed: ${e.message} (is the device online?)` })); return;
              }
            } else {
            const ra = await remoteAgentSetup();
            let acctEnv = '';
            try { acctEnv = await remoteAccountEnv(h); }
            catch (e) { ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, message: 'Failed to place the account key on ' + h.name + ': ' + e.message })); return; }
            // acctEnv = shell prefix assignment (see the terminal branch note)
            // 2.124.0: claude no longer hangs directly off the ssh pipe — it
            // runs DETACHED on the host under vibespace-remote-keeper (buffer
            // file + unix-socket stdin), so an ssh drop kills only the pipe.
            // __VS_OFFSET__ is substituted by the LOCAL chat-wrapper at every
            // (re)spawn with the byte offset it has consumed — the keeper
            // replays exactly the missed bytes. env pairs precede the keeper
            // so claude (spawned by the keeper daemon) inherits them.
            // ── B-4058 pre-spawn orphan cleanup (resume-with-respawn only) ──
            // A pod rebuild loses local state; a later plain resume used to
            // race a still-alive orphan claude holding the SAME claude session
            // id (double JSONL writers, 'resume did nothing', keeper remnants
            // that fooled diagnosis). Before respawning with --resume: SIGTERM
            // any lock-holding claude for this session id (cmdline-verified)
            // and stop any live keeper session referencing it. Never runs for
            // keeper-ATTACH (data.keeperSid — we adopt, not respawn).
            // EXPLICIT-host adopt probe (2.247.2, the B-218d completion): the
            // dial branch probes the device's pipe-session store on every
            // sidebar resume (its discovery carries no pipe sids) — the ssh
            // branch never did, so an explicit-host resume ALWAYS swept and
            // respawned even when a healthy surviving claude was one
            // attach-pipe-session away (userL's 12 orphans). Probe first;
            // a hit skips the sweep below and adopts via the attach-cli.
            if (data.resume && data.resumeId && !data.keeperSid && !data.accountId && agentdRemote && /^[\w-]+$/.test(data.resumeId)) {
              try {
                const k = await hosts.findKeeperFor(h.id, data.resumeId);
                if (k?.error) {
                  ws.send(JSON.stringify({ type: 'error', reqId: data.reqId, code: 'keeper-probe-failed',
                    message: `${h.name} isn’t responding — couldn’t verify whether this conversation is still running there. Retry in a moment.` }));
                  return;
                }
                if (k?.sid) { data.keeperSid = k.sid; data.keeperKind = k.kind; console.log(`[remote] live ${k.kind} session ${k.sid} holds ${data.resumeId.slice(0, 8)} — adopting instead of sweep+respawn`); }
              } catch { }
            }
            // !data.fork: a fork's resume target is the LIVE parent's own
            // conversation — sweeping it kills the parent (2.284.4).
            if (data.resume && data.resumeId && !data.fork && !data.keeperSid && /^[\w-]+$/.test(data.resumeId)) {
              try {
                // ROOT-CAUSE writer sweep (mechanism-agnostic): the ONE thing
                // that must be true before a resume is that NO other process is
                // still writing this conversation's transcript — else we get
                // multiple concurrent writers on one JSONL ("resume did
                // nothing / session ends"; real incident with agentd remote
                // sessions, whose setsid-detached claude survives a local pod
                // rebuild that the sidebar-driven cold resume then races). The
                // fd scan kills ANY claude holding <RID>.jsonl open regardless
                // of how it was spawned (bare / keeper / agentd pipe-session) —
                // it subsumes the id-lock grep (a --resumed claude's lock
                // carries a NEW session id, so grepping the lock for RID missed
                // it). The pipe-meta + keeper legs clean their own bookkeeping.
                // Codex sessions get the codex legs (open rollout / argv).
                const r = await sweepWriters(hosts, h.id, data.resumeId, { shq, execFileAsync, ...sweepOpts(h.id) });
                if (r.swept.length) session._resumeSwept = { host: h.name, pids: r.swept };
                hosts.invalidateDiscovery(h.id);
              } catch (e) {
                // The sweep exists to guarantee no other writer holds this
                // transcript; it fails exactly under the host lag that makes
                // a second writer likely (2.271.0 T1-2). Proceed (the user
                // asked to resume) but SURFACE it — the created reply carries
                // a warning so the window can show it, not a silent double-
                // write risk.
                console.warn('[remote] pre-resume cleanup failed (continuing):', e.message);
                session._resumeWarning = `Couldn’t verify no other process is writing this conversation on ${h.name} — if it was still running there, the transcript may double-write. Watch for duplicated messages.`;
              }
            }
            // keeper-ATTACH (B-4058): the card carried a live keeper sid —
            // reattach to the surviving remote claude from byte 0 (full
            // replay rebuilds the view) instead of killing + respawning.
            // No command after the sid: keeper adopts (takeover if the
            // daemon died) or drains/synthesizes an exit — never spawns.
            const keeperSid = data.keeperSid && /^[\w-]+$/.test(data.keeperSid) ? data.keeperSid : null;
            session.keeperSid = keeperSid || id;
            const runTail = keeperSid
              ? ` node "$HOME/.vibespace/bin/vibespace-remote-keeper" run ${shq(keeperSid)} __VS_OFFSET__`
              : ` node "$HOME/.vibespace/bin/vibespace-remote-keeper" run ${shq(id)} __VS_OFFSET__ -- ` + [rcmd, ...rargs.map(shq)].join(' ');
            // ── The session runs as a persistent PIPE SESSION inside the
            // standing remote device daemon; the local chat-wrapper spawns the
            // agentd-attach bridge (SAME contract as `keeper run`: raw bytes +
            // __VS_OFFSET__ + sentinel), so the wrapper machinery is
            // untouched. GRADUATED (flags removed): keeper survives only as
            // the provisioning-failure fallback + for pre-existing keeper
            // sessions (keeperSid resumes). ──
            let agentdMode = !!agentdRemote;
            // B-218d: an AGENTD pipe sid must be adopted through the attach-cli
            // (no spawn spec ⇒ attach-pipe-session, never spawns — the dial
            // branch's exact contract). Routing it into the legacy keeper
            // runTail below silently failed: the keeper binary only reads
            // ~/.vibespace/run and has never heard of these sids, so the
            // keeper-attach optimization never worked on modern ssh sessions.
            const agentdAttach = !!(agentdMode && keeperSid && data.keeperKind === 'agentd');
            if (agentdMode && (!keeperSid || agentdAttach)) {
              try {
                await agentdRemote.ensureAgentdOnHost(h.id);
                // the child claude runs under `sh -lc` on the host so the
                // existing shell-expanded prefixes (token file reads, $HOME
                // account paths) keep their exact semantics
                const shellCmd = buildRemoteExec({
                  cwd, shq, pre: ra.prelude, tokenAssign: ra.tokenAssign, acctEnv,
                  parts: [...ra.envPairs.map(shq), ...spawnEnvPairs.map(shq), rcmd, ...rargs.map(shq)],
                });
                const remoteCmd = REMOTE_PRELUDE + 'exec node "$HOME/.vibespace/agentd/current/agentd.js" --stdio';
                const cfg = {
                  sshBin: 'ssh',
                  sshArgs: hosts.sshArgs(h, { reverse: ra.reverse }),
                  remoteCmd,
                  hostToken: agentdRemote.agentdHostToken(h.id),
                  sid: agentdAttach ? keeperSid : id,
                  version: require('../package.json').version,
                  // adopt (agentdAttach) sends NO spawn spec — the daemon
                  // attach-pipe-sessions the surviving claude from offset 0
                  ...(agentdAttach ? {} : { spawn: { cmd: 'sh', args: ['-lc', shellCmd], cwd: os.homedir() } }),
                };
                ensureDir(agentdRemote.agentdDir);
                const cfgFile = path.join(agentdRemote.agentdDir, 'session-' + id + '.json');
                fs.writeFileSync(cfgFile, JSON.stringify(cfg), { mode: 0o600 });
                spawnCmd = NODE_CMD;
                spawnArgs = [agentdRemote.attachBundle, '--config', cfgFile, '--offset', '__VS_OFFSET__'];
                spawnEnvPairs = [];
                spawnCwd = os.homedir();
                session.host = h.id;
                session.hostName = h.name;
                session._agentdSession = true;
                session._agentdCfgFile = cfgFile;
              } catch (e) {
                console.warn('[device] remote provisioning failed — keeper fallback:', e.message);
                agentdMode = false;
              }
            }
            if (!agentdMode || (keeperSid && !agentdAttach)) {
              const inner = buildRemoteExec({
                cwd, shq, pre: ra.prelude, tokenAssign: ra.tokenAssign, acctEnv,
                parts: [...ra.envPairs.map(shq), ...spawnEnvPairs.map(shq)],
                tail: runTail,
              });
              spawnCmd = 'ssh';
              spawnArgs = [...hosts.sshArgs(h, { reverse: ra.reverse }), '-T', '--', inner];
              spawnEnvPairs = [];
              spawnCwd = os.homedir();
              session.host = h.id;
              session.hostName = h.name;
            }
            } // ← end of the non-dial (ssh) path
          }
          // PASSIVE usage capture (§ban-safety): for LOCAL CLAUDE TERMINAL
          // sessions (a statusLine only renders in the TUI — chat/stream-json
          // has none), inject a statusLine command that harvests the CLI's OWN
          // 5h/7d rate_limits into data/usage-cache/. This is why VibeSpace
          // makes NO background /api/oauth/usage calls with subscription
          // tokens. Merged into any existing --settings (e.g. ultracode) so
          // there's ONE flag. The claude gate is load-bearing: only the claude
          // CLI understands --settings — appending it to `zsh -l` (shell
          // terminals, incl. the Manage-Agents update/login helpers) or codex
          // made them exit instantly ("terminated").
          // Deliberately NOT gated by the Integration master switch (2.190.1,
          // user decision): the statusline is never model-visible — it renders
          // in the TUI and writes usage-cache locally. The switch scopes to
          // AGENT-VISIBLE integration only (hooks/context/tools); billing env
          // is likewise exempt.
          const usageEnvPairs = [];
          if (backend === 'claude' && sessionMode === 'terminal' && !data.hostId && USAGE_STATUSLINE_CMD) {
            try {
              let settingsObj = {};
              const si = spawnArgs.indexOf('--settings');
              if (si >= 0 && spawnArgs[si + 1]) { try { settingsObj = JSON.parse(spawnArgs[si + 1]) || {}; } catch {} }
              settingsObj.statusLine = { type: 'command', command: USAGE_STATUSLINE_CMD, padding: 0 };
              const sjson = JSON.stringify(settingsObj);
              if (si >= 0) spawnArgs[si + 1] = sjson; else spawnArgs = [...spawnArgs, '--settings', sjson];
              // A POOLED spawn attributes usage to the real TARGET account, not
              // the pool: the statusline cache + quota popup are per-account.
              // The old comment here claimed "the target is fixed for this
              // process's lifetime anyway (a hot re-point is a known
              // attribution seam handled by the ledger's time-based records)".
              // It was wrong on both halves (2026-09-07): the CLI re-reads the
              // credential file on the re-point's mtime bump, and the STATUSLINE
              // cache is not the ledger — nothing re-attributed it by time, so
              // every later reading of a hot-switched terminal session landed on
              // the member it started on. The link itself is the slot, so ship
              // its PATH and let the statusline resolve it per write.
              const acctKey = spawnAccount?.poolTarget || spawnAccount?.id || '__global__';
              const orig = (userStatuslineCmd && userStatuslineCmd()) || '';
              usageEnvPairs.push(`VIBESPACE_ACCOUNT_KEY=${acctKey}`);
              // resolveForSpawn NAMES the credential symlink (`linkPath`) — the
              // per-session plan-C link, else the pool default. Not derived
              // from localEnv here: the consumer must not guess which key of a
              // spawn env happens to hold the slot.
              if (spawnAccount?.pooled && spawnAccount.linkPath) usageEnvPairs.push(`VIBESPACE_ACCOUNT_LINK=${spawnAccount.linkPath}`);
              if (orig) usageEnvPairs.push(`VIBESPACE_ORIG_STATUSLINE=${orig}`);
            } catch {}
          }
          // ── LOCAL pre-resume writer sweep (CS separation, 2.276.0) ──
          // The SAME invariant the remote paths have enforced since B-4058:
          // no other process may still be writing this conversation. Local
          // never had it — not because local is safe (a claude running in an
          // external terminal holds the transcript exactly the same way) but
          // because the incident that motivated the sweep happened remotely,
          // and the local twin is the one nobody exercises. Now hostId is a
          // parameter: the identical script runs over device #0.
          // The live-session case is already refused earlier (2.179.0
          // resume-already-live) — EXCEPT forks, which that guard exempts by
          // design (branching a live conversation is legitimate). A fork must
          // therefore skip the sweep too: its resume target is the live
          // parent's own conversation, and sweeping it SIGTERMs the parent
          // mid-turn (2.284.4, real incident on this very machine — the fork
          // writes a NEW id's JSONL, so there is no double-writer to prevent).
          // Codex too (P1): `thread/resume` reuses the thread id, and a codex
          // app-server holds its rollout open for its lifetime — a `codex
          // resume <id>` TUI in an external terminal is exactly the local
          // double-writer the claude leg exists for.
          if (data.resume && data.resumeId && !data.fork && !data.hostId && !data.keeperSid
              && (backend === 'claude' || backend === 'codex') && /^[\w-]+$/.test(data.resumeId) && hosts) {
            try {
              // shq is defined in the remote branches' scope, not here — the
              // undefined ref was swallowed by this catch and the local sweep
              // NEVER ran (caught in a fleet console ring: "sweep skipped:
              // shq is not defined"). Inline the same quoting.
              const shqL = (v) => `'${String(v).replace(/'/g, `'\''`)}'`;
              const r = await sweepWriters(hosts, null, data.resumeId, { shq: shqL, connectMs: 8000, ...sweepOpts(null) });
              if (r.swept.length) session._resumeSwept = { host: 'this machine', pids: r.swept };
            } catch (e) {
              // Local device daemon down ⇒ legacy behaviour (no sweep), which
              // is what every release before this one did — warn, never block.
              console.warn('[session] local pre-resume sweep skipped:', e.message);
            }
          }
          // R6 / session-brain step 4 (2.318.0, FLAG-GATED default OFF —
          // the design's own sequencing law: step 3 must soak first): a local
          // CHAT session spawns as a device-#0 PIPE session — the SAME
          // chat-wrapper with the SAME buffer/meta paths, supervised by the
          // daemon instead of dtach. Adoption-based: existing sessions stay
          // on their dtach path forever; only NEW creates route here, and any
          // failure falls through to the dtach spawn below (never worse).
          let r6Handle = null;
          const r6Wanted = !session.host && sessionMode === 'chat' && backend === 'claude'
            && serverSetting?.('agentd.localPipeSessions') === true;
          let createPty;
          try {
            const r6Argv = [
              NODE_CMD, wrapper,
              bufFile, metaFileW,
              ENV_CMD, `EDITOR=${EDITOR_CMD}`, `CLAUDE_WEBUI_PORT=${PORT}`, `CLAUDE_WEBUI_SESSION_ID=${id}`,
              ...usageEnvPairs,
              // Agent-facing env: the vibespace tools (data/bin on PATH)
              // authenticate with the per-session token; Task Group belonging is
              // resolved server-side from that token (no task id in the env).
              // Integration OFF strips VIBESPACE_API + the data/bin PATH prefix
              // (the sane-PATH fallback itself stays — the systemd-minimal-env
              // incident class); the TOKEN stays deliberately: data/bin/code
              // (Ctrl+G, invoked via the absolute EDITOR path) authenticates
              // with it, it's never model-visible, and every consumer (hook,
              // tools, codex wrapper) guards on api AND token so token-alone is
              // inert. The CLI itself never reads either var.
              ...(integrationOn ? [`VIBESPACE_API=http://127.0.0.1:${PORT}`] : []),
              // AGENT_BIN_DIR (vibespace-* tools), NOT dirname(EDITOR_CMD):
              // the fake `code` lives in editor/ precisely so PATH never
              // resolves it (B-b87b — it shadowed real VS Code locally)
              `PATH=${integrationOn ? AGENT_BIN_DIR + ':' : ''}${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
              `VIBESPACE_SESSION_TOKEN=${session.agentToken}`,
              // Probed working X display (see server.js detectXDisplay) — the CLI
              // reads the clipboard itself on Ctrl+V, so it needs BOTH vars
              `DISPLAY=${X_ENV?.DISPLAY || process.env.DISPLAY || ''}`,
              ...(X_ENV?.XAUTHORITY ? [`XAUTHORITY=${X_ENV.XAUTHORITY}`] : []),
              `TERM=xterm-256color`, `COLORTERM=truecolor`,
              ...spawnEnvPairs,
              spawnCmd, ...spawnArgs,
            ];
            const r6Env = (() => {
                const env = {
                  ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor',
                  // The WRAPPER (always local, even for remote sessions) needs the
                  // agent API in its OWN env: the codex-chat-wrapper injects task
                  // context via thread/inject_items by calling /api/agent/*. The
                  // spawned CLI gets these separately via the `env VAR=val` argv
                  // prefix; the wrapper doesn't, hence this. Always the LOCAL port.
                  // Integration OFF drops VIBESPACE_API (token kept — see the
                  // argv-prefix note above; wrapper guards require api AND token).
                  ...(integrationOn ? { VIBESPACE_API: `http://127.0.0.1:${PORT}` } : {}),
                  VIBESPACE_SESSION_TOKEN: session.agentToken,
                  ...Object.fromEntries(Object.entries(sessionSpec.env || {}).map(([k, v]) => [k, v == null ? '' : String(v)])),
                  // Remote resilience (2.124.0): tell the wrapper HOW to
                  // survive ssh death — chat reconnects the keeper pipe with
                  // an offset; terminal respawns ssh (remote dtach -A reattaches).
                  ...(session.host ? (sessionMode === 'chat' ? { VIBESPACE_REMOTE_SID: id } : { VIBESPACE_REMOTE_RETRY: '1' }) : {}),
                };
                // Billing identity: the key rides the PROCESS-ENV channel only
                // (dtach → wrapper `env: process.env` → CLI), never argv — argv
                // is world-readable in /proc/cmdline. No account → explicitly
                // strip any ambient key so the CLI uses its global login.
                delete env.ANTHROPIC_API_KEY;
                delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
                delete env.CLAUDE_CODE_OAUTH_TOKEN;                 // top-precedence in the CLI — ambient copy = wrong billing
                delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
                // Claude API key → ANTHROPIC_API_KEY; Claude subscription → its
                // own CLAUDE_SECURESTORAGE_CONFIG_DIR (relocates ONLY the creds
                // store, transcripts stay shared); Codex subscription → its own
                // CODEX_HOME (auth isolated, sessions/config symlinked shared).
                // All ride process-env, never argv. No account → the CLI's env
                // is left as-is (CODEX_HOME inherited from the server, if any).
                if (spawnAccount?.localEnv) Object.assign(env, spawnAccount.localEnv);
                // Per-request billing TRUTH (2.361.0, B-345b): LOCAL claude
                // sessions export the CLI's own api_request telemetry
                // (organization.id + request_id) to the loopback OTLP
                // receiver — the only channel that NAMES the billing org per
                // request (hot-switch stale tokens make link-intent
                // attribution wrong). Structurally local-only (remote CLIs
                // get env via buildRemoteExec, never r6Env) but gated
                // explicitly anyway; a user-provided OTEL endpoint in the
                // session spec wins (we never clobber their telemetry).
                if (!session.host && backend === 'claude' && typeof otelEnv === 'function'
                    && !(sessionSpec.env && sessionSpec.env.OTEL_EXPORTER_OTLP_ENDPOINT)) {
                  const oe = otelEnv();
                  if (oe) Object.assign(env, oe);
                }
                return env;
              })();
            if (r6Wanted && hosts?.device) {
              try {
                const dm = await hosts.device(null);
                r6Handle = await dm.openPipeSession({ sid: id, cmd: r6Argv[0], args: r6Argv.slice(1), cwd: spawnCwd, env: r6Env });
                // kill/terminate + the step-2/3 device streams key on the daemon sid
                session.agentdSession = true; session.keeperSid = id;
              } catch (e) { console.warn('[r6] device session.open failed — dtach fallback:', e.message); r6Handle = null; }
            }
            if (!r6Handle) createPty = pty.spawn(DTACH_CMD, ['-c', socketPath, '-E', '-r', 'none', ...r6Argv], {
              name: 'xterm-256color', cols: data.cols || 120, rows: data.rows || 30, cwd: spawnCwd, env: r6Env,
            });
          } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: `Failed to spawn session: ${err.message}\ndtach=${DTACH_CMD} node=${NODE_CMD} env=${ENV_CMD} cwd=${cwd}` }));
            return;
          }
          if (r6Handle) {
            // pipe → pty-shaped shim: setupSessionPty consumes onData(string)/
            // onExit({exitCode})/write/kill/pid; resize is a chat no-op.
            const h = r6Handle;
            const shim = {
              pid: h.pid || -1,
              onData: (cb) => { h.onData = (buf) => cb(buf.toString('utf-8')); },
              onExit: (cb) => { h.onExit = (code) => cb({ exitCode: code ?? 0 }); },
              write: (str) => { try { h.write(str); } catch { } },
              resize: () => { },
              kill: () => { try { h.kill(); } catch { } },
            };
            setupSessionPty(session, id, shim);
          } else setupSessionPty(session, id, createPty);

          session._cwdRecreated = cwdRecreated; // B-7812: prompt-context tells the agent once
          activeSessions.set(id, session);
          session._webuiId = id;
          // 2.368.0: what this session was spawned with / prefers. undefined on
          // _autoResume means "follow the global default" — the tri-state is
          // deliberate so a per-session OFF survives the default being ON.
          // the EFFECTIVE style (client pick OR the instance default): the chip
          // must report what the session actually runs with, not just what the
          // client asked for (a default-sourced Concise showed as "默认")
          if (data._effOutputStyle) session._outputStyle = data._effOutputStyle;
          if (data.autoResume !== undefined && data.autoResume !== null) session._autoResume = !!data.autoResume;
          session._spawnModel = data.model || null; // model ladder's floor (plan C) // per-session pool link key (plan C) — the id the session is registered under
          attachedSessions.add(id);
          console.log(`[session] created ${id} "${session.name || ''}" mode=${sessionMode} backend=${backend}${data.hostId ? ' host=' + data.hostId : ''}${session._accountId ? ' account=' + session._accountId : ''}${data.resumeId ? ' resume=' + data.resumeId : ''}`);
          global.__vsEvent?.('session-created', `${sessionMode}/${backend}${data.hostId ? '/remote' : ''}${data.resumeId ? '/resume' : ''}`);
          // Unresumable-conversation circuit breaker (2.207.1): a resume that
          // recently died with "No conversation found" has NO transcript on
          // its machine — every retry is a guaranteed ~2s death. Note this is
          // checked at CREATE below via noConvoRef (the refusal must run
          // BEFORE the spawn; see the guard further up).
          // Crash-loop detector (2.207.0, the userN incident: one
          // conversation restarted 4× in 3.5 minutes with zero signal): ≥3
          // creates of the SAME conversation within 10 minutes is a loop —
          // flag it loudly so Diagnostics/opslog show it in real time.
          if (data.resumeId) {
            const rl = (crashLoopRef.map ||= new Map());
            const arr = (rl.get(data.resumeId) || []).filter((t) => Date.now() - t < 600000);
            arr.push(Date.now());
            rl.set(data.resumeId, arr);
            if (rl.size > 200) rl.delete(rl.keys().next().value);
            if (arr.length >= 3) {
              console.warn(`[session] crash-loop suspected: conversation ${data.resumeId} created ${arr.length}× in 10min`);
              global.__vsEvent?.('session-crash-loop', `${arr.length}x`);
            }
          }
          // Remote session: push its groups' context folders to the host now
          // (the 60s timer + prompt-time trigger keep them fresh afterwards);
          // bust the host's discovery cache so the sidebar's remote zone sees
          // the new session on the next poll instead of after the TTL.
          if (session.host) {
            if (integrationOn) scheduleCtxSync?.(session, id); // ctx-folder sync is task-context machinery
            setTimeout(() => { try { hosts?.invalidateDiscovery?.(session.host); } catch {} }, 3000);
          }

          writeSessionMeta(sockName, {
            name: session.name,
            cwd,
            spawnModel: data.model || null, // plan C model ladder's floor — survives restarts
            agentdPipe: r6Handle ? true : undefined, // R6: daemon-owned pipe session (restore re-opens it, no dtach socket exists)
            host: session.host || null,
            hostName: session.hostName || null,
            keeperSid: session.keeperSid || null,
            dialDeviceId: session._dialDeviceId || null,
            bridgePort: session._bridgePort || null,
            // the device-side VIBESPACE_API back-tunnel port (audit #49): the
            // dial-in handler re-owns it on every re-link — without the record
            // a server restart / re-dial silently killed the agent tools' API
            dialReversePort: session._dialReversePort || null,
            // transport mechanism + fork intent survive restarts (2.219.0
            // audit: a restored agentd session's terminate took the keeper
            // branch = silent no-op, remote claude ran on; a restored fork's
            // new id could never be adopted)
            agentdSession: !!session._agentdSession,
            cwdRecreated: session._cwdRecreated || undefined, // B-7812: agent notice pending
            forkRequested: !!session._forkRequested,
            // implicit-fork adoption (2.218.0) is armed by _resumeSpawn and
            // disarmed by _sawFirstId — neither survived a restart, so a
            // restored resume whose claude implicitly forked could never be
            // adopted (B-b87b; the exact 2.219.0 fork-divergence class)
            resumeSpawn: !!session._resumeSpawn,
            sawFirstId: !!session._sawFirstId,
            remotePort: session._remotePort || null, // tools back-tunnel port (boot re-adopt revives it)
            backend: session.backend,
            backendSessionId: session.backendSessionId,
            claudeSessionId: session.claudeSessionId,
            sourceKind: session.sourceKind,
            agentKind: session.agentKind,
            agentRole: session.agentRole,
            agentNickname: session.agentNickname,
            parentThreadId: session.parentThreadId,
            permissionMode: session._permissionMode || null,
            effort: session._effort || null,
            modelOrigin: session._modelOrigin || null, // B-6b6d: which fact the spawn's model/effort came from — a restart must not turn an honest
            effortOrigin: session._effortOrigin || null, // "this conversation's own value" row into a guess
            outputStyle: session._outputStyle || null, // 2.369.58: the EFFECTIVE response style survives a server restart (the chip otherwise reported "default" for a session really running one)
            modelLocked: session._modelLocked || undefined, // #6: survive server restart (else a resumed lock's badge silently reverts — review-caught)
            lockedModel: session._lockedModel || undefined,
            agentToken: session.agentToken || null,
            taskId: session._initialGroupId || null, // group spawned into (meta key kept for back-compat)
            accountId: session._accountId || null, // billing identity (badge restore across server restarts)
            authAtSpawn: session._authAtSpawn || null,
            createdAt: session.createdAt,
            webuiSessionId: id,
            mode: sessionMode,
          });

          // Capture claudeSessionId from lock file for new (non-resume) Claude sessions.
          // LOCAL sessions only (2.156.2, trace finding): a REMOTE session's
          // claude runs on the host — scanning the LOCAL lock dir here could
          // FALSE-MATCH a same-cwd local session and adopt the WRONG id.
          // Remote sessions get their id from the stream parser's first-capture
          // (2.156.1), which every stream-json line feeds.
          if (backend === 'claude' && !session.claudeSessionId && !session.host) {
            const { SESSIONS_DIR } = require('./session-store');
            const tryCapture = (attempts) => {
              if (attempts <= 0 || !activeSessions.has(id)) return;
              try {
                // Exclude lock sessionIds already claimed by other webui
                // sessions — two new same-cwd sessions within the retry window
                // would otherwise both claim the FIRST matching lock
                const claimed = new Set();
                for (const [oid, os] of activeSessions) {
                  if (oid !== id && os.backend === 'claude' && os.claudeSessionId) claimed.add(os.claudeSessionId);
                }
                const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
                for (const f of files) {
                  const lockData = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8'));
                  if (claimed.has(lockData.sessionId)) continue;
                  if (lockData.cwd === cwd && lockData.startedAt > session.createdAt - 5000) {
                    session.claudeSessionId = lockData.sessionId;
                    session.backendSessionId = lockData.sessionId;
                    // MERGE into the existing meta (spread base) — a hardcoded
                    // field list here silently dropped later-added keys
                    // (agentToken, taskId, accountId) on id capture.
                    // Spread the base ONLY when the on-disk meta is ours — a
                    // foreign meta (sockName collision) would graft another
                    // session's name/cwd/account onto this record, which is
                    // exactly how the identity crossing was produced.
                    const base = readSessionMeta(sockName) || {};
                    const own = !base.webuiSessionId || base.webuiSessionId === id;
                    if (!own) console.error(`[session] refusing to inherit foreign meta ${sockName} (owner ${base.webuiSessionId}, me ${id})`);
                    writeSessionMeta(sockName, {
                      ...(own ? base : {}),
                      webuiSessionId: id,
                      backendSessionId: session.backendSessionId,
                      claudeSessionId: session.claudeSessionId,
                    });
                    broadcastActiveSessions();
                    return;
                  }
                }
              } catch {}
              setTimeout(() => tryCapture(attempts - 1), 1000);
            };
            setTimeout(() => tryCapture(15), 2000);
          }

          if (backend === 'codex' && !session.backendSessionId) {
            const tryCapture = (attempts) => {
              if (attempts <= 0 || !activeSessions.has(id)) return;

              const matched = pickCodexThreadCandidate({
                activeSessions,
                webuiSessionId: id,
                cwd: session.cwd,
                createdAt: session.createdAt,
                baselineThreadIds: session._codexThreadBaseline,
                pathLib: path,
              });

              if (matched) {
                session._captureReservedThreadId = matched.backendSessionId || matched.sessionId || null;
                session.backendSessionId = matched.backendSessionId || matched.sessionId || session.backendSessionId;
                session.claudeSessionId = null;
                if (matched.name) session.name = matched.name;
                if (matched.cwd) session.cwd = matched.cwd;
                if (matched.sourceKind) session.sourceKind = matched.sourceKind;
                if (matched.agentKind) session.agentKind = matched.agentKind;
                if (matched.agentRole != null) session.agentRole = matched.agentRole || '';
                if (matched.agentNickname != null) session.agentNickname = matched.agentNickname || '';
                if (matched.parentThreadId !== undefined) session.parentThreadId = matched.parentThreadId || null;

                writeSessionMeta(sockName, {
                  ...(readSessionMeta(sockName) || {}), // preserve keys not re-listed (agentToken/taskId/accountId)
                  name: session.name,
                  cwd: session.cwd,
                  backend: session.backend,
                  backendSessionId: session.backendSessionId,
                  claudeSessionId: session.claudeSessionId,
                  sourceKind: session.sourceKind,
                  agentKind: session.agentKind,
                  agentRole: session.agentRole,
                  agentNickname: session.agentNickname,
                  parentThreadId: session.parentThreadId,
                  forkedFrom: session.forkedFrom || null,
                  permissionMode: session._permissionMode || null,
                  effort: session._effort || null,
                  modelOrigin: session._modelOrigin || null,
                  effortOrigin: session._effortOrigin || null,
                  outputStyle: session._outputStyle || null,
                  createdAt: session.createdAt,
                  webuiSessionId: id,
                  mode: sessionMode,
                });
                delete session._codexThreadBaseline;
                delete session._captureReservedThreadId;
                broadcastActiveSessions();
                return;
              }

              setTimeout(() => tryCapture(attempts - 1), 1500);
            };
            setTimeout(() => tryCapture(40), 1500);
          }

          // Read childPid from wrapper metadata after it has time to spawn
          setTimeout(() => refreshWebuiPids(), 3000);

          ws.send(JSON.stringify({
            type: 'created', sessionId: id, name: session.name, cwd, mode: sessionMode, reqId: data.reqId || undefined,
            // POST-FACTO billing truth (B-f531): what the spawn ACTUALLY
            // resolved to — the client persists/labels from this, never from
            // the requested intent (the badge-vs-reality split class)
            billing: {
              accountId: session._accountId || null,
              how: session._billingHow || null,
              name: session._accountId ? (() => { try { return accounts?.get?.(session._accountId)?.name || null; } catch { return null; } })() : null,
            },
            // The CREATOR never gets an 'attached' payload, so the live style /
            // auto-resume state must ride here or the resumed window shows
            // "default" forever (2.368.4, owner-caught on the resume it was
            // built for). Always present (null = CLI default) so the client's
            // carries-the-key guard fires.
            outputStyle: session._outputStyle || null,
            // …and so must the effort this spawn RESOLVED to (B-6b6d). The
            // creator's chip used to show the value the CLIENT sent, which on a
            // resume is now deliberately nothing — the server is the only party
            // that read the conversation's own last turn. `spawnOrigin` names
            // WHICH fact it is, for the same reason Session Properties needs it.
            effort: session._effort || null,
            spawnModel: session._spawnModel || null,
            spawnOrigin: { model: session._modelOrigin || null, effort: session._effortOrigin || null },
            autoResume: autoResume?.statusFor?.(id) || null,
            // A freshly spawned/resumed wrapper always starts with an EMPTY
            // input queue — stated explicitly (not omitted) so the creator's
            // carries-the-key guard clears any strip a recycled window kept.
            queue: [],
            // The wrapper has not written its sidecar yet, so we do not KNOW
            // whether it publishes a queue: say false and let its own baseline
            // `queue_changed` (published at boot, seconds later) turn the
            // controls on. Guessing 'true' here is the skew bug in miniature —
            // and nothing can be queued before the first turn anyway.
            queueSupported: false,
            // …and NOTHING is known about its verbs yet — `null`, never `[]`
            // (an empty list is a real answer the client would intersect with,
            // leaving a session with no controls at all).
            queueVerbs: null,
            // NO `turnState` here either, for the same reason and one more: a
            // just-spawned CLI has not run a turn yet, so it has said nothing
            // about turn state. null/absent = "not told yet"; the client keeps
            // the derived path until the first `turn-state` push arrives — the
            // same tri-state honesty as responseStyleLive below.
            // NO `responseStyleLive` here, deliberately: the sidecar that
            // adverts it is written seconds later, and the client's third
            // state (undefined = "not told yet") is the honest one — it TRIES
            // the live verb and a refusal flips it to false with the restart
            // row in the same menu (2.369.58). Guessing either way is the
            // capability-skew bug in miniature.
            warning: session._resumeWarning || undefined, // 2.271.0 T1-2: sweep-skipped-under-lag double-write risk
            // A sweep is DESTRUCTIVE by design (it SIGTERMs another claude that
            // held this transcript). Never do that silently — 2.276.0.
            swept: session._resumeSwept || undefined,
          }));
          broadcastActiveSessions();
    } while (0);
  };
}

module.exports = { createWsCreateHandler };
