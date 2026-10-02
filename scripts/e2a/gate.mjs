#!/usr/bin/env node
// E2a-3 stress gate CLI — thin wrapper over lib/gate.mjs (STRESS-GATE.md).
//   --check | --acquire --arm A [--expected-end-utc ISO] | --release | --lock-owner
import { cli } from './lib/gate.mjs';

cli().catch((err) => {
  console.error(`[gate] ${err.message}`);
  process.exitCode = 1;
});
