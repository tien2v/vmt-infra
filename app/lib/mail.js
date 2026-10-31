'use strict';
// Gui email tu hop thu no-reply cua tung brand qua SMTP (Lark Mail: smtp.larksuite.com).
// Tu viet SMTP (khong dung thu vien ngoai). Thong tin nhap o /ket-noi (chi admin), luu trong kv, KHONG len GitHub.
// Brand: vominhthien (nhom khach default + cac nhom khac) / vmtglobal.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const BRANDS = { vominhthien: 'Vominhthien', vmtglobal: 'VMT Global' };
let store;
function init(st) { store = st; }

function cfg(brand) { try { return JSON.parse(store.kvGet('mail_' + brand) || 'null'); } catch { return null; } }

function setCfg(brand, b, by) {
  if (!BRANDS[brand]) return { error: 'Brand không hợp lệ' };
  const old = cfg(brand) || {};
  const from = String(b.from || '').trim().toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(from)) return { error: 'Địa chỉ email gửi không hợp lệ' };
  const host = String(b.host || 'smtp.larksuite.com').trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,100}$/.test(host)) return { error: 'Máy chủ SMTP không hợp lệ' };
  const port = Number(b.port) || 465;
  if (![465, 587].includes(port)) return { error: 'Cổng chỉ nhận 465 hoặc 587' };
  let pass = String(b.pass || '');
  if (!pass) pass = old.pass || ''; // de trong = giu mat khau cu
  if (!pass || pass.length > 200) return { error: 'Thiếu mật khẩu SMTP' };
  const name = String(b.name || BRANDS[brand]).trim().slice(0, 60);
  store.kvSet('mail_' + brand, JSON.stringify({ from, name, host, port, pass, by, at: new Date().toISOString(), lastTest: null }));
  return { ok: true };
}

function view() {
  const out = {};
  for (const k of Object.keys(BRANDS)) {
    const c = cfg(k);
    out[k] = c ? { configured: true, label: BRANDS[k], from: c.from, name: c.name, host: c.host, port: c.port, by: c.by, at: c.at, lastTest: c.lastTest || null } : { configured: false, label: BRANDS[k] };
  }
  return out;
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const encWord = (s) => /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');

function buildMessage(c, to, subject, text, html) {
  const bnd = 'b_' + crypto.randomBytes(12).toString('hex');
  const domain = c.from.split('@')[1];
  const h = [
    'From: ' + encWord(c.name) + ' <' + c.from + '>',
    'To: <' + to + '>',
    'Subject: ' + encWord(subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + bnd + '"',
  ];
  const parts = ['--' + bnd, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(text || ''))];
  if (html) parts.push('--' + bnd, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap76(b64(html)));
  parts.push('--' + bnd + '--', '');
  // dot-stuffing (base64 khong bat dau bang '.', nhung van lam cho an toan)
  return (h.join('\r\n') + '\r\n\r\n' + parts.join('\r\n')).replace(/\r\n\./g, '\r\n..');
}

// Doc tung phan hoi SMTP (nhieu dong "250-..." ket thuc bang "250 ...").
function reader(sock) {
  let buf = ''; let waiting = null; const queue = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let m;
    while ((m = buf.match(/^(?:\d{3}-[^\r\n]*\r?\n)*\d{3}(?: [^\r\n]*)?\r?\n/))) {
      const resp = m[0]; buf = buf.slice(resp.length);
      const code = Number(resp.slice(0, 3));
      if (waiting) { const w = waiting; waiting = null; w({ code, text: resp.trim() }); } else queue.push({ code, text: resp.trim() });
    }
  };
  let closed = null;
  const onEnd = (e) => { closed = (e && e.message) || 'Máy chủ email ngắt kết nối'; if (waiting) { const w = waiting; waiting = null; w({ code: 0, text: closed }); } };
  sock.on('data', onData); sock.on('close', onEnd); sock.on('error', onEnd);
  return {
    next: () => new Promise((res) => { if (queue.length) res(queue.shift()); else if (closed) res({ code: 0, text: closed }); else waiting = res; }),
    detach: () => { sock.removeListener('data', onData); sock.removeListener('close', onEnd); sock.removeListener('error', onEnd); },
  };
}

