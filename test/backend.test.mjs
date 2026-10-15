import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,rm,readFile,writeFile,stat,access,realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server/index.mjs';
import { AccountManager,normalizeRateLimits } from '../server/accounts.mjs';
import { isolatedEnvironment } from '../server/codex.mjs';
const limits = {rateLimitsByLimitId:{codex:{limitId:'codex',primary:{usedPercent:27,windowDurationMins:300,resetsAt:1800000000},secondary:{usedPercent:81,windowDurationMins:10080,resetsAt:1800600000}},extra:{limitId:'extra',primary:null,secondary:null}}};
class FakeAdapter extends EventEmitter {
  constructor(options){super();this.home=options.home;this.closed=false;this.account=null;this.calls=[];}
  async start(){}
  async request(method,params){
    this.calls.push([method,params]);
    if(this.fail)throw new Error('private-access-token');
    if(method==='account/read')return {account:this.account};
    if(method==='account/rateLimits/read')return structuredClone(limits);
    if(method==='account/login/start')return params.type==='chatgptDeviceCode'?{loginId:'pending-id',userCode:'ABCD-EFGH',verificationUrl:'https://auth.openai.com/codex/device'}:{loginId:'pending-id',authUrl:'https://auth.openai.com/oauth/authorize?state=test'};
    if(method==='account/login/cancel')return {status:'canceled'};
    throw new Error('Unexpected RPC');
  }
  async close(){this.closed=true;}
}
async function fixture(){
  const dir=await realpath(await mkdtemp(path.join(os.tmpdir(),'codex-deck-test-')));
  const adapters=new Map();
  const opts={desktop:false,dataDir:dir,pollIntervalMs:0,health:{codexAvailable:true,codexVersion:'fake'},adapterFactory:options=>{const adapter=new FakeAdapter(options);adapters.set(options.accountId,adapter);return adapter;}};
  const manager=await new AccountManager(opts).init();
  return {dir,adapters,opts,manager,async cleanup(){await manager.close();await rm(dir,{recursive:true,force:true});}};
}
test('normalization preserves all buckets and treats null usage as unknown',()=>{
  const buckets=normalizeRateLimits(limits);assert.equal(buckets.length,2);assert.equal(buckets[0].primary.remainingPercent,73);assert.equal(buckets[0].secondary.remainingPercent,19);assert.equal(buckets[1].primary,null);
  assert.equal(normalizeRateLimits({rateLimits:{primary:{usedPercent:null}}})[0].primary.remainingPercent,null);
  assert.deepEqual(normalizeRateLimits(null),[]);
});
test('isolated environment never inherits provider credentials or existing CODEX_HOME',()=>{
  const env=isolatedEnvironment('/tmp/test-home');assert.equal(env.CODEX_HOME,'/tmp/test-home');
  for(const key of ['OPENAI_API_KEY','CODEX_API_KEY','CODEX_ACCESS_TOKEN','OPENAI_BASE_URL','CODEX_THREAD_ID'])assert.equal(env[key],undefined);
});
test('add, rename, persistence, directory permissions and isolated deletion',async()=>{
  const f=await fixture();try{
    const a=await f.manager.add('  主力  '),b=await f.manager.add('备用');assert.equal(a.name,'主力');
    await f.manager.rename(a.id,'开发');
    await writeFile(path.join(f.manager.accountHome(a.id),'auth.json'),'mock-auth');
    await writeFile(path.join(f.manager.accountHome(b.id),'auth.json'),'keep-other-account');
    await f.manager.secureAuth(a.id);
    assert.equal((await stat(f.manager.accountHome(a.id))).mode&0o777,0o700);
    assert.equal((await stat(path.join(f.manager.accountHome(a.id),'auth.json'))).mode&0o777,0o600);
    assert.equal((await stat(f.manager.metadataPath)).mode&0o777,0o600);
    const saved=JSON.parse(await readFile(f.manager.metadataPath,'utf8'));assert.equal(saved.accounts[0].name,'开发');assert.ok(!('login' in saved.accounts[0]));
    await f.manager.remove(a.id);await assert.rejects(access(f.manager.accountHome(a.id)));
    assert.equal(await readFile(path.join(f.manager.accountHome(b.id),'auth.json'),'utf8'),'keep-other-account');
    await f.manager.close();
    const restored=await new AccountManager(f.opts).init();await restored.startup;assert.equal(restored.state().accounts.length,1);assert.equal(restored.state().accounts[0].name,'备用');await restored.close();
  }finally{await f.cleanup();}
});
test('login lock, device flow, cancel and successful login notification',async()=>{
  const f=await fixture();try{
    const a=await f.manager.add('A'),b=await f.manager.add('B');
    const started=await f.manager.login(a.id);assert.equal(started.status,'connecting');assert.match(started.login.authUrl,/^https:\/\/auth.openai.com/);assert.ok(!JSON.stringify(started).includes('pending-id'));
    await assert.rejects(f.manager.login(b.id),e=>e.status===409);
    await f.manager.cancelLogin(a.id);assert.equal(f.adapters.get(a.id).closed,true);assert.equal(f.manager.activeLogin,null);
    const device=await f.manager.login(b.id,'device');assert.equal(device.login.userCode,'ABCD-EFGH');
    const adapter=f.adapters.get(b.id);adapter.account={type:'chatgpt',email:'test@example.com',planType:'plus'};
    await f.manager.notification(f.manager.get(b.id),adapter,'account/login/completed',{loginId:'pending-id',success:true});
    const connected=f.manager.get(b.id);assert.equal(connected.status,'connected');assert.equal(connected.rateLimits[0].primary.remainingPercent,73);assert.equal(connected.email,'test@example.com');assert.equal(f.manager.activeLogin,null);
  }finally{await f.cleanup();}
});
test('network failure retains last quota and returns no raw sensitive error',async()=>{
  const f=await fixture();try{
    const a=await f.manager.add('A');await f.manager.refresh(a.id);const adapter=f.adapters.get(a.id);
    adapter.account={type:'chatgpt',email:'test@example.com',planType:'pro'};await f.manager.refresh(a.id);
    const saved=f.manager.state().accounts[0];adapter.fail=true;const failed=await f.manager.refresh(a.id);
    assert.equal(failed.status,'error');assert.deepEqual(failed.rateLimits,saved.rateLimits);assert.equal(failed.lastUpdatedAt,saved.lastUpdatedAt);assert.ok(!JSON.stringify(failed).includes('private-access-token'));
  }finally{await f.cleanup();}
});
test('HTTP routes enforce same-origin JSON mutations, validation and private-data boundary',async()=>{
  const f=await fixture();const app=await createApp(f.opts);const url=await app.listen(0);
  const request=(endpoint,method='GET',body={},headers={})=>fetch(url+endpoint,{method,headers:method==='GET'?headers:{Origin:url,'Content-Type':'application/json',...headers},body:method==='GET'?undefined:JSON.stringify(body)});
  try{
    assert.equal((await request('/')).status,200);
    assert.equal((await request('/api/state','GET',{}, {Host:'evil.example'})).status,403);
    assert.equal((await request('/api/accounts','POST',{name:'A'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await request('/api/accounts','POST',{name:'A'},{Origin:''})).status,403);
    assert.equal((await request('/api/accounts','POST',{name:'A'},{'Content-Type':'text/plain'})).status,415);
    assert.equal((await request('/api/accounts','POST',{name:' '})).status,400);
    assert.equal((await request('/api/accounts','POST',{name:'x'.repeat(61)})).status,400);
    const created=await request('/api/accounts','POST',{name:'UI test'});assert.equal(created.status,201);const {account}=await created.json();
    assert.equal((await request('/data/accounts.json')).status,404);
    assert.equal((await request('/%2e%2e%2fdata/accounts.json')).status,404);
    assert.equal((await request(`/api/accounts/${account.id}`,'PATCH',{name:'Renamed'})).status,200);
    assert.equal((await request(`/api/accounts/${account.id}`,'DELETE')).status,200);
    assert.deepEqual((await (await request('/api/state')).json()).accounts,[]);
  }finally{await app.close();await f.cleanup();}
});
