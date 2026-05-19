#!/usr/bin/env npx tsx
/**
 * Claude Channel Live Validation Script
 *
 * Connects to the Pi Web UI WebSocket API, creates a Claude channel session,
 * sends prompts, and verifies that streaming events, tool visibility,
 * heartbeats, and session info reporters work correctly.
 *
 * Usage:
 *   npx tsx scripts/test-claude-channel.ts [--port 3456] [--verbose] [--password <pw>]
 *
 * If --password is not provided, reads from AUTH_PASSWORD env var.
 */

import WebSocket from 'ws';
import http from 'node:http';
import { randomUUID } from 'crypto';

// ── Configuration ────────────────────────────────────────────────────────────

const HOST = '127.0.0.1';
const PORT = parseInt(process.env.TEST_PORT || '3456', 10);
const WS_URL = process.env.TEST_WS_URL || `ws://${HOST}:${PORT}/ws`;
const VERBOSE = process.argv.includes('--verbose');
const passIdx = process.argv.indexOf('--password');
const AUTH_PASSWORD = passIdx >= 0 ? process.argv[passIdx + 1] : (process.env.AUTH_PASSWORD || 'admin');
const originIdx = process.argv.indexOf('--origin');
const WS_ORIGIN = originIdx >= 0 ? process.argv[originIdx + 1] : (process.env.TEST_ORIGIN || 'https://pi.letsautomate.work');
const TIMEOUT_MS = 120_000;
const SLOW_THRESHOLD_MS = 60_000;

// ── HTTP Cookie Login ────────────────────────────────────────────────────────

