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
  const D_CLAIMS = () => (window.VMT_DATA && window.VMT_DATA.claims) || [];
  const today = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      kh: { rows: [], total: 0, all: 0, counts: {}, groups: [], staff: [], me: '', full: true },
      khF: { q: '', seg: 'all', grp: '', owner: '', sort: 'last', p: 1, size: 25 },
      khErr: '', khBusy: false, khShow: false, khD: null, khTab: 'care', khMsg: '',
      khN: { kind: 'call', text: '', remind: '' }, khO: { sale: '', cskh: '', tags: '' },

      td: null, tdScope: 'mine', tdTab: 'remind', tdErr: '',
      init() {
        if (origInit) origInit.call(this);
        if (this.role === 'admin') this.tdScope = 'all';
        this.$watch('page', (p) => { if (p === 'kh') this.khLoad(); if (p === 'sale') this.tdLoad(); });
        if (this.page === 'kh') this.khLoad();
        if (this.canDesk && this.canDesk('sale')) { this.tdLoad(); setInterval(() => this.tdLoad(), 5 * 60e3); }
        // dong ngan chi tiet khach thi lam moi viec can lam (vua ghi chu / xong viec nhac)
        this.$watch('khShow', (v) => { if (!v && this.page === 'sale') this.tdLoad(); });
      },

      // ---- Gan phu trach hang loat + phan cong theo brand (chi admin) ----
      khSel: {}, khAs: null, khAsRes: null, khAsErr: '', khCfg: null, khCfgErr: '',
      khIsAdmin() { return this.role === 'admin' && (this.me || {}).role === 'admin'; },
      khSelN() { return Object.keys(this.khSel).filter((k) => this.khSel[k]).length; },
      khSelAll(on) { for (const c of this.kh.rows) this.khSel[c.k] = on; },
      khAllChecked() { return this.kh.rows.length > 0 && this.kh.rows.every((c) => this.khSel[c.k]); },
      khAsOpen() { this.khAs = { scope: this.khSelN() ? 'sel' : 'filter', sale: 'split', cskh: 'keep', onlyEmpty: true }; this.khAsRes = null; this.khAsErr = ''; if (!this.khCfg) this.khCfgLoad(); },
      khAsBody(dry) {
        const a = this.khAs, b = { onlyEmpty: !!a.onlyEmpty, dry };
        if (a.scope === 'sel') b.users = Object.keys(this.khSel).filter((k) => this.khSel[k]);
        else b.filter = { q: this.khF.q, seg: this.khF.seg, grp: this.khF.grp, owner: this.khF.owner };
        for (const f of ['sale', 'cskh']) { const v = a[f]; b[f] = ['keep', 'split', 'clear'].includes(v) ? { mode: v } : { mode: 'set', u: v }; }
        return b;
      },
      async khAsRun(dry) {
        this.khAsErr = '';
        if (!dry) { const n = this.khAsRes ? this.khAsRes.n : 0; if (!confirm('Gán phụ trách cho ' + n.toLocaleString('vi-VN') + ' khách?')) return; }
        this.khBusy = true;
        try {
          const r = await fetch('/api/kh/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.khAsBody(dry)) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) this.khAsErr = j.error || 'Lỗi'; else if (dry) this.khAsRes = j;
          else { this.khAs = null; this.khSel = {}; window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã gán phụ trách cho ' + (j.changed || 0).toLocaleString('vi-VN') + ' khách' })); this.khLoad(); this.tdLoad && this.tdLoad(); }
        } catch (e) { this.khAsErr = 'Mất kết nối'; }
        this.khBusy = false;
      },
      khAsPer() { const p = (this.khAsRes || {}).per || {}; return Object.keys(p).sort().map((k) => { const [f, u] = k.split(':'); return { f: f === 'sale' ? 'Sale' : 'CSKH', who: u === '-' ? 'Bỏ trống' : this.khStaff(u), n: p[k] }; }); },
      async khCfgLoad() {
        try {
          const r = await fetch('/api/kh/staffcfg', { cache: 'no-store' }); const j = await r.json();
          if (!r.ok) { this.khCfgErr = j.error || 'Lỗi'; return; }
          const st = {}; for (const x of j.staff) { const c = (j.cfg.staff || {})[x.u] || {}; st[x.u] = { n: x.n, role: x.role, kind: c.kind || 'sale', b: Object.fromEntries(j.groups.map((g) => [g, (c.brands || []).includes(g)])) }; }
          this.khCfg = { show: this.khCfg ? this.khCfg.show : false, groups: j.groups, staff: st, auto: !!j.cfg.auto, canEdit: j.canEdit, by: j.cfg.by, at: j.cfg.at };
          if (!(this.kh.staff || []).length) this.kh.staff = j.staff;
        } catch (e) { this.khCfgErr = 'Mất kết nối'; }
      },
      async khCfgOpen() { this.khCfgErr = ''; await this.khCfgLoad(); if (this.khCfg) this.khCfg.show = true; },
      khCfgCount(g, kind) { if (!this.khCfg) return 0; return Object.values(this.khCfg.staff).filter((x) => x.b[g] && (x.kind === 'both' || x.kind === kind)).length; },
      async khCfgSave() {
        const st = {}; for (const u in this.khCfg.staff) { const x = this.khCfg.staff[u]; const brands = Object.keys(x.b).filter((g) => x.b[g]); if (brands.length) st[u] = { brands, kind: x.kind }; }
        this.khBusy = true; this.khCfgErr = '';
        try {
          const r = await fetch('/api/kh/staffcfg', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff: st, auto: this.khCfg.auto }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) this.khCfgErr = j.error || 'Lỗi lưu'; else { this.khCfg.show = false; await this.khCfgLoad(); window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã lưu phân công theo brand' })); }
        } catch (e) { this.khCfgErr = 'Mất kết nối'; }
        this.khBusy = false;
      },

      // ---- Viec can lam ban Sale / CSKH ----
      async tdLoad() {
        try {
          const r = await fetch('/api/kh/todo', { cache: 'no-store' });
          if (!r.ok) { if (r.status !== 403) this.tdErr = 'Không tải được việc cần làm'; return; }
          this.td = await r.json(); this.tdErr = '';
          if (this.td.staff && !(this.kh.staff || []).length) this.kh.staff = this.td.staff;
          const n = this.tdRem().filter((x) => x.due).length;
          for (const d of this.desks) for (const m of d.menu) if (m.p === 'sale') m.n = n || undefined;
        } catch (e) { this.tdErr = 'Mất kết nối'; }
      },
      tdRem() { const a = (this.td && this.td.reminders) || []; return this.tdScope === 'mine' ? a.filter((x) => x.mine) : a; },
      tdDue() { return this.tdRem().filter((x) => x.due); },
      tdSoon() { return this.tdRem().filter((x) => !x.due); },
      tdTickets() { return (D_CLAIMS() || []).filter((r) => r.st === 'NEW' || r.st === 'ACCEPTED' || r.st === 'PROCESSING'); },
      tdPeer() { return (window.VMT_DATA && window.VMT_DATA.peer || []).filter((p) => p.st === 'REQUEST_FOR_PAY' || p.st === 'PAYMENT_PAID'); },
      tdDays(d) { const t = this.td ? this.td.today : ''; if (!d) return ''; const x = Math.round((Date.parse(d.slice(0, 10)) - Date.parse(t)) / 86400e3); return x === 0 ? 'Hôm nay' : x < 0 ? 'Trễ ' + (-x) + ' ngày' : x === 1 ? 'Ngày mai' : 'Còn ' + x + ' ngày'; },
      async tdDone(x) {
        try {
          const r = await fetch('/api/kh/' + encodeURIComponent(x.k) + '/note/' + x.id + '/done', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          if (!r.ok) { const j = await r.json().catch(() => ({})); window.dispatchEvent(new CustomEvent('vmt-toast', { detail: j.error || 'Lỗi lưu' })); return; }
          window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã xong việc nhắc · ' + x.u }));
          this.tdLoad();
        } catch (e) { window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Mất kết nối' })); }
      },
      tdOpenKh(u, tab) { this.khOpen(u); if (tab) this.$nextTick(() => { this.khTab = tab; }); },
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
      khSet(k, v) { this.khF[k] = v; this.khF.p = 1; this.khSel = {}; this.khLoad(); },
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
