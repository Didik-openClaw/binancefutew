import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import type { RiskProfileId } from '../../../shared/types';
import type { Engine } from '../copy/engine';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

export function startApi(engine: Engine, opts: { host: string; port: number; token: string; staticDir?: string; log: (m: string) => void }) {
  const authorized = (req: IncomingMessage) => {
    if (!opts.token) return true;
    const url = new URL(req.url ?? '/', 'http://x');
    return req.headers.authorization === `Bearer ${opts.token}` || url.searchParams.get('token') === opts.token;
  };

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 10_000) reject(new Error('body terlalu besar'));
      });
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) return json(res, 401, { error: 'Token dashboard salah atau belum diisi' });
        if (req.method === 'GET' && url.pathname === '/api/snapshot') return json(res, 200, engine.snapshot());
        if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
        if (req.method === 'POST' && url.pathname === '/api/control') {
          const body = await readBody(req);
          switch (body.action) {
            case 'pause':
              engine.pause();
              break;
            case 'resume':
              engine.resume();
              break;
            case 'flatten':
              engine.pause();
              await engine.flatten('manual dari dashboard');
              break;
            case 'run-cycle':
              void engine.runWeeklyCycle('manual dari dashboard');
              break;
            case 'apply-playbook':
              engine.applyPendingPlaybook();
              break;
            case 'set-profile':
              if (!['balanced', 'bold', 'extreme'].includes(String(body.profile))) return json(res, 400, { error: 'Profil tidak dikenal' });
              engine.setProfile(body.profile as RiskProfileId);
              break;
            default:
              return json(res, 400, { error: 'Aksi tidak dikenal' });
          }
          return json(res, 200, engine.snapshot());
        }
        return json(res, 404, { error: 'Tidak ditemukan' });
      }
      if (opts.staticDir && existsSync(opts.staticDir)) {
        const safe = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
        let file = join(opts.staticDir, safe);
        if (!file.startsWith(opts.staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(opts.staticDir, 'index.html');
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        return res.end(readFileSync(file));
      }
      res.writeHead(404);
      res.end('Dashboard belum di-build. Jalankan: npm run build');
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws' || !authorized(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify(engine.snapshot()));
    });
  });
  let lastPush = 0;
  engine.on('snapshot', (snap) => {
    if (Date.now() - lastPush < 900) return;
    lastPush = Date.now();
    const msg = JSON.stringify(snap);
    for (const c of wss.clients) if (c.readyState === c.OPEN) c.send(msg);
  });

  server.listen(opts.port, opts.host, () => opts.log(`Dashboard: http://${opts.host}:${opts.port}${opts.token ? ' (pakai DASHBOARD_TOKEN)' : ''}`));
  return server;
}
