import { t, getLanguage, setLanguage, LANGUAGE_KEY, applyTranslations, message, message as localizeMessage } from './i18n.mjs';
import { remaining, windowLabel, windowPair, isExpired, countdown, accountHealth, nearestResets, formatReset, escapeHtml as esc } from './lib.mjs';

const icons = {
  grip:'<circle cx="9" cy="5" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="19" r="1"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  clock:'<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  shield:'<path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1.2.8-1.5 1-1.5 2.5M12 17h.01"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>',
  plus:'<path d="M12 5v14M5 12h14"/>', search:'<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/>',
  external:'<path d="M14 3h7v7m0-7L11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3M12 15v2"/>',
  layers:'<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5M3 18l9 5 9-5"/>',
  'user-plus':'<circle cx="9" cy="8" r="4"/><path d="M2 21v-3a7 7 0 0 1 12-4M19 13v8m-4-4h8"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>',monitor:'<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  edit:'<path d="m15 4 5 5M4 20l1-6L16 3a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3L10 19l-6 1Z"/>',
  check:'<path d="m5 12 4 4L19 6"/>',users:'<circle cx="9" cy="8" r="3.5"/><path d="M2 21v-3a7 7 0 0 1 14 0v3M16 4a4 4 0 0 1 0 8m3 3a5 5 0 0 1 3 5"/>',
  warning:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',sparkles:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.grid}</svg>`;
const $ = selector => document.querySelector(selector);
function hydrateIcons(root = document) { root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); }); }
applyTranslations();
hydrateIcons();
const DEFAULT_GROUP = 'default';
const GROUP_EXPANDED_KEY = 'codex-deck.groups.expanded';
function groupStorage() { try { return globalThis.localStorage; } catch { return null; } }
function readExpandedGroups() { try { const value = JSON.parse(groupStorage()?.getItem(GROUP_EXPANDED_KEY) || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
function saveExpandedGroups() { try { const storage = groupStorage(); if (!storage) return false; storage.setItem(GROUP_EXPANDED_KEY, JSON.stringify(expandedGroups)); return true; } catch { return false; } }
let expandedGroups = readExpandedGroups();
let state = { accounts: [], groups: [{ id: DEFAULT_GROUP, name: null }], health: {}, pollIntervalMs: 60000 };
let loaded = false, disconnected = false, demo = false, demoAccounts = [], filter = 'all', search = '', sort = 'created';
let editingId = null, formMode = 'add', loginId = null, deletingId = null, signature = '', fetchPending = false, toastTimer;
let desktopAction = null, desktopSubmitting = false, desktopRefreshing = false;
let groupMode = 'add', editingGroupId = null, deletingGroupId = null, draggingAccountId = null;
let organizationPending = false, stateRevision = 0;
const buckets = new Map(), refreshing = new Set(), expirationRefresh = new Map();
const accounts = () => demo ? demoAccounts : state.accounts;
const groups = () => (demo ? [{ id: DEFAULT_GROUP, name: null }] : (state.groups?.length ? state.groups : [{ id: DEFAULT_GROUP, name: null }]));
function groupTitle(group) { return group.id === DEFAULT_GROUP && !group.name ? t('默认分组') : group.name || t('默认分组'); }
function groupFor(account) { return groups().find(group => group.id === (account.groupId || DEFAULT_GROUP)) || groups()[0]; }
function expanded(groupId) { return expandedGroups[groupId] !== false; }
function toggleGroup(groupId) { expandedGroups[groupId] = !expanded(groupId); const saved = saveExpandedGroups(); render(true); if (!saved) toast(t('无法保存分组展开状态；本次切换仍然生效。'), true); }
const desktopJobActive = value => ['queued','stopping','applying','restarting'].includes(value?.job?.status);
function desktopState() {
  return demo ? { supported:true,installed:true,appName:'Codex',running:true,canSwitch:true,canRestore:false,matchedAccountId:demoAccounts[0]?.id,currentAccount:{email:demoAccounts[0]?.email},job:null } : state.desktop;
}
const statusNames = () => ({ ready:t("额度充足"), low:t("额度偏低"), limited:t("额度已用尽"), error:t("连接异常"), disconnected:t("待连接"), connecting:t("等待授权"), stale:t("等待同步"), unknown:t("暂无额度") });
const colors = [['#eeebfb','#a08bca'],['#e9f3fc','#87a9ca'],['#eaf4ee','#8cafa1'],['#fbf0e7','#c3a17f'],['#f2eaf6','#b592bf']];
function getBucket(account) { return (account.rateLimits || []).find(b => b.id === buckets.get(account.id)) || account.rateLimits?.[0]; }
function isAttention(account) { return !['ready','connecting'].includes(accountHealth(account)); }
function ago(value) {
  if (!value) return t("尚未同步");
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return t("尚未同步");
  if (seconds < 60) return t("刚刚同步");
  if (seconds < 3600) return t('{count} 分钟前', { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t('{count} 小时前', { count: Math.floor(seconds / 3600) });
  return t('{count} 天前', { count: Math.floor(seconds / 86400) });
}
function toast(message, error = false) {
  const el = $('#toast'); clearTimeout(toastTimer); el.textContent = localizeMessage(message); el.classList.toggle('error', error); el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3500);
}
async function api(url, method = 'GET', body = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === 'GET' ? 12000 : 65000);
  try {
    const response = await fetch(url, { method, headers: method === 'GET' ? {} : { 'Content-Type':'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body), signal: controller.signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || t("操作未完成，请重试。"));
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(t("请求超时，请稍后刷新页面查看结果。"));
    if (error instanceof TypeError) throw new Error(t("无法连接本地服务，请确认项目正在运行。"));
    throw error;
  } finally { clearTimeout(timer); }
}
async function loadState() {
  if (fetchPending || organizationPending) return;
  fetchPending = true;
  const revision = stateRevision;
  try {
    const next = await api('/api/state');
    if (revision !== stateRevision) return;
    state = next;
    loaded = true; disconnected = false;
    const banner = $('#connection-banner');
    if (state.health.codexAvailable === false) { banner.hidden = false; feedback(banner, '未检测到 Codex CLI。请先安装 Codex CLI，再重新启动本项目；也可设置 CODEX_BIN 指定已有程序的路径。'); }
    else { banner.hidden = true; }
    render(); updateLogin();
  } catch (error) {
    if (revision !== stateRevision) return;
    disconnected = true;
    $('#connection-banner').hidden = false;
    feedback($('#connection-banner'), error.message);
    if (!loaded) $('#account-content').innerHTML = `<div class="no-results">${t("本地服务暂时不可用")}<br>${t("启动项目后，页面会自动重新连接。")}</div>`;
    else render(true);
    $('#sync-label').textContent = t("连接已断开 · 显示上次数据");
  } finally { fetchPending = false; }
}
function summary() {
  const list = accounts();
  const ready = list.filter(a => ['ready','low'].includes(accountHealth(a))).length;
  const attention = list.filter(isAttention).length;
  const next = nearestResets(list)[0];
  const nextValue = next ? countdown(next.window.resetsAt).replace(/:\d{2}$/, '') : '—';
  $('#stats').innerHTML = [
    [t("管理账号"),list.length,t("个"),'users',t("全部账号集中管理")],
    [t("当前可用"),ready,t("个"),'check',`<span class="positive">${ready ? '●' : '○'}</span> ${ready ? t("额度已同步，可以继续工作") : t("连接后自动获取额度")}`],
    [t("需要关注"),attention,t("个"),'warning',attention ? t("额度不足或连接需要检查") : t("暂无需要处理的账号")],
    [t("最近重置"),`<span id="next-reset-value">${nextValue}</span>`,'','clock',next ? `${esc(next.account.name)} · ${esc(windowLabel(next.window,''))}` : t("连接账号后显示倒计时")]
  ].map(([label,value,unit,i,note]) => `<div class="stat-card"><div class="stat-top"><span>${label}</span><span>${icon(i)}</span></div><div class="stat-number">${value}<small>${unit}</small></div><div class="stat-note">${note}</div></div>`).join('');
  for (const id of ['#nav-count','#account-count','#filter-total']) $(id).textContent = String(list.length);
  $('#attention-dot').hidden = !attention;
}
function quotaMarkup(window, fallback) {
  if (!window) return `<div class="quota-window-label">${esc(fallback)}</div><div class="missing-quota">—</div><span>${t("暂无数据")}</span>`;
  const value = remaining(window), expired = isExpired(window);
  const level = expired ? 'stale' : value === 0 ? 'limited' : value !== null && value <= 20 ? 'low' : '';
  const caption = windowLabel(window, fallback);
  return `<div class="quota ${level}"><div class="quota-window-label">${esc(caption)}</div><div class="quota-top"><div class="quota-value">${value === null ? '—' : `${Number(value.toFixed(1))}<small>%</small>`}</div><span class="quota-caption">${caption === fallback ? t("剩余") : esc(caption)}</span></div><div class="progress-track" role="meter" aria-label="${esc(t('{period}剩余', { period: caption }))}" ${value === null ? '' : `aria-valuenow="${value}" aria-valuemin="0" aria-valuemax="100"`}><div class="progress-fill" style="width:${value ?? 0}%"></div></div><div class="reset-countdown">${icon('clock')}<span ${Number.isFinite(window.resetsAt) ? `data-reset="${window.resetsAt}"` : ''}>${countdown(window.resetsAt)}</span></div><div class="reset-time">${Number.isFinite(window.resetsAt) ? t('{time} 重置', { time: formatReset(window.resetsAt) }) : t("重置时间未知")}</div></div>`;
}
function renderDesktop() {
  const desktop = desktopState();
  if (!desktop) {
    $('#desktop-panel').innerHTML = `<div class="desktop-symbol">${icon('monitor')}</div><div class="desktop-details"><h2 id="desktop-title">${t("桌面客户端")}</h2><p>${loaded ? t("正在准备客户端状态，请稍候…") : t("正在检测本机登录状态…")}</p></div>`;
    return;
  }
  const busy = desktopJobActive(desktop) || desktopSubmitting;
  const current = desktop.currentAccount;
  const identity = current?.email || (current ? t("已保存登录，邮箱未知") : t("尚未检测到登录账号"));
  const appLabel = desktop.appName || 'Codex';
  const appStatus = !desktop.supported ? t("当前系统不支持") : !desktop.installed ? t("未检测到客户端") : desktop.running ? t("运行中") : t("未运行");
  const job = desktop.job;
  const jobText = message(job?.message) || (busy ? t("正在切换桌面端账号…") : '');
  const blockedReason = !demo && disconnected ? t("本地服务已断开，连接恢复后可切换账号。") : message(desktop.reason);
  $('#desktop-panel').innerHTML = `<div class="desktop-symbol">${icon('monitor')}</div><div class="desktop-details"><div class="desktop-heading"><h2 id="desktop-title">${t("桌面客户端")}</h2><span class="desktop-app-status">${esc(appLabel)}${desktop.appVersion ? ` ${esc(desktop.appVersion)}` : ''} · ${appStatus}${demo ? t(" · 演示") : ''}</span></div><p class="desktop-identity">${t("已保存登录")} <strong title="${esc(identity)}">${esc(identity)}</strong></p><p class="desktop-note">${t("按本机保存的登录信息识别；切换账号会重启客户端。")}</p>${blockedReason ? `<p class="desktop-reason">${esc(blockedReason)}</p>` : ''}${jobText ? `<div class="desktop-job ${job?.status === 'failed' ? 'failed' : job?.status === 'completed' ? 'completed' : ''}" role="status">${busy ? '<span class="spinner"></span>' : icon(job?.status === 'failed' ? 'warning' : 'check')}<span>${esc(jobText)}</span></div>` : ''}</div><div class="desktop-actions"><button class="button secondary desktop-refresh ${desktopRefreshing ? 'spinning' : ''}" data-desktop-action="refresh" ${desktopRefreshing || busy ? 'disabled' : ''}>${icon('refresh')}${t("检测状态")}</button>${desktop.canRestore ? `<button class="text-button desktop-restore" data-desktop-action="restore" ${busy || disconnected || !desktop.canSwitch ? 'disabled' : ''}>${t("恢复上次登录")}</button>` : ''}</div>`;
}
function duplicateMarkup(account) {
  const existing = accounts().find(item => item.id === account.duplicateOf);
  if (!existing) return '';
  const label = existing.name === existing.email || !existing.email ? existing.name : `${existing.name} (${existing.email})`;
  return `<div class="duplicate-details"><span>${esc(t('已存在记录：{name}', { name: label }))}</span><button class="text-button" data-action="show-existing" data-id="${esc(existing.id)}">${t('查看已有账号')}</button><span>${t('若要连接其他账号，请在官方授权页确认登录邮箱。')}</span></div>`;
}
function showExistingAccount(id) {
  const account = accounts().find(item => item.id === id);
  if (account) { expandedGroups[groupFor(account).id] = true; saveExpandedGroups(); }
  filter = 'all'; search = ''; $('#search').value = ''; render(true);
  const row = [...document.querySelectorAll('[data-account-row]')].find(element => element.dataset.accountRow === id);
  row?.focus({ preventScroll: true });
  row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function groupOptions(account) {
  return groups().map(group => `<option value="${esc(group.id)}" ${groupFor(account).id === group.id ? 'selected' : ''}>${esc(groupTitle(group))}</option>`).join('');
}
function rowMarkup(account, index) {
  const bucket = getBucket(account), [short,week] = windowPair(bucket), health = accountHealth(account), [bg,fg] = colors[index % colors.length];
  const desktop = desktopState();
  const isCurrent = desktop?.matchedAccountId === account.id;
  const switchDisabled = isCurrent || !desktop?.canSwitch || desktopJobActive(desktop) || desktopSubmitting || (!demo && disconnected);
  const switchTitle = isCurrent ? t("本机已保存此账号的登录信息") : !desktop?.canSwitch ? message(desktop?.reason) || t("桌面客户端暂时不可切换") : t("切换账号并重新启动桌面客户端");
  const switchButton = account.status === 'connected' ? `<div class="account-switch"><button class="switch-account" data-action="activate" data-id="${esc(account.id)}" title="${esc(switchTitle)}" ${switchDisabled ? 'disabled' : ''}>${icon(isCurrent ? 'check' : 'monitor')}${isCurrent ? t("当前账号") : t("切换到桌面端")}</button></div>` : '';
  const selected = account.rateLimits?.length > 1 ? `<select class="bucket-select" data-account="${esc(account.id)}" aria-label="${esc(t('选择 {name} 的额度类型', { name: account.name }))}">${account.rateLimits.map(b => `<option value="${esc(b.id)}" ${b.id === bucket.id ? 'selected' : ''}>${esc(b.name || b.id)}</option>`).join('')}</select>` : '';
  const action = (act,i,label,cls='') => `<button class="icon-button ${cls}" data-action="${act}" data-id="${esc(account.id)}" title="${label}" aria-label="${label} ${esc(account.name)}" ${refreshing.has(account.id) && act === 'refresh' ? 'disabled' : ''}>${icon(i)}</button>`;
  return `<tr data-account-row="${esc(account.id)}" data-group-id="${esc(groupFor(account).id)}" draggable="${!demo && !organizationPending && !disconnected && sort === 'created'}" tabindex="-1"><td><div class="identity"><button class="drag-handle" data-id="${esc(account.id)}" title="${t('拖动排序，或按 Alt+↑／↓ 调整顺序')}" aria-label="${esc(t('调整 {name} 的顺序', { name: account.name }))}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown">${icon('grip')}</button><span class="avatar" style="background:${bg};color:${fg}">${esc(Array.from(account.name)[0]?.toUpperCase() || 'C')}</span><div class="identity-main"><div class="account-name" title="${esc(account.name)}">${esc(account.name)}</div><div class="account-email" title="${esc(account.email || '')}">${esc(account.email || (health === 'connecting' ? t("正在等待官方授权…") : t("连接后显示账号邮箱")))}</div><span class="plan-badge ${account.planType === 'pro' ? 'pro' : ''}">${esc(account.planType ? account.planType.toUpperCase() : t("未连接"))}</span>${isCurrent ? `<span class="desktop-current-badge" title="${t("根据本机保存的登录信息识别")}">${t("桌面端当前账号")}</span>` : ''}${selected}</div></div></td><td>${quotaMarkup(short,t("5 小时额度"))}</td><td>${quotaMarkup(week,t("每周额度"))}</td><td><span class="status-pill ${health}"><span class="status-dot"></span>${account.duplicateOf ? t("重复账号") : statusNames()[health]}</span><div class="last-updated" data-updated="${esc(account.lastUpdatedAt || '')}">${ago(account.lastUpdatedAt)}</div>${account.error ? `<div class="error-text">${esc(message(account.error))}${duplicateMarkup(account)}</div>` : ''}</td><td><div class="row-actions">${action('refresh','refresh',t("刷新额度"),refreshing.has(account.id) ? 'spinning' : '')}${action('edit','edit',t("重命名"))}${action('delete','trash',t("移除账号"),'delete')}</div><label class="account-group-picker"><span>${t('分组')}</span><select data-action="move-group" data-id="${esc(account.id)}" aria-label="${esc(t('{name} 的分组', { name: account.name }))}">${groupOptions(account)}</select></label>${switchButton}<div class="account-connect"><button data-action="connect" data-id="${esc(account.id)}">${health === 'connecting' ? t("继续授权") : health === 'disconnected' || health === 'error' ? t("连接账号") : t("重新连接")}</button></div></td></tr>`;
}
function accountTableMarkup(items) {
  return `<table class="account-table"><thead><tr><th>${t("账号 / 订阅")}</th><th>${t("5 小时额度")} <span class="subtle">${t("/ 剩余")}</span></th><th>${t("每周额度")} <span class="subtle">${t("/ 剩余")}</span></th><th>${t("账号状态")}</th><th>${t("管理")}</th></tr></thead><tbody>${items.map(rowMarkup).join('')}</tbody></table>`;
}
function groupMarkup(group, items, total) {
  const isOpen = expanded(group.id);
  const deletable = group.id !== DEFAULT_GROUP;
  return `<section class="account-group ${isOpen ? 'is-open' : 'is-closed'}" data-group="${esc(group.id)}"><header class="group-header" data-group-body="${esc(group.id)}"><button class="group-toggle" data-action="toggle-group" data-id="${esc(group.id)}" aria-expanded="${isOpen}" aria-controls="group-body-${esc(group.id)}"><span class="group-chevron">⌄</span><strong>${esc(groupTitle(group))}</strong><span class="count-badge">${total}</span></button><div class="group-actions"><button class="icon-button" data-action="rename-group" data-id="${esc(group.id)}" title="${t('重命名分组')}" aria-label="${t('重命名分组')} ${esc(groupTitle(group))}">${icon('edit')}</button>${deletable ? `<button class="icon-button delete" data-action="delete-group" data-id="${esc(group.id)}" title="${t('删除分组')}" aria-label="${t('删除分组')} ${esc(groupTitle(group))}">${icon('trash')}</button>` : ''}</div></header><div class="group-body" id="group-body-${esc(group.id)}" data-group-body="${esc(group.id)}" ${isOpen ? '' : 'hidden'}>${items.length ? accountTableMarkup(items) : `<div class="group-empty" data-group-id="${esc(group.id)}">${total ? t('没有符合条件的账号') : t('将账号拖到这里')}</div>`}</div></section>`;
}
function render(force = false) {
  if (draggingAccountId) return;
  const list = accounts();
  const key = JSON.stringify([getLanguage(),list,groups(),expandedGroups,organizationPending,filter,search,sort,[...buckets],[...refreshing],demo,list.map(a=>accountHealth(a)),state.desktop,desktopSubmitting,desktopRefreshing,disconnected,loaded]);
  if (!force && signature === key) return;
  signature = key; summary(); renderDesktop();
  $('#demo-banner').hidden = !demo;
  $('#demo-button').hidden = demo;
  $('#add-group').disabled = demo || organizationPending || disconnected || !loaded;
  $('#sync-label').innerHTML = demo ? `<span class="status-dot green"></span>${t("示例数据 · 仅供预览")}` : disconnected ? t("连接已断开 · 显示上次数据") : `<span class="status-dot green"></span>${t('每{seconds}秒自动同步额度', { seconds: Math.round((state.pollIntervalMs || 60000)/1000) })}`;
  document.querySelectorAll('[data-filter]').forEach(el => el.classList.toggle('active',el.dataset.filter === filter));
  let visible = list.filter(a => (!search || `${a.name} ${a.email || ''}`.toLowerCase().includes(search)) && (filter === 'all' || filter === 'ready' && ['ready','low'].includes(accountHealth(a)) || filter === 'attention' && isAttention(a)));
  if (sort === 'name') visible.sort((a,b) => a.name.localeCompare(b.name,getLanguage()));
  if (sort === 'quota') visible.sort((a,b) => (remaining(windowPair(getBucket(b))[0]) ?? -1) - (remaining(windowPair(getBucket(a))[0]) ?? -1));
  if (sort === 'reset') visible.sort((a,b) => (nearestResets([a])[0]?.window.resetsAt ?? Infinity) - (nearestResets([b])[0]?.window.resetsAt ?? Infinity));
  if (!loaded && !demo) {
    $('#account-content').innerHTML = disconnected
      ? `<div class="no-results">${t("本地服务暂时不可用")}<br>${t("启动项目后，页面会自动重新连接。")}</div>`
      : `<div class="loading-state">${t("正在连接本地服务…")}</div>`;
  } else if (!list.length) {
    $('#account-content').innerHTML = `<div class="empty-state"><div class="empty-art" aria-hidden="true"><div class="mini-card"></div><div class="mini-card front"><div class="mini-avatar"></div><div class="mini-lines"><i></i><i></i></div></div><span>+</span></div><h3>${t("从你的第一个账号开始")}</h3><p>${t("连接 Codex 账号，实时查看 5 小时与每周额度。")}<br>${t("所有账号、所有重置时间，在这里一览。")}</p><div class="empty-actions"><button class="button primary" data-action="add">${icon('plus')}${t("添加第一个账号")}</button><button class="button secondary" data-action="demo">${t("先看一下演示")} ${icon('arrow')}</button></div></div>`;
  } else if (!visible.length) {
    $('#account-content').innerHTML = `<div class="no-results">${t("没有符合条件的账号")}<br><button class="text-button" data-action="clear-filter">${t("清除筛选条件")}</button></div>`;
  } else $('#account-content').innerHTML = '';
  if (loaded || demo) {
    const groupsForView = groups().map(group => ({ group, items: visible.filter(account => groupFor(account).id === group.id), total: list.filter(account => groupFor(account).id === group.id).length }));
    $('#account-content').insertAdjacentHTML('beforeend', `<div class="group-list">${groupsForView.map(({ group, items, total }) => groupMarkup(group, items, total)).join('')}</div>`);
    $('#account-content').querySelectorAll('[data-action="move-group"], [data-action="rename-group"], [data-action="delete-group"], .drag-handle, [data-action="move-up"], [data-action="move-down"]').forEach(element => { element.disabled = demo || organizationPending || disconnected || (element.matches('.drag-handle') && sort !== 'created'); });
  }
  const resets = nearestResets(list).slice(0,3);
  $('#timeline').innerHTML = resets.length ? resets.map(({account,bucket,window}) => `<div class="timeline-entry"><span class="timeline-marker"></span><div class="timeline-info"><div class="timeline-name"><strong>${esc(account.name)}</strong><span>${esc(windowLabel(window,''))}${account.rateLimits.length > 1 ? ` · ${esc(bucket.name)}` : ''}</span></div><div class="timeline-time">${t('{time} 重置', { time: formatReset(window.resetsAt) })}</div></div><span class="timeline-countdown" data-reset="${window.resetsAt}">${countdown(window.resetsAt)}</span></div>`).join('') : `<div class="timeline-empty">${icon('clock')}<span>${list.length ? t("暂时没有待重置的额度窗口") : t("连接账号后，自动排列最近的重置时间")}</span></div>`;
}
function showModal(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function openDesktopAction(kind, account = null) {
  const desktop = desktopState();
  if (desktopSubmitting || desktopJobActive(desktop)) return toast(t("正在切换账号，请等待客户端重新启动。"));
  if (!demo && (disconnected || !desktop?.canSwitch)) return toast(message(desktop?.reason) || t("桌面客户端暂时不可切换，请检测状态后重试。"),true);
  if (kind === 'restore' && !desktop?.canRestore) return toast(t("暂时没有可恢复的登录备份。"));
  desktopAction = {kind,id:account?.id,preview:demo};
  renderSwitchDialog();
  $('#switch-form-error').hidden = true;
  $('#confirm-switch').disabled = false;
  showModal('#switch-dialog');
}
function renderSwitchDialog() {
  if (!desktopAction) return;
  const { kind, id } = desktopAction;
  const account = accounts().find(item => item.id === id);
  if (kind !== 'restore' && !account) return;
  $('#switch-dialog-title').textContent = kind === 'restore' ? t("恢复上次桌面端登录") : t("切换桌面端账号");
  $('#switch-description').textContent = kind === 'restore' ? t("将恢复最近一次切换前备份的桌面端登录信息。") : t('将桌面端切换为「{name}」{email}。', { name: account.name, email: account.email ? ` (${account.email})` : '' });
  $('#switch-details').textContent = kind === 'restore' ? t("恢复也会更新默认 Codex CLI／扩展共用的登录信息。完成后请确认客户端显示的账号。") : t("这会更新桌面端和默认 Codex CLI／扩展共用的登录信息。原登录会先在本机备份，可从本页面恢复。");
  $('#switch-demo-note').hidden = !demo;
  $('#confirm-switch').textContent = demo ? t("知道了，仅预览") : kind === 'restore' ? t("确认恢复并重启") : t("确认切换并重启");
}
$('#confirm-switch').addEventListener('click',async event => {
  if (!desktopAction || desktopSubmitting) return;
  if (demo || desktopAction.preview) { $('#switch-dialog').close(); return toast(t("演示模式不会更改桌面端登录或重启客户端。")); }
  if (desktopJobActive(state.desktop)) { $('#switch-dialog').close(); return toast(t("已有切换操作正在进行。")); }
  const action = desktopAction;
  const button = event.currentTarget; button.disabled = true; desktopSubmitting = true;
  $('#switch-form-error').hidden = true; render();
  try {
    const url = action.kind === 'restore' ? '/api/desktop/restore' : `/api/accounts/${encodeURIComponent(action.id)}/activate`;
    const result = await api(url,'POST',{confirmRestart:true});
    state.desktop = result.desktop;
    $('#switch-dialog').close();
    toast(t("操作已提交，客户端将重启。重新打开本页面可查看结果。"));
  } catch(error) {
    feedback($('#switch-form-error'), error.message); $('#switch-form-error').hidden = false;
  } finally { desktopSubmitting = false; button.disabled = false; render(true); void loadState(); }
});
$('#desktop-panel').addEventListener('click',async event => {
  const button = event.target.closest('[data-desktop-action]'); if (!button || button.disabled) return;
  if (button.dataset.desktopAction === 'restore') return openDesktopAction('restore');
  if (demo) return toast(t("演示模式显示示例客户端状态。"));
  if (desktopRefreshing) return;
  desktopRefreshing = true; render();
  try { const result = await api('/api/desktop'); state.desktop = result.desktop; toast(t("桌面客户端状态已更新")); }
  catch(error) { toast(error.message,true); }
  finally { desktopRefreshing = false; render(true); }
});
function openAccount(mode='add', account=null) {
  if (demo && mode !== 'add') return toast(t("演示模式仅供查看。返回我的账号后即可管理。"));
  if (demo) exitDemo();
  formMode = mode; editingId = account?.id || null;
  $('#account-form').reset(); $('#account-form-error').hidden = true;
  $('#account-name').value = account?.name || ''; $('#account-name').disabled = mode === 'connect';
  $('#login-methods').hidden = mode === 'edit';
  renderAccountForm();
  showModal('#account-dialog');
}
function renderAccountForm() {
  const mode = formMode;
  $('#account-dialog-title').textContent = mode === 'edit' ? t("给账号换个名字") : mode === 'connect' ? t("连接 Codex 账号") : t("连接一个 Codex 账号");
  $('#account-dialog-description').textContent = mode === 'edit' ? t("用一个好记的名称，区分你的工作账号。") : t("为账号起一个好记的名字，然后通过官方页面登录。");
  $('#account-submit').innerHTML = mode === 'edit' ? t("保存名称") : `${mode === 'connect' ? t("开始登录") : t("添加并登录")} ${icon('arrow')}`;
}
$('#account-name').maxLength = 60;
$('#account-form').addEventListener('submit',async event => {
  event.preventDefault();
  const name = $('#account-name').value.trim();
  const method = new FormData(event.currentTarget).get('method') || 'browser';
  const button = $('#account-submit'); button.disabled = true; $('#account-form-error').hidden = true;
  let created = false;
  try {
    if (formMode === 'edit') {
      await api(`/api/accounts/${editingId}`,'PATCH',{name}); $('#account-dialog').close(); toast(t("账号名称已更新"));
    } else {
      let id = editingId;
      if (formMode === 'add') { const result = await api('/api/accounts','POST',{name}); id = result.account.id; created = true; }
      const result = await api(`/api/accounts/${id}/login`,'POST',{method});
      $('#account-dialog').close();
      const existingIndex = state.accounts.findIndex(a => a.id === id);
      if (existingIndex >= 0) state.accounts[existingIndex] = result.account; else state.accounts.push(result.account);
      openLogin(id);
    }
    await loadState();
  } catch (error) {
    if (created) { $('#account-dialog').close(); toast(t('账号已添加。{error}', { error: message(error.message) }),true); await loadState(); }
    else { feedback($('#account-form-error'), error.message); $('#account-form-error').hidden = false; }
  } finally { button.disabled = false; }
});
function safeLoginUrl(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && ['auth.openai.com','auth0.openai.com','login.openai.com','chatgpt.com'].includes(url.hostname)) return url.href; } catch {}
  return null;
}
function openLogin(id) { loginId = id; updateLogin(true); showModal('#login-dialog'); }
let loginSignature = '';
function updateLogin(force = false) {
  if (!loginId) return;
  const account = state.accounts.find(a => a.id === loginId);
  if (!account) { $('#login-dialog').close(); loginId = null; return; }
  const key = JSON.stringify([getLanguage(),account.name,account.status,account.login,account.error,account.duplicateOf,state.accounts.find(item => item.id === account.duplicateOf)?.name]);
  if (!force && key === loginSignature) return; loginSignature = key;
  const login = account.login;
  const url = safeLoginUrl(login?.authUrl || login?.verificationUrl);
  $('#login-content').innerHTML = account.status === 'connecting' ? `<h2>${t("完成官方登录")}</h2><p class="login-hint">${t('正在连接「{name}」。在官方授权页登录你要添加的账号，完成后此处自动更新。', { name: esc(account.name) })}</p>${login?.userCode ? `<div class="login-code">${esc(login.userCode)}</div><p class="login-hint">${t("在官方页面输入上方设备验证码。若不可用，请在 ChatGPT 安全设置中开启 Codex 设备码登录，或切换浏览器登录。")}</p>` : ''}<div class="login-status"><span class="spinner"></span>${t("等待账号授权…")}</div>${url ? `<a class="button primary login-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${t("打开官方授权页")} ${icon('external')}</a>` : `<p class="login-hint">${t("正在准备登录链接…")}</p>`}<p class="login-hint">${t("添加其他账号时，先确认官方页面选择的账号正确。可以使用无痕窗口登录。关闭此窗口后仍可在账号行继续授权。")}</p><div class="modal-actions"><button class="button secondary" id="cancel-login">${t("取消本次登录")}</button><button class="button secondary" id="hide-login">${t("稍后继续")}</button></div>` : account.status === 'connected' ? `<h2>${t("账号已连接")}</h2><div class="login-status">${icon('check')}${t('已连接 {name}', { name: esc(account.email || account.name) })}</div><p class="login-hint">${t("额度已经同步，接下来每分钟自动更新。")}</p><div class="modal-actions"><button class="button primary" id="hide-login">${t("查看账号")}</button></div>` : `<h2>${t("登录未完成")}</h2><p class="login-hint">${esc(message(account.error) || t("请重新发起登录。"))}</p>${duplicateMarkup(account)}<div class="modal-actions"><button class="button secondary" id="hide-login">${t("关闭")}</button><button class="button primary" id="retry-login">${t("重新登录")}</button></div>`;
  $('#hide-login')?.addEventListener('click',()=>$('#login-dialog').close());
  $('#login-content [data-action="show-existing"]')?.addEventListener('click', event => {
    $('#login-dialog').close(); showExistingAccount(event.currentTarget.dataset.id);
  });
  $('#retry-login')?.addEventListener('click',()=>{ $('#login-dialog').close(); openAccount('connect',account); });
  $('#cancel-login')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await api(`/api/accounts/${account.id}/cancel-login`,'POST'); $('#login-dialog').close(); await loadState(); toast(t("已取消登录")); }
    catch(error) { toast(error.message,true); event.target.disabled = false; }
  });
}
async function refreshAccount(id, silent=false) {
  if (demo) return toast(t("这是演示数据。连接真实账号后即可刷新额度。"));
  if (refreshing.has(id)) return;
  refreshing.add(id); render();
  try { const result = await api(`/api/accounts/${id}/refresh`,'POST'); if (!silent) toast(result.account.error || (result.account.status === 'disconnected' ? t("请先连接账号") : t("额度已更新")),Boolean(result.account.error)); }
  catch(error) { if (!silent) toast(error.message,true); }
  finally { refreshing.delete(id); await loadState(); render(true); }
}
$('#refresh-all').addEventListener('click',async event => {
  if (demo) return toast(t("演示数据无需同步。返回我的账号后可刷新真实额度。"));
  const button = event.currentTarget; button.disabled = true; button.classList.add('spinning');
  try {
    state = await api('/api/refresh','POST'); render(true);
    const errors = state.accounts.filter(a=>a.error).length;
    toast(state.accounts.length ? errors ? t('{count} 个账号同步失败，请查看账号状态', { count: errors }) : t("所有账号已同步") : t("先添加一个账号开始使用"),Boolean(errors));
  } catch(error) { toast(error.message,true); }
  finally { button.disabled = false; button.classList.remove('spinning'); await loadState(); }
});
$('#account-content').addEventListener('click',event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const {action,id} = button.dataset;
  if (action === 'add') return openAccount();
  if (action === 'demo') return startDemo();
  if (action === 'clear-filter') { filter = 'all'; search = ''; $('#search').value = ''; return render(true); }
  if (action === 'toggle-group') return toggleGroup(id);
  if (action === 'rename-group') return openGroup('edit', id);
  if (action === 'delete-group') {
    const group = groups().find(item => item.id === id); if (!group || id === DEFAULT_GROUP) return;
    deletingGroupId = id; $('#group-delete-description').textContent = t('删除「{name}」？组内账号会移回默认分组。', { name: groupTitle(group) }); showModal('#group-delete-dialog'); return;
  }
  const account = accounts().find(a=>a.id===id); if (!account) return;
  if (action === 'show-existing') return showExistingAccount(id);
  if (action === 'activate') return openDesktopAction('activate',account);
  if (demo) return toast(t("演示模式仅供查看。返回我的账号后即可管理。"));
  if (action === 'refresh') return refreshAccount(id);
  if (action === 'edit') return openAccount('edit',account);
  if (action === 'connect') return account.status === 'connecting' ? openLogin(id) : openAccount('connect',account);
  if (action === 'delete') {
    deletingId = id; $('#delete-description').textContent = t('你将从管理面板移除「{name}」。', { name: account.name });
    showModal('#delete-dialog');
  }
});
async function moveAccount(id, groupId, beforeId = null) {
  if (demo) return toast(t('演示模式仅供查看。返回我的账号后即可管理。'), true);
  try { await organize(`/api/accounts/${encodeURIComponent(id)}/move`, 'POST', { groupId, beforeId }); toast(t('账号分组和顺序已更新')); }
  catch (error) { render(true); toast(error.message, true); }
}
async function organize(url, method, body = {}) {
  if (organizationPending) throw new Error(t('正在保存，请稍候。'));
  organizationPending = true; stateRevision++; render(true);
  try {
    const next = await api(url, method, body);
    state = { ...state, ...next }; stateRevision++;
    loaded = true; disconnected = false;
  } finally { organizationPending = false; render(true); updateLogin(true); }
}
$('#account-content').addEventListener('change',event => {
  if (event.target.matches('.bucket-select')) { buckets.set(event.target.dataset.account,event.target.value); render(true); }
  if (event.target.matches('[data-action="move-group"]')) void moveAccount(event.target.dataset.id, event.target.value);
});
$('#account-content').addEventListener('dragstart', event => {
  const row = event.target.closest('[data-account-row]');
  if (!row || demo || organizationPending || disconnected || sort !== 'created' || (event.target.closest('button,select,input,a') && !event.target.closest('.drag-handle'))) { event.preventDefault(); return; }
  draggingAccountId = row.dataset.accountRow; row.classList.add('dragging');
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggingAccountId);
});
$('#account-content').addEventListener('dragover', event => {
  const target = event.target.closest('[data-account-row], [data-group-body]');
  if (!target || !draggingAccountId || demo) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-over').forEach(element => element.classList.remove('drag-over'));
  target.classList.add('drag-over');
});
$('#account-content').addEventListener('dragleave', event => { event.target.closest('[data-account-row], [data-group-body]')?.classList.remove('drag-over'); });
$('#account-content').addEventListener('drop', event => {
  const target = event.target.closest('[data-account-row], [data-group-body]');
  if (!target || !draggingAccountId || demo) return;
  event.preventDefault();
  const targetRow = target.matches('[data-account-row]') ? target : null;
  const groupId = targetRow?.dataset.groupId || target.dataset.groupBody;
  const id = draggingAccountId;
  if (targetRow?.dataset.accountRow === id) { endDrag(); return; }
  let beforeId = targetRow?.dataset.accountRow || null;
  if (targetRow && event.clientY > targetRow.getBoundingClientRect().top + targetRow.getBoundingClientRect().height / 2) {
    const siblings = accounts().filter(account => groupFor(account).id === groupId && account.id !== id);
    const index = siblings.findIndex(account => account.id === beforeId);
    beforeId = siblings[index + 1]?.id || null;
  }
  document.querySelectorAll('.drag-over,.dragging').forEach(element => element.classList.remove('drag-over','dragging'));
  draggingAccountId = null; void moveAccount(id, groupId, beforeId);
});
function endDrag() { draggingAccountId = null; document.querySelectorAll('.drag-over,.dragging').forEach(element => element.classList.remove('drag-over','dragging')); render(true); }
$('#account-content').addEventListener('dragend', endDrag);
$('#account-content').addEventListener('keydown', async event => {
  if (!event.target.matches('.drag-handle') || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || sort !== 'created' || organizationPending) return;
  event.preventDefault();
  const id = event.target.dataset.id, account = accounts().find(item => item.id === id); if (!account) return;
  const groupId = groupFor(account).id, siblings = accounts().filter(item => groupFor(item).id === groupId);
  const index = siblings.findIndex(item => item.id === id);
  if ((event.key === 'ArrowUp' && index === 0) || (event.key === 'ArrowDown' && index === siblings.length - 1)) return;
  await moveAccount(id, groupId, event.key === 'ArrowUp' ? siblings[index - 1].id : siblings[index + 2]?.id || null);
  [...document.querySelectorAll('.drag-handle')].find(item => item.dataset.id === id)?.focus();
});
$('#confirm-delete').addEventListener('click',async event => {
  const button = event.currentTarget; button.disabled = true;
  try { await api(`/api/accounts/${deletingId}`,'DELETE'); $('#delete-dialog').close(); toast(t("账号及本地登录记录已移除")); await loadState(); }
  catch(error) { toast(error.message,true); }
  finally { button.disabled = false; }
});
function openGroup(mode = 'add', groupId = null) {
  if (demo || organizationPending) return;
  groupMode = mode; editingGroupId = groupId; $('#group-form').reset(); $('#group-form-error').hidden = true;
  const group = groups().find(item => item.id === groupId);
  $('#group-name').value = mode === 'edit' && group ? groupTitle(group) : '';
  renderGroupForm();
  showModal('#group-dialog');
}
function renderGroupForm() {
  $('#group-dialog-title').textContent = groupMode === 'edit' ? t('重命名分组') : t('新建分组');
  $('#group-dialog-description').textContent = groupMode === 'edit' ? t('修改这个分组的名称，组内账号不会改变。') : t('给一组账号起一个便于识别的名称。');
  $('#group-submit').textContent = groupMode === 'edit' ? t('保存分组名称') : t('创建分组');
}
$('#add-group').addEventListener('click', () => openGroup());
$('#group-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#group-submit'); button.disabled = true; $('#group-form-error').hidden = true;
  try {
    const name = $('#group-name').value.trim();
    if (groupMode === 'edit') await organize(`/api/groups/${encodeURIComponent(editingGroupId)}`, 'PATCH', { name });
    else await organize('/api/groups', 'POST', { name });
    $('#group-dialog').close(); toast(t('分组已更新'));
  } catch (error) { feedback($('#group-form-error'), error.message); $('#group-form-error').hidden = false; }
  finally { button.disabled = false; }
});
$('#confirm-group-delete').addEventListener('click', async event => {
  if (!deletingGroupId) return; const button = event.currentTarget; button.disabled = true;
  try { await organize(`/api/groups/${encodeURIComponent(deletingGroupId)}`, 'DELETE'); delete expandedGroups[deletingGroupId]; saveExpandedGroups(); $('#group-delete-dialog').close(); deletingGroupId = null; toast(t('分组已删除，账号已移回默认分组')); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
const demoNameKeys = ['主力开发账号', '工作账号', '备用账号', '实验室账号'];
function makeDemoAccounts() {
  const now = Math.floor(Date.now()/1000);
  return [
    [t("主力开发账号"),'developer@example.com','pro',18,38,7620,182400],
    [t("工作账号"),'work@example.com','plus',57,24,12180,356400],
    [t("备用账号"),'backup@example.com','plus',94,82,3120,102000],
    [t("实验室账号"),'lab@example.com','pro',100,51,11100,478800]
  ].map(([name,email,planType,used,weekly,fiveReset,weekReset],i)=>({id:`demo-${i}`,name,email,planType,status:'connected',error:null,lastUpdatedAt:new Date().toISOString(),createdAt:new Date().toISOString(),rateLimits:[{id:'codex',name:'Codex',primary:{usedPercent:used,windowDurationMins:300,resetsAt:now+fiveReset},secondary:{usedPercent:weekly,windowDurationMins:10080,resetsAt:now+weekReset}}]}));
}
function startDemo() { demoAccounts = makeDemoAccounts(); demo = true; filter = 'all'; search = ''; $('#search').value = ''; render(true); }
function exitDemo() { demo = false; filter = 'all'; search = ''; $('#search').value = ''; render(true); }
$('#demo-button').addEventListener('click',startDemo); $('#exit-demo').addEventListener('click',exitDemo);
$('#add-account').addEventListener('click',()=>openAccount());
$('#search').addEventListener('input',event=>{search=event.target.value.trim().toLowerCase();render();});
$('#sort').addEventListener('change',event=>{sort=event.target.value;render();});
$('.tabs').addEventListener('click',event=>{const button=event.target.closest('[data-filter]');if(button){filter=button.dataset.filter;render();}});
$('#help-button').addEventListener('click',()=>showModal('#help-dialog'));
$('#timeline-nav').addEventListener('click',()=>{$('#timeline-panel').scrollIntoView({behavior:'smooth',block:'center'});$('#timeline-panel').focus({preventScroll:true});});
$('#overview-nav').addEventListener('click',()=>{filter='all';search='';$('#search').value='';render();window.scrollTo({top:0,behavior:'smooth'});});
document.querySelectorAll('.close-dialog').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}}));
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&!document.querySelector('dialog[open]')){event.preventDefault();$('#search').focus();}});
setInterval(()=>{
  document.querySelectorAll('[data-reset]').forEach(el=>{el.textContent=countdown(Number(el.dataset.reset));});
  document.querySelectorAll('[data-updated]').forEach(el=>{el.textContent=ago(el.dataset.updated);});
  const next=nearestResets(accounts())[0];if($('#next-reset-value'))$('#next-reset-value').textContent=next?countdown(next.window.resetsAt).replace(/:\d{2}$/,''):'—';
  if (!demo && !disconnected) for(const account of state.accounts){
    if(account.status==='connected' && account.rateLimits.some(b=>[b.primary,b.secondary].some(w=>w&&isExpired(w))) && Date.now()-(expirationRefresh.get(account.id)||0)>60000){expirationRefresh.set(account.id,Date.now());void refreshAccount(account.id,true);}
  }
},1000);
setInterval(()=>{if(!document.hidden)void loadState();},3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void loadState();});

