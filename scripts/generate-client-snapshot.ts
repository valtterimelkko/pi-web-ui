/**
 * C1 (orchestration-scaling plan): generate the committed contract snapshot the
 * thin parent client (`pi-orch`, sibling repo) validates its request builders
 * and response parsers against.
 *
 * Everything in the snapshot is DERIVED from server source, so a server change
 * without regeneration fails `client-snapshot-drift.test.ts`:
 *   - zod layer: request-body schemas introspected from the live zod objects
 *     (`session-validation.ts`, `dispatch-preflight.ts`);
 *   - types layer: exported interfaces / type aliases extracted syntactically
 *     with the TypeScript compiler from the internal-api type files;
 *   - routes layer: the client-used route table, each entry anchored to a
 *     handler function name that the drift test verifies still exists;
 *   - error codes and the contract version.
 *
 * Determinism contract: the output contains NO timestamps, git metadata or any
 * other run-varying value — regeneration is reproducible byte-for-byte. Run:
 *   npx tsx scripts/generate-client-snapshot.ts
 * and commit `docs/contract/internal-api-client-snapshot.json`.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { ALL_ERROR_CODES } from '../server/src/internal-api/error-codes.js';
import {
  INTERNAL_API_CONTRACT_VERSION,
  THINKING_LEVELS,
} from '../server/src/internal-api/types.js';
import {
  createSessionBodySchema,
  goalSpecSchema,
  retentionSchema,
  sessionControlBodySchema,
} from '../server/src/internal-api/session-validation.js';
import { preflightSpecSchema } from '../server/src/internal-api/dispatch-preflight.js';
import { COMMAND_CODE_EFFORT_LEVELS } from '../server/src/command-code/command-code-model-catalog.js';

// ─── Snapshot shape ──────────────────────────────────────────────────────────

export interface ZodField {
  type: string;
  optional?: boolean;
  nullable?: boolean;
  min?: number;
  max?: number;
  int?: boolean;
  uuid?: boolean;
  values?: Array<string | number | boolean>;
  fields?: Record<string, ZodField>;
  strict?: boolean;
  items?: ZodField;
  refined?: boolean;
  defaulted?: boolean;
  opaque?: boolean;
}

export interface TypeField {
  type: string;
  optional?: boolean;
}

export interface ExtractedType {
  kind: 'interface' | 'type' | 'enum';
  fields?: Record<string, TypeField>;
  type?: string;
  values?: string[];
}

export interface SnapshotRoute {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  handler: string;
  sourceFile: string;
  query?: Record<string, string>;
  request?: { zod?: string; type?: string };
  response?: string;
}

export interface ClientContractSnapshot {
  $schema: 'pi-orch-contract-snapshot/v1';
  contractVersion: string;
  source: {
    typeFiles: string[];
    zodFiles: string[];
    routeFiles: string[];
  };
  errorCodes: string[];
  zodSchemas: Record<string, ZodField>;
  routes: Record<string, SnapshotRoute>;
  types: Record<string, ExtractedType>;
}

// ─── Zod introspection (public zod v3 surface) ───────────────────────────────

type ZodLike = { _def: Record<string, unknown> & { typeName: string } };

function describeZod(node: unknown): ZodField {
  const def = (node as ZodLike | undefined)?._def;
  if (!def) return { type: 'unknown', opaque: true };
  switch (def.typeName) {
    case 'ZodString': {
      const field: ZodField = { type: 'string' };
      for (const check of (def.checks as Array<{ kind: string; value?: number }> | undefined) ?? []) {
        if (check.kind === 'min') field.min = check.value ?? 0;
        if (check.kind === 'max') field.max = check.value;
        if (check.kind === 'uuid') field.uuid = true;
      }
      return field;
    }
    case 'ZodNumber': {
      const field: ZodField = { type: 'number' };
      for (const check of (def.checks as Array<{ kind: string; value?: number }> | undefined) ?? []) {
        if (check.kind === 'int') field.int = true;
        if (check.kind === 'min') field.min = check.value ?? 0;
        if (check.kind === 'max') field.max = check.value;
      }
      return field;
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'enum', values: [...(def.values as Array<string | number | boolean>)] };
    case 'ZodLiteral':
      return { type: 'enum', values: [def.value as string] };
    case 'ZodUnknown':
      return { type: 'unknown' };
    case 'ZodObject': {
      const shape = (node as { shape: Record<string, unknown> }).shape;
      const fields: Record<string, ZodField> = {};
      for (const key of Object.keys(shape).sort()) fields[key] = fieldOf(shape[key]);
      const refinements = def.refinements as unknown[] | undefined;
      return {
        type: 'object',
        strict: def.unknownKeys === 'strict',
        fields,
        ...(refinements && refinements.length > 0 ? { refined: true } : {}),
      };
    }
    case 'ZodArray': {
      const field: ZodField = { type: 'array', items: describeZod(def.type) };
      if (def.minLength) field.min = (def.minLength as { _value: number })._value;
      if (def.maxLength) field.max = (def.maxLength as { _value: number })._value;
      return field;
    }
    case 'ZodUnion':
      return {
        type: 'enum',
        values: (def.options as unknown[]).flatMap((option) => describeZod(option).values ?? []),
      };
    case 'ZodEffects':
      return { ...describeZod(def.schema), refined: true };
    case 'ZodDefault':
      return { ...describeZod(def.innerType), defaulted: true };
    default:
      return { type: String(def.typeName), opaque: true };
  }
}

function fieldOf(node: unknown): ZodField {
  const def = (node as ZodLike | undefined)?._def;
  const base = describeZod(node);
  if (def?.typeName === 'ZodOptional') return { ...base, optional: true };
  if (def?.typeName === 'ZodNullable') return { ...base, nullable: true };
  return base;
}

// ─── TypeScript type extraction (syntactic) ──────────────────────────────────

interface ParsedFile {
  interfaces: Map<string, ts.InterfaceDeclaration>;
  aliases: Map<string, ts.TypeAliasDeclaration>;
  constStringArrays: Map<string, readonly string[]>;
}

function parseTypeFile(filePath: string): ParsedFile {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true);
  const parsed: ParsedFile = { interfaces: new Map(), aliases: new Map(), constStringArrays: new Map() };
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name) {
      parsed.interfaces.set(node.name.text, node);
    } else if (ts.isTypeAliasDeclaration(node) && node.name) {
      parsed.aliases.set(node.name.text, node);
    } else if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          ts.isArrayLiteralExpression(declaration.initializer)
        ) {
          const values = declaration.initializer.elements
            .filter((element): element is ts.StringLiteral => ts.isStringLiteral(element))
            .map((element) => element.text);
          if (values.length > 0 && values.length === declaration.initializer.elements.length) {
            parsed.constStringArrays.set(declaration.name.text, values);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parsed;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

function printTypeNode(node: ts.Node | undefined, files: ParsedFile[]): string {
  if (!node) return 'unknown';
  // Resolve `(typeof X)[number]` where X is a parsed exported string-array const.
  if (ts.isIndexedAccessTypeNode(node) && ts.isTypeQueryNode(node.objectType)) {
    const constName = node.objectType.exprName.getText();
    for (const file of files) {
      const values = file.constStringArrays.get(constName);
      if (values) return values.map((value) => JSON.stringify(value)).join(' | ');
    }
  }
  // Resolve a bare alias that names another parsed alias or const array.
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
    const name = node.typeName.text;
    for (const file of files) {
      const values = file.constStringArrays.get(name);
      if (values) return values.map((value) => JSON.stringify(value)).join(' | ');
      const alias = file.aliases.get(name);
      if (alias) return printTypeNode(alias.type, files);
    }
  }
  return collapse(node.getText());
}

function fieldsOfMembers(members: ts.NodeArray<ts.TypeElement>, files: ParsedFile[]): Record<string, TypeField> {
  const fields: Record<string, TypeField> = {};
  for (const member of members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const name = member.name.getText().replace(/^['"]|['"]$/g, '');
    fields[name] = {
      type: printTypeNode(member.type, files),
      ...(member.questionToken ? { optional: true } : {}),
    };
  }
  return fields;
}

const TYPE_ROOTS = [
  'ApiError',
  'CapacityResponse',
  'CapabilitiesResponse',
  'CreateSessionResponse',
  'DeleteWatchRequest',
  'DeleteWatchResponse',
  'DetachedPromptResponse',
  'DuplicatePromptResponse',
  'ListSessionsResponse',
  'ModelInfo',
  'ModelsResponse',
  'PromptDispatchResponse',
  'PromptResponse',
  'RegisterWatchRequest',
  'RetentionLeaseRequest',
  'RetentionLeaseResponse',
  'RunActivityObservation',
  'RunCessationEvidence',
  'RunLivenessEvidence',
  'RunOutputEvidence',
  'RunReceipt',
  'RunTerminalObservation',
  'RunTokenUsage',
  'RunWatchdogEvidence',
  'SendPromptRequest',
  'SessionControlRequest',
  'SessionControlResponse',
  'SessionDetail',
  'SessionGoalProjection',
  'SessionInfo',
  'TranscriptResponse',
  'WaitResponse',
  'WatchConditionSpec',
  'WatchConditionState',
  'WatchFireIfSettledResult',
  'WatchFiring',
  'WatchOnFireAction',
  'WatchResponse',
  'WatchSnapshot',
  'WatchWakeAttempt',
  'WatchesWaitResponse',
  'WatchWaitEntry',
];

/** Alias values that do not print usefully from syntax alone. */
const ALIAS_VALUE_OVERRIDES: Record<string, readonly string[]> = {
  ThinkingLevel: THINKING_LEVELS,
  CommandCodeEffort: COMMAND_CODE_EFFORT_LEVELS,
};

