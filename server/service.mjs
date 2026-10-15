import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { open, rm, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safeDirectory, readPrivate, writePrivate } from './credentials.mjs';
import { installedDefinition, manageAutostart } from './autostart.mjs';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = path.resolve(process.env.CODEX_MANAGER_DATA_DIR ?? path.join(projectDir, 'data'));
const statePath = path.join(dataDir, 'service.json');
const command = process.argv[2] ?? 'start';
const port = Number(process.env.PORT ?? 4317);
const url = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function probe(address) {
  try {
    const response = await fetch(`${address}/api/service`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return null;
    const state = await response.json();
    return state.app === 'codex-account-deck' ? state : null;
  } catch { return null; }
}

try {
  if (!['start', 'stop', 'status'].includes(command) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('参数无效，使用 start / stop / status 和有效 PORT。');
  if (await installedDefinition()) { await manageAutostart(command); process.exit(0); }
  await safeDirectory(dataDir, { create: true });
  await chmod(dataDir, 0o700);
  if (command === 'stop') {
    const saved = await readPrivate(statePath, { optional: true });
    if (!saved) throw new Error('未找到后台服务记录；前台启动的服务请在终端按 Control+C。');
    const live = await probe(saved.url);
    if (!live || live.instanceId !== saved.instanceId) throw new Error('后台服务已停止或身份不匹配，没有终止任何进程。');
    process.kill(saved.pid, 'SIGTERM');
    for (let i = 0; i < 50; i++) {
      if (!(await probe(saved.url))) { await rm(statePath, { force: true }); console.log('Codex 账号管理后台已停止。'); process.exit(0); }
      await wait(100);
    }
    throw new Error('服务正在结束请求，请稍后运行 npm run status 检查。');
  }
  const existing = await probe(url);
  if (existing) { console.log(`Codex 账号管理正在运行：${url}`); process.exit(0); }
  if (command === 'status') { console.log('Codex 账号管理后台未运行。'); process.exit(0); }
  const instanceId = randomUUID();
  const log = await open(path.join(dataDir, 'service.log'), 'a', 0o600);
  await log.chmod(0o600);
  const child = spawn(process.execPath, [path.join(projectDir, 'server', 'index.mjs')], {
    cwd: projectDir, detached: true, stdio: ['ignore', log.fd, log.fd],
    env: { ...process.env, CODEX_MANAGER_INSTANCE_ID: instanceId },
  });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  await log.close();
  for (let i = 0; i < 80; i++) {
    const live = await probe(url);
    if (live?.instanceId === instanceId) {
      await writePrivate(statePath, { pid: child.pid, instanceId, url });
      console.log(`Codex 账号管理后台已启动：${url}\n关闭此终端不会停止服务；停止请运行 npm stop。`);
      process.exit(0);
    }
    if (child.exitCode !== null) break;
    await wait(100);
  }
  throw new Error('启动失败，请检查端口占用或 data/service.log。');
} catch (error) {
  console.error(error.message.startsWith('启动') || error.message.startsWith('后台') || error.message.startsWith('服务') || error.message.startsWith('未找到') || error.message.startsWith('参数') ? error.message : '无法管理后台服务，请检查本地目录权限。');
  process.exitCode = 1;
}
