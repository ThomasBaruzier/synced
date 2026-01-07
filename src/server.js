import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { fileTypeFromFile, fileTypeFromBuffer } from 'file-type';
import { fileURLToPath } from 'url';
import { mkdir, open, stat, statfs, unlink } from 'fs/promises';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOAD_DIR = path.resolve(ROOT_DIR, 'uploads');
const SALT = randomBytes(16).toString('hex');
const MAX_PATH_LENGTH = 256;

await mkdir(UPLOAD_DIR, { recursive: true });

const CONFIG = {
  CACHE_LIMIT_FILES: 1000,
  CACHE_LIMIT_IPS: 1000,
  DISK_RESERVED: (parseInt(process.env.DISK_RESERVED_MB) || 1024) * 1024 * 1024,
  HOST: process.env.HOST || '127.0.0.1',
  MAX_REQ_PER_MIN: parseInt(process.env.MAX_REQ_PER_MIN_PER_IP) || 100,
  MAX_UPLOAD_SIZE: (parseInt(process.env.MAX_UPLOAD_MB) || 8192) * 1024 * 1024,
  MAX_USERS: parseInt(process.env.MAX_USERS) || 100,
  PORT: parseInt(process.env.PORT) || 3000,
  PUBLIC_SERVE: process.env.PUBLIC_SERVE === 'true',
  TRUST_PROXY: (process.env.TRUST_PROXY || 'loopback').split(',')
};

const fileMetaCache = new Map();
const ipRateLimits = new Map();
const activeHues = new Map();
let pendingUploadBytes = 0;

const getIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

const anonymizeIp = (ip) => {
  if (ip === 'unknown') return 'unknown';
  return createHash('sha256')
    .update(ip + SALT)
    .digest('hex')
    .slice(0, 8);
};

const assignHue = () => {
  const hues = [...activeHues.values()].sort((a, b) => a - b);
  if (hues.length === 0) return 210;

  let maxGap = 0;
  let bestHue = 0;

  for (let i = 0; i < hues.length; i++) {
    const current = hues[i];
    const next = hues[(i + 1) % hues.length];
    let gap = next - current;
    if (gap <= 0) gap += 360;

    if (gap > maxGap) {
      maxGap = gap;
      bestHue = (current + gap / 2) % 360;
    }
  }

  return bestHue;
};

const isText = (buf) => !buf.includes(0x00);

const cacheFileMeta = (filename, meta) => {
  if (fileMetaCache.size >= CONFIG.CACHE_LIMIT_FILES) {
    const oldestKey = fileMetaCache.keys().next().value;
    fileMetaCache.delete(oldestKey);
  }
  fileMetaCache.set(filename, meta);
};

const detectFileMeta = async (filePath) => {
  let handle = null;
  try {
    const fileStat = await stat(filePath);
    const size = fileStat.size;
    const detection = await fileTypeFromFile(filePath);

    if (detection) return { mime: detection.mime, size };

    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);

    const head = buffer.slice(0, bytesRead);
    const mime = isText(head) ? 'text/plain' : 'application/octet-stream';

    return { mime, size };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

const getCachedFileMeta = async (filename) => {
  if (fileMetaCache.has(filename)) return fileMetaCache.get(filename);
  const filePath = path.join(UPLOAD_DIR, filename);
  const meta = await detectFileMeta(filePath);
  if (meta) cacheFileMeta(filename, meta);
  return meta;
};

const app = express();
const httpServer = createServer(app);

app.set('trust proxy', CONFIG.TRUST_PROXY);

if (CONFIG.PUBLIC_SERVE) {
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  app.use('/uploads', express.static(UPLOAD_DIR, {
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; sandbox allow-popups"
      );
      res.setHeader('Content-Disposition', 'inline');
    }
  }));
}

const upload = multer({
  limits: { fileSize: CONFIG.MAX_UPLOAD_SIZE },
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const id = randomBytes(8).toString('hex');
      const ext = path.extname(file.originalname);
      const name = path.basename(file.originalname, ext);
      let safeName = name
        .replace(/[^a-z0-9.-]/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
      if (safeName.length > 100)
        safeName = safeName.substring(0, 100);
      safeName = safeName.replace(/_+$/, '');
      cb(null, `${id}-${safeName}${ext}`);
    }
  })
}).single('file');

const uploadLimiter = rateLimit({
  limit: 100,
  windowMs: 60000,
});

