/* Ship to China trong giao dien admin (Lineone). File nay KHONG thuoc template, nap sau /assets/vmt.js.
   Cach gan: bat su kien alpine:init o pha capture tren window (chay truoc listener cua vmt.js tren document),
   boc Alpine.data('vmt') de them trang 'cn', muc menu va thong bao don moi. */
(function () {
  const ST = [
    ['PENDING', 'Chờ tiếp nhận', 'warning'],
    ['VN_WAREHOUSE', 'Đã nhập kho VN', 'info'],
    ['TRANSPORTING', 'Đã xuất kho · chờ thông quan', 'secondary'],
    ['CLEARED', 'Đã thông quan · đang giao TQ', 'primary'],
    ['DELIVERED', 'Giao thành công', 'success'],
    ['CANCELLED', 'Đã huỷ', 'error'],
    ['RETURN', 'Trả hàng', 'error'],
  ];
  const SM = Object.fromEntries(ST.map((s) => [s[0], { label: s[1], color: s[2] }]));
  const CL = { thuong: 'Hàng thường', kho: 'Hàng khó', yen: 'Yến sào', thu: 'Thư, chứng từ', rieng: 'Báo giá riêng' };
  const SP = { express_shipping: 'Nhanh', standard_shipping: 'Thường', eco_shipping: 'Chậm' };
  const SV = { insurance: 'Bảo hiểm', reinforce: 'Gia cố' };
  const WH = { HN: 'Hà Nội', HCM: 'TP.HCM' };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  const iso2 = (s) => { if (!s) return ''; const d = new Date(s); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  const csvCell = (v) => { if (v === undefined || v === null) return ''; const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  // ---- Ma vach Code128-B (ve SVG) de in tem dan kien ----
  const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
  function code128svg(text, h) {
    const codes = [104]; for (const ch of String(text)) { const c = ch.charCodeAt(0) - 32; codes.push(c >= 0 && c < 95 ? c : 0); }
    let sum = 104; for (let i = 1; i < codes.length; i++) sum += codes[i] * i; codes.push(sum % 103, 106);
    let x = 10, bars = ''; for (const c of codes) { const p = C128[c]; for (let i = 0; i < p.length; i++) { const w = +p[i]; if (i % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="' + h + '"/>'; x += w; } }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (x + 10) + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:' + h + 'px">' + bars + '</svg>';
  }
  const loadJs = (src) => new Promise((ok, no) => { if (document.querySelector('script[data-src="' + src + '"]')) return ok(); const x = document.createElement('script'); x.src = src; x.dataset.src = src; x.onload = ok; x.onerror = no; document.head.appendChild(x); });
  const qrSvg = (text) => { try { const q = window.qrcode(0, 'M'); q.addData(String(text)); q.make(); return q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }); } catch (e) { return ''; } };
  const escH = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  async function printLabels(o) {
    try { await loadJs('/ext/vendor/qrcode.js'); } catch (e) {}
    const n = Math.max(1, Math.min(50, Number(o.pk) || 1)); let pages = '';
    for (let i = 1; i <= n; i++) pages += '<div class="lb"><div class="top"><b>SHIP TO CHINA</b><span>' + escH(o.wh || '') + ' → TQ</span></div><div class="bc"><div class="qr">' + qrSvg(o.code) + '</div><div class="c128">' + code128svg(o.code, 56) + '</div></div>' +
      '<div class="code">' + escH(o.code) + '</div><div class="row"><span>Khách: <b>' + escH(o.gobiz || o.username || '') + '</b></span><span>Kiện <b>' + i + '/' + n + '</b></span></div>' +
      '<div class="row"><span>Nhận: ' + escH(o.recvName || '') + '</span><span>' + escH((o.recvAddr || '').slice(0, 14)) + '</span></div><div class="row small"><span>' + escH(o.note || '') + '</span><span>' + new Date().toLocaleDateString('vi-VN') + '</span></div></div>';
    const html = '<!doctype html><html><head><meta charset="utf-8"><title>' + escH(o.code) + '</title><style>@page{size:75mm 50mm;margin:0}body{margin:0;font-family:Arial,sans-serif}.lb{width:75mm;height:50mm;box-sizing:border-box;padding:2.5mm 3.5mm;page-break-after:always;overflow:hidden}.top{display:flex;justify-content:space-between;font-size:10pt;margin-bottom:1mm}.bc{display:flex;gap:2mm;align-items:center}.qr{width:17mm;height:17mm;flex:none}.qr svg{width:100%;height:100%}.c128{flex:1;min-width:0}.code{text-align:center;font-size:15pt;font-weight:700;letter-spacing:1px;margin:1mm 0}.row{display:flex;justify-content:space-between;gap:2mm;font-size:9pt;white-space:nowrap;overflow:hidden}.small{font-size:8pt;color:#333}svg rect{fill:#000}</style></head><body>' + pages + '</body></html>';
    let f = document.getElementById('cnPrintFrame');
    if (!f) { f = document.createElement('iframe'); f.id = 'cnPrintFrame'; f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'; document.body.appendChild(f); }
    f.srcdoc = html; f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) {} };
    fetch('/api/cn/' + o.code + '?event=print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
  }

  const MENU = { t: 'Ship to China', p: 'cn', i: 'fa-plane-departure' };
  const MENU_SCAN = { t: 'Quét mã Ship to China', p: 'cnscan', i: 'fa-barcode' };
  const MENU_WAL = { t: 'Ví khách (mới)', p: 'cnwal', i: 'fa-wallet' };

  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      cn: [], cnCan: [], cnCounts: {}, cnLoaded: false, cnErr: '',
      cnF: { st: '', q: '', w: '', from: '', to: '', test: false, debt: false, p: 1 },
      cnDetail: null, cnShow: false, cnForm: {}, cnSaving: false, cnMsg: '',
      cnPending: 0, cnLastSeq: null,

      init() {
        // them muc menu "Ship to China" canh "Don ky gui" (chieu VN -> TQ)
        for (const d of this.desks) {
          if (!['kho', 'sale', 'tc'].includes(d.id) || d.menu.some((m) => m.p === 'cn')) continue;
          const i = d.menu.findIndex((m) => m.p === 'ship');
          const item = Object.assign({}, MENU);
          if (i >= 0) d.menu.splice(i + 1, 0, item); else d.menu.push(item);
          if (d.id !== 'kho' && !d.menu.some((m) => m.p === 'cnwal')) { const k = d.menu.findIndex((m) => m.p === 'cn'); d.menu.splice(k + 1, 0, Object.assign({}, MENU_WAL)); }
          if (d.id === 'kho') { const j = d.menu.findIndex((m) => m.p === 'kho'); d.menu.splice(j >= 0 ? j + 1 : 0, 0, Object.assign({}, MENU_SCAN)); }
        }
        if (origInit) origInit.call(this);
        const h = () => { const x = location.hash.slice(1); if ((x === 'cn' || x === 'cnscan') && this.canSee(x)) { this.desk = this.deskOfPage(x) || this.desk; this.page = x; } else if (x === 'cnwal' && this.canSee('cnwal')) { this.desk = this.deskOfPage('cnwal') || this.desk; this.page = 'cnwal'; } else if (x === 'cnnew' && this.canSee('cn')) { this.desk = this.deskOfPage('cn') || this.desk; this.page = 'cnnew'; } };
        h(); window.addEventListener('hashchange', h);
        this.$watch('page', (p) => { if (p !== 'cnscan' && this.camOn) this.camStop(); if (p === 'cn') this.cnLoad(); if (p === 'cnwal') this.wlLoad(); if (p === 'cnscan') this.$nextTick(() => { const el = document.getElementById('cnScanInput'); if (el) el.focus(); }); });
        if (this.page === 'cn') this.cnLoad(); if (this.page === 'cnwal') this.wlLoad();
        this.cnPoll(); setInterval(() => this.cnPoll(), 30000);
      },

      // ---- du lieu ----
      async cnLoad() {
        try {
          const r = await fetch('/api/cn' + (this.cnF.test ? '?test=1' : ''), { cache: 'no-store' });
          if (r.status === 401) { location.href = '/login'; return; }
          const j = await r.json();
          if (!r.ok) { this.cnErr = j.error || 'Không tải được đơn'; return; }
          this.cn = (j.orders || []).map((x) => Object.assign(x, { _q: norm([x.code, x.refTL, x.gobiz, x.username, x.recvName, x.recvPhone, x.note, x.wb, x.wbCn].join(' ')) }));
          this.cnCan = j.can || []; this.cnCounts = j.counts || {}; this.cnLoaded = true; this.cnErr = '';
          if (this.cnDetail) { const d = this.cn.find((x) => x.code === this.cnDetail.code); if (d) this.cnPick(d); }
        } catch (e) { this.cnErr = 'Mất kết nối'; }
      },
      async cnPoll() {
        try {
          const r = await fetch('/api/cn/summary', { cache: 'no-store' }); if (!r.ok) return;
          const j = await r.json();
          this.cnPending = j.pending || 0;
          for (const d of this.desks) for (const m of d.menu) if (m.p === 'cn') m.n = this.cnPending || undefined;
          if (this.cnLastSeq !== null && j.lastSeq > this.cnLastSeq) {
            const n = j.lastSeq - this.cnLastSeq;
            window.dispatchEvent(new CustomEvent('vmt-toast', { detail: n + ' đơn Ship to China mới' + (j.last ? ' · ' + j.last.code : '') }));
            try { if (window.Notification && Notification.permission === 'granted') new Notification('Ship to China', { body: n + ' đơn mới' + (j.last ? ' · ' + j.last.code : '') }); } catch (e) {}
            if (this.page === 'cn') this.cnLoad();
          }
          this.cnLastSeq = j.lastSeq || 0;
          document.title = (this.cnPending ? '(' + this.cnPending + ') ' : '') + 'VMT Admin';
        } catch (e) {}
      },
      cnNotifyAsk() { if (window.Notification) Notification.requestPermission(); },
      cnNotifyCan() { return !!(window.Notification && Notification.permission === 'default'); },

      // ---- danh sach ----
      cnSt: (s) => (SM[s] || { label: s }).label,
      cnStClass(s) { const c = (SM[s] || { color: 'slate' }).color; return 'bg-' + c + '/10 text-' + c + ' dark:bg-' + c + '/15'; },
      cnStList: () => ST,
      cnCl: (c) => CL[c] || c || '—',
      cnSpeed(x) { return x.cat === 'kho' ? (SP[((x.fees || []).find((f) => /shipping/.test(f.t)) || {}).t] || '—') : 'Theo bảng giá'; },
      cnSvc(x) { return (x.svcs || []).map((s) => SV[s] || s).join(', ') || 'Không'; },
      cnWh: (w) => WH[w] || w || '—',
      cnQty(x) { return (x.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0); },
      cnDT: (s) => iso2(s),
      cnBase() {
        const f = this.cnF, q = norm(f.q.trim());
        return this.cn.filter((x) => (!q || x._q.includes(q)) && (!f.w || x.wh === f.w) && (!f.from || iso2(x.created).slice(0, 10) >= f.from) && (!f.to || iso2(x.created).slice(0, 10) <= f.to) && (!f.debt || x.unpaid > 0));
      },
      cnRows() { const st = this.cnF.st; const b = this.cnBase(); return st ? b.filter((x) => x.status === st) : b; },
      cnCount(st) { const b = this.cnBase(); return st ? b.filter((x) => x.status === st).length : b.length; },
      cnPages() { return Math.max(1, Math.ceil(this.cnRows().length / this.size)); },
      cnPageRows() { const p = this.cnF.p; return this.cnRows().slice((p - 1) * this.size, p * this.size); },
      cnSetP(p) { this.cnF.p = Math.min(Math.max(1, p), this.cnPages()); },
      cnHasF() { const f = this.cnF; return !!(f.q || f.w || f.from || f.to || f.debt); },
      cnResetF() { Object.assign(this.cnF, { st: '', q: '', w: '', from: '', to: '', debt: false, p: 1 }); },
      cnTotals() {
        const r = this.cnRows(); const s = (f) => r.reduce((a, x) => a + (Number(f(x)) || 0), 0);
        return { n: r.length, kg: s((x) => x.cw ?? x.w), fee: s((x) => x.fee), paid: s((x) => x.paid), unpaid: s((x) => x.unpaid) };
      },
      cnCsv() {
        const head = ['Mã đơn', 'Mã đối chiếu Tài Lộc', 'Khách', 'Trạng thái', 'Tên lô', 'Loại hàng', 'Tốc độ', 'Kho gửi', 'Người nhận', 'SĐT', 'Địa chỉ TQ', 'Vận đơn khách', 'Mã VC tại TQ', 'Cân thực', 'Cân tính cước', 'Số kiện', 'Giá trị khai', 'Phí', 'Đã TT', 'Còn thiếu', 'Ngày tạo'];
        let rows = this.cnRows().map((x) => [x.code, x.refTL, x.gobiz, this.cnSt(x.status), x.note, this.cnCl(x.cat), this.cnSpeed(x), x.wh, x.recvName, x.recvPhone, x.recvAddr, x.wb, x.wbCn, x.w, x.cw, x.pk, x.value, x.fee, x.paid, x.unpaid, iso2(x.created)]);
        if (!this.money()) { const keep = head.map((h) => !/(Giá trị|Phí|TT|thiếu)/.test(h)); rows = rows.map((l) => l.filter((_, i) => keep[i])); head.splice(0, head.length, ...head.filter((_, i) => keep[i])); }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + [head].concat(rows).map((l) => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
        a.download = 'ship-to-china.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },

      // ---- vi khach (so giao dich moi, tach Gobiz) ----
      wl: [], wlQ: '', wlRole: '', wlPend: 0, wlCur: null, wlTx: [], wlLog: [], wlReqs: [], wlMsg: '', wlErr: '', wlBusy: false,
      wlCredit: { limit: '', days: 30 }, wlReq: { kind: 'TOPUP_MANUAL', amount: '', code: '', note: '' },
      async wlLoad() {
        this.wlAccLoad();
        try {
          const [a, b, c] = await Promise.all([fetch('/api/fin/wallets', { cache: 'no-store' }).then((r) => r.json()), fetch('/api/fin/requests?status=pending', { cache: 'no-store' }).then((r) => r.json()), fetch('/api/fin/deposits?status=hold', { cache: 'no-store' }).then((r) => r.json())]);
          this.wlHolds = c.items || [];
          this.wl = (a.items || []).map((x) => Object.assign(x, { _q: norm([x.u, x.code, x.gobizCode, x.fn].join(' ')) })); this.wlRole = a.role; this.wlPend = a.pending; this.wlReqs = b.items || [];
        } catch (e) { this.wlErr = 'Không tải được ví'; }
      },
      wlRows() { const q = norm(this.wlQ.trim()); return this.wl.filter((x) => !q || x._q.includes(q)).sort((a, b) => (b.balance !== 0) - (a.balance !== 0) || b.creditLimit - a.creditLimit).slice(0, 200); },
      async wlOpen(x) {
        this.wlCur = x; this.wlMsg = ''; this.wlErr = ''; this.wlCredit = { limit: x.creditLimit || '', days: x.creditDays || 30 }; this.wlReq = { kind: 'TOPUP_MANUAL', amount: '', code: '', note: '' };
        const j = await fetch('/api/fin/wallet/' + encodeURIComponent(x.owner), { cache: 'no-store' }).then((r) => r.json()); this.wlTx = j.txns || []; this.wlLog = j.log || []; Object.assign(this.wlCur, j.wallet || {});
      },
      async wlPost(url, body) {
        this.wlBusy = true; this.wlErr = ''; this.wlMsg = '';
        try { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) { this.wlErr = j.error || 'Lỗi'; return null; } return j; }
        catch (e) { this.wlErr = 'Mất kết nối'; return null; } finally { this.wlBusy = false; }
      },
      async wlSetCredit() { const j = await this.wlPost('/api/fin/credit', { owner: this.wlCur.owner, limit: Number(String(this.wlCredit.limit).replace(/\D/g, '')) || 0, days: Number(this.wlCredit.days) }); if (j) { this.wlMsg = 'Đã lưu hạn mức'; await this.wlLoad(); this.wlOpen(this.wl.find((x) => x.owner === this.wlCur.owner)); } },
      async wlMakeReq() {
        const f = this.wlReq; const amt = Number(String(f.amount).replace(/[^\d-]/g, ''));
        const j = await this.wlPost('/api/fin/request', { owner: this.wlCur.owner, kind: f.kind, amount: amt, codes: f.code ? [f.code.trim().toUpperCase()] : [], note: f.note });
        if (j) { this.wlMsg = 'Đã tạo yêu cầu #' + j.id + ', chờ anh duyệt'; this.wlReq = { kind: f.kind, amount: '', code: '', note: '' }; this.wlLoad(); }
      },
      async wlDecide(q, ok) {
        if (ok && !confirm('Duyệt ' + q.kindLabel + ' ' + this.vnd(q.amount) + ' cho ' + q.owner + '?')) return;
        const note = ok ? '' : (prompt('Lý do từ chối?') || ''); if (!ok && !note) return;
        const j = await this.wlPost('/api/fin/request/' + q.id + '/' + (ok ? 'approve' : 'reject'), { note });
        if (j) { this.wlMsg = ok ? 'Đã duyệt · ' + j.txn : 'Đã từ chối'; await this.wlLoad(); if (this.wlCur) this.wlOpen(this.wl.find((x) => x.owner === this.wlCur.owner) || this.wlCur); }
      },
      wlAccs: [], wlBanks: {}, wlAccOpen: false,
      async wlAccLoad() { try { const j = await fetch('/api/fin/accounts', { cache: 'no-store' }).then((r) => r.json()); this.wlAccs = j.items || []; this.wlBanks = j.banks || {}; } catch (e) {} },
      wlAccAdd() { this.wlAccs.push({ id: '', label: '', bank: 'TPB', acct: '', holder: '', active: true }); },
      async wlAccSave() { const j = await this.wlPost('/api/fin/accounts', { items: this.wlAccs }); if (j) { this.wlAccs = j.items; this.wlMsg = 'Đã lưu tài khoản nhận nạp tiền'; } },
      wlHolds: [],
      async wlHold(d, act) {
        let owner = '';
        if (act === 'assign') {
          const v = prompt('Gán khoản ' + this.vnd(d.amount) + ' cho khách nào? Gõ mã khách (vd 3HK7Q25) hoặc tên đăng nhập Gobiz', d.code || d.owner || ''); if (!v) return;
          const x = this.wl.find((w) => w.code === v.trim().toUpperCase() || w.owner === v.trim().toLowerCase()); if (!x) { this.wlErr = 'Không tìm thấy khách ' + v; return; } owner = x.owner;
        } else if (!confirm('Bỏ qua khoản này (tiền của Gobiz, không cộng ví mới)?')) return;
        const j = await this.wlPost('/api/fin/hold', { ref: d.ref, action: act, owner, note: '' });
        if (j) { this.wlMsg = act === 'assign' ? 'Đã tạo yêu cầu nạp tay #' + j.requestId + ', chờ anh duyệt' : 'Đã bỏ qua'; this.wlLoad(); }
      },
      cnTx: [],
      async cnTxLoad(code) { this.cnTx = []; try { const j = await fetch('/api/cn/' + code + '/txns', { cache: 'no-store' }).then((r) => r.json()); this.cnTx = j.items || []; } catch (e) {} },

      // ---- nhan vien tao don gium khach ----
      nfZone: 'prod',
      nfPaste(e) {
        if (this.page !== 'cnnew' || !this.nf || this.nfDone) return;
        const f = [...((e.clipboardData && e.clipboardData.items) || [])].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
        if (!f.length) return; e.preventDefault(); this.nfAddPh(this.nfZone, f);
      },
      nfDrop(k, e) { this.nfZone = k; const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].filter((x) => /^image\//.test(x.type)); if (f.length) this.nfAddPh(k, f); },
      nf: null, nfQ: '', nfCands: [], nfCos: [], nfErr: '', nfBusy: false, nfDone: null, nfPh: { prod: [], pkg: [] }, nfUp: 0,
      nfNew() {
        this.nf = { cust: null, lot: '', cat: 'thuong', rname: '', rphone: '', raddr: '', items: [{ name: '', qty: 1, price: '' }], wb: '', wh: 'HN', method: 'standard_shipping', insurance: false, reinforce: false, estW: '', note: '', vat: false, companyId: '', invCompany: '', invTax: '', invAddr: '', invEmail: '' };
        this.nfQ = ''; this.nfCands = []; this.nfCos = []; this.nfErr = ''; this.nfDone = null; this.nfPh = { prod: [], pkg: [] };
      },
      nfOpen() { this.nfNew(); this.page = 'cnnew'; location.hash = 'cnnew'; },
      async nfSearch() {
        const q = this.nfQ.trim(); if (q.length < 2) { this.nfCands = []; return; }
        try { const r = await fetch('/api/cn/customers?q=' + encodeURIComponent(q)); const j = await r.json(); if (this.nfQ.trim() === q) this.nfCands = j.items || []; } catch (e) {}
      },
      async nfPick(c) {
        this.nf.cust = c; this.nfCands = []; this.nfQ = '';
        try { const r = await fetch('/api/cn/customers/' + encodeURIComponent(c.u) + '/companies'); const j = await r.json(); this.nfCos = j.items || []; const d = this.nfCos.find((x) => x.isDefault) || this.nfCos[0]; this.nf.companyId = d ? String(d.id) : 'new'; } catch (e) { this.nfCos = []; this.nf.companyId = 'new'; }
      },
      async nfAddPh(k, files) {
        for (const f of files) {
          if (this.nfPh[k].length >= 10) { this.nfErr = 'Tối đa 10 ảnh mỗi loại'; break; }
          const p = { id: null, url: URL.createObjectURL(f) }; this.nfPh[k].push(p); this.nfUp++;
          try {
            const url = p.url; const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Không đọc được ảnh')); i.src = url; });
            const m = 1600, sc = Math.min(1, m / Math.max(img.naturalWidth, img.naturalHeight)); const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * sc); c.height = Math.round(img.naturalHeight * sc); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            let q = 0.82, b; do { b = await new Promise((r) => c.toBlob(r, 'image/jpeg', q)); q -= 0.12; } while (b && b.size > 2.8e6 && q > 0.3);
            const r = await fetch('/api/cn/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: b }); const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'Không tải được ảnh');
            const i = this.nfPh[k].indexOf(p); if (i >= 0) this.nfPh[k].splice(i, 1, Object.assign({}, p, { id: j.id }));
          } catch (e) { this.nfPh[k] = this.nfPh[k].filter((x) => x.url !== p.url); this.nfErr = e.message; }
          this.nfUp--;
        }
      },
      async nfSubmit() {
        const f = this.nf; this.nfErr = '';
        if (!f.cust) { this.nfErr = 'Chọn khách hàng trước'; return; }
        if (this.nfUp) { this.nfErr = 'Đang tải ảnh, chờ chút'; return; }
        const items = f.items.filter((i) => String(i.name).trim()).map((i) => ({ name: String(i.name).trim(), qty: Number(i.qty) || 0, price: Number(String(i.price).replace(/\D/g, '')) || 0 }));
        const b = { customer: f.cust.u, lot: f.lot.trim(), cat: f.cat, rname: f.rname.trim(), rphone: f.rphone.trim(), raddr: f.raddr.trim(), items, wb: f.wb.split(/[\s,;]+/).filter(Boolean).map((x) => x.toUpperCase()), wh: f.wh, method: f.cat === 'kho' ? f.method : 'standard_shipping',
          svcs: [f.insurance && 'insurance', f.reinforce && 'reinforce'].filter(Boolean), estW: String(f.estW).replace(',', '.'), note: f.note.trim(), vat: f.vat,
          companyId: f.vat && f.companyId && f.companyId !== 'new' ? Number(f.companyId) : null, invCompany: f.invCompany.trim(), invTax: f.invTax.trim(), invAddr: f.invAddr.trim(), invEmail: f.invEmail.trim(),
          photos: { prod: this.nfPh.prod.map((p) => p.id), pkg: this.nfPh.pkg.map((p) => p.id) } };
        this.nfBusy = true;
        try {
          const r = await fetch('/api/cn/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) this.nfErr = j.error || 'Không tạo được đơn';
          else { this.nfDone = j.order; this.cnLoad(); window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã tạo đơn ' + j.order.code + ' và báo cho khách' })); }
        } catch (e) { this.nfErr = 'Mất kết nối'; }
        this.nfBusy = false;
      },
      cnImg: (id) => '/cnimg/' + id + '.jpg',

      // ---- quet ma tai kho ----
      scMode: 'in', scCode: '', scBusy: false, scLog: [], scCur: null, scMsg: '', scErr: '', scMissing: [], scWaitRef: '', scAutoPrint: true,
      scPrint(o) { printLabels(o || this.cnDetail); },
      // ---- quet bang camera dien thoai (khong can may quet) ----
      camOn: false, camErr: '', camLast: '', camLastT: 0,
      async camToggle() {
        if (this.camOn) return this.camStop();
        this.camErr = '';
        try {
          await loadJs('/ext/vendor/html5-qrcode.min.js');
          this.camOn = true; await this.$nextTick();
          const F = window.Html5QrcodeSupportedFormats || {};
          const fm = ['QR_CODE', 'CODE_128', 'CODE_39', 'CODE_93', 'EAN_13', 'EAN_8', 'UPC_A', 'ITF', 'CODABAR', 'DATA_MATRIX', 'PDF_417'].map((k) => F[k]).filter((x) => x !== undefined);
          this._cam = new window.Html5Qrcode('cnCam', { formatsToSupport: fm, verbose: false });
          await this._cam.start({ facingMode: 'environment' }, { fps: 12, qrbox: (w, h) => ({ width: Math.min(320, w * 0.9), height: Math.min(180, h * 0.6) }) }, (txt) => {
            const t = String(txt || '').trim(); const n = Date.now();
            if (!t || (t === this.camLast && n - this.camLastT < 3000) || this.scBusy) return;
            this.camLast = t; this.camLastT = n; try { navigator.vibrate && navigator.vibrate(80); } catch (e) {}
            this.scCode = t; this.scGo(false);
          }, () => {});
        } catch (e) { this.camOn = false; this.camErr = 'Không mở được camera: ' + ((e && e.message) || e) + '. Cho phép trình duyệt dùng camera rồi thử lại.'; }
      },
      async camStop() { try { if (this._cam) { await this._cam.stop(); this._cam.clear(); } } catch (e) {} this._cam = null; this.camOn = false; },
      scCancelRef() { this.scWaitRef = ''; this.scMsg = ''; this.$nextTick(() => { const el = document.getElementById('cnScanInput'); if (el) el.focus(); }); },
      async scGo(force) {
        const code = this.scCode.trim(); if (!code || this.scBusy) return;
        this.scBusy = true; this.scErr = ''; this.scMsg = '';
        // Xuat kho luot 2: ma vua quet la bill Tai Loc cua don dang cho
        if (this.scWaitRef && /^SCN\d+$/i.test(code)) this.scWaitRef = ''; // quet tem don khac = sang don moi
        const body = this.scMode === 'out' && this.scWaitRef ? { code: this.scWaitRef, mode: 'out', ref: code, force: !!force } : { code, mode: this.scMode, force: !!force };
        try {
          const r = await fetch('/api/cn/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          const ok = r.ok;
          if (ok && j.needRef) this.scWaitRef = j.order.code; else if (body.ref) this.scWaitRef = ok ? '' : this.scWaitRef;
          if (ok && this.scMode === 'in' && !j.warn && this.scAutoPrint && j.order) printLabels(j.order);
          this.scLog.unshift({ t: new Date().toTimeString().slice(0, 8), code: body.ref ? body.code + ' + bill ' + body.ref : code, mode: this.scMode, ok: ok && !j.warn, text: ok ? (j.order.code + ' · ' + j.result) : j.error });
          if (this.scLog.length > 50) this.scLog.pop();
          if (j.order) { this.scCur = j.order; this.cnPick(j.order); this.cnDetail = j.order; }
          this.scMissing = j.missing || [];
          if (ok) { this.scMsg = j.result + (this.scMissing.length ? ' · còn thiếu: ' + this.scMissing.join(', ') : ''); try { new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play(); } catch (e) {} }
          else this.scErr = j.error || 'Lỗi quét';
          this.cnLoad(); this.cnPoll();
        } catch (e) { this.scErr = 'Mất kết nối'; }
        this.scCode = ''; this.scBusy = false;
        this.$nextTick(() => { const el = document.getElementById('cnScanInput'); if (el && !this.scMissing.length) el.focus(); });
      },
      async scSave() { await this.cnSave(false); if (this.cnMsg === 'Đã lưu') this.scErr = ''; if (this.cnDetail) { this.scCur = this.cnDetail; } const d = this.cn.find((x) => this.scCur && x.code === this.scCur.code); if (d) { this.scCur = d; this.scMissing = this.cnMissing(d); } this.$nextTick(() => { const el = document.getElementById('cnScanInput'); if (el) el.focus(); }); },
      cnMissing(x) { const m = []; if (!(x.w > 0)) m.push('cân nặng'); if (!x.dims) m.push('kích thước'); if (!(x.pk > 0)) m.push('số kiện'); return m; },

      // ---- chi tiet + cap nhat ----
      cnPick(x) {
        this.cnDetail = x;
        this.cnForm = { status: x.status, w: x.w ?? '', dL: x.dims ? x.dims[0] : '', dW: x.dims ? x.dims[1] : '', dH: x.dims ? x.dims[2] : '', pk: x.pk ?? '', wbCn: x.wbCn || '', refTL: x.refTL || '', fee: x.fee ?? '', paid: x.paid ?? '', staffNote: x.staffNote || '' };
        this.cnMsg = '';
      },
      cnOpen(x) { this.cnPick(x); this.cnShow = true; this.cnLogLoad(x.code); this.cnTxLoad(x.code); },
      cnLog: [], cnLogCode: '',
      async cnLogLoad(code) { this.cnLog = []; this.cnLogCode = code; try { const r = await fetch('/api/cn/' + code + '/log', { cache: 'no-store' }); const j = await r.json(); if (this.cnLogCode === code) this.cnLog = (j.log || []).slice().reverse().map((l) => { let d = null; try { d = JSON.parse(l.detail); } catch (e) {} return { ts: l.ts, who: l.username, action: l.action, changes: d && d.changes ? d.changes : [], raw: d ? '' : (l.detail || ''), extra: d || {} }; }); } catch (e) {} },
      cnWho(w) { w = String(w || ''); return w.startsWith('staff:') ? 'NV ' + w.slice(6) : w.startsWith('khach:') ? 'Khách ' + w.slice(6) : w === 'tai-loc' ? 'Tài Lộc (tự động)' : w === 'he-thong' ? 'Hệ thống (tự động)' : w; },
      cnPrint(x) { printLabels(x || this.cnDetail); if (this.cnDetail) setTimeout(() => this.cnLogLoad(this.cnDetail.code), 800); },
      cnCanEdit(k) { return this.cnCan.includes(k); },
      async cnSave(recalc) {
        const x = this.cnDetail, f = this.cnForm, b = {};
        if (!x) return;
        const n = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(',', '.')));
        if (recalc) b.recalc = true;
        else {
          if (this.cnCanEdit('status') && f.status !== x.status) b.status = f.status;
          if (this.cnCanEdit('w') && String(f.w) !== String(x.w ?? '')) b.w = n(f.w);
          if (this.cnCanEdit('dims')) { const nv = [f.dL, f.dW, f.dH].map((v) => String(v).trim()); const ov = x.dims ? x.dims.map(String) : ['', '', '']; if (nv.join('|') !== ov.join('|')) b.dims = nv.every((v) => v === '') ? null : nv.map((v) => Number(v.replace(',', '.'))); }
          if (this.cnCanEdit('pk') && String(f.pk) !== String(x.pk ?? '')) b.pk = n(f.pk);
          for (const k of ['wbCn', 'refTL', 'staffNote']) if (this.cnCanEdit(k) && String(f[k]).trim() !== String(x[k] || '')) b[k] = String(f[k]).trim();
          if (this.cnCanEdit('fee') && String(f.fee) !== String(x.fee ?? '')) b.fee = n(f.fee);
          if (this.cnCanEdit('paid') && String(f.paid) !== String(x.paid ?? '')) b.paid = n(f.paid);
          if (!Object.keys(b).length) { this.cnMsg = 'Chưa có gì thay đổi'; return; }
          if (b.status === 'CANCELLED' && !confirm('Huỷ đơn ' + x.code + '?')) return;
          if (b.status === 'RETURN') { const why = prompt('Lý do trả hàng (khách huỷ / hàng cấm / kho từ chối…). Khách có 15 ngày lấy hàng; cước đã trả sẽ tạo yêu cầu hoàn chờ anh duyệt.'); if (!why) return; b.returnReason = why; }
        }
        this.cnSaving = true; this.cnMsg = '';
        try {
          const r = await fetch('/api/cn/' + x.code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this.cnMsg = j.error || 'Lỗi lưu'; } else { this.cnMsg = 'Đã lưu'; if (j.order) { this.cnLogLoad(j.order.code); j.order._q = norm([j.order.code, j.order.refTL, j.order.gobiz, j.order.recvName, j.order.wb, j.order.wbCn].join(' ')); this.cnPick(j.order); this.cnMsg = 'Đã lưu'; } await this.cnLoad(); this.cnPoll(); }
        } catch (e) { this.cnMsg = 'Mất kết nối'; }
        this.cnSaving = false;
      },
    });
    return o;
  }

  window.addEventListener('alpine:init', () => {
    const orig = Alpine.data.bind(Alpine);
    Alpine.data = function (name, fn) {
      if (name === 'vmt') { const f = fn; fn = function () { return extend(f.apply(this, arguments)); }; }
      return orig(name, fn);
    };
  }, true);
})();
