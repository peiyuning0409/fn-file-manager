'use strict';

/**
 * 飞牛NAS专属文件资源管理器 - 后端
 * 极致稳定：流式上传/下载、Range断点续传、zip流式打包、路径安全防护、异常兜底
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const PORT = parseInt(process.env.PORT || '8888', 10);
const ROOT = path.resolve(process.env.ROOT || '/data');
const PASSWORD = process.env.PASSWORD || 'changeme';
// token 由密码派生，无状态、重启不变
const ACCESS_TOKEN = crypto.createHash('sha256').update('fnfm:' + PASSWORD).digest('hex');

// 存储空间（卷）定义：key 为相对路径入口，name 为友好显示名
const VOLUME_NAMES = (process.env.VOLUME_NAMES || '主存储,SSD存储').split(',').map((s) => s.trim());
const VOLUMES = [
  { key: 'vol1', name: VOLUME_NAMES[0] || '主存储' },
  { key: 'vol2', name: VOLUME_NAMES[1] || 'SSD存储' },
];

// 上传时限制单文件最大字节数（0 = 不限制）
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10);

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.rar': 'application/x-rar-compressed', '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar', '.gz': 'application/gzip', '.txt': 'text/plain', '.md': 'text/markdown',
};

function guessMime(p) {
  const ext = path.extname(p).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/** 安全解析路径到 ROOT 内，防目录穿越。返回绝对路径或 null */
function resolveSafe(urlPath) {
  if (typeof urlPath !== 'string') return null;
  let p = urlPath;
  try { p = decodeURIComponent(p); } catch (e) { /* 保持原样 */ }
  // 统一分隔符
  p = p.replace(/\\/g, '/');
  if (p.includes('\0')) return null;
  // 去掉前导斜杠，防止绝对路径逃逸
  p = p.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, p);
  // 确保在 ROOT 内
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

/** 相对路径（用于返回给前端，不含前导斜杠） */
function toRel(abs) {
  if (abs === ROOT) return '';
  return abs.slice(ROOT.length + 1).replace(/\\/g, '/');
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** 判断是否已认证（支持 header 与 query，query 用于浏览器原生下载） */
function authorized(req, q) {
  const h = req.headers['x-auth-token'] || '';
  if (h === ACCESS_TOKEN) return true;
  if (q) {
    const qt = q.get('token') || '';
    if (qt === ACCESS_TOKEN) return true;
  }
  return false;
}

/** 生成一个安全的新文件名（存在同名时加序号） */
async function uniquePath(target) {
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  let candidate = target;
  let i = 1;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch (e) {
      return candidate; // 不存在，可用
    }
  }
}

async function handleList(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  let st;
  try { st = await fsp.stat(target); } catch (e) { return sendJSON(res, 404, { ok: false, error: '路径不存在' }); }
  if (!st.isDirectory()) return sendJSON(res, 400, { ok: false, error: '不是目录' });

  let dirents;
  try { dirents = await fsp.readdir(target, { withFileTypes: true }); } catch (e) { return sendJSON(res, 500, { ok: false, error: '读取失败: ' + e.message }); }

  // withFileTypes 直接判类型：目录不 stat（省一半 I/O），仅文件 stat 取大小/时间
  const items = await Promise.all(dirents.map(async (d) => {
    if (d.name.startsWith('.')) return null;
    if (d.isDirectory()) {
      return { name: d.name, type: 'dir', size: 0, mtime: 0 };
    }
    const fp = path.join(target, d.name);
    try {
      const s = await fsp.stat(fp);
      return { name: d.name, type: s.isFile() ? 'file' : 'dir', size: s.isFile() ? s.size : 0, mtime: s.isFile() ? Math.floor(s.mtimeMs) : 0 };
    } catch (e) { return null; }
  }));
  const entries = items.filter(Boolean);
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : (a.type === 'dir' ? -1 : 1)));
  sendJSON(res, 200, { ok: true, path: toRel(target), parent: toRel(path.dirname(target)), entries });
}

