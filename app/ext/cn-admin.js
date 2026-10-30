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
  ];
  const SM = Object.fromEntries(ST.map((s) => [s[0], { label: s[1], color: s[2] }]));
  const CL = { thuong: 'Hàng thường', kho: 'Hàng khó', yen: 'Yến sào', thu: 'Thư, chứng từ', rieng: 'Báo giá riêng' };
  const SP = { express_shipping: 'Nhanh', standard_shipping: 'Thường', eco_shipping: 'Chậm' };
  const SV = { insurance: 'Bảo hiểm', reinforce: 'Gia cố' };
  const WH = { HN: 'Hà Nội', HCM: 'TP.HCM' };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  const iso2 = (s) => { if (!s) return ''; const d = new Date(s); const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
  const csvCell = (v) => { if (v === undefined || v === null) return ''; const s = String(v); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const MENU = { t: 'Ship to China', p: 'cn', i: 'fa-plane-departure' };
  const MENU_SCAN = { t: 'Quét mã Ship to China', p: 'cnscan', i: 'fa-barcode' };

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
          if (d.id === 'kho') { const j = d.menu.findIndex((m) => m.p === 'kho'); d.menu.splice(j >= 0 ? j + 1 : 0, 0, Object.assign({}, MENU_SCAN)); }
        }
        if (origInit) origInit.call(this);
        const h = () => { const x = location.hash.slice(1); if ((x === 'cn' || x === 'cnscan') && this.canSee(x)) { this.desk = this.deskOfPage(x) || this.desk; this.page = x; } };
        h(); window.addEventListener('hashchange', h);
        this.$watch('page', (p) => { if (p === 'cn') this.cnLoad(); if (p === 'cnscan') this.$nextTick(() => { const el = document.getElementById('cnScanInput'); if (el) el.focus(); }); });
        if (this.page === 'cn') this.cnLoad();
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
        const head = ['Mã đơn', 'Mã đối chiếu Tài Lộc', 'Khách', 'Trạng thái', 'Tên lô', 'Loại hàng', 'Tốc độ', 'Kho gửi', 'Người nhận', 'SĐT', 'Địa chỉ TQ', 'Vận đơn khách', 'Mã VC tại TQ', 'Cân thực', 'Cân tính cước', 'Số kiện', 'Giá trị khai', 'Phí', 'Đã TT', 'Còn nợ', 'Ngày tạo'];
        let rows = this.cnRows().map((x) => [x.code, x.refTL, x.gobiz, this.cnSt(x.status), x.note, this.cnCl(x.cat), this.cnSpeed(x), x.wh, x.recvName, x.recvPhone, x.recvAddr, x.wb, x.wbCn, x.w, x.cw, x.pk, x.value, x.fee, x.paid, x.unpaid, iso2(x.created)]);
        if (!this.money()) { const keep = head.map((h) => !/(Giá trị|Phí|TT|nợ)/.test(h)); rows = rows.map((l) => l.filter((_, i) => keep[i])); head.splice(0, head.length, ...head.filter((_, i) => keep[i])); }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + [head].concat(rows).map((l) => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' }));
        a.download = 'ship-to-china.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      },

      // ---- quet ma tai kho ----
      scMode: 'in', scCode: '', scBusy: false, scLog: [], scCur: null, scMsg: '', scErr: '', scMissing: [],
      async scGo(force) {
        const code = this.scCode.trim(); if (!code || this.scBusy) return;
        this.scBusy = true; this.scErr = ''; this.scMsg = '';
        try {
          const r = await fetch('/api/cn/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, mode: this.scMode, force: !!force }) });
          const j = await r.json().catch(() => ({}));
          const ok = r.ok;
          this.scLog.unshift({ t: new Date().toTimeString().slice(0, 8), code, mode: this.scMode, ok: ok && !j.warn, text: ok ? (j.order.code + ' · ' + j.result) : j.error });
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
      cnMissing(x) { const m = []; if (!x.refTL) m.push('mã đối chiếu'); if (!(x.w > 0)) m.push('cân nặng'); if (!x.dims) m.push('kích thước'); if (!(x.pk > 0)) m.push('số kiện'); return m; },

      // ---- chi tiet + cap nhat ----
      cnPick(x) {
        this.cnDetail = x;
        this.cnForm = { status: x.status, w: x.w ?? '', dL: x.dims ? x.dims[0] : '', dW: x.dims ? x.dims[1] : '', dH: x.dims ? x.dims[2] : '', pk: x.pk ?? '', wbCn: x.wbCn || '', refTL: x.refTL || '', fee: x.fee ?? '', paid: x.paid ?? '', staffNote: x.staffNote || '' };
        this.cnMsg = '';
      },
      cnOpen(x) { this.cnPick(x); this.cnShow = true; },
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
        }
        this.cnSaving = true; this.cnMsg = '';
        try {
          const r = await fetch('/api/cn/' + x.code, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { this.cnMsg = j.error || 'Lỗi lưu'; } else { this.cnMsg = 'Đã lưu'; if (j.order) { j.order._q = norm([j.order.code, j.order.refTL, j.order.gobiz, j.order.recvName, j.order.wb, j.order.wbCn].join(' ')); this.cnPick(j.order); this.cnMsg = 'Đã lưu'; } await this.cnLoad(); this.cnPoll(); }
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
