import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { CodexAdapter, checkCodex } from './codex.mjs';
import { fingerprint, readPrivate, authIdentity, sameIdentity } from './credentials.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stringOrNull = value => typeof value === 'string' ? value.slice(0, 512) : null;
const finiteOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const clamp = value => Math.min(100, Math.max(0, value));

export function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return null;
  const usedPercent = finiteOrNull(window.usedPercent);
  return {
    usedPercent,
    remainingPercent: usedPercent === null ? null : clamp(100 - usedPercent),
    windowDurationMins: finiteOrNull(window.windowDurationMins),
    resetsAt: finiteOrNull(window.resetsAt),
  };
}

export function normalizeRateLimits(response) {
  const map = response?.rateLimitsByLimitId;
  const entries = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length
    ? Object.entries(map) : response?.rateLimits ? [[response.rateLimits.limitId ?? 'codex', response.rateLimits]] : [];
  return entries.filter(([, value]) => value && typeof value === 'object').map(([key, bucket]) => ({
    id: stringOrNull(bucket.limitId) ?? key,
    name: stringOrNull(bucket.limitName) ?? (key === 'codex' ? 'Codex' : key),
    planType: stringOrNull(bucket.planType),
    primary: normalizeWindow(bucket.primary),
    secondary: normalizeWindow(bucket.secondary),
  }));
}

export function validateName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 60 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, '账号名称须为 1–60 个字符。');
  }
  return value.trim();
}

function publicAccount(account) {
  return {
    id: account.id, name: account.name, email: account.email, planType: account.planType,
    status: account.status, error: account.error, lastUpdatedAt: account.lastUpdatedAt,
    createdAt: account.createdAt, rateLimits: account.rateLimits,
    login: account.login ? { ...account.login } : null,
  };
}

function loginUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && ['auth.openai.com', 'auth0.openai.com', 'login.openai.com', 'chatgpt.com'].includes(url.hostname)) return url.href;
  } catch { /* Only official HTTPS login destinations are accepted. */ }
  throw new HttpError(502, 'Codex 返回了无效的登录地址，请更新 Codex CLI 后重试。');
}

export class AccountManager {
  constructor({ dataDir, codexPath = process.env.CODEX_BIN || 'codex', adapterFactory, pollIntervalMs = 60_000, health, externalAuthProvider }) {
    this.dataDir = path.resolve(dataDir);
    this.accountsDir = path.join(this.dataDir, 'accounts');
    this.metadataPath = path.join(this.dataDir, 'accounts.json');
    this.codexPath = codexPath;
    this.adapterFactory = adapterFactory ?? (options => new CodexAdapter(options));
    this.healthOverride = health;
    this.externalAuthProvider = externalAuthProvider;
    this.suspended = false;
    this.pollIntervalMs = pollIntervalMs;
    this.accounts = new Map();
    this.adapters = new Map();
    this.refreshes = new Map();
    this.activeLogin = null;
    this.persistQueue = Promise.resolve();
    this.closed = false;
  }