function extractTypes(files: ParsedFile[]): Record<string, ExtractedType> {
  const out: Record<string, ExtractedType> = {};
  const queue = [...TYPE_ROOTS];
  const seen = new Set<string>();
  const namesIn = (token: string): boolean =>
    files.some((file) => file.interfaces.has(token) || file.aliases.has(token));
  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    if (ALIAS_VALUE_OVERRIDES[name]) {
      out[name] = { kind: 'enum', values: [...ALIAS_VALUE_OVERRIDES[name]].sort() };
      continue;
    }
    const declaration = files.flatMap((file) => file.interfaces.get(name) ?? [])[0];
    if (declaration) {
      const fields = fieldsOfMembers(declaration.members, files);
      out[name] = { kind: 'interface', fields };
      for (const field of Object.values(fields)) {
        for (const token of field.type.split(/[^A-Za-z0-9_]/)) {
          if (token.length > 0 && !seen.has(token) && namesIn(token)) queue.push(token);
        }
      }
      continue;
    }
    const alias = files.flatMap((file) => file.aliases.get(name) ?? [])[0];
    if (alias) {
      out[name] = { kind: 'type', type: printTypeNode(alias.type, files) };
      continue;
    }
    // A root that resolves to nothing is a generator bug, not a snapshot entry.
    throw new Error(`generate-client-snapshot: type root '${name}' not found in parsed type files`);
  }
  return out;
}

