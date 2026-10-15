import { staticMessages } from './static-messages.mjs';
import { dynamicMessages } from './dynamic-messages.mjs';
import { serverMessages, translateServerMessage } from './server-messages.mjs';

export const LANGUAGE_KEY = 'codex-deck.language';
export const SUPPORTED_LANGUAGES = ['en', 'zh-CN'];
export const messages = { ...staticMessages, ...dynamicMessages };
const reverseMessages = new Map([...Object.entries(serverMessages), ...Object.entries(messages)].filter(([, value]) => typeof value === 'string' && value).map(([key, value]) => [value, key]));
const normalize = value => SUPPORTED_LANGUAGES.includes(value) ? value : 'en';
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }

export function readLanguage(storage = browserStorage()) {
  try { return normalize(storage?.getItem(LANGUAGE_KEY)); } catch { return 'en'; }
}
let language = readLanguage();
export function getLanguage() { return language; }
export function setLanguage(value, { persist = true, storage = browserStorage() } = {}) {
  language = normalize(value);
  if (!persist) return true;
  try { if (!storage) return false; storage.setItem(LANGUAGE_KEY, language); return true; } catch { return false; }
}

// Text-only interpolation: callers escape untrusted values when generating HTML.
export function t(source, params = {}, locale = language) {
  const template = locale === 'zh-CN' ? source : (messages[source] ?? source);
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => Object.hasOwn(params, key) ? String(params[key]) : placeholder);
}
export function message(source, locale = language) {
  if (typeof source !== 'string') return source;
  const original = reverseMessages.get(source) ?? source;
  return Object.hasOwn(messages, original) ? t(original, {}, locale) : translateServerMessage(original, locale);
}

export function applyTranslations(root = document) {
  const attributes = ['placeholder', 'aria-label', 'title', 'content'];
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  for (const attribute of attributes) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => { element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`))); });
  }
  if (root.documentElement) root.documentElement.lang = language;
  const select = root.querySelector('#language-select');
  if (select) select.value = language;
}
