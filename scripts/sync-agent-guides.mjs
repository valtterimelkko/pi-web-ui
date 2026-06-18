#!/usr/bin/env node
import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const source = path.join(repoRoot, 'AGENTS.md');
const target = path.join(repoRoot, 'CLAUDE.md');

cpSync(source, target);
console.log('Synced CLAUDE.md from AGENTS.md');
