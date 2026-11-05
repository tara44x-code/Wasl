'use strict';
/* global mirror, VideoDecoder, EncodedVideoChunk, AudioDecoder, EncodedAudioChunk */
// Decodes the phone's H.264 screen with WebCodecs, plays its Opus audio, and
// turns mouse and keyboard input into touches and key presses.

const q = new URLSearchParams(location.search);
const ar = q.get('lang') === 'ar';
const TIPS = {
  back: ['رجوع (زر الفأرة الأيمن)', 'Back (right click)'],
  home: ['الرئيسية (الزر الأوسط)', 'Home (middle click)'],
  recents: ['التطبيقات الأخيرة', 'Recent apps'],
  voldown: ['خفض الصوت', 'Volume down'],
  volup: ['رفع الصوت', 'Volume up'],
  mute: ['كتم صوت الهاتف هنا', 'Mute phone audio here'],
  notifications: ['لوحة الإشعارات', 'Notification panel'],
  rotate: ['تدوير', 'Rotate'],
  screenshot: ['لقطة شاشة', 'Screenshot'],
  screenoff: ['إطفاء شاشة الهاتف (يستمر العرض هنا)', 'Turn phone screen off (keeps mirroring)'],
  power: ['زر التشغيل', 'Power button'],
};
const T = (k) => (TIPS[k] ? TIPS[k][ar ? 0 : 1] : k);
document.querySelectorAll('[data-tip]').forEach((b) => (b.title = T(b.dataset.tip)));
document.getElementById('waitText').textContent = ar ? 'جارٍ تشغيل العرض…' : 'Starting the mirror…';
document.documentElement.lang = ar ? 'ar' : 'en';

const canvas = document.getElementById('screen');
const ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
canvas.width = Number(q.get('w')) || 1080;
canvas.height = Number(q.get('h')) || 2400;

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 1800);
}

// ---- video -----------------------------------------------------------------

let decoder = null;
let configBytes = null;
let needKey = true;

function avcCodec(cfg) {
  for (let i = 0; i + 4 < cfg.length; i++) {
    if (cfg[i] === 0 && cfg[i + 1] === 0 && cfg[i + 2] === 1 && (cfg[i + 3] & 0x1f) === 7) {
      const hex = (b) => b.toString(16).padStart(2, '0');
      return `avc1.${hex(cfg[i + 4])}${hex(cfg[i + 5])}${hex(cfg[i + 6])}`;
    }
  }
  return 'avc1.42e01f';
}

function makeDecoder() {
  if (decoder && decoder.state !== 'closed') decoder.close();
  decoder = new VideoDecoder({
    output(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx2d.drawImage(frame, 0, 0);
      frame.close();
      document.getElementById('wait').hidden = true;
    },
    error() {
      needKey = true;
      if (configBytes) setTimeout(makeDecoder, 0);
    },
  });
  decoder.configure({ codec: avcCodec(configBytes), optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  needKey = true;
}

mirror.onVideo((p) => {
  if (p.config) {
    configBytes = p.data;
    makeDecoder();
    return;
  }
  if (!decoder || decoder.state !== 'configured') return;
  if (needKey && !p.key) return;
  // Fall behind? Skip to the next key frame rather than lag.
  if (decoder.decodeQueueSize > 6 && !p.key) {
    needKey = true;
    return;
  }
  let data = p.data;
  if (p.key && configBytes) {
    data = new Uint8Array(configBytes.length + p.data.length);
    data.set(configBytes, 0);
    data.set(p.data, configBytes.length);
  }
  try {
    decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.pts, data }));
    needKey = false;
  } catch {
    needKey = true;
  }
});

// ---- audio -----------------------------------------------------------------

let audioCtx = null;
let audioDecoder = null;
let nextTime = 0;
let muted = false;

function setupAudio() {
  audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  audioDecoder = new AudioDecoder({
    output(ad) {
      if (muted) return ad.close();
      const n = ad.numberOfFrames;
      const ch = ad.numberOfChannels;
      const buf = audioCtx.createBuffer(ch, n, ad.sampleRate);
      for (let c = 0; c < ch; c++) {
        const f = new Float32Array(n);
        ad.copyTo(f, { planeIndex: c, format: 'f32-planar' });
        buf.copyToChannel(f, c);
      }
      ad.close();
      const now = audioCtx.currentTime;
      if (nextTime < now + 0.02 || nextTime > now + 0.25) nextTime = now + 0.05;
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.start(nextTime);
      nextTime += buf.duration;
    },
    error() {},
  });
  audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
}

