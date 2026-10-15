import { constants } from 'node:fs';
import { open, lstat, mkdir, chmod, rename, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export async function safeDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory);
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  for (const name of parts) {
    cursor = path.join(cursor, name);
    let info;
    try { info = await lstat(cursor); }
    catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await mkdir(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      info = await lstat(cursor);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('登录目录不能是符号链接。');
  }
  return absolute;
}

export async function readPrivate(file, { optional = false } = {}) {
  try {
    await safeDirectory(path.dirname(file));
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error('本地登录文件格式无效。');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
}

export async function writePrivate(file, value) {
  await safeDirectory(path.dirname(file), { create: true });
  try { if (!(await lstat(file)).isFile()) throw new Error('目标文件必须是普通文件。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temp, file); await chmod(file, 0o600); }
  finally { await rm(temp, { force: true }); }
}

function claims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

export function authIdentity(auth) {
  if (!auth || auth.auth_mode !== 'chatgpt' || !auth.tokens) return null;
  const id = claims(auth.tokens.id_token ?? '');
  const access = claims(auth.tokens.access_token ?? '');
  const info = id['https://api.openai.com/auth'] ?? access['https://api.openai.com/auth'] ?? {};
  const email = id.email ?? access['https://api.openai.com/profile']?.email;
  const userId = info.chatgpt_user_id ?? info.user_id ?? id.sub;
  const accountId = auth.tokens.account_id ?? info.chatgpt_account_id;
  if (typeof accountId !== 'string' || (!userId && !email)) return null;
  return { accountId, userId: typeof userId === 'string' ? userId : null, email: typeof email === 'string' ? email : null, planType: info.chatgpt_plan_type ?? null };
}

export function sameIdentity(a, b) {
  if (!a || !b || a.accountId !== b.accountId) return false;
  if (a.userId && b.userId) return a.userId === b.userId;
  return Boolean(a.email && b.email && a.email.toLowerCase() === b.email.toLowerCase());
}

export function validAuth(auth) {
  return Boolean(authIdentity(auth) && ['id_token', 'access_token', 'refresh_token', 'account_id'].every(key => typeof auth.tokens[key] === 'string' && auth.tokens[key].length > 0));
}

export function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

// Only the file credential store is supported. Unknown/repeated/table-scoped settings
// fail closed; no user or organization settings are rewritten by the dashboard.
export async function credentialPolicy(home, { checkSystem = true } = {}) {
  try {
    await safeDirectory(home);
    let config = '';
    try { config = await readFile(path.join(home, 'config.toml'), 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    let table = false, store = null, method = null, workspace = null;
    for (const raw of config.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) table = true;
      for (const key of ['cli_auth_credentials_store', 'forced_login_method', 'forced_chatgpt_workspace_id']) {
        if (!line.includes(key)) continue;
        const match = line.match(new RegExp(`^${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`));
        if (!match || table) return { supported: false, reason: '登录配置存在自定义或分组设置，请在 Codex 内完成切换。' };
        if (key === 'cli_auth_credentials_store') { if (store !== null) throw new Error(); store = match[1]; }
        if (key === 'forced_login_method') method = match[1];
        if (key === 'forced_chatgpt_workspace_id') workspace = match[1];
      }
    }
    if (checkSystem) {
      for (const file of ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml', path.join(home, 'managed_config.toml')]) {
        try { await lstat(file); return { supported: false, reason: '检测到受管理的 Codex 配置，请使用客户端的登录功能。' }; }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    }
    if (store && store !== 'file') return { supported: false, reason: `当前凭据存储为 ${['keyring', 'auto', 'ephemeral'].includes(store) ? store : '自定义方式'}，暂不支持网页切换。` };
    if (method && method !== 'chatgpt') return { supported: false, reason: '当前配置限制为 API Key 登录，不能切换订阅账号。' };
    return { supported: true, workspace };
  } catch { return { supported: false, reason: '无法安全读取本机登录配置，请检查目录和文件权限。' }; }
}
