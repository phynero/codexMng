import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.mjs';
import { writePrivate, readPrivate, authIdentity } from '../server/credentials.mjs';
import { runDesktopJob } from '../server/desktop-worker.mjs';

function auth(user, revision = 1) {
  const payload = { sub: user, email: `${user}@example.invalid`, 'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: 'shared-workspace', chatgpt_plan_type: 'plus' } };
  const jwt = `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${revision}`;
  return { auth_mode: 'chatgpt', tokens: { id_token: jwt, access_token: jwt, refresh_token: `secret-refresh-${user}-${revision}`, account_id: 'shared-workspace' } };
}
class Adapter extends EventEmitter {
  constructor(options) { super(); Object.assign(this, options); this.closed = false; }
  async start() {}
  async close() { this.closed = true; }
  async request(method) {
    if (method === 'account/read') {
      const identity = authIdentity(await readPrivate(path.join(this.home, 'auth.json'), { optional: true }));
      return { account: identity ? { type: 'chatgpt', email: identity.email, planType: 'plus' } : null };
    }
    if (method === 'account/rateLimits/read') return { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1900000000 } } };
    throw new Error('Unexpected request');
  }
}
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'codex-switch-api-')));
  const home = path.join(root, 'home'); await mkdir(home);
  await writePrivate(path.join(home, 'auth.json'), auth('original'));
  const adapters = [], dispatches = [];
  const platform = {
    running: true, blockingClients: false,
    async inspect() { return { supported: true, installed: true, running: this.running, appPath: '/mock/Codex.app', executable: '/mock/Codex', appName: 'Codex', appVersion: 'fake', processes: [], blockingClients: this.blockingClients, reason: null }; },
    async stop() { this.running = false; }, async launch() { this.running = true; },
  };
  const policy = async () => ({ supported: true });
  const app = await createApp({
    dataDir: path.join(root, 'data'), pollIntervalMs: 0, health: { codexAvailable: true },
    adapterFactory: options => { const adapter = new Adapter(options); adapters.push(adapter); return adapter; },
    desktopOptions: { home, platform, policy, launchWorker: async dir => { dispatches.push(dir); return process.pid; } },
  });
  const url = await app.listen(0);
  async function add(user) { const account = await app.manager.add(user); await writePrivate(path.join(app.manager.accountHome(account.id), 'auth.json'), auth(user)); await app.manager.refresh(account.id); return account; }
  const request = (endpoint, body = {}, headers = {}) => fetch(`${url}${endpoint}`, { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { root, home, app, platform, policy, url, adapters, dispatches, add, request, async cleanup() { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

test('switch API requires same-origin confirmation and never returns credentials', async () => {
  const f = await fixture(); try {
    const target = await f.add('target');
    assert.equal((await f.request(`/api/accounts/${target.id}/activate`)).status, 400);
    assert.equal((await f.request(`/api/accounts/${target.id}/activate`, { confirmRestart: true }, { Origin: 'https://outside.invalid' })).status, 403);
    assert.equal(f.dispatches.length, 0);
    const response = await f.request(`/api/accounts/${target.id}/activate`, { confirmRestart: true });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.desktop.job.status, 'queued'); assert.equal(body.desktop.canSwitch, false);
    assert.equal(f.app.manager.suspended, true); assert.equal(f.app.manager.adapters.size, 0);
    assert.ok(f.adapters.every(adapter => adapter.closed));
    assert.equal(f.dispatches.length, 1);
    assert.equal((await f.request(`/api/accounts/${target.id}`, {})).status, 409);
    assert.equal((await f.request('/api/accounts', { name: 'blocked' })).status, 409);
    const state = await (await fetch(`${f.url}/api/state`)).json();
    const encoded = JSON.stringify(state);
    for (const forbidden of ['secret-refresh', 'access_token', 'id_token', 'workerPid', 'stagedFingerprint']) assert.ok(!encoded.includes(forbidden));
    await runDesktopJob(f.app.desktop.directory, { platform: f.platform, policy: f.policy, delayMs: 0 });
    const complete = await f.app.desktop.state();
    assert.equal(complete.job.status, 'completed'); assert.equal(complete.matchedAccountId, target.id);
    assert.equal(complete.canRestore, true); assert.equal(f.app.manager.suspended, false);
    assert.equal(authIdentity(await readPrivate(path.join(f.home, 'auth.json'))).email, 'target@example.invalid');
  } finally { await f.cleanup(); }
});

test('simultaneous switch requests dispatch only one worker', async () => {
  const f = await fixture(); try {
    const target = await f.add('target');
    const results = await Promise.allSettled([f.app.desktop.activate(target.id, true), f.app.desktop.activate(target.id, true)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter(item => item.status === 'rejected' && item.reason.status === 409).length, 1);
    assert.equal(f.dispatches.length, 1);
  } finally { await f.cleanup(); }
});

test('shared desktop monitoring uses access-token-only sessions and refreshes when desktop tokens rotate', async () => {
  const f = await fixture(); try {
    const original = await f.add('original');
    const active = f.app.manager.adapters.get(original.id);
    assert.ok(active.externalAuth.accessToken); assert.equal(active.externalAuth.chatgptAccountId, 'shared-workspace');
    assert.equal('refresh_token' in active.externalAuth, false); assert.equal('refreshToken' in active.externalAuth, false);
    await writePrivate(path.join(f.home, 'auth.json'), auth('original', 2));
    await f.app.manager.refresh(original.id);
    assert.equal(active.closed, true);
    assert.notEqual(f.app.manager.adapters.get(original.id), active);
    const other = await f.add('other-user');
    assert.equal(f.app.manager.adapters.get(other.id).externalAuth, null);
    await assert.rejects(f.app.desktop.activate(original.id, true), error => error.status === 409);
  } finally { await f.cleanup(); }
});

test('duplicate identities are stopped before starting another refresh-capable session', async () => {
  const f = await fixture(); try {
    await f.add('target'); const duplicate = await f.add('target');
    assert.equal(f.app.manager.get(duplicate.id).status, 'error');
    assert.match(f.app.manager.get(duplicate.id).error, /列表中/);
    assert.equal(f.app.manager.adapters.has(duplicate.id), false);
    await assert.rejects(f.app.desktop.activate(duplicate.id, true), error => error.status === 409);
    assert.equal(f.dispatches.length, 0);
  } finally { await f.cleanup(); }
});

test('restore uses the managed account latest rotated credentials instead of a stale backup', async () => {
  const f = await fixture(); try {
    const old = await f.add('backup-user');
    await writePrivate(path.join(f.app.desktop.directory, 'backup.json'), { present: true, auth: auth('backup-user', 1) });
    await writePrivate(path.join(f.app.manager.accountHome(old.id), 'auth.json'), auth('backup-user', 9));
    assert.equal((await f.request('/api/desktop/restore', { confirmRestart: true })).status, 202);
    const staged = await readPrivate(path.join(f.app.desktop.directory, 'staged.json'));
    assert.equal(staged.auth.tokens.refresh_token, 'secret-refresh-backup-user-9');
    await runDesktopJob(f.app.desktop.directory, { platform: f.platform, policy: f.policy, delayMs: 0 });
    assert.equal((await f.app.desktop.state()).job.status, 'completed');
  } finally { await f.cleanup(); }
});

test('blocking clients and invalid target credentials never dispatch a worker', async () => {
  const f = await fixture(); try {
    const target = await f.add('target');
    f.platform.blockingClients = true;
    await assert.rejects(f.app.desktop.activate(target.id, true), error => error.status === 409);
    assert.equal(f.dispatches.length, 0); assert.equal(f.app.manager.suspended, false);
    f.platform.blockingClients = false;
    await writePrivate(path.join(f.app.manager.accountHome(target.id), 'auth.json'), { auth_mode: 'apikey' });
    await assert.rejects(f.app.desktop.activate(target.id, true), error => error.status === 409);
    assert.equal(f.dispatches.length, 0);
  } finally { await f.cleanup(); }
});

test('failed worker launch releases the switch lock and resumes quota polling', async () => {
  const f = await fixture(); try {
    const target = await f.add('target');
    f.app.desktop.launchWorker = async () => { throw new Error('private details'); };
    await assert.rejects(f.app.desktop.activate(target.id, true), error => error.status === 500 && !error.message.includes('private'));
    assert.equal(f.app.manager.suspended, false);
    assert.equal((await f.app.desktop.state()).job.status, 'failed');
    assert.equal(await readPrivate(path.join(f.app.desktop.directory, 'staged.json'), { optional: true }), null);
  } finally { await f.cleanup(); }
});

test('dead workers are detected without restart and release suspended monitoring', async () => {
  const f = await fixture(); try {
    await f.app.manager.suspend(); f.app.desktop.ownsSuspension = true;
    await writePrivate(path.join(f.app.desktop.directory, 'status.json'), { id: 'dead', status: 'applying', createdAt: new Date(Date.now() - 20000).toISOString(), workerPid: 2147483647 });
    const state = await f.app.desktop.state();
    assert.equal(state.job.status, 'failed'); assert.equal(f.app.manager.suspended, false);
  } finally { await f.cleanup(); }
});
