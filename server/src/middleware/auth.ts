import type { Request, Response, NextFunction } from 'express';
import { verifyToken, type JwtPayload } from '../security/auth.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  
  req.user = payload;
  next();
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
    }
  }
  
  next();
}

export function cookieAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const cookieHeader = req.headers.cookie;
  
  if (!cookieHeader) {
    res.status(401).json({ error: 'No authentication cookie' });
    return;
  }
  
  const match = cookieHeader.match(/(?:^|;\s*)accessToken=([^;]+)/);
  if (!match) {
    res.status(401).json({ error: 'No authentication token in cookie' });
    return;
  }
  
  const token = match[1];
  const payload = verifyToken(token);
  
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  
  req.user = payload;
  next();
}
