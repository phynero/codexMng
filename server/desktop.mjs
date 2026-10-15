import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { HttpError } from './accounts.mjs';
import { MacDesktopPlatform } from './desktop-platform.mjs';
import { safeDirectory, readPrivate, writePrivate, validAuth, authIdentity, sameIdentity, fingerprint, credentialPolicy } from './credentials.mjs';

const pending = job => job && ['queued', 'stopping', 'applying', 'restarting'].includes(job.status);
function publicJob(job) {
  if (!job) return null;
  const { id, status, targetName, message, createdAt, finishedAt } = job;
  return { id, status, targetName, message, createdAt, ...(finishedAt ? { finishedAt } : {}) };
}

function spawnWorker(directory) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG']) if (process.env[key]) env[key] = process.env[key];
    const child = spawn(process.execPath, [fileURLToPath(new URL('./desktop-worker.mjs', import.meta.url)), directory], {
      detached: true, stdio: 'ignore', cwd: directory, env,
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

export class DesktopController {
  constructor({ manager, home = path.join(os.homedir(), '.codex'), platform = new MacDesktopPlatform(), launchWorker = spawnWorker, policy = credentialPolicy } = {}) {
    this.manager = manager;
    this.home = path.resolve(home);
    this.directory = path.join(manager.dataDir, 'desktop');
    this.platform = platform;
    this.launchWorker = launchWorker;
    this.policy = policy;
    this.preparing = false;
    this.ownsSuspension = false;
    this.customHome = process.env.CODEX_HOME && path.resolve(process.env.CODEX_HOME) !== this.home;
  }

  async init() {
    await safeDirectory(this.directory, { create: true });
    await chmod(this.directory, 0o700);
    const job = await this.job();
    if (pending(job)) {
      let alive = false;
      if (Number.isInteger(job.workerPid) && job.workerPid > 1) {
        try { process.kill(job.workerPid, 0); alive = true; } catch { /* Worker has exited. */ }
      }
      if (alive) { this.manager.suspended = true; this.ownsSuspension = true; }
      else {
        await writePrivate(path.join(this.directory, 'status.json'), { ...job, status: 'failed', message: '上次切换被中断，请检查客户端账号；原登录备份仍保留。', finishedAt: new Date().toISOString() });
        await this.clearStaging();
      }
    } else await this.clearStaging();
    this.timer = setInterval(() => { void this.reconcile().catch(() => {}); }, 1000);
    this.timer.unref?.();
  }

  async clearStaging() {
    for (const file of ['operation.json', 'staged.json', 'active.lock']) await rm(path.join(this.directory, file), { recursive: true, force: true });
  }

  async job() { return readPrivate(path.join(this.directory, 'status.json'), { optional: true }); }

  async reconcile() {
    const job = await this.job();
    if (!this.preparing && pending(job) && Date.now() - Date.parse(job.createdAt) > 10_000) {
      const pid = job.workerPid ?? this.workerPid;
      let alive = false;
      if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, 0); alive = true; } catch {} }
      if (!alive) {
        await writePrivate(path.join(this.directory, 'status.json'), { ...job, status: 'failed', message: '切换进程意外退出，请检查客户端；登录备份仍保留，可尝试恢复。', finishedAt: new Date().toISOString() });
        await this.clearStaging();
      }
    }
    if (!this.preparing && this.ownsSuspension && !pending(await this.job())) {
      this.ownsSuspension = false;
      this.manager.resume();
    }
  }

  async assertIdle() {
    if (this.preparing || pending(await this.job())) throw new HttpError(409, '桌面账号正在切换，请等待完成。');
  }

  async currentAuth() { return readPrivate(path.join(this.home, 'auth.json'), { optional: true }); }

  async managedAuth(id) { return readPrivate(path.join(this.manager.accountHome(id), 'auth.json'), { optional: true }); }

  // The desktop owns refresh tokens for its current identity. Monitoring only
  // supplies the latest access token to an ephemeral app-server session.
  async externalAuth(id) {
    const managed = await this.managedAuth(id);
    const current = await this.currentAuth();
    const identity = authIdentity(current);
    if (!sameIdentity(authIdentity(managed), identity)) return null;
    if (!validAuth(current)) throw new Error('Desktop login is unavailable');
    return { accessToken: current.tokens.access_token, chatgptAccountId: identity.accountId, ...(identity.planType ? { chatgptPlanType: identity.planType } : {}) };
  }

  async state({ ignorePreparing = false } = {}) {
    await this.reconcile();
    const ignoredPids = [...this.manager.adapters.values()].map(adapter => adapter.process?.pid).filter(Boolean);
    const platform = await this.platform.inspect({ ignoredPids });
    const rules = await this.policy(this.home);
    let current = null, credentialError = false;
    try { current = authIdentity(await this.currentAuth()); } catch { credentialError = true; }
    let matchedAccountId = null;
    for (const account of this.manager.accounts.values()) {
      try { if (sameIdentity(authIdentity(await this.managedAuth(account.id)), current)) { matchedAccountId = account.id; break; } }
      catch { /* A broken managed account must not break the overview. */ }
    }
    const job = await this.job();
    const busy = (!ignorePreparing && this.preparing) || pending(job);
    const reason = platform.reason || (!platform.supported ? '目前仅支持 macOS 桌面客户端。' : !platform.installed ? '未检测到受支持的 Codex 桌面客户端。' : null)
      || (this.customHome ? '检测到自定义 CODEX_HOME，请使用客户端自带的登录功能。' : null)
      || (!rules.supported ? rules.reason : null)
      || (credentialError ? '无法安全读取桌面登录文件，请检查权限或符号链接。' : null)
      || (platform.blockingClients ? '请先关闭其他 Codex CLI 或 VS Code Codex 扩展，再切换账号。' : null)
      || (this.manager.activeLogin ? '请先完成或取消正在进行的账号授权。' : null)
      || (busy ? '正在切换桌面账号，请等待完成。' : null);
    let canRestore = false;
    try { const backup = await readPrivate(path.join(this.directory, 'backup.json'), { optional: true }); canRestore = Boolean(backup && (!backup.present || validAuth(backup.auth))); } catch { /* Keep malformed backup private. */ }
    return {
      supported: platform.supported, installed: platform.installed, appName: platform.appName || 'Codex', appVersion: platform.appVersion || null,
      running: platform.running, credentialStore: rules.supported ? 'file' : 'unsupported',
      currentAccount: current ? { email: current.email, accountId: current.accountId, planType: current.planType } : null,
      matchedAccountId, canSwitch: !reason, reason, job: publicJob(job), canRestore,
    };
  }

  async activate(id, confirmed) {
    const account = this.manager.get(id);
    return this.queue({ id, targetName: account.name, confirmed });
  }

  async restore(confirmed) { return this.queue({ restore: true, targetName: '上次桌面登录', confirmed }); }

  async queue({ id, restore = false, targetName, confirmed }) {
    if (confirmed !== true) throw new HttpError(400, '请先确认切换并重启桌面客户端。');
    await this.assertIdle();
    // Reserve before the first asynchronous preflight so concurrent requests cannot race.
    if (this.preparing) throw new HttpError(409, '已有切换请求正在准备。');
    this.preparing = true;
    let locked = false, dispatched = false;
    try {
      const state = await this.state({ ignorePreparing: true });
      if (!state.canSwitch) throw new HttpError(409, state.reason);
      if (!restore && state.matchedAccountId === id) throw new HttpError(409, '该账号已是桌面保存的当前登录。');
      let restoreManagedId = null;
      const savedBackup = restore ? await readPrivate(path.join(this.directory, 'backup.json'), { optional: true }) : null;
      if (restore && savedBackup?.present) {
        for (const account of this.manager.accounts.values()) {
          if (sameIdentity(authIdentity(await this.managedAuth(account.id)), authIdentity(savedBackup.auth))) { restoreManagedId = account.id; break; }
        }
      }
      if (!restore || restoreManagedId) {
        const account = await this.manager.refresh(restoreManagedId ?? id);
        if (account.status !== 'connected') throw new HttpError(409, '请先成功读取该账号额度，再进行切换。');
      }
      if (this.manager.activeLogin) throw new HttpError(409, '请先完成或取消账号授权。');
      await this.manager.suspend();
      this.ownsSuspension = true;
      const staged = restore && !restoreManagedId ? savedBackup : { present: true, auth: await this.managedAuth(restoreManagedId ?? id) };
      if (!staged || typeof staged.present !== 'boolean' || (staged.present && !validAuth(staged.auth))) throw new HttpError(409, '没有可用的登录凭据，请重新连接账号。');
      const rules = await this.policy(this.home);
      if (!rules.supported || (rules.workspace && rules.workspace !== authIdentity(staged.auth)?.accountId)) throw new HttpError(409, rules.reason || '所选账号不属于客户端配置要求的工作区。');
      const platform = await this.platform.inspect();
      if (platform.reason || platform.blockingClients || !platform.installed || !platform.supported) throw new HttpError(409, platform.reason || '客户端状态已变化，请刷新后重试。');
      const previousIdentity = authIdentity(await this.currentAuth());
      // Non-ChatGPT credentials can be backed up, but an unidentifiable present
      // auth file is rejected to avoid overwriting an unknown login method.
      if (!previousIdentity && await this.currentAuth()) throw new HttpError(409, '当前桌面使用的登录方式无法安全识别，请在客户端内切换。');
      const syncBackPaths = [];
      for (const account of this.manager.accounts.values()) {
        if (sameIdentity(authIdentity(await this.managedAuth(account.id)), previousIdentity)) { syncBackPaths.push(path.join(this.manager.accountHome(account.id), 'auth.json')); break; }
      }
      try { await mkdir(path.join(this.directory, 'active.lock'), { mode: 0o700 }); locked = true; }
      catch { throw new HttpError(409, '另一个切换任务仍在执行，请稍后刷新。'); }
      const job = { id: randomUUID(), status: 'queued', targetName, message: '即将退出客户端并切换登录…', createdAt: new Date().toISOString() };
      await writePrivate(path.join(this.directory, 'staged.json'), staged);
      await writePrivate(path.join(this.directory, 'operation.json'), { id: job.id, home: this.home, platform, previousIdentity, syncBackPaths, stagedFingerprint: fingerprint(staged) });
      await writePrivate(path.join(this.directory, 'status.json'), job);
      const workerPid = await this.launchWorker(this.directory);
      // The worker writes its own PID before stopping the app. Do not overwrite
      // status here: a fast worker may already have advanced to the next phase.
      this.workerPid = workerPid;
      dispatched = true;
    } catch (error) {
      if (locked) {
        const job = await this.job();
        if (pending(job)) await writePrivate(path.join(this.directory, 'status.json'), { ...job, status: 'failed', message: '切换任务未能启动，桌面登录未更改。', finishedAt: new Date().toISOString() });
        await this.clearStaging();
      }
      if (error instanceof HttpError) throw error;
      throw new HttpError(500, '无法准备桌面切换，请检查登录文件和本地权限。');
    } finally {
      this.preparing = false;
      if (!dispatched && this.ownsSuspension) { this.ownsSuspension = false; this.manager.resume(); }
    }
    return this.state();
  }

  close() { clearInterval(this.timer); }
}
