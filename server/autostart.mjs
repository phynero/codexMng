import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, lstat, readFile, writeFile, rename, rm, open, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { safeDirectory, readPrivate } from './credentials.mjs';

const exec = promisify(execFile);
export const LABEL = 'local.codex-account-deck';
export const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/${LABEL}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const allowedEnvironment = ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','CODEX_CA_CERTIFICATE'];

const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[char]));
function plistValue(value) {
  if (typeof value === 'boolean') return `<${value ? 'true' : 'false'}/>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`;
  if (typeof value === 'object') return `<dict>${Object.entries(value).map(([key, item]) => `<key>${xml(key)}</key>${plistValue(item)}`).join('')}</dict>`;
  return `<string>${xml(value)}</string>`;
}
export function encodePlist(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${plistValue(value)}</plist>\n`;
}

export function buildDefinition({ nodePath, codexPath, directory = projectDir, dataDir, home = os.homedir(), port = 4317, instanceId = randomUUID(), env = process.env }) {
  if (![nodePath, codexPath, directory, dataDir, home].every(item => typeof item === 'string' && path.isAbsolute(item)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('自启配置需要有效端口和绝对路径。');
  const environment = {
    HOME: home, PATH: [...new Set([path.dirname(nodePath), path.dirname(codexPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
    PORT: String(port), CODEX_BIN: codexPath, CODEX_MANAGER_DATA_DIR: dataDir, CODEX_MANAGER_INSTANCE_ID: instanceId,
  };
  for (const key of allowedEnvironment) if (typeof env[key] === 'string') environment[key] = env[key];
  return {
    Label: LABEL, ProgramArguments: [nodePath, path.join(directory, 'server', 'index.mjs')], WorkingDirectory: directory,
    RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10, ExitTimeOut: 30, ProcessType: 'Background', LimitLoadToSessionType: 'Aqua', Umask: 0o077,
    EnvironmentVariables: environment,
    StandardOutPath: path.join(dataDir, 'autostart.log'), StandardErrorPath: path.join(dataDir, 'autostart-error.log'),
  };
}

async function run(file, args) { return exec(file, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }); }
async function launchctl(...args) { return run('/bin/launchctl', args); }
async function executable(name) {
  const choices = path.isAbsolute(name) ? [name] : (process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin').split(':').map(directory => path.resolve(directory, name));
  for (const choice of choices) { try { await access(choice, constants.X_OK); return choice; } catch {} }
  throw new Error('未找到 Node.js 或 Codex CLI，请安装后重新执行启动脚本。');
}
function requireMac() { if (process.platform !== 'darwin') throw new Error('开机自启功能仅支持 macOS。'); }

export async function installedDefinition() {
  if (process.platform !== 'darwin') return null;
  try {
    const info = await lstat(plistPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('自启配置必须是普通文件。');
    const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath]);
    const definition = JSON.parse(stdout);
    if (definition.Label !== LABEL || !Array.isArray(definition.ProgramArguments) || definition.ProgramArguments.length !== 2 || !path.isAbsolute(definition.WorkingDirectory ?? '') || definition.ProgramArguments[1] !== path.join(definition.WorkingDirectory, 'server', 'index.mjs')) throw new Error('已存在无法识别的自启配置，请检查 LaunchAgents 文件。');
    const env = definition.EnvironmentVariables;
    const absolutePaths = [definition.ProgramArguments[0], env?.HOME, env?.CODEX_BIN, env?.CODEX_MANAGER_DATA_DIR];
    if (!absolutePaths.every(item => typeof item === 'string' && path.isAbsolute(item)) || !/^\d+$/.test(env?.PORT ?? '') || Number(env.PORT) < 1 || Number(env.PORT) > 65535 || typeof env?.CODEX_MANAGER_INSTANCE_ID !== 'string' || !env.CODEX_MANAGER_INSTANCE_ID) throw new Error('自启配置路径或端口无效，请重新运行启动脚本安装。');
    return definition;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function loadedState() {
  try {
    const { stdout } = await launchctl('print', target);
    return { loaded: true, running: /^\s*state = running\s*$/m.test(stdout), pid: Number(stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null };
  } catch { return { loaded: false, running: false, pid: null }; }
}
async function enabledState() {
  const { stdout } = await launchctl('print-disabled', domain);
  return !stdout.split('\n').some(line => line.includes(`"${LABEL}"`) && /=>\s*true/.test(line));
}
const address = definition => `http://127.0.0.1:${definition.EnvironmentVariables.PORT}`;
async function probe(url, endpoint = '/api/service', timeout = 1200) {
  try { const response = await fetch(`${url}${endpoint}`, { signal: AbortSignal.timeout(timeout) }); return response.ok ? await response.json() : null; }
  catch { return null; }
}
async function ensureIdle(url) {
  const live = await probe(url);
  if (!live) return;
  if (live.app !== 'codex-account-deck') throw new Error('端口上存在其他服务，请检查后重试。');
  const state = await probe(url, '/api/state', 5000);
  if (!Array.isArray(state?.accounts) || !state?.health) throw new Error('无法确认当前授权或切换状态，请稍后重试。');
  if (state?.health?.activeLoginAccountId || ['queued', 'stopping', 'applying', 'restarting'].includes(state?.desktop?.job?.status)) throw new Error('当前有账号授权或切换正在进行，请完成后再设置自启。');
}
async function stopLoaded() {
  if (!(await loadedState()).loaded) return;
  await launchctl('bootout', target);
  for (let i = 0; i < 60; i++) { if (!(await loadedState()).loaded) return; await wait(100); }
  throw new Error('后台服务仍在退出，请稍后重试。');
}

// Only stop the old detached service after its private instance record matches
// the HTTP response. Never signal an arbitrary process just because it owns a port.
async function stopLegacy(definition) {
  const url = address(definition);
  const live = await probe(url);
  if (!live) return;
  const statePath = path.join(definition.EnvironmentVariables.CODEX_MANAGER_DATA_DIR, 'service.json');
  const saved = await readPrivate(statePath, { optional: true });
  if (live.app !== 'codex-account-deck' || !saved?.instanceId || live.instanceId !== saved.instanceId || saved.url !== url || !Number.isInteger(saved.pid) || saved.pid <= 1 || (live.pid && live.pid !== saved.pid)) throw new Error('端口上存在其他服务，请先停止该服务再安装自启。');
  await ensureIdle(url);
  process.kill(saved.pid, 'SIGTERM');
  for (let i = 0; i < 60; i++) {
    if (!(await probe(url))) { await rm(statePath, { force: true }); return; }
    await wait(100);
  }
  throw new Error('原后台服务仍在退出，尚未启动第二个服务。');
}

async function ready(definition) {
  const url = address(definition);
  for (let i = 0; i < 100; i++) {
    const [live, state] = await Promise.all([probe(url), loadedState()]);
    if (state.running && live?.instanceId === definition.EnvironmentVariables.CODEX_MANAGER_INSTANCE_ID && live.pid === state.pid) return { url, ...state };
    await wait(100);
  }
  throw new Error('自启已登记，但服务尚未就绪，请查看 data/autostart-error.log。');
}

export async function startAutostart(definition = null) {
  requireMac();
  definition ??= await installedDefinition();
  if (!definition) throw new Error('尚未安装自启，请运行 npm run autostart:enable。');
  await launchctl('enable', target);
  if (!(await loadedState()).loaded) {
    await stopLegacy(definition);
    await launchctl('bootstrap', domain, plistPath);
  }
  return ready(definition);
}

export async function installAutostart() {
  requireMac();
  const previous = await installedDefinition();
  const dataDir = path.resolve(process.env.CODEX_MANAGER_DATA_DIR ?? path.join(projectDir, 'data'));
  const definition = buildDefinition({
    nodePath: await executable(process.execPath), codexPath: await executable(process.env.CODEX_BIN ?? 'codex'),
    dataDir, port: Number(process.env.PORT ?? 4317), instanceId: previous?.EnvironmentVariables?.CODEX_MANAGER_INSTANCE_ID || randomUUID(),
  });
  await safeDirectory(path.dirname(plistPath), { create: true });
  await safeDirectory(dataDir, { create: true }); await chmod(dataDir, 0o700);
  for (const file of [definition.StandardOutPath, definition.StandardErrorPath]) {
    try { if (!(await lstat(file)).isFile()) throw new Error('日志路径必须是普通文件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const handle = await open(file, 'a', 0o600); await handle.chmod(0o600); await handle.close();
  }
  if (!isDeepStrictEqual(previous, definition)) {
    const temporary = `${plistPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, encodePlist(definition), { mode: 0o600, flag: 'wx' });
    try {
      await run('/usr/bin/plutil', ['-lint', temporary]);
      if (previous) { await ensureIdle(address(previous)); await stopLoaded(); }
      await stopLegacy(definition);
      await rename(temporary, plistPath);
    } finally { await rm(temporary, { force: true }); }
  }
  await chmod(plistPath, 0o600);
  return startAutostart(definition);
}

export async function manageAutostart(command) {
  requireMac();
  const definition = await installedDefinition();
  if (command === 'install') {
    const state = await installAutostart();
    console.log(`开机自启已启用并启动：${state.url}\n下次登录 macOS 后自动运行，无需打开终端或 Codex。`);
  } else if (command === 'start') {
    const state = await startAutostart(definition);
    console.log(`Codex 账号管理正在运行（系统托管）：${state.url}`);
  } else if (command === 'stop' || command === 'uninstall') {
    if (definition) await ensureIdle(address(definition));
    await stopLoaded();
    if (command === 'uninstall') {
      await launchctl('disable', target);
      await rm(plistPath, { force: true });
      console.log('已关闭开机自启并停止后台服务。账号及登录数据已保留。');
    } else console.log('后台服务已暂停；下次登录 macOS 仍会自启。永久关闭请运行 npm run autostart:disable。');
  } else if (command === 'status') {
    if (!definition) { console.log('开机自启尚未安装。'); return; }
    const [state, enabled, live] = await Promise.all([loadedState(), enabledState(), probe(address(definition))]);
    const healthy = state.running && live?.instanceId === definition.EnvironmentVariables.CODEX_MANAGER_INSTANCE_ID && live.pid === state.pid;
    console.log(`开机自启：${enabled ? '已启用（登录 macOS 后）' : '已禁用'}\n当前服务：${healthy ? '运行正常' : state.loaded ? '已加载，等待就绪或需要检查日志' : '已暂停'}\n页面地址：${address(definition)}`);
  } else throw new Error('使用 install / uninstall / start / stop / status。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  manageAutostart(process.argv[2] ?? 'status').catch(error => {
    console.error(error.stderr ? '系统未能加载自启服务，请检查登录项权限并重试。' : error.message);
    process.exitCode = 1;
  });
}
