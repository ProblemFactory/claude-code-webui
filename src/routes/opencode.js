'use strict';
/**
 * OpenCode serve ACTION routes (S9 remainder, B-eac2) — roll back / restore a
 * conversation, answer or reject a pending ask, read the live status map and
 * the agent's todos.
 *
 * EVERY route takes `host` and passes it STRAIGHT to the access layer
 * (src/server/opencode-access.js): `hostId` is a parameter, never a branch, so
 * there is exactly one implementation of each action for this machine, a
 * paired device and an ssh host.
 *
 * EVERY mutating route BROADCASTS the change (`opencode-updated`) — a rollback
 * or an answered question is persistent state, and the multi-client law says
 * the other browsers must see it without a refresh. The broadcast carries the
 * FACT that changed plus the conversation id, so a client re-reads exactly one
 * thing (cache invalidation must NOTIFY).
 *
 * EVERY failure answers `{error}` with the machine-side reason — fetchJson
 * never throws, so a route that returned 200-with-nothing would be a silent
 * failure of a user action.
 */
const express = require('express');
const router = express.Router();

let ctx = null;
function setup(deps) { ctx = deps; }

const bad = (res, code, error) => res.status(code).json({ error });
/** THE ONE way a route reaches a machine. Everything an HTTP caller may see
 *  goes through `publicView`, which strips the transport secrets an op may
 *  carry (the serve's ws url + auth header on `pty-open`) — a structural
 *  guarantee rather than "no route asks for that op today", because the next
 *  route is written by someone who never read this file. */
async function call(req, op, params = {}) {
  const host = (req.method === 'GET' ? req.query.host : req.body?.host) || null;
  return ctx.access.publicView(op, await ctx.access.call(host, op, params));
}
function fail(res, e) {
  const status = e?.status === 404 ? 404 : (e?.code === 'unavailable' || e?.code === 'unconfigured' ? 503 : 500);
  return res.status(status).json({ error: String(e?.message || e), code: e?.code || null });
}
function notify(kind, sessionId, extra = {}) {
  try { ctx?.broadcast?.({ type: 'opencode-updated', kind, sessionId: sessionId || null, ...extra }); } catch { }
}

/** The serve's own state on a machine (panel + diagnostics). */
router.get('/api/opencode/state', async (req, res) => {
  try { res.json(await call(req, 'state')); }
  catch (e) { fail(res, e); }
});

/** The OpenCode conversations a machine's serve knows (the same entry shape
 *  the sidebar consumes). This is how a REMOTE machine's OpenCode store is
 *  reachable at all today: the 5s /api/sessions discovery is local-only, so a
 *  remote host answers here on demand rather than pretending its conversations
 *  are in the merged list. */
router.get('/api/opencode/sessions', async (req, res) => {
  try { res.json(await call(req, 'discover')); }
  catch (e) { fail(res, e); }
});

/** Roll a conversation back to a message. v1 route only — measured NOT to
 *  bootstrap an OpenCode instance, unlike every v2 revert/* route. */
router.post('/api/opencode/revert', async (req, res) => {
  const { id, messageID, partID, cwd, host } = req.body || {};
  if (!id || !messageID) return bad(res, 400, 'id and messageID are required');
  try {
    const r = await call(req, 'revert', { id, messageID, partID: partID || null, cwd: cwd || null });
    notify('revert', id, { revert: r?.session?.revert || null, host: host || null });
    res.json({ ok: true, session: r?.session || null });
  } catch (e) { fail(res, e); }
});

/** Undo a staged rollback (OpenCode's own `unrevert`). */
router.post('/api/opencode/unrevert', async (req, res) => {
  const { id, cwd, host } = req.body || {};
  if (!id) return bad(res, 400, 'id is required');
  try {
    const r = await call(req, 'unrevert', { id, cwd: cwd || null });
    notify('unrevert', id, { revert: null, host: host || null });
    res.json({ ok: true, session: r?.session || null });
  } catch (e) { fail(res, e); }
});

/** Pending asks. `refresh=0` reads the live-lane cache; the default re-reads
 *  the authoritative list, which is what makes a pending card survive a page
 *  reload (the client asks on window open). */
router.get('/api/opencode/questions', async (req, res) => {
  try {
    const r = await call(req, 'questions', {
      sessionId: req.query.sessionId || null,
      refresh: req.query.refresh !== '0',
    });
    res.json({ questions: r?.questions || [] });
  } catch (e) { fail(res, e); }
});

/** Answer an ask through the REAL OpenCode route. `answers` is either the
 *  positional array-of-arrays or the card's question-text map. */
router.post('/api/opencode/question/:requestId/reply', async (req, res) => {
  const { answers, host } = req.body || {};
  if (!answers) return bad(res, 400, 'answers are required');
  try {
    const r = await call(req, 'answer', { requestId: req.params.requestId, answers });
    notify('question-replied', r?.sessionID || req.body?.sessionId || null, { requestId: req.params.requestId, host: host || null });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

router.post('/api/opencode/question/:requestId/reject', async (req, res) => {
  const { host } = req.body || {};
  try {
    const r = await call(req, 'reject', { requestId: req.params.requestId });
    notify('question-rejected', r?.sessionID || req.body?.sessionId || null, { requestId: req.params.requestId, host: host || null });
    res.json({ ok: true, ...r });
  } catch (e) { fail(res, e); }
});

/** The serve's in-process busy map (idle|busy|retry per conversation). */
router.get('/api/opencode/status', async (req, res) => {
  try { res.json(await call(req, 'status')); }
  catch (e) { fail(res, e); }
});

/** The agent's own todo list for a conversation. */
router.get('/api/opencode/todos', async (req, res) => {
  if (!req.query.id) return bad(res, 400, 'id is required');
  try { res.json(await call(req, 'todos', { id: req.query.id })); }
  catch (e) { fail(res, e); }
});

module.exports = { router, setup };
