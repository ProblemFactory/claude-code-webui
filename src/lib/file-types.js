/**
 * File type registry — single source of truth for extension → metadata.
 */
import { FILE_ICONS } from './icons.js';

const I = FILE_ICONS;
const REGISTRY = {
  // Images
  png:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  jpg:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  jpeg: { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  gif:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  webp: { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  svg:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  bmp:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  ico:  { category: 'image', icon: I.image, viewer: 'image', bypassBinary: true },
  // Video
  mp4:  { category: 'video', icon: I.video, viewer: 'video', bypassBinary: true },
  webm: { category: 'video', icon: I.video, viewer: 'video', bypassBinary: true },
  mov:  { category: 'video', icon: I.video, viewer: 'video', bypassBinary: true },
  avi:  { category: 'video', icon: I.video, viewer: 'video', bypassBinary: true },
  // Audio
  mp3:  { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  wav:  { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  ogg:  { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  flac: { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  aac:  { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  m4a:  { category: 'audio', icon: I.audio, viewer: 'audio', bypassBinary: true },
  // PDF
  pdf:  { category: 'document', icon: I.pdf, viewer: 'pdf', bypassBinary: true },
  // Office
  docx: { category: 'office', icon: I.word, viewer: 'docx', bypassBinary: true },
  doc:  { category: 'office', icon: I.word, viewer: 'docx', bypassBinary: true },
  xlsx: { category: 'office', icon: I.sheet, viewer: 'xlsx', bypassBinary: true },
  xls:  { category: 'office', icon: I.sheet, viewer: 'xlsx', bypassBinary: true },
  pptx: { category: 'office', icon: I.slides, viewer: 'pptx', bypassBinary: true },
  ppt:  { category: 'office', icon: I.slides, viewer: 'pptx', bypassBinary: true },
  // Data
  csv:  { category: 'data', icon: I.data, viewer: 'csv' },
  tsv:  { category: 'data', icon: I.data, viewer: 'csv' },
  // Web
  html: { category: 'web', icon: I.web, viewer: 'html-editor' },
  htm:  { category: 'web', icon: I.web, viewer: 'html-editor' },
  // Code
  js:   { category: 'code', icon: I.code }, jsx: { category: 'code', icon: I.code },
  ts:   { category: 'code', icon: I.code }, tsx: { category: 'code', icon: I.code },
  mjs:  { category: 'code', icon: I.code }, cjs: { category: 'code', icon: I.code },
  py:   { category: 'code', icon: I.python },
  go:   { category: 'code', icon: I.code },
  rs:   { category: 'code', icon: I.code },
  css:  { category: 'code', icon: I.style }, scss: { category: 'code', icon: I.style }, less: { category: 'code', icon: I.style },
  json: { category: 'code', icon: I.config },
  yaml: { category: 'code', icon: I.config }, yml: { category: 'code', icon: I.config },
  toml: { category: 'code', icon: I.config }, xml: { category: 'code', icon: I.config },
  sh:   { category: 'code', icon: I.shell }, bash: { category: 'code', icon: I.shell }, zsh: { category: 'code', icon: I.shell },
  c:    { category: 'code', icon: I.code }, cpp: { category: 'code', icon: I.code },
  h:    { category: 'code', icon: I.code }, java: { category: 'code', icon: I.code },
  rb:   { category: 'code', icon: I.code }, php: { category: 'code', icon: I.code }, swift: { category: 'code', icon: I.code },
  // Text
  md:   { category: 'text', icon: I.markdown },
  txt:  { category: 'text', icon: I.text },
  log:  { category: 'text', icon: I.text },
};

const DEFAULT_ENTRY = { category: 'unknown', icon: I.unknown };

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
