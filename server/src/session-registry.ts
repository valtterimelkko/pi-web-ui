import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { SdkType } from '@pi-web-ui/shared';

export interface RegistryEntry {
  id: string;              // Internal UUID
  sdkType: SdkType;        // 'pi' | 'claude'
  path: string;            // For Pi: session path; for Claude: our JSONL file path
  claudeSessionId?: string; // For Claude: the --session-id
  opencodeSessionId?: string; // For OpenCode: the OpenCode server session ID
  cwd: string;
  model?: string;
  firstMessage: string;
  messageCount: number;
  createdAt: string;       // ISO string
  lastActivity: string;    // ISO string
  status: 'idle' | 'running' | 'error';
}

export interface SessionRegistry {
  version: number;
  updatedAt: string;
  entries: RegistryEntry[];
}

const REGISTRY_VERSION = 1;

export class SessionRegistryManager {
  private registryPath: string;
  private registry: SessionRegistry | null = null;

  constructor(registryPath: string) {
    this.registryPath = registryPath;
  }

  async load(): Promise<SessionRegistry> {
    if (this.registry !== null) {
      return this.registry;
    }

    try {
      const raw = await fs.readFile(this.registryPath, 'utf-8');
      const parsed = JSON.parse(raw) as SessionRegistry;
      // Basic validation
      if (typeof parsed.version !== 'number' || !Array.isArray(parsed.entries)) {
        throw new Error('Invalid registry format');
      }
      this.registry = parsed;
      return this.registry;
    } catch (err: unknown) {
      const isNotFound = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!isNotFound) {
        console.warn('[SessionRegistry] Failed to load registry, starting fresh:', err instanceof Error ? err.message : String(err));
      }
      this.registry = {
        version: REGISTRY_VERSION,
        updatedAt: new Date().toISOString(),
        entries: [],
      };
      return this.registry;
    }
  }

  async save(): Promise<void> {
    if (this.registry === null) {
      return;
    }

    this.registry.updatedAt = new Date().toISOString();

    const dir = path.dirname(this.registryPath);
    await fs.mkdir(dir, { recursive: true });

    const tmpPath = `${this.registryPath}.tmp`;
    try {
      await fs.writeFile(tmpPath, JSON.stringify(this.registry, null, 2), 'utf-8');
      await fs.rename(tmpPath, this.registryPath);
    } catch (err) {
      // Clean up tmp file on failure
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  async get(id: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.id === id);
  }

  async getByPath(sessionPath: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.path === sessionPath);
  }

  async getByClaudeSessionId(claudeSessionId: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.claudeSessionId === claudeSessionId);
  }

  async getByOpencodeSessionId(opencodeSessionId: string): Promise<RegistryEntry | undefined> {
    const registry = await this.load();
    return registry.entries.find(e => e.opencodeSessionId === opencodeSessionId);
  }

  async upsert(entry: Partial<RegistryEntry> & { sdkType: SdkType; cwd: string }): Promise<RegistryEntry> {
    const registry = await this.load();

    // Find existing entry by id, path, or claudeSessionId
    let existingIndex = -1;
    if (entry.id) {
      existingIndex = registry.entries.findIndex(e => e.id === entry.id);
    }
    if (existingIndex === -1 && entry.path) {
      existingIndex = registry.entries.findIndex(e => e.path === entry.path);
    }
    if (existingIndex === -1 && entry.claudeSessionId) {
      existingIndex = registry.entries.findIndex(e => e.claudeSessionId === entry.claudeSessionId);
    }
    if (existingIndex === -1 && entry.opencodeSessionId) {
      existingIndex = registry.entries.findIndex(e => e.opencodeSessionId === entry.opencodeSessionId);
    }

    const now = new Date().toISOString();

    if (existingIndex !== -1) {
      // Update existing entry
      const existing = registry.entries[existingIndex];
      const updated: RegistryEntry = {
        ...existing,
        ...entry,
        id: existing.id, // preserve original ID
        updatedAt: now,
        lastActivity: entry.lastActivity ?? now,
      } as RegistryEntry;
      registry.entries[existingIndex] = updated;
      await this.save();
      return updated;
    } else {
      // Create new entry
      const newEntry: RegistryEntry = {
        id: entry.id ?? randomUUID(),
        sdkType: entry.sdkType,
        path: entry.path ?? '',
        claudeSessionId: entry.claudeSessionId,
        cwd: entry.cwd,
        model: entry.model,
        firstMessage: entry.firstMessage ?? '',
        messageCount: entry.messageCount ?? 0,
        createdAt: entry.createdAt ?? now,
        lastActivity: entry.lastActivity ?? now,
        status: entry.status ?? 'idle',
      };
      registry.entries.push(newEntry);
      await this.save();
      return newEntry;
    }
  }

  async updateStatus(id: string, status: RegistryEntry['status']): Promise<void> {
    const registry = await this.load();
    const entry = registry.entries.find(e => e.id === id);
    if (entry) {
      entry.status = status;
      entry.lastActivity = new Date().toISOString();
      await this.save();
    } else {
      console.warn(`[SessionRegistry] updateStatus: entry not found for id=${id}`);
    }
  }

  async listAll(): Promise<RegistryEntry[]> {
    const registry = await this.load();
    return [...registry.entries];
  }

  async listBySdkType(sdkType: SdkType): Promise<RegistryEntry[]> {
    const registry = await this.load();
    return registry.entries.filter(e => e.sdkType === sdkType);
  }

  async delete(id: string): Promise<void> {
    const registry = await this.load();
    const before = registry.entries.length;
    registry.entries = registry.entries.filter(e => e.id !== id);
    if (registry.entries.length !== before) {
      await this.save();
    }
  }

  async rebuildFromPiSessions(piSessionDir: string): Promise<void> {
    let sessionPaths: string[];
    try {
      const entries = await fs.readdir(piSessionDir, { withFileTypes: true });
      // Pi sessions are directories under piSessionDir
      sessionPaths = entries
        .filter(e => e.isDirectory())
        .map(e => path.join(piSessionDir, e.name));
    } catch (err) {
      console.warn('[SessionRegistry] rebuildFromPiSessions: could not read session dir:', err instanceof Error ? err.message : String(err));
      return;
    }

    for (const sessionPath of sessionPaths) {
      const existing = await this.getByPath(sessionPath);
      if (existing) {
        continue; // Already in registry
      }

      // Try to read basic info from the session directory
      let firstMessage = '';
      let messageCount = 0;
      let createdAt = new Date().toISOString();
      let lastActivity = new Date().toISOString();

      try {
        const stat = await fs.stat(sessionPath);
        createdAt = stat.birthtime.toISOString();
        lastActivity = stat.mtime.toISOString();
      } catch { /* ignore */ }

      // Try to read the first JSONL file for firstMessage
      try {
        const files = await fs.readdir(sessionPath);
        const jsonlFile = files.find(f => f.endsWith('.jsonl'));
        if (jsonlFile) {
          const content = await fs.readFile(path.join(sessionPath, jsonlFile), 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);
          messageCount = lines.length;
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              if (msg.role === 'user' && msg.content) {
                const text = typeof msg.content === 'string'
                  ? msg.content
                  : Array.isArray(msg.content)
                    ? msg.content.map((c: { text?: string }) => c.text ?? '').join('')
                    : '';
                if (text.trim()) {
                  firstMessage = text.slice(0, 200);
                  break;
                }
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }

      await this.upsert({
        sdkType: 'pi',
        path: sessionPath,
        cwd: sessionPath, // fallback; Pi sessions store cwd in session metadata
        firstMessage,
        messageCount,
        createdAt,
        lastActivity,
        status: 'idle',
      });
    }

    console.log(`[SessionRegistry] rebuildFromPiSessions: processed ${sessionPaths.length} session(s) from ${piSessionDir}`);
  }
}

// Singleton instance
let registryInstance: SessionRegistryManager | null = null;

export function getSessionRegistry(registryPath?: string): SessionRegistryManager {
  if (registryInstance === null) {
    if (!registryPath) {
      throw new Error('getSessionRegistry: registryPath required for first call');
    }
    registryInstance = new SessionRegistryManager(registryPath);
  }
  return registryInstance;
}