/** 存储空间列表（含容量） */
async function handleVolumes(req, res) {
  const vols = await Promise.all(VOLUMES.map(async (v) => {
    const mount = path.join(ROOT, v.key);
    try {
      const s = await fsp.statfs(mount);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = Math.max(0, total - free);
      return {
        name: v.name,
        path: v.key,
        total,
        used,
        free,
        usePct: total ? Math.round((used / total) * 1000) / 10 : 0,
      };
    } catch (e) {
      return { name: v.name, path: v.key, total: 0, used: 0, free: 0, usePct: 0 };
    }
  }));
  sendJSON(res, 200, { ok: true, volumes: vols });
}

/** 递归统计文件夹大小（BFS + 并发，限制深度与文件数防失控） */
async function handleSize(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  try {
    const st = await fsp.lstat(target);
    if (!st.isDirectory()) return sendJSON(res, 200, { ok: true, size: st.size, files: 1, dirs: 0 });
  } catch (e) { return sendJSON(res, 404, { ok: false, error: '路径不存在' }); }

  let totalSize = 0, fileCount = 0, dirCount = 0;
  const MAX_FILES = 200000;
  const MAX_DEPTH = 24;
  const CONCURRENCY = 96;
  const queue = [{ path: target, depth: 0 }];

  while (queue.length && fileCount < MAX_FILES) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(batch.map(async (d) => {
      if (d.depth > MAX_DEPTH || fileCount >= MAX_FILES) return;
      let dirents;
      try { dirents = await fsp.readdir(d.path, { withFileTypes: true }); } catch (e) { return; }
      const subDirs = [];
      await Promise.all(dirents.map(async (ent) => {
        if (fileCount >= MAX_FILES) return;
        if (ent.isDirectory()) {
          dirCount++;
          subDirs.push({ path: path.join(d.path, ent.name), depth: d.depth + 1 });
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          try {
            const s = await fsp.lstat(path.join(d.path, ent.name));
            if (s.isFile()) { totalSize += s.size; fileCount++; }
          } catch (e) {}
        }
      }));
      queue.push(...subDirs);
    }));
  }
  sendJSON(res, 200, {
    ok: true,
    size: totalSize,
    files: fileCount,
    dirs: dirCount,
    truncated: fileCount >= MAX_FILES,
  });
}

async function handleUpload(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });

  // 文件名不允许为空
  if (!path.basename(target)) return sendJSON(res, 400, { ok: false, error: '缺少文件名' });

  const declaredSize = parseInt(req.headers['content-length'] || '0', 10);
  if (MAX_UPLOAD_SIZE > 0 && declaredSize > MAX_UPLOAD_SIZE) {
    return sendJSON(res, 413, { ok: false, error: '文件超过大小限制' });
  }

  // 确保父目录存在
  try { await fsp.mkdir(path.dirname(target), { recursive: true }); }
  catch (e) { return sendJSON(res, 500, { ok: false, error: '创建目录失败: ' + e.message }); }

  // 同名自动重命名，避免覆盖丢失数据
  let finalTarget = target;
  try { finalTarget = await uniquePath(target); } catch (e) {}

  const tmp = finalTarget + '.part-' + crypto.randomBytes(4).toString('hex');
  const ws = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
  let received = 0;
  let aborted = false;

  const cleanup = () => {
    fs.unlink(tmp, () => {});
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (MAX_UPLOAD_SIZE > 0 && received > MAX_UPLOAD_SIZE) {
      aborted = true;
      ws.destroy();
      req.destroy();
      cleanup();
      try { sendJSON(res, 413, { ok: false, error: '文件超过大小限制' }); } catch (e) {}
    }
  });

  ws.on('error', (e) => {
    aborted = true;
    cleanup();
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '写入失败: ' + e.message });
  });

  req.on('error', () => {
    aborted = true;
    ws.destroy();
    cleanup();
  });

  ws.on('finish', async () => {
    if (aborted) return;
    try {
      await fsp.rename(tmp, finalTarget);
      const st = await fsp.stat(finalTarget);
      sendJSON(res, 200, { ok: true, name: path.basename(finalTarget), size: st.size });
    } catch (e) {
      cleanup();
      if (!res.headersSent) sendJSON(res, 500, { ok: false, error: '保存失败: ' + e.message });
    }
  });

  req.pipe(ws);
}

