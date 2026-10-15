import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, mkdir, rm, writeFile, stat, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  safeDirectory, readPrivate, writePrivate, authIdentity, sameIdentity,
  validAuth, fingerprint, credentialPolicy,
} from '../server/credentials.mjs';
import { runDesktopJob } from '../server/desktop-worker.mjs';

function fakeAuth(user = 'first', { workspace = 'workspace-shared', version = 1, email = `${user}@example.test` } = {}) {
  const info = { chatgpt_account_id: workspace, chatgpt_user_id: user, chatgpt_plan_type: 'plus' };
  const token = payload => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test-signature-${version}`;
  return {
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: {
      id_token: token({ sub: user, email, 'https://api.openai.com/auth': info }),
      access_token: token({ sub: user, exp: 4000000000, 'https://api.openai.com/auth': info }),
      refresh_token: `fake-refresh-${user}-${version}`, account_id: workspace,
    },
    last_refresh: `2026-10-15T00:00:0${version}.000Z`,
  };
}

async function fixture({ previous = fakeAuth(), target = fakeAuth('second') } = {}) {
  // macOS /var is itself a symlink; production helpers deliberately reject symlink ancestors.
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'codex-desktop-test-'));
  const home = path.join(root, 'codex-home');
  const directory = path.join(root, 'job');
  await mkdir(home, { mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(directory, 'active.lock'), { mode: 0o700 });
  const authPath = path.join(home, 'auth.json');
  if (previous) await writePrivate(authPath, previous);
  const staged = { present: target !== null, auth: target };
  const job = { id: 'test-job', status: 'queued', targetName: '测试账号', createdAt: '2026-10-15T00:00:00.000Z' };
  const operation = {
    id: job.id, home, platform: { appPath: '/fake/Codex.app' },
    previousIdentity: authIdentity(previous), stagedFingerprint: fingerprint(staged), syncBackPaths: [],
  };
  await writePrivate(path.join(directory, 'status.json'), job);
  await writePrivate(path.join(directory, 'operation.json'), operation);
  await writePrivate(path.join(directory, 'staged.json'), staged);
  let running = true;
  const calls = [];
  const platform = {
    async inspect() {
      calls.push('inspect');
      return { supported: true, installed: true, appPath: operation.platform.appPath, running, blockingClients: false, reason: null, ...platform.state };
    },
    async stop() { calls.push('stop'); await platform.onStop?.(); running = false; },
    async launch() { calls.push('launch'); await platform.onLaunch?.(); running = true; },
    state: {},
  };
  return {
    root, home, directory, authPath, previous, target, staged, operation, platform, calls,
    async saveOperation() { await writePrivate(path.join(directory, 'operation.json'), operation); },
    async run(options = {}) { return runDesktopJob(directory, { platform, delayMs: 0, policy: async () => ({ supported: true }), ...options }); },
    async cleanup() { await rm(root, { recursive: true, force: true }); },
  };
}

async function assertCleaned(f) {
  for (const name of ['staged.json', 'operation.json', 'active.lock']) {
    await assert.rejects(access(path.join(f.directory, name)), error => error.code === 'ENOENT');
  }
}

test('identity compares the individual user as well as a shared workspace', () => {
  const first = authIdentity(fakeAuth('first'));
  const second = authIdentity(fakeAuth('second'));
  assert.equal(first.accountId, second.accountId);
  assert.equal(sameIdentity(first, second), false);
  assert.equal(sameIdentity(first, authIdentity(fakeAuth('first', { version: 2, email: 'new@example.test' }))), true);
  assert.equal(sameIdentity(first, authIdentity(fakeAuth('first', { workspace: 'another-workspace' }))), false);
  assert.equal(sameIdentity(null, first), false);
  assert.equal(sameIdentity({ accountId: 'a', email: 'Case@Example.test' }, { accountId: 'a', email: 'case@example.test' }), true);
  assert.equal(sameIdentity({ accountId: 'a' }, { accountId: 'a' }), false);
});

test('credential validation rejects absent, partial, API-key and undecodable logins', () => {
  assert.equal(validAuth(fakeAuth()), true);
  for (const value of [null, {}, { auth_mode: 'api_key', OPENAI_API_KEY: 'fake-key' }]) assert.equal(validAuth(value), false);
  for (const key of ['id_token', 'access_token', 'refresh_token', 'account_id']) {
    const value = fakeAuth(); value.tokens[key] = '';
    assert.equal(validAuth(value), false, `${key} is required`);
  }
  const malformed = fakeAuth();
  malformed.tokens.id_token = 'not-a-jwt'; malformed.tokens.access_token = 'not-a-jwt';
  assert.equal(validAuth(malformed), false);
});

test('credential policy accepts file storage and rejects unsupported or restricted configurations', async () => {
  const f = await fixture();
  try {
    const config = path.join(f.home, 'config.toml');
    assert.equal((await credentialPolicy(f.home, { checkSystem: false })).supported, true);
    await writeFile(config, 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\nforced_chatgpt_workspace_id = "required-workspace"\n');
    assert.deepEqual(await credentialPolicy(f.home, { checkSystem: false }), { supported: true, workspace: 'required-workspace' });
    for (const content of [
      ...['keyring', 'auto', 'ephemeral', 'unknown'].map(store => `cli_auth_credentials_store = "${store}"`),
      'forced_login_method = "api"',
      'cli_auth_credentials_store = "file"\ncli_auth_credentials_store = "file"',
      '[profile]\ncli_auth_credentials_store = "file"',
      'cli_auth_credentials_store = ["file"]',
    ]) {
      await writeFile(config, content);
      assert.equal((await credentialPolicy(f.home, { checkSystem: false })).supported, false, content);
    }
    await writeFile(config, 'cli_auth_credentials_store = "file"');
    await writeFile(path.join(f.home, 'managed_config.toml'), '# managed');
    assert.equal((await credentialPolicy(f.home)).supported, false);
  } finally { await f.cleanup(); }
});

test('private files have mode 600 and reject symlink files or directory ancestors', async () => {
  const f = await fixture();
  try {
    assert.equal((await stat(f.authPath)).mode & 0o777, 0o600);
    const alias = path.join(f.root, 'alias');
    await symlink(f.home, alias);
    await assert.rejects(safeDirectory(alias));
    await assert.rejects(readPrivate(path.join(alias, 'auth.json')));
    await assert.rejects(writePrivate(path.join(alias, 'auth.json'), fakeAuth('intruder')));
    const linkedFile = path.join(f.root, 'linked-auth.json');
    await symlink(f.authPath, linkedFile);
    await assert.rejects(readPrivate(linkedFile));
    await assert.rejects(writePrivate(linkedFile, fakeAuth('intruder')));
    assert.deepEqual(await readPrivate(f.authPath), f.previous);
  } finally { await f.cleanup(); }
});

test('switch backs up the final desktop tokens after shutdown and syncs only the owning user', async () => {
  const f = await fixture();
  try {
    const newest = fakeAuth('first', { version: 2 });
    const ownPath = path.join(f.root, 'managed-own', 'auth.json');
    const otherPath = path.join(f.root, 'managed-other', 'auth.json');
    const other = fakeAuth('other-member');
    await writePrivate(ownPath, f.previous); await writePrivate(otherPath, other);
    f.operation.syncBackPaths = [ownPath, otherPath]; await f.saveOperation();
    f.platform.onStop = () => writePrivate(f.authPath, newest);
    const result = await f.run();
    assert.equal(result.status, 'completed');
    assert.deepEqual(await readPrivate(f.authPath), f.target);
    assert.deepEqual(await readPrivate(path.join(f.directory, 'backup.json')), { present: true, auth: newest });
    assert.deepEqual(await readPrivate(ownPath), newest);
    assert.deepEqual(await readPrivate(otherPath), other);
    assert.equal(f.calls.filter(call => call === 'stop').length, 1);
    assert.equal(f.calls.filter(call => call === 'launch').length, 1);
    assert.ok(f.calls.indexOf('stop') < f.calls.indexOf('launch'));
    for (const file of [f.authPath, ownPath, path.join(f.directory, 'backup.json'), path.join(f.directory, 'status.json')]) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    const publicJob = JSON.stringify(result);
    for (const token of [...Object.values(newest.tokens), ...Object.values(f.target.tokens)].filter(value => value.includes('fake-') || value.includes('test-signature'))) {
      assert.equal(publicJob.includes(token), false);
    }
    assert.ok(!publicJob.includes('tokens'));
    await assertCleaned(f);
  } finally { await f.cleanup(); }
});

test('restore can reinstate a missing auth file and switch can start from an unsigned-in desktop', async () => {
  for (const setup of [{ target: null }, { previous: null }]) {
    const f = await fixture(setup);
    try {
      const result = await f.run();
      assert.equal(result.status, 'completed');
      assert.deepEqual(await readPrivate(f.authPath, { optional: true }), f.target);
      assert.deepEqual(await readPrivate(path.join(f.directory, 'backup.json')), { present: f.previous !== null, auth: f.previous });
      await assertCleaned(f);
    } finally { await f.cleanup(); }
  }
});

test('failed launch rolls back auth and retries reopening the original desktop', async () => {
  const f = await fixture();
  try {
    let attempts = 0;
    f.platform.onLaunch = () => { if (++attempts === 1) throw new Error('fake launch failure with private-token'); };
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.match(result.message, /已恢复/);
    assert.equal(result.message.includes('private-token'), false);
    assert.deepEqual(await readPrivate(f.authPath), f.previous);
    assert.equal(attempts, 2);
    assert.equal((await f.platform.inspect()).running, true);
    await assertCleaned(f);
  } finally { await f.cleanup(); }
});

test('a concurrent desktop identity change is preserved and never replaced', async () => {
  const f = await fixture();
  try {
    const thirdParty = fakeAuth('concurrent-login');
    f.platform.onStop = () => writePrivate(f.authPath, thirdParty);
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.deepEqual(await readPrivate(f.authPath), thirdParty);
    assert.equal((await f.platform.inspect()).running, true);
    await assertCleaned(f);
  } finally { await f.cleanup(); }
});

test('launch failure does not roll back over another client changing credentials', async () => {
  const f = await fixture();
  try {
    const thirdParty = fakeAuth('concurrent-login');
    f.platform.onLaunch = async () => { await writePrivate(f.authPath, thirdParty); throw new Error('fake failure'); };
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.deepEqual(await readPrivate(f.authPath), thirdParty);
    assert.deepEqual(await readPrivate(path.join(f.directory, 'backup.json')), { present: true, auth: f.previous });
    assert.match(result.message, /保留现状/);
    await assertCleaned(f);
  } finally { await f.cleanup(); }
});

test('unsupported storage, forced workspace, changed target and blocking clients stop before any desktop mutation', async () => {
  for (const scenario of ['storage', 'workspace', 'blocking-client', 'app-moved', 'target-changed', 'invalid-target']) {
    const f = await fixture();
    try {
      const options = {};
      if (scenario === 'storage') options.policy = async () => ({ supported: false, reason: 'keyring' });
      if (scenario === 'workspace') options.policy = async () => ({ supported: true, workspace: 'required-other-workspace' });
      if (scenario === 'blocking-client') f.platform.state.blockingClients = true;
      if (scenario === 'app-moved') f.platform.state.appPath = '/other/Codex.app';
      if (scenario === 'target-changed') await writePrivate(path.join(f.directory, 'staged.json'), { present: true, auth: fakeAuth('tampered') });
      if (scenario === 'invalid-target') {
        const invalid = { present: true, auth: { auth_mode: 'chatgpt', tokens: {} } };
        await writePrivate(path.join(f.directory, 'staged.json'), invalid);
        f.operation.stagedFingerprint = fingerprint(invalid); await f.saveOperation();
      }
      const result = await f.run(options);
      assert.equal(result.status, 'failed', scenario);
      assert.equal(f.calls.includes('stop'), false, scenario);
      assert.equal(f.calls.includes('launch'), false, scenario);
      assert.deepEqual(await readPrivate(f.authPath), f.previous, scenario);
      await assertCleaned(f);
    } finally { await f.cleanup(); }
  }
});

test('policy and other clients are checked again after the desktop exits', async () => {
  for (const scenario of ['policy-changed', 'client-started']) {
    const f = await fixture();
    try {
      let checks = 0;
      const options = scenario === 'policy-changed' ? { policy: async () => ({ supported: ++checks === 1 }) } : {};
      if (scenario === 'client-started') f.platform.onStop = () => { f.platform.state.blockingClients = true; };
      const result = await f.run(options);
      assert.equal(result.status, 'failed', scenario);
      assert.deepEqual(await readPrivate(f.authPath), f.previous, scenario);
      await assertCleaned(f);
    } finally { await f.cleanup(); }
  }
});
