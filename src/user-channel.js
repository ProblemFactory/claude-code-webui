// Claude's agent→user channel tools — ONE home for both sides of the wire
// (PURE tier: no requires; CJS pulled into the browser bundle like
// search-card.js / collab-row.js, so the escaping rules below are unit-provable).
//
// WHY THIS EXISTS (design-harness-features §2.12, owner ruling 8(c)): the CLI
// has had a FIRST-CLASS agent→user channel since `--brief` — two real tools,
// not prose — and VibeSpace had zero mentions of either name, so a session
// started with --brief drew a generic "SendUserMessage" tool card for the one
// message the agent meant the human to read. We had hand-rolled the same two
// ideas twice (vibespace-ask for "tell the user something", published pages
// for "hand the user a file"); this module makes the CLI's own channel
// first-class instead of building a third one.
//
// SCHEMAS ARE DUMPED, NEVER GUESSED (the §6 landing rule). Both come from the
// 2.1.257 native binary's own zod definitions — `strings` on
// ~/.local/share/claude/versions/2.1.257, the `.describe()` literals are the
// protocol truth:
//
//   SendUserMessage  (aliases: ['Brief']; enabled by --brief / Xfe())
//     input  { message: string                      // "The message for the user. Supports markdown formatting."
//            , attachments?: Array<string | {file_uuid, file_name, size, is_image, media_type?}>
//            , status: 'normal'|'proactive' }       // REQUIRED in the full form
//     …and a MINIMAL input form `{ message }` when the attachment capability
//     is off (the binary picks `vAe() ? GMo() : zMo()`), so `status` and
//     `attachments` are OPTIONAL AS FAR AS WE ARE CONCERNED — a reader that
//     required them would blank the card on the minimal form.
//     output { message: string
//            , attachments?: [{path, size, isImage, file_uuid?, media_type?, pathValidated?, upload_error?}]
//            , sentAt?: string, rendered_locally?: boolean }
//
//   SendUserFile
//     input  { files: string[]                      // "File paths (absolute or relative to cwd)…"; a bare string is coerced to [string] by the CLI's own preprocessor, so accept both
//            , caption?: string
//            , status: 'normal'|'proactive'
//            , display?: 'render'|'attach' }        // 'render' = show it inline now, 'attach' = download card only, unset = client decides
//     output { caption?, display?
//            , attachments: [{path, size, isImage, file_uuid?, media_type?, pathValidated?, upload_error?}]
//            , rendered_locally?: boolean }
//
// THE OUTPUT IS THE BETTER SOURCE when we have it: the CLI resolved every
// path, stat'ed it and recorded `upload_error` per file. The input is the
// fallback for a still-pending card (the tool_use is rendered before its
// result arrives) — which is exactly why both are read here and merged by
// PATH, never "output if present else input" (a merge-never-fallback case:
// `attachments` can legitimately be a SHORTER list than `files` when one file
// failed, and dropping the input would hide the failed one entirely).
'use strict';

/** The CLI's own tool names. `Brief` is the documented ALIAS of
 *  SendUserMessage (binary: `aliases:[TQe]`, TQe="Brief", plus the global
 *  alias map `Brief:"SendUserMessage"`), so a permission rule or an older
 *  record spelling it that way must classify identically. */
const USER_CHANNEL_TOOLS = Object.freeze({
  message: Object.freeze(['SendUserMessage', 'Brief']),
  file: Object.freeze(['SendUserFile']),
});

const MAX_MESSAGE_CHARS = 20000;   // a card, not a transcript viewer
const MAX_FILES = 20;              // one call may name many; the card lists at most this many
const MAX_CAPTION_CHARS = 500;

/**
 * Which user-channel tool this is — the ONE classifier every surface uses.
 * Returns 'message' | 'file' | null. A tool that is not part of the channel
 * MUST return null: the whole point of the highlighted card is that it means
 * "the agent is talking to YOU", so a Bash card that borrowed the styling
 * would be a lie (scripts/test-stdout-registry.mjs pins the negative control).
 */
