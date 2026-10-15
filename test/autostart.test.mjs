import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { buildDefinition, encodePlist, LABEL } from '../server/autostart.mjs';
const options = { nodePath: '/usr/local/bin/node', codexPath: '/opt/homebrew/bin/codex', directory: '/Users/example/Codex Tools & Apps', dataDir: '/Users/example/Codex Tools & Apps/data', home: '/Users/example', port: 4317, instanceId: 'test-instance' };

test('autostart runs the foreground server with fixed paths and a credential-free environment', () => {
  const definition = buildDefinition({ ...options, env: { HTTP_PROXY: 'http://127.0.0.1:7890', OPENAI_API_KEY: 'must-not-persist', CODEX_ACCESS_TOKEN: 'must-not-persist', CODEX_HOME: '/wrong/home', PATH: '/untrusted/bin' } });
  assert.equal(definition.Label, LABEL);
  assert.deepEqual(definition.ProgramArguments, ['/usr/local/bin/node', `${options.directory}/server/index.mjs`]);
  assert.equal(definition.EnvironmentVariables.HOME, options.home);
  assert.equal(definition.EnvironmentVariables.CODEX_MANAGER_DATA_DIR, options.dataDir);
  assert.equal(definition.EnvironmentVariables.CODEX_BIN, options.codexPath);
  assert.equal(definition.EnvironmentVariables.HTTP_PROXY, 'http://127.0.0.1:7890');
  for (const key of ['CODEX_HOME', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN']) assert.equal(definition.EnvironmentVariables[key], undefined);
  assert.equal(definition.RunAtLoad, true); assert.equal(definition.KeepAlive, true); assert.equal(definition.Umask, 0o077);
  assert.equal(definition.LimitLoadToSessionType, 'Aqua'); assert.equal(definition.ExitTimeOut, 30);
  assert.ok(!JSON.stringify(definition).includes('must-not-persist'));
});

test('autostart rejects relative runtime paths and invalid ports', () => {
  assert.throws(() => buildDefinition({ ...options, nodePath: 'node' }));
  assert.throws(() => buildDefinition({ ...options, codexPath: 'codex' }));
  assert.throws(() => buildDefinition({ ...options, port: 0 }));
  assert.throws(() => buildDefinition({ ...options, port: 70000 }));
});

test('generated plist round trips spaces, XML characters, arrays and launchd types', { skip: process.platform !== 'darwin' }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codex-autostart-plist-'));
  try {
    const definition = buildDefinition({ ...options, env: { NO_PROXY: 'example"<&>.invalid' } });
    const file = path.join(directory, 'test.plist');
    await writeFile(file, encodePlist(definition), { mode: 0o600 });
    await promisify(execFile)('/usr/bin/plutil', ['-lint', file]);
    const { stdout } = await promisify(execFile)('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]);
    assert.deepEqual(JSON.parse(stdout), definition);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
