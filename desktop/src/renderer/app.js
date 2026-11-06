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

  // While pairing (first time or again), the QR code replaces the device view.
  const showPair = !S.paired || !!S.pairing;
  $('pairView').hidden = !showPair;
  $('deviceView').hidden = showPair;
  if (showPair) renderPairing();
  else renderDevice();

  const n = S.notifications.length;
  $('notifBadge').hidden = !n;
  $('notifBadge').textContent = n > 99 ? '99+' : String(n);
  renderNotifications();
  renderTransfers();
  renderSettings();
  renderMessages();
  renderCalls();
  renderScreen();
  renderClipboard();
  renderUpdate();
  renderPhoneFs();
}

function renderPairing() {
  const p = S.pairing;
  const wrap = $('qrWrap');
  $('pairCancel').hidden = !p && !S.paired;
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
  $('repairBtn').hidden = S.connected;
  $('repairHint').hidden = S.connected;
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
  document.querySelectorAll('.action').forEach((a) => (a.disabled = !S.connected && a.id !== 'actMirror'));
  $('ringLabel').textContent = tr(S.ringing ? 'act.ringStop' : 'act.ring');
  $('actRing').classList.toggle('ringing', S.ringing);
  $('actMirror').disabled = false;
  renderMedia();
  renderControls();

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
$('repairBtn').onclick = () => wasl.pairStart();
$('actFiles').onclick = () => wasl.pickFiles();
$('actClip').onclick = () => { wasl.sendClipboard(); showToast(tr('notif.sent')); };
$('actRing').onclick = () => wasl.ring(!S.ringing);
$('actMirror').onclick = () => { go('screen'); wasl.mirrorStart(); };
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

// ======================================================================
// Media & quick controls
// ======================================================================

function fmtTime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function mediaPosition(m) {
  if (!m) return 0;
  const p = m.playing ? m.position + (Date.now() - m.at) : m.position;
  return m.duration ? Math.min(p, m.duration) : p;
}

function renderMedia() {
  const m = S.connected ? S.media : null;
  $('mediaEmpty').hidden = !!m;
  $('mediaBody').hidden = !m;
  if (!m) return;
  const art = $('mediaArt');
  const artKey = m.art ? m.art.slice(-40) : '';
  if (art.dataset.key !== artKey) {
    art.dataset.key = artKey;
    art.replaceChildren(m.art ? el('img', { src: `data:image/jpeg;base64,${m.art}`, alt: '' }) : el('div', { class: 'art-ph', text: '♪' }));
  }
  $('mediaApp').textContent = m.app;
  $('mediaTitle').textContent = m.title;
  $('mediaArtist').textContent = [m.artist, m.album].filter(Boolean).join(' — ');
  $('mToggleIcon').innerHTML = m.playing ? '<path d="M7 4h4v16H7zM14 4h4v16h-4z"/>' : '<path d="M7 4l13 8-13 8z"/>';
  $('mPrev').disabled = !m.canPrev;
  $('mNext').disabled = !m.canNext;
  tickMedia();
}

function tickMedia() {
  const m = S && S.connected ? S.media : null;
  if (!m) return;
  const p = mediaPosition(m);
  $('mediaBar').style.width = m.duration ? `${(p / m.duration) * 100}%` : '0';
  $('mediaPos').textContent = fmtTime(p);
  $('mediaDur').textContent = m.duration ? fmtTime(m.duration) : '';
}
setInterval(tickMedia, 1000);

$('mPrev').onclick = () => wasl.media('prev');
$('mNext').onclick = () => wasl.media('next');
$('mToggle').onclick = () => wasl.media('toggle');
$('mediaSeek').onclick = (e) => {
  const m = S.media;
  if (!m || !m.canSeek || !m.duration) return;
  const r = e.currentTarget.getBoundingClientRect();
  let f = (e.clientX - r.left) / r.width;
  if (document.documentElement.dir === 'rtl') f = 1 - f;
  wasl.media('seek', Math.round(f * m.duration));
};

function renderControls() {
  const st = S.connected ? S.status : null;
  const tiles = ['tDnd', 'tTorch', 'tRinger', 'tLock'];
  tiles.forEach((id) => ($(id).disabled = !st));
  $('volMusic').disabled = !st;
  $('volRing').disabled = !st;
  const ringer = st ? st.ringer : 'normal';
  $('ringerLabel').textContent = tr(`ctl.${ringer}`);
  if (!st) return;
  $('tDnd').classList.toggle('on', !!st.dnd);
  $('tTorch').classList.toggle('on', !!st.torch);
  $('tTorch').disabled = !st.hasTorch;
  $('tRinger').classList.toggle('on', ringer !== 'normal');
  $('tLock').disabled = !st.canLock;
  $('tLock').title = st.canLock ? '' : tr('perm.a11y');
  const vm = $('volMusic');
  const vr = $('volRing');
  if (document.activeElement !== vm) { vm.max = st.volMusicMax; vm.value = st.volMusic; }
  if (document.activeElement !== vr) { vr.max = st.volRingMax; vr.value = st.volRing; }
}

$('tDnd').onclick = () => wasl.toggle('dnd', !(S.status && S.status.dnd));
$('tTorch').onclick = () => wasl.toggle('torch', !(S.status && S.status.torch));
$('tRinger').onclick = () => {
  const order = ['normal', 'vibrate', 'silent'];
  const cur = (S.status && S.status.ringer) || 'normal';
  wasl.toggle('ringer', order[(order.indexOf(cur) + 1) % order.length]);
};
$('tLock').onclick = () => wasl.toggle('lock', true);
let volTimer = null;
const volChange = (stream, input) => {
  clearTimeout(volTimer);
  volTimer = setTimeout(() => wasl.volume(stream, Number(input.value)), 80);
};
$('volMusic').oninput = (e) => volChange('music', e.target);
$('volRing').oninput = (e) => volChange('ring', e.target);

// ======================================================================
// Messages
// ======================================================================

let composingNew = false;
let smsRequested = false;

function contactOptions() {
  const dl = $('contactList');
  const c = S.contacts || [];
  if (dl.dataset.n === String(c.length)) return;
  dl.dataset.n = String(c.length);
  dl.replaceChildren(...c.flatMap((x) => x.numbers.map((n) => el('option', { value: n, label: x.name }))));
}

function resolveNumber(text) {
  const t = String(text).trim();
  if (/^[+\d][\d\s-]*$/.test(t)) return t.replace(/[\s-]/g, '');
  const c = (S.contacts || []).find((x) => x.name.toLowerCase() === t.toLowerCase());
  return c ? c.numbers[0] : t;
}

function renderMessages() {
  const page = $('page-messages');
  if (!page.classList.contains('active')) return;
  if (S.connected && !smsRequested) {
    smsRequested = true;
    wasl.smsThreads();
    wasl.contacts();
  }
  contactOptions();
  const th = S.smsThreads;
  $('smsPerm').hidden = !(th && !th.allowed);
  const q = $('smsSearch').value.trim().toLowerCase();
  const list = $('threadList');
  const items = (th ? th.items : []).filter((x) => !q || `${x.name} ${x.address} ${x.snippet}`.toLowerCase().includes(q));
  const cur = S.smsThread;
  list.replaceChildren(...(items.length ? items.map((x) => el('button', {
    class: `thread ${cur && cur.thread === x.thread ? 'sel' : ''} ${x.unread ? 'unread' : ''}`,
    onclick: () => { composingNew = false; wasl.smsOpen(x.thread); },
  },
  el('div', { class: 'app-icon letter', text: (x.name || x.address || '#').trim().charAt(0).toUpperCase() }),
  el('div', { class: 't-main' },
    el('div', { class: 'th-top' }, el('b', { dir: 'auto', text: x.name || x.address }), el('span', { class: 'muted small', text: ago(x.date) })),
    el('div', { class: 'muted small ellipsis', dir: 'auto', text: (x.out ? '↪ ' : '') + x.snippet })),
  x.unread ? el('b', { class: 'badge', text: String(x.unread) }) : null)) : [el('div', { class: 'empty small' }, el('span', { class: 'muted', text: th ? tr('notif.empty') : tr('sms.loading') }))]));

  const head = $('convoHead');
  const bubbles = $('bubbles');
  $('smsTo').hidden = !composingNew;
  if (composingNew) {
    head.replaceChildren(el('b', { text: tr('sms.newTitle') }));
    bubbles.replaceChildren();
  } else if (cur) {
    head.replaceChildren(el('b', { dir: 'auto', text: cur.name || cur.address || '' }), el('span', { class: 'muted small mono', text: cur.name ? cur.address : '' }),
      el('button', { class: 'pill', text: tr('calls.call'), onclick: () => wasl.dial(cur.address) }));
    const atBottom = bubbles.scrollHeight - bubbles.scrollTop - bubbles.clientHeight < 40;
    bubbles.replaceChildren(...(cur.items || []).map((m) => el('div', { class: `bubble ${m.out ? 'out' : 'in'} ${m.pending ? 'pending' : ''}` },
      el('div', { dir: 'auto', text: m.body }), el('span', { class: 'b-time', text: new Date(m.date).toLocaleString(lang === 'ar' ? 'ar-IQ' : undefined, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) }))));
    if (atBottom || bubbles.dataset.thread !== String(cur.thread)) bubbles.scrollTop = bubbles.scrollHeight;
    bubbles.dataset.thread = String(cur.thread);
  } else {
    head.replaceChildren();
    bubbles.replaceChildren(el('div', { class: 'empty' }, el('span', { class: 'muted', text: tr('sms.pick') })));
  }
  $('smsBody').disabled = !S.connected || (!cur && !composingNew);
  $('smsSendBtn').disabled = $('smsBody').disabled;
  const unread = (th ? th.items : []).reduce((a, x) => a + (x.unread || 0), 0);
  $('smsBadge').hidden = !unread;
  $('smsBadge').textContent = String(unread);
}

function sendSms() {
  const body = $('smsBody').value.trim();
  if (!body) return;
  const to = composingNew ? resolveNumber($('smsTo').value) : S.smsThread && S.smsThread.address;
  if (!to) return;
  wasl.smsSend(to, body).then((ok) => showToast(tr(ok ? 'notif.sent' : 'notif.failed')));
  $('smsBody').value = '';
  if (composingNew) {
    composingNew = false;
    setTimeout(() => wasl.smsThreads(), 1500);
  }
}
$('smsSendBtn').onclick = sendSms;
$('smsBody').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSms(); }
});
$('smsNew').onclick = () => { composingNew = true; wasl.smsClose(); wasl.contacts(); render(); setTimeout(() => $('smsTo').focus(), 0); };
$('smsRefresh').onclick = () => { wasl.smsThreads(); if (S.smsThread) wasl.smsOpen(S.smsThread.thread); };
$('smsSearch').oninput = () => renderMessages();

