/**
 * Isolated Pi agent dir for the disposable server: the REAL extension set as
 * byte-identical copies (goal engine and auto-compact-75 included — the
 * owner's real child pattern), settings.json verbatim, and ONLY the `zai`
 * credential from auth.json / models.json (COMMON-BRIEF-e2.md: "Copy only
 * the zai credential").
 *
 * The extension loader refuses symlinks, so everything is copied with
 * dereference:true — the copies are regular files, byte-identical to the
 * production originals (asserted below by content hash on a sample).
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { homedir } from 'node:os';

export const PRODUCTION_AGENT_DIR = path.join(homedir(), '.pi', 'agent');

/** Provider names that must NOT appear anywhere in the filtered credentials. */
const NON_ZAI_PROVIDERS = [
  'github-copilot', 'anthropic', 'google-antigravity', 'openai-codex', 'deepseek',
  'nvidia', 'openrouter', 'google', 'opencode-go', 'glm-coding', 'kimi-subscription', 'clinepass',
];

export interface AgentDirResult {
  agentDir: string;
  extensionFileCount: number;
  extensionByteCount: number;
  credentialProviders: string[];
  assertions: string[];
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function assertNoSymlinks(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (lstatSync(full).isSymbolicLink()) {
        throw new Error(`Isolated agent dir contains a symlink (loader refuses them): ${full}`);
      }
      if (statSync(full).isDirectory()) stack.push(full);
    }
  }
}

/**
 * Materialising recursive copy: every source entry becomes a REGULAR file/dir
 * under dest. Symlinks are resolved (realpath) and their CONTENT copied, so
 * the tree is byte-identical and contains no symlinks (the extension loader
 * refuses symlinks). cpSync's dereference mode chokes on the production
 * tree's external-dir symlinks (e.g. extensions/agent-os-inject →
 * /root/pi-enhancement/agent-os-inject), hence the manual walk.
 */
function materialiseCopy(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = path.join(srcDir, entry);
    const dst = path.join(destDir, entry);
    const real = realpathSync(src); // follow symlinks (internal or external)
    const st = statSync(real);
    if (st.isDirectory()) {
      materialiseCopy(real, dst);
    } else if (st.isFile()) {
      copyFileSync(real, dst);
    } else {
      throw new Error(`Unsupported extension entry (not file/dir): ${src}`);
    }
  }
}

/** Build the isolated agent dir. Read-only on the production source. */
export function buildCrashAgentDir(destDir: string, sourceDir: string = PRODUCTION_AGENT_DIR): AgentDirResult {
  if (path.resolve(destDir) === path.resolve(sourceDir)) {
    throw new Error(`Refusing to build the isolated agent dir on top of the production agent dir: ${destDir}`);
   }
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  const assertions: string[] = [];

  // 1. Extensions: the real set, byte-identical (materialised regular files).
  const extensionsSource = path.join(sourceDir, 'extensions');
  if (!existsSync(extensionsSource)) throw new Error(`No production extensions dir at ${extensionsSource}`);
  materialiseCopy(extensionsSource, path.join(destDir, 'extensions'));
  assertNoSymlinks(path.join(destDir, 'extensions'));

  // Byte-identity sample: hash every file in both trees (they are small, ~1.4 MB).
  let fileCount = 0;
  let byteCount = 0;
  let mismatched = 0;
  const stackSource = [extensionsSource];
  while (stackSource.length > 0) {
    const dir = stackSource.pop() as string;
    for (const entry of readdirSync(dir)) {
      const src = path.join(dir, entry);
      const rel = path.relative(extensionsSource, src);
      const dst = path.join(destDir, 'extensions', rel);
      if (statSync(src).isDirectory()) {
        stackSource.push(src);
        continue;
      }
      fileCount += 1;
      const srcBuf = readFileSync(src);
      byteCount += srcBuf.length;
      if (!existsSync(dst) || sha256(srcBuf) !== sha256(readFileSync(dst))) mismatched += 1;
    }
  }
  if (mismatched !== 0) throw new Error(`${mismatched} extension copies are not byte-identical to production`);
  assertions.push(`extensions byte-identical: ${fileCount} files, ${byteCount} bytes, 0 mismatches`);

  // 2. settings.json verbatim (defaultProvider zai / defaultModel glm-5.3 live here).
  const settingsSrc = path.join(sourceDir, 'settings.json');
  if (existsSync(settingsSrc)) {
    writeFileSync(path.join(destDir, 'settings.json'), readFileSync(realpathSync(settingsSrc)));
    assertions.push('settings.json copied verbatim');
  }

  // 3. auth.json filtered to zai only (never copy other providers' credentials).
  const authSrc = JSON.parse(readFileSync(path.join(sourceDir, 'auth.json'), 'utf8')) as Record<string, unknown>;
  const authFiltered: Record<string, unknown> = {};
  if (typeof authSrc.zai === 'object' && authSrc.zai !== null) authFiltered.zai = authSrc.zai;
  writeFileSync(path.join(destDir, 'auth.json'), `${JSON.stringify(authFiltered, null, 2)}\n`, { mode: 0o600 });
  assertions.push(`auth.json filtered: providers=[${Object.keys(authFiltered).join(', ')}]`);

  // 4. models.json filtered to the zai provider entry (model overrides; the
  // zai entry itself carries no key — the credential lives in auth.json).
  const modelsSrc = JSON.parse(readFileSync(path.join(sourceDir, 'models.json'), 'utf8')) as Record<string, unknown>;
  const providersSrc = typeof modelsSrc.providers === 'object' && modelsSrc.providers !== null
    ? (modelsSrc.providers as Record<string, unknown>)
    : {};
  const modelsFiltered: Record<string, unknown> = { providers: {} };
  if (typeof providersSrc.zai === 'object' && providersSrc.zai !== null) {
    (modelsFiltered.providers as Record<string, unknown>).zai = providersSrc.zai;
  }
  writeFileSync(path.join(destDir, 'models.json'), `${JSON.stringify(modelsFiltered, null, 2)}\n`, { mode: 0o600 });
  assertions.push('models.json filtered: providers=[zai]');

  // 5. Assert no non-zai provider material leaked into the filtered files.
  const authText = readFileSync(path.join(destDir, 'auth.json'), 'utf8');
  const modelsText = readFileSync(path.join(destDir, 'models.json'), 'utf8');
  const leaked = NON_ZAI_PROVIDERS.filter((p) => authText.includes(`"${p}"`) || modelsText.includes(`"${p}"`));
  if (leaked.length > 0) throw new Error(`Non-zai provider material leaked into the isolated agent dir: ${leaked.join(', ')}`);
  assertions.push('non-zai provider leak check: clean');

  return {
    agentDir: destDir,
    extensionFileCount: fileCount,
    extensionByteCount: byteCount,
    credentialProviders: Object.keys(authFiltered),
    assertions,
  };
}
