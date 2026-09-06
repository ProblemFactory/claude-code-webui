// Web-search tool cards — ONE home for both sides of the wire (PURE tier: no
// requires; CJS pulled into the browser bundle like task-color-seq.js).
//
//   renderSearchOutput(ev)  — the HUMAN output of a codex search completion
//                             {query, action, results, error}; the normalizer is
//                             the only caller (live records and rollout rebuilds
//                             go through the same function).
//   searchQueryOf(input)    — the query/url a search-kind card's TITLE shows:
//                             claude WebSearch {query} / WebFetch {url}, codex
//                             web_search {query, action}, ACP search tools
//                             ({query|pattern|url}). '' = nothing to show.
//   searchActionKey(a, q)   — twin-dedup key: 0.120-0.130 rollouts persist the
//                             SAME search twice (event_msg web_search_end with a
//                             call_id, then an id-less Responses-API
//                             web_search_call item carrying only the action).
//
// Shapes (codex 0.153.4 v2 schema + real rollouts 2026-04..09, fleet-scanned by
// session_meta.cli_version — the full table is in the codex-message-manager.js
// kb essay; do NOT restate a version claim here without re-running that scan):
//   action.type is spelled TWO ways for the same thing and both reach here —
//     core protocol / 0.120-0.149 event_msg web_search_end + web_search_call:
//       {type:'search', query?, queries?[]} | {type:'open_page', url?}
//       | {type:'find_in_page', url?, pattern?} | {type:'other'}
//     v2 app-server (the wrapper's live item/completed) AND the 0.153.4 rollout's
//     event_msg item_completed {item:{type:'Extension', kind:'web.search'}}:
//       {type:'search', query:null, queries[]} | {type:'openPage', url?}
//       | {type:'findInPage', url?, pattern?} | {type:'other'}
//     (url/pattern are NULLABLE in the v2 schema — a real findInPage carried url:null)
//   result = {type:'text_result', ref_id, title?, url?, domain?, snippet?, thumbnail_url?}
//            (opaque JSON at the extension boundary — anything else is stringified)
//   results: 0.149.1 + 0.153.4 ALWAYS persist the array ([] = the search really
//            returned nothing — 35/35 ends and 245/245 Extension items carry the
//            key in the local corpus); 0.120/0.125/0.130 NEVER carry it (1698
//            ends, 0 with the key) — absent means nothing known, NOT empty.
'use strict';

const MAX_RESULTS = 20;
const MAX_OUTPUT_BYTES = 4096;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

// canonical (snake_case) action type — the v2 camelCase spellings map onto it
const ACTION_TYPES = { search: 'search', open_page: 'open_page', openpage: 'open_page', find_in_page: 'find_in_page', findinpage: 'find_in_page', other: 'other' };
/** 'search' | 'open_page' | 'find_in_page' | 'other' | '' (no/unknown action). */
function actionType(action) {
  const a = obj(action);
  const t = str(a?.type).toLowerCase();
  return ACTION_TYPES[t] || ACTION_TYPES[t.replace(/_/g, '')] || (t ? 'other' : '');
}