// ======================================================================
// Calls
// ======================================================================

let callsRequested = false;

function renderCalls() {
  const c = S.connected ? S.call : null;
  $('activeCall').hidden = !c;
  if (c) {
    $('acLabel').textContent = tr(c.state === 'ringing' ? 'calls.incoming' : 'calls.ongoing');
    $('acName').textContent = c.name || c.number || tr('calls.unknown');
    $('acAnswer').hidden = c.state !== 'ringing';
  }
  if (!$('page-calls').classList.contains('active')) return;
  if (S.connected && !callsRequested) {
    callsRequested = true;
    wasl.callLog();
    wasl.contacts();
  }
  contactOptions();
  const log = S.calllog;
  $('callsPerm').hidden = !(log && !log.allowed);
  const items = log ? log.items : [];
  $('callLog').replaceChildren(...(items.length ? items.map((x) => el('div', { class: `call-row ${x.type}` },
    el('div', { class: `call-ico ${x.type}`, text: { in: '↙', out: '↗', missed: '✕', rejected: '⊘' }[x.type] || '•' }),
    el('div', { class: 't-main' },
      el('b', { dir: 'auto', text: x.name || x.number || tr('calls.unknown') }),
      el('span', { class: 'muted small', text: `${tr(`calls.${x.type}`)} · ${ago(x.date)}${x.duration ? ` · ${fmtTime(x.duration * 1000)}` : ''}` })),
    x.number ? el('div', { class: 'row' },
      el('button', { class: 'pill', text: tr('calls.call'), onclick: () => wasl.dial(x.number) }),
      el('button', { class: 'pill', text: tr('calls.sms'), onclick: () => startSmsTo(x.number) })) : null))
    : [el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('calls.empty') }))]));
}

