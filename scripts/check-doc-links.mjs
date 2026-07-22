#!/usr/bin/env node
// scripts/check-doc-links.mjs
//
// Lightweight internal Markdown link checker. Validates that every relative
// link and image target in the repository's Markdown files resolves to a file
// that exists on disk. This catches the most common documentation-rot failure:
// a page renaming or removal that leaves dangling links behind.
//
// Scope and intentional non-goals:
//   - Only relative links are checked. External (http/https/mailto/tel) links
//     and pure in-page anchors (`#section`) are ignored.
//   - Anchor fragments on relative links are stripped before resolution; we
//     verify the target file exists, not that a heading anchor exists.
//   - Code fences are stripped so example paths inside ``` blocks are ignored.
//
// Usage: node scripts/check-doc-links.mjs
// Exit code 0 when all internal links resolve, 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);
const LINK_RE = /(?:!?\[[^\]]*\])\(([^)]+)\)/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

function stripCodeFences(md) {
  // Remove fenced code blocks and inline code so example paths are not linted.
  return md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

const files = walk(repoRoot, []);
let broken = 0;
let checked = 0;

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const md = stripCodeFences(raw);
  let m;
  while ((m = LINK_RE.exec(md)) !== null) {
    let target = m[1].trim();
    // Strip optional link titles: [text](path "title")
    target = target.replace(/\s+["'].*["']$/, '');
    if (!target || target.startsWith('#')) continue;
    if (isExternal(target)) continue;
    // Drop anchor / query fragments — we only verify the file exists.
    const filePart = target.split('#')[0].split('?')[0];
    if (!filePart) continue;
    checked += 1;
    const resolved = path.resolve(path.dirname(file), filePart);
    if (!fs.existsSync(resolved)) {
      broken += 1;
      console.error(
        `BROKEN LINK: ${path.relative(repoRoot, file)} -> ${target}`,
      );
    }
  }
}

if (broken > 0) {
  console.error(`\n${broken} broken internal link(s) across ${files.length} Markdown files.`);
  process.exit(1);
}

console.log(`OK: ${checked} internal link(s) resolve across ${files.length} Markdown files.`);
