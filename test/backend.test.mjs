import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp,rm,readFile,writeFile,stat,access,realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { get as httpGet } from 'node:http';
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
test('deleting during credential lookup cannot leave a late monitoring process or directory',async()=>{
  const f=await fixture();try{
    const account=await f.manager.add('Delete while starting');
    let signalLookup,releaseLookup;
    const entered=new Promise(resolve=>{signalLookup=resolve;});
    const gate=new Promise(resolve=>{releaseLookup=resolve;});
    f.manager.externalAuthProvider=async()=>{signalLookup();await gate;return null;};
    const refresh=f.manager.refresh(account.id);
    await entered;
    const removal=f.manager.remove(account.id);
    releaseLookup();
    await Promise.all([refresh,removal]);
    assert.equal(f.adapters.has(account.id),false);
    assert.equal(f.manager.adapters.has(account.id),false);
    assert.equal(f.manager.accounts.has(account.id),false);
    await assert.rejects(access(f.manager.accountHome(account.id)),error=>error.code==='ENOENT');
    assert.deepEqual(JSON.parse(await readFile(f.manager.metadataPath,'utf8')).accounts,[]);
  }finally{await f.cleanup();}
});
test('groups persist, move accounts, reorder them, and return accounts when a group is deleted',async()=>{
  const f=await fixture();try{
    const first=await f.manager.add('First'),second=await f.manager.add('Second'),third=await f.manager.add('Third');
    assert.equal(f.manager.get(first.id).groupId,'default');
    const group=await f.manager.addGroup('Work');
    await assert.rejects(f.manager.addGroup(' work '),error=>error.status===409);
    await f.manager.move(second.id,group.id);
    await f.manager.move(third.id,group.id,second.id);
    assert.deepEqual(f.manager.state().accounts.map(item=>item.id),[first.id,third.id,second.id]);
    assert.equal(f.manager.get(third.id).groupId,group.id);
    await f.manager.renameGroup(group.id,'Clients');
    assert.equal(f.manager.group(group.id).name,'Clients');
    const persisted=JSON.parse(await readFile(f.manager.metadataPath,'utf8'));
    assert.deepEqual(persisted.groups.map(item=>item.name),[null,'Clients']);
    await f.manager.removeGroup(group.id);
    assert.equal(f.manager.get(second.id).groupId,'default');
    assert.equal(f.manager.get(third.id).groupId,'default');
    await assert.rejects(f.manager.removeGroup('default'),error=>error.status===400);
    await f.manager.close();
    const restored=await new AccountManager(f.opts).init();
    try { await restored.startup; assert.deepEqual(restored.state().groups.map(item=>item.name),[null]); assert.deepEqual(restored.state().accounts.map(item=>item.id),[first.id,third.id,second.id]); }
    finally { await restored.close(); }
  }finally{await f.cleanup();}
});
test('legacy metadata migrates accounts into default group without changing their sequence',async()=>{
  const f=await fixture();try{
    const a=await f.manager.add('Legacy A'),b=await f.manager.add('Legacy B');
    await f.manager.close();
    const saved=JSON.parse(await readFile(f.manager.metadataPath,'utf8'));
    delete saved.groups;
    saved.accounts.forEach(item=>{delete item.groupId;delete item.order;});
    await writeFile(f.manager.metadataPath,JSON.stringify(saved));
    const restored=await new AccountManager(f.opts).init();
    try {await restored.startup;assert.deepEqual(restored.state().accounts.map(item=>[item.id,item.groupId]),[[a.id,'default'],[b.id,'default']]);await restored.addGroup('Work');}
    finally {await restored.close();}
    assert.equal(JSON.parse(await readFile(f.manager.metadataPath,'utf8')).groups.length,2);
  }finally{await f.cleanup();}
});
test('group names and move destinations are validated without changing account membership',async()=>{
  const f=await fixture();try{
    const a=await f.manager.add('A'),b=await f.manager.add('B'),group=await f.manager.addGroup('Work');
    for(const name of ['', ' ', 'x'.repeat(41), 'bad\nname'])await assert.rejects(f.manager.addGroup(name),error=>error.status===400);
    await assert.rejects(f.manager.addGroup('Default group'),error=>error.status===409);
    await f.manager.move(b.id,group.id);
    await assert.rejects(f.manager.move(a.id,group.id,a.id),error=>error.status===409);
    await assert.rejects(f.manager.move(a.id,'missing'),error=>error.status===404);
    assert.equal(f.manager.get(a.id).groupId,'default');
    await f.manager.renameGroup('default','Personal');
    assert.equal(f.manager.get((await f.manager.add('C')).id).groupId,'default');
    assert.equal(f.manager.group('default').name,'Personal');
    const original=await readFile(f.manager.metadataPath,'utf8');
    await assert.rejects(f.manager.move(a.id,group.id,'missing'),error=>error.status===409);
    assert.equal(await readFile(f.manager.metadataPath,'utf8'),original);
  }finally{await f.cleanup();}
});
test('group HTTP endpoints preserve origin checks and can move and return account records',async()=>{
  const f=await fixture();const app=await createApp(f.opts),url=await app.listen(0);
  const request=(endpoint,method,body={},headers={})=>fetch(url+endpoint,{method,headers:{Origin:url,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  try{
    const account=await app.manager.add('Keep me');
    assert.equal((await request('/api/groups','POST',{name:'Bad'},{Origin:'https://outside.invalid'})).status,403);
    assert.equal((await request('/api/groups','POST',{name:' '})).status,400);
    const response=await request('/api/groups','POST',{name:'Work'});assert.equal(response.status,201);
    const group=(await response.json()).groups.find(item=>item.id!=='default');
    assert.equal((await request(`/api/groups/${group.id}`,'PATCH',{name:'Clients'})).status,200);
    const move=await request(`/api/accounts/${account.id}/move`,'POST',{groupId:group.id});
    assert.equal(move.status,200);assert.equal((await move.json()).accounts[0].groupId,group.id);
    assert.equal((await request('/api/groups/default','DELETE')).status,400);
    const removal=await request(`/api/groups/${group.id}`,'DELETE');assert.equal(removal.status,200);
    const final=await removal.json();assert.equal(final.accounts[0].id,account.id);assert.equal(final.accounts[0].groupId,'default');
    await access(app.manager.accountHome(account.id));
  }finally{await app.close();await f.cleanup();}
});
test('HTTP routes enforce same-origin JSON mutations, validation and private-data boundary',async()=>{
  const f=await fixture();const app=await createApp(f.opts);const url=await app.listen(0);
  const request=(endpoint,method='GET',body={},headers={})=>fetch(url+endpoint,{method,headers:method==='GET'?headers:{Origin:url,'Content-Type':'application/json',...headers},body:method==='GET'?undefined:JSON.stringify(body)});
  try{
    assert.equal((await request('/')).status,200);
    // Native HTTP preserves the hostile Host header; newer fetch versions replace it.
    const hostileHostStatus=await new Promise((resolve,reject)=>{
      httpGet(url+'/api/state',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);
    });
    assert.equal(hostileHostStatus,403);
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