function handleDownload(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) { res.writeHead(400); return res.end('bad path'); }

  fs.stat(target, (err, st) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    if (st.isDirectory()) return handleZipDownload(res, target, q);

    // 单文件下载，支持 Range 断点续传
    const total = st.size;
    const range = req.headers.range;
    let start = 0, end = total - 1, status = 200;

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1] === '' && m[2] !== '') {
          // 后缀范围 bytes=-N
          const n = parseInt(m[2], 10);
          if (!isNaN(n)) { start = Math.max(0, total - n); end = total - 1; status = 206; }
        } else {
          start = parseInt(m[1], 10) || 0;
          end = (m[2] !== '' && !isNaN(parseInt(m[2], 10))) ? parseInt(m[2], 10) : total - 1;
          if (start < total) status = 206;
        }
        if (start < 0) start = 0;
        if (end >= total) end = total - 1;
      }
    }

    const inline = q.get('inline') === '1';
    const disp = inline ? 'inline' : 'attachment';
    const headers = {
      'Content-Type': guessMime(target),
      'Accept-Ranges': 'bytes',
      'Content-Length': (end - start + 1).toString(),
      'Content-Disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    };
    if (status === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    }
    res.writeHead(status, headers);

    const rs = fs.createReadStream(target, { start, end });
    rs.on('error', () => { res.destroy(); });
    rs.pipe(res);
  });
}

