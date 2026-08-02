import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import { createWriteStream } from 'fs';
import { createServer } from 'http';
import { isIP } from 'net';
import { fileTypeFromFile } from 'file-type';
import { fileURLToPath } from 'url';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  statfs,
  unlink,
  writeFile
} from 'fs/promises';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { pipeline } from 'stream/promises';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const UPLOAD_DIR = path.resolve(ROOT_DIR, 'uploads');
const PARTIAL_DIR = path.resolve(UPLOAD_DIR, '.partial');
const SALT = randomBytes(16).toString('hex');
const MB = 1024 * 1024;
const STORED_FILE_RE =
  /^([a-f0-9]{32}|[a-f0-9]{16})-([A-Za-z0-9._-]{1,150})$/;

const envInt = (name, fallback) => {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const CONFIG = {
  CACHE_LIMIT_FILES: 1000,
  CACHE_LIMIT_IPS: 1000,
  DISK_RESERVED: envInt('DISK_RESERVED_MB', 1024) * MB,
  HOST: process.env.HOST || '127.0.0.1',
  MAX_ACTIVE_UPLOADS_PER_IP: envInt('MAX_ACTIVE_UPLOADS_PER_IP', 5),
  MAX_REQ_PER_MIN: envInt('MAX_REQ_PER_MIN_PER_IP', 100),
  MAX_UPLOAD_SIZE: envInt('MAX_UPLOAD_MB', 8192) * MB,
  MAX_USERS: envInt('MAX_USERS', 100),
  PORT: envInt('PORT', 3000),
  PUBLIC_SERVE: process.env.PUBLIC_SERVE !== 'false',
  TRUST_PROXY: (process.env.TRUST_PROXY || 'loopback')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  UPLOAD_CHUNK_SIZE:
    Math.min(envInt('UPLOAD_CHUNK_MB', 64), 90) * MB,
  UPLOAD_CHUNKS_PER_MIN: envInt(
    'UPLOAD_CHUNKS_PER_MIN_PER_IP',
    300
  ),
  UPLOAD_INIT_PER_MIN: envInt(
    'UPLOAD_INIT_PER_MIN_PER_IP',
    20
  ),
  UPLOAD_SESSION_TTL:
    envInt('UPLOAD_SESSION_TTL_HOURS', 24) * 60 * 60 * 1000
};

const app = express();
app.set('trust proxy', CONFIG.TRUST_PROXY);
const trustProxy = app.get('trust proxy fn');

await mkdir(PARTIAL_DIR, { recursive: true, mode: 0o700 });

const fileMetaCache = new Map();
const ipRateLimits = new Map();
const activeHues = new Map();
const uploadLocks = new Set();
const uploadOwners = new Map();
const activeUploadsByIp = new Map();
let pendingUploadBytes = 0;

const getHeader = (req, name) => {
  const value = req.headers?.[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string'
    ? text.split(',')[0].trim()
    : '';
};

const isTrustedPeer = req => {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && trustProxy(address, 0);
};

const getIp = req => {
  if (typeof req.ip === 'string' && isIP(req.ip)) {
    return req.ip;
  }

  const peer = req.socket?.remoteAddress || '';

  if (isTrustedPeer(req)) {
    const forwarded = getHeader(req, 'x-real-ip');
    if (isIP(forwarded)) return forwarded;
  }

  return isIP(peer) ? peer : 'unknown';
};

const anonymizeIp = ip => {
  if (ip === 'unknown') return 'unknown';
  return createHash('sha256')
    .update(ip + SALT)
    .digest('hex')
    .slice(0, 16);
};

const getIpHash = req => {
  const ip = getIp(req);
  return anonymizeIp(ip === 'unknown' ? ip : ipKeyGenerator(ip));
};

const isAllowedSocketRequest = req => {
  const origin = getHeader(req, 'origin');
  if (!origin) return true;

  const host = getHeader(req, 'host').toLowerCase();
  if (!host) return false;

  let protocol = req.socket?.encrypted ? 'https' : 'http';

  if (isTrustedPeer(req)) {
    const forwarded = getHeader(req, 'x-forwarded-proto').toLowerCase();
    if (forwarded === 'http' || forwarded === 'https') {
      protocol = forwarded;
    }
  }

  try {
    const parsed = new URL(origin);
    return parsed.protocol === `${protocol}:` &&
      parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
};

const assignHue = () => {
  const hues = [...activeHues.values()].sort((a, b) => a - b);
  if (!hues.length) return 210;

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

const sanitizeName = value => {
  const source = path.posix
    .basename(String(value || 'file').replace(/\\/g, '/'))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');

  let safe = source
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  if (!safe) safe = 'file';

  let extension = path.extname(safe);
  if (extension.length > 20) extension = '';

  let stem = extension ? safe.slice(0, -extension.length) : safe;
  stem = stem
    .slice(0, 150 - extension.length)
    .replace(/[._-]+$/g, '');

  if (!stem) stem = 'file';
  return `${stem}${extension}`;
};

const parseStoredName = value => {
  if (typeof value !== 'string') return null;
  const match = STORED_FILE_RE.exec(value);
  if (!match) return null;
  return {
    id: match[1],
    safeName: match[2],
    storedName: value
  };
};

const isText = buffer => !buffer.includes(0x00);

const cacheFileMeta = (filename, meta) => {
  if (fileMetaCache.size >= CONFIG.CACHE_LIMIT_FILES) {
    const oldestKey = fileMetaCache.keys().next().value;
    fileMetaCache.delete(oldestKey);
  }
  fileMetaCache.set(filename, meta);
};

const detectFileMeta = async filePath => {
  let handle = null;

  try {
    const fileStat = await stat(filePath);
    const size = fileStat.size;
    let detection = null;

    try {
      detection = await fileTypeFromFile(filePath);
    } catch {}

    if (detection) return { mime: detection.mime, size };
    if (!size) return { mime: 'application/octet-stream', size };

    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    const head = buffer.subarray(0, bytesRead);

    return {
      mime: bytesRead && isText(head)
        ? 'text/plain'
        : 'application/octet-stream',
      size
    };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
};

const getCachedFileMeta = async filename => {
  if (fileMetaCache.has(filename)) return fileMetaCache.get(filename);

  const meta = await detectFileMeta(path.join(UPLOAD_DIR, filename));
  if (meta) cacheFileMeta(filename, meta);
  return meta;
};

const sessionPath = id => path.join(PARTIAL_DIR, `${id}.json`);
const partPath = id => path.join(PARTIAL_DIR, `${id}.part`);

const safeStat = async filePath => {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
};

const writeSession = async session => {
  const target = sessionPath(session.id);
  const temporary = path.join(
    PARTIAL_DIR,
    `${session.id}.json.tmp-${randomBytes(6).toString('hex')}`
  );

  try {
    await writeFile(
      temporary,
      JSON.stringify(session),
      { flag: 'wx', mode: 0o600 }
    );
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
};

const validSession = session => {
  if (!session || typeof session !== 'object') return false;
  if (!/^[a-f0-9]{32}$/.test(session.id)) return false;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,149}$/.test(session.safeName)
  ) {
    return false;
  }
  if (session.storedName !== `${session.id}-${session.safeName}`) {
    return false;
  }
  if (
    !Number.isSafeInteger(session.expectedSize) ||
    session.expectedSize < 0 ||
    session.expectedSize > CONFIG.MAX_UPLOAD_SIZE
  ) {
    return false;
  }
  return session.state === 'active' || session.state === 'complete';
};

const readSession = async id => {
  try {
    const session = JSON.parse(await readFile(sessionPath(id), 'utf8'));
    return validSession(session) ? session : null;
  } catch {
    return null;
  }
};

const activeCount = ipHash =>
  activeUploadsByIp.get(ipHash)?.size || 0;

const acquireUpload = id => {
  if (uploadLocks.has(id)) return false;
  uploadLocks.add(id);
  return true;
};

const claimUpload = (id, ipHash) => {
  if (uploadOwners.has(id)) return true;
  if (activeCount(ipHash) >= CONFIG.MAX_ACTIVE_UPLOADS_PER_IP) {
    return false;
  }

  let uploads = activeUploadsByIp.get(ipHash);
  if (!uploads) {
    uploads = new Set();
    activeUploadsByIp.set(ipHash, uploads);
  }

  uploads.add(id);
  uploadOwners.set(id, ipHash);
  return true;
};

const releaseUpload = id => {
  const ipHash = uploadOwners.get(id);
  if (!ipHash) return;

  uploadOwners.delete(id);
  const uploads = activeUploadsByIp.get(ipHash);
  if (!uploads) return;

  uploads.delete(id);
  if (!uploads.size) activeUploadsByIp.delete(ipHash);
};

const completedPayload = session => ({
  uploadId: session.id,
  offset: session.expectedSize,
  length: session.expectedSize,
  chunkSize: CONFIG.UPLOAD_CHUNK_SIZE,
  complete: true,
  url: `/uploads/${session.storedName}`,
  downloadUrl: `/download/${session.storedName}`,
  name: session.safeName,
  size: session.expectedSize,
  type: session.mime || 'application/octet-stream'
});

const activePayload = (session, offset) => ({
  uploadId: session.id,
  offset,
  length: session.expectedSize,
  chunkSize: CONFIG.UPLOAD_CHUNK_SIZE,
  complete: false,
  name: session.safeName
});

const finalizeSession = async session => {
  const partialFile = partPath(session.id);
  const finalFile = path.join(UPLOAD_DIR, session.storedName);
  const existingFinal = await safeStat(finalFile);
  let meta;

  if (existingFinal) {
    if (
      !existingFinal.isFile() ||
      existingFinal.size !== session.expectedSize
    ) {
      throw new Error('Final file conflict');
    }
    meta = await detectFileMeta(finalFile);
    await unlink(partialFile).catch(() => {});
  } else {
    const partialStat = await safeStat(partialFile);
    if (
      !partialStat ||
      !partialStat.isFile() ||
      partialStat.size !== session.expectedSize
    ) {
      throw new Error('Upload is incomplete');
    }

    meta = await detectFileMeta(partialFile);
    if (!meta || meta.size !== session.expectedSize) {
      throw new Error('Unable to inspect upload');
    }

    await rename(partialFile, finalFile);
  }

  if (!meta) meta = await detectFileMeta(finalFile);
  if (!meta) throw new Error('Unable to inspect finalized upload');

  const completed = {
    ...session,
    state: 'complete',
    mime: meta.mime,
    completedAt: Date.now(),
    updatedAt: Date.now()
  };

  await writeSession(completed);
  cacheFileMeta(completed.storedName, {
    mime: completed.mime,
    size: completed.expectedSize
  });
  releaseUpload(completed.id);
  return completed;
};

const resolveSession = async session => {
  const finalFile = path.join(UPLOAD_DIR, session.storedName);

  if (session.state === 'complete') {
    const finalStat = await safeStat(finalFile);
    if (
      !finalStat ||
      !finalStat.isFile() ||
      finalStat.size !== session.expectedSize
    ) {
      return null;
    }

    if (!session.mime) {
      const completed = await finalizeSession(session);
      return { session: completed, offset: completed.expectedSize };
    }

    return { session, offset: session.expectedSize };
  }

  const partialStat = await safeStat(partPath(session.id));

  if (partialStat) {
    if (
      !partialStat.isFile() ||
      partialStat.size > session.expectedSize
    ) {
      throw new Error('Invalid partial upload');
    }

    if (partialStat.size === session.expectedSize) {
      const completed = await finalizeSession(session);
      return { session: completed, offset: completed.expectedSize };
    }

    return { session, offset: partialStat.size };
  }

  const finalStat = await safeStat(finalFile);
  if (
    finalStat &&
    finalStat.isFile() &&
    finalStat.size === session.expectedSize
  ) {
    const completed = await finalizeSession(session);
    return { session: completed, offset: completed.expectedSize };
  }

  return null;
};

const setUploadHeaders = (res, session, offset) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Upload-Offset', String(offset));
  res.setHeader('Upload-Length', String(session.expectedSize));
  res.setHeader('Upload-Chunk-Size', String(CONFIG.UPLOAD_CHUNK_SIZE));
  res.setHeader(
    'Upload-Complete',
    session.state === 'complete' ? 'true' : 'false'
  );
  res.setHeader('Upload-Name', session.safeName);

  if (session.state === 'complete') {
    res.setHeader('Upload-URL', `/uploads/${session.storedName}`);
    res.setHeader(
      'Upload-Download-URL',
      `/download/${session.storedName}`
    );
    res.setHeader(
      'Upload-Type',
      session.mime || 'application/octet-stream'
    );
  }
};

const cleanupSessions = async () => {
  const now = Date.now();
  const entries = await readdir(PARTIAL_DIR).catch(() => []);
  const validIds = new Set();

  for (const entry of entries) {
    const match = /^([a-f0-9]{32})\.json$/.exec(entry);
    if (!match) continue;

    const id = match[1];
    const session = await readSession(id);

    if (!session) {
      const info = await safeStat(path.join(PARTIAL_DIR, entry));
      if (info && now - info.mtimeMs > CONFIG.UPLOAD_SESSION_TTL) {
        await unlink(path.join(PARTIAL_DIR, entry)).catch(() => {});
      }
      continue;
    }

    validIds.add(id);
    if (!acquireUpload(id)) continue;

    try {
      let lastActivity =
        session.completedAt || session.updatedAt || session.createdAt || 0;

      if (session.state === 'active') {
        const info = await safeStat(partPath(id));
        if (info) lastActivity = Math.max(lastActivity, info.mtimeMs);
      }

      if (now - lastActivity <= CONFIG.UPLOAD_SESSION_TTL) continue;

      if (session.state === 'active') {
        await unlink(partPath(id)).catch(() => {});
      }

      await unlink(sessionPath(id)).catch(() => {});
      releaseUpload(id);
      validIds.delete(id);
    } finally {
      uploadLocks.delete(id);
    }
  }

  for (const entry of entries) {
    const partMatch = /^([a-f0-9]{32})\.part$/.exec(entry);

    if (partMatch && !validIds.has(partMatch[1])) {
      const target = path.join(PARTIAL_DIR, entry);
      const info = await safeStat(target);
      if (info && now - info.mtimeMs > CONFIG.UPLOAD_SESSION_TTL) {
        await unlink(target).catch(() => {});
      }
      continue;
    }

    if (/^[a-f0-9]{32}\.json\.tmp-[a-f0-9]+$/.test(entry)) {
      const target = path.join(PARTIAL_DIR, entry);
      const info = await safeStat(target);
      if (info && now - info.mtimeMs > 60 * 60 * 1000) {
        await unlink(target).catch(() => {});
      }
    }
  }
};

await cleanupSessions();

const cleanupTimer = setInterval(
  () => cleanupSessions().catch(console.error),
  Math.min(CONFIG.UPLOAD_SESSION_TTL, 60 * 60 * 1000)
);
cleanupTimer.unref();

const httpServer = createServer(app);

app.use('/uploads/.partial', (req, res) => {
  res.sendStatus(404);
});

if (CONFIG.PUBLIC_SERVE) {
  app.use(express.static(path.join(ROOT_DIR, 'public')));
  app.use('/uploads', express.static(UPLOAD_DIR, {
    dotfiles: 'deny',
    setHeaders: res => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'none'; sandbox allow-popups"
      );
      res.setHeader('Content-Disposition', 'inline');
    }
  }));
}

const limiterOptions = limit => ({
  keyGenerator: getIpHash,
  legacyHeaders: false,
  limit,
  standardHeaders: 'draft-8',
  windowMs: 60000
});

const uploadInitLimiter = rateLimit(
  limiterOptions(CONFIG.UPLOAD_INIT_PER_MIN)
);
const uploadTransferLimiter = rateLimit(
  limiterOptions(CONFIG.UPLOAD_CHUNKS_PER_MIN)
);
const uploadJson = express.json({ limit: '8kb' });

app.post(
  '/upload',
  uploadInitLimiter,
  uploadJson,
  async (req, res, next) => {
    const size = Number(req.body?.size);

    if (!Number.isSafeInteger(size) || size < 0) {
      return res.status(400).json({ error: 'Invalid file size' });
    }

    if (size > CONFIG.MAX_UPLOAD_SIZE) {
      return res.status(413).json({ error: 'File too large' });
    }

    const ipHash = getIpHash(req);
    if (activeCount(ipHash) >= CONFIG.MAX_ACTIVE_UPLOADS_PER_IP) {
      return res.status(429).json({
        error: 'Too many active uploads'
      });
    }

    const id = randomBytes(16).toString('hex');
    const safeName = sanitizeName(req.body?.name);
    const session = {
      id,
      safeName,
      storedName: `${id}-${safeName}`,
      expectedSize: size,
      state: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    if (!claimUpload(id, ipHash)) {
      return res.status(429).json({
        error: 'Too many active uploads'
      });
    }

    try {
      await writeFile(
        partPath(id),
        Buffer.alloc(0),
        { flag: 'wx', mode: 0o640 }
      );
      await writeSession(session);

      if (size === 0) {
        uploadLocks.add(id);
        try {
          const completed = await finalizeSession(session);
          return res.status(201).json(completedPayload(completed));
        } finally {
          uploadLocks.delete(id);
        }
      }

      res.status(201).json(activePayload(session, 0));
    } catch (error) {
      releaseUpload(id);
      await unlink(partPath(id)).catch(() => {});
      await unlink(sessionPath(id)).catch(() => {});
      next(error);
    }
  }
);

app.head('/upload', uploadTransferLimiter, async (req, res, next) => {
  const id = String(req.headers['upload-id'] || '');

  if (!/^[a-f0-9]{32}$/.test(id)) {
    return res.sendStatus(400);
  }

  if (!acquireUpload(id)) {
    res.setHeader('Retry-After', '1');
    return res.sendStatus(409);
  }

  try {
    const session = await readSession(id);
    if (!session) return res.sendStatus(404);

    if (session.state === 'active' && !claimUpload(id, getIpHash(req))) {
      return res.sendStatus(429);
    }

    const resolved = await resolveSession(session);
    if (!resolved) return res.sendStatus(404);

    setUploadHeaders(res, resolved.session, resolved.offset);
    res.status(200).end();
  } catch (error) {
    next(error);
  } finally {
    uploadLocks.delete(id);
  }
});

app.patch(
  '/upload',
  uploadTransferLimiter,
  async (req, res, next) => {
    const id = String(req.headers['upload-id'] || '');
    const offsetValue = String(req.headers['upload-offset'] || '');
    const lengthValue = String(req.headers['content-length'] || '');

    if (!/^[a-f0-9]{32}$/.test(id)) {
      req.resume();
      return res.status(400).json({ error: 'Invalid upload ID' });
    }

    if (req.headers['transfer-encoding']) {
      req.resume();
      return res.status(400).json({
        error: 'Transfer-Encoding is not allowed'
      });
    }

    if (!/^\d+$/.test(offsetValue) || !/^\d+$/.test(lengthValue)) {
      req.resume();
      return res.status(411).json({
        error: 'Valid offset and Content-Length required'
      });
    }

    const requestedOffset = Number(offsetValue);
    const contentLength = Number(lengthValue);

    if (
      !Number.isSafeInteger(requestedOffset) ||
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0
    ) {
      req.resume();
      return res.status(400).json({ error: 'Invalid chunk framing' });
    }

    if (contentLength > CONFIG.UPLOAD_CHUNK_SIZE) {
      req.resume();
      return res.status(413).json({ error: 'Chunk too large' });
    }

    if (!acquireUpload(id)) {
      req.resume();
      res.setHeader('Retry-After', '1');
      return res.status(409).json({ error: 'Upload is busy' });
    }

    let reserved = 0;

    try {
      const session = await readSession(id);
      if (!session) {
        req.resume();
        return res.status(404).json({ error: 'Upload not found' });
      }

      if (
        session.state === 'active' &&
        !claimUpload(id, getIpHash(req))
      ) {
        req.resume();
        return res.status(429).json({
          error: 'Too many active uploads'
        });
      }

      const resolved = await resolveSession(session);
      if (!resolved) {
        req.resume();
        return res.status(404).json({ error: 'Upload not found' });
      }

      if (resolved.session.state === 'complete') {
        req.resume();
        return res.json(completedPayload(resolved.session));
      }

      if (requestedOffset !== resolved.offset) {
        req.resume();
        res.setHeader('Upload-Offset', String(resolved.offset));
        return res.status(409).json({ error: 'Offset mismatch' });
      }

      if (
        requestedOffset + contentLength >
        resolved.session.expectedSize
      ) {
        req.resume();
        return res.status(400).json({
          error: 'Chunk exceeds declared file size'
        });
      }

      const disk = await statfs(UPLOAD_DIR);
      const available = disk.bavail * disk.bsize;
      const required =
        CONFIG.DISK_RESERVED + pendingUploadBytes + contentLength;

      if (available < required) {
        req.resume();
        return res.status(507).json({ error: 'Storage full' });
      }

      pendingUploadBytes += contentLength;
      reserved = contentLength;

      await pipeline(
        req,
        createWriteStream(partPath(id), { flags: 'a' })
      );

      const written = await stat(partPath(id));
      if (written.size !== requestedOffset + contentLength) {
        throw new Error('Incomplete chunk write');
      }

      if (written.size === resolved.session.expectedSize) {
        const completed = await finalizeSession(resolved.session);
        return res.json(completedPayload(completed));
      }

      res.setHeader('Upload-Offset', String(written.size));
      res.status(204).end();
    } catch (error) {
      if (!req.destroyed && !res.headersSent) next(error);
    } finally {
      if (reserved) pendingUploadBytes -= reserved;
      uploadLocks.delete(id);
    }
  }
);

app.get('/download/:storedName', async (req, res, next) => {
  const parsed = parseStoredName(req.params.storedName);
  if (!parsed) return res.sendStatus(404);

  const filePath = path.join(UPLOAD_DIR, parsed.storedName);
  const info = await safeStat(filePath);

  if (!info || !info.isFile()) return res.sendStatus(404);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.download(filePath, parsed.safeName, error => {
    if (!error) return;
    if (!res.headersSent) next(error);
    else console.error(error);
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  const status =
    error.status === 413 || error.type === 'entity.too.large'
      ? 413
      : 500;

  if (status === 500) console.error(error);
  res.status(status).json({
    error: status === 413 ? 'Request too large' : 'Internal server error'
  });
});

const io = new Server(httpServer, {
  allowRequest: (req, callback) => {
    callback(null, isAllowedSocketRequest(req));
  },
  maxHttpBufferSize: 128 * 1024
});

const ipCleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [id, data] of ipRateLimits) {
    if (now > data.expires) ipRateLimits.delete(id);
  }
}, 60000);
ipCleanupTimer.unref();

io.use((socket, next) => {
  if (io.sockets.sockets.size >= CONFIG.MAX_USERS) {
    return next(new Error('ERR_SERVER_FULL'));
  }
  next();
});

io.on('connection', socket => {
  if (io.sockets.sockets.size > CONFIG.MAX_USERS) {
    socket.disconnect(true);
    return;
  }

  const hue = assignHue();
  activeHues.set(socket.id, hue);
  const ipHash = getIpHash(socket.request);

  socket.emit('session', { hue });
  io.emit('userCountUpdate', io.sockets.sockets.size);

  socket.on('disconnect', () => {
    activeHues.delete(socket.id);
    io.emit('userCountUpdate', io.sockets.sockets.size);
  });

  socket.on('message', async input => {
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
      socket.emit('error', 'Rate limit exceeded');
      return;
    }

    if (!input || typeof input !== 'object') return;

    const tempId =
      typeof input.tempId === 'string' &&
      /^[A-Za-z0-9-]{1,100}$/.test(input.tempId)
        ? input.tempId
        : undefined;

    const currentHue = activeHues.get(socket.id) ?? 210;

    if (input.type === 'text') {
      if (
        typeof input.content !== 'string' ||
        !input.content.length ||
        input.content.length >= 65536
      ) {
        return;
      }

      io.emit('message', {
        type: 'text',
        content: input.content,
        tempId,
        senderId: socket.id,
        timestamp: now,
        hue: currentHue
      });
      return;
    }

    if (
      input.type !== 'file' ||
      typeof input.content !== 'string' ||
      !input.content.startsWith('/uploads/')
    ) {
      return;
    }

    const storedName = input.content.slice('/uploads/'.length);
    const parsed = parseStoredName(storedName);
    if (!parsed) return;

    try {
      const meta = await getCachedFileMeta(parsed.storedName);
      if (!meta) return;

      io.emit('message', {
        type: 'file',
        content: `/uploads/${parsed.storedName}`,
        downloadUrl: `/download/${parsed.storedName}`,
        name: parsed.safeName,
        fileType: meta.mime,
        size: meta.size,
        tempId,
        senderId: socket.id,
        timestamp: now,
        hue: currentHue
      });
    } catch (error) {
      console.error(error);
    }
  });
});

const shutdown = () => {
  clearInterval(cleanupTimer);
  clearInterval(ipCleanupTimer);

  httpServer.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 1000).unref();
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

httpServer.listen(CONFIG.PORT, CONFIG.HOST, () => {
  console.log(`Server running on ${CONFIG.HOST}:${CONFIG.PORT}`);
});
