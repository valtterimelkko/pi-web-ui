/**
 * End-to-end thinking-level validation for OpenCode/GLM-5.2.
 *
 * Exercises the FULL Pi Web UI backend pipeline:
 *   Internal API → opencode-service → config-file bridge → server recycle
 *   → prompt → Z.AI API → response with/without reasoning
 *
 * Verifies that the thinking level actually affects model reasoning output.
 */

import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import { readFileSync, readFileSync as rf } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import http from 'node:http';

const SOCKET_PATH = `${os.homedir()}/.pi-web-ui/internal-api.sock`;
const TOKEN_PATH = `${os.homedir()}/.pi-web-ui/internal-api-token`;
const OPENCODE_CONFIG = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
const REGISTRY_PATH = path.join(os.homedir(), '.pi-web-ui', 'session-registry.json');

const token = readFileSync(TOKEN_PATH, 'utf8').trim();
const client = new InternalApiClient({ socketPath: SOCKET_PATH, token });

const REASONING_PROMPT =
  'Solve step by step: A farmer has 100 meters of fencing to enclose a rectangular field along a river (no fence needed on the river side). What dimensions maximize the enclosed area? Show your work.';

function readOcConfig(): Record<string, any> {
  try { return JSON.parse(rf(OPENCODE_CONFIG, 'utf8')); } catch { return {}; }
}

function findThinkingOption(cfg: Record<string, any>): { type: string } | null {
  for (const prov of Object.values(cfg.provider ?? {})) {
    for (const model of Object.values((prov as any).models ?? {})) {
      const thinking = (model as any).options?.thinking;
      if (thinking && typeof thinking === 'object' && 'type' in thinking) return thinking as { type: string };
    }
  }
  return null;
}

