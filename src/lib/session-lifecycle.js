// Session lifecycle: create/attach/resume/fork/view/kill + billing switcher + openSpec replay (mixin split from app.js, 2.82.0 audit seam).
import { ChatView } from './chat-view.js';
import { backendFeatureCaps } from './agent-meta.js';
import { track, metric } from './telemetry-client.js';
import { t } from './i18n.js';
import { registerWindowType, replayOpenSpec as replayOpenSpecViaRegistry, svgIcon16 } from './window-types.js';
import { TerminalSession } from './terminal.js';
import { api, escHtml, estDisplayPair, fetchJson, hostStateChip, showConfirmDialog, showContextMenu, showToast, stripCwdHostLabel } from './utils.js';

export function installSessionLifecycle(App, ctx = {}) {
  Object.assign(App.prototype, {
  // management. Optional initialCommand is typed for the user once the shell
  // is up (e.g. the in-product "Log in to Claude" helper).
  openShellTerminal(cwd, { initialCommand, hostId } = {}) {
    this.createSession({
      backend: 'shell', mode: 'terminal', cwd: cwd || undefined, hostId,
      name: initialCommand ? initialCommand.split(' ')[0] : 'Terminal',
      model: null, permission: null, effort: null, extraArgs: '',
      initialCommand,
    });
  },

  createSession({ cwd, name, model, permission, extraArgs, resumeId, mode, syncId, effort, outputStyle, autoResume, fork, hostId, keeperSid, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId, initialMessage, initialCommand, forkAtUuid, forkTitle, taskId, accountId, modelLock, lockModel, ephemeral = false, winBounds, recreateCwd = false, ignoreNoConvo = false, onCreateResult }) {
    try { track('event', `session-create:${backend || 'claude'}:${mode || 'default'}`); } catch {}
    // FIRST USE of a harness whose history lives behind an opt-in background
    // service (opencode → the 'opencode-serve' plugin, default OFF since
    // 2026-09-07): offer it ONCE, here at the funnel every create/resume/fork
    // passes through. NOT awaited — a NEW live session never needs the
    // service, so the spawn must not wait on a dialog. The fork path awaits it
    // in _doForkSession instead (a fork is minted THROUGH the service).
    // needsService stays false: a resume rides the agent's own session load,
    // only LISTING and reading stopped conversations need the service.
    // fire-and-forget, but never as an UNHANDLED rejection (the offer is a
    // side quest; it must not surface as a console error on a normal create)
    if (!fork) { try { Promise.resolve(this.maybeOfferHarnessService?.(backend, { needsService: false })).catch(() => {}); } catch {} }
    cwd = stripCwdHostLabel(cwd); // merged-record display cwd ("host: /path") must never reach a spawn
    this._hideWelcome();
    const defaults = this._getBackendSessionDefaults(backend);
    const sessionMode = mode || this.settings.get('session.defaultMode') || 'chat';
    const sessionModel = model !== undefined ? model : defaults.model;
    const sessionPermission = permission !== undefined ? permission : defaults.permission;
    const sessionEffort = effort !== undefined ? effort : defaults.effort;
    const sessionExtraArgs = extraArgs !== undefined ? extraArgs : defaults.extraArgs;
    const sessionName = name || (resumeId ? t('Resume {id}', { id: resumeId.substring(0,8) }) : t('Session {n}', { n: this.wm.windowCounter+1 }));
    const sessionKey = backendSessionId || resumeId ? `${backend}:${backendSessionId || resumeId}` : '';
    const winType = sessionMode === 'chat' ? 'chat' : 'terminal';
    const titleMeta = this._buildTitleMeta({ backend, agentKind, agentRole, agentNickname, sourceKind, parentThreadId });
    const winInfo = this.wm.createWindow({ title: sessionName, type: winType, syncId, titleMeta });
    // Geometry carried over from a window this session replaces (billing
    // switch kill+resume, resume of a terminated read-only window) — without
    // it the conversation "moves" into a default-sized centered window.
    if (winBounds) {
      if (winBounds.gridBounds) { winInfo.gridBounds = { ...winBounds.gridBounds }; this.wm._applyGridBounds(winInfo); }
      if (winBounds.preSnapBounds) winInfo.preSnapBounds = { ...winBounds.preSnapBounds };
      if (winBounds.isMaximized) this.wm.toggleMaximize(winInfo.id);
      // Keep the resumed conversation on its ORIGINAL desktop (see
      // _snapshotWinBounds). createWindow tagged it with the active desktop;
      // move it back when the source lived elsewhere AND that desktop still
      // exists (a since-deleted one just leaves the window active).
      const dm = this.desktopManager;
      const destDesktop = winBounds.desktopId;
      const desktopExists = !!destDesktop && destDesktop !== '__stage__'
        && (dm?._desktops || []).some((d) => d.id === destDesktop);
      if (desktopExists && destDesktop !== winInfo._desktopId && dm?.moveWindowToDesktop) {
        try { dm.moveWindowToDesktop(winInfo.id, destDesktop); } catch {}
      }
      try { window.__vsOp?.('resume-place', { win: winInfo.id, home: destDesktop || null, exists: desktopExists, landed: winInfo._desktopId }); } catch {}
    }
    // Correlation id: concurrent creates (e.g. group resume-all) must each
    // match their OWN 'created' reply — an untagged match binds the ChatView
    // to whichever session the server happens to answer first.
    const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const _createT0 = performance.now();
    // A remote create lawfully spends 5-60s BEFORE 'created' (home-dir probe,
    // cwd preflight, tool tar, writer sweep, daemon provisioning) — the window
    // used to be blank for all of it, so the only signal was a timeout toast
    // blaming the connection.
    const createHostName = this._hostLabel(hostId);
    const pending = this._windowPending(winInfo, createHostName
      ? t('Starting the session on {host}… (installing tools / checking the conversation)', { host: createHostName })
      : (resumeId ? t('Resuming the conversation…') : t('Starting the session…')));

    const createMsg = {
      type:'create', backend, hostId: hostId||undefined, keeperSid: keeperSid||undefined, mode: sessionMode, cwd: cwd||undefined, sessionName: name||undefined, model: sessionModel||undefined,
      permissionMode: sessionPermission||undefined, effort: sessionEffort||undefined, outputStyle: outputStyle||undefined, autoResume, extraArgs: sessionExtraArgs||undefined,
      tuiRenderer: (backend === 'claude' && sessionMode === 'terminal' ? this.settings.get('claude.tuiRenderer') : '') || undefined,
      agentKind: agentKind || undefined, agentRole: agentRole || undefined, agentNickname: agentNickname || undefined,
      sourceKind: sourceKind || undefined, parentThreadId: parentThreadId || undefined,
      // initialCommand reaches the SERVER too (2.196.0): the shell adapter
      // arms DISABLE_UPDATE_PROMPT for auto-typed shells — without this field
      // the guard was dead code and oh-my-zsh's [Y/n] ate the first typed
      // char on remote helper terminals ("claude /login" → "laude").
      initialCommand: initialCommand || undefined,
      resume: !!resumeId, resumeId: resumeId||undefined, fork: fork||undefined, cols:120, rows:30, reqId,
      taskId: taskId || undefined, // spawns VIBESPACE_TASK_ID into the agent env
      accountId: accountId || undefined, // billing identity: undefined=server default, 'subscription', or acct-… key id
      modelLock: modelLock || undefined, // #6 lock v2: the server re-pins the target model after any fallback
      lockModel: lockModel || undefined, // explicit lock TARGET (review-caught: inferring from the spawn model re-targeted to claude.defaultModel)
      recreateCwd: recreateCwd || undefined, // B-7812: user danger-confirmed rebuilding a missing cwd
      ignoreNoConvo: ignoreNoConvo || undefined, // 2.227.3: user chose to retry past the no-transcript breaker
    };

    // Request/reply via ws.request (2026-07-03 review structural fix):
    // self-cleanup on window close + the reply watchdog (a create swallowed by
    // a zombie ws left a blank window with ZERO trace anywhere) + reconnect
    // re-send. Re-send is gated to RESUMES only (claude + codex): if the
    // create DID reach the old server, its dtach session survives the restart
    // and the re-sent resume trips the resume-already-live guard (2.179.0;
    // codex since the P1 codex double-writer fix — the wrapper's thread/resume
    // REUSES the thread id, it never forked), which the error branch turns
    // into an attach — no double-writer. Fresh creates and forks mint NEW ids
    // with no such guard, so re-sending them risks a silent double-spawn.
    this.ws.request(createMsg, (msg) => {
      // Server refused the create (e.g. remote subscription-shipping policy):
      // surface it — without this the window stayed BLANK forever with no
      // feedback and no openSpec (found reproducing the remote-blank report).
      if (msg.type === 'error' && msg.reqId === reqId) {
        pending.remove();
        try { onCreateResult?.(false, msg); } catch { }
        // Resume guard (2.179.0): the conversation is ALREADY live — attach
        // that session instead of leaving a dead "create failed" window (a
        // second --resume would double-write the same claude id).
        if (msg.code === 'resume-already-live' && msg.existingId) {
          showToast(t('Already running — opened the live session instead'));
          try { this.wm.closeWindow(winInfo.id); } catch { }
          this.attachSession(msg.existingId, msg.existingName || sessionName, msg.existingCwd || cwd, {
            mode: msg.existingMode || sessionMode, backend,
            backendSessionId: resumeId || undefined, hostId: hostId || undefined,
          });
          return true;
        }
        const text = msg.message || t('Session create failed');
        // Failed RESUME rescue (2.219.0, real window-loss class): resumeSession
        // CLOSES the old read-only window before creating, so a failed create
        // used to leave only a spec-less "Create failed" shell — which
        // EVAPORATES on the next refresh (captureState skips windows without
        // an openSpec-recreatable identity), silently losing the window from
        // the layout (userL lost "Mega Fish 训练" this way). Flip the shell
        // into the view-only pipeline with a REAL viewSession openSpec so the
        // window shows history + Resume and persists/syncs like any other.
        const rescueViewOnly = () => {
          winInfo._openSpec = {
            action: 'viewSession', sessionId: resumeId, backend,
            backendSessionId: resumeId, sessionKey: `${backend}:${resumeId}`,
            hostId: hostId || undefined, cwd: cwd || '', name: sessionName || '',
          };
          this.wm.setTitle(winInfo.id, `${sessionName || resumeId.slice(0, 8)} — ${cwd || ''}`);
          this._viewIntoWindow(winInfo, { backend, backendSessionId: resumeId, cwd, name: sessionName, hostId });
          this.sessions.get(winInfo.id)?._renderers?.appendSystem(text);
          this.layoutManager?.scheduleAutoSave?.();
          try { track('event', 'create-failed-rescued'); } catch { }
        };
        // No-transcript breaker (2.227.3, userN's 46MB "修轮子"): the CLI's
        // "no conversation found" only proves it looked in the WRONG PLACE —
        // the old dead-end told the user to close the card and start over,
        // i.e. discard a live conversation. Rescue into view-only (history +
        // Resume) and offer a retry that BYPASSES the breaker.
        if (msg.code === 'no-convo-breaker' && resumeId) {
          const retry = () => this.createSession({
            cwd, name: sessionName, resumeId, mode: sessionMode, model, permission, effort,
            backend, hostId, keeperSid, accountId, extraArgs, agentKind, agentRole, agentNickname,
            sourceKind, parentThreadId, ignoreNoConvo: true,
          });
          // Transcript verified to exist ⇒ the retry will usually just work
          // once the underlying cause is fixed — surface it as an UNMISSABLE
          // confirm dialog (2.237.0, real report: the 2.227.3 retry bar sat
          // quietly at the bottom of the rescued window and the user never
          // saw it — "还是resume不了"). Decline falls back to the rescued
          // view + the bar, exactly the old behavior.
          if (msg.transcriptKnown) {
            showConfirmDialog({
              title: t('Conversation found — retry now?'),
              message: t('The last resume failed because the CLI looked in the wrong folder, but this conversation\u2019s transcript EXISTS — nothing is lost. Retry the resume right now (this skips the retry cooldown)?'),
              confirmText: t('Retry resume now'),
            }).then((ok) => {
              if (ok) {
                const bounds = winBounds || this._snapshotWinBounds?.(this.wm.windows.get(winInfo.id));
                try { this.wm.closeWindow(winInfo.id); } catch { }
                this.createSession({
                  cwd, name: sessionName, resumeId, mode: sessionMode, model, permission, effort,
                  backend, hostId, keeperSid, accountId, extraArgs, agentKind, agentRole, agentNickname,
                  sourceKind, parentThreadId, winBounds: bounds, ignoreNoConvo: true,
                });
                return;
              }
              rescueViewOnly();
              const view = this.sessions.get(winInfo.id);
              view?._renderers?.appendSystem(t('A transcript for this conversation exists — it is not lost. The history below is loaded from it.'));
              view?._showRetryResumeBar?.(retry);
            });
            return true;
          }
          showToast(text, { type: 'error' });
          rescueViewOnly();
          const view = this.sessions.get(winInfo.id);
          view?._renderers?.appendSystem(t('No transcript turned up for this conversation. Nothing has been deleted; the history below is whatever could be loaded.'));
          view?._showRetryResumeBar?.(retry);
          return true;
        }
        // Missing-cwd DANGER flow (B-7812, user-approved with the explicit
        // constraint that this must be a red option): offer to recreate the
        // dir EMPTY and resume. The confirm spells out that the agent's files
        // are gone; on confirm the server also arms a one-shot agent notice
        // (prompt-context) so the session can never silently continue on the
        // false premise that its files still exist.
        if (msg.code === 'cwd-missing' && resumeId && !recreateCwd && sessionMode === 'chat') {
          const missingCwd = msg.cwd || cwd || '';
          showConfirmDialog({
            title: t('Working directory is gone'),
            message: `${missingCwd}\n\n` + t('This folder no longer exists on {machine}. You can recreate it as an EMPTY folder and resume — but every file the agent worked with there is GONE and is not coming back. The agent will be told the folder was recreated empty.', { machine: msg.hostName || t('this machine') }),
            confirmText: t('Recreate empty folder & resume'),
            danger: true,
          }).then((ok) => {
            if (!ok) { rescueViewOnly(); return; }
            const bounds = winBounds || this._snapshotWinBounds?.(this.wm.windows.get(winInfo.id));
            try { this.wm.closeWindow(winInfo.id); } catch { }
            this.createSession({
              cwd, name: sessionName, resumeId, mode: sessionMode, model, permission, effort,
              backend, hostId, keeperSid, accountId, extraArgs, agentKind, agentRole, agentNickname,
              sourceKind, parentThreadId, winBounds: bounds, recreateCwd: true,
            });
          });
          return true;
        }
        showToast(text, { type: 'error' });
        if (sessionMode === 'chat' && resumeId && !/^sess-\d/.test(resumeId) && backend === 'claude') {
          rescueViewOnly();
          return true;
        }
        const err = document.createElement('div');
        err.className = 'empty-hint';
        err.style.cssText = 'padding:24px;white-space:pre-wrap;user-select:text';
        // Identify WHICH session the failed create/resume was for — the
        // failure fires before the window ever gets an openSpec, so without
        // this the error shell was anonymous (real report: user couldn't
        // tell which conversation a "Create failed" window belonged to).
        err.textContent = text
          + (resumeId ? `\n\n${t('Conversation')}: ${resumeId}` : '')
          + (cwd ? `\n${cwd}` : '');
        winInfo.content.appendChild(err);
        const label = sessionName || (resumeId ? resumeId.slice(0, 8) : '');
        this.wm.setTitle(winInfo.id, label ? `${t('Create failed')} — ${label}` : t('Create failed'));
        return true;
      }
      if (msg.type === 'created' && msg.reqId === reqId) {
        pending.remove();
        try { onCreateResult?.(true, msg); } catch { }
        // Non-fatal server warning (2.271.0 T1-2): the pre-resume writer sweep
        // couldn't verify no other process was writing this conversation on a
        // laggy host — the resume proceeded, but the user must know a double-
        // write is possible so they don't mistake duplicated messages for a bug.
        if (msg.warning) { try { showToast(msg.warning, { type: 'error', duration: 9000 }); } catch { } }
        // The pre-resume sweep STOPPED another process that was writing this
        // conversation (2.276.0). That is destructive by design — say it, so a
        // terminal that just died elsewhere is explained rather than mysterious.
        if (msg.swept?.pids?.length) {
          try {
            showToast(t('Stopped {n} other process(es) that were still writing this conversation on {host} — resuming cleanly.',
              { n: msg.swept.pids.length, host: msg.swept.host || t('this machine') }), { duration: 8000 });
          } catch { }
        }
        metric('session-create-roundtrip-ms', performance.now() - _createT0);
        // Set openSpec now that we have the server session ID (for cross-client sync)
        winInfo._openSpec = {
          action: 'attachSession',
          serverId: msg.sessionId,
          backend,
          backendSessionId: backendSessionId || resumeId || null,
          hostId: hostId || null,
          sessionKey,
          agentKind: agentKind || 'primary',
          agentRole: agentRole || '',
          agentNickname: agentNickname || '',
          sourceKind: sourceKind || '',
          parentThreadId: parentThreadId || null,
          name: sessionName,
          cwd: msg.cwd || cwd || '',
          mode: sessionMode,
        };
        this.layoutManager.scheduleAutoSave(); // re-broadcast with openSpec
        // Persist a fork's chosen title as a custom name once the fork's NEW
        // backend id is adopted (after its first turn). Keyed by webui id; the
        // parent id is remembered so we don't rename the parent before divergence.
        if (forkTitle && resumeId) {
          (this._pendingForkTitles ??= new Map()).set(msg.sessionId, { name: forkTitle, parentId: backendSessionId || resumeId });
        }
        // Same for a USER-TYPED name on a brand-new session (New Session dialog):
        // the window title carried it, but the sidebar names sessions from the
        // first user message unless a CUSTOM NAME exists — so the typed name
        // silently lost to the first message once the transcript appeared.
        // Persist it as the custom name when the backend id is adopted.
        else if (name && name.trim() && !resumeId && backend !== 'shell' && !ephemeral) {
          (this._pendingCreateNames ??= new Map()).set(msg.sessionId, name.trim());
        }
        // Session created "in" a task — bind once the backend session id shows
        // up in active-sessions (unknown at creation for claude; folder
        // auto-include already covers tasks with linked folders, this makes
        // the explicit tag stick for folder-less tasks too).
        if (taskId) this.sidebar?._registerPendingTaskBind?.(msg.sessionId, taskId);
        if (msg.mode === 'chat' || sessionMode === 'chat') {
          const chatView = new ChatView(winInfo, this.ws, msg.sessionId, this);
          this.sessions.set(winInfo.id, chatView);
          // Commanded-at-spawn effort (the CLI never reports effort back, so
          // the commanded value is the display source — same as the server's
          // attach-time merge)
          if (sessionEffort) chatView.applyStatus({ effort: sessionEffort });
          // The creator NEVER receives an 'attached' payload, so the live
          // output style / auto-resume state rides the 'created' reply — the
          // HTTP history load below carries no meta, and without this a
          // resumed window said "style: default" while the session verifiably
          // ran the picked style (2.368.4, owner-caught).
          chatView._applyLiveMeta?.(msg);
          winInfo.onClose = () => {
            const shouldKill = (this.settings.get('window.closeBehavior') ?? 'terminate') === 'terminate';
            if (shouldKill) this.killSession(msg.sessionId);
            // pending name/fork-title entries otherwise only clear on identity
            // adoption — a window closed before that leaked them forever
            this._pendingForkTitles?.delete(msg.sessionId);
            this._pendingCreateNames?.delete(msg.sessionId);
            chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
          };
          winInfo._notifyChanged = () => this.updateTaskbar();
          // Load JSONL history for resumed sessions (truncated at the fork
          // point when forking from a specific message, so the displayed history
          // matches the fork's actual --resume-session-at boundary).
          // REMOTE sessions must pass host: the transcript lives on the host and
          // /api/session-messages only pulls it into the local cache when asked
          // (?host=). Without it, an externally-started server session — whose
          // cache nothing ever warmed — resumed into a BLANK conversation
          // (real user report 2026-07-11); VibeSpace-started ones appeared fine
          // only because attach/view paths had already cached their transcript.
          if (resumeId) {
            fetch(`/api/session-messages?backend=${encodeURIComponent(backend)}&backendSessionId=${encodeURIComponent(backendSessionId || resumeId)}&cwd=${encodeURIComponent(cwd||'')}&withStatus=1${hostId ? `&host=${encodeURIComponent(hostId)}` : ''}${forkAtUuid ? `&untilUuid=${encodeURIComponent(forkAtUuid)}` : ''}`)
              .then(r => r.json())
              .then(data => {
                if (data.messages?.length) chatView.loadHistory(data.messages, data.total);
                if (data.chatStatus) chatView.applyStatus(data.chatStatus);
              })
              .catch(() => {})
              // Send the fork's first message AFTER history renders, so the
              // echoed user message appends instead of being wiped by loadHistory.
              // This first turn is also what makes the fork diverge (claude mints
              // the fork's new id on first input).
              .finally(() => { if (initialMessage) this._sendChatMessage(msg.sessionId, initialMessage); });
          } else if (initialMessage) {
            this._sendChatMessage(msg.sessionId, initialMessage);
          }
          chatView.focus();
        } else {
          const term = new TerminalSession(winInfo, this.ws, msg.sessionId, this.themeManager, (filePath, signalPath) => {
            this._openExternalEditor(filePath, signalPath);
          }, {}, this.settings);
          this.sessions.set(winInfo.id, term);
          // Automation-command terminals (Log in / Update helpers) are
          // throwaway — closing the window should terminate them directly,
          // never leave a detached login shell lingering, regardless of the
          // global close-behavior setting.
          this._wireTerminalWindow(winInfo, term, msg.sessionId, { ephemeral: ephemeral || !!initialCommand, backend });
          // Type a starter command for the user (shell terminals: login helpers
          // etc.) once the shell has had a beat to print its prompt
          if (initialCommand) {
            setTimeout(() => this.ws.send({ type: 'input', sessionId: msg.sessionId, data: initialCommand + '\r' }), 1200);
          }
          term.focus();
        }
        this.wm.setTitle(winInfo.id, `${sessionName} — ${msg.cwd||cwd||'~'}`);
        return true;
      }
      return false;
    }, {
      isAlive: () => this.wm.windows.has(winInfo.id),
      timeoutMs: 15000,
      onTimeout: () => {
        try { track('event', 'ws-reply-timeout:create', backend + ':' + sessionMode); } catch { }
        // A slow REMOTE create is not a broken connection — the old wording
        // invited a reload, which abandons the create (fresh creates are not
        // re-sent on reconnect, so the window comes back spec-less).
        showToast(createHostName
          ? t('Still starting the session on {host} — this can take a minute on a slow machine. Leave the window open.', { host: createHostName })
          : t('Creating the session is taking unusually long — it may still be in progress; reloading the tab abandons it'), { type: 'error' });
      },
      resend: (backend === 'claude' || backend === 'codex') && !!resumeId && !fork,
    });
  },

  _wireTerminalWindow(winInfo, term, sessionId, { killOnClose = true, ephemeral = false, backend = 'claude' } = {}) {
    winInfo._ephemeral = ephemeral;
    winInfo.onClose = () => {
      // ephemeral (automation helper) terminals always terminate on close;
      // otherwise honor the global close-behavior (default: detach — user
      // directive, no per-type exceptions; sessions stay re-attachable)
      const shouldKill = ephemeral || (killOnClose && this.settings.get('window.closeBehavior') === 'terminate');
      if (shouldKill) this.killSession(sessionId);
      term.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
    };
    winInfo._notifyChanged = () => this.updateTaskbar();
    // Exited-overlay Resume (2.206.0): agent terminals resume by conversation
    // id (kept fresh in the openSpec by syncSessionIdentity); plain shells
    // have nothing to resume — no callback, the overlay shows message-only.
    if (backend !== 'shell') {
      term.onSessionExited = () => {
        const spec = winInfo._openSpec || {};
        const backendSessionId = spec.backendSessionId;
        const cwd = spec.cwd || winInfo.cwd || '';
        if (!backendSessionId) { showToast(t('Session id not known — resume it from the sidebar'), { type: 'error' }); return; }
        const name = this.sidebar?.getCustomName?.({ backend, backendSessionId }) || spec.name || winInfo.name || t('Session');
        const winId = winInfo.id;
        const winBounds = this._snapshotWinBounds(this.wm.windows.get(winId));
        this.wm?.closeWindow?.(winId);
        this.resumeSession(backendSessionId, cwd, name, {
          mode: 'terminal', backend, backendSessionId,
          hostId: spec.host || spec.hostId || undefined, winBounds,
        });
      };
    }
  },

  // RELIABLE KILL (2.369.16, userW inc-mtndq0vb "没法 terminate"): a kill
  // written to a socket the server later terminated (its own stall → missed
  // pong) was simply lost — the window stayed blank and Terminate did
  // nothing. Every kill now rides ws.request with resend:true and is
  // re-sent on each reconnect until the server acknowledges ('killed' to
  // the requester — ok:false = already gone — or the attached-only 'exited').
  // Two frames when a conversation id is known (review-caught): the frame
  // carrying backendSessionId lets the server's 2.179.0 stale-id fallback
  // find the live session, but that same fallback would make a RESENT copy
  // kill whatever session later resumed the conversation — so only the plain
  // {kill, sessionId} rides the resend chase, and the fallback frame is a
  // one-shot sent first. The server answers 'killed' with the id the client
  // asked for (requestedId), so a remapped kill still resolves the request.
  // The 3-minute watchdog DISARMS the request (ws.request's timer alone
  // leaves the handler live) — nothing chases a kill for the page's lifetime.
  killSession(webuiId, backendSessionId) {
    if (!webuiId) return;
    if (backendSessionId) this.ws.send({ type: 'kill', sessionId: webuiId, backendSessionId });
    const msg = { type: 'kill', sessionId: webuiId };
    const cancel = this.ws.request(msg, (m) => (m.type === 'killed' || m.type === 'exited') && m.sessionId === webuiId,
      { resend: true, timeoutMs: 180000, onTimeout: () => cancel() });
  },

  // ONE-CLICK RESTART (owner UX, 2.369.8: applying a "next resume" pick —
  // output style etc. — used to mean a sidebar hunt + terminate + re-find
  // the moved entry). Terminate, wait for the transcript flush, resume the
  // SAME conversation — per-session config rides the respawn automatically.
  // Same kill→exited→resume machinery the pool cold switch uses.
  restartConversationInPlace(sessLike = {}) {
    const all = this.sidebar?._allSessions || [];
    const live = all.find((x) => (sessLike.webuiId && x.webuiId === sessLike.webuiId)
      || (sessLike.sessionId && x.sessionId === sessLike.sessionId)
      || (sessLike.backendSessionId && x.sessionId === sessLike.backendSessionId)) || sessLike;
    const cid = live.sessionId || live.backendSessionId;
    if (!cid) { showToast(t('Nothing to restart — this session has no conversation id yet'), { type: 'error' }); return; }
    const webuiId = live.webuiId || sessLike.webuiId || null;
    const name = this.sidebar?.getCustomName?.({ backend: live.backend, backendSessionId: cid }) || live.name || '';
    const mode = live.webuiMode || 'chat';
    const finish = () => this.resumeSession(cid, live.cwd || '', name, { mode, backend: live.backend || 'claude', backendSessionId: cid, hostId: live.host || undefined, excludeWebuiId: webuiId || undefined });
    if (!webuiId || live.status === 'stopped') { finish(); return; }  // already dead — just resume
    showToast(t('Restarting the session…'));
    let done = false;
    const go = () => { if (done) return; done = true; this.ws.offGlobal(onExit); finish(); };
    const onExit = (msg) => { if (msg.type === 'exited' && msg.sessionId === webuiId) setTimeout(go, 400); }; // let the CLI flush its transcript
    this.ws.onGlobal(onExit);
    this.killSession(webuiId, cid);
    setTimeout(go, 15000); // a lost exited must not strand the restart
  },

  // Jump the sidebar to a conversation's entry (owner UX: with dozens of
  // sessions the entry hunt was the pain) — switch to Folders, expand the
  // containing folder if collapsed, scroll to the card and flash it.
  locateSessionInSidebar(backendSessionId) {
    const sb = this.sidebar;
    if (!sb || !backendSessionId) return;
    try { sb._railGo?.('folders'); } catch { }
    try { if (sb._activeTab !== 'folders') { sb._activeTab = 'folders'; sb.render?.(); } } catch { }
    setTimeout(() => {
      const card = [...document.querySelectorAll('.session-card')].find((c) => c._sessionId === backendSessionId);
      if (!card) { showToast(t('Entry not visible — it may be archived or filtered out')); return; }
      const group = card.closest('.folder-group');
      if (group?.classList.contains('collapsed')) group.classList.remove('collapsed');
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      card.classList.add('locate-flash');
      setTimeout(() => card.classList.remove('locate-flash'), 2400);
    }, 60);
  },

  async killPid(pid, host) {
    // host: an EXTERNAL/tmux session discovered on a REMOTE machine — its pid
    // lives there; the local-only route 400'd silently forever (real report:
    // terminate一直不成功). Failures now surface as a toast either way.
    try {
      const r = await fetch('/api/kill-pid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid, host: host || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) showToast(j.error || t('Terminate failed'), { type: 'error' });
      else {
        showToast(t('Terminated'));
        // The server invalidated the host's discovery cache; the sidebar's
        // remote-zone cache has no TTL — force one fresh load so the card
        // flips to STOPPED without a manual ⟳.
        if (host) this.sidebar?._loadRemoteHost?.(host, { fresh: true });
      }
    } catch { showToast(t('Terminate failed'), { type: 'error' }); }
  },

  // Find existing window for a server session ID and focus it
  _focusExistingSession(serverId) {
    for (const [winId, term] of this.sessions) {
      if (term.sessionId === serverId) {
        this.wm.focusWindow(winId);
        if (this.wm.windows.get(winId)?.isMinimized) this.wm.restore(winId);
        term.focus();
        return true;
      }
    }
    return false;
  },

  _closeSidebarOnMobile() {
    if (window.innerWidth <= 768 && this.sidebar.isOpen) this.sidebar.toggle(false);
  },

  // Transition-state note for a window whose contents only exist once a ws
  // reply lands. A remote attach/create legitimately runs 15-120s (transcript
  // pull over ssh, keeper probe, tool shipping, cwd preflight) and the window
  // was BLANK for all of it — indistinguishable from a broken one, which is
  // what taught users to reload the tab and abandon the create.
  _windowPending(winInfo, text) {
    const el = document.createElement('div');
    el.className = 'empty-hint';
    el.style.cssText = 'padding:24px;white-space:pre-wrap';
    el.textContent = text;
    winInfo.content.appendChild(el);
    return { set: (s) => { el.textContent = s; }, remove: () => el.remove() };
  },

  attachSession(serverId, name, cwd, { mode, syncId, backend = 'claude', backendSessionId, hostId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId } = {}) {
    cwd = stripCwdHostLabel(cwd); // keep openSpec.cwd a REAL path — it persists into layouts and feeds later resumes
    this._closeSidebarOnMobile();
    // If we already have a window for this session, just focus it
    if (this._focusExistingSession(serverId)) return null;

    this._hideWelcome();
    const isChat = mode === 'chat';
    const openSpec = {
      action: 'attachSession',
      serverId,
      name,
      cwd,
      mode,
      backend,
      backendSessionId: backendSessionId || null,
      hostId: hostId || null,
      sessionKey: backendSessionId ? `${backend}:${backendSessionId}` : '',
      agentKind: agentKind || 'primary',
      agentRole: agentRole || '',
      agentNickname: agentNickname || '',
      sourceKind: sourceKind || '',
      parentThreadId: parentThreadId || null,
    };
    const winInfo = this.wm.createWindow({
      title: `${name} — ${cwd}`,
      type: isChat ? 'chat' : 'terminal',
      syncId,
      openSpec,
      titleMeta: this._buildTitleMeta(openSpec),
    });

    const hostName = this._hostLabel(openSpec.hostId);
    const pending = this._windowPending(winInfo, hostName
      ? t('Connecting to {host}…', { host: hostName })
      : t('Opening session…'));
    let acked = false;

    // Request/reply via ws.request: self-cleanup on window close (esp. slow
    // huge-JSONL attaches — a leaked handler could build a ChatView into a
    // dead winInfo and leave a phantom sessions entry), the reply watchdog
    // (a lost attach used to leave the window silently blank forever with
    // zero telemetry), and reconnect re-send: attach is idempotent — the
    // restarted server either re-adopted the dtach session (attached) or
    // answers error → the view-only rescue below; without the re-send a
    // window awaiting its FIRST 'attached' had no session object, so
    // app.js's reconnect loop never covered it (blank-shell class).
    this.ws.request({ type: 'attach', sessionId: serverId }, (msg) => {
      // PROOF OF LIFE (2.234.1's ack, consumed here too): the server answers
      // this synchronously at the top of every attach, so a long wait after it
      // is the transcript pull / history rebuild working — not a dead
      // connection. Name what it is waiting on and disarm the alarmist toast.
      if (msg.type === 'attach-ack' && msg.sessionId === serverId) {
        acked = true;
        pending.set(isChat
          ? (hostName
            ? t('Loading history from {host}… (large conversations can take a while)', { host: hostName })
            : t('Loading history…'))
          : t('Restoring the terminal…'));
        return false; // not the reply — keep waiting
      }
      if ((msg.type === 'error') && msg.sessionId === serverId) {
        pending.remove();
        // Dead session (stale serverId from a saved layout — server restart
        // after an OOM kill / pod recreation loses every dtach session): no
        // ChatView exists yet at this point, so ChatView's own error path
        // can't fire — dropping the handler left a BARE BLANK window shell
        // (real fleet report: 12 at once). Flip the window into the
        // view-only pipeline in place: saved history + Resume bar.
        const bsid = openSpec.backendSessionId;
        if (isChat && bsid && !/^sess-\d/.test(bsid)) {
          this._viewIntoWindow(winInfo, { backend, backendSessionId: bsid, cwd, name, hostId: openSpec.hostId });
          try { track('event', 'chat-attach-rescued'); } catch { }
        } else {
          // Not rescuable (terminal window / synthetic id): removing the
          // placeholder without this leaves the same anonymous blank shell the
          // rescue exists to prevent — state the failure in the window.
          this._windowPending(winInfo, (msg.message || t('Session not found.'))
            + '\n\n' + t('Resume it from the sidebar.'));
        }
        return true;
      }
      if (msg.type === 'attached' && msg.sessionId === serverId) {
        pending.remove();
        if (msg.mode === 'chat' || isChat) {
          const chatView = new ChatView(winInfo, this.ws, serverId, this);
          this.sessions.set(winInfo.id, chatView);
          if (msg.messages?.length) {
            // The attach payload IS the meta (2.368.4): this hand-copied key
            // list silently dropped outputStyle/autoResume/streamingKind — the
            // whitelist-drift class, fifth strike.
            chatView.loadHistory(msg.messages, msg.totalCount, msg.isStreaming, msg);
          } else {
            chatView._applyLiveMeta?.(msg); // zero messages still has live state
          }
          if (msg.viewOnly) chatView._setReadOnly();
          winInfo.onClose = () => {
            const shouldKill = !msg.viewOnly && (this.settings.get('window.closeBehavior') ?? 'terminate') === 'terminate';
            if (shouldKill) this.killSession(serverId);
            chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome();
          };
          winInfo._notifyChanged = () => this.updateTaskbar();
          chatView.focus();
        } else {
          // Terminal mode (existing)
          const term = new TerminalSession(winInfo, this.ws, serverId, this.themeManager, (fp, sp) => this._openExternalEditor(fp, sp), {}, this.settings);
          this.sessions.set(winInfo.id, term);
          if (msg.buffer) {
            const buf = msg.buffer;
            term._suppressWaiting = true;
            // _replaying: suppress xterm's auto-answers to query sequences
            // stored in the buffer (they were answered live long ago — the
            // re-answers echo as ^[]11;rgb:… junk; see terminal.js onData).
            term._replaying = true;
            setTimeout(() => { term.terminal.write(buf, () => { term._suppressWaiting = false; term._replaying = false; term.terminal.scrollToBottom(); term.fit(); }); }, 300);
          }
          this._wireTerminalWindow(winInfo, term, serverId, { backend });
          term.focus();
        }
        return true;
      }
      return false;
    }, {
      isAlive: () => this.wm.windows.has(winInfo.id),
      timeoutMs: 12000,
      onTimeout: () => {
        try { track('event', 'ws-reply-timeout:attach', serverId); } catch { }
        // ACKED ⇒ the server IS alive and working (the 2.234.1 lesson: "check
        // the connection or reload the tab" on a legitimately slow remote pull
        // is the misdiagnosis that made users reload and lose windows).
        if (acked) {
          showToast(t('"{name}" is still loading — {host} may be slow. Leave the window open.', { name: name || serverId, host: hostName || t('the machine') }));
          return;
        }
        showToast(t('Attaching "{name}" is taking unusually long — it may still be working; check the connection before reloading', { name: name || serverId }), { type: 'error' });
      },
      resend: true,
    });
    return winInfo;
  },

  attachTmuxSession(tmuxTarget, name, cwd) {
    this._closeSidebarOnMobile();
    // Check if already viewing this tmux target
    for (const [winId, term] of this.sessions) {
      if (term._tmuxTarget === tmuxTarget) {
        this.wm.focusWindow(winId);
        if (this.wm.windows.get(winId)?.isMinimized) this.wm.restore(winId);
        term.focus(); return;
      }
    }

    this._hideWelcome();
    // openSpec from creation: without it, another client's layout-sync diff
    // sees an unknown window and closes it (tmux views were killed on the
    // first remote broadcast)
    const winInfo = this.wm.createWindow({ title: `[tmux] ${name}`, type: 'terminal', openSpec: { action: 'attachTmuxSession', tmuxTarget, name, cwd } });
    const reqId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // ws.request: self-cleanup on window close + a reply watchdog (this path
    // had NO watchdog at all — a lost tmux-attach failed with zero feedback).
    // NOT re-sent on reconnect: tmux-attach mints a new server-side view pty
    // per request, so a re-send after a zombie-ws reconnect (where the first
    // request DID land) would leak a clientless duplicate view.
    this.ws.request({ type: 'tmux-attach', tmuxTarget, name, cwd, cols: 120, rows: 30, reqId }, (msg) => {
      if (msg.type === 'created' && msg.isTmuxView && msg.reqId === reqId) {
        const term = new TerminalSession(winInfo, this.ws, msg.sessionId, this.themeManager, null, {}, this.settings);
        term._tmuxTarget = tmuxTarget;
        this.sessions.set(winInfo.id, term);
        // Closing window only detaches the tmux view — does NOT kill the session
        this._wireTerminalWindow(winInfo, term, msg.sessionId, { killOnClose: false });
        term.focus();
        return true;
      }
      return false;
    }, {
      isAlive: () => this.wm.windows.has(winInfo.id),
      timeoutMs: 12000,
      onTimeout: () => {
        try { track('event', 'ws-reply-timeout:tmux-attach', tmuxTarget); } catch { }
        showToast(t('Attaching "{name}" is taking unusually long — check the connection or reload the tab', { name: name || tmuxTarget }), { type: 'error' });
      },
    });
  },

  resumeSession(sessionId, cwd, sessionName, { mode, model, effort, permission, accountId, syncId, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId, hostId, keeperSid, winBounds, excludeWebuiId, onCreateResult } = {}) {
    this._closeSidebarOnMobile();
    const targetBackendId = backendSessionId || sessionId;
    // If this session is already open in a LIVE window, focus it.
    // TWO staleness guards (2.241.0): a read-only view is a DEAD window, not a
    // live one (its ChatView keeps sessionId after 'exited'), and an
    // excludeWebuiId caller (billing switch) just killed that id — either can
    // still match here because _allSessions refreshes on a poll/broadcast that
    // may be seconds stale, and the silent return ate the whole resume.
    for (const [winId, term] of this.sessions) {
      if (term.sessionId && !term._readOnly) {
        const sidebar = this.sidebar;
        const match = (sidebar._allSessions || []).find(s => (s.backendSessionId || s.sessionId) === targetBackendId && (s.backend || 'claude') === backend && s.webuiId);
        if (match && term.sessionId === match.webuiId && match.webuiId !== excludeWebuiId) {
          this._focusExistingSession(match.webuiId);
          return;
        }
      }
    }
    // Close any TERMINATED/read-only windows for the same backend session
    // (otherwise we'd end up with two windows pointing at the same conversation)
    for (const [winId, term] of [...this.sessions]) {
      const win = this.wm.windows.get(winId);
      const spec = win?._openSpec;
      if (spec?.backend === backend && spec?.backendSessionId === targetBackendId) {
        // The resumed conversation should stay where the old window was.
        if (!winBounds) winBounds = this._snapshotWinBounds(win);
        this.wm.closeWindow(winId);
      }
    }

    const sessionMode = mode || (this.settings.get('session.defaultMode') ?? 'chat');
    // Apply persisted per-session config (gear popover) for any param the caller
    // didn't specify — covers card click, resume-all, chat resume bar, etc.
    const savedCfg = this.sidebar?.getSessionConfig?.({ backend, sessionId, backendSessionId: targetBackendId }) || {};
    // Context task rides across resumes: the first task this session is
    // explicitly tagged with becomes VIBESPACE_TASK_ID again, so the
    // SessionStart hook re-injects task context on every resume.
    const contextTask = this.sidebar?._getSessionTasks?.({ backend, backendSessionId: targetBackendId })?.[0];
    this.createSession({
      cwd,
      name: sessionName,
      resumeId: sessionId,
      mode: sessionMode,
      model: model !== undefined ? model : savedCfg.model,
      permission: permission !== undefined ? permission : savedCfg.permission,
      effort: effort !== undefined ? effort : savedCfg.effort,
      outputStyle: savedCfg.outputStyle,   // 2.368.0: spawn-only settings key, so a resume is where a change lands
      autoResume: savedCfg.autoResume,     // tri-state: undefined = follow the instance default
      accountId: accountId !== undefined ? accountId : savedCfg.account,
      modelLock: savedCfg.modelLock,  // #6 lock v2: a locked conversation stays locked across resume (re-pin re-arms)
      lockModel: savedCfg.lockModel,
      syncId,
      backend,
      keeperSid,
      backendSessionId: backendSessionId || sessionId,
      hostId, // remote session resumes ON its host
      agentKind,
      agentRole,
      agentNickname,
      sourceKind,
      parentThreadId,
      taskId: contextTask?.id,
      winBounds,
      onCreateResult,
    });
  },

  _snapshotWinBounds(win) {
    if (!win) return undefined;
    return {
      gridBounds: win.gridBounds ? { ...win.gridBounds } : null,
      preSnapBounds: win.preSnapBounds ? { ...win.preSnapBounds } : null,
      isMaximized: !!win.isMaximized,
      // The resumed conversation must stay on its HOME desktop — not the one
      // that happens to be active. A single billing switch usually resumes a
      // session on the visible desktop (so this is a no-op there), but the
      // pool cold-restart kills+resumes sessions across EVERY desktop at once
      // while one is active: without this every one of them piled onto the
      // active desktop and flattened the whole layout (a fleet user, inc-mso43urh).
      desktopId: win._desktopId || null,
    };
  },

  // "Hot-switch" a session's billing account (title-bar badge click). A true
  // in-process swap is impossible — the account rides the spawn env
  // (ANTHROPIC_API_KEY / CLAUDE_SECURESTORAGE_CONFIG_DIR / CODEX_HOME), fixed
  // for the CLI's lifetime — so this is the honest next best thing: persist
  // the choice (sessionConfigs.account), kill the CLI, resume the SAME
  // conversation on the new account. Also works on already-terminated
  // (read-only) windows, where it just resumes on the picked account.
  // Warm the per-host account knowledge the billing switcher depends on
  // (2.239.2, userN's inc-msfwgfpd-tlhn — the panic button's first real
  // catch): hostSubHeld/hostLinked read `_hostSubsKnown`/host-email caches
  // that only a Manage-Agents visit or a usage ⟳ populated, so on a FRESH
  // page every named subscription rendered disabled ("can't ship") even when
  // its login was held ON the host or WAS the host's own login. Fetch the
  // same accounts-status probe Manage Agents uses, once per host per page;
  // when the fetch lands while the billing menu is still open, rebuild it in
  // place so the rows un-grey in front of the user.
  _warmHostAccountCache(hostId) {
    if (!hostId) return;
    this._hostAcctWarmState = this._hostAcctWarmState || {};
    this._hostAcctWarmAt = this._hostAcctWarmAt || {};
    // TTL, not once-per-page (2.240.1, userN's "左右状态不一致": the host's
    // MACHINE LOGIN can change out from under a page-lifetime cache — he
    // /login'd a different account on the host and the switcher kept calling
    // the OLD identity "the host's own login", a wrong-BILLING hazard, while
    // Manage Agents' fresh probe showed the truth. 2min matches the host
    // auto-test cadence.)
    this._hostAcctWarmErrAt = this._hostAcctWarmErrAt || {};
    if (this._hostAcctWarmState[hostId] === 'pending') return;
    if (this._hostAcctWarmState[hostId] === 'done' && Date.now() - (this._hostAcctWarmAt[hostId] || 0) < 120000) return;
    // A FAILED probe retries in 15s, not 2min (2.272.x lag/silent-failure
    // campaign): the old code stamped a failure as `done` + a FRESH warmAt, so
    // for two whole minutes nothing retried and every consumer kept rendering
    // its legacy fallback as DEFINITIVE ("never finished signing in", "can't
    // ship to {host}") off an answer it never received — a usable host-held
    // login read as broken, with a confident WRONG reason.
    if (this._hostAcctWarmState[hostId] === 'error' && Date.now() - (this._hostAcctWarmErrAt[hostId] || 0) < 15000) return;
    this._hostAcctWarmState[hostId] = 'pending';
    // Rebuild whichever host-scoped surface is open — on SUCCESS the rows
    // un-grey, on FAILURE they gain the honest "couldn't reach {host}" state.
    const rebuild = () => {
      const bm = this._billingMenu;
      if (bm && bm.host === hostId && bm.el?.isConnected) {
        bm.el.remove();
        this.showBillingSwitcher(...bm.args);
      }
      // New Session dialog open on this host → rebuild its account row with
      // the fresh verdicts (same rebuild-on-arrival pattern as the menu)
      try { this._updateAcctRow?.(); } catch { }
    };
    api(`/api/hosts/${encodeURIComponent(hostId)}/accounts-status`).then((r) => {
      this._hostAcctWarmState[hostId] = 'done';
      this._hostAcctWarmAt[hostId] = Date.now();
      if (this._hostAcctWarmErr) delete this._hostAcctWarmErr[hostId];
      if (!r) return;
      this._hostSubsKnown = { ...(this._hostSubsKnown || {}), [hostId]: r.hostSubs || [] };
      const email = String(r.subscription?.email || '').trim().toLowerCase();
      this._hostOwnEmailKnown = { ...(this._hostOwnEmailKnown || {}), [hostId]: email };
      // Server-computed per-account VERDICTS (B-f531) — surfaces render these
      // verbatim; the legacy email/subs caches above stay only as fallback
      // for servers that predate the field.
      if (r.verdicts) this._hostVerdicts = { ...(this._hostVerdicts || {}), [hostId]: r.verdicts };
      rebuild();
    }).catch((e) => {
      // warmAt is the freshness of the DATA, never of the attempt — leave the
      // last good stamp alone so a previously-warmed host keeps its verdicts.
      this._hostAcctWarmState[hostId] = 'error';
      this._hostAcctWarmErrAt[hostId] = Date.now();
      this._hostAcctWarmErr = { ...(this._hostAcctWarmErr || {}), [hostId]: e?.message || t('unreachable') };
      rebuild();
    });
  },

  // Display name for a machine id (host-scoped transition states name the
  // machine — "checking…" alone doesn't say WHICH one is slow).
  _hostLabel(hostId) {
    if (!hostId) return '';
    const hs = this.sidebar?._hostsData?.hosts || this._nsHosts || [];
    return hs.find((h) => h.id === hostId)?.name || hostId;
  },

  showBillingSwitcher(winId, anchor) {
    // Two call shapes: (windowId, anchorElement) from the title-bar identity
    // badge, or (sessionObject, {x,y}) from the sidebar card context menu —
    // the card path has no window (and phones have no title-bar badges).
    let win = null, spec = {}, live = null;
    if (winId && typeof winId === 'object') {
      live = winId;
    } else {
      const term = this.sessions.get(winId);
      win = this.wm.windows.get(winId);
      if (!win) return;
      spec = win._openSpec || {};
      const allSess = this.sidebar?._allSessions || [];
      live = term ? allSess.find(s => s.webuiId === term.sessionId) : null;
    }
    const backend = live?.backend || spec.backend || 'claude';
    if (!backendFeatureCaps(backend).accounts) return; // billing switcher = backends with an account roster (META cap, not an id list)
    const backendSessionId = live?.backendSessionId || spec.backendSessionId || live?.sessionId || null;
    const isCodex = backend === 'codex';
    // exact-backend match (P4): the old boolean partition ('is codex' vs
    // 'is not') breaks structurally with a third backend
    const accts = (this._accounts?.accounts || []).filter(a => (a.backend || 'claude') === backend)
      // same TYPE-then-name order as the Manage-Agents roster (2.268.5) —
      // divergent ordering between the two surfaces reads as a shuffle
      .sort((a, b) => (((a.pooled || a.type === 'pooled') ? 0 : a.type === 'subscription' ? 1 : 2)
        - ((b.pooled || b.type === 'pooled') ? 0 : b.type === 'subscription' ? 1 : 2))
        || String(a.name || '').localeCompare(String(b.name || '')));
    // A stopped session has no live accountId — its saved on-resume account
    // config is the honest "current" (that's what the next resume bills to).
    const savedAcct = !live?.webuiId
      ? this.sidebar?.getSessionConfig?.(`${backend}:${backendSessionId}`)?.account : null;
    const currentId = live?.accountId || (savedAcct && savedAcct !== 'subscription' ? savedAcct : null) || null;
    const doSwitch = async (acctVal, label) => {
      if (!backendSessionId) {
        showToast(t('Nothing to resume yet — send a message first, or pick the account in the New Session dialog'), { type: 'error' });
        return;
      }
      const ok = await showConfirmDialog({
        title: t('Switch billing to “{name}”?', { name: label }),
        message: t('The account is fixed when the CLI starts, so the session restarts and the conversation continues via resume.'),
        confirmText: t('Switch & restart'),
      });
      if (!ok) return;
      const key = spec.sessionKey || `${backend}:${backendSessionId}`;
      // PERSIST-AFTER-VERIFY (B-77f3, 2.243.0): the pick used to be written as
      // the on-resume account BEFORE the spawn — a doomed pick (not logged in,
      // can't ship, host down) poisoned the session's config, and every later
      // manual Resume re-failed with it (userN's 2.240.0 incident chain).
      // The pick now rides the create explicitly and is persisted only once
      // the server confirms the session actually spawned with it.
      const persistOnSuccess = (ok2, createdMsg) => {
        if (!ok2) return; // create errored — config untouched, old account stands
        // Persist the POST-FACTO truth (B-f531): what the server actually
        // resolved the spawn to (created.billing), not the requested intent.
        // billing.accountId null = the CLI/host's own login = the sentinel.
        const resolved = createdMsg?.billing ? (createdMsg.billing.accountId || 'subscription') : acctVal;
        this.sidebar?.setSessionConfig?.(key, { ...(this.sidebar?.getSessionConfig?.(key) || {}), account: resolved });
      };
      const name = this.sidebar?.getCustomName?.({ backend, backendSessionId }) || live?.name || spec.name || win?.title || t('Session');
      const cwd = live?.cwd || spec.cwd || '';
      const mode = live?.webuiMode || (win ? (win.type === 'terminal' ? 'terminal' : 'chat') : (this.settings.get('session.defaultMode') || 'chat'));
      const hostId = live?.host || undefined;
      const winBounds = win ? this._snapshotWinBounds(this.wm.windows.get(winId)) : undefined;
      // excludeWebuiId: we KILLED this webui id ourselves — resumeSession's
      // "already open in a live window" shortcut must not trust a stale
      // _allSessions entry still carrying it (2.241.0, userN's incident ws
      // ring: kill → exited → the auto-resume create was never sent; on his
      // loop-blocked instance the active-sessions refresh lagged 10-30s, the
      // killed session still matched as "live", and the switch silently
      // ended at _focusExistingSession on the dead window).
      const finish = () => this.resumeSession(backendSessionId, cwd, name, { mode, backend, backendSessionId, accountId: acctVal, hostId, winBounds, excludeWebuiId: live?.webuiId, onCreateResult: persistOnSuccess });
      if (live?.webuiId) {
        // backendSessionId lets the server resolve the session even when the
        // webui id went stale across a restart (2.179.0 — a no-op'd kill here
        // followed by the resume double-wrote the same claude id)
        this.killSession(live.webuiId, backendSessionId);
        // Wait for the ACTUAL exited event, not a fixed delay (2.240.0,
        // userN's incident timeline: a REMOTE session's teardown took ~9s —
        // the old 900ms fire let resume run while the session still lived,
        // where the duplicate-window guard swallowed it silently; the window
        // just died with no restart, twice, before a third attempt landed).
        let done = false;
        const go = () => { if (done) return; done = true; this.ws.offGlobal(onExit); finish(); };
        const onExit = (msg) => {
          if (msg.type === 'exited' && msg.sessionId === live.webuiId) setTimeout(go, 400); // let the CLI flush its transcript
        };
        this.ws.onGlobal(onExit);
        setTimeout(go, 15000); // fallback: a lost exited must not strand the switch
      } else finish();
    };
    // Remote sessions can't take every account: subscriptions never ship to
    // dial devices, and to ssh hosts only with the opt-in setting. The server
    // enforces this at spawn — but offering the pick here was FAIL-LATE (the
    // user confirmed, the session restarted into an error, and the doomed
    // account was already persisted as the on-resume config; 2.188.0 audit).
    const rHostId = live?.host || spec.host || null;
    const rHostName = live?.hostName || rHostId;
    const rTransport = rHostId ? (this.sidebar?._hostsData?.hosts?.find(h => h.id === rHostId)?.transport || 'ssh') : null;
    const shipSubs = !!this.settings.get('accounts.shipSubscriptionToRemote');
    // Same-account link: a named subscription whose email matches the host's
    // own login identity (⟳-baked orgEmail cache) IS that login — pickable;
    // the server maps the spawn onto the host's own login (2.198.0, zero
    // creds ship). Cache empty → stays blocked with the pick-CLI-login hint.
    const hostOwnEmail = rHostId ? String(this._hostOwnUsage?.[rHostId]?.orgEmail || this._hostOwnEmailKnown?.[rHostId] || '').trim().toLowerCase() : '';
    // Cold caches ⇒ probe the host now; the menu rebuilds in place when the
    // answer lands (~1s). Without this, a fresh page disables every named
    // subscription no matter what the host actually holds.
    if (rHostId) this._warmHostAccountCache(rHostId); // TTL-guarded internally; rebuilds the open menu on fresh data
    // Is what this menu is about to claim actually KNOWN? With no verdicts for
    // the host the rows below are legacy guesses — the menu used to render
    // them as definitive disabled rows with no way to tell "genuinely can't
    // run there" from "the probe hasn't answered yet" (and the user picks a
    // worse account off that). Name the state instead.
    // ⚠ gated on the WARM STATE too: a pre-verdict server answers fine but
    // never sends `verdicts`, and a bare "no verdicts" test would pin those
    // instances on "checking…" forever.
    const acctWarm = rHostId ? this._hostAcctWarmState?.[rHostId] : null;
    const verdictsCold = !!rHostId && !this._hostVerdicts?.[rHostId] && (acctWarm === 'pending' || acctWarm === 'error');
    const probeErr = verdictsCold && acctWarm === 'error' ? (this._hostAcctWarmErr?.[rHostId] || t('unreachable')) : null;
    const acctEmailOf = (a) => String(a.email || (String(a.name || '').includes('@') ? a.name : '')).trim().toLowerCase();
    // SERVER-COMPUTED verdicts (B-f531, 2.244.0): evaluateOnHost's answer per
    // account, fetched live by _warmHostAccountCache — the SAME function the
    // spawn path uses, so what this menu promises is what the spawn does.
    // Legacy cache-derived checks below survive only as fallback while the
    // probe is in flight or against a pre-verdict server.
    const vOf = (a) => (rHostId ? this._hostVerdicts?.[rHostId]?.[a.id] : null) || null;
    const hostLinked = (a) => { const v = vOf(a); if (v) return v.usable && v.how === 'host-login'; return !isCodex && !!hostOwnEmail && acctEmailOf(a) === hostOwnEmail; };
    // Per-account login held ON the host (2.199.0) — cached from the last
    // Manage-Agents visit to that machine; the server re-verifies at spawn.
    const hostSubHeld = (a) => { const v = vOf(a); if (v) return v.usable && v.how === 'host-held'; return !isCodex && rHostId && (this._hostSubsKnown?.[rHostId] || []).includes(a.id); };
    const subBlock = (a) => {
      const isSub = isCodex || (a.type || 'api') === 'subscription';
      if (!isSub) return null; // API keys always ship
      const v = vOf(a);
      if (v) { // verdict is authoritative — render it verbatim
        // Belt vs a stale server: an expired oat must not be pickable (the
        // pick kills the session, then the create refuses — window gone)
        if (v.usable) return (v.how === 'oat' && a.oatDaysLeft <= 0)
          ? t('“{name}”’s long-lived token has expired — re-mint it in Manage agents (⋯ → Long-lived token).', { name: a.name })
          : null;
        if (v.reason === 'oat-expired') return t('“{name}”’s long-lived token has expired — re-mint it in Manage agents (⋯ → Long-lived token).', { name: a.name });
        if (v.reason === 'held-identity-mismatch') return t('The login held on {host} for “{name}” actually belongs to {email} — re-run “Log in on host as this account”.', { host: rHostName, name: a.name, email: v.dirEmail || '?' });
        if (v.reason === 'not-on-this-host') {
          // signed in SOMEWHERE — just not on the machine this session runs on
          // (2.244.3, userN: ClaudeLu held on Novita read "never finished
          // signing in" in a CW-H200 session's menu = looked like a broken
          // account)
          const others = (v.otherHosts || []).map((h) => this._hostNamesKnown?.[h] || h).join(', ');
          return t('“{name}” isn’t logged in on {host} — it’s logged in on {others}. Use “Log in on host as this account” for {host} (Manage agents), or run the session on {others}.', { name: a.name, host: rHostName || t('this machine'), others: others || '?' });
        }
        if (v.reason === 'never-signed-in') return t('“{name}” never finished signing in — complete its login in Manage agents first.', { name: a.name });
        if (v.reason === 'dial-no-ship') return t('Subscription logins can’t ship to a paired device — log in on the device, or use an API-key account');
        if (v.reason === 'local-only-mac') return t('This macOS Keychain-backed login stays on this machine. Log in as this account on {host} instead; copying it can invalidate rotating OAuth credentials.', { host: rHostName });
        if (v.reason === 'pool-local-only') return t('Pooled accounts run on this machine only');
        if (v.reason === 'pool-no-target') return t('This pooled account has no target — pick a subscription in Manage agents');
        return t('This stored login can’t ship to {host}. If you’ve logged this account in ON {host}, pick “CLI login @ {host}” above — that uses the host’s own login. (Or enable Settings → “Ship subscription logins to remote hosts”.)', { host: rHostName });
      }
      // ── legacy fallback (probe in flight / old server) ──
      // NEVER-SIGNED-IN sub (2.240.0, userN's inc-msfx2fdt-3rbn): an
      // account added but whose OAuth login was never completed has no
      // usable credentials ANYWHERE — offering it fail-lates at spawn with
      // "subscription not logged in" and poisons the session's on-resume
      // config. Say the real reason instead of the ship explanation.
      if (a.pooled) { // pooled = local-only; loggedIn reads through the symlink
        if (rHostId) return t('Pooled accounts run on this machine only');
        return a.loggedIn ? null : t('This pooled account has no target — pick a subscription in Manage agents');
      }
      // Long-lived token (B-211a): usable anywhere via the secret env channel
      // — locally there ARE no verdicts (vOf needs a host), and remotely this
      // covers the probe-in-flight window. Expired is the one honest refusal.
      if (a.oat) {
        const expired = typeof a.oatDaysLeft === 'number' && a.oatDaysLeft <= 0;
        // valid oat = usable anywhere; expired blocks ONLY where the oat is
        // the actual spawn channel — a LOCALLY logged-in account keeps its
        // dir login (the server drops the dead secret), so it must fall
        // through to the normal ladder instead of a false hard-block
        if (!expired) return null;
        if (!a.loggedIn) return t('“{name}”’s long-lived token has expired — re-mint it in Manage agents (⋯ → Long-lived token).', { name: a.name });
        // logged-in + expired oat → the ordinary rules below tell the truth
      }
      if (!a.loggedIn && !(rHostId && (hostLinked(a) || hostSubHeld(a)))) {
        return t('“{name}” never finished signing in — complete its login in Manage agents first.', { name: a.name });
      }
      if (!rHostId) return null;
      if (hostLinked(a)) return null; // = the host's own login — usable directly
      if (hostSubHeld(a)) return null; // has its own login held ON the host
      if (a.localOnly) return t('This macOS Keychain-backed login stays on this machine. Log in as this account on {host} instead; copying it can invalidate rotating OAuth credentials.', { host: rHostName });
      if (rTransport === 'dial') return t('Subscription logins can’t ship to a paired device — log in on the device, or use an API-key account');
      if (!shipSubs) return t('This stored login can’t ship to {host}. If you’ve logged this account in ON {host}, pick “CLI login @ {host}” above — that uses the host’s own login. (Or enable Settings → “Ship subscription logins to remote hosts”.)', { host: rHostName });
      return null;
    };
    const items = [];
    // Transition state FIRST — before any row whose reason it qualifies.
    if (verdictsCold) {
      const chip = probeErr
        ? hostStateChip('error', { text: t('couldn’t reach {host} — account availability unknown', { host: rHostName }), title: probeErr })
        : hostStateChip('pending', { text: t('checking accounts on {host}…', { host: rHostName }) });
      items.push({ labelHtml: chip.outerHTML, disabled: true,
        title: probeErr ? t('The reasons below are guesses from cached data until the machine answers. Retrying shortly.') : t('Availability below is unconfirmed until the machine answers.') });
    }
    // 'subscription' = accounts.resolveForSpawn's force-the-CLI's-own-login
    // sentinel (a bare '' would fall through to the default account). For a
    // remote session that login lives on the HOST — say so.
    // Per-row usage PREVIEW (2.245.1; scoped buckets + water-level colors
    // 2.245.2, user request): remaining quota + data age inline in the
    // switcher, same per-row source rule as the Agents overview (host-login →
    // machine quota, host-held → hostAccounts cache, else the local passive
    // cache). Rendered via showContextMenu's OPT-IN labelHtml — every
    // interpolated string below is escHtml'd (labelHtml contract); the
    // percentage spans carry the same >95 red / >80 amber / green scheme as
    // the roster donuts.
    const pctOf = (x) => (x == null ? null : Math.min(100, Math.round(x.usedPercent ?? ((x.utilization || 0) * 100))));
    const wlColor = (p) => (p > 95 ? 'var(--red,#e55)' : p > 80 ? 'var(--yellow,#e5c07b)' : 'var(--green,#3fb950)');
    const pctHtml = (p) => (p == null ? '?' : `<span class="bsw-pct" style="color:${wlColor(p)}">${p}%</span>`);
    // STABLE ROW LAYOUT (2.258.0, real report '布局不稳定/空白很多'): the old
    // flat `name — 5h 11% · 7d …` string wrapped at arbitrary points in an
    // auto-width menu. Rows are now two flex parts — `.bsw-name` (flex:1,
    // ellipsized, suffix dim) + `.bsw-usage` (nowrap fixed cluster, tabular
    // numbers) — and `.context-menu:has(.bsw-usage)` pins the menu width, so
    // every row renders on ONE line with the usage column right-aligned.
    const usageHint = (u, est) => {
      if (!u && !est) return '';
      u = u || {};
      // Dead-reckoned CURRENT view (B-b87b: this menu showed the raw cached
      // reading while every other surface — popup/taskbar/roster — shows the
      // estimate; a stale reading here contradicted them and mis-informed the
      // exact decision this menu exists for). estDisplayPair = the shared
      // roll-aware discriminator; an estimated value renders dash-underlined.
      const eff = (raw, e) => {
        const pair = estDisplayPair(raw, e);
        if (pair.estPct != null) return { p: pair.estPct, est: true };
        const p = pctOf(raw);
        return p == null ? null : { p, est: false };
      };
      const f = eff(u.fiveHour, est?.fiveHour), s7 = eff(u.sevenDay, est?.sevenDay);
      // Scoped buckets (e.g. the Fable weekly cap) — same 2-char short label
      // as the roster donuts ('Fa 41%').
      const scoped = (u.scopedWeekly || []).map((sc) => {
        const e = (est?.scopedWeekly || []).find((x) => String(x?.name || '').toLowerCase() === String(sc?.name || '').toLowerCase());
        return [String(sc.name || '?').slice(0, 2), eff(sc, e)];
      }).filter(([, v]) => v != null);
      if (f == null && s7 == null && !scoped.length) return '';
      const age = u.fetchedAt ? Math.round((Date.now() - u.fetchedAt) / 60000) : null;
      const ageTxt = age != null && age > 5 ? escHtml(age < 100 ? t('{n}m', { n: age }) : t('{n}h', { n: Math.round(age / 60) })) : '';
      const seg = (k, v) => (v == null ? '' : `<span class="bsw-seg${v.est ? ' bsw-est' : ''}"><span class="bsw-k">${escHtml(k)}</span>${pctHtml(v.p)}</span>`);
      return `<span class="bsw-usage">${seg('5h', f)}${seg('7d', s7)}${scoped.map(([l, v]) => seg(l, v)).join('')}${ageTxt ? `<span class="bsw-age">${ageTxt}</span>` : ''}</span>`;
    };
    const rowHtml = (nameText, subText, usage) =>
      `<span class="bsw-name">${escHtml(nameText)}${subText ? `<span class="bsw-sub">${escHtml(subText)}</span>` : ''}</span>` + (usage || '');
    const usageFor = (a) => {
      const v = vOf(a);
      if (rHostId && v?.usable && v.how === 'host-login') return this._hostOwnUsage?.[rHostId];
      if (rHostId && v?.usable && v.how === 'host-held') return this._hostAccountUsage?.[`${rHostId}:${a.id}`];
      // codex accounts carry their own persisted quota buckets (/api/usage
      // codexAccounts, 2.368.18) — the switcher rows were blind to them
      if ((a.backend || 'claude') === 'codex') return this._codexAccountUsage?.[a.id];
      return this._accountUsage?.[a.id];
    };
    // Codex sessions bill the machine's ChatGPT login, not the claude CLI's —
    // the old backend-agnostic label ("CLI login") plus the CLAUDE global
    // quota chips below made a codex session's account row read as the claude
    // CLI login (owner report, 2.368.16).
    const globalLoginName = isCodex ? t('ChatGPT login') : t('CLI login');
    const cliLabel = rHostId ? globalLoginName + ' @ ' + rHostName : globalLoginName;
    // apiKeyHelper honesty (2.191.0, CW-H200): when the CLI itself reported
    // apiKeySource=apiKeyHelper, "CLI login" IS the helper's API key — the
    // machine's OAuth login is overridden by the CLI's own precedence, and no
    // switcher pick can change that. Say so instead of leaving a menu that
    // looks like it should work but "does nothing".
    const helperActive = live?.auth?.source === 'api-other' && live?.auth?.detail === 'apiKeyHelper';
    items.push({
      // labelHtml contract: every text part escHtml'd inside rowHtml; only the
      // usage spans carry markup (see utils.showContextMenu).
      labelHtml: rowHtml((currentId === null ? '✓ ' : '') + cliLabel, helperActive ? ' · apiKeyHelper (API)' : '',
        // the machine usage caches are the CLAUDE login's quota — attaching
        // them to a codex row dressed the ChatGPT login in claude percentages
        isCodex ? (rHostId ? '' : usageHint(this._codexAccountUsage?.__global_codex__, this._usageEstimates?.__global_codex__)) : usageHint(rHostId ? this._hostOwnUsage?.[rHostId] : this._rateLimit, rHostId ? null : this._usageEstimates?.__global__)),
      action: () => { if (currentId !== null) doSwitch('subscription', cliLabel); },
    });
    if (helperActive) {
      items.push({ label: t('Why API billing? apiKeyHelper is set on the machine'), disabled: true,
        title: t('The CLI prefers a configured apiKeyHelper over the machine\u2019s own OAuth login. Picking a NAMED subscription account below bypasses the helper for that session (the helper is neutralized at spawn); this CLI-login entry keeps billing via the helper.') });
    }
    for (const a of accts) {
      const cur = currentId === a.id;
      // Pooled pseudo-accounts are neither API keys nor plain subscriptions
      // (user report: the switcher tagged the pool '· API'): the row names
      // the CURRENT TARGET, and remote sessions can't use a pool at all
      // (local symlink mechanics — the server refuses the spawn too).
      if (a.pooled) {
        const sfx = a.currentName ? ` → ${a.currentName}` : ' ' + t('· pool');
        if (rHostId) { items.push({ label: a.name + sfx, disabled: true, title: t('Pooled accounts are local-only (the pool switches a credentials directory on THIS machine)') }); continue; }
        const estP = a.current ? (this._usageEstimates?.[a.current] || (this._usageGlobal?.accountId === a.current ? this._usageEstimates?.__global__ : null)) : null;
        items.push({ labelHtml: rowHtml((cur ? '✓ ' : '') + a.name, sfx, usageHint(a.current ? this._accountUsage?.[a.current] : null, estP)), action: () => { if (!cur) doSwitch(a.id, a.name); } });
        continue;
      }
      const linked = rHostId && hostLinked(a) && (isCodex || (a.type || 'api') === 'subscription');
      const held = !linked && rHostId && hostSubHeld(a) && (a.type || 'api') === 'subscription';
      const suffix = (!isCodex && (a.type || 'api') !== 'subscription') ? ' · API'
        : linked ? ' ' + t('· is {host}’s machine login (same account)', { host: rHostName })
        : held ? ' ' + t('· own login held on {host}', { host: rHostName }) : '';
      let block = subBlock(a);
      // A reason derived from the LEGACY fallback (no verdict for this host
      // yet) is a guess — say so in the tooltip rather than let a cold cache
      // speak with the server's authority.
      if (block && verdictsCold) block += ' ' + t('(unconfirmed — {host} hasn’t answered the availability check yet)', { host: rHostName });
      if (block && !cur) { items.push({ label: a.name + suffix, disabled: true, title: block }); continue; }
      // LINKED pick sends the REAL account id (2.241.0): the server's
      // email-linked rescue (ws-handler create, 2.240.2) maps it onto the
      // host's own login — zero creds ship — while session._accountId keeps
      // the picked identity, so the badge and this menu's ✓ show the account
      // instead of "CLI login @ host" (userN's sixth incident: a successful
      // linked switch READ as failed because the identity degraded to the
      // sentinel). The old client-side sentinel mapping predates the rescue.
      // estimates key on the LOCAL passive-cache identity — host-login /
      // host-held rows read a host-side cache no local estimator covers
      const estA = rHostId ? null
        : (this._usageEstimates?.[a.id] || (this._usageGlobal?.accountId === a.id ? this._usageEstimates?.__global__ : null));
      items.push({ labelHtml: rowHtml((cur ? '✓ ' : '') + a.name, suffix, usageHint(usageFor(a), estA)), action: () => { if (!cur) doSwitch(a.id, a.name); } });
    }
    let menuEl;
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      menuEl = showContextMenu(r.left, r.bottom + 4, items);
    } else {
      menuEl = showContextMenu(anchor?.x || 40, anchor?.y || 40, items);
    }
    this._billingMenu = { el: menuEl, host: rHostId, args: [winId, anchor] };
  },

  // Clicking Fork opens a popup for the first message. The fork only diverges
  // into its own session once that message is sent (the backend mints the
  // fork's new id on first input), so prompting up front gives the user an
  // immediately-distinct session instead of a window indistinguishable from a
  // resume. Terminal-mode forks have no chat input, so they fork directly.
  forkSession(sessionInfo) {
    const mode = sessionInfo.webuiMode || this.settings.get('session.defaultMode') || 'chat';
    if (mode !== 'chat') { this._doForkSession(sessionInfo, ''); return; }
    this._openForkDialog(sessionInfo, null);
  },

  // Fork from a specific assistant message (chat fork button). Passes the
  // message uuid as the truncation point (--resume-session-at) so the branch
  // contains the conversation only up to that message.
  forkFromMessage(sessionInfo, messageUuid) {
    this._openForkDialog(sessionInfo, messageUuid || null);
  },

  _openForkDialog(sessionInfo, forkAtUuid) {
    this._pendingFork = sessionInfo;
    this._pendingForkAt = forkAtUuid;
    if (this.isMobile) this.sidebar.toggle(false);
    this._showDialog('dialog-fork');
    // Swap the hint depending on whole-session vs from-a-point fork
    const genHint = document.getElementById('fork-hint-general');
    const atHint = document.getElementById('fork-hint-at');
    if (genHint) genHint.classList.toggle('hidden', !!forkAtUuid);
    if (atHint) atHint.classList.toggle('hidden', !forkAtUuid);
    const titleInput = document.getElementById('fork-title');
    if (titleInput) titleInput.value = this._defaultForkName(sessionInfo); // editable default
    const ta = document.getElementById('fork-first-message');
    const btn = document.getElementById('btn-fork-send');
    if (ta) { ta.value = ''; }
    if (btn) { btn.disabled = true; }
    if (ta) setTimeout(() => ta.focus(), 0);
  },

  // Programmatically send a chat message to a live chat session (used for the
  // fork first-message popup). The server echoes it back via the normalizer, so
  // the ChatView renders it without any local preview.
  _sendChatMessage(sessionId, text) {
    const t = (text || '').trim();
    if (!t) return;
    this.ws.send({ type: 'chat-input', sessionId, text: t, msgId: Date.now() + '-' + Math.random().toString(36).slice(2, 8) });
  },

  // Default fork title: "<base> (forked)" with a numeric suffix to stay unique.
  _defaultForkName(sessionInfo) {
    const baseName = sessionInfo.webuiName || sessionInfo.name || 'Session';
    const allNames = (this.sidebar._allSessions || []).map(s => s.webuiName || s.name || '');
    let forkName = `${baseName} (forked)`;
    let n = 2;
    while (allNames.includes(forkName)) { forkName = `${baseName} (forked ${n++})`; }
    return forkName;
  },

  async _doForkSession(sessionInfo, initialMessage = '', resumeAt = null, customName = '') {
    const backend = sessionInfo.backend || 'claude';
    const resumeId = sessionInfo.backendSessionId || sessionInfo.sessionId;
    // A fork of an OpenCode conversation is MINTED through the background
    // service (POST /session/:id/fork) — unlike a resume it genuinely cannot
    // work without it, so this one waits for the offer and only then spawns.
    try { await this.maybeOfferHarnessService?.(backend, { needsService: true }); } catch {}
    const forkName = (customName && customName.trim()) || this._defaultForkName(sessionInfo);

    const mode = sessionInfo.webuiMode || this.settings.get('session.defaultMode') || 'chat';
    // --resume-session-at <uuid> truncates the fork to up-to-and-including that
    // assistant message (claude-only). uuid has no spaces, so it tokenizes
    // cleanly inside the extraArgs string.
    const forkArgs = backend === 'claude'
      ? ('--fork-session' + (resumeAt ? ` --resume-session-at ${resumeAt}` : ''))
      : '';
    this.createSession({
      cwd: sessionInfo.cwd,
      name: forkName,
      resumeId,
      mode,
      backend,
      backendSessionId: resumeId,
      fork: true,
      // remote sessions fork ON their host — omitting this spawned a LOCAL
      // `claude --resume <remote-id> --fork-session` against a transcript
      // that doesn't exist here (audit 2.192.0)
      hostId: sessionInfo.host || sessionInfo.hostId || undefined,
      extraArgs: forkArgs,
      initialMessage,
      forkAtUuid: resumeAt || undefined,
      forkTitle: forkName,
    });
  },

  // Open a stopped session as view-only (load JSONL, no claude --resume)
  viewSession(sessionId, cwd, sessionName, { syncId, backend = 'claude', backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId, hostId, offerService = true } = {}) {
    cwd = stripCwdHostLabel(cwd);
    this._closeSidebarOnMobile();
    this._hideWelcome();
    const resolvedSessionId = backendSessionId || sessionId;
    const viewId = backend === 'claude' ? `view-${resolvedSessionId}` : `view-${backend}-${resolvedSessionId}`;
    const openSpec = {
      action: 'viewSession',
      sessionId,
      backend,
      backendSessionId: resolvedSessionId,
      sessionKey: `${backend}:${resolvedSessionId}`,
      agentKind: agentKind || 'primary',
      agentRole: agentRole || '',
      agentNickname: agentNickname || '',
      sourceKind: sourceKind || '',
      parentThreadId: parentThreadId || null,
      hostId: hostId || undefined,
      cwd,
      name: sessionName,
    };
    const winInfo = this.wm.createWindow({
      title: `${sessionName || t('History')} — ${cwd}`,
      type: 'chat',
      syncId,
      openSpec,
      titleMeta: this._buildTitleMeta(openSpec),
    });
    this._viewIntoWindow(winInfo, { backend, backendSessionId: resolvedSessionId, cwd, name: sessionName, hostId,
      // A sub-agent's own conversation (claude Task viewer, codex collab child
      // thread) is read-only by NATURE, not by death — no Resume bar.
      subagentView: (agentKind || 'primary') === 'subagent' || sourceKind === 'subagent' });
    // Reading a STOPPED conversation is exactly what the opt-in background
    // service exists for: offer it (once) while the read-only attach runs, and
    // when it is enabled re-open this window against the now-live store — the
    // pending action continues instead of leaving an error pane behind.
    if (offerService) try {
      Promise.resolve(this.maybeOfferHarnessService?.(backend, {
        needsService: true,
        retry: () => {
          if (!this.wm.windows.has(winInfo.id)) return;
          // keep the window where it was (geometry AND desktop) — the same
          // rule createSession's winBounds follows, or the reopened history
          // "moves" to whatever desktop happens to be active (2.295.0 class)
          const bounds = this._snapshotWinBounds?.(this.wm.windows.get(winInfo.id));
          this.wm.closeWindow(winInfo.id);
          const again = this.viewSession(sessionId, cwd, sessionName, { syncId, backend, backendSessionId, agentKind, agentRole, agentNickname, sourceKind, parentThreadId, hostId, offerService: false });
          if (!again) return;
          if (bounds?.gridBounds) { again.gridBounds = { ...bounds.gridBounds }; this.wm._applyGridBounds(again); }
          const dm = this.desktopManager, home = bounds?.desktopId;
          if (home && home !== '__stage__' && home !== again._desktopId && (dm?._desktops || []).some((d) => d.id === home)) {
            try { dm.moveWindowToDesktop(again.id, home); } catch {}
          }
        },
      })).catch(() => {});
    } catch {}
    return winInfo;
  },

  // Drive the view-only pipeline into an EXISTING window: build a read-only
  // ChatView, request the viewOnly attach (server loads the JSONL — local
  // transcript or the host-less remote-jsonl cache scan; stale cache beats no
  // history, so it works with the session's host machine down), render on
  // 'attached'. Shared by viewSession and attachSession's dead-session rescue
  // (the blank-window class: a stale serverId replayed after the server lost
  // its sessions used to leave a bare shell with no ChatView at all).
  _viewIntoWindow(winInfo, { backend = 'claude', backendSessionId, cwd, name, hostId, subagentView = false } = {}) {
    const viewId = backend === 'claude' ? `view-${backendSessionId}` : `view-${backend}-${backendSessionId}`;
    const chatView = new ChatView(winInfo, this.ws, viewId, this, { readOnly: true, subagentView });
    this.sessions.set(winInfo.id, chatView);
    const hostName = this._hostLabel(hostId);
    // For a REMOTE session the server first pulls the transcript over ssh
    // (seconds, up to the 15s ssh budget) — the pane used to be BLANK for all
    // of it, and read-only windows are skipped by the reconnect re-attach
    // ladder, so a lost reply left it blank FOREVER with no error and no
    // retry: indistinguishable from an empty conversation.
    const loadingEl = chatView._renderers.appendSystem(hostName
      ? t('Loading history from {host}…', { host: hostName })
      : t('Loading history…'));

    // ws.request (not a bare send + onGlobal): the view-only attach is
    // idempotent, so it can be RE-SENT after a reconnect — a server restart
    // between request and reply is exactly the documented blank-shell class.
    this.ws.request({
      type: 'attach',
      sessionId: viewId,
      viewOnly: true,
      backend,
      backendSessionId,
      claudeSessionId: backend === 'claude' ? backendSessionId : undefined,
      host: hostId || undefined, // remote session: server pulls the transcript over ssh first
      cwd,
      name,
    }, (msg) => {
      if (msg.type === 'error' && msg.sessionId === viewId) {
        loadingEl?.remove();
        chatView._renderers.appendSystem(msg.message || t('Session not found.'));
        return true;
      }
      if (msg.type === 'attached' && msg.sessionId === viewId) {
        loadingEl?.remove();
        if (msg.messages?.length) {
          chatView.loadHistory(msg.messages, msg.totalCount, false, { chatStatus: msg.chatStatus });
        } else {
          // Zero messages (empty/aborted transcript, or a brand-new session
          // whose JSONL hasn't flushed yet) — say so instead of a silent blank
          // pane (blank windows read as bugs; real user report).
          chatView._renderers.appendSystem(t("No messages in this session's transcript yet."));
        }
        return true;
      }
      return false;
    }, {
      // Window closed before 'attached' — the request self-cleans so a stale
      // fire can't call loadHistory on a disposed ChatView (which throws
      // mid-dispatch and swallows every later handler's message).
      isAlive: () => this.wm.windows.has(winInfo.id),
      timeoutMs: 20000,
      onTimeout: () => {
        try { track('event', 'ws-reply-timeout:view', viewId); } catch { }
        // Rewrite the inner .chat-system node, never the wrapper's textContent
        // (that would flatten appendSystem's structure).
        const inner = loadingEl?.isConnected ? loadingEl.querySelector('.chat-system') : null;
        if (inner) inner.textContent = hostName
          ? t('Still loading — {host} may be slow to hand over the transcript.', { host: hostName })
          : t('Still loading the transcript…');
      },
      resend: true,
    });
    winInfo.onClose = () => { chatView.dispose(); this.sessions.delete(winInfo.id); this._checkWelcome(); };
    winInfo._notifyChanged = () => this.updateTaskbar();
    return chatView;
  },

  // Replay a serialized openSpec to recreate a window (cross-client sync,
  // layout restore, desktop switch, stage). Dispatch lives in the WINDOW-TYPE
  // REGISTRY (window-types.js, Plugin Ph1): every window kind registers its
  // replay in the module that owns it; an unknown action is LOUD there
  // (console.warn + 'openspec-unknown' telemetry) — the switch this replaced
  // had no default, so a spec nobody could replay vanished silently.
  replayOpenSpec(spec, syncId) {
    return replayOpenSpecViaRegistry(this, spec, { syncId });
  },
  });
}

