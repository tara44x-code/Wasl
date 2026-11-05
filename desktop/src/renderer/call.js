'use strict';
/* global callwin */
const q = new URLSearchParams(location.search);
const ar = q.get('lang') === 'ar';
document.documentElement.dir = ar ? 'rtl' : 'ltr';
const $ = (id) => document.getElementById(id);
$('answer').textContent = ar ? 'رد' : 'Answer';
$('decline').textContent = ar ? 'رفض' : 'Decline';
callwin.onCall((c) => {
  if (!c) return;
  const ringing = c.state === 'ringing';
  $('label').textContent = ringing ? (ar ? 'مكالمة واردة' : 'Incoming call') : (ar ? 'مكالمة جارية' : 'On a call');
  $('name').textContent = c.name || c.number || (ar ? 'رقم مخفي' : 'Unknown number');
  $('num').textContent = c.name ? c.number : '';
  $('avatar').textContent = (c.name || '☎').trim().charAt(0).toUpperCase();
  $('answer').hidden = !ringing;
  $('decline').textContent = ringing ? (ar ? 'رفض' : 'Decline') : (ar ? 'إنهاء' : 'End');
});
$('answer').onclick = () => callwin.act('answer');
$('decline').onclick = () => callwin.act('decline');
$('x').onclick = () => callwin.act('close');
document.querySelector('.who').onclick = () => callwin.act('open');
