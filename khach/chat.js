/* Chat theo don (trang khach). File rieng, KHONG thuoc template; may chu tu chen vao cuoi index.html.
   Dung lai ham chung cua trang: I (icon), esc, toast, ALL, TYPES, openDetail, lab, findX, ME.
   Duong dan: #tin-nhan (danh sach) · #tin-nhan/<id> · #tin-nhan/vmt · #tin-nhan/don/<ma don> */
(function () {
  'use strict';
  if (window.__vmtChat) return; window.__vmtChat = 1;
  const $ = (s, r) => (r || document).querySelector(s);
  const isM = () => matchMedia('(max-width:767px)').matches;
  const SV = (d, w) => `<span class="icon" aria-hidden="true"><svg class="chs" viewBox="0 0 24 24" width="${w || 20}" height="${w || 20}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg></span>`;
  const IC = {
    reply: SV('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', 18),
    smile: SV('<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8"/><path d="M9 9.5h.01M15 9.5h.01"/>'),
    camera: SV('<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>'),
    hash: SV('<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>'),
    send: SV('<path d="M5 12 3 4l18 8-18 8 2-8zm0 0h7"/>', 22),
    back: SV('<path d="M15 5 8 12l7 7"/>', 24),
    undo: SV('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>', 18),
    copy: SV('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>', 18),
    bell: SV('<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>', 18),
    bellOff: SV('<path d="M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8"/><path d="M10 20a2 2 0 0 0 4 0M3 3l18 18"/>', 18),
    more: SV('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>', 18),
  };
  const ico = (n) => (window.ICONS && ICONS[n] ? I(n) : '');
  const EMO = ['❤️', '👍', '😂', '😮', '😢', '😡'];
  const KN = { order: 'Đặt hàng', ship: 'Ký gửi', peer: 'Thanh toán hộ', cn: 'Ship to China', vmt: 'Chung' };
  const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Lỗi, thử lại'); return j; });
  const getJ = (u) => fetch(u, { cache: 'no-store' }).then(async (r) => { if (r.status === 401) { location.href = '/login'; throw new Error('login'); } const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Lỗi, thử lại'); return j; });
  const tHM = (s) => new Date(s).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const dayL = (s) => { const d = new Date(s), n = new Date(); const k = (x) => x.toDateString(); if (k(d) === k(n)) return 'Hôm nay'; const y = new Date(n); y.setDate(n.getDate() - 1); if (k(d) === k(y)) return 'Hôm qua'; return d.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' }); };
  const shortT = (s) => { if (!s) return ''; const d = new Date(s), n = new Date(); if (d.toDateString() === n.toDateString()) return tHM(s); const m = (n - d) / 864e5; return m < 6 ? d.toLocaleDateString('vi-VN', { weekday: 'short' }) : d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }); };
  const inHours = () => { const v = new Date(Date.now() + 7 * 3600e3); const d = v.getUTCDay(), m = v.getUTCHours() * 60 + v.getUTCMinutes(); return d >= 1 && d <= 6 && m >= 510 && m < 1080; };
  const initials = (n) => { const w = String(n || 'NV').trim().split(/\s+/); return (w.length > 1 ? w[w.length - 2][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase(); };
  const xOf = (code) => (typeof findX === 'function' ? findX(code) : null);
  const kOf = (code) => { const x = xOf(code); return x ? x.k : null; };

  // ---------- CSS ----------
  const css = `
svg.chs{fill:none!important}
.ch-wrap{display:grid;gap:14px}
.ch-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.ch-head h1{margin:0}
.ch-snd{display:inline-flex;align-items:center;gap:6px;border:1px solid #e1d7c5;background:#fffdf6;border-radius:999px;padding:6px 11px;font-size:12px;font-weight:700;color:#6f6656}
.ch-hint{font-size:12px;color:#8b8170;margin:-6px 4px 0}
.ch-list{padding:6px}
.ch-row{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:11px;align-items:center;padding:11px 10px;border-radius:16px;width:100%;text-align:left;background:none;border:0;color:inherit;cursor:pointer}
.ch-row+.ch-row{border-top:1px solid #f0e9db}
.ch-row.on{background:var(--b-soft)}
.ch-row .icon-tile{width:46px;height:46px;border-radius:15px}
.ch-row b{display:block;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-row small{display:block;color:#8b8170;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.ch-row.unread small{color:#2f2a20;font-weight:700}
.ch-row .ch-meta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;font-size:11px;color:#8b8170}
.ch-badge{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:#e5484d;color:#fff;font-size:11px;font-weight:800;display:inline-grid;place-items:center}
.ch-empty{padding:18px 14px;color:#6f6656;font-size:13px;line-height:1.55;text-align:center}
.ch-empty .secondary-button{margin-top:10px}
.ch-tabdot{position:absolute;top:2px;left:calc(50% + 6px);min-width:17px;height:17px;padding:0 5px;border-radius:999px;background:#e5484d;color:#fff;font-size:10px;font-weight:800;display:grid;place-items:center;font-style:normal;box-shadow:0 0 0 2px #fff}
[data-mt="tin-nhan"]{position:relative}
.nav-link .ch-badge{margin-left:auto}
/* cuoc chat */
.ch-t{display:flex;flex-direction:column;min-height:0;background:#f7f3ea}
.ch-t[hidden]{display:none!important}
.ch-tb{display:flex;align-items:center;gap:8px;padding:8px 10px;background:#fffdf8;border-bottom:1px solid #ece4d4}
.ch-tb .icon-button{flex:none}
.ch-tt{min-width:0;flex:1}.ch-tt b{display:block;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ch-tt small{display:block;color:#8b8170;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-oc{display:flex;align-items:center;gap:10px;margin:8px 10px 0;padding:9px 11px;border-radius:14px;background:#fffdf8;border:1px solid #ece4d4;cursor:pointer;text-align:left;width:calc(100% - 20px);color:inherit;font:inherit}
.ch-oc .icon-tile{width:36px;height:36px;border-radius:12px;flex:none}.ch-oc span{min-width:0;flex:1}.ch-oc b{display:block;font-size:13px}.ch-oc small{display:block;font-size:12px;color:#8b8170;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-ooh{margin:8px 10px 0;padding:8px 11px;border-radius:12px;background:#fff6dc;color:#7a5a12;font-size:12px;line-height:1.45}
.ch-ms{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:10px 10px 6px;-webkit-overflow-scrolling:touch}
.ch-day{text-align:center;margin:12px 0 8px}.ch-day span{display:inline-block;font-size:11px;font-weight:700;color:#8b8170;background:#efe8da;border-radius:999px;padding:3px 10px}
.ch-g{display:flex;gap:7px;align-items:flex-end;margin-top:8px}
.ch-g.me{justify-content:flex-end}
.ch-av{width:28px;height:28px;border-radius:50%;flex:none;display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--b-ink);background:linear-gradient(120deg,var(--b-1),var(--b-2))}
.ch-av.sp{visibility:hidden}
.ch-col{display:flex;flex-direction:column;gap:2px;max-width:78%;min-width:0}
.ch-g.me .ch-col{align-items:flex-end}
.ch-nm{font-size:11px;color:#8b8170;margin:0 0 1px 4px}
.ch-b{position:relative;padding:8px 11px;border-radius:18px;background:#fff;border:1px solid #ece4d4;font-size:15px;line-height:1.42;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text;-webkit-touch-callout:none}
.ch-g.me .ch-b{background:linear-gradient(120deg,var(--b-soft2),var(--b-soft));border-color:transparent;color:var(--b-ink)}
.ch-b.rc{background:none!important;border:1px dashed #d8cfbd;color:#8b8170;font-style:italic;font-size:13px}
.ch-b.img{padding:3px;background:#fff}
.ch-b a{color:inherit;text-decoration:underline}
.ch-b .ch-code{display:inline-block;padding:0 6px;border-radius:7px;background:#ffffffb3;border:1px solid #e1d7c5;font-weight:800;text-decoration:none;cursor:pointer}
.ch-q{display:block;margin:-2px -4px 6px;padding:5px 8px;border-left:3px solid var(--b-3);border-radius:8px;background:#0000000a;font-size:12px;color:#6f6656;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.ch-imgs{display:grid;gap:3px;grid-template-columns:repeat(2,minmax(0,1fr))}
.ch-imgs.one{grid-template-columns:1fr}
.ch-imgs img{width:100%;max-height:300px;min-height:80px;object-fit:cover;border-radius:15px;display:block;cursor:zoom-in;background:#efe8da}
.ch-imgs.one img{max-width:240px;max-height:320px;width:auto}
.ch-card{display:flex;align-items:center;gap:10px;min-width:210px;cursor:pointer;text-align:left}
.ch-card .icon-tile{width:38px;height:38px;border-radius:12px;flex:none}
.ch-card b{display:block;font-size:14px}.ch-card small{display:block;font-size:12px;color:#6f6656}
.ch-lk{display:block;margin-top:6px;padding:7px 9px;border-radius:11px;background:#ffffffb3;border:1px solid #e1d7c5;font-size:12px;font-weight:700;text-decoration:none!important}
.ch-re{display:flex;gap:3px;flex-wrap:wrap;margin-top:-6px;padding:0 6px;z-index:1}
.ch-re button{display:inline-flex;align-items:center;gap:2px;font-size:12px;padding:1px 6px;border-radius:999px;background:#fff;border:1px solid #e6dcc9;box-shadow:0 1px 2px #0000000d;color:#6f6656;font-weight:700}
.ch-re button.mine{border-color:var(--b-3);background:var(--b-soft)}
.ch-st{font-size:11px;color:#8b8170;margin:1px 4px 0}
.ch-sys{text-align:center;margin:10px 18px}.ch-sys span{display:inline-block;font-size:12px;line-height:1.5;color:#6f6656;background:#efe8da;border-radius:12px;padding:6px 11px}
.ch-bw{position:relative;max-width:100%}
.ch-g{transition:transform .15s ease-out;position:relative}
.ch-g.sw{transition:none}
.ch-swi{position:absolute;left:-30px;top:50%;margin-top:-14px;width:28px;height:28px;border-radius:50%;background:#efe8da;color:#6f6656;display:grid;place-items:center;opacity:0}
.ch-tools{display:none;align-self:center;gap:3px;flex:none}
@media (hover:hover){.ch-g:hover .ch-tools{display:flex}}
.ch-tools button{width:30px;height:30px;border-radius:50%;border:1px solid #ece4d4;background:#fffdf8;color:#6f6656;display:grid;place-items:center;padding:0;font-size:15px}
.ch-tools button:hover{background:var(--b-soft)}
.ch-qh{position:absolute;right:-9px;bottom:-9px;width:24px;height:24px;border-radius:50%;border:1px solid #e6dcc9;background:#fff;color:#a89d86;display:grid;place-items:center;padding:0;font-size:12px;box-shadow:0 1px 3px #0000001a;z-index:1}
.ch-g.me .ch-qh{right:auto;left:-9px}
.ch-bar{position:fixed;z-index:96;display:flex;align-items:center;gap:2px;padding:5px 6px;border-radius:999px;background:#fffdf8;border:1px solid #ece4d4;box-shadow:0 10px 28px -8px #3d2f1666;animation:chIn .15s ease-out}
.ch-bar button{border:0;background:none;font-size:25px;line-height:1;padding:5px;border-radius:50%;transition:transform .1s}
.ch-bar button:active,.ch-bar button:hover{transform:scale(1.25)}
.ch-bar button.mine{background:var(--b-soft)}
.ch-bar i{width:1px;height:24px;background:#ece4d4;margin:0 3px}
.ch-bar .t{font-size:13px;font-weight:700;color:#4c4436;padding:6px 8px;display:flex;align-items:center;gap:4px;border-radius:999px}
.ch-bar .t:hover{transform:none;background:#f3ecdf}
.ch-vid{display:block;max-width:260px;width:100%;max-height:340px;border-radius:15px;background:#000}
.ch-pv video{width:100%;height:100%;object-fit:cover}
.ch-typ{font-size:12px;color:#8b8170;padding:2px 14px 6px;min-height:18px}
.ch-typ i{display:inline-block;width:5px;height:5px;border-radius:50%;background:#b3a88f;margin-right:2px;animation:chTy 1s infinite}.ch-typ i:nth-child(2){animation-delay:.15s}.ch-typ i:nth-child(3){animation-delay:.3s;margin-right:6px}
@keyframes chTy{0%,80%,100%{opacity:.25}40%{opacity:1}}
.ch-more{display:block;margin:4px auto 8px;font-size:12px;font-weight:700;color:#6f6656;background:#efe8da;border:0;border-radius:999px;padding:5px 12px}
.ch-cp{background:#fffdf8;border-top:1px solid #ece4d4;padding:7px 8px calc(7px + env(safe-area-inset-bottom,0px))}
.ch-rb{display:flex;align-items:center;gap:8px;padding:5px 8px 7px;font-size:12px;color:#6f6656}.ch-rb span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:3px solid var(--b-3);padding-left:7px}.ch-rb button{border:0;background:none;color:#8b8170;font-size:18px;line-height:1}
.ch-pv{display:flex;gap:6px;overflow-x:auto;padding:2px 2px 8px}.ch-pv span{position:relative;flex:none;width:62px;height:62px;border-radius:12px;overflow:hidden;background:#efe8da}.ch-pv img{width:100%;height:100%;object-fit:cover}.ch-pv em{position:absolute;inset:0;display:grid;place-items:center;background:#0006;color:#fff;font-style:normal;font-size:11px;font-weight:800}.ch-pv button{position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;border:0;background:#000a;color:#fff;font-size:12px;line-height:20px;padding:0}
.ch-row2{display:flex;align-items:flex-end;gap:4px}
.ch-row2 .ch-ib{flex:none;width:40px;height:40px;border-radius:13px;border:0;background:none;color:#6f6656;display:grid;place-items:center;padding:0}
.ch-row2 textarea{flex:1;min-width:0;resize:none;max-height:130px;min-height:40px;box-sizing:border-box;border:1px solid #e1d7c5;border-radius:20px;padding:9px 13px;font:inherit;font-size:16px;line-height:1.35;background:#fff;color:#2f2a20;outline:none}
.ch-row2 textarea:focus{border-color:var(--b-3)}
.ch-row2 .ch-send{flex:none;width:42px;height:42px;border-radius:50%;border:0;display:grid;place-items:center;color:var(--b-ink);background:linear-gradient(120deg,var(--b-1),var(--b-2));padding:0}
.ch-row2 .ch-send:disabled{opacity:.45}
.ch-sheet{position:fixed;inset:0;z-index:90;background:#2b241a59;display:flex;align-items:flex-end;justify-content:center}
.ch-sheet>div{width:min(520px,100%);background:#fffdf8;border-radius:22px 22px 0 0;padding:12px 12px calc(14px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 30px -12px #0004;max-height:80vh;overflow:auto}
.ch-emo{display:flex;justify-content:space-between;padding:4px 6px 10px}.ch-emo button{font-size:28px;background:none;border:0;padding:4px;border-radius:12px;line-height:1}.ch-emo button.mine{background:var(--b-soft)}
.ch-act{display:grid;gap:2px}.ch-act button{display:flex;align-items:center;gap:12px;padding:12px;border:0;background:none;border-radius:12px;font-size:15px;font-weight:600;color:#2f2a20;text-align:left}.ch-act button:active{background:#f3ecdf}.ch-act button.red{color:#b5310a}
.ch-pk input{width:100%;box-sizing:border-box;border:1px solid #e1d7c5;border-radius:12px;padding:10px 12px;font-size:16px;margin-bottom:8px}
.ch-pk h3{margin:2px 4px 10px;font-size:16px}
.ch-pop{position:fixed;left:10px;right:10px;top:calc(env(safe-area-inset-top,0px) + 8px);z-index:95;display:flex;gap:10px;align-items:center;padding:11px 13px;border-radius:16px;background:#fffdf8;box-shadow:0 12px 30px -10px #3d2f1666;border:1px solid #ece4d4;cursor:pointer;animation:chIn .2s ease-out}
.ch-pop span{min-width:0;flex:1}.ch-pop b{display:block;font-size:13px}.ch-pop small{display:block;font-size:13px;color:#4c4436;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes chIn{from{transform:translateY(-20px);opacity:0}}
@media (min-width:768px){.ch-pop{left:auto;right:20px;width:340px;top:76px}}
.ch-iv{position:fixed;inset:0;z-index:99;background:#000e;display:grid;place-items:center}.ch-iv img{max-width:100vw;max-height:100dvh;object-fit:contain}
@media (max-width:767px){
 .ch-t{position:fixed;left:0;right:0;top:0;height:100dvh;z-index:80}
 .ch-t .ch-tb{padding-top:calc(8px + env(safe-area-inset-top,0px))}
 html.ch-lock,html.ch-lock body{overflow:hidden}
 html.ch-lock .m-tabbar{display:none}
}
@media (min-width:768px){
 .ch-wrap.split{grid-template-columns:minmax(260px,340px) minmax(0,1fr);align-items:start}
 .ch-wrap.split .ch-side{grid-row:1/span 3}
 .ch-t{height:calc(100dvh - 150px);min-height:460px;border-radius:22px;overflow:hidden;border:1px solid #fff;box-shadow:var(--shadow-glass)}
}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ---------- trang thai ----------
  const S = { hello: 0, list: [], loaded: false, cur: null, msgs: [], more: false, reply: null, att: [], seen: 0, typingT: 0, typingName: '', sendT: 0, live: false, busy: false };
  let unreadN = (window.ME && ME.chatUnread) || 0;
  let soundOn = true; try { soundOn = localStorage.getItem('vmt_chat_snd') !== '0'; } catch (e) {}

  // ---------- so do (thanh duoi + menu) ----------
  function badge() {
    const n = S.loaded ? S.list.filter((t) => t.unread > 0).length : unreadN;
    unreadN = n;
    const a = document.querySelector('.m-tabbar [data-mt="tin-nhan"]');
    if (a) { let d = a.querySelector('.ch-tabdot'); if (!d) { d = document.createElement('em'); d.className = 'ch-tabdot'; a.appendChild(d); } d.hidden = !n; d.textContent = n > 9 ? '9+' : n; }
    const l = document.querySelector('.nav-link[data-v="tin-nhan"]');
    if (l) { let d = l.querySelector('.ch-badge'); if (!d) { d = document.createElement('em'); d.className = 'ch-badge'; d.style.fontStyle = 'normal'; l.appendChild(d); } d.hidden = !n; d.textContent = n > 9 ? '9+' : n; }
    try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch (e) {}
  }
  function sideLink() { // menu may tinh: them muc "Tin nhan" duoi Tong quan
    if (document.querySelector('.nav-link[data-v="tin-nhan"]')) return;
    const first = document.querySelector('.navigation .nav-group ul'); if (!first) return;
    const li = document.createElement('li');
    li.innerHTML = `<a class="nav-link" href="#tin-nhan" data-v="tin-nhan">${ico('chats')}<span class="nav-label">Tin nhắn</span></a>`;
    first.appendChild(li);
  }

  // ---------- am bao ----------
  let ac = null; const lastSnd = new Map();
  addEventListener('pointerdown', () => { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } else if (ac.state === 'suspended') ac.resume(); }, { passive: true });
  function ding(th) {
    if (!soundOn || !ac) return;
    const now = Date.now(); if (now - (lastSnd.get(th) || 0) < 60e3) { lastSnd.set(th, now); return; } lastSnd.set(th, now);
    try {
      const t0 = ac.currentTime;
      for (const [f, d] of [[880, 0], [1320, 0.11]]) { const o = ac.createOscillator(), g = ac.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0 + d); g.gain.exponentialRampToValueAtTime(0.18, t0 + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.22); o.connect(g).connect(ac.destination); o.start(t0 + d); o.stop(t0 + d + 0.25); }
    } catch (e) {}
  }

  // ---------- danh sach ----------
  const view = () => document.getElementById('v-tin-nhan');
  const tTitle = (t) => (t.ctx === 'vmt' ? 'Chat' : (KN[t.kind] && t.kind !== 'vmt' ? KN[t.kind] + ' · ' : 'Đơn ') + t.code);
  const tIcon = (t) => { const m = { vmt: ['chats', 'tile-success'], order: ['shopping-bag', 'tile-amber'], ship: ['package', 'tile-neutral'], peer: ['wallet', 'tile-amber'], cn: ['truck', 'tile-success'] }[t.kind] || ['clipboard-text', 'tile-neutral']; return `<span class="icon-tile ${m[1]}">${ico(m[0])}</span>`; };
  function preview(t) {
    if (!t.lastId) return t.ctx === 'vmt' ? 'Hỏi bất cứ điều gì, nhân viên trả lời ngay trong giờ làm việc' : 'Chưa có tin nhắn';
    const who = t.lastFrom === 'k' ? 'Bạn: ' : t.lastFrom === 'sys' ? '' : (t.lastName ? t.lastName.split(/\s+/).pop() + ': ' : '');
    return (t.unread > 1 ? t.unread + ' tin mới · ' : '') + who + (t.lastText || '');
  }
  function rowHtml(t) {
    const on = S.cur && ((S.cur.id && S.cur.id === t.id) || (!S.cur.id && S.cur.ctx === t.ctx));
    return `<button type="button" class="ch-row${t.unread ? ' unread' : ''}${on ? ' on' : ''}" data-chopen="${t.id ? t.id : t.ctx}">${tIcon(t)}<span><b>${esc(tTitle(t))}</b><small>${esc(preview(t))}</small></span><span class="ch-meta">${t.lastAt ? shortT(t.lastAt) : ''}${t.unread ? `<span class="ch-badge">${t.unread > 9 ? '9+' : t.unread}</span>` : ''}</span></button>`;
  }
  function renderList() {
    const v = view(); if (!v) return;
    let w = $('.ch-wrap', v);
    if (!w) {
      v.innerHTML = `<div class="ch-wrap"><div class="ch-side"><header class="commerce-heading ch-head"><div><h1>Tin nhắn<span>.</span></h1></div><button type="button" class="ch-snd" data-chsnd></button></header><p class="ch-hint"></p><section class="glass-card ch-list" id="chList" style="margin-top:12px"></section></div></div>`;
      w = $('.ch-wrap', v);
    }
    $('[data-chsnd]', v).innerHTML = (soundOn ? IC.bell : IC.bellOff) + (soundOn ? 'Âm báo: bật' : 'Âm báo: tắt');
    $('.ch-hint', v).textContent = (inHours() ? 'Nhân viên đang trực, ' : 'Ngoài giờ làm việc, ') + 'giờ làm việc Thứ Hai – Thứ Bảy, 8:30 – 18:00.';
    const vmt = S.list.find((t) => t.ctx === 'vmt') || { id: 0, ctx: 'vmt', kind: 'vmt', unread: 0 };
    const others = S.list.filter((t) => t.ctx !== 'vmt');
    $('#chList', v).innerHTML = rowHtml(vmt) + others.map(rowHtml).join('') +
      (others.length ? '' : `<div class="ch-empty">Muốn hỏi về đơn nào thì mở đơn đó rồi bấm <b>Chat về đơn này</b>, hoặc chọn đơn ở dưới. Nhân viên thấy ngay đơn anh/chị đang hỏi.<br><button type="button" class="secondary-button" data-chpick="open">${IC.hash} Hỏi về một đơn</button></div>`) +
      (others.length ? `<div style="padding:8px 10px 4px"><button type="button" class="secondary-button" style="width:100%" data-chpick="open">${IC.hash} Hỏi về một đơn khác</button></div>` : '');
    place();
  }
  async function loadList() {
    try { const j = await getJ('/api/chat'); S.list = j.threads || []; S.loaded = true; badge(); if (!view().hidden) renderList(); } catch (e) {}
  }
  let listT = 0; const loadListSoon = () => { clearTimeout(listT); listT = setTimeout(loadList, 400); };

  // ---------- cuoc chat ----------
  let T = null; // phan tu cuoc chat
  function buildT() {
    T = document.createElement('section'); T.className = 'ch-t'; T.hidden = true;
    T.innerHTML = `<div class="ch-tb"><button type="button" class="icon-button" data-chback aria-label="Quay lại">${IC.back}</button><div class="ch-tt"><b id="chTitle"></b><small id="chSub"></small></div></div>
<div id="chOc"></div><div id="chOoh"></div><div class="ch-ms" id="chMs"></div><div class="ch-typ" id="chTyp"></div>
<div class="ch-cp"><div id="chRb"></div><div class="ch-pv" id="chPv" hidden></div><div class="ch-row2">
<button type="button" class="ch-ib" data-chimg aria-label="Gửi ảnh / video">${IC.camera}</button><button type="button" class="ch-ib" data-chpick="card" aria-label="Gửi mã đơn">${IC.hash}</button>
<textarea id="chIn" rows="1" placeholder="Nhắn tin…" enterkeyhint="send"></textarea><button type="button" class="ch-send" id="chSend" aria-label="Gửi" disabled>${IC.send}</button></div>
<input type="file" id="chFile" accept="image/*,video/*" multiple hidden></div>`;
    document.body.appendChild(T);
    // khong de "keo xuong tai lai" cua trang chay khi dang cuon tin nhan
    T.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    const inp = $('#chIn', T);
    inp.addEventListener('input', () => { grow(); upd(); typingPing(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isM()) { e.preventDefault(); sendNow(); } });
    inp.addEventListener('paste', (e) => { const fs = [...(e.clipboardData ? e.clipboardData.files : [])].filter((f) => /^image\//.test(f.type)); if (fs.length) { e.preventDefault(); addFiles(fs); } });
    $('#chSend', T).addEventListener('click', sendNow);
    $('#chFile', T).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
    $('[data-chimg]', T).addEventListener('click', () => $('#chFile', T).click());
    $('#chMs', T).addEventListener('scroll', () => { const m = $('#chMs', T); if (m.scrollTop < 40 && S.more && !S.busy) older(); });
    T.addEventListener('dragover', (e) => e.preventDefault());
    T.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...(e.dataTransfer ? e.dataTransfer.files : [])].filter((f) => /^image\//.test(f.type))); });
    // ban phim iPhone: giu o nhap tren ban phim
    if (window.visualViewport) { const fit = () => { if (!isM() || T.hidden) { T.style.height = ''; T.style.top = ''; return; } T.style.height = visualViewport.height + 'px'; T.style.top = visualViewport.offsetTop + 'px'; }; visualViewport.addEventListener('resize', fit); visualViewport.addEventListener('scroll', fit); }
    // Cu chi kieu Zalo: giu-bam -> thanh cam xuc; vuot sang phai -> tra loi; cham 2 lan -> tha tim
    const ms = $('#chMs', T);
    let g = null; // { el, mid, x, y, dx, mode, lp }
    ms.addEventListener('touchstart', (e) => {
      const b = e.target.closest('.ch-b[data-mid], .ch-qh'); const row = e.target.closest('.ch-g[data-g]'); if (!row) return;
      const mid = +row.dataset.g; const t0 = e.touches[0];
      g = { el: row, mid, x: t0.clientX, y: t0.clientY, dx: 0, mode: null, lp: b && !e.target.closest('video,a') ? setTimeout(() => { if (g && !g.mode) { g.mode = 'lp'; try { navigator.vibrate && navigator.vibrate(12); } catch (x) {} bar(mid); } }, 420) : 0 };
    }, { passive: true });
    ms.addEventListener('touchmove', (e) => {
      if (!g) return; const t0 = e.touches[0]; const dx = t0.clientX - g.x, dy = t0.clientY - g.y;
      if (!g.mode && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) { clearTimeout(g.lp); g.mode = Math.abs(dx) > Math.abs(dy) * 1.3 && dx > 0 && !S.msgs.find((m) => m.id === g.mid && m.recalled) ? 'sw' : 'scroll'; if (g.mode === 'sw') g.el.classList.add('sw'); }
      if (g.mode === 'sw') { g.dx = Math.max(0, Math.min(dx, 90)); g.el.style.transform = 'translateX(' + g.dx + 'px)'; const ic = g.el.querySelector('.ch-swi'); if (ic) { ic.style.opacity = Math.min(1, g.dx / 60); ic.style.background = g.dx > 60 ? 'var(--b-soft2)' : ''; } }
    }, { passive: true });
    let lastTap = { mid: 0, at: 0 };
    ms.addEventListener('touchend', (e) => {
      if (!g) return; clearTimeout(g.lp); const cur = g; g = null;
      if (cur.mode === 'sw') { cur.el.classList.remove('sw'); cur.el.style.transform = ''; const ic = cur.el.querySelector('.ch-swi'); if (ic) ic.style.opacity = 0; if (cur.dx > 60) { const m = S.msgs.find((x) => x.id === cur.mid); if (m) { S.reply = m; renderRb(); try { navigator.vibrate && navigator.vibrate(8); } catch (x) {} $('#chIn', T).focus(); } } return; }
      if (cur.mode) return;
      if (!e.target.closest('.ch-b[data-mid]') || e.target.closest('a,video,img,[data-chord],.ch-q')) return;
      const now = Date.now();
      if (lastTap.mid === cur.mid && now - lastTap.at < 320) { lastTap = { mid: 0, at: 0 }; e.preventDefault(); react(cur.mid, '❤️', true); } else lastTap = { mid: cur.mid, at: now };
    });
    ms.addEventListener('touchcancel', () => { if (g) { clearTimeout(g.lp); g.el.classList.remove('sw'); g.el.style.transform = ''; g = null; } });
    ms.addEventListener('contextmenu', (e) => { const b = e.target.closest('.ch-b[data-mid]'); if (b && !e.target.closest('a,video')) { e.preventDefault(); bar(+b.dataset.mid); } });
    ms.addEventListener('scroll', () => { const o = $('.ch-bar'); if (o) o.remove(); }, { passive: true });
  }
  function place() { // dien thoai: lop phu toan man hinh; may tinh: cot ben phai danh sach
    if (!T) return; const w = $('.ch-wrap', view() || document);
    if (!isM() && w) { if (T.parentNode !== w) w.appendChild(T); w.classList.toggle('split', !T.hidden); }
    else if (T.parentNode !== document.body) { document.body.appendChild(T); if (w) w.classList.remove('split'); }
    document.documentElement.classList.toggle('ch-lock', isM() && !T.hidden);
  }
  addEventListener('resize', () => { if (T) place(); });
  const grow = () => { const i = $('#chIn', T); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight + 2, 130) + 'px'; };
  const upd = () => { $('#chSend', T).disabled = !($('#chIn', T).value.trim() || S.att.some((a) => a.id)) || S.att.some((a) => !a.id && !a.err); };

  async function openThread(key) {
    if (!T) buildT();
    // key: so id | 'vmt' | 'don:<ma>'
    const isCtx = typeof key === 'string' && !/^\d+$/.test(key);
    const ctx = isCtx ? key : null; const id = isCtx ? null : +key;
    if (S.cur && ((id && S.cur.id === id) || (ctx && S.cur.ctx === ctx))) { T.hidden = false; place(); markRead(); return; }
    S.cur = { id, ctx: ctx || null }; S.msgs = []; S.more = false; S.reply = null; S.att = []; S.seen = 0; S.typingT = 0;
    T.hidden = false; $('#chIn', T).value = ''; grow(); renderPv(); renderRb();
    head(); $('#chMs', T).innerHTML = '<div class="ch-empty">Đang tải…</div>'; place(); if (S.loaded) renderList();
    try {
      const j = id ? await getJ('/api/chat/t/' + id) : await getJ('/api/chat/ctx?ctx=' + encodeURIComponent(ctx));
      if (!S.cur || (id && S.cur.id !== id) || (ctx && S.cur.ctx !== ctx)) return;
      if (j.thread) { S.cur = Object.assign(S.cur, j.thread); S.seen = j.thread.seenByStaff || 0; }
      S.msgs = j.msgs || []; S.more = S.msgs.length >= 50;
      head(); renderMsgs(true); markRead();
    } catch (e) { $('#chMs', T).innerHTML = `<div class="ch-empty">${esc(e.message)}</div>`; }
    if (!isM()) setTimeout(() => $('#chIn', T).focus(), 50);
  }
  function closeThread() { if (!T) return; T.hidden = true; S.cur = null; place(); if (S.loaded) renderList(); }
  function head() {
    const c = S.cur; const code = c.code || (c.ctx && c.ctx.startsWith('don:') ? c.ctx.slice(4) : null);
    const x = code ? xOf(code) : null; const k = c.kind || (x && x.k) || (code ? null : 'vmt');
    $('#chTitle', T).textContent = code ? (KN[k] && k !== 'vmt' ? KN[k] + ' · ' : 'Đơn ') + code : 'Chat';
    $('#chSub', T).textContent = inHours() ? 'Nhân viên đang trực · thường trả lời trong vài phút' : 'Ngoài giờ · trả lời trong ca làm việc';
    $('#chOc', T).innerHTML = x ? `<button type="button" class="ch-oc" data-chord="${esc(code)}">${tIcon({ kind: x.k })}<span><b>${esc(code)} · ${esc(typeof lab === 'function' ? lab(x) : '')}</b><small>${esc(orderLine(x))}</small></span>${ico('caret-right')}</button>` : '';
    $('#chOoh', T).innerHTML = inHours() ? '' : '<div class="ch-ooh">Đang ngoài giờ làm việc (Thứ Hai – Thứ Bảy, 8:30 – 18:00). Anh/chị cứ nhắn, có nhân viên trực là trả lời ngay.</div>';
  }
  function orderLine(x) {
    const it = (x.items || [])[0]; const n = it && (it.tname || it.name || it.nameCn);
    const parts = [];
    if (x.unpaid > 0 && typeof vnd === 'function') parts.push('Còn thiếu ' + vnd(x.unpaid));
    if (n) parts.push(n); else if (x.shop) parts.push(x.shop); else if (x.recvName) parts.push('Người nhận ' + x.recvName); else if (x.benName) parts.push(x.benName);
    return parts.join(' · ') || 'Bấm để xem chi tiết đơn';
  }

  // ---------- ve tin nhan ----------
  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  let codeSet = null; const codes = () => codeSet || (codeSet = new Set((window.ALL || (typeof ALL !== 'undefined' ? ALL : [])).map((x) => String(x.code))));
  function fmt(text) {
    return String(text || '').split(URL_RE).map((part, i) => {
      if (i % 2) { const host = (() => { try { return new URL(part).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })(); return `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part.length > 60 ? part.slice(0, 57) + '…' : part)}</a>${/taobao|tmall|1688|yangkeduo|pinduoduo/.test(host) ? `<a class="ch-lk" href="${esc(part)}" target="_blank" rel="noopener noreferrer">${ico('shopping-bag')} Sản phẩm ${esc(/1688/.test(host) ? '1688' : /tmall/.test(host) ? 'Tmall' : /yangkeduo|pinduoduo/.test(host) ? 'Pinduoduo' : 'Taobao')} · mở link</a>` : ''}`; }
      return esc(part).replace(/\b([A-Za-z]{0,4}\d[A-Za-z0-9]{4,18})\b/g, (m) => (codes().has(m) ? `<span class="ch-code" data-chord="${m}">${m}</span>` : m));
    }).join('');
  }
  function bubble(m) {
    if (m.recalled) return `<div class="ch-b rc" data-mid="${m.id}">Tin nhắn đã được thu hồi</div>`;
    let h = '';
    if (m.reply) h += `<span class="ch-q" data-chjump="${m.reply.id}">${IC.reply} ${esc(m.reply.f === 'k' ? 'Bạn' : (m.reply.name || 'Nhân viên'))}: ${esc(m.reply.recalled ? 'Tin đã thu hồi' : m.reply.body || (m.reply.vid ? '[Video]' : m.reply.img ? '[Ảnh]' : '[Đơn hàng]'))}</span>`;
    if (m.card) { const x = xOf(m.card.code); h += `<div class="ch-card" data-chord="${esc(m.card.code)}">${tIcon({ kind: m.card.k || (x && x.k) })}<span><b>${esc(m.card.code)}</b><small>${esc((KN[m.card.k] || 'Đơn hàng') + (x && typeof lab === 'function' ? ' · ' + lab(x) : ''))}</small></span></div>`; }
    if (m.body) h += (m.card ? '<div style="margin-top:6px">' : '') + fmt(m.body) + (m.card ? '</div>' : '');
    const pics = (m.att || []).filter((a) => a.t !== 'v'), vids = (m.att || []).filter((a) => a.t === 'v');
    const imgs = (pics.length ? `<div class="ch-imgs${pics.length === 1 ? ' one' : ''}">${pics.map((a) => `<img src="/u/${esc(a.id)}.jpg" alt="" loading="lazy" data-chiv>`).join('')}</div>` : '') +
      vids.map((a) => `<video class="ch-vid" src="/api/chat/f/${esc(a.id)}#t=0.1" controls playsinline preload="metadata"></video>`).join('');
    if (imgs && !h) return `<div class="ch-b img" data-mid="${m.id}">${imgs}</div>`;
    return `<div class="ch-b" data-mid="${m.id}">${h}${imgs ? '<div style="margin-top:6px">' + imgs + '</div>' : ''}</div>`;
  }
  const reacts = (m) => (m.re && m.re.length ? `<div class="ch-re">${m.re.map((r) => `<button type="button" class="${r.mine ? 'mine' : ''}" data-chre="${m.id}" data-e="${r.e}">${r.e}${r.n > 1 ? ' ' + r.n : ''}</button>`).join('')}</div>` : '');
  function renderMsgs(bottom) {
    const box = $('#chMs', T); const near = bottom || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const L = S.msgs; let h = S.more ? '<button type="button" class="ch-more" data-chold>Xem tin cũ hơn</button>' : '';
    if (!L.length) h += `<div class="ch-empty">${S.cur && S.cur.ctx && S.cur.ctx.startsWith('don:') ? 'Anh/chị cần hỏi gì về đơn này cứ nhắn ở đây, nhân viên thấy ngay đơn đang hỏi.' : 'Anh/chị cần gì cứ nhắn, gửi được cả ảnh, video và mã đơn.'}</div>`;
    let lastDay = '', lastMine = 0;
    for (const m of L) if (m.f === 'k' && !m.recalled) lastMine = m.id;
    for (let i = 0; i < L.length; i++) {
      const m = L[i], p = L[i - 1], n = L[i + 1];
      const d = new Date(m.at).toDateString(); if (d !== lastDay) { h += `<div class="ch-day"><span>${dayL(m.at)}</span></div>`; lastDay = d; }
      if (m.f === 'sys') { h += `<div class="ch-sys"><span>${fmt(m.body)}</span></div>`; continue; }
      const me = m.f === 'k';
      const same = (a, b) => a && b && a.f === b.f && a.name === b.name && Math.abs(new Date(a.at) - new Date(b.at)) < 180e3 && new Date(a.at).toDateString() === new Date(b.at).toDateString();
      const first = !same(p, m), last = !same(m, n);
      const qh = !me && last && !m.recalled && !(m.re && m.re.length) ? `<button type="button" class="ch-qh" data-chqh="${m.id}" aria-label="Thả tim">♡</button>` : '';
      const tools = m.recalled ? '' : `<span class="ch-tools"><button type="button" data-chbar="${m.id}" title="Thả cảm xúc">☺</button><button type="button" data-chrep="${m.id}" title="Trả lời">${IC.reply}</button><button type="button" data-chact="${m.id}" title="Thêm">${IC.more}</button></span>`;
      h += `<div class="ch-g${me ? ' me' : ''}" id="chm${m.id}" data-g="${m.id}"><span class="ch-swi">${IC.reply}</span>${me ? tools : `<span class="ch-av${last ? '' : ' sp'}">${esc(initials(m.name))}</span>`}<div class="ch-col">${!me && first ? `<span class="ch-nm">${esc(m.name || 'Nhân viên')}</span>` : ''}<div class="ch-bw">${bubble(m)}${qh}</div>${reacts(m)}${last ? `<span class="ch-st">${tHM(m.at)}${me && m.id === lastMine ? (S.seen >= m.id ? ' · Đã xem' : ' · Đã gửi') : ''}</span>` : ''}</div>${me ? '' : tools}</div>`;
    }
    const oldH = box.scrollHeight, oldT = box.scrollTop;
    box.innerHTML = h;
    if (near) box.scrollTop = box.scrollHeight;
    else if (S._prepend) box.scrollTop = box.scrollHeight - oldH + oldT;
    S._prepend = false;
    box.querySelectorAll('img[data-chiv]').forEach((im) => { if (!im.complete) im.addEventListener('load', () => { if (near) box.scrollTop = box.scrollHeight; }, { once: true }); });
  }
  async function older() {
    if (!S.cur || !S.cur.id || !S.msgs.length) return; S.busy = true;
    try { const j = await getJ('/api/chat/t/' + S.cur.id + '?before=' + S.msgs[0].id); const add = j.msgs || []; S.more = add.length >= 50; S.msgs = add.concat(S.msgs); S._prepend = true; renderMsgs(false); } catch (e) {} S.busy = false;
  }
  function upsert(m) { const i = S.msgs.findIndex((x) => x.id === m.id); if (i >= 0) S.msgs[i] = m; else { S.msgs.push(m); S.msgs.sort((a, b) => a.id - b.id); } }
  let readT = 0;
  function markRead() {
    if (!S.cur || !S.cur.id || document.hidden || !T || T.hidden || !S.msgs.length) return;
    const upto = S.msgs[S.msgs.length - 1].id;
    const t = S.list.find((x) => x.id === S.cur.id); if (t && t.unread) { t.unread = 0; badge(); if (!view().hidden) renderList(); }
    clearTimeout(readT); readT = setTimeout(() => post('/api/chat/t/' + S.cur.id + '/read', { upto }).catch(() => {}), 300);
  }

  // ---------- gui ----------
  let tyAt = 0;
  function typingPing() { if (!S.cur || !S.cur.id || Date.now() - tyAt < 3000 || !$('#chIn', T).value.trim()) return; tyAt = Date.now(); post('/api/chat/t/' + S.cur.id + '/typing', {}).catch(() => {}); }
  async function sendNow(extra) {
    if (!S.cur) return;
    const inp = $('#chIn', T); const body = extra && extra.card ? '' : inp.value.trim();
    const att = extra && extra.card ? [] : S.att.filter((a) => a.id).map((a) => a.id);
    if (!(extra && extra.card) && (S.att.some((a) => !a.id && !a.err) || (!body && !att.length))) return;
    const b = { body, att, reply: S.reply ? S.reply.id : null, card: extra && extra.card ? extra.card : null };
    if (S.cur.id) b.th = S.cur.id; else b.ctx = S.cur.ctx;
    if (!(extra && extra.card)) { inp.value = ''; S.att = []; renderPv(); grow(); }
    S.reply = null; renderRb(); upd();
    try {
      const j = await post('/api/chat/send', b);
      if (!S.cur.id) { S.cur = Object.assign(S.cur, j.thread); }
      S.seen = (j.thread && j.thread.seenByStaff) || S.seen;
      upsert(j.msg); renderMsgs(true); loadListSoon();
    } catch (e) { toast(e.message); if (!(extra && extra.card) && !inp.value) { inp.value = body; grow(); upd(); } }
    if (!isM()) inp.focus();
  }
  // anh: nen ve JPG <= 1600px roi tai len (/api/upload)
  function jpg(file) {
    return new Promise((ok, no) => {
      const url = URL.createObjectURL(file); const im = new Image();
      im.onload = () => { let w = im.naturalWidth, h = im.naturalHeight; const k = Math.min(1, 1600 / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h); URL.revokeObjectURL(url);
        const go = (q) => c.toBlob((b) => { if (!b) return no(new Error('Không đọc được ảnh')); if (b.size > 2.8e6 && q > 0.5) return go(q - 0.15); ok(b); }, 'image/jpeg', q); go(0.82); };
      im.onerror = () => { URL.revokeObjectURL(url); no(new Error('Không đọc được ảnh (định dạng lạ)')); };
      im.src = url;
    });
  }
  // Video: gui nguyen file (toi da 100MB), co phan tram tien do
  function upVideo(f, a) {
    return new Promise((ok, no) => {
      const x = new XMLHttpRequest(); x.open('POST', '/api/chat/file');
      x.setRequestHeader('Content-Type', /^video\//.test(f.type) ? f.type : 'video/mp4');
      x.upload.onprogress = (e) => { if (e.lengthComputable) { a.pct = Math.floor(e.loaded / e.total * 100); renderPv(); } };
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} if (x.status === 200 && j.id) ok(j.id); else no(new Error(j.error || 'Gửi video lỗi, thử lại')); };
      x.onerror = () => no(new Error('Mất mạng khi gửi video, thử lại'));
      x.send(f);
    });
  }
  async function addFiles(files) {
    if (!S.cur || !files.length) return;
    for (const f of files.slice(0, 10 - S.att.length)) {
      const v = /^video\//.test(f.type) || /\.(mov|mp4|m4v|webm)$/i.test(f.name || '');
      if (v && f.size > 100 * 1048576) { toast('Video tối đa 100MB (video này ' + Math.round(f.size / 1048576) + 'MB). Anh/chị cắt ngắn hoặc quay lại chất lượng thấp hơn nhé.'); continue; }
      const a = { url: URL.createObjectURL(f), id: null, err: null, v, pct: 0 }; S.att.push(a); renderPv(); upd();
      try {
        if (v) a.id = await upVideo(f, a);
        else { const b = await jpg(f); const r = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: b }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Tải ảnh lỗi'); a.id = j.id; }
      } catch (e) { a.err = e.message; toast(e.message); }
      renderPv(); upd();
    }
  }
  function renderPv() {
    const pv = $('#chPv', T); pv.hidden = !S.att.length;
    pv.innerHTML = S.att.map((a, i) => `<span>${a.v ? `<video src="${a.url}#t=0.1" muted playsinline preload="metadata"></video>` : `<img src="${a.url}" alt="">`}${a.id ? (a.v ? '<em style="background:#0003;align-items:end;padding-bottom:3px">▶</em>' : '') : `<em>${a.err ? 'Lỗi' : a.v ? (a.pct || 0) + '%' : 'Đang tải'}</em>`}<button type="button" data-chrm="${i}" aria-label="Bỏ">×</button></span>`).join('');
  }
  function renderRb() {
    const r = S.reply; $('#chRb', T).innerHTML = r ? `<div class="ch-rb">${IC.reply}<span>Trả lời ${esc(r.f === 'k' ? 'chính mình' : (r.name || 'nhân viên'))}: ${esc(r.body ? r.body.slice(0, 80) : r.att ? (r.att.some((x) => x.t === 'v') ? '[Video]' : '[Ảnh]') : '[Đơn hàng]')}</span><button type="button" data-chnorep aria-label="Bỏ trả lời">×</button></div>` : '';
  }

  // ---------- menu tin nhan ----------
  function sheet(html) {
    const o = document.createElement('div'); o.className = 'ch-sheet'; o.innerHTML = '<div>' + html + '</div>';
    o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-x]')) o.remove(); });
    o.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(o); return o;
  }
  // Thanh cam xuc noi canh tin (kieu Zalo): 6 cam xuc + Tra loi + Them
  function bar(mid) {
    const m = S.msgs.find((x) => x.id === mid); if (!m || m.f === 'sys' || m.recalled) return;
    const old = $('.ch-bar'); if (old) old.remove();
    const b = document.querySelector('#chm' + mid + ' .ch-b'); if (!b) return;
    const o = document.createElement('div'); o.className = 'ch-bar';
    o.innerHTML = EMO.map((e) => `<button type="button" data-e="${e}" class="${(m.re || []).some((r) => r.e === e && r.mine) ? 'mine' : ''}">${e}</button>`).join('') + `<i></i><button type="button" class="t" data-a="rep">${IC.reply}</button><button type="button" class="t" data-a="more">${IC.more}</button>`;
    o.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(o);
    const r = b.getBoundingClientRect(), w = o.offsetWidth, h = o.offsetHeight;
    o.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 8)) + 'px';
    o.style.top = (r.top - h - 8 > 60 ? r.top - h - 8 : Math.min(r.bottom + 8, innerHeight - h - 8)) + 'px';
    const close = (e) => { if (!o.contains(e.target)) { o.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    o.addEventListener('click', (e) => {
      const em = e.target.closest('[data-e]'), a = e.target.closest('[data-a]'); if (!em && !a) return;
      o.remove(); document.removeEventListener('pointerdown', close, true);
      if (em) react(mid, em.dataset.e);
      else if (a.dataset.a === 'rep') { S.reply = m; renderRb(); $('#chIn', T).focus(); }
      else actions(mid);
    });
  }
  function actions(mid) {
    const m = S.msgs.find((x) => x.id === mid); if (!m || m.f === 'sys') return;
    const mine = m.f === 'k'; const canRecall = mine && !m.recalled && Date.now() - new Date(m.at) < 5 * 60e3;
    const o = sheet((m.recalled ? '' : `<div class="ch-emo">${EMO.map((e) => `<button type="button" data-e="${e}" class="${(m.re || []).some((r) => r.e === e && r.mine) ? 'mine' : ''}">${e}</button>`).join('')}</div>`) +
      `<div class="ch-act">${m.recalled ? '' : `<button type="button" data-a="rep">${IC.reply} Trả lời</button>`}${m.body && !m.recalled ? `<button type="button" data-a="copy">${IC.copy} Sao chép</button>` : ''}${canRecall ? `<button type="button" class="red" data-a="recall">${IC.undo} Thu hồi</button>` : ''}<button type="button" data-x>Đóng</button></div>`);
    o.addEventListener('click', async (e) => {
      const em = e.target.closest('[data-e]'); const a = e.target.closest('[data-a]');
      if (em) { o.remove(); react(mid, em.dataset.e); return; }
      if (!a) return; o.remove();
      if (a.dataset.a === 'rep') { S.reply = m; renderRb(); $('#chIn', T).focus(); }
      if (a.dataset.a === 'copy') { try { await navigator.clipboard.writeText(m.body); toast('Đã sao chép'); } catch (x) {} }
      if (a.dataset.a === 'recall') { try { const j = await post('/api/chat/m/' + mid + '/recall', {}); upsert(j.msg); renderMsgs(); loadListSoon(); } catch (x) { toast(x.message); } }
    });
  }
  async function react(mid, e, addOnly) { const m = S.msgs.find((x) => x.id === mid); if (!m || m.recalled || m.f === 'sys') return; if (addOnly && (m.re || []).some((r) => r.e === e && r.mine)) return; try { const j = await post('/api/chat/m/' + mid + '/react', { e }); upsert(j.msg); renderMsgs(); } catch (x) { toast(x.message); } }

  // ---------- chon don (#) ----------
  function picker(mode) {
    const list = (typeof ALL !== 'undefined' ? ALL : []).slice(0, 400);
    const o = sheet(`<div class="ch-pk"><h3>${mode === 'card' ? 'Gửi mã đơn vào cuộc chat' : 'Anh/chị muốn hỏi về đơn nào?'}</h3><input type="search" placeholder="Tìm mã đơn, tên hàng, shop…" data-q><div class="ch-act" data-l></div></div>`);
    const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase();
    const draw = (q) => { q = fold(q); const r = list.filter((x) => !q || fold([x.code, x.note, x.shop, x.wb, ...(x.items || []).map((i) => i.tname || i.name)].join(' ')).includes(q)).slice(0, 40);
      $('[data-l]', o).innerHTML = r.length ? r.map((x) => `<button type="button" data-c="${esc(x.code)}">${tIcon({ kind: x.k })}<span style="min-width:0"><b style="display:block">${esc(x.code)} · ${esc(KN[x.k] || '')}</b><small style="display:block;color:#8b8170;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc((typeof lab === 'function' ? lab(x) : '') + ' · ' + orderLine(x))}</small></span></button>`).join('') : '<div class="ch-empty">Không thấy đơn nào</div>'; };
    draw(''); $('[data-q]', o).addEventListener('input', (e) => draw(e.target.value));
    if (!isM()) setTimeout(() => $('[data-q]', o).focus(), 30);
    o.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (!b) return; o.remove(); const code = b.dataset.c;
      if (mode === 'card') sendNow({ card: { code, k: kOf(code) } }); else location.hash = '#tin-nhan/don/' + encodeURIComponent(code); });
  }

  // ---------- thoi gian thuc ----------
  let es = null, pollT = 0, helloT = 0;
  function live() {
    if (!window.EventSource) return poll();
    try { es = new EventSource('/api/chat/stream'); } catch (e) { return poll(); }
    helloT = setTimeout(() => { if (!S.live) { try { es.close(); } catch (e) {} poll(); } }, 9000);
    es.onmessage = (e) => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } if (d.t === 'hello') { S.live = true; clearTimeout(helloT); clearInterval(pollT); if (S.hello++) { loadList(); catchUp(); } return; } onEv(d); };
    es.onerror = () => { S.live = false; };
  }
  function poll() { // du phong khi SSE bi chan: 6 giay/lan
    clearInterval(pollT);
    pollT = setInterval(async () => {
      if (document.hidden) return;
      const before = new Map(S.list.map((t) => [t.id, t.lastId]));
      await loadList();
      for (const t of S.list) if (t.lastId > (before.get(t.id) || 0) && t.lastFrom !== 'k') incoming(t.id, { name: t.lastName, body: t.lastText });
      if (S.cur && S.cur.id) catchUp();
    }, 6000);
  }
  async function catchUp() {
    if (!S.cur || !S.cur.id) return;
    try { const j = await getJ('/api/chat/t/' + S.cur.id + (S.msgs.length ? '?after=' + S.msgs[S.msgs.length - 1].id : '')); if (j.thread) S.seen = j.thread.seenByStaff || S.seen; for (const m of j.msgs || []) upsert(m); renderMsgs(); markRead(); } catch (e) {}
  }
  function onEv(d) {
    const open = S.cur && S.cur.id === d.th && T && !T.hidden;
    if (d.t === 'msg' || d.t === 'upd') {
      if (open) { upsert(d.m); if (d.m.f !== 'k') S.typingT = 0; renderMsgs(); typ(); if (d.t === 'msg') markRead(); }
      if (d.t === 'msg' && d.m.f !== 'k') incoming(d.th, d.m, open);
      loadListSoon();
    } else if (d.t === 'read') { if (d.side === 's' && open) { S.seen = Math.max(S.seen, d.upto); renderMsgs(); } if (d.side === 'k') loadListSoon(); }
    else if (d.t === 'typing' && open) { S.typingT = Date.now(); S.typingName = d.name || ''; typ(); setTimeout(typ, 5200); }
  }
  function typ() { if (!T) return; const on = Date.now() - S.typingT < 5000; $('#chTyp', T).innerHTML = on ? `<i></i><i></i><i></i>${esc(S.typingName || 'Nhân viên')} đang nhập…` : ''; }
  function incoming(th, m, open) {
    if (open && !document.hidden) return;
    ding(th);
    if (document.hidden) return; // may da co thong bao day
    const t = S.list.find((x) => x.id === th);
    let p = $('.ch-pop'); if (!p) { p = document.createElement('div'); p.className = 'ch-pop'; document.body.appendChild(p); }
    p.dataset.th = th; p.innerHTML = `<span class="ch-av">${esc(initials(m.name))}</span><span><b>${esc(t ? tTitle(t) : 'Tin nhắn mới')}</b><small>${esc((m.name ? m.name + ': ' : '') + (m.body || (m.att ? (m.att.some((x) => x.t === 'v') ? '[Video]' : '[Ảnh]') : 'Tin nhắn mới')))}</small></span>`;
    clearTimeout(p._t); p._t = setTimeout(() => p.remove(), 6000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadList(); catchUp(); } });

  // ---------- su kien bam ----------
  document.addEventListener('click', (e) => {
    const mc = e.target.closest('[data-mchat]'); // nut "Chat ve don nay" trong chi tiet don (cua trang chinh)
    if (mc) {
      e.preventDefault(); e.stopImmediatePropagation();
      const box = mc.closest('.order-detail-actions, .dialog-body, #pgBody, dialog') || document; const cp = box.querySelector('[data-mcopy]');
      const code = cp ? cp.dataset.mcopy : decodeURIComponent((location.hash.split('/')[2] || ''));
      const dl = mc.closest('dialog'); if (dl && dl.open) dl.close();
      if (code) location.hash = '#tin-nhan/don/' + encodeURIComponent(code); return;
    }
    const o = e.target.closest('[data-chopen]'); if (o) { const k = o.dataset.chopen; location.hash = '#tin-nhan/' + (/^\d+$/.test(k) ? k : k === 'vmt' ? 'vmt' : 'don/' + encodeURIComponent(k.slice(4))); return; }
    if (e.target.closest('[data-chback]')) { if (history.length > 1 && S._fromList) history.back(); else location.hash = '#tin-nhan'; return; }
    const pk = e.target.closest('[data-chpick]'); if (pk) { picker(pk.dataset.chpick); return; }
    if (e.target.closest('[data-chsnd]')) { soundOn = !soundOn; try { localStorage.setItem('vmt_chat_snd', soundOn ? '1' : '0'); } catch (x) {} renderList(); toast(soundOn ? 'Đã bật âm báo tin nhắn' : 'Đã tắt âm báo tin nhắn'); return; }
    const od = e.target.closest('[data-chord]'); if (od) { const code = od.dataset.chord; const k = kOf(code); if (k && typeof openDetail === 'function') openDetail(k, code); else toast('Không tìm thấy đơn ' + code); return; }
    const iv = e.target.closest('img[data-chiv]'); if (iv) { const v = document.createElement('div'); v.className = 'ch-iv'; v.innerHTML = `<img src="${esc(iv.src)}" alt="">`; v.addEventListener('click', () => v.remove()); document.body.appendChild(v); return; }
    const re = e.target.closest('[data-chre]'); if (re) { react(+re.dataset.chre, re.dataset.e); return; }
    const ac2 = e.target.closest('[data-chact]'); if (ac2) { actions(+ac2.dataset.chact); return; }
    const qh = e.target.closest('[data-chqh]'); if (qh) { react(+qh.dataset.chqh, '❤️'); return; }
    const br = e.target.closest('[data-chbar]'); if (br) { bar(+br.dataset.chbar); return; }
    const rp = e.target.closest('[data-chrep]'); if (rp) { const m = S.msgs.find((x) => x.id === +rp.dataset.chrep); if (m) { S.reply = m; renderRb(); $('#chIn', T).focus(); } return; }
    const jp = e.target.closest('[data-chjump]'); if (jp) { const el = document.getElementById('chm' + jp.dataset.chjump); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.style.transition = 'background .4s'; el.style.background = '#fff0c8'; setTimeout(() => (el.style.background = ''), 900); } return; }
    if (e.target.closest('[data-chold]')) { older(); return; }
    const rm = e.target.closest('[data-chrm]'); if (rm) { S.att.splice(+rm.dataset.chrm, 1); renderPv(); upd(); return; }
    if (e.target.closest('[data-chnorep]')) { S.reply = null; renderRb(); return; }
    const pop = e.target.closest('.ch-pop'); if (pop) { location.hash = '#tin-nhan/' + pop.dataset.th; pop.remove(); }
  }, true);

  // ---------- dinh tuyen ----------
  let prevHash = '';
  function route() {
    const h = location.hash.replace(/^#/, ''); const p = h.split('/');
    if (p[0] !== 'tin-nhan') { if (T && !T.hidden) closeThread(); prevHash = h; return; }
    S._fromList = prevHash === 'tin-nhan'; // vao tu danh sach -> nut quay lai = lui trang
    prevHash = h;
    sideLink();
    if (!S.loaded) loadList(); renderList();
    if (!p[1]) { closeThread(); return; }
    if (p[1] === 'vmt') openThread('vmt');
    else if (p[1] === 'don' && p[2]) openThread('don:' + decodeURIComponent(p[2]));
    else if (/^\d+$/.test(p[1])) openThread(p[1]);
  }
  addEventListener('hashchange', () => setTimeout(route, 0)); // sau show() cua trang chinh

  // ---------- khoi dong ----------
  sideLink(); badge(); live(); setTimeout(loadList, 1500);
  if (/^#tin-nhan/.test(location.hash)) setTimeout(route, 0);
})();
