import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import { config } from '../config.js';
import { generateSessionToken } from '../security/auth.js';
import { generateCsrfToken, invalidateCsrfToken } from '../security/csrf.js';
import { authLimiter } from '../security/rate-limit.js';
import { validateBody, loginSchema } from '../security/input-validation.js';
import { cookieAuthMiddleware } from '../middleware/auth.js';

const router = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.nodeEnv === 'production',
  sameSite: config.nodeEnv === 'production' ? ('strict' as const) : ('lax' as const),
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

router.post('/login', authLimiter, validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { password } = req.body;

    const storedPassword = config.authPassword;
    let validPassword: boolean;

    if (storedPassword.startsWith('$2')) {
      validPassword = await bcrypt.compare(password, storedPassword);
    } else {
      if (config.nodeEnv === 'production') {
        console.error('SECURITY ERROR: Plain text password detected in production. Use bcrypt hash.');
        res.status(500).json({ error: 'Server configuration error' });
        return;
      }
      validPassword = password === storedPassword;
    }

    if (!validPassword) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const userId = 'default-user';
    const token = generateSessionToken(userId);
    const csrfToken = generateCsrfToken(userId);

    res.cookie('accessToken', token, COOKIE_OPTIONS);

    res.setHeader('X-CSRF-Token', csrfToken);
    res.json({
      success: true,
      csrfToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/logout', (req: Request, res: Response) => {
  const userId = req.user?.userId ?? 'default-user';
  invalidateCsrfToken(userId);

  res.clearCookie('accessToken', { path: '/' });

  res.json({ success: true });
});

router.get('/me', cookieAuthMiddleware, (req: Request, res: Response) => {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const csrfToken = generateCsrfToken(userId);

  res.setHeader('X-CSRF-Token', csrfToken);
  res.json({
    user: {
      id: userId,
    },
    csrfToken,
  });
});

export default router;