// ─── Route table (the routes the client uses) ────────────────────────────────

const SESSIONS_ROUTE_FILE = 'server/src/internal-api/routes/sessions.ts';

const ROUTE_TABLE: Array<SnapshotRoute & { key: string }> = [
  { key: 'getCapabilities', method: 'GET', path: '/api/v1/capabilities', handler: 'handleGetCapabilities', sourceFile: 'server/src/internal-api/routes/capabilities.ts', response: 'CapabilitiesResponse' },
  { key: 'getCapacity', method: 'GET', path: '/api/v1/capacity', handler: 'handleCapacity', sourceFile: SESSIONS_ROUTE_FILE, response: 'CapacityResponse' },
  { key: 'listModels', method: 'GET', path: '/api/v1/models', handler: 'handleListModels', sourceFile: 'server/src/internal-api/routes/models.ts', query: { runtime: 'optional, one of the SessionRuntime values' }, response: 'ModelsResponse' },
  { key: 'createSession', method: 'POST', path: '/api/v1/sessions', handler: 'handleCreateSession', sourceFile: SESSIONS_ROUTE_FILE, request: { zod: 'createSessionBody' }, response: 'CreateSessionResponse' },
  { key: 'sendPrompt', method: 'POST', path: '/api/v1/sessions/:id/prompt', handler: 'handleSendPrompt', sourceFile: SESSIONS_ROUTE_FILE, request: { type: 'SendPromptRequest' }, response: 'PromptDispatchResponse' },
  { key: 'getRunReceipt', method: 'GET', path: '/api/v1/runs/:runId', handler: 'handleGetRunReceipt', sourceFile: SESSIONS_ROUTE_FILE, response: 'RunReceipt' },
  { key: 'registerWatch', method: 'POST', path: '/api/v1/sessions/:id/watch', handler: 'handleRegisterWatch', sourceFile: SESSIONS_ROUTE_FILE, request: { type: 'RegisterWatchRequest' }, response: 'WatchResponse' },
  { key: 'getWatch', method: 'GET', path: '/api/v1/sessions/:id/watch', handler: 'handleGetWatch', sourceFile: SESSIONS_ROUTE_FILE, query: { sinceIndex: 'optional integer' }, response: 'WatchResponse' },
  { key: 'deleteWatch', method: 'DELETE', path: '/api/v1/sessions/:id/watch', handler: 'handleDeleteWatch', sourceFile: SESSIONS_ROUTE_FILE, request: { type: 'DeleteWatchRequest' }, response: 'DeleteWatchResponse' },
  { key: 'watchesWait', method: 'GET', path: '/api/v1/watches/wait', handler: 'handleWatchesWait', sourceFile: SESSIONS_ROUTE_FILE, query: { ids: 'required, comma-separated watch ids', timeout: 'optional ms, capped at 300000', cursor: 'optional opaque cursor from nextCursor' }, response: 'WatchesWaitResponse' },
  { key: 'sessionControl', method: 'POST', path: '/api/v1/sessions/:id/control', handler: 'handleSessionControl', sourceFile: SESSIONS_ROUTE_FILE, request: { zod: 'sessionControlBody' }, response: 'SessionControlResponse' },
  { key: 'deleteSession', method: 'DELETE', path: '/api/v1/sessions/:id', handler: 'handleDeleteSession', sourceFile: SESSIONS_ROUTE_FILE, response: '(object)' },
  { key: 'listSessions', method: 'GET', path: '/api/v1/sessions', handler: 'handleListSessions', sourceFile: SESSIONS_ROUTE_FILE, query: { parent: 'optional parent session id (C5)', limit: 'optional integer', cwd: 'optional exact cwd filter' }, response: 'ListSessionsResponse' },
  { key: 'getSessionTranscript', method: 'GET', path: '/api/v1/sessions/:id/transcript', handler: 'handleSessionTranscript', sourceFile: SESSIONS_ROUTE_FILE, query: { scope: 'optional, visible_recent (default) | visible_full', view: 'optional, screen', limit: 'optional integer 1-500 (visible_recent)' }, response: 'TranscriptResponse' },
  { key: 'getSessionGoal', method: 'GET', path: '/api/v1/sessions/:id/goal', handler: 'handleGetSessionGoal', sourceFile: SESSIONS_ROUTE_FILE, response: 'SessionGoalProjection (+ sessionId, runtime)' },
  { key: 'sessionGoalControl', method: 'POST', path: '/api/v1/sessions/:id/goal', handler: 'handleSessionGoalControl', sourceFile: SESSIONS_ROUTE_FILE, request: { type: 'SessionGoalControlRequest' }, response: '(goal action result incl. goal projection)' },
];

