#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const agentsPath = path.join(repoRoot, 'AGENTS.md');
const claudePath = path.join(repoRoot, 'CLAUDE.md');

const agents = readFileSync(agentsPath, 'utf8');
const claude = readFileSync(claudePath, 'utf8');

if (agents !== claude) {
  console.error('AGENTS.md and CLAUDE.md differ. Run: npm run docs:sync-agent-guides');
  process.exit(1);
}

console.log('AGENTS.md and CLAUDE.md are byte-identical');
