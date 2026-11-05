'use strict';
/* global wasl, STRINGS */

let S = null; // latest state from the main process
let lang = 'ar';

const $ = (id) => document.getElementById(id);

function tr(key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

/** Builds an element; text always goes through textContent. */
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c) e.append(c);
  return e;
}

function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function ago(ms) {
  const d = Math.max(0, Date.now() - ms);
  if (d < 60_000) return tr('time.now');
  if (d < 3_600_000) return tr('time.min', { n: Math.floor(d / 60_000) });
  if (d < 86_400_000) return tr('time.hour', { n: Math.floor(d / 3_600_000) });
  return new Date(ms).toLocaleDateString(lang === 'ar' ? 'ar-IQ' : undefined);
}

function size(n) {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

/** A one-time code in a notification, if there is one. */
function findCode(text) {
  if (!/(code|otp|verif|رمز|كود|تحقق|password|pin)/i.test(text)) return null;
  const m = text.match(/(?<![\d-])(\d{4,8})(?![\d-])/);
  return m ? m[1] : null;
}

// ---- language & theme --------------------------------------------------

function applyLanguage() {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach((e) => (e.textContent = tr(e.dataset.i18n)));
  document.querySelectorAll('[data-i18n-ph]').forEach((e) => (e.placeholder = tr(e.dataset.i18nPh)));
}

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// ---- navigation ----------------------------------------------------------

function go(page) {
  document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
}
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

// ---- rendering -----------------------------------------------------------

function render() {
  if (!S) return;
  if (S.settings.language !== lang) {
    lang = S.settings.language;
    applyLanguage();
  }
  applyTheme(S.settings.theme);
  document.body.classList.toggle('is-win', S.platform === 'win32');

  const status = !S.paired ? 'unpaired' : S.connected ? 'on' : 'off';
  const sc = $('sideConn');
  sc.className = `conn ${status}`;
  sc.querySelector('span').textContent = tr(`conn.${status}`);

  $('pairView').hidden = S.paired;
  $('deviceView').hidden = !S.paired;
  if (!S.paired) renderPairing();
  else renderDevice();

  const n = S.notifications.length;
  $('notifBadge').hidden = !n;
  $('notifBadge').textContent = n > 99 ? '99+' : String(n);
  renderNotifications();
  renderTransfers();
  renderSettings();
}

function renderPairing() {
  const p = S.pairing;
  const wrap = $('qrWrap');
  $('pairCancel').hidden = !p;
  $('pairBtn').hidden = !!p;
  if (p) {
    if (wrap.dataset.uri !== p.uri) {
      wrap.dataset.uri = p.uri;
      wrap.replaceChildren(el('img', { src: p.qr, class: 'qr', alt: 'QR' }));
    }
    const mins = Math.max(0, Math.ceil((p.until - Date.now()) / 60000));
    $('pairInfo').textContent = mins > 0
      ? tr('pair.expires', { m: mins, h: `${p.hosts[0] || '?'}:${p.port}` })
      : tr('pair.expired');
  } else {
    delete wrap.dataset.uri;
    if (!wrap.querySelector('.qr-placeholder')) {
      wrap.replaceChildren(el('div', { class: 'qr-placeholder' }, el('img', { src: '../assets/icon.png', alt: '' })));
    }
    $('pairInfo').textContent = '';
  }
}

function renderDevice() {
  const d = S.device;
  $('devName').textContent = d.name;
  const cc = $('chipConn');
  cc.textContent = tr(S.connected ? 'conn.on' : 'conn.off');
  cc.className = `chip ${S.connected ? 'ok' : 'warn'}`;
  $('chipModel').textContent = [d.model, d.os].filter(Boolean).join(' · ') || 'Android';
  const b = S.battery;
  const ring = $('batteryRing');
  if (b && S.connected) {
    $('batteryText').textContent = `${b.level}%`;
    ring.style.setProperty('--p', b.level);
    ring.classList.toggle('low', b.level <= 15);
    $('chipCharge').hidden = !b.charging;
    $('chipCharge').textContent = `⚡ ${tr('home.charging')}`;
  } else {
    $('batteryText').textContent = '–';
    ring.style.setProperty('--p', 0);
    $('chipCharge').hidden = true;
  }
  document.querySelectorAll('.action').forEach((a) => (a.disabled = !S.connected && a.id !== 'actNotifs'));
  $('ringLabel').textContent = tr(S.ringing ? 'act.ringStop' : 'act.ring');
  $('actRing').classList.toggle('ringing', S.ringing);
  $('notifCount').textContent = tr('act.notifCount', { n: S.notifications.length });

  const list = $('recentList');
  const items = S.notifications.slice(0, 4);
  list.replaceChildren(...(items.length ? items.map((n) => notifCard(n, true)) : [emptyState()]));
}

function emptyState() {
  return el('div', { class: 'empty' },
    el('b', { text: tr('notif.empty') }),
    el('span', { class: 'muted', text: tr('notif.emptySub') }));
}

const openReplies = new Set();

function notifCard(n, compact) {
  const initial = (n.app || '?').trim().charAt(0).toUpperCase();
  const icon = n.icon
    ? el('img', { class: 'app-icon', src: `data:image/png;base64,${n.icon}`, alt: '' })
    : el('div', { class: 'app-icon letter', text: initial });
  const head = el('div', { class: 'n-head' },
    el('span', { class: 'n-app', text: n.app }),
    el('span', { class: 'n-time', text: ago(n.time) }));
  const body = el('div', { class: 'n-body' },
    head,
    n.title ? el('div', { class: 'n-title', dir: 'auto', text: n.title }) : null,
    n.text ? el('div', { class: 'n-text', dir: 'auto', text: n.text }) : null);

  const card = el('div', { class: 'notif' }, icon, body);
  if (!compact) {
    const btns = el('div', { class: 'n-actions' });
    const code = findCode(`${n.title} ${n.text}`);
    if (code) {
      btns.append(el('button', {
        class: 'pill accent',
        text: tr('notif.copyCode', { c: code }),
        onclick: () => { wasl.copy(code); showToast(tr('notif.copied')); },
      }));
    }
    for (const a of n.actions) {
      btns.append(el('button', {
        class: 'pill',
        text: a.title,
        disabled: S.connected ? null : 'disabled',
        onclick: () => {
          if (a.reply) {
            openReplies.has(n.key) ? openReplies.delete(n.key) : openReplies.add(n.key);
            renderNotifications();
          } else {
            wasl.action(n.key, a.i).then((ok) => showToast(tr(ok ? 'notif.sent' : 'notif.failed')));
          }
        },
      }));
    }
    if (n.text) {
      btns.append(el('button', { class: 'pill', text: '⧉', title: 'Copy', onclick: () => { wasl.copy(n.text); showToast(tr('notif.copied')); } }));
    }
    body.append(btns);

    const replyAction = n.actions.find((a) => a.reply);
    if (replyAction && openReplies.has(n.key)) {
      const input = el('input', { class: 'reply-input', placeholder: tr('notif.reply') });
      const send = () => {
        const text = input.value.trim();
        if (!text) return;
        wasl.action(n.key, replyAction.i, text).then((ok) => {
          showToast(tr(ok ? 'notif.sent' : 'notif.failed'));
          if (ok) { openReplies.delete(n.key); renderNotifications(); }
        });
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
      body.append(el('div', { class: 'reply' }, input, el('button', { class: 'btn primary sm', text: tr('notif.send'), onclick: send })));
      setTimeout(() => input.focus(), 0);
    }
    card.append(el('button', { class: 'n-close', title: '×', text: '×', onclick: () => wasl.dismiss(n.key) }));
  }
  return card;
}

function renderNotifications() {
  if (!S) return;
  const list = $('notifList');
  if (list.contains(document.activeElement) && document.activeElement.classList.contains('reply-input')) return;
  const q = $('notifSearch').value.trim().toLowerCase();
  const items = S.notifications.filter((n) => !q || `${n.app} ${n.title} ${n.text}`.toLowerCase().includes(q));
  list.replaceChildren(...(items.length ? items.map((n) => notifCard(n, false)) : [emptyState()]));
}

function renderTransfers() {
  const list = $('transferList');
  if (!S.transfers.length) {
    list.replaceChildren(el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('files.empty') })));
    return;
  }
  list.replaceChildren(...S.transfers.map((x) => {
    const pct = x.size ? Math.round((x.done / x.size) * 100) : 100;
    const stateText = x.state === 'active' ? `${pct}% · ${size(x.done)} / ${size(x.size)}` : `${tr(`files.${x.state}`)} · ${size(x.size)}`;
    const actions = el('div', { class: 'row' });
    if (x.state === 'active') actions.append(el('button', { class: 'btn ghost sm', text: tr('files.cancel'), onclick: () => wasl.cancelTransfer(x.id) }));
    if (x.state === 'done' && x.dir === 'in') actions.append(el('button', { class: 'btn ghost sm', text: tr('files.show'), onclick: () => wasl.openFile(x.path) }));
    return el('div', { class: `transfer ${x.state}` },
      el('div', { class: `t-dir ${x.dir}`, text: x.dir === 'in' ? '↓' : '↑' }),
      el('div', { class: 't-main' },
        el('div', { class: 't-name', dir: 'auto', text: x.name }),
        el('div', { class: 'muted small', text: `${tr(x.dir === 'in' ? 'files.in' : 'files.out')} · ${stateText}` }),
        el('div', { class: 'bar' }, el('i', { style: `width:${pct}%` }))),
      actions);
  }));
}

