import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const MAX_EMBEDDED_MANIFEST_BYTES = 64 * 1024;
const MAX_INPUT_COUNT = 1_000_000;
const MAX_IDENTITY_STRING_LENGTH = 256;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILD_ID_PATTERN = /^(build|source)-[0-9a-f]{32}$/;
const KNOWN_COMPONENT_VERSION_KEYS = [
  'app',
  'server',
  'client',
  'shared',
  'internalApiMcp',
] as const;

export type BuildMode = 'source' | 'compiled';
export type IdentityStatus = 'known' | 'unknown';

export interface BuildIdentityFileSystem {
  lstatSync: (pathname: string) => Stats;
  readdirSync: (pathname: string) => string[];
  readFileSync: (pathname: string) => Buffer;
}

const defaultFileSystem: BuildIdentityFileSystem = {
  lstatSync,
  readdirSync: (pathname) => readdirSync(pathname, { encoding: 'utf8' }),
  readFileSync: (pathname) => readFileSync(pathname),
};

/**
 * Declared build inputs. The manifest stores only counts and digests, never
 * these paths. Source inputs include runtime source and static client assets;
 * configuration inputs include package/compiler/Vite configuration; lockfile
 * inputs include the root package-manager lockfile(s).
 *
 * Deliberate exclusions: node_modules, dist/build/coverage outputs, VCS
 * metadata, environment files, auth/session stores, logs, generated manifests,
 * test reports, and arbitrary files outside this allowlisted set. Dirty source
 * and configuration contents are read directly, so a candidate does not need a
 * clean checkout or a Git diff to receive a distinct fingerprint.
 */
export const BUILD_INPUT_POLICY = Object.freeze({
  sourceRoots: [
    'server/src',
    'client/src',
    'client/public',
    'shared/src',
    'packages/internal-api-mcp/src',
  ],
  configFiles: [
    'package.json',
    'server/package.json',
    'client/package.json',
    'shared/package.json',
    'packages/internal-api-mcp/package.json',
    'tsconfig.json',
    'server/tsconfig.json',
    'client/tsconfig.json',
    'client/tsconfig.node.json',
    'shared/tsconfig.json',
    'packages/internal-api-mcp/tsconfig.json',
    'client/vite.config.ts',
    'client/index.html',
    'client/tailwind.config.js',
    'client/postcss.config.js',
  ],
  scriptFiles: [
    'scripts/live-validate.ts',
    'scripts/long-horizon-validate.ts',
    'scripts/validation-server.ts',
    'scripts/validation-server-child.ts',
    'scripts/validation-server-stop.mjs',
    'scripts/health-probe.sh',
    'scripts/wait-for-internal-api.mjs',
    'scripts/test-workspaces.mjs',
  ],
  lockfileNames: ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock'],
  excludedDirectoryNames: [
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.git',
    '.cache',
  ],
  excludedFileNames: [
    'embedded-manifest.json',
    'manifest.generated.ts',
    'test-results.json',
  ],
});

export interface BuildManifest {
  manifestSchemaVersion: typeof BUILD_MANIFEST_SCHEMA_VERSION;
  identityStatus: IdentityStatus;
  buildMode: 'compiled';
  buildId: string;
  buildFingerprint: string;
  revision: string;
  sourceFingerprint: string;
  configFingerprint: string;
  lockfileFingerprint: string;
  componentVersions: Record<string, string>;
  inputCounts: {
    source: number;
    config: number;
    lockfile: number;
  };
}

export interface BuildIdentity {
  manifestSchemaVersion: typeof BUILD_MANIFEST_SCHEMA_VERSION;
  identityStatus: IdentityStatus;
  buildMode: BuildMode;
  buildId: string;
  buildFingerprint: string;
  revision: string;
  sourceFingerprint: string;
  configFingerprint: string;
  lockfileFingerprint: string;
  componentVersions: Record<string, string>;
  inputCounts?: {
    source: number;
    config: number;
    lockfile: number;
  };
}

export interface GenerateBuildManifestOptions {
  /** Repository root. Defaults to the checkout containing this source file. */
  rootDir?: string;
  /** Build-time revision. If omitted, read only `git rev-parse HEAD`. */
  revision?: string;
  /** Injectable filesystem seam for deterministic read-failure tests. */
  fileSystem?: BuildIdentityFileSystem;
}

