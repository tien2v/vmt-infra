/* Quan ly khach hang (ban Sale / CSKH) trong giao dien admin. File nay KHONG thuoc template, nap sau /ext/cn-admin.js.
   Du lieu: /api/kh (danh sach loc tren may chu), /api/kh/<username> (chi tiet + ghi chu + don 30 ngay + vi moi). */
(function () {
  const SEG = [
    ['all', 'Tất cả'], ['mine', 'Của tôi'], ['due', 'Cần nhắc hôm nay'], ['active', 'Đang hoạt động'], ['risk', 'Sắp rời'], ['lost', 'Đã rời'],
    ['isNew', 'Khách mới'], ['none', 'Chưa lên đơn'], ['debt', 'Còn thiếu tiền'], ['vip', 'Chi tiêu lớn'],
  ];
  const SEG_TIP = { active: 'Có đơn trong 30 ngày', risk: 'Đơn gần nhất 31–90 ngày trước', lost: 'Hơn 90 ngày không lên đơn', isNew: 'Tạo tài khoản trong 30 ngày', none: 'Chưa có đơn nào', debt: 'Đơn còn thiếu tiền hoặc số dư Gobiz âm', vip: 'Chi tiêu từ 100 triệu trong 90 ngày', due: 'Có việc nhắc tới hạn', mine: 'Khách anh/chị đang phụ trách' };
  const SEG_BADGE = { active: ['Đang hoạt động', 'success'], risk: ['Sắp rời', 'warning'], lost: ['Đã rời', 'error'], none: ['Chưa lên đơn', 'slate'] };
  const KIND = [['note', 'Ghi chú', 'fa-note-sticky'], ['call', 'Gọi điện', 'fa-phone'], ['zalo', 'Nhắn Zalo', 'fa-comment-dots'], ['meet', 'Gặp mặt', 'fa-handshake'], ['care', 'Chăm sóc', 'fa-heart'], ['complain', 'Khách phàn nàn', 'fa-triangle-exclamation']];
  const GRP = { default: 'Vominhthien', vmtglobal: 'VMT Global' };
  const SORT = [['last', 'Hoạt động gần nhất'], ['old', 'Lâu không lên đơn'], ['v90', 'Chi tiêu 90 ngày'], ['n90', 'Số đơn 90 ngày'], ['debt', 'Còn thiếu nhiều'], ['bal', 'Số dư Gobiz'], ['remind', 'Ngày nhắc'], ['created', 'Khách mới tạo']];
  const PEER = { payment: 'Uỷ quyền', payment_ali_vn: 'Alipay VN', payment_ali_cn: 'Alipay TQ', payment_wechat: 'WeChat', transfer: 'Chuyển khoản' };
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      kh: { rows: [], total: 0, all: 0, counts: {}, groups: [], staff: [], me: '', full: true },
      khF: { q: '', seg: 'all', grp: '', owner: '', sort: 'last', p: 1, size: 25 },
      khErr: '', khBusy: false, khShow: false, khD: null, khTab: 'care', khMsg: '',
      khN: { kind: 'call', text: '', remind: '' }, khO: { sale: '', cskh: '', tags: '' },

      init() {
        if (origInit) origInit.call(this);
        this.$watch('page', (p) => { if (p === 'kh') this.khLoad(); });
        if (this.page === 'kh') this.khLoad();
      },
      khSegs: () => SEG,
      khSegTip: (k) => SEG_TIP[k] || '',
      khKinds: () => KIND,
      khKind: (k) => (KIND.find((x) => x[0] === k) || KIND[0]),
      khSorts: () => SORT,
      khGrp: (g) => GRP[g] || g || '—',
      khBadge(c) { const b = SEG_BADGE[c.seg]; if (!b) return null; return { t: b[0], cls: b[1] === 'slate' ? 'bg-slate-150 text-slate-600 dark:bg-navy-500 dark:text-navy-100' : 'bg-' + b[1] + '/10 text-' + b[1] + ' dark:bg-' + b[1] + '/15' }; },
      khAgo(d) { if (d === null || d === undefined) return ''; return d <= 0 ? 'hôm nay' : d === 1 ? 'hôm qua' : d + ' ngày trước'; },
      khN90(c) { return (Number(c.o90) || 0) + (Number(c.s90) || 0) + (Number(c.p90) || 0); },
      khStaff(u) { if (!u) return ''; const s = (this.kh.staff || []).find((x) => x.u === u); return s ? s.n : u; },
      khPeer: (t) => PEER[t] || t || '',
      khDue: (r) => !!(r && r.slice(0, 10) <= today()),
      khPh(p) { return String(p || '').replace(/[^\d+]/g, ''); },
      khZalo(p) { let x = String(p || '').replace(/\D/g, ''); if (x.startsWith('84')) x = '0' + x.slice(2); return x ? 'https://zalo.me/' + x : null; },

      async khLoad() {
        const f = this.khF; const qs = new URLSearchParams({ q: f.q, seg: f.seg, grp: f.grp, owner: f.owner, sort: f.sort, p: f.p, size: f.size });
        this.khBusy = true;
        try {
          const r = await fetch('/api/kh?' + qs, { cache: 'no-store' });
          if (r.status === 401) { location.href = '/login'; return; }
          const j = await r.json();
          if (!r.ok) { this.khErr = j.error || 'Không tải được'; } else { this.kh = j; this.khErr = ''; }
        } catch (e) { this.khErr = 'Mất kết nối'; }
        this.khBusy = false;
      },
      khSet(k, v) { this.khF[k] = v; this.khF.p = 1; this.khLoad(); },
      khPages() { return Math.max(1, Math.ceil((this.kh.total || 0) / this.khF.size)); },
      khGo(p) { p = Math.min(this.khPages(), Math.max(1, p)); if (p !== this.khF.p) { this.khF.p = p; this.khLoad(); } },

      async khOpen(u) {
        this.khShow = true; this.khMsg = ''; this.khTab = 'care';
        if (!this.khD || this.khD.c.k !== String(u).toLowerCase()) this.khD = null;
        try {
          const r = await fetch('/api/kh/' + encodeURIComponent(u), { cache: 'no-store' });
          const j = await r.json();
          if (!r.ok) { this.khMsg = j.error || 'Không tải được'; return; }
          this.khPick(j);
        } catch (e) { this.khMsg = 'Mất kết nối'; }
      },
      khPick(j) { this.khD = j; this.khO = { sale: j.c.sale || '', cskh: j.c.cskh || '', tags: j.c.tags || '' }; this.khN = { kind: 'call', text: '', remind: '' }; },
      async khPost(path, body, okMsg) {
        if (this.khBusy) return; this.khBusy = true; this.khMsg = '';
        try {
          const r = await fetch('/api/kh/' + encodeURIComponent(this.khD.c.u) + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) this.khMsg = j.error || 'Lỗi lưu'; else { this.khPick(j); this.khMsg = okMsg; this.khBusy = false; this.khLoad(); return; }
        } catch (e) { this.khMsg = 'Mất kết nối'; }
        this.khBusy = false;
      },
      khAddNote() { if (!this.khN.text.trim()) { this.khMsg = 'Chưa nhập nội dung'; return; } this.khPost('/note', this.khN, 'Đã lưu ghi chú'); },
      khDone(id) { this.khPost('/note/' + id + '/done', {}, 'Đã đánh dấu xong'); },
      khSaveOwner() { this.khPost('/owner', this.khO, 'Đã lưu phụ trách'); },
      khGoOrder(x) {
        const t = x.t === 'peer' ? 'peer' : x.t === 'ship' ? 'ship' : 'order';
        if (!this.canSee(t)) return;
        this.khShow = false;
        this.f[t].st = ''; this.f[t].grp = ''; this.f[t].q = x.code; this.f[t].p = 1;
        this.desk = this.deskOfPage(t) || this.desk; this.page = t;
      },
      khLogText(l) { try { const d = JSON.parse(l.detail || '{}'); if (d.changes) return d.changes.map((c) => c[0] + ': ' + (c[1] || '—') + ' → ' + (c[2] || '—')).join(' · '); if (d.remind) return 'Nhắc ' + d.remind; return ''; } catch (e) { return ''; } },
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
