'use strict';
// ONE delivery ladder for "get a message into a conversation" (2.362.0,
// B-274d/B-dfd2) — extracted from jobs-wiring so background-job notifications
// and agent-to-agent messages ride the SAME implementation (CS law: transport
// is selected inside, callers never branch). Rungs, in order:
//   0. VibeSpace channel socket (EXPERIMENTAL, agents.vibespaceChannel)
//   1. LOCAL CLI inbox — scan this machine's ~/.claude/sessions registry
//   2. REMOTE machine — conversation-index names the owner host; that host's
//      agentd runs the SAME findPeer+postToPeer against ITS registry via the
//      'peer-post' device op (capability-gated; daemon-first doctrine — no
//      ssh-script twin: any host we deliver to can run the daemon)
//   3. STASH — durable per-conversation queue (data/msg-stash.json), drained
//      into the conversation's next context injection. Machine-agnostic by
//      construction: remote sessions' hooks already call back to this hub.
// Envelope is CHANNEL-READY (owner direction 2026-08-20): every stashed entry
// carries {source, fromName, text, ts} — 'agent' today; Gmail/Lark/Slack
// connectors later feed the same ladder with their own source tags.
const fs = require('fs');
const path = require('path');
const { capsOf } = require('../backend-caps.js');
const { wrapperCaps } = require('./wrapper-files.js');

const STASH_CAP = 30; // per-conversation; oldest fall off

