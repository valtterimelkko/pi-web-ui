import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import fs from 'fs/promises';
import path from 'path';
import { createWriteStream, mkdirSync } from 'fs';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Files');

// ─── Upload cap ────────────────────────────────────────────────────────────

/** Default cap for one uploaded file: 50 MB. */
export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Resolve the per-file upload cap from its raw env value. Empty, invalid and
 * non-positive values fall back to the 50 MB default, so a bad env value can
 * never remove the cap (security review 2026-11-27, finding 6). Never throws.
 */
export function resolveUploadMaxBytes(raw: string | undefined): number {
  const parsed = Number(raw ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_UPLOAD_BYTES;
}

/** Hard cap applied to every upload, whatever its content type. */
export const MAX_UPLOAD_BYTES = resolveUploadMaxBytes(process.env.FILE_UPLOAD_MAX_BYTES);

/**
 * True for the raw file-upload request. Its body must reach the upload route
 * unparsed: every body parser mounted before the route would consume the stream
 * (so the route would save an empty file, or reject a .json upload outright).
 */
export function isFileUploadRequest(req: Pick<Request, 'method' | 'path'>): boolean {
  return req.method === 'POST' && req.path === '/api/files/upload';
}

class UploadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`File exceeds the ${describeBytes(limitBytes)} upload limit`);
    this.name = 'UploadTooLargeError';
  }
}

function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Write one uploaded body to `savedPath`, enforcing `limitBytes` whatever the
 * content type (security review 2026-11-27, finding 6: the old cap belonged to
 * the application/octet-stream body parser alone, so every other MIME type
 * streamed to disk unbounded).
 *
 * A body already consumed by a body parser (express.raw for
 * application/octet-stream) arrives as a Buffer and is written directly —
 * piping the spent request would silently save an empty file. Streamed bodies
 * are counted byte by byte, so a chunked body with no Content-Length cannot
 * exceed the cap either. Throws UploadTooLargeError when the cap is exceeded;
 * the caller unlinks the partial file.
 */
async function writeUploadBody(req: Request, savedPath: string, limitBytes: number): Promise<number> {
  const parsedBody: unknown = req.body;
  if (Buffer.isBuffer(parsedBody)) {
    if (parsedBody.length > limitBytes) throw new UploadTooLargeError(limitBytes);
    await fs.writeFile(savedPath, parsedBody);
    return parsedBody.length;
  }

  return await new Promise<number>((resolve, reject) => {
    const writeStream = createWriteStream(savedPath);
    let received = 0;
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      req.unpipe(writeStream);
      writeStream.destroy();
      reject(error);
    };

    // Count the bytes that actually arrive: pipe() writes a chunk before this
    // listener sees it, so an overflowing chunk may reach the file — the caller
    // unlinks it. Once failed, later chunks are still consumed but discarded.
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limitBytes) fail(new UploadTooLargeError(limitBytes));
    });
    req.on('error', (error: Error) => fail(error));
    req.on('aborted', () => fail(new Error('Upload aborted by the client')));
    writeStream.on('error', (error: Error) => fail(error));
    writeStream.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve(received);
    });
    req.pipe(writeStream);
  });
}


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

async function validateCanonicalPath(real: string): Promise<string | null> {
  const allowedDirs = getAllowedDirectories();
  for (const allowed of allowedDirs) {
    try {
      const allowedReal = await fs.realpath(allowed);
      const relative = path.relative(allowedReal, real);
      if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
        return real;
      }
    } catch {
      continue;
    }
  }
  logger.warn(`Path validation failed: ${real} not in allowed directories: ${allowedDirs.join(', ')}`);
  return null;
}

// Validate path is within allowed directories
async function validatePath(requestedPath: string): Promise<string | null> {
  try {
    const resolved = path.resolve(requestedPath);
    const real = await fs.realpath(resolved);
    return await validateCanonicalPath(real);
  } catch (err) {
    logger.warn(`Path validation error for ${requestedPath}:`, err);
    return null;
  }
}

// Validate a write target that may not exist yet. Existing paths keep full
// realpath validation; missing paths validate the canonical parent and use
// only their basename. A dangling symlink at the target is never followed.
async function validateWritePath(requestedPath: string): Promise<string | null> {
  const resolved = path.resolve(requestedPath);
  try {
    const real = await fs.realpath(resolved);
    return await validateCanonicalPath(real);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }

  try {
    const targetStat = await fs.lstat(resolved);
    if (targetStat.isSymbolicLink()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }

  try {
    const parentReal = await fs.realpath(path.dirname(resolved));
    const canonicalParent = await validateCanonicalPath(parentReal);
    return canonicalParent ? path.join(canonicalParent, path.basename(resolved)) : null;
  } catch {
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
      // For large files, only read the beginning. Allocate the actual bounded
      // read size (min(file size, maxSize + 1)) — never the whole file and never
      // a fixed maxSize buffer for a file only just over the limit. The +1 byte
      // lets us detect truncation from the read and avoids cutting a multibyte
      // UTF-8 sequence exactly at the limit.
      const readLen = Math.min(stat.size, maxSize + 1);
      const handle = await fs.open(validatedPath, 'r');
      try {
        const buffer = Buffer.alloc(readLen);
        const { bytesRead } = await handle.read(buffer, 0, readLen, 0);
        // Honour bytesRead so a short read cannot leave zero-padding in content.
        const available = buffer.subarray(0, bytesRead);
        // If we read past maxSize, the file exceeds the limit (truncated); keep
        // only the first maxSize bytes before decoding.
        const limit = bytesRead > maxSize ? maxSize : bytesRead;
        // Decode only complete UTF-8 characters within the limit so a multibyte
        // sequence split at the cut does not become a U+FFFD replacement char.
        // StringDecoder.write() drops the incomplete trailing sequence.
        let content = new StringDecoder('utf8').write(available.subarray(0, limit));
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
      } finally {
        await handle.close();
      }
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

    // Enforce the cap before touching the disk (Content-Length is advisory, so
    // writeUploadBody still counts the bytes it actually receives).
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      res.status(413).json({ error: new UploadTooLargeError(MAX_UPLOAD_BYTES).message });
      return;
    }

    // Ensure upload directory exists
    await fs.mkdir(UPLOAD_DIR, { recursive: true });

    // Stream the request body to file, counting bytes against the cap for
    // every content type
    let size: number;
    try {
      size = await writeUploadBody(req, savedPath, MAX_UPLOAD_BYTES);
    } catch (error) {
      // Never leave a partial or over-cap file behind
      await fs.unlink(savedPath).catch(() => undefined);
      if (error instanceof UploadTooLargeError) {
        res.status(413).json({ error: error.message });
        return;
      }
      throw error;
    }

    res.json({
      success: true,
      path: savedPath,
      name: sanitizedName,
      savedName,
      size,
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

    const safePath = await validateWritePath(filePath);
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