function renderSettings() {
  const s = S.settings;
  document.querySelectorAll('.seg').forEach((seg) => {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', s[seg.dataset.setting] === b.dataset.v));
  });
  document.querySelectorAll('input.switch').forEach((i) => (i.checked = !!s[i.dataset.setting]));
  $('folderPath').textContent = S.downloadDir;
  $('rowStartup').hidden = S.platform === 'linux';
  $('rowUnpair').hidden = !S.paired;
  $('pairedWith').textContent = S.device ? `${S.device.name}${S.device.model ? ` · ${S.device.model}` : ''}` : tr('set.none');
  $('ver').textContent = `v${S.version}`;
}

// ---- events --------------------------------------------------------------

$('pairBtn').onclick = () => wasl.pairStart();
$('pairCancel').onclick = () => wasl.pairCancel();
$('actFiles').onclick = () => wasl.pickFiles();
$('actClip').onclick = () => { wasl.sendClipboard(); showToast(tr('notif.sent')); };
$('actRing').onclick = () => wasl.ring(!S.ringing);
$('actNotifs').onclick = () => go('notifications');
$('seeAll').onclick = () => go('notifications');
$('clearAll').onclick = () => wasl.clearNotifications();
$('notifSearch').oninput = () => renderNotifications();
$('pickFiles').onclick = () => (S.connected ? wasl.pickFiles() : showToast(tr('files.needConn')));
$('openFolder').onclick = () => wasl.openFile('');
$('clearDone').onclick = () => wasl.clearTransfers();
$('pickDir').onclick = () => wasl.pickDir();
$('unpair').onclick = () => wasl.unpair();
$('repoLink').onclick = () => wasl.openUrl('https://github.com/tara44x-code/Wasl');

document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) wasl.setSettings({ [seg.dataset.setting]: b.dataset.v });
  });
});
document.querySelectorAll('input.switch').forEach((i) => {
  i.addEventListener('change', () => wasl.setSettings({ [i.dataset.setting]: i.checked }));
});

// Drag and drop anywhere in the window sends files.
const drop = $('drop');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!S || !S.connected) return showToast(tr('files.needConn'));
  const paths = [...e.dataTransfer.files].map((f) => wasl.pathOf(f)).filter(Boolean);
  if (paths.length) {
    wasl.sendFiles(paths);
    go('files');
  }
});
drop.addEventListener('click', (e) => { if (e.target === drop) $('pickFiles').click(); });

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S && applyTheme(S.settings.theme));
setInterval(() => S && (renderPairing(), S.paired && renderDevice()), 30_000);

wasl.onState((s) => { S = s; render(); });
wasl.state().then((s) => { S = s; applyLanguage(); render(); });
applyLanguage();