// THE SPEND CEILING ON THIS LADDER (design-account-hardening §4.4c / P9).
// Rungs 0-2 all put a message into a LIVE agent session: when that session is
// idle the CLI opens a BILLED TURN for it, exactly as if somebody had typed.
// Nine conversations can be parked on one subscription, so the jobs engine's
// 30s-per-conversation flood floor bounds pacing and nothing else.
// A REFUSAL HERE LOSES NOTHING: the caller stashes (rung 3) and the message is
// injected into the conversation's next context — the same words, riding a turn
// that was going to happen anyway. That is why this gate is safe to fail
// CLOSED and why its refusal is not a dropped promise.
// WHO PAYS, when the ladder cannot see a live local session: a REMOTE
// conversation bills that machine's own binding, which this server genuinely
// cannot name. It is charged to a NAMED bucket (`host:<id>` / `unattributed`)
// rather than guessed at or waved through — the instance/day ceiling still
// applies to it, and the name says what we do not know.
function create({ dataDir, peerMsg, getHosts, getConvIndex, serverSetting, activeSessions, emitPeerCard, authorizeSpend = null, noteSpend = null, log = () => { } }) {
  const stashFile = path.join(dataDir, 'msg-stash.json');
  let stash = {};
  try { stash = JSON.parse(fs.readFileSync(stashFile, 'utf-8')) || {}; } catch { }
  let stashTimer = null;
  const writeStashNow = () => {
    try { fs.writeFileSync(stashFile + '.tmp', JSON.stringify(stash)); fs.renameSync(stashFile + '.tmp', stashFile); } catch (e) { log('[deliver] stash persist failed:', e.message); }
  };
  const persistStash = () => {
    if (stashTimer) return;
    stashTimer = setTimeout(() => { stashTimer = null; writeStashNow(); }, 500);
  };
  // SIGTERM/SIGINT belt (review-caught): a debounced-only write loses a
  // just-stashed "queued" promise on the ROUTINE restart path — same law as
  // every other data/*.json store.
  const flush = () => { if (stashTimer) { clearTimeout(stashTimer); stashTimer = null; } writeStashNow(); };

  function stashFor(cid, envelope) {
    const q = stash[cid] || (stash[cid] = []);
    q.push({ source: envelope.source || 'agent', fromName: envelope.fromName || null, text: String(envelope.text || ''), ts: Date.now() });
    if (q.length > STASH_CAP) q.splice(0, q.length - STASH_CAP);
    persistStash();
  }
  function drainStash(cid) {
    const q = stash[cid] || [];
    if (q.length) { delete stash[cid]; persistStash(); }
    return q;
  }
  function stashCount(cid) { return (stash[cid] || []).length; }

  // rung 1.5 helper: a LIVE local chat session whose backend declares the
  // 'rpc-queue' peer-delivery lane AND whose wrapper adverts caps.peerMessage
  // in its own sidecar (capability law: gate on what the process wrote, never
  // on version guesses; negative verdicts are never cached — this is a fresh
  // stateless read per attempt).
  function findRpcPeer(cid) {
    if (!activeSessions) return null;
    try {
      for (const [wid, s] of activeSessions) {
        if ((s.backendSessionId || s.claudeSessionId) !== cid) continue;
        if (s.mode !== 'chat' || !s.pty || s.host) continue;
        if (capsOf(s.backend).peerDelivery !== 'rpc-queue') continue;
        if (!wrapperCaps(path.join(dataDir, 'session-buffers'), wid, s.socketPath).peerMessage) continue;
        return { wid, s };
      }
    } catch { }
    return null;
  }

  // rung 2 helper: which registered machine owns this conversation? null =
  // local/unknown (the local rung already ran by the time this is asked).
  function ownerHostOf(cid) {
    try {
      const hosts = getHosts?.();
      const idx = getConvIndex?.();
      if (!hosts || !idx) return null;
      const hid = idx.ownerHost(cid, (id) => { try { return !!hosts.get(id); } catch { return false; } });
      return hid && hid !== 'local' ? hid : null;
    } catch { return null; }
  }

  /** The LIVE LOCAL session carrying this conversation, if any — the only
   *  thing on this machine that can name the credential slot a turn would
   *  bill. (findRpcPeer answers a narrower question: a codex session whose
   *  wrapper adverts the peer lane.) */
  function localSessionFor(cid) {
    if (!activeSessions) return null;
    try {
      for (const [, s] of activeSessions) if ((s.backendSessionId || s.claudeSessionId) === cid) return s;
    } catch { }
    return null;
  }

  /** One delivery attempt down the ladder. Returns {ok, lane, kind, peerName?,
   *  hostId?, reason?} — the caller decides whether a miss stashes (jobs and
   *  agent-msg both do; a future fire-and-forget source may not).
   *  opts.fromName/opts.cardText label the CHAT CARD the server renders on a
   *  successful post (2.363.0): the CLI records server-posted injections with
   *  a body-less origin (unregistered poster), so the delivery site is the
   *  ONLY party that can render the message visibly in the live window.
   *  opts.kind TYPES THE ORIGIN (2026-09-07, owner: "系统通知默认应该是steering的"):
   *    'notification' — VibeSpace itself speaking: a Background Work event, a
   *                     system notice. Nobody is waiting for a reply, so on a
   *                     harness whose notification lane is 'steer'
   *                     (backend-caps notificationDelivery) it joins the
   *                     RUNNING turn instead of becoming its own billed one.
   *    'peer'         — a human/agent message from another session (default):
   *                     it is somebody's message, it gets its own turn.
   *  The ladder only TAGS the frame — the receiving wrapper owns the lane
   *  decision, because only it knows whether a turn is running right now. */
  async function deliverToConversation(cid, text, opts = {}) {
    // Unknown/absent origin = 'peer', the conservative lane (an older caller
    // never silently gains the steer behaviour).
    const kind = opts.kind === 'notification' ? 'notification' : 'peer';
    // THE CEILING (see the header). `spendReason` types the producer for the
    // budget's journal/inbox; jobs pass 'job-notification', agent messaging
    // 'peer-message'. An unknown/absent reason is 'peer-message', the same
    // conservative default the lane itself uses.
    const spendReason = opts.spendReason && typeof opts.spendReason === 'string' ? opts.spendReason : 'peer-message';
    let charged = null;
    if (authorizeSpend) {
      const session = localSessionFor(cid);
      // the owner-host lookup is only needed for the NAMED fallback bucket —
      // a live local session answers the question by itself
      const hid0 = session ? null : ownerHostOf(cid);
      const identity = session ? null : { key: hid0 ? 'host:' + hid0 : '__unattributed__', name: hid0 ? `conversation on ${hid0}` : 'unattributed conversation' };
      let v = null;
      try { v = authorizeSpend({ reason: spendReason, session, identity, cid }); }
      catch (e) { log('[deliver] spend authorizer threw (refusing, the stash keeps the message):', e.message); return { ok: false, reason: 'spend authorizer failed: ' + e.message, refused: 'spend' }; } // FAIL CLOSED (P8)
      if (v && v.ok === false) return { ok: false, reason: `spend budget: ${v.detail || v.why}`, refused: 'spend', why: v.why, retryAfter: v.retryAfter || 0 };
      charged = { reason: spendReason, session, identity };
    }
    // CHARGED WHERE THE FRAME LEAVES US. For rungs 0/1/2 that is the delivery;
    // for the rpc-queue rung the wrapper may still answer `ok:false` and the
    // caller re-stashes, so that one over-charges by one turn in the failure
    // case. Deliberate: the conservative direction for money is to assume the
    // turn happened, and the alternative (charging on the wrapper's reply)
    // would need a correlation this lane does not carry.
    const spent = () => { if (charged && noteSpend) { try { noteSpend(charged); } catch (e) { log('[deliver] spend accounting failed:', e.message); } } };
    const cardOk = () => { try { emitPeerCard?.(cid, { fromName: opts.fromName || null, text: opts.cardText || text }); } catch (e) { log('[deliver] card emit failed:', e.message); } };
    // rung 0: VibeSpace channel socket (experimental, per-session opt-in)
    try {
      if (serverSetting?.('agents.vibespaceChannel') === true && activeSessions) {
        for (const [wid, s] of activeSessions) {
          if ((s.backendSessionId || s.claudeSessionId) !== cid) continue;
          const sock = path.join(dataDir, 'channel-socks', wid + '.sock');
          if (!fs.existsSync(sock)) continue;
          const rc = await peerMsg.postChannelEvent(sock, text, { kind: 'peer_message' });
          if (rc.ok) { spent(); cardOk(); return { ok: true, lane: 'channel', kind, peerName: s.name || null }; }
        }
      }
    } catch (e) { log('[deliver] channel lane failed (falling through):', e.message); }
    // rung 1: this machine's CLI inbox registry
    try {
      const peer = peerMsg.findPeer(cid);
      if (peer) {
        const r = await peerMsg.postToPeer(peer, text);
        if (r.ok) { spent(); cardOk(); return { ok: true, lane: 'message', kind, peerName: peer.name || null }; }
        log(`[deliver] local peer post to ${peer.socketPath} failed: ${r.reason}`);
        return { ok: false, lane: 'message', reason: r.reason };
      }
    } catch (e) { return { ok: false, reason: e.message }; }
    // rung 1.5: backend-declared RPC lane (REGISTRY-gated: capsOf(backend)
    // .peerDelivery === 'rpc-queue', never a backend-id branch — a third
    // backend claims this lane by declaring the cap + serving the contract).
    // The wrapper owns the app-server connection: idle ⇒ it starts a billed
    // turn (claude-inbox parity), busy ⇒ thread/queue/add runs it after the
    // current turn. The frame carries fromName + cardText (P1, design-
    // harness-plugins §1): the WRAPPER records the user message with a
    // `webui_peer` marker built from them and the codex normalizer renders
    // THAT record as the labelled peer card — live (buffer) and on rebuild
    // (rollout twin, marker-blind dedup). Deliberately NO cardOk() here,
    // unlike the other lanes: ① the record already renders, so an in-memory
    // card on top would double-render live; ② a stdin write succeeding is not
    // a delivery — the wrapper may still report ok:false, which re-stashes
    // and re-renders at drain, so a card emitted now would be a phantom.
    const rpc = findRpcPeer(cid);
    if (rpc) {
      try {
        rpc.s.pty.write(JSON.stringify({ type: 'peer-message', text, fromName: opts.fromName || null, cardText: opts.cardText || null, kind }) + '\n');
        spent();
        return { ok: true, lane: 'rpc-queue', kind, peerName: rpc.s.name || null };
      } catch (e) { log('[deliver] rpc-queue write failed (falling through): ' + e.message); }
    }
    // rung 2: the owning machine's daemon posts to ITS local registry
    const hid = ownerHostOf(cid);
    if (hid) {
      try {
        const hosts = getHosts?.();
        // BOUNDED connect (review-caught): plain device() rides the full
        // ~2.7min retry ladder on a down host — a send request must fall to
        // the stash rung honestly instead (the background connect still heals).
        const dm = await (hosts.deviceBounded ? hosts.deviceBounded(hid, 6000) : hosts.device(hid));
        const r = await dm.peerPost({ cid, text });
        if (r && r.ok) { spent(); cardOk(); return { ok: true, lane: 'remote-message', kind, peerName: r.peerName || null, hostId: hid }; }
        return { ok: false, lane: 'remote-message', hostId: hid, reason: (r && r.reason) || 'remote daemon could not reach the inbox' };
      } catch (e) {
        // capability gate / daemon down — an honest miss, the stash covers it
        return { ok: false, lane: 'remote-message', hostId: hid, reason: e.message };
      }
    }
    return { ok: false, reason: 'no live inbox for this conversation on any reachable machine' };
  }

  function peerReachable(cid) {
    try { if (peerMsg.findPeer(cid)) return true; } catch { }
    if (findRpcPeer(cid)) return true;
    return !!ownerHostOf(cid); // a remote owner MAY be reachable — optimistic preview, the ladder decides for real
  }

  return {
    deliverToConversation, peerReachable, stashFor, drainStash, stashCount, flush,
    // exposed for the stash-drain sites: a drained message enters the agent's
    // context invisibly — the drain site emits the same card the live lanes do
    emitPeerCard: (cid, card) => { try { emitPeerCard?.(cid, card); } catch { } },
  };
}

module.exports = { create };