mirror.onAudio((p) => {
  try {
    if (!audioDecoder) setupAudio();
    audioDecoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: p.pts, data: p.data }));
  } catch {}
});

// ---- input -------------------------------------------------------------------

function pos(e) {
  const r = canvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * canvas.width;
  const y = ((e.clientY - r.top) / r.height) * canvas.height;
  return { x: Math.max(0, Math.min(canvas.width - 1, x)), y: Math.max(0, Math.min(canvas.height - 1, y)), w: canvas.width, h: canvas.height };
}

const KEY = { HOME: 3, BACK: 4, VOL_UP: 24, VOL_DOWN: 25, POWER: 26, APP_SWITCH: 187 };
let pressed = false;

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.focus();
  if (e.button === 2) return mirror.input({ type: 'back' });
  if (e.button === 1) return mirror.input({ type: 'press', keycode: KEY.HOME });
  if (e.button !== 0) return;
  pressed = true;
  canvas.setPointerCapture(e.pointerId);
  mirror.input({ type: 'touch', action: 'down', ...pos(e) });
});
canvas.addEventListener('pointermove', (e) => {
  if (pressed) mirror.input({ type: 'touch', action: 'move', ...pos(e) });
});
const release = (e) => {
  if (!pressed) return;
  pressed = false;
  mirror.input({ type: 'touch', action: 'up', ...pos(e) });
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const scale = e.deltaMode === 1 ? 1 : 1 / 100;
  mirror.input({ type: 'scroll', ...pos(e), hs: -e.deltaX * scale, vs: -e.deltaY * scale });
}, { passive: false });

const KEYCODES = {
  Enter: 66, Backspace: 67, Delete: 112, Tab: 61, Escape: 111,
  ArrowLeft: 21, ArrowRight: 22, ArrowUp: 19, ArrowDown: 20,
  Home: 122, End: 123, PageUp: 92, PageDown: 93,
};
const META_SHIFT = 0x1;
const META_CTRL = 0x1000;

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
    e.preventDefault();
    return mirror.input({ type: 'pastePC' });
  }
  const code = KEYCODES[e.key];
  if (code) {
    e.preventDefault();
    const meta = (e.shiftKey ? META_SHIFT : 0) | (e.ctrlKey ? META_CTRL : 0);
    return mirror.input({ type: 'key', action: 'down', keycode: code, meta });
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    mirror.input({ type: 'text', text: e.key });
  }
});
window.addEventListener('keyup', (e) => {
  const code = KEYCODES[e.key];
  if (code) mirror.input({ type: 'key', action: 'up', keycode: code });
});

// ---- toolbar -----------------------------------------------------------------

let screenOff = false;
document.getElementById('bar').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  switch (b.dataset.act) {
    case 'back': return mirror.input({ type: 'back' });
    case 'home': return mirror.input({ type: 'press', keycode: KEY.HOME });
    case 'recents': return mirror.input({ type: 'press', keycode: KEY.APP_SWITCH });
    case 'volup': return mirror.input({ type: 'press', keycode: KEY.VOL_UP });
    case 'voldown': return mirror.input({ type: 'press', keycode: KEY.VOL_DOWN });
    case 'power': return mirror.input({ type: 'press', keycode: KEY.POWER });
    case 'rotate': return mirror.input({ type: 'rotate' });
    case 'notifications': return mirror.input({ type: 'notifications' });
    case 'mute':
      muted = !muted;
      b.classList.toggle('on', muted);
      return undefined;
    case 'screenoff':
      screenOff = !screenOff;
      b.classList.toggle('on', screenOff);
      mirror.input({ type: 'screen', on: !screenOff });
      return toast(screenOff ? (ar ? 'شاشة الهاتف مطفأة' : 'Phone screen off') : (ar ? 'شاشة الهاتف تعمل' : 'Phone screen on'));
    case 'screenshot': {
      const r = await mirror.screenshot(canvas.toDataURL('image/png'));
      return toast(r.ok ? (ar ? 'حُفظت في الصور › Wasl' : 'Saved to Pictures › Wasl') : (ar ? 'تعذّر الحفظ' : 'Could not save'));
    }
    default: return undefined;
  }
});

canvas.focus();
