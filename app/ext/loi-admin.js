/* Loi kho TQ trong admin (ban Order + ban Sale/CSKH). Nap sau /assets/vmt.js, boc Alpine.data('vmt') nhu cn-admin.js.
   Kho TQ bao loi tren dien thoai (/kho/) -> loi tu chia: nha ban -> NV order, khach -> CSKH, kho lam hong -> admin.
   Bo phan: Nhan xu ly -> lien he shop / khach -> bam ket qua (Di tiep / Hoan shop / Bo sung / Huy) -> kien het bi giu, kho thay trong lich su.
   Han 2 ngay (anh chot 31/10): qua han hien do + dem tren menu. */
(function () {
  const KIND = {
    short: ['Thiếu hàng', '少货'], wrong: ['Sai mẫu / size', '发错货'], shop_damage: ['Hỏng do shop', '商家货损'], fake: ['Hàng giả / nhái', '假货'],
    ship_damage: ['Móp / ướt do ship nội địa', '国内快递破损'], cust_info: ['Khách khai sai / đặt sai', '客户信息错误'], banned: ['Hàng cấm / nhạy cảm', '违禁 / 敏感货'],
    no_info: ['Thiếu thông tin hàng', '缺少信息'], wh_damage: ['Kho làm hỏng', '仓库损坏'], other: ['Khác', '其他'],
    cust_reject: ['Khách báo có vấn đề khi duyệt ảnh', '客户确认有问题'], no_reply: ['Khách chưa xác nhận ảnh sau 48 giờ', '客户48小时未确认'],
  };
  const DEPT = { order: 'NV order', cskh: 'CSKH', admin: 'Quản lý' };
  const RES = [['go', 'Đi tiếp', 'Hàng ổn / đã thống nhất, kho đóng bao gửi về'], ['supplement', 'Bổ sung', 'Shop gửi bù, kho chờ hàng bù rồi gửi'], ['return', 'Hoàn shop', 'Trả hàng lại cho shop'], ['cancel', 'Huỷ', 'Huỷ hàng / không gửi về']];
  const RESN = Object.fromEntries(RES.map((r) => [r[0], r[1]]));
  const KINDK = { g: 'Ký gửi', o: 'Order', n: 'Ký gửi mới', u: 'Vô chủ' };
  const CST = { ok: 'Đủ', short: 'Thiếu', more: 'Thừa', wrong: 'Sai', bad: 'Hỏng' };
  const MENU = { t: 'Lỗi kho TQ', p: 'loikho', i: 'fa-triangle-exclamation' };

  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      lk: { tab: 'open', dept: '', items: [], loaded: false, err: '', busy: 0, open: null, note: {}, hist: {}, sum: { open: 0, late: 0, last: 0 }, lastSeen: null, lateSeen: null },
      lkKind: (k) => KIND[k] || [k, k],
      lkDept: (d) => DEPT[d] || d,
      lkRes: RES, lkResN: (r) => RESN[r] || r, lkKindK: (k) => KINDK[k] || '', lkCst: (s) => CST[s] || s,

      init() {
        // muc menu "Loi kho TQ": ban Order (sau Don order) + ban Sale/CSKH (sau Khach hang)
        for (const d of this.desks) {
          if (!['order', 'sale'].includes(d.id) || d.menu.some((m) => m.p === 'loikho')) continue;
          const i = d.menu.findIndex((m) => m.p === (d.id === 'order' ? 'order' : 'kh'));
          d.menu.splice(i >= 0 ? i + 1 : d.menu.length, 0, Object.assign({}, MENU));
        }
        if (origInit) origInit.call(this);
        const h = () => { if (location.hash.slice(1) === 'loikho' && this.canSee('loikho')) { this.desk = this.deskOfPage('loikho') || this.desk; this.page = 'loikho'; } };
        h(); window.addEventListener('hashchange', h);
        this.$watch('page', (p) => { if (p === 'loikho') this.lkLoad(); });
        if (this.page === 'loikho') this.lkLoad();
        if (this.role === 'admin' || this.role === 'order' || this.role === 'sale') { this.lkPoll(); setInterval(() => this.lkPoll(), 60000); }
      },
      async lkPoll() {
        try {
          const r = await fetch('/kho/api/issues/summary', { cache: 'no-store' }); if (!r.ok) return;
          const j = await r.json(); this.lk.sum = j;
          for (const d of this.desks) for (const m of d.menu) if (m.p === 'loikho') m.n = j.open || undefined;
          if (this.lk.lastSeen !== null && j.last > this.lk.lastSeen) {
            window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Kho TQ vừa báo lỗi mới — mở "Lỗi kho TQ"' }));
            try { if (window.Notification && Notification.permission === 'granted') new Notification('Lỗi kho TQ', { body: 'Kho TQ vừa báo lỗi mới' }); } catch (e) {}
            if (this.page === 'loikho') this.lkLoad();
          }
          this.lk.lastSeen = j.last || 0;
          // Qua han 2 ngay: bao anh (admin) + CSKH (anh 31/10 16h40: chua co truong bo phan)
          if ((this.role === 'admin' || this.role === 'sale') && j.late && (this.lk.lateSeen === null || j.late > this.lk.lateSeen)) {
            window.dispatchEvent(new CustomEvent('vmt-toast', { detail: j.late + ' lỗi kho TQ quá 2 ngày chưa xử lý' + (this.role === 'sale' ? ' — CSKH xử lý thay' : '') }));
            try { if (window.Notification && Notification.permission === 'granted') new Notification('Lỗi kho TQ quá hạn', { body: j.late + ' lỗi quá 2 ngày chưa xử lý' }); } catch (e) {}
          }
          this.lk.lateSeen = j.late || 0;
        } catch (e) {}
      },
      async lkLoad() {
        this.lk.err = '';
        try {
          const q = new URLSearchParams({ status: this.lk.tab === 'done' ? 'done' : 'open' }); if (this.lk.dept) q.set('dept', this.lk.dept);
          const r = await fetch('/kho/api/issues?' + q, { cache: 'no-store' });
          if (r.status === 401) { location.href = '/login'; return; }
          const j = await r.json(); if (!r.ok) { this.lk.err = j.error || 'Không tải được'; return; }
          this.lk.items = j.items || []; this.lk.me = j.me; this.lk.loaded = true;
        } catch (e) { this.lk.err = 'Mất kết nối'; }
      },
      lkRows() { return this.lk.tab === 'late' ? this.lk.items.filter((x) => x.late) : this.lk.items; },
      lkTab(t) { const was = this.lk.tab; this.lk.tab = t; if ((was === 'done') !== (t === 'done')) this.lkLoad(); },
      lkAge(x) { // con / qua bao lau so voi han (gio VN dang 'YYYY-MM-DD HH:MM:SS')
        const ms = Date.parse(String(x.due).replace(' ', 'T') + '+07:00') - Date.now(); const h = Math.round(Math.abs(ms) / 3600e3);
        const t = h >= 24 ? Math.floor(h / 24) + ' ngày ' + (h % 24) + ' giờ' : h + ' giờ';
        return ms < 0 ? 'Quá hạn ' + t : 'Còn ' + t;
      },
      lkBad(x) { const c = x.pkg && x.pkg.my && x.pkg.my.cnt; if (!c || !x.pkg.it) return []; return (c.lines || []).filter((l) => l.st && l.st !== 'ok').map((l) => ({ n: (x.pkg.it[l.i] || [])[0] || '#' + (l.i + 1), want: l.want, got: l.got, st: l.st })); },
      async lkPost(path, body) {
        this.lk.busy = body.id;
        try {
          const r = await fetch('/kho/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) { window.dispatchEvent(new CustomEvent('vmt-toast', { detail: j.error || 'Không lưu được' })); return false; }
          return true;
        } catch (e) { window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Mất kết nối' })); return false; } finally { this.lk.busy = 0; }
      },
      async lkClaim(x) { if (await this.lkPost('claim', { id: x.id })) { await this.lkLoad(); this.lkPoll(); } },
      async lkResolve(x, res) {
        const note = (this.lk.note[x.id] || '').trim();
        if (res !== 'go' && !note) { window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Ghi chú cho kho biết cần làm gì (bắt buộc khi Bổ sung / Hoàn shop / Huỷ)' })); return; }
        if (!confirm('Báo kết quả "' + RESN[res] + '" cho kiện ' + x.code + '? Kho TQ sẽ thấy ngay.')) return;
        if (await this.lkPost('resolve', { id: x.id, result: res, note })) { this.lk.note[x.id] = ''; window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã báo kho: ' + RESN[res] })); await this.lkLoad(); this.lkPoll(); }
      },
      async lkHist(x) {
        if (this.lk.hist[x.id]) { this.lk.hist[x.id] = null; return; }
        try { const r = await fetch('/kho/api/hist?code=' + encodeURIComponent(x.code)); const j = await r.json(); this.lk.hist[x.id] = j.items || []; } catch (e) {}
      },
      lkEv: (t) => ({ in: 'Nhận kiện', photo: 'Chụp ảnh', count: 'Kiểm đếm', issue: 'Báo lỗi', claim: 'Nhận xử lý', resolve: 'Báo kết quả', svc: 'Dịch vụ', note: 'Ghi chú', ask: 'Gửi khách duyệt ảnh', reply: 'Khách trả lời' }[t] || t),
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
