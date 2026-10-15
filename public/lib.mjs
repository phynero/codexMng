import { t, getLanguage } from './i18n.mjs';
export const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
export function remaining(window) {
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return null;
  return clamp(100 - window.usedPercent);
}
export function windowLabel(window, fallback) {
  const minutes = window?.windowDurationMins;
  if (!Number.isFinite(minutes) || minutes <= 0) return window ? t('额度周期未知') : fallback;
  if (minutes === 10080) return t('每周额度');
  if (minutes % 1440 === 0) return t('{count} 天额度', { count: minutes / 1440 });
  if (minutes % 60 === 0) return t('{count} 小时额度', { count: minutes / 60 });
  return t('{count} 分钟额度', { count: minutes });
}
export function windowPair(bucket) {
  const windows = [bucket?.primary, bucket?.secondary].filter(Boolean);
  const short = windows.find(w => w.windowDurationMins === 300);
  const week = windows.find(w => w.windowDurationMins === 10080);
  if (short || week) return [short || windows.find(w => w !== week) || null, week || windows.find(w => w !== short) || null];
  return [bucket?.primary || null, bucket?.secondary || null];
}
export function isExpired(window, now = Date.now()) {
  return Number.isFinite(window?.resetsAt) && window.resetsAt * 1000 <= now;
}
export function countdown(resetsAt, now = Date.now()) {
  if (!Number.isFinite(resetsAt)) return t('重置时间未知');
  const seconds = Math.ceil((resetsAt * 1000 - now) / 1000);
  if (seconds <= 0) return t('已到重置时间 · 等待同步');
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const rest = seconds % 60;
  if (days) return t('{days}天 {hours}时 {minutes}分', { days, hours, minutes });
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
export function accountHealth(account, now = Date.now()) {
  if (account.status === 'connecting') return 'connecting';
  if (account.status !== 'connected') return account.status === 'error' ? 'error' : 'disconnected';
  const windows = (account.rateLimits || []).flatMap(b => [b.primary, b.secondary]).filter(Boolean);
  if (!windows.length) return 'unknown';
  if (windows.some(w => isExpired(w, now)) || (account.lastUpdatedAt && now - Date.parse(account.lastUpdatedAt) > 180000)) return 'stale';
  const values = windows.map(remaining).filter(n => n !== null);
  if (!values.length) return 'unknown';
  if (values.some(n => n <= 0)) return 'limited';
  if (values.some(n => n <= 20)) return 'low';
  if (values.length !== windows.length) return 'unknown';
  return 'ready';
}
export function nearestResets(accounts, now = Date.now()) {
  return accounts.flatMap(account => (account.rateLimits || []).flatMap(bucket => [bucket.primary, bucket.secondary].filter(Boolean).map(window => ({account, bucket, window}))))
    .filter(entry => Number.isFinite(entry.window.resetsAt) && entry.window.resetsAt * 1000 > now)
    .sort((a, b) => a.window.resetsAt - b.window.resetsAt);
}
export function formatReset(value) {
  if (!Number.isFinite(value)) return t('暂无重置时间');
  return new Intl.DateTimeFormat(getLanguage() === 'en' ? 'en-US' : 'zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value * 1000));
}
export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
}
