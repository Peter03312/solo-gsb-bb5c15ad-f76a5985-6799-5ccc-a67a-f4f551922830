import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scheduleRequest } from './scheduler.js';
import { initDb, saveSchedule, getSchedule, recentSchedules } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 8080);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'scheduler.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

async function readBody(req, limit = 1 << 20) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/schedule') {
      let input;
      try {
        input = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { ok: false, errors: [{ field: '_', message: '请求体不是合法 JSON' }] });
        return;
      }
      const result = scheduleRequest(input);
      if (!result.ok) {
        // 参数错误或锁定冲突：400
        sendJson(res, 400, result);
        return;
      }
      let savedId = null;
      try {
        savedId = saveSchedule(input, result);
      } catch (e) {
        console.error('保存排程失败:', e);
      }
      sendJson(res, 200, { ...result, id: savedId });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/schedules') {
      sendJson(res, 200, { ok: true, items: recentSchedules(50) });
      return;
    }

    const m = url.pathname.match(/^\/api\/schedules\/(\d+)$/);
    if (req.method === 'GET' && m) {
      const row = getSchedule(Number(m[1]));
      if (!row) {
        sendJson(res, 404, { ok: false, errors: [{ field: '_', message: '记录不存在' }] });
        return;
      }
      sendJson(res, 200, { ok: true, ...row });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'observatory-scheduler' });
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, errors: [{ field: '_', message: '服务器内部错误' }] });
  }
});

initDb(DB_PATH);
server.listen(PORT, () => {
  console.log(`天文台排程服务已启动: http://localhost:${PORT}`);
  console.log(`数据库: ${DB_PATH}`);
});