function feedback(element, source) {
  element.dataset.feedbackSource = source;
  element.textContent = message(source);
}
function changeLanguage(value, persist = true) {
  const saved = setLanguage(value, { persist });
  applyTranslations();
  // Dynamic dialog content must override its initial static translation.
  renderAccountForm();
  if (demo) demoAccounts.forEach((account, index) => { account.name = t(demoNameKeys[index]); });
  render(true);
  updateLogin(true);
  renderSwitchDialog();
  const deleting = state.accounts.find(account => account.id === deletingId);
  if (deleting) $('#delete-description').textContent = t('你将从管理面板移除「{name}」。', { name: deleting.name });
  const deletingGroup = groups().find(group => group.id === deletingGroupId);
  if (deletingGroup) $('#group-delete-description').textContent = t('删除「{name}」？组内账号会移回默认分组。', { name: groupTitle(deletingGroup) });
  if ($('#group-dialog').open) renderGroupForm();
  document.querySelectorAll('[data-feedback-source]').forEach(element => { element.textContent = message(element.dataset.feedbackSource); });
  $('#toast').hidden = true;
  if (!saved) toast(t('无法保存语言偏好；本次切换仍然生效。'), true);
}
$('#language-select').addEventListener('change', event => changeLanguage(event.target.value));
window.addEventListener('storage', event => {
  if (event.key === LANGUAGE_KEY || event.key === null) changeLanguage(event.newValue, false);
  if (event.key === GROUP_EXPANDED_KEY || event.key === null) { expandedGroups = readExpandedGroups(); render(true); }
});
summary(); void loadState();
