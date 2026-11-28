import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  sessionGeneration?: number;
  iat: number;
  exp: number;
}

const sessionGenerations = new Map<string, number>();

function currentSessionGeneration(userId: string): number {
  return sessionGenerations.get(userId) ?? 0;
}

export function revokeSessionTokens(userId: string): void {
  sessionGenerations.set(userId, currentSessionGeneration(userId) + 1);
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