  async init() {
    for (const dir of [this.dataDir, this.accountsDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (!(await lstat(dir)).isDirectory()) throw new Error('应用数据目录必须是普通目录');
      await chmod(dir, 0o700);
    }
    try {
      const saved = JSON.parse(await readFile(this.metadataPath, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts)) throw new Error('Invalid metadata');
      for (const item of saved.accounts) {
        if (!UUID.test(item.id) || this.accounts.has(item.id)) throw new Error('Invalid account ID');
        const rateLimits = Array.isArray(item.rateLimits) ? item.rateLimits.map(bucket => ({
          id: stringOrNull(bucket.id) ?? 'codex', name: stringOrNull(bucket.name) ?? 'Codex',
          planType: stringOrNull(bucket.planType), primary: normalizeWindow(bucket.primary), secondary: normalizeWindow(bucket.secondary),
        })) : [];
        this.accounts.set(item.id, {
          id: item.id, name: validateName(item.name), email: stringOrNull(item.email), planType: stringOrNull(item.planType),
          status: item.email ? 'connected' : 'disconnected', error: null, login: null,
          lastUpdatedAt: stringOrNull(item.lastUpdatedAt), createdAt: stringOrNull(item.createdAt) ?? new Date().toISOString(), rateLimits,
        });
        await this.prepareHome(item.id);
      }
      await chmod(this.metadataPath, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('账号记录无法读取。请检查 data/accounts.json；已保留原文件。');
    }
    this.health = this.healthOverride ?? await checkCodex(this.codexPath);
    if (this.pollIntervalMs > 0) {
      this.timer = setInterval(() => { void this.refreshAll(); }, this.pollIntervalMs);
      this.timer.unref?.();
    }
    // Return the cached overview immediately, then reconcile credentials in the background.
    this.startup = this.refreshAll();
    return this;
  }

  accountHome(id) { return path.join(this.accountsDir, id); }

  async prepareHome(id) {
    const home = this.accountHome(id);
    await mkdir(home, { mode: 0o700, recursive: true });
    if (!(await lstat(home)).isDirectory()) throw new Error('Invalid account directory');
    await chmod(home, 0o700);
    await writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n', { mode: 0o600 });
    await this.secureAuth(id);
    return home;
  }

  async secureAuth(id) {
    try {
      const auth = path.join(this.accountHome(id), 'auth.json');
      if (!(await lstat(auth)).isFile()) throw new Error('Invalid authentication file');
      await chmod(auth, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  get(id) {
    const account = this.accounts.get(id);
    if (!account) throw new HttpError(404, '账号不存在。');
    return account;
  }

  state() {
    return {
      accounts: [...this.accounts.values()].map(publicAccount),
      health: { ...this.health, activeLoginAccountId: this.activeLogin?.account.id ?? null },
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  persist() {
    const snapshot = JSON.stringify({ version: 1, accounts: [...this.accounts.values()].map(account => {
      const saved = publicAccount(account);
      delete saved.login;
      delete saved.error;
      return saved;
    }) }, null, 2);
    const next = this.persistQueue.catch(() => {}).then(async () => {
      const temporary = `${this.metadataPath}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, this.metadataPath);
    });
    this.persistQueue = next;
    return next;
  }

  async add(name) {
    const validName = validateName(name);
    if (this.accounts.size >= 100) throw new HttpError(400, '最多管理 100 个账号。');
    const id = randomUUID();
    const account = { id, name: validName, email: null, planType: null, status: 'disconnected', error: null, lastUpdatedAt: null, createdAt: new Date().toISOString(), rateLimits: [], login: null };
    await this.prepareHome(id);
    this.accounts.set(id, account);
    await this.persist();
    return publicAccount(account);
  }

  async rename(id, name) {
    const account = this.get(id);
    account.name = validateName(name);
    await this.persist();
    return publicAccount(account);
  }

  async adapter(account, { login = false } = {}) {
    if (!login) {
      const identity = authIdentity(await readPrivate(path.join(this.accountHome(account.id), 'auth.json'), { optional: true }));
      for (const other of this.accounts.values()) {
        if (other.id === account.id) break;
        if (sameIdentity(identity, authIdentity(await readPrivate(path.join(this.accountHome(other.id), 'auth.json'), { optional: true })))) {
          const adapter = this.adapters.get(account.id);
          this.adapters.delete(account.id);
          await adapter?.close();
          const error = new Error('Duplicate account identity');
          error.publicMessage = '此账号已在列表中，请保留一条记录，或连接不同账号。';
          throw error;
        }
      }
    }
    const externalAuth = login ? null : await this.externalAuthProvider?.(account.id);
    const authKey = externalAuth ? fingerprint(externalAuth) : 'managed';
    let adapter = this.adapters.get(account.id);
    if (adapter && adapter.authKey !== authKey) {
      this.adapters.delete(account.id);
      await adapter.close();
      adapter = null;
    }
    if (!adapter) {
      adapter = this.adapterFactory({ home: this.accountHome(account.id), codexPath: this.codexPath, accountId: account.id, externalAuth });
      adapter.authKey = authKey;
      this.adapters.set(account.id, adapter);
      adapter.on?.('notification', (method, params) => { void this.notification(account, adapter, method, params).catch(() => {}); });
      adapter.on?.('closed', () => {
        if (this.adapters.get(account.id) !== adapter || this.closed) return;
        this.adapters.delete(account.id);
        if (this.accounts.get(account.id) !== account) return;
        if (this.activeLogin?.account === account) this.clearLogin();
        account.login = null;
        account.status = 'error';
        account.error = 'Codex 连接已中断，请刷新或重新登录。';
      });
    }
    try { await adapter.start(); } catch (error) {
      if (this.adapters.get(account.id) === adapter) this.adapters.delete(account.id);
      await adapter.close();
      throw error;
    }
    return adapter;
  }

  async notification(account, adapter, method, params) {
    if (this.closed || this.accounts.get(account.id) !== account || this.adapters.get(account.id) !== adapter) return;
    if (method === 'account/login/completed') {
      const attempt = this.activeLogin;
      if (!attempt || attempt.account !== account || (attempt.loginId && params.loginId && attempt.loginId !== params.loginId)) return;
      if (!attempt.loginId) { attempt.completion = params; return; }
      this.clearLogin();
      account.login = null;
      if (params.success) {
        await this.secureAuth(account.id);
        account.status = 'disconnected';
        await this.refresh(account.id);
      } else {
        account.status = 'error';
        account.error = '登录未完成，请重试；也可使用设备验证码登录。';
        await this.persist();
      }
    } else if ((method === 'account/updated' || method === 'account/rateLimits/updated') && account.status !== 'connecting' && !this.refreshes.has(account.id)) {
      await this.refresh(account.id);
    }
  }

  clearLogin() {
    if (this.activeLogin?.timer) clearTimeout(this.activeLogin.timer);
    this.activeLogin = null;
  }

  async login(id, method = 'browser') {
    const account = this.get(id);
    if (this.suspended) throw new HttpError(409, '桌面账号正在切换，请稍后操作。');
    if (!['browser', 'device'].includes(method)) throw new HttpError(400, '不支持的登录方式。');
    if (this.activeLogin) throw new HttpError(409, '请先完成或取消当前账号的登录。');
    const attempt = { account, loginId: null };
    this.activeLogin = attempt;
    account.status = 'connecting';
    account.error = null;
    try {
      await this.refreshes.get(id);
      if (this.activeLogin !== attempt) throw new HttpError(409, '登录已取消。');
      account.status = 'connecting';
      const adapter = await this.adapter(account, { login: true });
      const result = await adapter.request('account/login/start', { type: method === 'device' ? 'chatgptDeviceCode' : 'chatgpt' });
      if (this.activeLogin !== attempt || this.accounts.get(id) !== account) throw new HttpError(409, '登录已取消。');
      if (!result?.loginId) throw new Error('Missing login id');
      attempt.loginId = result.loginId;
      account.login = method === 'device'
        ? { method, userCode: stringOrNull(result.userCode), verificationUrl: loginUrl(result.verificationUrl) }
        : { method, authUrl: loginUrl(result.authUrl) };
      attempt.timer = setTimeout(() => {
        if (this.activeLogin !== attempt) return;
        void this.cancelLogin(id).then(() => {
          if (this.accounts.get(id) === account) { account.status = 'error'; account.error = '登录已超时，请重新发起登录。'; }
        }).catch(() => {});
      }, 10 * 60_000);
      attempt.timer.unref?.();
      if (attempt.completion) await this.notification(account, adapter, 'account/login/completed', attempt.completion);
      return publicAccount(account);
    } catch (error) {
      if (this.activeLogin === attempt) {
        this.clearLogin();
        account.login = null;
        account.status = 'error';
        account.error = '无法启动登录。请确认 Codex CLI 可用，或改用设备验证码登录。';
        const adapter = this.adapters.get(id);
        this.adapters.delete(id);
        await adapter?.close();
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, '无法启动登录。请确认 Codex CLI 已安装，浏览器登录回调端口未被占用；也可尝试设备验证码登录。');
    }
  }

  async cancelLogin(id) {
    const account = this.get(id);
    if (this.activeLogin?.account !== account) return publicAccount(account);
    const attempt = this.activeLogin;
    this.clearLogin();
    account.login = null;
    account.status = account.email ? 'connected' : 'disconnected';
    account.error = null;
    const adapter = this.adapters.get(id);
    this.adapters.delete(id);
    // Closing the isolated process also reliably releases its OAuth callback listener.
    if (adapter && attempt.loginId) {
      await Promise.race([adapter.request('account/login/cancel', { loginId: attempt.loginId }).catch(() => {}), new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref?.(); })]);
    }
    await adapter?.close();
    return publicAccount(account);
  }

  async refresh(id) {
    const account = this.get(id);
    if (this.refreshes.has(id)) return this.refreshes.get(id);
    if (account.status === 'connecting' || this.closed || this.suspended) return publicAccount(account);
    const task = this.fetchAccount(account);
    this.refreshes.set(id, task);
    try { return await task; } finally { this.refreshes.delete(id); }
  }

  async fetchAccount(account) {
    const present = () => !this.closed && this.accounts.get(account.id) === account;
    try {
      const adapter = await this.adapter(account);
      const result = await adapter.request('account/read', { refreshToken: false });
      if (!present()) return publicAccount(account);
      if (!result?.account) {
        account.status = 'disconnected';
        account.error = account.email ? '登录已失效，请重新登录。' : null;
      } else if (result.account.type !== 'chatgpt') {
        account.status = 'error';
        account.error = '此账号不是 ChatGPT 登录，无法读取订阅额度。';
      } else {
        account.email = stringOrNull(result.account.email);
        account.planType = stringOrNull(result.account.planType);
        const limits = await adapter.request('account/rateLimits/read', {});
        if (!present()) return publicAccount(account);
        account.rateLimits = normalizeRateLimits(limits);
        account.planType ||= account.rateLimits.find(bucket => bucket.planType)?.planType ?? null;
        account.lastUpdatedAt = new Date().toISOString();
        account.status = 'connected';
        account.error = null;
      }
      await this.secureAuth(account.id);
    } catch (error) {
      if (present()) {
        account.status = error.authRequired ? 'disconnected' : 'error';
        account.error = error.publicMessage || (error.authRequired ? '登录已失效，请重新登录。' : '读取额度失败，已保留上次数据。请检查网络后刷新。');
      }
    }
    if (present()) await this.persist();
    return publicAccount(account);
  }

  async refreshAll() {
    const ids = [...this.accounts.keys()];
    // Avoid an unbounded burst of child processes or network requests.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, async () => {
      while (index < ids.length && !this.closed) {
        const id = ids[index++];
        if (this.accounts.has(id)) await this.refresh(id).catch(() => {});
      }
    }));
    return this.state();
  }

  async remove(id) {
    this.get(id);
    if (this.activeLogin?.account.id === id) await this.cancelLogin(id);
    this.accounts.delete(id);
    const adapter = this.adapters.get(id);
    this.adapters.delete(id);
    await adapter?.close();
    await this.refreshes.get(id)?.catch(() => {});
    await this.persist();
    await rm(this.accountHome(id), { recursive: true, force: true });
  }

  async suspend() {
    this.suspended = true;
    await Promise.allSettled([...this.refreshes.values()]);
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    await Promise.allSettled(adapters.map(adapter => adapter.close()));
  }

  resume() {
    if (this.closed) return;
    this.suspended = false;
    void this.refreshAll();
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.clearLogin();
    await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.close()));
    await Promise.allSettled([...this.refreshes.values()]);
    await this.persistQueue.catch(() => {});
    this.adapters.clear();
  }
}
