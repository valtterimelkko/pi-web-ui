import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { apiLimiter } from '../security/rate-limit.js';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Files');


// Upload directory
const UPLOAD_DIR = '/tmp/pi-uploads';

// Ensure upload directory exists
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  // Directory may already exist
}

const router = Router();

router.use(cookieAuthMiddleware);
router.use(apiLimiter);

// Allowed directories for file browsing
function getAllowedDirectories(): string[] {
  // Always include common directories for flexibility
  const dirs = new Set<string>();
  
  // Add current working directory
  dirs.add(process.cwd());
  
  // Add home directory
  if (process.env.HOME) {
    dirs.add(process.env.HOME);
  }
  
  // Always allow /root for this deployment
  dirs.add('/root');
  
  // Add parent of cwd if cwd is a subdirectory of /root
  const cwd = process.cwd();
  if (cwd.startsWith('/root/')) {
    dirs.add('/root');
  }
  
  return Array.from(dirs);
}

// Validate path is within allowed directories
async function validatePath(requestedPath: string): Promise<string | null> {
  const allowedDirs = getAllowedDirectories();
  
  try {
    const resolved = path.resolve(requestedPath);
    const real = await fs.realpath(resolved);
    
    for (const allowed of allowedDirs) {
      try {
        const allowedReal = await fs.realpath(allowed);
        if (real.startsWith(allowedReal)) {
          return real;
        }
      } catch {
        // Skip allowed dirs that don't exist
        continue;
      }
    }
    
    logger.warn(`Path validation failed: ${real} not in allowed directories: ${allowedDirs.join(', ')}`);
    return null;
  } catch (err) {
    logger.warn(`Path validation error for ${requestedPath}:`, err);
    return null;
  }
}

// GET /api/files/browse - Browse directory
router.get('/browse', async (req: Request, res: Response) => {
  try {
    const requestedPath = (req.query.path as string) || process.cwd();
    
    const validatedPath = await validatePath(requestedPath);
    if (!validatedPath) {
      logger.warn(`Browse access denied for path: ${requestedPath}, allowed dirs: ${getAllowedDirectories().join(', ')}`);
      res.status(403).json({ error: 'Access denied to this path' });
      return;
    }
    
    const entries = await fs.readdir(validatedPath, { withFileTypes: true });
    
    const items = await Promise.all(
      entries.map(async (entry) => {
        const itemPath = path.join(validatedPath, entry.name);
        let size = 0;
        
        try {
          if (entry.isFile()) {
            const stat = await fs.stat(itemPath);
            size = stat.size;
          }
        } catch {
          // Ignore stat errors
        }
        
        let modifiedAt: string | null = null;
        let isSymlink = false;
        try {
          const lstat = await fs.lstat(itemPath);
          isSymlink = lstat.isSymbolicLink();
          modifiedAt = lstat.mtime.toISOString();
          if (entry.isFile() && size === 0) {
            // lstat gives accurate size for files too
            size = lstat.size;
          }
        } catch {
          // Ignore lstat errors
        }

        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          path: itemPath,
          size,
          modifiedAt,
          isSymlink,
        };
      })
    );
    
    // Sort: directories first, then files, alphabetically
    items.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    
    res.json({
      path: validatedPath,
      parent: path.dirname(validatedPath),
      items,
    });
  } catch (error) {
    logger.error('Error browsing files:', error);
    res.status(500).json({ error: 'Failed to browse directory' });
  }
});

