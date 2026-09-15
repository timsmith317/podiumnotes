// File: lib/importers.js → ~/Projects/podiumnotes/lib/importers.js
//
// Shared document-import pipeline. One entry point, readDocumentAsText(asset),
// used by every import call site — app/(notes)/index.js, app/(notes)/[id].js
// and the share-sheet handler in app/_layout.js — so format handling can
// never drift between them again.
//
// Formats:
//   .docx — a ZIP of XML. Read as base64 → unzip with fflate (pure JS, works
//           under Hermes) → extract word/document.xml → pull text runs.
//           Reading a docx as UTF-8 text (the old behavior) throws on the
//           binary zip bytes — that was the "Import failed" bug.
//   .rtf  — ASCII markup. Read as UTF-8, then strip control words/groups.
//           The old behavior imported raw {\rtf1... markup into the note.
//   else  — plain text / markdown, read as UTF-8 unchanged.
//
// Requires: npm install fflate   (tiny, zero-dependency, pure JS)

import * as FileSystem from 'expo-file-system/legacy';
import { unzipSync } from 'fflate';

// ---------------------------------------------------------------------------
// base64 → Uint8Array without Buffer/atob (portable across JS engines)
// ---------------------------------------------------------------------------
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Uint8Array(128);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

function base64ToBytes(b64) {
  const clean = b64.replace(/[\r\n\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let o = 0, buffer = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | B64_LOOKUP[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// UTF-8 bytes → string without TextDecoder (portable across JS engines)
// ---------------------------------------------------------------------------
function utf8BytesToString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i += 1; }
    else if (b < 0xe0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b < 0xf0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const u = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      i += 4;
    }
  }
  return s;
}

function decodeXmlEntities(t) {
  return t
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------------------
// .docx (base64 of the file) → plain text
// Walks <w:p> paragraphs; inside each, collects <w:t> text runs, <w:tab/> as
// tab, <w:br/>/<w:cr/> as newline. Note the <w:t(?:\s...)?> form — a bare
// <w:t prefix would also match <w:tabs> in paragraph properties and leak XML.
// ---------------------------------------------------------------------------
export function docxBase64ToText(b64) {
  const files = unzipSync(base64ToBytes(b64));
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('word/document.xml not found - not a Word document?');
  const xml = utf8BytesToString(doc);
  const paragraphs = [];
  const paraRe = /<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g;
  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    const p = m[0];
    let text = '';
    const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*[^>]*\/>|<w:cr\s*\/>/g;
    let r;
    while ((r = runRe.exec(p)) !== null) {
      if (r[1] !== undefined) text += decodeXmlEntities(r[1]);
      else if (r[0].startsWith('<w:tab')) text += '\t';
      else text += '\n';
    }
    paragraphs.push(text);
  }
  return paragraphs.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// RTF markup → plain text
// Control words are terminated by ONE optional literal space (per RTF spec) —
// using \s? here instead of " ?" would eat the newlines inserted by \par.
// ---------------------------------------------------------------------------
export function rtfToText(rtf) {
  let s = rtf;
  // Drop non-content groups (fonts, colors, styles, embedded images, ...)
  s = s.replace(/\{\\(?:fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|listtable|listoverridetable|generator)[\s\S]*?\}/g, '');
  s = s.replace(/\\par[d]?\b ?/g, '\n');
  s = s.replace(/\\tab\b ?/g, '\t');
  s = s.replace(/\\line\b ?/g, '\n');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\u(-?\d+) ?\??/g, (_, d) => { let n = parseInt(d, 10); if (n < 0) n += 65536; return String.fromCharCode(n); });
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
  s = s.replace(/\\([{}\\])/g, '$1');
  s = s.replace(/[{}]/g, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Entry point. asset = { uri, name, mimeType } from expo-document-picker
// (or an equivalent shape from any other import path).
// Throws on unreadable content; callers keep their friendly alert but should
// log the underlying error for diagnosis.
// ---------------------------------------------------------------------------
export async function readDocumentAsText(asset) {
  const name = asset.name || asset.uri || '';
  const mime = asset.mimeType || '';
  const isDocx = /\.docx$/i.test(name) || mime.includes('wordprocessingml');
  const isRtf = /\.rtf$/i.test(name) || mime === 'application/rtf' || mime === 'text/rtf';

  if (isDocx) {
    const b64 = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    return docxBase64ToText(b64);
  }

  const raw = await FileSystem.readAsStringAsync(asset.uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  if (isRtf || raw.startsWith('{\\rtf')) return rtfToText(raw);
  return raw;
}
