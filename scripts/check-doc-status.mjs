#!/usr/bin/env node
// scripts/check-doc-status.mjs
//
// Gate for the Voice Mode document corpus: every active voice document must
// declare its class and status, and anything marked as superseded must link to
// the document that replaced it.
//
// Why this exists (2026-09-17). The voice corpus accumulated ~25 documents over
// three weeks at different levels of completion. Two of them told a resuming
// agent to "read this first" while pinning an old contract version, and a third
// still reported a completed verdict that was never measured. A reader could not
// tell current from superseded without reading everything. The orientation file
// `docs/VOICE-MODE-INDEX.md` fixes that by hand; this gate keeps it fixed.
//
// Rules (both are hard failures):
//   1. Every corpus document carries a `Class:` or `Status:` marker in its first
//      60 lines, so its class and freshness are visible at the top of the file.
//   2. If those lines say the document is superseded, they must also contain a
//      Markdown link — a reader who learns a document is superseded must be able
//      to reach its successor.
//
// Scope: Voice Mode corpus documents under `docs/` and `docs/plans/`. Archived
// documents (`docs/archive/**`) are excluded — the archive index governs them.
// This is deliberately narrow rather than a repo-wide status lint: it can be
// widened once the rest of `docs/plans/` is compliant, which it currently is not.
//
// Usage: node scripts/check-doc-status.mjs
// Exit code 0 when every corpus document complies, 1 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CORPUS_DIRS = ['docs', 'docs/plans'];
const CORPUS_RE = /(voice|talker|drive-?mode|audio-regression)/i;
const EXCLUDE_DIRS = new Set([path.join('docs', 'archive')]);
const MARKER_WINDOW = 60;
// A "superseded" claim is only a claim about the document when it appears in the
// header banner; a table row far below ("accumulated / superseded / cleared")
// describes a value, not the file. So the successor rule scans the banner only.
const BANNER_WINDOW = 20;

// A marker line begins (after any Markdown/quote/emoji decoration) with the word
// "Class" or "Status", e.g. "> **Class:** canonical", "**Status:** current",
// "> ## \u26a0\ufe0f Status \u2014 corrected", "Status: **EXECUTING**".
const MARKER_RE = /^(class|status)\b/i;
const DECORATION_RE = /^[^A-Za-z]+/;
const LINK_RE = /\]\([^)]+\.md(?:#[^)]*)?\)/;

function corpusFiles() {
  const files = [];
  for (const dir of CORPUS_DIRS) {
    const full = path.join(repoRoot, dir);
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      if (!CORPUS_RE.test(entry.name)) continue;
      files.push(path.join(dir, entry.name));
    }
  }
  for (const excluded of EXCLUDE_DIRS) {
    const prefix = excluded + path.sep;
    for (let i = files.length - 1; i >= 0; i -= 1) {
      if (files[i].startsWith(prefix)) files.splice(i, 1);
    }
  }
  return files.sort();
}

function inspect(relativePath) {
  const text = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const lines = text.split(/\r?\n/);
  const window = lines.slice(0, MARKER_WINDOW);
  const banner = lines.slice(0, BANNER_WINDOW);

  const hasMarker = window.some((line) => MARKER_RE.test(line.replace(DECORATION_RE, '')));
  // Match the past participle only: "supersedes nothing" is not a claim that the
  // document itself has been superseded.
  const claimsSuperseded = banner.some((line) => /superseded/i.test(line));
  const hasSuccessorLink = banner.some((line) => LINK_RE.test(line));

  const problems = [];
  if (!hasMarker) {
    problems.push('no `Class:`/`Status:` marker in the first 60 lines');
  }
  if (claimsSuperseded && !hasSuccessorLink) {
    problems.push('says it is superseded but links to no successor document');
  }
  return problems;
}

const files = corpusFiles();
const failures = [];
for (const file of files) {
  const problems = inspect(file);
  if (problems.length > 0) failures.push({ file, problems });
}

if (failures.length === 0) {
  console.log(
    `OK: ${files.length} Voice Mode document(s) declare class/status, and every superseded one links to its successor.`,
  );
  process.exit(0);
}

console.error(`FAIL: ${failures.length} Voice Mode document(s) do not comply.`);
console.error('See docs/VOICE-MODE-INDEX.md section 8 for the rules.');
for (const { file, problems } of failures) {
  console.error(`  - ${file}`);
  for (const problem of problems) console.error(`      ${problem}`);
}
process.exit(1);
