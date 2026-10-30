/* Ship to China trong giao dien admin (Lineone). File nay KHONG thuoc template, nap sau /assets/vmt.js.
   Cach gan: bat su kien alpine:init o pha capture tren window (chay truoc listener cua vmt.js tren document),
   boc Alpine.data('vmt') de them trang 'cn', muc menu va thong bao don moi. */
(function () {
  const ST = [
    ['PENDING', 'Chờ tiếp nhận', 'warning'],
    ['VN_WAREHOUSE', 'Đã nhận kho VN', 'info'],
    ['TRANSPORTING', 'Vận chuyển quốc tế', 'secondary'],
    ['CN_WAREHOUSE', 'Đã tới kho TQ', 'primary'],
    ['DISPATCHED', 'Đang giao tại TQ', 'primary'],
    ['DELIVERED', 'Đã giao', 'success'],
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
        }
        if (origInit) origInit.call(this);
        const h = () => { if (location.hash === '#cn' && this.canSee('cn')) { this.desk = this.deskOfPage('cn') || this.desk; this.page = 'cn'; } };
        h(); window.addEventListener('hashchange', h);
        this.$watch('page', (p) => { if (p === 'cn') this.cnLoad(); });
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
          if (!r.ok) { this.cnMsg = j.error || 'Lỗi lưu'; } else { this.cnMsg = 'Đã lưu'; await this.cnLoad(); this.cnPoll(); }
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
