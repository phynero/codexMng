import test from 'node:test';
import assert from 'node:assert/strict';
import { MacDesktopPlatform } from '../server/desktop-platform.mjs';

const appPath = '/Applications/ChatGPT.app';
const executable = `${appPath}/Contents/MacOS/ChatGPT`;
const childExecutable = `${appPath}/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`;
const root = { pid: 101, ppid: 1, command: executable, arguments: executable };
const child = { pid: 102, ppid: 101, command: childExecutable, arguments: `${childExecutable} app-server` };
const vscode = { pid: 201, ppid: 200, command: '/Users/test/.vscode/extensions/openai/bin/codex', arguments: 'codex app-server --listen stdio://' };

function fixture(initial = [root, child]) {
  const state = { processes: initial.map(process => ({ ...process })), calls: [], kills: [], bundleId: 'com.openai.codex', onKill: null, onOpen: null };
  const platform = new MacDesktopPlatform({
    platform: 'darwin',
    execFile: async (file, args) => {
      state.calls.push([file, args]);
      if (file === '/usr/bin/plutil') {
        if (!args.at(-1).startsWith(appPath)) throw new Error('not installed');
        return { stdout: { CFBundleIdentifier: state.bundleId, CFBundleExecutable: 'ChatGPT', CFBundleShortVersionString: '26.1007.71326' }[args[1]] };
      }
      if (file === '/bin/test') return { stdout: '' };
      if (file === '/bin/ps' && args[0] === '-p') return { stdout: state.processes.find(process => process.pid === Number(args[1]))?.command ?? '' };
      if (file === '/bin/ps') return { stdout: state.processes.map(process => args.at(-1).includes('ppid') ? `${process.pid} ${process.ppid} ${process.command}` : `${process.pid} ${process.arguments}`).join('\n') };
      if (file === '/usr/bin/open') { state.onOpen?.(); return { stdout: '' }; }
      throw new Error('Unexpected command');
    },
    kill: (pid, signal) => { state.kills.push([pid, signal]); state.onKill?.(pid); },
  });
  platform.timeoutMs = 15;
  platform.pollIntervalMs = 2;
  return { platform, state };
}

test('desktop inspection verifies the bundle and hides process arguments', async () => {
  const { platform, state } = fixture();
  state.processes[1].arguments += ' --some-private-value=secret';
  const snapshot = await platform.inspect();
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.appPath, appPath);
  assert.equal(snapshot.appVersion, '26.1007.71326');
  assert.deepEqual(snapshot.processes.map(process => process.pid), [101, 102]);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  state.bundleId = 'com.unrelated.app';
  assert.equal((await platform.inspect()).installed, false);
});

test('VS Code and external CLI block switching; manager processes can be ignored', async () => {
  const { platform } = fixture([root, child, vscode]);
  assert.equal((await platform.inspect()).blockingClients, true);
  const allowed = await platform.inspect({ ignoredPids: [201] });
  assert.equal(allowed.blockingClients, false);
  assert.equal(allowed.reason, null);
});

test('ignored manager adapters are excluded even when descended from the desktop', async () => {
  const { platform } = fixture([root, child, { ...vscode, ppid: 102 }]);
  const snapshot = await platform.inspect({ ignoredPids: [201] });
  assert.deepEqual(snapshot.processes.map(process => process.pid), [101, 102]);
  assert.equal(snapshot.blockingClients, false);
});

test('custom auth storage, home and profiles block switching without exposing values', async () => {
  for (const override of ['-c cli_auth_credentials_store="keyring"', '--codex-home /private/home', 'CODEX_HOME=/private/home', '-p sensitive-profile']) {
    const { platform, state } = fixture();
    state.processes[1].arguments += ` ${override}`;
    const snapshot = await platform.inspect();
    assert.match(snapshot.reason, /自定义/);
    assert.equal(JSON.stringify(snapshot).includes('/private/home'), false);
    assert.equal(JSON.stringify(snapshot).includes('sensitive-profile'), false);
  }
});

test('stop sends TERM only to the verified desktop main process and waits for the child', async () => {
  const { platform, state } = fixture();
  const snapshot = await platform.inspect();
  state.onKill = () => { state.processes = []; };
  await platform.stop(snapshot);
  assert.deepEqual(state.kills, [[101, 'SIGTERM']]);
  assert.ok(state.calls.some(([file, args]) => file === '/bin/ps' && args[0] === '-p'));
});

test('stop refuses a replaced root process and never signals it', async () => {
  const { platform, state } = fixture();
  const snapshot = await platform.inspect();
  state.processes[0].pid = 999;
  await assert.rejects(platform.stop(snapshot), /进程已经变化/);
  assert.deepEqual(state.kills, []);
});

test('a surviving app-server child cancels switching without SIGKILL', async () => {
  const { platform, state } = fixture();
  const snapshot = await platform.inspect();
  state.onKill = () => { state.processes = [{ ...child, ppid: 1 }]; };
  await assert.rejects(platform.stop(snapshot), /尚未完全退出/);
  assert.deepEqual(state.kills, [[101, 'SIGTERM']]);
});

test('launch uses verified application path and waits for a real process', async () => {
  const { platform, state } = fixture([]);
  const snapshot = await platform.inspect();
  state.onOpen = () => { state.processes = [root]; };
  await platform.launch(snapshot);
  assert.ok(state.calls.some(([file, args]) => file === '/usr/bin/open' && args.join('|') === `-a|${appPath}`));
  state.processes = [];
  state.onOpen = null;
  await assert.rejects(platform.launch(snapshot), /尚未检测到/);
});

test('unsupported platforms and untrusted launch paths fail before opening or signalling', async () => {
  const unsupported = new MacDesktopPlatform({ platform: 'linux', execFile: () => { throw new Error('must not run'); } });
  assert.equal((await unsupported.inspect()).supported, false);
  const { platform, state } = fixture();
  const snapshot = await platform.inspect();
  await assert.rejects(platform.launch({ ...snapshot, appPath: '/tmp/untrusted.app' }), /路径或版本/);
  assert.equal(state.calls.some(([file]) => file === '/usr/bin/open'), false);
  assert.deepEqual(state.kills, []);
});
