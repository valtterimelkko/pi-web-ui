import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface HooksConfig {
  hooks: Record<string, HookEntry[]>;
}

export interface HookEntry {
  matcher: string;
  hooks: HookHandler[];
}

export type HookHandler =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'command'; command: string };

const MANAGED_HOOK_NAMES = ['PostToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit'] as const;

export class ClaudeChannelHooksConfig {
  private hookPort: number;
  private claudeSettingsPath: string;

  constructor(cfg: { hookPort: number; claudeSettingsPath?: string }) {
    this.hookPort = cfg.hookPort;
    this.claudeSettingsPath =
      cfg.claudeSettingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  }

  buildHooksConfig(): HooksConfig {
    const baseUrl = `http://127.0.0.1:${this.hookPort}/hook`;
    return {
      hooks: {
        PostToolUse: [
          {
            matcher: '*',
            hooks: [{ type: 'http' as const, url: `${baseUrl}/post-tool-use` }],
          },
        ],
        Stop: [
          {
            matcher: '*',
            hooks: [{ type: 'http' as const, url: `${baseUrl}/stop` }],
          },
        ],
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'http' as const, url: `${baseUrl}/session-start` }],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '*',
            hooks: [{ type: 'http' as const, url: `${baseUrl}/user-prompt` }],
          },
        ],
      },
    };
  }

  async writeHooksConfig(): Promise<void> {
    const dir = path.dirname(this.claudeSettingsPath);
    await fs.mkdir(dir, { recursive: true });

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(this.claudeSettingsPath, 'utf-8');
      existing = JSON.parse(raw);
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        throw new Error('not an object');
      }
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        // file doesn't exist yet — that's fine
      } else {
        const backupPath = this.claudeSettingsPath + '.bak';
        await fs.writeFile(backupPath, typeof (await fs.readFile(this.claudeSettingsPath, 'utf-8').catch(() => '')) === 'string' ? '' : '', 'utf-8').catch(() => {});
        existing = {};
      }
    }

    const hooksConfig = this.buildHooksConfig();
    const merged = { ...existing, hooks: hooksConfig.hooks };
    await fs.writeFile(this.claudeSettingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  async removeHooksConfig(): Promise<void> {
    let existing: Record<string, unknown>;
    try {
      const raw = await fs.readFile(this.claudeSettingsPath, 'utf-8');
      existing = JSON.parse(raw);
    } catch {
      return;
    }

    if (typeof existing !== 'object' || existing === null) return;

    const hooks = existing.hooks as Record<string, unknown> | undefined;
    if (hooks && typeof hooks === 'object') {
      for (const name of MANAGED_HOOK_NAMES) {
        if (name in hooks) {
          const entries = hooks[name] as HookEntry[] | undefined;
          if (Array.isArray(entries)) {
            const filtered = entries.filter((entry) => !this.isManagedEntry(entry));
            if (filtered.length > 0) {
              hooks[name] = filtered;
            } else {
              delete hooks[name];
            }
          } else {
            delete hooks[name];
          }
        }
      }
      if (Object.keys(hooks).length === 0) {
        delete existing.hooks;
      }
    }

    await fs.writeFile(this.claudeSettingsPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
  }

  private isManagedEntry(entry: HookEntry): boolean {
    if (!entry || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (h) => h.type === 'http' && typeof h.url === 'string' && h.url.includes(`127.0.0.1:${this.hookPort}`)
    );
  }
}
