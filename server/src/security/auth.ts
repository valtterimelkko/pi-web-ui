import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export interface JwtPayload {
  userId: string;
  iat: number;
  exp: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function generateAccessToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function generateRefreshToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: config.jwtRefreshExpiresIn as jwt.SignOptions['expiresIn'],
  });
}

export function generateTokens(userId: string): AuthTokens {
  return {
    accessToken: generateAccessToken(userId),
    refreshToken: generateRefreshToken(userId),
    expiresIn: parseExpiresIn(config.jwtExpiresIn),
  };
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as JwtPayload;
  } catch {
    return null;
  }
}

function parseExpiresIn(expiresIn: string): number {
  // Parse "15m", "7d", etc. to seconds
  const match = expiresIn.match(/^(\d+)([smhd])$/);
  if (!match) return 900; // Default 15 min
  const [, value, unit] = match;
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return parseInt(value) * multipliers[unit];
}
