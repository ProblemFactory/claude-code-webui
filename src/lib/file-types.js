/**
 * File type registry — single source of truth for extension → metadata.
 *
 * Every file extension is registered once with its category, icon, viewer type,
 * and whether it bypasses the binary→hex fallback. All consumers query this
 * registry instead of maintaining their own extension lists.
 */

// category: how the file is opened/previewed
// icon: emoji shown in file explorer icon view / list view
// viewer: which viewer handles it in file-viewer.js
// bypassBinary: true = has a dedicated viewer even though it's binary (skip hex)
const REGISTRY = {
  // Images
  png:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  jpg:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  jpeg: { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  gif:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  webp: { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  svg:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  bmp:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },
  ico:  { category: 'image', icon: '\uD83D\uDDBC', viewer: 'image', bypassBinary: true },

  // Video
  mp4:  { category: 'video', icon: '\uD83C\uDFAC', viewer: 'video', bypassBinary: true },
  webm: { category: 'video', icon: '\uD83C\uDFAC', viewer: 'video', bypassBinary: true },
  mov:  { category: 'video', icon: '\uD83C\uDFAC', viewer: 'video', bypassBinary: true },
  avi:  { category: 'video', icon: '\uD83C\uDFAC', viewer: 'video', bypassBinary: true },

  // Audio
  mp3:  { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },
  wav:  { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },
  ogg:  { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },
  flac: { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },
  aac:  { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },
  m4a:  { category: 'audio', icon: '\uD83C\uDFB5', viewer: 'audio', bypassBinary: true },

  // PDF
  pdf:  { category: 'document', icon: '\uD83D\uDCD5', viewer: 'pdf', bypassBinary: true },

  // Office — Word
  docx: { category: 'office', icon: '\uD83D\uDCD8', viewer: 'docx', bypassBinary: true },
  doc:  { category: 'office', icon: '\uD83D\uDCD8', viewer: 'docx', bypassBinary: true },

  // Office — Spreadsheet
  xlsx: { category: 'office', icon: '\uD83D\uDCCA', viewer: 'xlsx', bypassBinary: true },
  xls:  { category: 'office', icon: '\uD83D\uDCCA', viewer: 'xlsx', bypassBinary: true },

  // Office — Presentation
  pptx: { category: 'office', icon: '\uD83D\uDCCA', viewer: 'pptx', bypassBinary: true },
  ppt:  { category: 'office', icon: '\uD83D\uDCCA', viewer: 'pptx', bypassBinary: true },

  // Data
  csv:  { category: 'data', icon: '\uD83D\uDCCA', viewer: 'csv' },
  tsv:  { category: 'data', icon: '\uD83D\uDCCA', viewer: 'csv' },

  // Web
  html: { category: 'web', icon: '\uD83C\uDF10', viewer: 'html-editor' },
  htm:  { category: 'web', icon: '\uD83C\uDF10', viewer: 'html-editor' },

  // Code
  js:   { category: 'code', icon: '\uD83D\uDCDC' },
  jsx:  { category: 'code', icon: '\uD83D\uDCDC' },
  ts:   { category: 'code', icon: '\uD83D\uDCDC' },
  tsx:  { category: 'code', icon: '\uD83D\uDCDC' },
  mjs:  { category: 'code', icon: '\uD83D\uDCDC' },
  cjs:  { category: 'code', icon: '\uD83D\uDCDC' },
  py:   { category: 'code', icon: '\uD83D\uDC0D' },
  go:   { category: 'code', icon: '\uD83D\uDD37' },
  rs:   { category: 'code', icon: '\uD83E\uDD80' },
  css:  { category: 'code', icon: '\uD83C\uDFA8' },
  scss: { category: 'code', icon: '\uD83C\uDFA8' },
  less: { category: 'code', icon: '\uD83C\uDFA8' },
  json: { category: 'code', icon: '{}' },
  yaml: { category: 'code', icon: '\uD83D\uDCC4' },
  yml:  { category: 'code', icon: '\uD83D\uDCC4' },
  toml: { category: 'code', icon: '\uD83D\uDCC4' },
  xml:  { category: 'code', icon: '\uD83D\uDCC4' },
  sh:   { category: 'code', icon: '\u2699' },
  bash: { category: 'code', icon: '\u2699' },
  zsh:  { category: 'code', icon: '\u2699' },
  c:    { category: 'code', icon: '\uD83D\uDCDC' },
  cpp:  { category: 'code', icon: '\uD83D\uDCDC' },
  h:    { category: 'code', icon: '\uD83D\uDCDC' },
  java: { category: 'code', icon: '\uD83D\uDCDC' },
  rb:   { category: 'code', icon: '\uD83D\uDCDC' },
  php:  { category: 'code', icon: '\uD83D\uDCDC' },
  swift:{ category: 'code', icon: '\uD83D\uDCDC' },

  // Text / docs
  md:   { category: 'text', icon: '\uD83D\uDCDD' },
  txt:  { category: 'text', icon: '\uD83D\uDCC4' },
  log:  { category: 'text', icon: '\uD83D\uDCC4' },
};

const DEFAULT_ENTRY = { category: 'unknown', icon: '\uD83D\uDCC4' };

/** Get file type info for an extension (without dot). Returns { category, icon, viewer?, bypassBinary? } */
export function getFileType(ext) {
  return REGISTRY[ext?.toLowerCase()] || DEFAULT_ENTRY;
}

/** Get the icon emoji for a filename */
export function getFileIcon(fileName) {
  const ext = fileName?.split('.').pop()?.toLowerCase() || '';
  return (REGISTRY[ext] || DEFAULT_ENTRY).icon;
}

/** Check if a binary file has a dedicated viewer (should not fall back to hex) */
export function hasDedicatedViewer(ext) {
  return !!(REGISTRY[ext?.toLowerCase()]?.bypassBinary);
}

/** Get the viewer type for an extension */
export function getViewerType(ext) {
  return REGISTRY[ext?.toLowerCase()]?.viewer || null;
}

/** Get category for an extension */
export function getCategory(ext) {
  return (REGISTRY[ext?.toLowerCase()] || DEFAULT_ENTRY).category;
}