// ── WINDOW-TYPE REGISTRATIONS (Plugin Ph1): the session window kinds ──
// chat/terminal restore by SESSION IDENTITY, not by spec (persist:false —
// layout.js's former TRANSIENT_WINDOW_TYPES): their openSpec arrives async
// after 'created'. The replay bodies are the former replayOpenSpec switch
// cases, verbatim (`this` → `app`).
function replayAttachSession(app, spec, { syncId } = {}) {
  // The saved serverId/name may be STALE — the dtach instance dies and
  // gets resumed under a new server id while the spec persists in the
  // autosave (and the name was captured at window creation, before any
  // rename). Re-resolve against the live session list like restoreState
  // does; a spec replayed verbatim attaches to a nonexistent session and
  // leaves a blank window that re-persists the stale spec forever.
  const backend = spec.backend || 'claude';
  // A bsid equal to the serverId is POLLUTION from pre-2.105.2 specs
  // (the webui id was baked in before the CLI reported a real id —
  // long window on remote spawns): treat it as no bsid, or the
  // re-resolution below misses on it and opens a bogus view-only
  // window (real report: remote-host session blank on other clients).
  const bsid = (spec.backendSessionId && spec.backendSessionId !== spec.serverId)
    ? spec.backendSessionId : null;
  const live = app.sidebar?._webuiSessions || [];
  let serverId = spec.serverId;
  let name = spec.name;
  let cwd = spec.cwd;
  if (bsid && !live.some(s => s.id === serverId)) {
    const alive = live.find(s => (s.backend || 'claude') === backend
      && (s.backendSessionId || s.claudeSessionId) === bsid);
    if (alive) {
      serverId = alive.id;
      name = alive.name || name;
      cwd = alive.cwd || cwd;
    } else if (live.length && !serverId) {
      // Session is dead — open read-only history with a Resume bar
      // instead of a blank window stuck on a failed attach. Only when
      // there is NO serverId to try: a serverId the local list doesn't
      // know yet is usually a RACE (layout-sync beat the active-sessions
      // push for a just-created session) — attach directly and let the
      // server be authoritative; a genuinely dead session's attach
      // errors into the read-only path anyway.
      return app.viewSession(bsid, cwd, app.sidebar?.getCustomName(spec.sessionKey || bsid) || name, {
        syncId, backend, backendSessionId: bsid, hostId: spec.hostId || spec.host || undefined,
        agentKind: spec.agentKind, agentRole: spec.agentRole,
        agentNickname: spec.agentNickname, sourceKind: spec.sourceKind,
        parentThreadId: spec.parentThreadId,
        offerService: false, // a layout REPLAY is not the user reaching for OpenCode history — never pop the first-use dialog on boot
      });
    }
  }
  if (bsid) name = app.sidebar?.getCustomName(spec.sessionKey || bsid) || name;
  return app.attachSession(serverId, name, cwd, {
    mode: spec.mode,
    syncId,
    backend,
    backendSessionId: bsid,
    hostId: spec.hostId || spec.host || undefined,
    agentKind: spec.agentKind,
    agentRole: spec.agentRole,
    agentNickname: spec.agentNickname,
    sourceKind: spec.sourceKind,
    parentThreadId: spec.parentThreadId,
  });
}