function userChannelKind(toolName) {
  const n = String(toolName || '');
  if (USER_CHANNEL_TOOLS.message.includes(n)) return 'message';
  if (USER_CHANNEL_TOOLS.file.includes(n)) return 'file';
  return null;
}

/** 'normal' | 'proactive' — anything else is treated as unset. The CLI's own
 *  describe: 'proactive' = the agent initiated (a finished background task, a
 *  blocker) and downstream routing uses it; 'normal' = a reply. */
function channelStatus(v) {
  return v === 'proactive' || v === 'normal' ? v : null;
}

const clip = (s, n) => {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, n) + '…' : str;
};

/** Basename WITHOUT importing path (PURE tier): both separators, no trailing
 *  slash surprises. */
function baseName(p) {
  const s = String(p || '').replace(/[/\\]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** One entry of an `attachments` array (both tools share the shape). */
function attachmentEntry(a) {
  if (!a || typeof a !== 'object') return null;
  const p = typeof a.path === 'string' ? a.path : '';
  const uuid = typeof a.file_uuid === 'string' ? a.file_uuid : '';
  if (!p && !uuid) return null;
  return {
    path: p,
    name: baseName(p) || uuid,
    size: Number.isFinite(a.size) ? a.size : null,
    isImage: a.isImage === true || a.is_image === true,
    mediaType: typeof a.media_type === 'string' ? a.media_type : '',
    fileUuid: uuid,
    // upload_error is the CLI's own per-file failure string. It must reach the
    // card: a file the agent believes it sent and the user never got is the
    // exact silent failure this product does not tolerate.
    error: typeof a.upload_error === 'string' && a.upload_error ? a.upload_error : '',
  };
}

/** A SendUserMessage input entry may be a bare PATH STRING or the device
 *  `attach_file` object passed through verbatim. */
function inputAttachmentEntry(a) {
  if (typeof a === 'string') return a ? { path: a, name: baseName(a), size: null, isImage: false, mediaType: '', fileUuid: '', error: '' } : null;
  if (a && typeof a === 'object' && typeof a.file_uuid === 'string') {
    return {
      path: '', name: String(a.file_name || a.file_uuid), size: Number.isFinite(a.size) ? a.size : null,
      isImage: a.is_image === true, mediaType: typeof a.media_type === 'string' ? a.media_type : '',
      fileUuid: a.file_uuid, error: '',
    };
  }
  return null;
}

/**
 * MERGE, never fallback (feedback_merge_never_fallback): the resolved output
 * entries win per file, and an input entry the output never mentioned is kept
 * as an UNRESOLVED row rather than disappearing. Keyed by path when there is
 * one, else by the file_uuid, else by list position.
 */
function mergeEntries(fromInput, fromOutput) {
  const out = [];
  const byKey = new Map();
  const keyOf = (e, i) => e.path || e.fileUuid || `#${i}`;
  fromInput.forEach((e, i) => { const k = keyOf(e, i); byKey.set(k, out.length); out.push({ ...e, resolved: false }); });
  fromOutput.forEach((e, i) => {
    const k = keyOf(e, i);
    const at = byKey.get(k);
    // A resolved entry keyed differently from its input row (the CLI made a
    // relative path absolute) still belongs to the SAME file — match by
    // basename before giving it a row of its own, so "report.md" does not
    // print twice.
    const byBase = at === undefined ? out.findIndex((x) => !x.resolved && x.name && x.name === e.name) : -1;
    const idx = at !== undefined ? at : (byBase >= 0 ? byBase : -1);
    if (idx >= 0) out[idx] = { ...out[idx], ...e, resolved: true };
    else { byKey.set(k, out.length); out.push({ ...e, resolved: true }); }
  });
  return out.slice(0, MAX_FILES);
}

/**
 * The typed record a user-channel card renders from. NEVER parses prose —
 * every field comes from a named key of the dumped schemas above.
 * @param {{toolName:string, input:object, output:object|string|null}} block
 * @returns {null | {kind:'message'|'file', status, message, caption, display, files:Array, truncatedFiles:number}}
 */
function userChannelRecord(block) {
  const kind = userChannelKind(block && block.toolName);
  if (!kind) return null;
  const input = (block && block.input && typeof block.input === 'object') ? block.input : {};
  // The tool RESULT reaches us as text on the normalized block (`output`);
  // the CLI's structured output rides it as JSON. A non-JSON body is not an
  // error — it just means we render from the input alone.
  let output = null;
  if (block && block.output && typeof block.output === 'object') output = block.output;
  else if (typeof (block && block.output) === 'string' && block.output.trim().startsWith('{')) {
    try { output = JSON.parse(block.output); } catch { output = null; }
  }
  const outAtt = Array.isArray(output && output.attachments) ? output.attachments.map(attachmentEntry).filter(Boolean) : [];

  if (kind === 'message') {
    const inAtt = Array.isArray(input.attachments) ? input.attachments.map(inputAttachmentEntry).filter(Boolean) : [];
    const text = typeof (output && output.message) === 'string' && output.message ? output.message
      : (typeof input.message === 'string' ? input.message : '');
    return {
      kind: 'message',
      status: channelStatus(input.status),
      message: clip(text, MAX_MESSAGE_CHARS),
      truncated: String(text || '').length > MAX_MESSAGE_CHARS,
      caption: '',
      display: '',
      files: mergeEntries(inAtt, outAtt),
      truncatedFiles: Math.max(0, inAtt.length + outAtt.length - MAX_FILES),
      sentAt: typeof (output && output.sentAt) === 'string' ? output.sentAt : '',
    };
  }
  // SendUserFile — `files` is string[] but the CLI's own preprocessor coerces
  // a bare string, so a record produced by an older/looser caller can carry
  // either. Accept both rather than showing an empty card.
  const rawFiles = typeof input.files === 'string' ? [input.files] : (Array.isArray(input.files) ? input.files : []);
  const inAtt = rawFiles.map(inputAttachmentEntry).filter(Boolean);
  const display = (input.display === 'render' || input.display === 'attach') ? input.display
    : ((output && (output.display === 'render' || output.display === 'attach')) ? output.display : '');
  return {
    kind: 'file',
    status: channelStatus(input.status),
    message: '',
    truncated: false,
    caption: clip(typeof input.caption === 'string' ? input.caption : (typeof (output && output.caption) === 'string' ? output.caption : ''), MAX_CAPTION_CHARS),
    display,
    files: mergeEntries(inAtt, outAtt),
    truncatedFiles: Math.max(0, inAtt.length - MAX_FILES),
  };
}

/**
 * The file paths a SendUserFile call names, resolved against the directory the
 * CLI itself is running in. PURE: the caller brings `base` (for a --worktree
 * session that is the WORKTREE path the CLI announced in its init frame, not
 * the folder the user picked — the CLI resolves relative paths against its own
 * cwd and it chdir'd into the worktree).
 * @returns {string[]} absolute-looking paths, de-duplicated, capped
 */
function userFilePaths(rec, base) {
  if (!rec || rec.kind !== 'file') return [];
  const dir = String(base || '').replace(/\/+$/, '');
  const seen = new Set();
  const out = [];
  for (const f of rec.files) {
    if (!f.path) continue;                       // a device upload has no local path
    const abs = f.path.startsWith('/') ? f.path : (dir ? dir + '/' + f.path : '');
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

// ── card HTML (esc/t/icons INJECTED, exactly like collab-row.js) ─────────────
// Building the markup here — with the escaper handed in — is what makes the
// XSS rule provable in a unit test instead of a review promise: every
// interpolation below goes through `esc`, and the suite feeds a marker string.

/** Shared file-row markup for both cards. `link(entry)` returns a RELATIVE
 *  href (or '') — the 2.366.1 URL law: the server never guesses an absolute
 *  URL, the browser joins it with its own origin. */
function fileRowsHtml(rec, { esc, t, link = () => '' }) {
  if (!rec.files.length) return '';
  const rows = rec.files.map((f) => {
    const href = String(link(f) || '');
    // The VISIBLE label is the basename: a 375px column cannot show
    // /home/u/very/long/…/report.png and still show the size next to it, and
    // the basename is what the user is looking for. The full path is not
    // dropped — it rides the title, so the fact is still reachable (and the
    // row stays honest about WHICH file it is when two share a name).
    const label = esc(f.name || f.path || '?');
    const full = f.path && f.path !== f.name ? ` title="${esc(f.path)}"` : '';
    const nameHtml = href
      ? `<a class="chat-userfile-link"${full} href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`
      : `<span class="chat-userfile-name"${full}>${label}</span>`;
    const bits = [];
    if (f.size != null) bits.push(esc(formatBytes(f.size)));
    if (f.isImage) bits.push(esc(t('image')));
    const meta = bits.length ? ` <span class="chat-userfile-meta">${bits.join(' · ')}</span>` : '';
    const err = f.error ? ` <span class="chat-userfile-error">${esc(t('not delivered: {why}', { why: f.error }))}</span>` : '';
    return `<div class="chat-userfile-row">${nameHtml}${meta}${err}</div>`;
  }).join('');
  const more = rec.truncatedFiles > 0
    ? `<div class="chat-userfile-row chat-userfile-meta">${esc(t('and {n} more', { n: rec.truncatedFiles }))}</div>` : '';
  return `<div class="chat-userfile-list">${rows}${more}</div>`;
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/** `status:'proactive'` = the agent INITIATED this (a finished background
 *  task, a blocker) rather than replying — the CLI's describe says downstream
 *  routing uses it, so it is worth showing. The chip text is the PROTOCOL
 *  VALUE, deliberately untranslated (§16: t() never wraps protocol values —
 *  same rule as the codex personality names); the human sentence lives in the
 *  tooltip, which IS translated. */
function proactiveChip(rec, { esc, t }) {
  if (rec.status !== 'proactive') return '';
  return ` <span class="chat-userchan-chip" title="${esc(t('The agent sent this on its own initiative, not as a reply'))}">${esc(rec.status)}</span>`;
}

/**
 * The HIGHLIGHTED "message to you" card. `body` is the caller's already-
 * rendered markdown (chat-renderers owns DOMPurify+marked — a PURE module must
 * never carry a sanitizer), or null to fall back to escaped plain text.
 */
function userMessageCardHtml(rec, { esc, t, icons = {}, body = null }) {
  const head = `<span class="chat-userchan-label">${icons.mail || ''} ${esc(t('Message for you'))}${proactiveChip(rec, { esc, t })}</span>`;
  const text = body != null ? body : `<div class="chat-userchan-text">${esc(rec.message)}</div>`;
  const trunc = rec.truncated ? `<div class="chat-userfile-meta">${esc(t('(message truncated for display)'))}</div>` : '';
  return `<div class="chat-userchan chat-userchan-message">${head}${text}${trunc}${fileRowsHtml(rec, { esc, t })}</div>`;
}

/** The "file for you" card. */
function userFileCardHtml(rec, { esc, t, icons = {}, link = () => '', note = '' }) {
  const n = rec.files.length;
  const title = n === 1 ? t('File for you') : t('{n} files for you', { n });
  const head = `<span class="chat-userchan-label">${icons.upload || ''} ${esc(title)}${proactiveChip(rec, { esc, t })}</span>`;
  const cap = rec.caption ? `<div class="chat-userchan-text">${esc(rec.caption)}</div>` : '';
  const noteHtml = note ? `<div class="chat-userfile-meta">${esc(note)}</div>` : '';
  return `<div class="chat-userchan chat-userchan-file">${head}${cap}${fileRowsHtml(rec, { esc, t, link })}${noteHtml}</div>`;
}

module.exports = {
  USER_CHANNEL_TOOLS, MAX_FILES,
  userChannelKind, userChannelRecord, userFilePaths,
  userMessageCardHtml, userFileCardHtml, formatBytes,
};
