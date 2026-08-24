const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SERVERS = (process.env.SERVERS || 'server-1,server-2,server-3,server-4,server-5')
  .split(',').map(s => s.trim()).filter(Boolean);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'store.json');
const LONG_POLL_MS = 25000;

// ---- state ----------------------------------------------------------------
const store = {};   // name -> { text, version, updatedAt }
const waiters = {}; // name -> [ {res, version, timer} ]

for (const name of SERVERS) {
  store[name] = { text: '', version: 0, updatedAt: null };
  waiters[name] = [];
}

try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  for (const name of SERVERS) if (saved[name]) store[name] = saved[name];
} catch (e) { /* first run, no file yet */ }

let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdir(path.dirname(DATA_FILE), { recursive: true }, () => {
      fs.writeFile(DATA_FILE, JSON.stringify(store), () => {});
    });
  }, 300);
}

function setText(name, text) {
  const slot = store[name];
  slot.text = text;
  slot.version += 1;
  slot.updatedAt = new Date().toISOString();
  persist();
  const pending = waiters[name];
  waiters[name] = [];
  for (const w of pending) {
    clearTimeout(w.timer);
    send(w.res, 200, slot);
  }
}

// ---- helpers --------------------------------------------------------------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > limit) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.ico': 'image/x-icon' };

// ---- routes ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/api/servers') return send(res, 200, { servers: SERVERS });

  if (p === '/api/clip' && req.method === 'GET') {
    const name = url.searchParams.get('server');
    if (!store[name]) return send(res, 404, { error: 'unknown server' });
    const since = Number(url.searchParams.get('since'));
    const slot = store[name];
    // long poll: hold the request until the value actually changes
    if (Number.isFinite(since) && since === slot.version && url.searchParams.get('wait') === '1') {
      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        waiters[name] = waiters[name].filter(w => w !== waiter);
        send(res, 200, store[name]);
      }, LONG_POLL_MS);
      waiters[name].push(waiter);
      req.on('close', () => {
        clearTimeout(waiter.timer);
        waiters[name] = waiters[name].filter(w => w !== waiter);
      });
      return;
    }
    return send(res, 200, slot);
  }

  if (p === '/api/clip' && req.method === 'POST') {
    try {
      const { server: name, text } = JSON.parse(await readBody(req) || '{}');
      if (!store[name]) return send(res, 404, { error: 'unknown server' });
      setText(name, String(text ?? ''));
      return send(res, 200, store[name]);
    } catch (e) {
      return send(res, 400, { error: 'bad request' });
    }
  }

  if (p === '/healthz') return send(res, 200, { ok: true });

  // static files
  const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
  const full = path.join(__dirname, 'public', path.normalize(file));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, () => console.log(`clipboard sync on http://0.0.0.0:${PORT} servers=${SERVERS.join(',')}`));