export interface ResolveBuildIdentityOptions {
  /** URL of the runtime module used to distinguish source from dist. */
  moduleUrl: string;
  /** Test/fixture override for the repository root used by source mode. */
  sourceRoot?: string;
  /** Test/fixture override; compiled mode never searches the checkout. */
  embeddedManifestPath?: string;
}

interface InputDigest {
  fingerprint: string;
  count: number;
}

const UNKNOWN = 'unknown';

/**
 * Generate the deterministic identity copied into server/dist and consumed by
 * compiled runtime code. No timestamp, environment value, absolute path or
 * raw diff is part of the result, so two boots of one build share this value.
 */
export function generateBuildManifest(options: GenerateBuildManifestOptions = {}): BuildManifest {
  const rootDir = resolve(options.rootDir ?? repositoryRootFromModuleUrl(import.meta.url));
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const source = digestDeclaredFiles(rootDir, BUILD_INPUT_POLICY.sourceRoots, true, fileSystem);
  const config = digestDeclaredFiles(
    rootDir,
    [...BUILD_INPUT_POLICY.configFiles, ...BUILD_INPUT_POLICY.scriptFiles],
    false,
    fileSystem,
  );
  const lockfile = digestLockfiles(rootDir, fileSystem);
  const componentVersions = readComponentVersions(rootDir, fileSystem);
  const revision = cleanIdentityValue(options.revision) ?? readGitRevision(rootDir);
  const identityStatus: IdentityStatus = source.count > 0 && config.count > 0 && lockfile.count > 0
    ? 'known'
    : 'unknown';
  const buildFingerprint = identityStatus === 'known'
    ? hashCanonical({
      buildMode: 'compiled',
      revision,
      sourceFingerprint: source.fingerprint,
      configFingerprint: config.fingerprint,
      lockfileFingerprint: lockfile.fingerprint,
      componentVersions,
    })
    : UNKNOWN;

  return {
    manifestSchemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    identityStatus,
    buildMode: 'compiled',
    buildId: identityStatus === 'known' ? `build-${buildFingerprint.slice(0, 32)}` : UNKNOWN,
    buildFingerprint: identityStatus === 'known' ? `sha256:${buildFingerprint}` : UNKNOWN,
    revision: identityStatus === 'known' ? revision : UNKNOWN,
    sourceFingerprint: source.fingerprint,
    configFingerprint: config.fingerprint,
    lockfileFingerprint: lockfile.fingerprint,
    componentVersions,
    inputCounts: {
      source: source.count,
      config: config.count,
      lockfile: lockfile.count,
    },
  };
}

/**
 * Resolve the identity of the executing runtime. A `.js` module below `dist`
 * can use only its adjacent embedded manifest. It never consults Git, the
 * current checkout, process environment labels, or a caller-provided version.
 */
export function resolveBuildIdentity(options: ResolveBuildIdentityOptions): BuildIdentity {
  if (isCompiledModuleUrl(options.moduleUrl)) {
    const manifestPath = options.embeddedManifestPath
      ?? fileURLToPath(new URL('./embedded-manifest.json', options.moduleUrl));
    return readEmbeddedIdentity(manifestPath);
  }

  return createSourceBuildIdentity(
    options.sourceRoot ?? repositoryRootFromModuleUrl(options.moduleUrl),
  );
}

/** Resolve the identity for this helper's own process/runtime. */
export function getRuntimeBuildIdentity(): BuildIdentity {
  return resolveBuildIdentity({ moduleUrl: import.meta.url });
}