function handleZipDownload(res, target) {
  const name = path.basename(target) || 'download';
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip`,
    'Cache-Control': 'no-store',
  });

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (e) => {
    // 打包失败时尽量结束
    try { res.end(); } catch (err) {}
  });
  archive.on('warning', () => {});

  archive.pipe(res);
  archive.directory(target, name);
  archive.finalize().catch(() => {});
}

async function handleMkdir(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  try {
    await fsp.mkdir(target, { recursive: false });
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: e.code === 'EEXIST' ? '目录已存在' : '创建失败: ' + e.message });
  }
}

async function handleRename(req, res, q) {
  const from = resolveSafe(q.get('from') || '');
  const to = resolveSafe(q.get('to') || '');
  if (from === null || to === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  if (path.dirname(from) !== path.dirname(to)) return sendJSON(res, 400, { ok: false, error: '只能同目录重命名' });
  try {
    await fsp.rename(from, to);
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '重命名失败: ' + e.message });
  }
}

async function handleDelete(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  if (target === ROOT) return sendJSON(res, 400, { ok: false, error: '不能删除根目录' });
  try {
    await fsp.rm(target, { recursive: true, force: false });
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '删除失败: ' + e.message });
  }
}

async function handleMove(req, res, q) {
  const from = resolveSafe(q.get('from') || '');
  const to = resolveSafe(q.get('to') || '');
  if (from === null || to === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  if (from === to) return sendJSON(res, 400, { ok: false, error: '源和目标相同' });
  // 目标必须是目录
  try {
    const dst = await fsp.stat(to);
    if (!dst.isDirectory()) return sendJSON(res, 400, { ok: false, error: '目标不是目录' });
    const finalTo = path.join(to, path.basename(from));
    if (finalTo === from) return sendJSON(res, 400, { ok: false, error: '不能移动到自身' });
    try {
      await fsp.rename(from, finalTo);
    } catch (e) {
      if (e.code === 'EXDEV') {
        // 跨卷移动：复制后删除
        await fsp.cp(from, finalTo, { recursive: true });
        await fsp.rm(from, { recursive: true, force: true });
      } else throw e;
    }
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: '移动失败: ' + e.message });
  }
}

async function handleSearch(req, res, q) {
  const target = resolveSafe(q.get('path') || '');
  const keyword = (q.get('q') || '').toLowerCase();
  if (target === null) return sendJSON(res, 400, { ok: false, error: '非法路径' });
  if (!keyword) return sendJSON(res, 200, { ok: true, results: [] });

  const results = [];
  const MAX_RESULTS = 200;
  async function walk(dir, depth) {
    if (results.length >= MAX_RESULTS || depth > 12) return;
    let dirents;
    try { dirents = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    const dirs = [];
    for (const ent of dirents) {
      if (results.length >= MAX_RESULTS) return;
      if (ent.name.startsWith('.')) continue;
      const fp = path.join(dir, ent.name);
      let isDir = ent.isDirectory();
      let st = null;
      if (!isDir) {
        // 文件或符号链接：stat 拿大小/时间，并判断符号链接是否指向目录
        try { st = await fsp.stat(fp); isDir = st.isDirectory(); } catch (e) { st = null; }
      }
      if (ent.name.toLowerCase().includes(keyword)) {
        results.push({
          name: ent.name,
          path: toRel(fp),
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : (st ? st.size : 0),
          mtime: st ? Math.floor(st.mtimeMs) : 0,
        });
      }
      if (isDir) dirs.push(fp);
    }
    for (const d of dirs) await walk(d, depth + 1);
  }
  await walk(target, 0);
  sendJSON(res, 200, { ok: true, results: results.slice(0, MAX_RESULTS) });
}

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const q = url.searchParams;

    // 登录接口（无需认证）
    if (pathname === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let pw = '';
        try { pw = JSON.parse(body).password || ''; } catch (e) {}
        if (pw === PASSWORD) {
          sendJSON(res, 200, { ok: true, token: ACCESS_TOKEN });
        } else {
          sendJSON(res, 401, { ok: false, error: '密码错误' });
        }
      });
      return;
    }

    // 静态资源（前端页面），无需认证（页面本身不含数据）
    if (req.method === 'GET') {
      const staticFile = pathname === '/' ? '/index.html' : pathname;
      if (staticFile === '/index.html' || staticFile === '/style.css' || staticFile === '/app.js' || staticFile === '/favicon.svg') {
        const fp = path.join(__dirname, 'public', staticFile);
        fs.readFile(fp, (err, data) => {
          if (err) { res.writeHead(404); return res.end(); }
          res.writeHead(200, { 'Content-Type': staticFile === '/index.html' ? 'text/html; charset=utf-8' : staticFile === '/style.css' ? 'text/css; charset=utf-8' : staticFile === '/app.js' ? 'text/javascript; charset=utf-8' : 'image/svg+xml', 'Cache-Control': 'no-cache' });
          res.end(data);
        });
        return;
      }
    }

    // 以下接口需要认证
    if (pathname.startsWith('/api/')) {
      if (!authorized(req, q)) return sendJSON(res, 401, { ok: false, error: '未授权' });

      if (pathname === '/api/list' && req.method === 'GET') return handleList(req, res, q);
      if (pathname === '/api/volumes' && req.method === 'GET') return handleVolumes(req, res);
      if (pathname === '/api/size' && req.method === 'GET') return handleSize(req, res, q);
      if (pathname === '/api/upload' && req.method === 'POST') return handleUpload(req, res, q);
      if (pathname === '/api/download' && req.method === 'GET') return handleDownload(req, res, q);
      if (pathname === '/api/mkdir' && req.method === 'POST') return handleMkdir(req, res, q);
      if (pathname === '/api/rename' && req.method === 'POST') return handleRename(req, res, q);
      if (pathname === '/api/delete' && req.method === 'POST') return handleDelete(req, res, q);
      if (pathname === '/api/move' && req.method === 'POST') return handleMove(req, res, q);
      if (pathname === '/api/search' && req.method === 'GET') return handleSearch(req, res, q);
      if (pathname === '/api/ping' && req.method === 'GET') return sendJSON(res, 200, { ok: true, pong: true });
    }

    sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    try { sendJSON(res, 500, { ok: false, error: '服务器错误: ' + e.message }); } catch (e2) {}
  }
});

server.on('error', (e) => {
  console.error('[server error]', e.message);
  if (e.code === 'EADDRINUSE') process.exit(1);
});

// 兜底防崩溃：记录错误但尽量不退出
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e.message));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e && e.message));

server.listen(PORT, () => {
  console.log(`[fn-file-manager] listening on :${PORT}, ROOT=${ROOT}`);
});