function getOcSessionId(piSessionId: string): string | null {
  try {
    const reg = JSON.parse(rf(REGISTRY_PATH, 'utf8'));
    for (const s of reg.sessions ?? []) {
      if (s.id === piSessionId) return s.opencodeSessionId ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

/** Query the OpenCode server for the most recent session in our CWD. */
async function getLatestOcSessionId(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: 4097,
      path: '/session',
      headers: {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c.toString(); });
      res.on('end', () => {
        try {
          const sessions = JSON.parse(raw) as any[];
          console.log(`   [debug] OpenCode server has ${sessions.length} sessions`);
          if (sessions.length > 0) {
            const sorted = sessions.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
            const latest = sorted[0];
            console.log(`   [debug] Latest: id=${latest.id}, dir=${latest.directory}, created=${latest.time?.created}`);
          }
          // Sort by creation time descending, pick latest
          const sorted = sessions.sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0));
          resolve(sorted[0]?.id ?? null);
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
  });
}

/** Query OpenCode server directly for the last assistant message. */
async function getLastAssistantMessage(ocSessionId: string): Promise<{ reasoningTokens: number; outputTokens: number; hasReasoningPart: boolean; reasoningChars: number }> {
  return new Promise((resolve, reject) => {
    const req = http.get({
      hostname: '127.0.0.1',
      port: 4097,
      path: `/session/${ocSessionId}/message?directory=${encodeURIComponent(process.cwd())}`,
      headers: {},
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c.toString(); });
      res.on('end', () => {
        try {
          const msgs = JSON.parse(raw) as any[];
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i];
            if (m?.info?.role !== 'assistant') continue;
            const tokens = m.info.tokens ?? {};
            const parts = m.parts ?? [];
            let reasoningChars = 0;
            let hasReasoningPart = false;
            for (const p of parts) {
              if (p?.type === 'reasoning') {
                hasReasoningPart = true;
                reasoningChars += (p.text ?? '').length;
              }
            }
            resolve({
              reasoningTokens: tokens.reasoning ?? 0,
              outputTokens: tokens.output ?? 0,
              hasReasoningPart,
              reasoningChars,
            });
            return;
          }
          resolve({ reasoningTokens: 0, outputTokens: 0, hasReasoningPart: false, reasoningChars: 0 });
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
  });
}

async function main() {
  console.log('=== End-to-End OpenCode Thinking-Level Validation ===\n');

  // 1. Create session
  console.log('1. Creating OpenCode session via Internal API...');
  const session = await client.createSession({
    runtime: 'opencode',
    cwd: process.cwd(),
    source: 'e2e-thinking-validation',
  });
  console.log(`   Pi session: ${session.sessionId}`);

  try {
    // 2. Set model
    console.log('\n2. Setting model to glm-5.2...');
    await client.controlSession(session.sessionId, { action: 'set_model', modelId: 'glm-5.2' });
    console.log('   OK');

    // 3. Set thinking OFF
    console.log('\n3. Setting thinking level to OFF...');
    await client.controlSession(session.sessionId, { action: 'set_thinking_level', level: 'off' });
    const cfgOff = readOcConfig();
    console.log(`   Config: thinking=${JSON.stringify(findThinkingOption(cfgOff))} (expected null/removed)`);

    console.log('   Waiting for server recycle...');
    await new Promise(r => setTimeout(r, 10000));

    // 4. Send prompt with thinking OFF
    console.log('\n4. Sending prompt with thinking OFF...');
    const eventsOff = await client.promptStream(session.sessionId, {
      message: REASONING_PROMPT,
      verbosity: 'full',
      mode: 'prompt',
    });
    console.log(`   Received ${eventsOff.length} events, agent_end=${eventsOff.filter(e => e.type === 'agent_end').length}`);

    let ocSessionId = getOcSessionId(session.sessionId);

    // Extract from agent_start event data (most reliable)
    if (!ocSessionId) {
      const agentStart = eventsOff.find(e => e.type === 'agent_start');
      const data = agentStart?.data as Record<string, unknown> | undefined;
      ocSessionId = (data?.opencodeSessionId as string) ?? null;
    }

    // Fallback: query the OpenCode server for the most recent session
    if (!ocSessionId) {
      ocSessionId = await getLatestOcSessionId();
    }
    console.log(`   OpenCode session ID: ${ocSessionId}`);

    if (!ocSessionId) throw new Error('Could not find OpenCode session ID in registry');

    await new Promise(r => setTimeout(r, 3000));
    const resultOff = await getLastAssistantMessage(ocSessionId);
    console.log(`   Result: reasoningTokens=${resultOff.reasoningTokens}, hasReasoningPart=${resultOff.hasReasoningPart}, reasoningChars=${resultOff.reasoningChars}`);

    // 5. Set thinking HIGH
    console.log('\n5. Setting thinking level to HIGH...');
    await client.controlSession(session.sessionId, { action: 'set_thinking_level', level: 'high' });
    const cfgHigh = readOcConfig();
    console.log(`   Config: thinking=${JSON.stringify(findThinkingOption(cfgHigh))} (expected {"type":"enabled"})`);

    console.log('   Waiting for server recycle...');
    await new Promise(r => setTimeout(r, 10000));

    // 6. Send same prompt with thinking HIGH
    console.log('\n6. Sending same prompt with thinking HIGH...');
    const eventsHigh = await client.promptStream(session.sessionId, {
      message: REASONING_PROMPT,
      verbosity: 'full',
      mode: 'prompt',
    });
    console.log(`   Received ${eventsHigh.length} events, agent_end=${eventsHigh.filter(e => e.type === 'agent_end').length}`);

    await new Promise(r => setTimeout(r, 3000));
    const resultHigh = await getLastAssistantMessage(ocSessionId);
    console.log(`   Result: reasoningTokens=${resultHigh.reasoningTokens}, hasReasoningPart=${resultHigh.hasReasoningPart}, reasoningChars=${resultHigh.reasoningChars}`);

    // 7. Verdict
    console.log('\n========== VERDICT ==========');
    console.log(`Thinking OFF  → hasReasoningPart=${resultOff.hasReasoningPart}, reasoningChars=${resultOff.reasoningChars}`);
    console.log(`Thinking HIGH → hasReasoningPart=${resultHigh.hasReasoningPart}, reasoningChars=${resultHigh.reasoningChars}`);

    const pass = !resultOff.hasReasoningPart && resultHigh.hasReasoningPart;
    if (pass) {
      console.log('\n✅ PASS: Thinking OFF produced NO reasoning, HIGH produced reasoning.');
      console.log('   The thinking level setting correctly controls model reasoning through the full Pi Web UI pipeline.');
    } else if (resultOff.hasReasoningPart && resultHigh.hasReasoningPart) {
      console.log('\n❌ FAIL: Both settings produced reasoning. The "off" setting did not disable reasoning.');
    } else if (!resultOff.hasReasoningPart && !resultHigh.hasReasoningPart) {
      console.log('\n❌ FAIL: Neither setting produced reasoning. The "high" setting did not enable reasoning.');
    } else {
      console.log('\n❌ FAIL: Unexpected — OFF had reasoning but HIGH did not.');
    }

  } finally {
    console.log('\nCleaning up...');
    await client.deleteSession(session.sessionId).catch(() => {});
    console.log('Done.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