async function loginAndGetCookies(): Promise<string> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ password: AUTH_PASSWORD });
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Login failed: ${res.statusCode} ${body}`));
          return;
        }
        const setCookie = res.headers['set-cookie'];
        if (!setCookie || setCookie.length === 0) {
          reject(new Error('No cookies in login response'));
          return;
        }
        // Extract cookie values
        const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
        console.log(`  Login successful, got cookies`);
        resolve(cookieStr);
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── Types ────────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

interface StreamEvent {
  type: string;
  sessionId?: string;
  event?: { type: string; [key: string]: unknown };
  stats?: { lastActivityAt?: number; [key: string]: unknown };
  [key: string]: unknown;
}

// ── WebSocket Client ─────────────────────────────────────────────────────────

class TestClient {
  private ws: WebSocket | null = null;
  private events: StreamEvent[] = [];
  private sessionId: string | null = null;
  private results: TestResult[] = [];
  private messageQueue: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private connected = false;
  private authenticated = false;

  private addResult(name: string, passed: boolean, details: string) {
    this.results.push({ name, passed, details });
    if (VERBOSE) console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}: ${details}`);
  }

  async connect(): Promise<void> {
    // Login via HTTP first to get the auth cookie
    const cookies = await loginAndGetCookies();

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL, {
        headers: {
          Cookie: cookies,
          Origin: WS_ORIGIN,
        },
      });
      this.ws = ws;

      ws.on('open', () => {
        this.connected = true;
        // Poll for authenticated message
        let attempts = 0;
        const check = setInterval(() => {
          attempts++;
          if (this.authenticated) {
            clearInterval(check);
            resolve();
          } else if (attempts > 25) {
            clearInterval(check);
            reject(new Error('Auth timeout — no authenticated message received'));
          }
        }, 200);
      });

      ws.on('message', (data: WebSocket.Data) => {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString()) as StreamEvent;
        this.events.push(msg);

        if (msg.type === 'authenticated') {
          this.authenticated = true;
        }

        // Process queued resolves
        if (['session_event', 'agent_end', 'session_switched', 'session_info', 'error'].includes(msg.type)) {
          while (this.messageQueue.length > 0) {
            const q = this.messageQueue.shift()!;
            q.resolve();
          }
        }
      });

      ws.on('error', (err) => {
        if (!this.connected) reject(err);
        else console.error('[TestClient] WS error:', err.message);
      });

      ws.on('close', () => {
        this.connected = false;
        while (this.messageQueue.length > 0) {
          this.messageQueue.shift()!.reject(new Error('WS closed'));
        }
      });

      setTimeout(() => { if (!this.authenticated) reject(new Error('Auth timeout')); }, 10000);
    });
  }

  async send(msg: Record<string, unknown>): Promise<void> {
    if (!this.ws || !this.connected) throw new Error('Not connected');
    this.ws.send(JSON.stringify(msg));
    this.events.length = 0;
    await this.waitForEvent(['session_event', 'session_switched', 'session_info', 'error', 'agent_end'], TIMEOUT_MS);
  }

  async waitForEvent(types: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.events.find(e => types.includes(e.type));
      if (match) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for events: ${types.join(', ')}`);
  }

  async waitForSessionEvent(eventType: string, timeoutMs: number): Promise<StreamEvent | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const e of this.events) {
        if (e.type === 'session_event' && e.event?.type === eventType) {
          return e;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  }

  findEvents(type: string, subType?: string): StreamEvent[] {
    if (subType) {
      return this.events.filter(e => e.type === type && e.event?.type === subType);
    }
    return this.events.filter(e => e.type === type);
  }

  hasEvents(type: string, subType: string): boolean {
    return this.findEvents(type, subType).length > 0;
  }

  clearEvents() { this.events.length = 0; }

  getSessionId(): string { return this.sessionId!; }

  getResults(): TestResult[] { return this.results; }

  async createClaudeSession(): Promise<void> {
    this.clearEvents();
    this.ws!.send(JSON.stringify({ type: 'new_session', sdkType: 'claude' }));
    await this.waitForEvent(['session_created', 'error'], 15000);

    const created = this.events.find(e => e.type === 'session_created');
    if (!created) throw new Error('No session_created received');
    this.sessionId = created.sessionId!;
    this.addResult('create_session', true, `Created session ${this.sessionId}`);

    // Switch to the newly created session
    this.clearEvents();
    this.ws!.send(JSON.stringify({ type: 'switch_session', sessionPath: this.sessionId }));
    await this.waitForEvent(['session_switched', 'error'], 10000);
    const switched = this.events.find(e => e.type === 'session_switched');
    if (switched) {
      this.addResult('switch_session', true, `Switched to ${this.sessionId}`);
    } else {
      this.addResult('switch_session', false, 'No session_switched after switching');
    }
  }

  async sendPrompt(prompt: string, waitForEnd = true): Promise<void> {
    this.clearEvents();
    this.ws!.send(JSON.stringify({ type: 'prompt', sessionId: this.sessionId, message: prompt }));

    // Wait for agent_start (longer timeout for follow-ups where PTY may be settling)
    const started = await this.waitForSessionEvent('agent_start', 35000);
    if (started) {
      this.addResult('prompt:agent_start', true, `agent_start received for "${prompt.slice(0, 40)}"`);
    } else {
      this.addResult('prompt:agent_start', false, `No agent_start after 15s for "${prompt.slice(0, 40)}"`);
      return;
    }

    if (waitForEnd) {
      const ended = await this.waitForSessionEvent('agent_end', TIMEOUT_MS);
      if (ended) {
        this.addResult('prompt:agent_end', true, 'agent_end received');
      } else {
        this.addResult('prompt:agent_end', false, 'No agent_end within 2 min');
      }
    }
  }

  async requestSessionInfo(): Promise<StreamEvent | null> {
    this.clearEvents();
    this.ws!.send(JSON.stringify({ type: 'get_session_info' }));
    await this.waitForEvent(['session_info', 'error'], 10000);
    return this.events.find(e => e.type === 'session_info') || null;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ── Test Suite ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('=== Claude Channel Live Validation ===\n');
  console.log(`WebSocket: ${WS_URL}`);
  console.log('');

  const client = new TestClient();

  try {
    // ── 1. Connect & Auth ─────────────────────────────────────────────────
    console.log('1. Connecting and authenticating...');
    await client.connect();
    client.addResult('auth', true, 'Connected and authenticated');

    // ── 2. Create Claude Session ──────────────────────────────────────────
    console.log('2. Creating Claude channel session...');
    await client.createClaudeSession();

    // ── 3. Send a simple prompt ───────────────────────────────────────────
    console.log('3. Sending test prompt (quick task)...');
    await client.sendPrompt(
      'Run a single bash command: echo "pi-web-ui-test-ok" and tell me the output. Do not do anything else.',
      true,
    );

    // Check for tool events
    const toolStarts = client.findEvents('session_event', 'tool_execution_start');
    const toolEnds = client.findEvents('session_event', 'tool_execution_end');
    client.addResult(
      'tool_visibility',
      toolStarts.length > 0 || toolEnds.length > 0,
      `Tool starts: ${toolStarts.length}, Tool ends: ${toolEnds.length}`,
    );

    // Check for message updates (text response)
    const messageUpdates = client.findEvents('session_event', 'message_update');
    client.addResult(
      'text_response',
      messageUpdates.length > 0,
      `Message updates: ${messageUpdates.length}`,
    );

    // Check for stream_activity (heartbeat pings)
    const streamActivity = client.findEvents('session_event', 'stream_activity');
    client.addResult(
      'stream_activity',
      streamActivity.length > 0,
      `stream_activity pings: ${streamActivity.length}`,
    );

    // Check tool name enrichment if available
    const activityWithTool = streamActivity.filter(
      e => !!(e.event as Record<string, unknown>)?.currentToolName,
    );
    if (activityWithTool.length > 0) {
      const toolName = (activityWithTool[0].event as Record<string, unknown>).currentToolName;
      client.addResult('tool_name_in_activity', true, `Tool name in activity: ${toolName}`);
    } else {
      // Not a failure — tool names depend on Claude calling send_event
      if (VERBOSE) {
        client.addResult('tool_name_in_activity', true, 'No tool name in activity (Claude may not have called send_event)');
      } else {
        client.addResult('tool_name_in_activity', true, 'Skipped (depends on Claude cooperation)');
      }
    }

    // ── 4. Session Info ───────────────────────────────────────────────────
    console.log('4. Testing session info...');
    const info = await client.requestSessionInfo();
    if (info?.stats) {
      client.addResult('session_info', true, `Got session info: ${info.stats.userMessages || 0} user msgs`);
      const lastActivity = info.stats.lastActivityAt;
      if (lastActivity !== undefined && lastActivity !== null) {
        const ago = Date.now() - (lastActivity as number);
        client.addResult(
          'lastActivityAt',
          true,
          `lastActivityAt: ${Math.round(ago / 1000)}s ago`,
        );
      } else {
        client.addResult('lastActivityAt', false, 'lastActivityAt not present in session info');
      }
    } else {
      client.addResult('session_info', false, 'No session info received');
    }

    // ── 5. Follow-up prompt ───────────────────────────────────────────────
    console.log('5. Sending follow-up prompt...');
    // Give the PTY time to fully settle (idle detection needs 12s quiet window).
    await new Promise(r => setTimeout(r, 5000));
    await client.sendPrompt(
      'Run: echo "follow-up-ok". That is all.',
      true,
    );

    const followUpToolStarts = client.findEvents('session_event', 'tool_execution_start');
    client.addResult(
      'followup_tool_visibility',
      followUpToolStarts.length > 0,
      `Follow-up tool starts: ${followUpToolStarts.length}`,
    );

    // ── 6. Summary ────────────────────────────────────────────────────────
    console.log('\n=== Results ===\n');
    let passCount = 0;
    let failCount = 0;
    for (const r of client.getResults()) {
      if (r.passed) {
        passCount++;
        if (!VERBOSE) console.log(`  ✅ ${r.name}: ${r.details}`);
      } else {
        failCount++;
        console.log(`  ❌ ${r.name}: ${r.details}`);
      }
    }

    console.log(`\n${passCount} passed, ${failCount} failed, ${client.getResults().length} total`);

    if (failCount > 0) {
      console.log('\n⚠️  Some tests failed. Review the details above.');
    } else {
      console.log('\n✅ All tests passed!');
    }

    // ── 7. Optional: prompt_ack verification ──────────────────────────────
    // Check server logs for prompt_ack
    console.log('\n8. Checking prompt_ack in server logs...');
    const { execSync } = await import('node:child_process');
    try {
      const logOutput = execSync(
        `journalctl -u pi-web-ui --since "5 minutes ago" --no-pager 2>/dev/null | grep -c 'Prompt ack received' || echo 0`,
        { encoding: 'utf-8', timeout: 5000 },
      ).trim();
      const ackCount = parseInt(logOutput, 10) || 0;
      client.addResult(
        'prompt_ack',
        ackCount >= 2, // At least 2 acks (one per prompt)
        `prompt_ack count in logs: ${ackCount}`,
      );
    } catch {
      client.addResult('prompt_ack', false, 'Could not check logs');
    }

    // Print updated results
    console.log('');
    for (const r of client.getResults().slice(-1)) {
      console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}: ${r.details}`);
    }

  } catch (err) {
    console.error('Test suite error:', err instanceof Error ? err.message : String(err));
    client.addResult('suite', false, `Error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.disconnect();
  }

  // Exit with appropriate code
  const failed = client.getResults().filter(r => !r.passed).length;
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
