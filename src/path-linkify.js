/**
 * path-linkify.js — PURE (imports nothing; CJS so the browser bundle and any
 * node test share ONE definition): where a file path ENDS in prose.
 *
 * The chat linkifier used to stop a path only at ASCII punctuation, so Chinese
 * prose glued its fullwidth punctuation onto the link (owner screenshot,
 * 2026-09-10: `…/SharedContext/designs/（浏览器` — the "（" that opens the
 * parenthetical became part of the path and the click opened nothing).
 * CJK filenames are common and stay linkable; only PUNCTUATION ends a path:
 *   U+3000–303F  CJK symbols and punctuation (　、。「」『』【】《》〈〉…)
 *   U+FF01–FF0F, FF1A–FF20, FF3B–FF40, FF5B–FF65  fullwidth ASCII punctuation
 *                (（）！？，．：；～ — the fullwidth DIGITS and LETTERS in between stay)
 *   U+2018–201F  curly quotes “ ” ‘ ’ · U+2026 … · U+2013/2014 – —
 */
'use strict';

const CJK_PUNCT = '\\u3000-\\u303F\\uFF01-\\uFF0F\\uFF1A-\\uFF20\\uFF3B-\\uFF40\\uFF5B-\\uFF65\\u2018-\\u201F\\u2026\\u2013\\u2014';
// One character of a path segment: never whitespace, never a shell/markup
// delimiter, never the punctuation above. (`:` is excluded from segments and
// re-admitted only as the trailing `:line[:col]` suffix.)
const SEG = '[^\\0<>?\\s!`&*()\'":;\\\\' + CJK_PUNCT + ']';
const PATH_SRC = '(?<![="\'\\w/])((?:~|\\.\\.?)?\\/' + SEG + SEG + '*(?:\\/' + SEG + '+)+(?::\\d+(?::\\d+)?)?)';

/** A fresh global regex each call (a shared `g` regex carries lastIndex state). */
function pathRe() { return new RegExp(PATH_SRC, 'g'); }

const TRAILING = new RegExp('[`\'".,;:!?)}\\]' + CJK_PUNCT + ']+$');
/** Strip trailing punctuation from a matched path or URL — ASCII and CJK alike. */
function cleanPath(p) { return String(p).replace(TRAILING, ''); }

module.exports = { pathRe, cleanPath, PATH_SRC, CJK_PUNCT };
