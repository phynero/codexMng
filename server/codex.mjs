import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Never inherit API credentials or a user's existing Codex configuration.
export function isolatedEnvironment(home) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CODEX_CA_CERTIFICATE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CODEX_HOME = home;
  env.RUST_LOG = 'off';
  return env;
}

export async function checkCodex(codexPath = 'codex') {
  try {
    const { stdout } = await execFileAsync(codexPath, ['--version'], { timeout: 5_000, maxBuffer: 4096 });
    const version = stdout.trim().match(/^codex-cli [\w.\-+]+$/)?.[0] ?? 'Codex CLI';
    return { codexAvailable: true, codexVersion: version };
  } catch {
    return { codexAvailable: false, codexVersion: null };
  }
}

export class CodexAdapter extends EventEmitter {
  constructor({ home, codexPath = 'codex', timeoutMs = 45_000, externalAuth = null }) {
    super();
    this.home = home;
    this.codexPath = codexPath;
    this.timeoutMs = timeoutMs;
    this.externalAuth = externalAuth;
    this.pending = new Map();
    this.sequence = 0;
    this.process = null;
    this.stopped = false;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    return this.starting;
  }

  async initialize() {
    if (this.stopped) throw new Error('Codex session closed');
    this.process = spawn(this.codexPath, ['-c', `cli_auth_credentials_store="${this.externalAuth ? 'ephemeral' : 'file'}"`, 'app-server', '--listen', 'stdio://'], {
      cwd: this.home, env: isolatedEnvironment(this.home), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    this.process.stdin.on('error', () => {});
    let buffer = '';
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) { void this.close(); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try { this.receive(JSON.parse(line)); } catch { /* Ignore non-protocol output. */ }
      }
    });
    const failed = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Codex process unavailable'));
      }
      this.pending.clear();
      if (!this.stopped) this.emit('closed');
    };
    this.process.once('error', failed);
    this.process.once('exit', failed);
    await this.request('initialize', { clientInfo: { name: 'codex_account_dashboard', title: 'Codex Account Dashboard', version: '1.0.0' }, capabilities: { experimentalApi: Boolean(this.externalAuth) } });
    this.write({ method: 'initialized', params: {} });
    if (this.externalAuth) await this.request('account/login/start', { type: 'chatgptAuthTokens', ...this.externalAuth });
  }

  write(message) {
    if (this.stopped || !this.process?.stdin.writable) throw new Error('Codex session unavailable');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(message) {
    if (!message.method && Object.hasOwn(message, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error('Codex request failed');
        error.code = message.error.code;
        // Raw server errors may contain sensitive details; never propagate them.
        error.authRequired = /authenticat|unauthoriz|token.*expired|refresh.*token/i.test(String(message.error.message));
        pending.reject(error);
      } else pending.resolve(message.result);
    } else if (message.method && Object.hasOwn(message, 'id')) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
    } else if (message.method) this.emit('notification', message.method, message.params ?? {});
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('Codex request timed out');
        error.timedOut = true;
        reject(error);
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async close() {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex session closed'));
    }
    this.pending.clear();
    const child = this.process;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
      child.kill('SIGTERM');
    });
  }
}