function startSmsTo(number) {
  const th = (S.smsThreads ? S.smsThreads.items : []).find((x) => x.address.replace(/\D/g, '').endsWith(number.replace(/\D/g, '').slice(-9)));
  go('messages');
  if (th) {
    composingNew = false;
    wasl.smsOpen(th.thread);
  } else {
    composingNew = true;
    $('smsTo').value = number;
    wasl.smsClose();
  }
  render();
}

$('dialBtn').onclick = () => {
  const n = resolveNumber($('dialNumber').value);
  if (n) { wasl.dial(n); showToast(tr('notif.sent')); }
};
$('dialSms').onclick = () => { const n = resolveNumber($('dialNumber').value); if (n) startSmsTo(n); };
$('acAnswer').onclick = () => wasl.callCmd('answer');
$('acEnd').onclick = () => wasl.callCmd(S.call && S.call.state === 'ringing' ? 'decline' : 'end');
$('callsRefresh').onclick = () => wasl.callLog();

// ======================================================================
// Screen mirroring
// ======================================================================

function renderScreen() {
  const m = S.mirror || { devices: [] };
  $('liveBadge').hidden = !m.active;
  $('mirrorStart').hidden = !!m.active;
  $('mirrorStop').hidden = !m.active;
  $('mirrorApp').hidden = !!m.active || !S.connected;
  $('mirrorStart').disabled = m.status === 'starting';
  let status = '';
  if (m.status === 'starting') status = tr('mirror.s.starting');
  else if (m.status === 'consent') status = tr('mirror.s.consent');
  else if (m.status === 'running' && m.active === 'app' && !m.a11y) status = tr('mirror.appNote');
  else if (m.status === 'running' && m.active) status = tr('mirror.s.running');
  else if (m.status === 'error') status = STRINGS.en[`mirror.e.${m.error}`] !== undefined ? tr(`mirror.e.${m.error}`) : tr('mirror.e.other') + m.error;
  $('mirrorStatus').textContent = status;
  $('mirrorStatus').className = `small ${m.status === 'error' ? 'err' : 'muted'}`;
  const list = $('adbDevices');
  list.replaceChildren(...(m.devices.length ? m.devices.map((d) => el('div', { class: 'device-row' },
    el('div', { class: `t-dir ${d.transport === 'usb' ? 'in' : 'out'}`, text: d.transport === 'usb' ? '⌁' : '≋' }),
    el('div', { class: 't-main' },
      el('b', { text: d.model || d.serial }),
      el('span', { class: 'muted small', text: d.state === 'unauthorized' ? tr('mirror.unauthorized') : `${tr(d.transport === 'usb' ? 'mirror.usb' : 'mirror.wifi')} · ${d.serial}` })),
    el('div', { class: 'row' },
      d.transport === 'usb' && d.state === 'device' ? el('button', { class: 'btn ghost sm', text: tr('mirror.toWifi'), onclick: () => wasl.mirrorWifi(d.serial).then((r) => showToast(r.ok ? `✓ ${r.result}` : r.error)) }) : null,
      d.state === 'device' ? el('button', { class: 'btn primary sm', text: tr('mirror.start'), onclick: () => wasl.mirrorStart(d.serial) }) : null)))
    : [el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('mirror.noDevices') }))]));
}