/** Return a source identity without claiming that a compiled artifact is live. */
export function createSourceBuildIdentity(
  rootDir: string,
  fileSystem: BuildIdentityFileSystem = defaultFileSystem,
): BuildIdentity {
  const root = resolve(rootDir);
  const source = digestDeclaredFiles(root, BUILD_INPUT_POLICY.sourceRoots, true, fileSystem);
  const config = digestDeclaredFiles(
    root,
    [...BUILD_INPUT_POLICY.configFiles, ...BUILD_INPUT_POLICY.scriptFiles],
    false,
    fileSystem,
  );
  const lockfile = digestLockfiles(root, fileSystem);
  const componentVersions = readComponentVersions(root, fileSystem);
  const identityStatus: IdentityStatus = source.count > 0 && config.count > 0 && lockfile.count > 0
    ? 'known'
    : 'unknown';
  const buildFingerprint = identityStatus === 'known'
    ? hashCanonical({
      buildMode: 'source',
      sourceFingerprint: source.fingerprint,
      configFingerprint: config.fingerprint,
      lockfileFingerprint: lockfile.fingerprint,
      componentVersions,
    })
    : UNKNOWN;

  return {
    manifestSchemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    identityStatus,
    buildMode: 'source',
    buildId: identityStatus === 'known' ? `source-${buildFingerprint.slice(0, 32)}` : UNKNOWN,
    buildFingerprint: identityStatus === 'known' ? `sha256:${buildFingerprint}` : UNKNOWN,
    revision: UNKNOWN,
    sourceFingerprint: source.fingerprint,
    configFingerprint: config.fingerprint,
    lockfileFingerprint: lockfile.fingerprint,
    componentVersions,
    inputCounts: {
      source: source.count,
      config: config.count,
      lockfile: lockfile.count,
    },
  };
}

/** Whether a runtime module is an emitted JavaScript module below `dist`. */
export function isCompiledModuleUrl(moduleUrl: string): boolean {
  try {
    const pathname = fileURLToPath(moduleUrl).replaceAll('\\', '/');
    return pathname.split('/').includes('dist') && pathname.endsWith('.js');
  } catch {
    return false;
  }
}

function readEmbeddedIdentity(manifestPath: string): BuildIdentity {
  try {
    // This is deliberately the only compiled identity source. The generated
    // file is placed beside the compiled helper during the successful build.
    const raw = readFileSync(manifestPath, 'utf8');
    return parseBuildIdentity(raw, 'compiled') ?? unknownCompiledIdentity();
  } catch {
    return unknownCompiledIdentity();
  }
}

/**
 * Parse and project an embedded identity without trusting arbitrary JSON. The
 * byte cap is applied before parsing, and the returned object contains only
 * fields that are part of the public identity contract.
 */
export function parseBuildIdentity(raw: string, expectedMode?: BuildMode): BuildIdentity | undefined {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_EMBEDDED_MANIFEST_BYTES) return undefined;
  try {
    return projectBuildIdentity(JSON.parse(raw), expectedMode);
  } catch {
    return undefined;
  }
}

