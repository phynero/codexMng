import test from 'node:test';
import assert from 'node:assert/strict';
import { remaining, countdown, windowPair, windowLabel, accountHealth, nearestResets, formatReset, escapeHtml } from '../public/lib.mjs';
const now = Date.UTC(2026,9,15,2,0,0);
const short = {usedPercent:30,windowDurationMins:300,resetsAt:now/1000+3600};
const week = {usedPercent:70,windowDurationMins:10080,resetsAt:now/1000+86400};
const account = (rateLimits=[{primary:short,secondary:week}]) => ({status:'connected',lastUpdatedAt:new Date(now).toISOString(),rateLimits});
test('remaining quota distinguishes unknown and zero, clamps out-of-range values',()=>{
  assert.equal(remaining(null),null); assert.equal(remaining({usedPercent:null}),null); assert.equal(remaining({usedPercent:NaN}),null);
  assert.equal(remaining({usedPercent:100}),0); assert.equal(remaining({usedPercent:0}),100); assert.equal(remaining({usedPercent:130}),0); assert.equal(remaining({usedPercent:-5}),100);
});
test('quota windows are identified by actual duration, including reversed and single-window responses',()=>{
  assert.deepEqual(windowPair({primary:week,secondary:short}),[short,week]);
  assert.deepEqual(windowPair({primary:week}),[null,week]);
  assert.deepEqual(windowPair({secondary:short}),[short,null]);
  assert.deepEqual(windowPair(null),[null,null]);
  const other={usedPercent:1,windowDurationMins:15};
  assert.deepEqual(windowPair({primary:week,secondary:other}),[other,week]);
  assert.equal(windowLabel({windowDurationMins:15},''),'15-minute quota');
  assert.equal(windowLabel(week,''),'Weekly quota');
});
test('elapsed reset does not manufacture recovered quota',()=>{
  const expired = {...short,usedPercent:100,resetsAt:now/1000-1};
  assert.equal(accountHealth(account([{primary:expired}]),now),'stale');
  assert.equal(remaining(expired),0);
  assert.equal(countdown(expired.resetsAt,now),'Reset time reached · Awaiting update');
  assert.equal(countdown(null,now),'Reset time unknown');
  assert.equal(countdown(now/1000+3601,now),'01:00:01');
  assert.equal(countdown(now/1000+90060,now),'1d 1h 1m');
});
test('account status distinguishes errors, stale data, unavailable quota and low multiple buckets',()=>{
  assert.equal(accountHealth(account(),now),'ready');
  assert.equal(accountHealth({...account(),lastUpdatedAt:new Date(now-181000).toISOString()},now),'stale');
  assert.equal(accountHealth({...account(),status:'error'},now),'error');
  assert.equal(accountHealth(account([]),now),'unknown');
  assert.equal(accountHealth(account([{primary:short,secondary:{...week,usedPercent:null}}]),now),'unknown');
  assert.equal(accountHealth(account([{primary:{...short,usedPercent:null}}]),now),'unknown');
  assert.equal(accountHealth(account([{primary:short},{primary:{...short,usedPercent:90}}]),now),'low');
  assert.equal(accountHealth(account([{primary:short},{primary:{...short,usedPercent:100}}]),now),'limited');
});
test('nearest resets filters elapsed and missing reset times then sorts across accounts',()=>{
  const a={...account(),id:'a'},b={...account([{primary:{...short,resetsAt:now/1000+60},secondary:{...week,resetsAt:null}}]),id:'b'};
  const list=nearestResets([a,b],now);
  assert.equal(list.length,3); assert.equal(list[0].account.id,'b'); assert.equal(list[2].window.windowDurationMins,10080);
  assert.equal(formatReset(Date.UTC(2026,9,15,2,0,0)/1000),'10/15, 10:00');
});
test('user labels cannot inject markup',()=>assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