$('mirrorStart').onclick = () => wasl.mirrorStart();
$('mirrorStop').onclick = () => wasl.mirrorStop();
$('mirrorApp').onclick = () => wasl.mirrorStart('app');
$('mirrorRefresh').onclick = () => wasl.mirrorRefresh();
$('pairDo').onclick = async () => {
  const host = $('pairHost').value.trim();
  const code = $('pairCode').value.trim();
  if (!host || !code) return;
  $('pairResult').textContent = '…';
  const r = await wasl.mirrorPair(host, code);
  $('pairResult').textContent = r.ok ? tr('mirror.paired') : r.error;
  $('pairResult').className = `small ${r.ok ? 'ok' : 'err'}`;
};

// ======================================================================
// Clipboard history
// ======================================================================

function renderClipboard() {
  const h = S.clipHistory || [];
  $('clipList').replaceChildren(...(h.length ? h.map((x, i) => el('div', { class: `clip ${x.pinned ? 'pinned' : ''}` },
    el('div', { class: 'clip-text', dir: 'auto', text: x.text.length > 600 ? `${x.text.slice(0, 600)}…` : x.text }),
    el('div', { class: 'clip-foot' },
      el('span', { class: 'muted small', text: `${tr(x.from === 'phone' ? 'clip.phone' : 'clip.pc')} · ${ago(x.time)}` }),
      el('div', { class: 'row' },
        el('button', { class: 'pill', text: tr('clip.copy'), onclick: () => { wasl.clipCopy(i); showToast(tr('notif.copied')); } }),
        el('button', { class: 'pill', text: tr(x.pinned ? 'clip.unpin' : 'clip.pin'), onclick: () => wasl.clipPin(i) }),
        el('button', { class: 'pill', text: '×', title: tr('clip.delete'), onclick: () => wasl.clipDelete(i) })))))
    : [el('div', { class: 'empty' }, el('span', { class: 'muted', text: tr('clip.empty') }))]));
}
$('clipClear').onclick = () => wasl.clipClear();

// ======================================================================
// Settings extras & updates
// ======================================================================