/** Validate and project an already parsed identity value. */
export function projectBuildIdentity(value: unknown, expectedMode?: BuildMode): BuildIdentity | undefined {
  if (!isRecord(value)) return undefined;
  if (value.manifestSchemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION) return undefined;

  const buildMode = value.buildMode;
  if ((buildMode !== 'source' && buildMode !== 'compiled') || (expectedMode && buildMode !== expectedMode)) {
    return undefined;
  }
  const identityStatus = value.identityStatus;
  if (identityStatus !== 'known' && identityStatus !== 'unknown') return undefined;

  const buildId = boundedIdentityString(value.buildId);
  const buildFingerprint = boundedIdentityString(value.buildFingerprint);
  const revision = boundedIdentityString(value.revision);
  const sourceFingerprint = boundedIdentityString(value.sourceFingerprint);
  const configFingerprint = boundedIdentityString(value.configFingerprint);
  const lockfileFingerprint = boundedIdentityString(value.lockfileFingerprint);
  const componentVersions = projectComponentVersions(value.componentVersions);
  const inputCounts = value.inputCounts === undefined ? undefined : projectInputCounts(value.inputCounts);
  if (!buildId || !buildFingerprint || !revision || !sourceFingerprint || !configFingerprint || !lockfileFingerprint
    || !componentVersions || (value.inputCounts !== undefined && !inputCounts)) {
    return undefined;
  }

  if (identityStatus === 'known') {
    if (!inputCounts || !hasPositiveInputCounts(inputCounts)
      || !isDigest(buildFingerprint) || !isDigest(sourceFingerprint)
      || !isDigest(configFingerprint) || !isDigest(lockfileFingerprint)
      || !BUILD_ID_PATTERN.test(buildId)) {
      return undefined;
    }
    const expectedPrefix = buildMode === 'compiled' ? 'build-' : 'source-';
    if (!buildId.startsWith(expectedPrefix) || buildId.slice(expectedPrefix.length) !== buildFingerprint.slice(7, 39)) {
      return undefined;
    }
    if (buildMode === 'source' && revision !== UNKNOWN) return undefined;
    const expectedFingerprint = hashCanonical({
      buildMode,
      ...(buildMode === 'compiled' ? { revision } : {}),
      sourceFingerprint,
      configFingerprint,
      lockfileFingerprint,
      componentVersions,
    });
    if (buildFingerprint !== `sha256:${expectedFingerprint}`) return undefined;
  } else if (buildId !== UNKNOWN || buildFingerprint !== UNKNOWN || revision !== UNKNOWN
    || sourceFingerprint !== UNKNOWN || configFingerprint !== UNKNOWN || lockfileFingerprint !== UNKNOWN) {
    return undefined;
  }

  return {
    manifestSchemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    identityStatus,
    buildMode,
    buildId,
    buildFingerprint,
    revision,
    sourceFingerprint,
    configFingerprint,
    lockfileFingerprint,
    componentVersions,
    ...(inputCounts ? { inputCounts } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedIdentityString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_STRING_LENGTH) return undefined;
  return /[\r\n]/.test(value) ? undefined : value;
}

function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

function projectComponentVersions(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of KNOWN_COMPONENT_VERSION_KEYS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 80 || /[\r\n]/.test(value[key])) return undefined;
    result[key] = value[key];
  }
  return result;
}

function projectInputCounts(value: unknown): BuildIdentity['inputCounts'] | undefined {
  if (!isRecord(value)) return undefined;
  const counts = { source: value.source, config: value.config, lockfile: value.lockfile };
  if (!Object.values(counts).every((count) => typeof count === 'number'
    && Number.isSafeInteger(count) && count >= 0 && count <= MAX_INPUT_COUNT)) return undefined;
  return counts as BuildIdentity['inputCounts'];
}

function hasPositiveInputCounts(
  counts: NonNullable<BuildIdentity['inputCounts']>,
): boolean {
  return counts.source > 0 && counts.config > 0 && counts.lockfile > 0;
}

function unknownCompiledIdentity(): BuildIdentity {
  return {
    manifestSchemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    identityStatus: 'unknown',
    buildMode: 'compiled',
    buildId: UNKNOWN,
    buildFingerprint: UNKNOWN,
    revision: UNKNOWN,
    sourceFingerprint: UNKNOWN,
    configFingerprint: UNKNOWN,
    lockfileFingerprint: UNKNOWN,
    componentVersions: {},
  };
}

function digestDeclaredFiles(
  rootDir: string,
  declaredPaths: readonly string[],
  recurse: boolean,
  fileSystem: BuildIdentityFileSystem,
): InputDigest {
  const files = new Set<string>();
  let complete = true;
  for (const declaredPath of declaredPaths) {
    const absolute = resolve(rootDir, declaredPath);
    const pathComplete = recurse
      ? collectFiles(absolute, files, fileSystem)
      : collectDirectFile(absolute, files, fileSystem);
    complete = complete && pathComplete;
  }
  if (!complete) return { fingerprint: UNKNOWN, count: 0 };
  return digestFiles(rootDir, [...files].sort(), fileSystem);
}

function digestLockfiles(rootDir: string, fileSystem: BuildIdentityFileSystem): InputDigest {
  const files = new Set<string>();
  let complete = true;
  for (const name of BUILD_INPUT_POLICY.lockfileNames) {
    complete = collectDirectFile(resolve(rootDir, name), files, fileSystem) && complete;
  }
  if (!complete) return { fingerprint: UNKNOWN, count: 0 };
  return digestFiles(rootDir, [...files].sort(), fileSystem);
}