function replayViewSession(app, spec, { syncId } = {}) {
  return app.viewSession(spec.sessionId, spec.cwd, spec.name, {
    hostId: spec.hostId || spec.host || undefined,
    syncId,
    backend: spec.backend || 'claude',
    backendSessionId: spec.backendSessionId || spec.sessionId,
    agentKind: spec.agentKind,
    agentRole: spec.agentRole,
    agentNickname: spec.agentNickname,
    sourceKind: spec.sourceKind,
    parentThreadId: spec.parentThreadId,
    offerService: false, // layout restore / cross-client replay — not a user action, so no first-use dialog on boot
  });
}

function replayViewSubagent(app, spec, { syncId } = {}) {
  const title = t('Agent: {desc}', { desc: spec.description || t('Subagent') });
  const winInfo = app.wm.createWindow({
    title,
    type: 'chat',
    syncId,
    openSpec: spec,
    titleMeta: app._buildTitleMeta({
      backend: spec.backend || 'claude',
      agentKind: spec.agentKind || 'subagent',
      agentRole: spec.agentRole,
      agentNickname: spec.agentNickname,
      sourceKind: spec.sourceKind,
      parentThreadId: spec.parentThreadId,
    }),
  });
  const view = new ChatView(winInfo, app.ws, spec.virtualId, app, { readOnly: true });
  app.sessions.set(winInfo.id, view);
  app.ws.send({
    type: 'attach',
    sessionId: spec.virtualId,
    parentSessionId: spec.parentSessionId,
    backend: spec.backend || 'claude',
    backendSessionId: spec.backendSessionId || spec.claudeSessionId,
    claudeSessionId: spec.claudeSessionId,
    cwd: spec.cwd,
    hostId: spec.hostId || spec.host || undefined, // remote workflow agent → transcript on the host (2.191.0)
  });
  const handler = (msg) => {
    if (!app.wm.windows.has(winInfo.id)) { app.ws.offGlobal(handler); return; }
    if (msg.type === 'error' && msg.sessionId === spec.virtualId) { app.ws.offGlobal(handler); return; }
    if (msg.type === 'attached' && msg.sessionId === spec.virtualId) {
      app.ws.offGlobal(handler);
      if (msg.messages?.length) view.loadHistory(msg.messages, msg.totalCount, msg.isStreaming);
    }
  };
  app.ws.onGlobal(handler);
  winInfo.onClose = () => { app.ws.offGlobal(handler); view.dispose(); app.sessions.delete(winInfo.id); app._checkWelcome(); };
  return winInfo;
}

registerWindowType({
  type: 'terminal', label: 'Terminal', persist: false,
  icon: svgIcon16('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 7l2 2-2 2M8.5 11h3"/>'),
  action: 'attachTmuxSession', replay: (app, spec) => app.attachTmuxSession(spec.tmuxTarget, spec.name, spec.cwd),
});
registerWindowType({
  type: 'chat', label: 'Chat', persist: false,
  icon: svgIcon16('<path d="M2 3a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H6l-4 3V3z"/>'),
  // attachSession opens a chat OR terminal window by spec.mode — registered on its home kind.
  actions: { attachSession: replayAttachSession, viewSession: replayViewSession, viewSubagent: replayViewSubagent },
});