const baseRenderSettings = renderSettings;
// eslint-disable-next-line no-func-assign
renderSettings = function renderSettingsAll() {
  baseRenderSettings();
  const muted = new Set(S.settings.mutedApps || []);
  const apps = Object.entries(S.seenApps || {}).sort((a, b) => a[1].localeCompare(b[1]));
  $('appFilter').replaceChildren(...(apps.length ? apps.map(([pkg, name]) => el('label', { class: 'app-toggle' },
    el('span', { text: name }),
    (() => {
      const i = el('input', { type: 'checkbox', class: 'switch' });
      i.checked = !muted.has(pkg);
      i.onchange = () => wasl.mute(pkg, !i.checked);
      return i;
    })())) : [el('span', { class: 'muted small', text: tr('set.noApps') })]));
  document.querySelectorAll('input.time').forEach((i) => {
    if (document.activeElement !== i) i.value = S.settings[i.dataset.time] || '';
  });
  $('phoneVer').textContent = S.phoneVersion ? tr('upd.phone', { v: S.phoneVersion }) : '';
};
document.querySelectorAll('input.time').forEach((i) => {
  i.addEventListener('change', () => wasl.setSettings({ [i.dataset.time]: i.value }));
});

function renderUpdate() {
  const u = S.update || { status: 'idle' };
  const vars = { v: S.version, n: u.version || '', p: u.percent || 0 };
  $('updateText').textContent = tr(`upd.${u.status}`, vars);
  $('updInstall').hidden = u.status !== 'available';
  $('updBanner').hidden = u.status !== 'available' && u.status !== 'downloading';
  $('updBannerText').textContent = u.status === 'downloading' ? tr('upd.downloading', vars) : tr('upd.banner', vars);
  $('updBannerBtn').hidden = u.status !== 'available';
}
$('updCheck').onclick = () => wasl.updateCheck();
$('updInstall').onclick = () => wasl.updateInstall();
$('updBannerBtn').onclick = () => wasl.updateInstall();

// Pages that load data when opened.
document.querySelectorAll('.nav').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.page === 'messages') { smsRequested = false; }
  if (b.dataset.page === 'calls') { callsRequested = false; }
  render();
}));

// ======================================================================
// Phone files
// ======================================================================

let pfsRequested = false;
let pfsPath = '';

function renderPhoneFs() {
  if (!$('page-files').classList.contains('active')) return;
  if (S.connected && !pfsRequested) {
    pfsRequested = true;
    wasl.fsList(pfsPath);
  }
  const fsx = S.phoneFs;
  $('pfsPath').textContent = `/${tr('pfs.root')}${pfsPath ? `/${pfsPath}` : ''}`;
  $('pfsUp').disabled = !pfsPath;
  const list = $('pfsList');
  if (!S.connected) return list.replaceChildren(el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('files.needConn') })));
  if (fsx && !fsx.allowed) return list.replaceChildren(el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('pfs.denied') })));
  const items = fsx && fsx.path === pfsPath ? fsx.items : null;
  if (!items) return list.replaceChildren(el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('sms.loading') })));
  if (!items.length) return list.replaceChildren(el('div', { class: 'empty small' }, el('span', { class: 'muted', text: tr('pfs.empty') })));
  return list.replaceChildren(...items.map((x) => el('div', {
    class: `pfs-row ${x.dir ? 'dir' : ''}`,
    ondblclick: () => x.dir && openDir(x.name),
  },
  el('span', { class: 'pfs-ico', text: x.dir ? '📁' : '📄' }),
  el('button', { class: 'pfs-name', dir: 'auto', text: x.name, onclick: () => x.dir && openDir(x.name) }),
  el('span', { class: 'muted small', text: x.dir ? '' : size(x.size) }),
  el('span', { class: 'muted small', text: new Date(x.mtime).toLocaleDateString(lang === 'ar' ? 'ar-IQ' : undefined) }),
  x.dir ? el('span') : el('button', { class: 'pill', text: tr('pfs.get'), onclick: () => { wasl.fsGet([pfsPath ? `${pfsPath}/${x.name}` : x.name]); showToast(tr('notif.sent')); } }))));
}

function openDir(name) {
  pfsPath = pfsPath ? `${pfsPath}/${name}` : name;
  wasl.fsList(pfsPath);
  renderPhoneFs();
}
$('pfsUp').onclick = () => {
  pfsPath = pfsPath.split('/').slice(0, -1).join('/');
  wasl.fsList(pfsPath);
  renderPhoneFs();
};
$('pfsRefresh').onclick = () => wasl.fsList(pfsPath);
document.querySelector('[data-page="files"]').addEventListener('click', () => { pfsRequested = false; renderPhoneFs(); });