/** Walk a declared directory without following symlinks. */
export function collectFiles(
  pathname: string,
  files: Set<string>,
  fileSystem: BuildIdentityFileSystem = defaultFileSystem,
): boolean {
  let stat: Stats;
  try {
    stat = fileSystem.lstatSync(pathname);
  } catch (error) {
    // A declared path may be absent in a fixture or optional workspace. Other
    // read failures are incomplete evidence and must not become known output.
    return isMissingPathError(error);
  }
  if (stat.isSymbolicLink()) return false;
  if (stat.isFile()) {
    if (isAllowedFile(pathname)) files.add(pathname);
    return true;
  }
  if (!stat.isDirectory()) return false;
  const name = pathname.split(/[\\/]/).pop() ?? '';
  if (BUILD_INPUT_POLICY.excludedDirectoryNames.includes(name)) return true;

  let entries: string[];
  try {
    entries = fileSystem.readdirSync(pathname);
  } catch {
    return false;
  }
  let complete = true;
  for (const entry of entries.sort()) {
    complete = collectFiles(join(pathname, entry), files, fileSystem) && complete;
  }
  return complete;
}

function collectDirectFile(
  pathname: string,
  files: Set<string>,
  fileSystem: BuildIdentityFileSystem,
): boolean {
  let stat: Stats;
  try {
    stat = fileSystem.lstatSync(pathname);
  } catch (error) {
    return isMissingPathError(error);
  }
  if (stat.isSymbolicLink()) return false;
  if (!stat.isFile()) return false;
  if (isAllowedFile(pathname)) files.add(pathname);
  return true;
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAllowedFile(pathname: string): boolean {
  const name = pathname.split(/[\\/]/).pop() ?? '';
  if (BUILD_INPUT_POLICY.excludedFileNames.includes(name)) return false;
  if (name.startsWith('.env')) return false;
  if (name.endsWith('.map')) return false;
  return true;
}

function digestFiles(
  rootDir: string,
  files: readonly string[],
  fileSystem: BuildIdentityFileSystem,
): InputDigest {
  if (files.length === 0) return { fingerprint: UNKNOWN, count: 0 };
  const hash = createHash('sha256');
  let count = 0;
  for (const file of files) {
    try {
      const stat = fileSystem.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return { fingerprint: UNKNOWN, count: 0 };
      const relativeName = relative(rootDir, file).replaceAll('\\', '/');
      // Names are only hash inputs; they are not exposed in the manifest.
      hash.update(relativeName);
      hash.update('\0');
      hash.update(fileSystem.readFileSync(file));
      hash.update('\0');
      count += 1;
    } catch {
      // A disappearing or unreadable candidate input makes its category
      // explicitly unknown rather than silently asserting partial evidence.
      return { fingerprint: UNKNOWN, count: 0 };
    }
  }
  return count > 0
    ? { fingerprint: `sha256:${hash.digest('hex')}`, count }
    : { fingerprint: UNKNOWN, count: 0 };
}

function readComponentVersions(
  rootDir: string,
  fileSystem: BuildIdentityFileSystem = defaultFileSystem,
): Record<string, string> {
  const packageFiles: Record<string, string> = {
    app: 'package.json',
    server: 'server/package.json',
    client: 'client/package.json',
    shared: 'shared/package.json',
    internalApiMcp: 'packages/internal-api-mcp/package.json',
  };
  return Object.fromEntries(Object.entries(packageFiles).map(([name, pathname]) => {
    try {
      const parsed = JSON.parse(fileSystem.readFileSync(resolve(rootDir, pathname)).toString('utf8')) as { version?: unknown };
      return [name, typeof parsed.version === 'string' ? parsed.version : UNKNOWN];
    } catch {
      return [name, UNKNOWN];
    }
  }));
}

function readGitRevision(rootDir: string): string {
  try {
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return cleanIdentityValue(revision) ?? UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

function cleanIdentityValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const cleaned = value.trim();
  return cleaned && !/[\r\n]/.test(cleaned) ? cleaned : undefined;
}

function repositoryRootFromModuleUrl(moduleUrl: string): string {
  try {
    const modulePath = fileURLToPath(moduleUrl);
    return resolve(dirname(modulePath), '../../..');
  } catch {
    return resolve(process.cwd());
  }
}