app.post('/upload', uploadLimiter, (req, res) => {
  upload(req, res, async (err) => {
    try {
      if (err) {
        if (req.file?.path) await unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: err.message });
      }

      const stats = await statfs(UPLOAD_DIR);
      const avail = stats.bavail * stats.bsize;
      const len = parseInt(req.headers['content-length']);
      const reserved = CONFIG.DISK_RESERVED + pendingUploadBytes;

      if (isNaN(len) || len <= 0) {
        if (req.file?.path) await unlink(req.file.path).catch(() => {});
        return res.status(411).json({ error: 'Length Required' });
      }

      if (len > avail - reserved) {
        if (req.file?.path) await unlink(req.file.path).catch(() => {});
        return res.status(507).json({ error: 'Storage full' });
      }

      pendingUploadBytes += len;
      let tracked = true;

      const releaseSpace = () => {
        if (tracked) {
          pendingUploadBytes -= len;
          tracked = false;
        }
      };

      res.on('finish', releaseSpace);
      res.on('close', releaseSpace);

      const meta = await detectFileMeta(req.file.path);
      if (meta) cacheFileMeta(req.file.filename, meta);

      res.json({ url: `/uploads/${req.file.filename}` });
    } catch (e) {
      if (req.file?.path) await unlink(req.file.path).catch(() => {});
      res.status(500).json({ error: e.message });
    }
  });
});

const io = new Server(httpServer, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2 * 1024 * 1024
});

setInterval(() => {
  const now = Date.now();
  for (const [id, data] of ipRateLimits) {
    if (now > data.expires) ipRateLimits.delete(id);
  }
}, 60000);

io.use((socket, next) => {
  if (io.sockets.sockets.size >= CONFIG.MAX_USERS) {
    return next(new Error('ERR_SERVER_FULL'));
  }
  next();
});

io.on('connection', (socket) => {
  if (io.sockets.sockets.size > CONFIG.MAX_USERS) {
    socket.disconnect(true);
    return;
  }

  const hue = assignHue();
  activeHues.set(socket.id, hue);

  const rawIp = getIp(socket.request);
  const ipHash = anonymizeIp(rawIp);

  socket.emit('session', { hue });
  io.emit('userCountUpdate', io.sockets.sockets.size);

  socket.on('disconnect', () => {
    activeHues.delete(socket.id);
    io.emit('userCountUpdate', io.sockets.sockets.size);
  });

  socket.on('message', async (msg) => {
    const now = Date.now();
    let limitData = ipRateLimits.get(ipHash);

    if (!limitData || now > limitData.expires) {
      if (ipRateLimits.size >= CONFIG.CACHE_LIMIT_IPS) {
        const oldest = ipRateLimits.keys().next().value;
        ipRateLimits.delete(oldest);
      }
      limitData = { count: 0, expires: now + 60000 };
      ipRateLimits.set(ipHash, limitData);
    }

    if (++limitData.count > CONFIG.MAX_REQ_PER_MIN) {
      return socket.emit('error', 'Rate limit exceeded');
    }

    msg.senderId = socket.id;
    msg.timestamp = now;

    const h = activeHues.get(socket.id);
    msg.hue = (h !== undefined) ? h : 210;

    if (msg.type === 'text') {
      if (typeof msg.content === 'string' && msg.content.length < 65536) {
        io.emit('message', msg);
      }
      return;
    }

    if (msg.type !== 'file') return;
    if (!msg.content.startsWith('/uploads/') && !msg.content.startsWith('data:'))
      return;
    if (msg.content.startsWith('/uploads/') &&
        msg.content.length > MAX_PATH_LENGTH) return;

    const base = String(msg.name || 'file');
    msg.name = path.basename(base)
      .replace(/[^a-z0-9_.-]/gi, '_')
      .replace(/_+/g, '_');

    try {
      let mime = 'application/octet-stream';
      let size = 0;

      if (msg.content.startsWith('/uploads/')) {
        const filename = path.basename(msg.content);
        const meta = await getCachedFileMeta(filename);
        if (!meta) return;
        mime = meta.mime;
        size = meta.size;
      } else if (msg.content.startsWith('data:')) {
        const parts = msg.content.split(',');
        if (parts.length < 2) return;
        const b = Buffer.from(parts[1], 'base64');
        size = b.length;
        const ft = await fileTypeFromBuffer(b);
        if (ft) mime = ft.mime;
        else if (isText(b)) mime = 'text/plain';
      }

      msg.fileType = mime;
      msg.size = size;

      io.emit('message', msg);
    } catch (e) {
      console.error(e);
    }
  });
});

const shutdown = (signal) => {
  httpServer.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 1000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpServer.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`Server running on ${CONFIG.HOST}:${CONFIG.PORT}`);
});