const asUrl = (s) => (/^https?:\/\//i.test(str(s)) ? str(s) : '');

/** Human head line for an action; '' for a plain search (its query is the card title). */
function actionSummary(action, query) {
  const a = obj(action);
  const t = actionType(a);
  // url is NULLABLE in the v2 schema (a real findInPage carried url:null and
  // query "'<pattern>'") — the query stands in only when it IS a url
  if (t === 'open_page') return `opened ${str(a.url) || asUrl(query) || '(page)'}`;
  if (t === 'find_in_page') { const where = str(a.url) || asUrl(query); return `found '${str(a.pattern)}'${where ? ` in ${where}` : ''}`; }
  return '';
}

function renderResult(r) {
  const o = obj(r);
  if (!o) {
    let s; try { s = typeof r === 'string' ? r : JSON.stringify(r); } catch { s = String(r); }
    return str(s).slice(0, 300);
  }
  const title = str(o.title) || str(o.domain) || str(o.ref_id) || '';
  const url = str(o.url);
  const head = title && url ? `${title} — ${url}` : (title || url);
  const snippet = str(o.snippet).replace(/\s+/g, ' ');
  return [head, snippet].filter(Boolean).join('\n');
}

/** @returns {{output:string,isError:boolean}} */
function renderSearchOutput(ev) {
  const e = obj(ev) || {};
  const err = e.error;
  if (err) {
    const msg = typeof err === 'string' ? err : (str(obj(err)?.message) || (() => { try { return JSON.stringify(err); } catch { return 'error'; } })());
    return { output: msg || 'error', isError: true };
  }
  const head = actionSummary(e.action, e.query);
  const hasResults = Array.isArray(e.results);
  const results = hasResults ? e.results : [];
  const lines = results.slice(0, MAX_RESULTS).map(renderResult).filter(Boolean);
  if (results.length > MAX_RESULTS) lines.push(`… +${results.length - MAX_RESULTS} more`);
  let body = lines.join('\n\n');
  if (!body) {
    // 'no results' is a CLAIM — only an EMPTY array supports it. An absent key
    // (0.120/0.125/0.130 never persist results) says nothing about emptiness, so
    // the card states what was done instead: the page head, or `searched: <q>`.
    if (hasResults) body = head ? '' : 'no results';
    else if (!head) { const q = searchQueryOf({ query: e.query, action: e.action }); body = q ? `searched: ${q}` : 'status: completed'; }
  }
  let output = [head, body].filter(Boolean).join('\n\n');
  // byte cap (TextEncoder: node + browser, no Buffer — the module ships in the bundle)
  const bytes = new TextEncoder().encode(output);
  if (bytes.length > MAX_OUTPUT_BYTES) {
    // cut under the cap on a char boundary (a split code point decodes lossy → drop it), then mark it
    let cut = new TextDecoder('utf-8').decode(bytes.subarray(0, MAX_OUTPUT_BYTES - 3));
    if (cut.endsWith('�')) cut = cut.slice(0, -1);
    output = cut + '…';
  }
  return { output, isError: false };
}

/** The query/url to surface in a search-kind card's title ('' = none). */
function searchQueryOf(input) {
  if (typeof input === 'string') return str(input);
  const i = obj(input);
  if (!i) return '';
  const a = obj(i.action);
  let fromAction = '';
  if (a) {
    const queries = Array.isArray(a.queries) ? a.queries.map(str).filter(Boolean) : [];
    if (queries.length) fromAction = queries.join(' | ');
    else if (str(a.query)) fromAction = str(a.query);
    // url is NULLABLE in the v2 schema — a dangling "… in" is not a title
    else if (actionType(a) === 'find_in_page' && str(a.pattern)) fromAction = str(a.url) ? `'${str(a.pattern)}' in ${str(a.url)}` : `'${str(a.pattern)}'`;
    else fromAction = str(a.url);
  }
  return str(i.query) || fromAction || str(i.url) || str(i.pattern) || str(i.q) || '';
}

/** Order-insensitive key identifying one search across its twin records. */
function searchActionKey(action, query) {
  const a = obj(action);
  const t = actionType(a);
  const queries = a && Array.isArray(a.queries) ? a.queries.map(str).filter(Boolean).join('\n') : '';
  // with an action the key is ACTION-ONLY (the id-less web_search_call twin has
  // no top-level query; an open_page end's query is its url) — the bare query
  // stands in only when there is no action at all. {type:'other'} and NO action
  // are ONE bucket: a 0.120 end `{query:'', action:{type:'other'}}` is twinned by
  // a call `{status:'completed'}` with no action key at all (real 2026-04-14
  // rollout — keyed apart they rendered a second empty card).
  const what = a ? (queries || str(a.query)) : str(query);
  if (t === 'other' || (!a && !what)) return 'other|||';
  return [t || 'search', what, str(a?.url), str(a?.pattern)].join('|');
}

module.exports = { renderSearchOutput, searchQueryOf, searchActionKey, actionType, MAX_RESULTS, MAX_OUTPUT_BYTES };
