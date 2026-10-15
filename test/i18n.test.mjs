import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_KEY, getLanguage, readLanguage, setLanguage, t, message, messages } from '../public/i18n.mjs';
import { countdown, formatReset, windowLabel, escapeHtml } from '../public/lib.mjs';

afterEach(() => setLanguage('en', { persist: false }));

test('first visit and unsupported saved preferences default to English', () => {
  assert.equal(getLanguage(), 'en');
  for (const value of [null, '', 'fr', 'zh', 'toString']) {
    assert.equal(readLanguage({ getItem: () => value }), 'en');
  }
  assert.equal(readLanguage({ getItem: () => 'zh-CN' }), 'zh-CN');
});

test('selected language is saved and can be restored on a subsequent visit', () => {
  const entries = new Map();
  const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  assert.equal(setLanguage('zh-CN', { storage }), true);
  assert.equal(entries.get(LANGUAGE_KEY), 'zh-CN');
  assert.equal(readLanguage(storage), 'zh-CN');
  assert.equal(t('添加并登录'), '添加并登录');
  setLanguage('en', { storage });
  assert.equal(readLanguage(storage), 'en');
  assert.equal(t('添加并登录'), 'Add and sign in');
});

test('unavailable storage still permits language changes without throwing', () => {
  const storage = {
    getItem() { throw new Error('Storage blocked'); },
    setItem() { throw new Error('Storage blocked'); },
  };
  assert.equal(readLanguage(storage), 'en');
  assert.equal(setLanguage('zh-CN', { storage }), false);
  assert.equal(getLanguage(), 'zh-CN');
  assert.equal(setLanguage('en', { storage: null }), false);
  assert.equal(getLanguage(), 'en');
  assert.equal(setLanguage('zh-CN', { storage, persist: false }), true);
  assert.equal(getLanguage(), 'zh-CN');
});

test('locale changes translate quota labels, elapsed states and dates without changing the timezone', () => {
  const now = Date.UTC(2026, 9, 15, 2, 0, 0);
  setLanguage('zh-CN', { persist: false });
  assert.equal(windowLabel({ windowDurationMins: 300 }), '5 小时额度');
  assert.equal(windowLabel({ windowDurationMins: 10080 }), '每周额度');
  assert.equal(countdown(now / 1000 - 1, now), '已到重置时间 · 等待同步');
  assert.equal(countdown(now / 1000 + 90060, now), '1天 1时 1分');
  assert.equal(formatReset(now / 1000), '10/15 10:00');
  assert.equal(formatReset(null), '暂无重置时间');
  setLanguage('en', { persist: false });
  assert.equal(windowLabel({ windowDurationMins: 300 }), '5-hour quota');
  assert.equal(countdown(now / 1000 + 90060, now), '1d 1h 1m');
  assert.equal(formatReset(now / 1000), '10/15, 10:00');
  assert.equal(formatReset(null), 'No reset time');
});

test('interpolation preserves user content and all translations retain their placeholders', () => {
  const name = '工作账号 <img src=x onerror=alert(1)> {count}';
  assert.equal(t('已连接 {name}', { name }), `Connected: ${name}`);
  assert.equal(t('已连接 {name}', { name: escapeHtml(name) }), `Connected: 工作账号 &lt;img src=x onerror=alert(1)&gt; {count}`);
  const placeholders = value => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
  for (const [source, translated] of Object.entries(messages)) {
    assert.deepEqual(placeholders(translated), placeholders(source), source);
  }
});

test('existing client feedback and API errors render in the selected language', () => {
  const error = '无法连接本地服务，请确认项目正在运行。';
  const english = message(error);
  assert.match(english, /Cannot reach the local service/);
  setLanguage('zh-CN', { persist: false });
  assert.equal(message(english), error);
  assert.equal(message('登录已失效，请重新登录。'), '登录已失效，请重新登录。');
  setLanguage('en', { persist: false });
  assert.equal(message('登录已失效，请重新登录。'), 'Your sign-in has expired. Please sign in again.');
});
