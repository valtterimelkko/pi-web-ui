import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  sessionGeneration?: number;
  iat: number;
  exp: number;
}

const authSessionStatePath = process.env.AUTH_SESSION_STATE_PATH
  || path.join(path.dirname(config.sessionRegistryPath), 'auth-session-state.json');

function loadSessionGenerations(): Map<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(authSessionStatePath, 'utf8')) as { generations?: unknown };
    if (!parsed.generations || typeof parsed.generations !== 'object' || Array.isArray(parsed.generations)) {
      return new Map();
    }
    return new Map(Object.entries(parsed.generations).filter((entry): entry is [string, number] =>
      typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && (entry[1] as number) >= 0
    ));
  } catch {
    return new Map();
  }
}

const sessionGenerations = loadSessionGenerations();

function currentSessionGeneration(userId: string): number {
  return sessionGenerations.get(userId) ?? 0;
}

function persistSessionGenerations(): void {
  fs.mkdirSync(path.dirname(authSessionStatePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${authSessionStatePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const state = JSON.stringify({ generations: Object.fromEntries(sessionGenerations) }, null, 2);
  fs.writeFileSync(temporaryPath, state, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, authSessionStatePath);
}

export function revokeSessionTokens(userId: string): void {
  sessionGenerations.set(userId, currentSessionGeneration(userId) + 1);
  persistSessionGenerations();
}

export function generateSessionToken(userId: string): string {
  return jwt.sign({ userId, sessionGeneration: currentSessionGeneration(userId) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    if ((payload.sessionGeneration ?? 0) !== currentSessionGeneration(payload.userId)) return null;
    return payload;
  } catch {
    return null;
  }
}
