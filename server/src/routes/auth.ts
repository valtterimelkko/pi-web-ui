import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { generateTokens, verifyToken, type JwtPayload } from '../security/auth.js';
import { generateCsrfToken, invalidateCsrfToken } from '../security/csrf.js';
import { authLimiter } from '../security/rate-limit.js';
import { validateBody, loginSchema } from '../security/input-validation.js';
import { cookieAuthMiddleware } from '../middleware/auth.js';

const router = Router();

// Cookie options for JWT
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
};

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

// POST /api/auth/login - Login with password
router.post('/login', authLimiter, validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { password } = req.body;
    
    // Single-user mode: compare against configured password
    // Support both bcrypt hash (starts with $2) and plain text (for development)
    const storedPassword = config.authPassword;
    let validPassword: boolean;
    
    if (storedPassword.startsWith('$2')) {
      // bcrypt hash
      validPassword = await bcrypt.compare(password, storedPassword);
    } else {
      // Plain text (development only)
      validPassword = password === storedPassword;
    }
    
    if (!validPassword) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    
    const userId = 'default-user'; // Single user mode
    const tokens = generateTokens(userId);
    const csrfToken = generateCsrfToken(userId);
    
    // Set JWT in httpOnly cookie
    res.cookie('accessToken', tokens.accessToken, COOKIE_OPTIONS);
    res.cookie('refreshToken', tokens.refreshToken, { ...COOKIE_OPTIONS, maxAge: 7 * 24 * 60 * 60 * 1000 });
    
    // Send CSRF token in header and response body
    res.setHeader('X-CSRF-Token', csrfToken);
    res.json({
      success: true,
      expiresIn: tokens.expiresIn,
      csrfToken, // Also in body for WebSocket handshake
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout - Logout
router.post('/logout', (req: Request, res: Response) => {
  const userId = req.user?.userId ?? 'default-user';
  invalidateCsrfToken(userId);
  
  res.clearCookie('accessToken', { path: '/' });
  res.clearCookie('refreshToken', { path: '/' });
  
  res.json({ success: true });
});

// POST /api/auth/refresh - Refresh tokens
router.post('/refresh', (req: Request, res: Response) => {
  // Get refresh token from cookie (preferred) or body
  const cookieHeader = req.headers.cookie;
  let refreshToken: string | undefined;
  
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)refreshToken=([^;]+)/);
    if (match) {
      refreshToken = match[1];
    }
  }
  
  // Fallback to body (for backward compatibility)
  if (!refreshToken && req.body?.refreshToken) {
    refreshToken = req.body.refreshToken;
  }
  
  if (!refreshToken) {
    res.status(401).json({ error: 'No refresh token provided' });
    return;
  }
  
  const payload = verifyToken(refreshToken);
  if (!payload) {
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }
  
  const tokens = generateTokens(payload.userId);
  const csrfToken = generateCsrfToken(payload.userId);
  
  res.cookie('accessToken', tokens.accessToken, COOKIE_OPTIONS);
  res.cookie('refreshToken', tokens.refreshToken, { ...COOKIE_OPTIONS, maxAge: 7 * 24 * 60 * 60 * 1000 });
  
  res.setHeader('X-CSRF-Token', csrfToken);
  res.json({
    success: true,
    expiresIn: tokens.expiresIn,
    csrfToken,
  });
});

// GET /api/auth/me - Get current user
router.get('/me', cookieAuthMiddleware, (req: Request, res: Response) => {
  res.json({
    user: {
      id: req.user!.userId,
    },
  });
});

export default router;
