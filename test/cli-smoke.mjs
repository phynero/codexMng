import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { CodexAdapter } from '../server/codex.mjs';
const home=await mkdtemp(path.join(os.tmpdir(),'codex-deck-smoke-'));
await writeFile(path.join(home,'config.toml'),'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n',{mode:0o600});
const adapter=new CodexAdapter({home,codexPath:process.env.CODEX_BIN||'codex',timeoutMs:15000});
try {
  await adapter.start();
  const result=await adapter.request('account/read',{refreshToken:false});
  assert.equal(result.account,null);
  await assert.rejects(adapter.request('account/rateLimits/read',{}),error=>error.authRequired===true);
  await adapter.close();
  const payload = { sub: 'smoke-user', exp: Math.floor(Date.now()/1000)+600, 'https://api.openai.com/auth': { chatgpt_account_id: 'smoke-account', chatgpt_user_id: 'smoke-user', chatgpt_plan_type: 'plus' }, 'https://api.openai.com/profile': { email: 'smoke@example.invalid' } };
  const fakeToken = `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fake`;
  const external = new CodexAdapter({home,codexPath:process.env.CODEX_BIN||'codex',timeoutMs:15000,externalAuth:{accessToken:fakeToken,chatgptAccountId:'smoke-account',chatgptPlanType:'plus'}});
  try {
    await external.start();
    assert.equal((await external.request('account/read',{refreshToken:false})).account.type,'chatgpt');
    const { access } = await import('node:fs/promises');
    await assert.rejects(access(path.join(home,'auth.json')),error=>error.code==='ENOENT');
  } finally { await external.close(); }
  console.log('真实 Codex App Server 隔离验证通过：初始化、未登录错误、临时令牌模式（模拟令牌且未写认证文件）。');
} finally {await adapter.close();await rm(home,{recursive:true,force:true});}