// ─── Assembly ────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Repository root containing `server/` and `scripts/`. Defaults to this file's repo. */
  repoRoot?: string;
}

export function generateSnapshot(options: GenerateOptions = {}): ClientContractSnapshot {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const at = (relative: string): string => resolve(repoRoot, relative);

  const typeFiles = [
    'server/src/internal-api/types.ts',
    'server/src/internal-api/goal/types.ts',
    'server/src/internal-api/goal/goal-actions.ts',
    'server/src/internal-api/dispatch-preflight.ts',
  ];
  const parsedTypeFiles = typeFiles.map((file) => parseTypeFile(at(file)));
  const types = extractTypes(parsedTypeFiles);

  const routes: Record<string, SnapshotRoute> = {};
  for (const { key, ...route } of ROUTE_TABLE) routes[key] = route;

  return {
    $schema: 'pi-orch-contract-snapshot/v1',
    contractVersion: INTERNAL_API_CONTRACT_VERSION,
    source: {
      typeFiles,
      zodFiles: [
        'server/src/internal-api/session-validation.ts',
        'server/src/internal-api/dispatch-preflight.ts',
      ],
      routeFiles: [
        SESSIONS_ROUTE_FILE,
        'server/src/internal-api/routes/models.ts',
        'server/src/internal-api/routes/capabilities.ts',
      ],
    },
    errorCodes: [...ALL_ERROR_CODES].sort(),
    zodSchemas: {
      createSessionBody: fieldOf(createSessionBodySchema),
      goalSpec: fieldOf(goalSpecSchema),
      retention: fieldOf(retentionSchema),
      preflightSpec: fieldOf(preflightSpecSchema),
      sessionControlBody: fieldOf(sessionControlBodySchema),
    },
    routes,
    types,
  };
}

function main(): void {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const snapshot = generateSnapshot({ repoRoot });
  const target = resolve(repoRoot, 'docs/contract/internal-api-client-snapshot.json');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `wrote ${target} (contract ${snapshot.contractVersion}, ${Object.keys(snapshot.routes).length} routes, ${Object.keys(snapshot.types).length} types)`,
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) main();
