// E2a-3 correction 01 — RED tests for the three code fixes.
// 1. gate.mjs releaseLock must check the lock owner before removing anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateRelease, acquireLock, releaseLock } from '../lib/gate.mjs';

function tmpLockDir(label, ownerText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-${String(label).replace(/\W+/g, '-')}-`));
  fs.writeFileSync(path.join(dir, 'owner'), ownerText, { mode: 0o644 });
  return dir;
}

test('evaluateRelease: the owner token matching the owner file allows release', () => {
  const v = evaluateRelease('lane E2a-3 arm 2b unit(s) start ...\n', 'lane E2a-3');
  assert.equal(v.allowed, true);
});

test('evaluateRelease: a non-owner token is refused', () => {
  const v = evaluateRelease('lane E2a-3 arm 2b unit(s) start ...\n', 'lane E2a-6c');
  assert.equal(v.allowed, false);
  assert.match(v.reason, /does not match/);
});

test('evaluateRelease: a missing or unreadable owner file is refused', () => {
  assert.equal(evaluateRelease(null, 'lane E2a-3').allowed, false);
  assert.equal(evaluateRelease(undefined, 'lane E2a-3').allowed, false);
  assert.equal(evaluateRelease('', 'lane E2a-3').allowed, false);
});

test('evaluateRelease: an empty caller token is refused', () => {
  assert.equal(evaluateRelease('lane E2a-3', '').allowed, false);
  assert.equal(evaluateRelease('lane E2a-3', '   ').allowed, false);
});

test('releaseLock: the owner releases and the lock directory is removed', () => {
  const dir = tmpLockDir('owner-releases', 'lane E2a-3 arm 2b unit(s)\n');
  try {
    const r = releaseLock('lane E2a-3', dir);
    assert.equal(r.released, true);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock: a non-owner is refused and the lock stays intact', () => {
  const dir = tmpLockDir('non-owner', 'lane E2a-3 arm 2b unit(s)\n');
  try {
    const r = releaseLock('lane E2a-6c', dir);
    assert.equal(r.released, false);
    assert.match(r.reason, /does not match/);
    assert.equal(fs.existsSync(dir), true);
    assert.match(fs.readFileSync(path.join(dir, 'owner'), 'utf8'), /E2a-3/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('releaseLock: a missing owner file is refused and the directory is untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-noowner-'));
  try {
    const r = releaseLock('lane E2a-3', dir);
    assert.equal(r.released, false);
    assert.match(r.reason, /owner file missing/);
    assert.equal(fs.existsSync(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireLock still writes the owner file the release check reads', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-acq-')), 'lock');
  try {
    assert.equal(acquireLock('lane E2a-3 arm 1', dir).acquired, true);
    assert.equal(releaseLock('lane E2a-3', dir).released, true);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});
