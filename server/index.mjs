import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { AccountManager, HttpError } from './accounts.mjs';
import { DesktopController } from './desktop.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, '请求必须使用 application/json。');
  if (Number(req.headers['content-length']) > 16_384) throw new HttpError(413, '请求内容过大。');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new HttpError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, 'JSON 请求格式错误。'); }
}

function validateRequest(req, port) {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) throw new HttpError(403, '仅允许通过本机地址访问。');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不允许跨站请求。');
  const expectedOrigin = `http://${host}`;
  if (req.headers.origin && req.headers.origin !== expectedOrigin) throw new HttpError(403, '不允许跨域请求。');
  if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== expectedOrigin) throw new HttpError(403, '修改操作必须从本机管理页面发起。');
}

export async function createApp(options = {}) {
  const publicDir = path.resolve(options.publicDir ?? path.join(projectDir, 'public'));
  const manager = new AccountManager({ ...options, dataDir: options.dataDir ?? process.env.CODEX_MANAGER_DATA_DIR ?? path.join(projectDir, 'data') });
  const desktop = options.desktop === false ? null : new DesktopController({ manager, ...options.desktopOptions });
  if (desktop) {
    await desktop.init();
    manager.externalAuthProvider = id => desktop.externalAuth(id);
  }
  await manager.init();
  const state = async () => ({ ...manager.state(), desktop: desktop ? await desktop.state() : null });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    try {
      validateRequest(req, server.address()?.port);
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/api/')) {
        if (req.method === 'GET' && pathname === '/api/service') return json(res, 200, { app: 'codex-account-deck', pid: process.pid, instanceId: process.env.CODEX_MANAGER_INSTANCE_ID ?? null });
        if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, await state());
        if (req.method === 'GET' && pathname === '/api/desktop') return json(res, 200, { desktop: desktop ? await desktop.state() : null });
        if (!['POST', 'PATCH', 'DELETE'].includes(req.method)) throw new HttpError(405, '不支持的请求方法。');
        const body = await jsonBody(req);
        await desktop?.assertIdle();
        if (req.method === 'POST' && pathname === '/api/desktop/restore') {
          if (!desktop) throw new HttpError(409, '桌面切换未启用。');
          return json(res, 202, { desktop: await desktop.restore(body.confirmRestart) });
        }
        if (req.method === 'POST' && pathname === '/api/accounts') return json(res, 201, { account: await manager.add(body.name) });
        if (req.method === 'POST' && pathname === '/api/groups') { await manager.addGroup(body.name); return json(res, 201, manager.state()); }
        const groupMatch = pathname.match(/^\/api\/groups\/(default|[a-f0-9-]+)$/i);
        if (groupMatch) {
          if (req.method === 'PATCH') { await manager.renameGroup(groupMatch[1], body.name); return json(res, 200, manager.state()); }
          if (req.method === 'DELETE') { await manager.removeGroup(groupMatch[1]); return json(res, 200, manager.state()); }
          throw new HttpError(405, '不支持的请求方法。');
        }
        if (req.method === 'POST' && pathname === '/api/refresh') { await manager.refreshAll(); return json(res, 200, await state()); }
        const match = pathname.match(/^\/api\/accounts\/([a-f0-9-]+)(?:\/(login|cancel-login|refresh|activate|move))?$/i);
        if (!match) throw new HttpError(404, '接口不存在。');
        const [, id, action] = match;
        if (req.method === 'POST' && action === 'move') { await manager.move(id, body.groupId, body.beforeId); return json(res, 200, manager.state()); }
        if (req.method === 'POST' && action === 'activate') {
          if (!desktop) throw new HttpError(409, '桌面切换未启用。');
          return json(res, 202, { desktop: await desktop.activate(id, body.confirmRestart) });
        }
        if (req.method === 'PATCH' && !action) return json(res, 200, { account: await manager.rename(id, body.name) });
        if (req.method === 'DELETE' && !action) { await manager.remove(id); return json(res, 200, { ok: true }); }
        if (req.method === 'POST' && action === 'login') return json(res, 200, { account: await manager.login(id, body.method ?? 'browser') });
        if (req.method === 'POST' && action === 'cancel-login') return json(res, 200, { account: await manager.cancelLogin(id) });
        if (req.method === 'POST' && action === 'refresh') return json(res, 200, { account: await manager.refresh(id) });
        throw new HttpError(405, '不支持的请求方法。');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, '不支持的请求方法。');
      const filePath = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filePath.startsWith(`${publicDir}${path.sep}`)) throw new HttpError(404, '文件不存在。');
      let content;
      try {
        if (!(await stat(filePath)).isFile()) throw new Error();
        content = await readFile(filePath);
      } catch { throw new HttpError(404, '文件不存在。'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream', 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const status = error instanceof HttpError ? error.status : error instanceof URIError ? 400 : 500;
      json(res, status, { error: error instanceof HttpError ? error.message : status === 400 ? '请求路径无效。' : '操作失败，请稍后重试。' });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  return {
    server, manager, desktop,
    async listen(port = Number(process.env.PORT ?? 4317)) {
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0–65535 之间的整数');
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      const closed = new Promise(resolve => server.listening ? server.close(resolve) : resolve());
      server.closeIdleConnections?.();
      desktop?.close();
      await manager.close();
      await closed;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let app;
  try {
    app = await createApp();
    const url = await app.listen();
    console.log(`Codex 账号管理已启动：${url}`);
    if (!app.manager.health.codexAvailable) console.log('未检测到 Codex CLI，请安装后重启，或通过 CODEX_BIN 指定路径。');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    await app?.close();
    console.error(error.code === 'EADDRINUSE' ? '端口已被占用，请通过 PORT 指定其他端口。' : '启动失败，请检查 Node.js、Codex CLI 和本地数据目录。');
    process.exitCode = 1;
  }
}
