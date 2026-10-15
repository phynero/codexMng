import test from 'node:test';
import assert from 'node:assert/strict';
import { translateServerMessage } from '../public/server-messages.mjs';

test('API account errors and desktop blocking reasons are translated by default', () => {
  assert.equal(translateServerMessage('登录已失效，请重新登录。'), 'Your sign-in has expired. Please sign in again.');
  assert.equal(translateServerMessage('请先关闭 VS Code 中的 Codex 及其他 Codex CLI 会话，再切换桌面账号。'), 'Close Codex in VS Code and any other Codex CLI sessions before switching the desktop account.');
  assert.equal(translateServerMessage('读取额度失败，已保留上次数据。请检查网络后刷新。'), 'Could not read usage. Your previous data has been kept. Check your connection and refresh.');
});

test('all credential storage variants have an English explanation', () => {
  for (const store of ['keyring', 'auto', 'ephemeral', '自定义方式']) {
    const result = translateServerMessage(`当前凭据存储为 ${store}，暂不支持网页切换。`);
    assert.doesNotMatch(result, /\p{Script=Han}|not available in English/u);
    assert.match(result, /Switching from this page is not supported\./);
    if (store !== '自定义方式') assert.ok(result.includes(store));
  }
});

test('composed worker failure messages preserve every recovery instruction', () => {
  const endings = [
    ['已恢复切换前的登录。', 'The previous sign-in has been restored.'],
    ['检测到客户端启动或登录文件变化，已保留现状；可使用恢复上次登录。', 'The app started or the sign-in file changed, so the current state was kept. You can use Restore previous sign-in.'],
    ['原登录备份仍保留，可使用恢复上次登录。', 'The original sign-in backup has been kept. You can use Restore previous sign-in.'],
  ];
  for (const [source, expected] of endings) {
    assert.equal(translateServerMessage(`客户端重新打开失败。${source}请手动打开 Codex。`), `The app could not be reopened. ${expected} Please open Codex manually.`);
  }
  assert.equal(translateServerMessage('切换未完成，原桌面登录未被替换。请手动打开 Codex。'), 'The switch did not complete. The original desktop sign-in was not replaced. Please open Codex manually.');
});

test('Chinese preference preserves the exact original message including combinations', () => {
  const message = '客户端重新打开失败。已恢复切换前的登录。请手动打开 Codex。';
  assert.equal(translateServerMessage(message, 'zh-CN'), message);
  assert.equal(translateServerMessage('未知中文消息', 'zh-CN'), '未知中文消息');
});

test('unknown Chinese has a useful fallback without leaking a partial translation', () => {
  const fallback = 'This server message is not available in English. Switch to Chinese to view the original message.';
  assert.equal(translateServerMessage('未知中文消息'), fallback);
  assert.equal(translateServerMessage('客户端重新打开失败。未知原因。'), fallback);
  assert.equal(translateServerMessage('Request failed'), 'Request failed');
  assert.equal(translateServerMessage(null), null);
  assert.equal(translateServerMessage(undefined), undefined);
  assert.equal(translateServerMessage(''), '');
});