async function send(brand, to, subject, text, html) {
  const c = cfg(brand);
  if (!c) return { error: 'Chưa cài email cho brand ' + (BRANDS[brand] || brand) };
  to = String(to || '').trim();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(to)) return { error: 'Email người nhận không hợp lệ' };
  let sock;
  const timer = setTimeout(() => sock && sock.destroy(new Error('Hết thời gian chờ máy chủ email (20 giây)')), 20000);
  try {
    let rd;
    const expect = async (ok, step) => { const r = await rd.next(); if (!ok.includes(r.code)) throw new Error(step + ': ' + r.text.slice(0, 200)); return r; };
    const cmd = (line) => sock.write(line + '\r\n');
    if (c.port === 465) {
      sock = tls.connect({ host: c.host, port: 465, servername: c.host });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      rd = reader(sock);
      await expect([220], 'Kết nối');
      cmd('EHLO saas.7zone.net'); await expect([250], 'EHLO');
    } else {
      const raw = net.connect({ host: c.host, port: 587 });
      sock = raw;
      await new Promise((res, rej) => { raw.once('connect', res); raw.once('error', rej); });
      rd = reader(raw);
      await expect([220], 'Kết nối');
      cmd('EHLO saas.7zone.net'); await expect([250], 'EHLO');
      cmd('STARTTLS'); await expect([220], 'STARTTLS');
      rd.detach();
      sock = tls.connect({ socket: raw, servername: c.host });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
      rd = reader(sock);
      cmd('EHLO saas.7zone.net'); await expect([250], 'EHLO');
    }
    sock.on('error', () => {});
    cmd('AUTH LOGIN'); await expect([334], 'Đăng nhập');
    cmd(b64(c.from)); await expect([334], 'Đăng nhập');
    cmd(b64(c.pass)); await expect([235], 'Sai email hoặc mật khẩu SMTP');
    cmd('MAIL FROM:<' + c.from + '>'); await expect([250], 'Người gửi');
    cmd('RCPT TO:<' + to + '>'); await expect([250, 251], 'Người nhận');
    cmd('DATA'); await expect([354], 'Gửi nội dung');
    sock.write(buildMessage(c, to, subject, text, html) + '\r\n.\r\n');
    const fin = await expect([250], 'Gửi nội dung');
    cmd('QUIT');
    return { ok: true, resp: fin.text.slice(0, 120) };
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
    if (sock) setTimeout(() => sock.destroy(), 500);
  }
}

// Gui thu (admin bam): ghi ket qua lan thu gan nhat.
async function test(brand, to, by) {
  const c = cfg(brand);
  if (!c) return { error: 'Chưa cài email cho brand này' };
  const name = BRANDS[brand];
  const r = await send(brand, to, 'Thử gửi email từ hệ thống ' + name,
    'Email thử từ hệ thống ' + name + ' (người bấm: ' + by + '). Nhận được thư này là cài đặt gửi email đã chạy.',
    '<p>Email thử từ hệ thống <b>' + name + '</b> (người bấm: ' + by + ').</p><p>Nhận được thư này là cài đặt gửi email đã chạy.</p>');
  c.lastTest = { at: new Date().toISOString(), ok: !!r.ok, to, msg: r.error || r.resp || '' };
  store.kvSet('mail_' + brand, JSON.stringify(c));
  return r;
}

// Brand theo nhom khach Gobiz: vmtglobal -> vmtglobal, con lai -> vominhthien (giong trang khach).
const brandOfGroup = (g) => String(g || '').toLowerCase() === 'vmtglobal' ? 'vmtglobal' : 'vominhthien';

module.exports = { init, BRANDS, setCfg, view, send, test, brandOfGroup, _buildMessage: buildMessage };
