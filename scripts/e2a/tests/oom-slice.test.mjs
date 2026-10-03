// E2a-3 harness tests — deliberate-OOM arms must live in e2a-oom.slice (STRESS-GATE 21:50 amendment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCgroupUnderSlice, OOM_ARM_SLICE, buildOomProofUnitArgv } from '../arm2-oom.mjs';
import { assertCgroupUnderSlice as assertMemlowSlice, buildMemlowUnitArgv } from '../arm3-memlow.mjs';

test('arm 2b unit argv pins Slice=e2a-oom.slice plus the containment properties', () => {
  const argv = buildOomProofUnitArgv({ payloadPath: '/x/arm2-oom.mjs', out: '/tmp/o.json' });
  const text = argv.join(' ');
  assert.ok(text.includes('Slice=e2a-oom.slice'), text);
  assert.ok(text.includes('MemoryMax=6G'));
  assert.ok(text.includes('MemorySwapMax=0'));
  assert.ok(text.includes('OOMPolicy=continue'));
  assert.ok(text.includes('RuntimeMaxSec=300'));
  assert.ok(text.includes('e2a-3-oomproof'));
});

test('arm 3 unit argv pins Slice=e2a-oom.slice plus the containment properties', () => {
  const argv = buildMemlowUnitArgv({ payloadPath: '/x/arm3-memlow.mjs', outDir: '/tmp/m', scaleName: 'full' });
  const text = argv.join(' ');
  assert.ok(text.includes('Slice=e2a-oom.slice'), text);
  assert.ok(text.includes('MemoryMax=8G'));
  assert.ok(text.includes('MemoryLow=4G'));
  assert.ok(text.includes('MemorySwapMax=0'));
  assert.ok(text.includes('RuntimeMaxSec=900'));
  assert.ok(text.includes('Delegate=yes'));
});

test('assertCgroupUnderSlice accepts the name-derived e2a-oom.slice subtree and rejects anything else', () => {
  assert.equal(assertCgroupUnderSlice('/e2a.slice/e2a-oom.slice/e2a-3-oomproof.service'), '/e2a.slice/e2a-oom.slice/e2a-3-oomproof.service');
  assert.equal(assertCgroupUnderSlice('e2a-oom.slice/e2a-3-oomproof.service'), '/e2a-oom.slice/e2a-3-oomproof.service');
  assert.throws(() => assertCgroupUnderSlice('/system.slice/e2a-3-oomproof.service'), /guard would trip/);
  assert.throws(() => assertCgroupUnderSlice('/e2a.slice/e2a-3.slice/e2a-3-oomproof.service'), /guard would trip/);
  assert.throws(() => assertCgroupUnderSlice(undefined), /guard would trip/);
  assert.equal(OOM_ARM_SLICE, 'e2a-oom.slice');
});

test('arm 3 assertion module behaves identically', () => {
  assert.doesNotThrow(() => assertMemlowSlice('/e2a.slice/e2a-oom.slice/e2a-3-memlow.service'));
  assert.throws(() => assertMemlowSlice('/system.slice/e2a-3-memlow.service'), /guard would trip/);
});
