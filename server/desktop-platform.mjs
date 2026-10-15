import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const runFile = promisify(nodeExecFile);
const APPLICATIONS = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];
const BUNDLE_ID = 'com.openai.codex';
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const isCodex = command => /^codex(?:\.exe)?$/i.test(path.basename(command));

function descendants(processes, rootPids) {
  const ids = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of processes) {
      if (ids.has(process.ppid) && !ids.has(process.pid)) { ids.add(process.pid); changed = true; }
    }
  }
  return ids;
}

// Process arguments remain private: the public snapshot exposes executable paths only.
export class MacDesktopPlatform {
  constructor({ platform = process.platform, execFile = runFile, kill = process.kill.bind(process) } = {}) {
    this.platform = platform;
    this.execFile = execFile;
    this.kill = kill;
    this.timeoutMs = 15_000;
    this.pollIntervalMs = 200;
  }

  async run(file, args) {
    return this.execFile(file, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
  }

  async bundle(appPath) {
    if (!APPLICATIONS.includes(appPath)) return null;
    try {
      const plist = path.join(appPath, 'Contents', 'Info.plist');
      const fields = await Promise.all(['CFBundleIdentifier', 'CFBundleExecutable', 'CFBundleShortVersionString'].map(async key => {
        const result = await this.run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
        return result.stdout.trim();
      }));
      const [identifier, name, appVersion] = fields;
      if (identifier !== BUNDLE_ID || !['ChatGPT', 'Codex'].includes(name)) return null;
      const executable = path.join(appPath, 'Contents', 'MacOS', name);
      await this.run('/bin/test', ['-x', executable]);
      return { appPath, executable, appName: name, appVersion: appVersion.slice(0, 80) };
    } catch { return null; }
  }

  async processTable() {
    const outputs = await Promise.all([
      this.run('/bin/ps', ['-axww', '-o', 'pid=,ppid=,comm=']),
      this.run('/bin/ps', ['-axww', '-o', 'pid=,args=']),
    ]);
    const argumentsByPid = new Map();
    for (const line of outputs[1].stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (match) argumentsByPid.set(Number(match[1]), match[2]);
    }
    const processes = [];
    for (const line of outputs[0].stdout.split('\n')) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      processes.push({ pid, ppid: Number(match[2]), command: match[3].trim(), arguments: argumentsByPid.get(pid) ?? '' });
    }
    return processes;
  }

  async inspect({ ignoredPids = [] } = {}) {
    const empty = { supported: this.platform === 'darwin', installed: false, appPath: null, executable: null, appName: null, appVersion: null, running: false, processes: [], blockingClients: false, reason: null };
    if (!empty.supported) return { ...empty, reason: '桌面账号切换目前仅支持 macOS。' };
    const installed = (await Promise.all(APPLICATIONS.map(appPath => this.bundle(appPath)))).filter(Boolean);
    if (!installed.length) return { ...empty, reason: '未找到受支持的 Codex 桌面应用，请将应用安装到 Applications 文件夹。' };
    let processes;
    try { processes = await this.processTable(); }
    catch { return { ...empty, installed: true, ...installed[0], reason: '无法确认桌面进程状态，暂时不能切换。' }; }
    const active = installed.filter(app => processes.some(process => process.command === app.executable));
    const selected = active[0] ?? installed[0];
    const roots = processes.filter(process => process.command === selected.executable);
    const desktopIds = descendants(processes, roots.map(process => process.pid));
    const ignoredIds = descendants(processes, ignoredPids.filter(Number.isSafeInteger));
    const desktopProcesses = processes.filter(process => roots.includes(process) || desktopIds.has(process.pid) && isCodex(process.command) && !ignoredIds.has(process.pid));
    const blockingClients = processes.some(process => isCodex(process.command) && !desktopIds.has(process.pid) && !ignoredIds.has(process.pid));
    const hasOverrides = desktopProcesses.some(process => /(?:\bCODEX_HOME\s*=|--codex-home(?:[=\s]|$)|\bcli_auth_credentials_store\b|(?:^|\s)(?:--profile|-p)(?:[=\s]|$)|\bcodex_home\s*=)/.test(process.arguments));
    let reason = null;
    if (active.length > 1 || roots.length > 1) reason = '检测到多个 Codex 桌面实例，请先仅保留一个。';
    else if (hasOverrides) reason = '桌面客户端使用了自定义配置或登录存储参数，暂时不能安全切换。';
    else if (blockingClients) reason = '请先关闭 VS Code 中的 Codex 及其他 Codex CLI 会话，再切换桌面账号。';
    return {
      ...empty, installed: true, ...selected, running: roots.length > 0, blockingClients, reason,
      processes: desktopProcesses.map(({ pid, ppid, command }) => ({ pid, ppid, command })),
    };
  }

  async validate(snapshot) {
    if (this.platform !== 'darwin' || !snapshot?.supported || !snapshot.installed) throw new Error('当前环境不支持桌面账号切换。');
    const bundle = await this.bundle(snapshot.appPath);
    if (!bundle || bundle.executable !== snapshot.executable) throw new Error('桌面应用路径或版本已发生变化，请刷新页面后重试。');
    return bundle;
  }

  async stop(snapshot) {
    await this.validate(snapshot);
    const processes = await this.processTable().catch(() => { throw new Error('无法确认桌面进程状态，已取消切换。'); });
    const roots = processes.filter(process => process.command === snapshot.executable);
    const expectedRoots = new Set(snapshot.processes.filter(process => process.command === snapshot.executable).map(process => process.pid));
    if (roots.some(process => !expectedRoots.has(process.pid))) throw new Error('桌面进程已经变化，请刷新页面后重试。');
    const desktopIds = descendants(processes, roots.map(process => process.pid));
    const tracked = new Map([...snapshot.processes, ...processes.filter(process => desktopIds.has(process.pid) && isCodex(process.command))].map(process => [process.pid, process.command]));
    for (const root of roots) {
      const { stdout } = await this.run('/bin/ps', ['-p', String(root.pid), '-o', 'comm=']).catch(() => ({ stdout: '' }));
      if (!stdout.trim()) continue;
      if (stdout.trim() !== snapshot.executable) throw new Error('桌面进程身份已经变化，已取消切换。');
      try { this.kill(root.pid, 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') throw new Error('无法正常退出桌面客户端，请手动退出后重试。'); }
    }
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const remaining = await this.processTable().catch(() => { throw new Error('无法确认桌面是否已退出，已取消切换。'); });
      const alive = remaining.some(process => process.command === snapshot.executable || tracked.get(process.pid) === process.command);
      if (!alive) return;
      if (Date.now() >= deadline) throw new Error('桌面客户端尚未完全退出，已取消切换；请手动退出后重试。');
      await wait(this.pollIntervalMs);
    }
  }

  async launch(snapshot) {
    const bundle = await this.validate(snapshot);
    try { await this.run('/usr/bin/open', ['-a', bundle.appPath]); }
    catch { throw new Error('桌面客户端未能启动，请手动打开应用。'); }
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const processes = await this.processTable().catch(() => { throw new Error('无法确认桌面是否已启动，请手动检查应用。'); });
      if (processes.some(process => process.command === bundle.executable)) return;
      if (Date.now() >= deadline) throw new Error('尚未检测到桌面客户端启动，请手动打开应用。');
      await wait(this.pollIntervalMs);
    }
  }
}