// GET /api/files/read - Read file contents
router.get('/read', async (req: Request, res: Response) => {
  try {
    const requestedPath = req.query.path as string;
    // Note: offset and limit are parsed but not used in this implementation
    // Future versions could support line-based pagination
    const _offset = parseInt(req.query.offset as string) || 1;
    const _limit = parseInt(req.query.limit as string) || 2000;
    
    if (!requestedPath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    
    const validatedPath = await validatePath(requestedPath);
    if (!validatedPath) {
      res.status(403).json({ error: 'Access denied to this path' });
      return;
    }
    
    // Check file size
    const stat = await fs.stat(validatedPath);
    const maxSize = 200 * 1024; // Increased to 200KB limit
    
    if (stat.size > maxSize) {
      // For large files, only read the beginning
      const handle = await fs.open(validatedPath, 'r');
      const buffer = Buffer.alloc(maxSize);
      await handle.read(buffer, 0, maxSize, 0);
      await handle.close();
      
      let content = buffer.toString('utf-8');
      // Truncate to last newline
      const lastNewline = content.lastIndexOf('\n');
      if (lastNewline > 0) {
        content = content.substring(0, lastNewline);
      }
      
      res.json({
        content,
        truncated: true,
        totalSize: stat.size,
        readSize: content.length,
      });
      return;
    }
    
    const content = await fs.readFile(validatedPath, 'utf-8');
    
    res.json({
      content,
      truncated: false,
      totalSize: stat.size,
    });
  } catch (error) {
    logger.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// POST /api/files/upload - Upload a file to /tmp/pi-uploads/
router.post('/upload', async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] || '';
    const rawFileName = req.headers['x-filename'] as string;

    if (!rawFileName) {
      res.status(400).json({ error: 'x-filename header is required' });
      return;
    }

    // Decode URL-encoded filename (client sends encodeURIComponent)
    const decodedFileName = decodeURIComponent(rawFileName);

    // Sanitize: strip path separators, leading dots, then replace spaces and
    // shell-special characters with underscores so the path is safe to embed
    // in bash commands that the AI agent may construct.
    const sanitizedName = path.basename(decodedFileName)
      .replace(/^\.+/, '')                        // no leading dots
      .replace(/[\s<>:"|?*\\]/g, '_');            // spaces & shell-unsafe → _
    if (!sanitizedName) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }

    // Generate unique filename
    const uniqueId = randomUUID().split('-')[0];
    const ext = path.extname(sanitizedName);
    const base = path.basename(sanitizedName, ext);
    const savedName = `${base}-${uniqueId}${ext}`;
    const savedPath = path.join(UPLOAD_DIR, savedName);

    // Ensure upload directory exists
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    // Stream the request body to file
    await new Promise<void>((resolve, reject) => {
      const writeStream = createWriteStream(savedPath);
      req.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      req.pipe(writeStream);
    });

    // Get file size
    const stat = await fs.stat(savedPath);

    res.json({
      success: true,
      path: savedPath,
      name: sanitizedName,
      savedName,
      size: stat.size,
      mimeType: contentType.split(';')[0] || 'application/octet-stream',
    });
  } catch (error) {
    logger.error('Error uploading file:', error);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// POST /api/files/write - create or overwrite a file
router.post('/write', async (req: Request, res: Response) => {
  try {
    const { path: filePath, content } = z.object({
      path: z.string().min(1),
      content: z.string(),
    }).parse(req.body);

    const safePath = await validatePath(filePath);
    if (!safePath) {
      res.status(400).json({ error: 'Access denied to this path' });
      return;
    }
    await fs.writeFile(safePath, content, 'utf-8');
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// PUT /api/files/rename - rename a file or directory
router.put('/rename', async (req: Request, res: Response) => {
  try {
    const { oldPath, newPath } = z.object({
      oldPath: z.string().min(1),
      newPath: z.string().min(1),
    }).parse(req.body);

    const safeOldPath = await validatePath(oldPath);
    if (!safeOldPath) {
      res.status(400).json({ error: 'Access denied to source path' });
      return;
    }
    // For newPath, validate the parent directory (the new path may not exist yet)
    const newPathParent = path.dirname(newPath);
    const safeNewParent = await validatePath(newPathParent);
    if (!safeNewParent) {
      res.status(400).json({ error: 'Access denied to destination path' });
      return;
    }
    const safeNewPath = path.join(safeNewParent, path.basename(newPath));
    await fs.rename(safeOldPath, safeNewPath);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// DELETE /api/files/delete - delete a file
router.delete('/delete', async (req: Request, res: Response) => {
  try {
    const { path: filePath } = z.object({
      path: z.string().min(1),
    }).parse(req.body);

    const safePath = await validatePath(filePath);
    if (!safePath) {
      res.status(400).json({ error: 'Access denied to this path' });
      return;
    }
    await fs.unlink(safePath);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// POST /api/files/mkdir - create a directory
router.post('/mkdir', async (req: Request, res: Response) => {
  try {
    const { path: dirPath } = z.object({
      path: z.string().min(1),
    }).parse(req.body);

    // For mkdir, validate the parent (the new dir may not exist yet)
    const parentDir = path.dirname(dirPath);
    const safeParent = await validatePath(parentDir);
    if (!safeParent) {
      res.status(400).json({ error: 'Access denied to this path' });
      return;
    }
    const safePath = path.join(safeParent, path.basename(dirPath));
    await fs.mkdir(safePath, { recursive: true });
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

export { router as filesRouter };
export default router;
