// Web-search tool cards — ONE home for both sides of the wire (PURE tier: no
// requires; CJS pulled into the browser bundle like task-color-seq.js).
//
//   renderSearchOutput(ev)  — the HUMAN output of a codex `web_search_end`
//                             event {query, action, results, error}; the
//                             normalizer is the only caller (live records and
//                             rollout rebuilds go through the same function).
//   searchQueryOf(input)    — the query/url a search-kind card's TITLE shows:
//                             claude WebSearch {query} / WebFetch {url}, codex
//                             web_search {query, action}, ACP search tools
//                             ({query|pattern|url}). '' = nothing to show.
//   searchActionKey(a, q)   — twin-dedup key: 0.14x rollouts persist the SAME
//                             search twice (event_msg web_search_end with a
//                             call_id, then an id-less Responses-API
//                             web_search_call item carrying only the action).
//
// Shapes (codex 0.153.4 bindings + real rollouts 2026-04..08):
//   WebSearchAction = {type:'search', query?, queries?[]} | {type:'open_page', url?}
//                   | {type:'find_in_page', url?, pattern?} | {type:'other'}
//   result          = {type:'text_result', ref_id, title?, url?, domain?, snippet?} (JsonValue in the bindings)
'use strict';

const MAX_RESULTS = 20;
const MAX_OUTPUT_BYTES = 4096;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);

/** Human head line for an action; '' for a plain search (its query is the card title). */
function actionSummary(action, query) {
  const a = obj(action);
  if (!a) return '';
  if (a.type === 'open_page') return `opened ${str(a.url) || str(query) || '(page)'}`;
  if (a.type === 'find_in_page') return `found '${str(a.pattern)}' in ${str(a.url) || str(query) || '(page)'}`;
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
  const results = Array.isArray(e.results) ? e.results : [];
  const lines = results.slice(0, MAX_RESULTS).map(renderResult).filter(Boolean);
  if (results.length > MAX_RESULTS) lines.push(`… +${results.length - MAX_RESULTS} more`);
  let body = lines.join('\n\n');
  if (!body) body = head ? '' : 'no results';
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
    else if (a.type === 'find_in_page' && str(a.pattern)) fromAction = `'${str(a.pattern)}' in ${str(a.url)}`.trim();
    else fromAction = str(a.url);
  }
  return str(i.query) || fromAction || str(i.url) || str(i.pattern) || str(i.q) || '';
}

/** Order-insensitive key identifying one search across its twin records. */
function searchActionKey(action, query) {
  const a = obj(action);
  const queries = a && Array.isArray(a.queries) ? a.queries.map(str).filter(Boolean).join('\n') : '';
  // with an action the key is ACTION-ONLY (the id-less web_search_call twin has
  // no top-level query; an open_page end's query is its url) — the bare query
  // stands in only when there is no action at all
  const what = a ? (queries || str(a.query)) : str(query);
  return [str(a?.type) || (what ? 'search' : ''), what, str(a?.url), str(a?.pattern)].join('|');
}

module.exports = { renderSearchOutput, searchQueryOf, searchActionKey, MAX_RESULTS, MAX_OUTPUT_BYTES };
