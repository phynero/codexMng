import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm } from 'node:fs/promises';
import { MacDesktopPlatform } from './desktop-platform.mjs';
import { readPrivate, writePrivate, validAuth, authIdentity, sameIdentity, fingerprint, credentialPolicy } from './credentials.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The detached worker survives the desktop app and its terminal being closed.
// All credential values stay in private files, never in argv, stdout or status.
export async function runDesktopJob(directory, { platform = new MacDesktopPlatform(), delayMs = 500, policy = credentialPolicy } = {}) {
  const statusPath = path.join(directory, 'status.json');
  const operationPath = path.join(directory, 'operation.json');
  const stagedPath = path.join(directory, 'staged.json');
  const backupPath = path.join(directory, 'backup.json');
  let job, operation, previous, staged, applied = false, stopped = false;
  const update = async (status, message) => {
    job = { ...job, status, message, ...(status === 'completed' || status === 'failed' ? { finishedAt: new Date().toISOString() } : {}) };
    await writePrivate(statusPath, job);
  };
  try {
    job = await readPrivate(statusPath);
    operation = await readPrivate(operationPath);
    if (job.id !== operation.id || job.status !== 'queued') throw new Error('Invalid operation');
    job.workerPid = process.pid;
    await writePrivate(statusPath, job);
    await pause(delayMs);
    staged = await readPrivate(stagedPath);
    if (staged.present && !validAuth(staged.auth)) throw new Error('Invalid target');
    if (fingerprint(staged) !== operation.stagedFingerprint) throw new Error('Target changed');
    const checkPolicy = async () => {
      const rules = await policy(operation.home);
      if (!rules.supported || (rules.workspace && rules.workspace !== authIdentity(staged.auth)?.accountId)) throw new Error('Policy changed');
    };
    await checkPolicy();
    const currentPlatform = await platform.inspect();
    if (!currentPlatform.supported || !currentPlatform.installed || currentPlatform.reason || currentPlatform.blockingClients || currentPlatform.appPath !== operation.platform.appPath) throw new Error('Client state changed');
    await update('stopping', '正在退出桌面客户端，等待登录文件停止更新…');
    await platform.stop(currentPlatform);
    stopped = true;
    await checkPolicy();
    const afterStop = await platform.inspect();
    if (afterStop.blockingClients || afterStop.running || afterStop.reason) throw new Error('Another client started');
    const authPath = path.join(operation.home, 'auth.json');
    const auth = await readPrivate(authPath, { optional: true });
    const identity = authIdentity(auth);
    if (operation.previousIdentity ? !sameIdentity(identity, operation.previousIdentity) : auth !== null) throw new Error('Desktop identity changed');
    previous = { present: auth !== null, auth };
    // Save the freshest rotating token back to the account that owned this session.
    for (const file of operation.syncBackPaths ?? []) {
      const existing = await readPrivate(file, { optional: true });
      if (validAuth(auth) && sameIdentity(authIdentity(existing), identity)) await writePrivate(file, auth);
    }
    await writePrivate(backupPath, previous);
    await update('applying', '已备份原登录，正在写入所选账号…');
    // Detect writes from a client that appeared between the process check and backup.
    if (fingerprint(await readPrivate(authPath, { optional: true })) !== fingerprint(auth)) throw new Error('Credentials changed concurrently');
    if (staged.present) await writePrivate(authPath, staged.auth);
    else await rm(authPath, { force: true });
    applied = true;
    await update('restarting', '登录文件已切换，正在重新打开桌面客户端…');
    await platform.launch(currentPlatform);
    await update('completed', '已写入登录并重新打开客户端，请在客户端确认账号。');
  } catch {
    let message = applied ? '客户端重新打开失败。' : '切换未完成，原桌面登录未被替换。';
    if (applied && operation && previous) {
      try {
        const authPath = path.join(operation.home, 'auth.json');
        const current = await readPrivate(authPath, { optional: true });
        const state = await platform.inspect();
        if (!state.running && !state.blockingClients && fingerprint(current) === fingerprint(staged.present ? staged.auth : null)) {
          if (previous.present) await writePrivate(authPath, previous.auth);
          else await rm(authPath, { force: true });
          message += '已恢复切换前的登录。';
        } else message += '检测到客户端启动或登录文件变化，已保留现状；可使用恢复上次登录。';
      } catch { message += '原登录备份仍保留，可使用恢复上次登录。'; }
    }
    if (stopped && operation) {
      try { const state = await platform.inspect(); if (!state.running) await platform.launch(operation.platform); }
      catch { message += '请手动打开 Codex。'; }
    }
    if (job) await update('failed', message);
  } finally {
    await rm(stagedPath, { force: true });
    await rm(operationPath, { force: true });
    await rm(path.join(directory, 'active.lock'), { recursive: true, force: true });
  }
  return job;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopJob(path.resolve(process.argv[2])).catch(() => { process.exitCode = 1; });
}
