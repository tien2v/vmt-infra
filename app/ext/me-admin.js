/* Ho so nhan vien + ten goi nho don + thong bao cho khach trong giao dien admin (Lineone). File nay KHONG thuoc template.
   - Anh dai dien: hien o nut tai khoan (goc tren), doi trong menu tai khoan.
   - Ten goi nho: o chi tiet don (drawer) xem ten khach dat, NV dat giup -> cho khach xac nhan.
   - Menu "Thông báo cho khách" (admin + sale) mo trang /thong-bao. */
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MENU = { t: 'Thông báo cho khách', p: 'thongbao', i: 'fa-bullhorn' };
  // Cat vuong o giua + thu nho 256px, JPEG
  function square(file) {
    return new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => { const s = Math.min(im.width, im.height); const c = document.createElement('canvas'); c.width = c.height = 256; c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 256, 256); URL.revokeObjectURL(im.src); c.toBlob((b) => (b ? ok(b) : no(new Error('Không đọc được ảnh'))), 'image/jpeg', 0.88); };
      im.onerror = () => no(new Error('Không đọc được ảnh')); im.src = URL.createObjectURL(file);
    });
  }
  async function pickAvatar() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      try {
        const b = await square(f);
        let r = await fetch('/api/cn/upload', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: b }); let j = await r.json(); if (!r.ok) throw new Error(j.error);
        r = await fetch('/api/me/avatar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j.id }) }); j = await r.json(); if (!r.ok) throw new Error(j.error);
        if (window.VMT_ME) window.VMT_ME.av = j.id; paintMe();
        window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã đổi ảnh đại diện' }));
      } catch (e) { window.dispatchEvent(new CustomEvent('vmt-toast', { detail: e.message || 'Không đổi được ảnh' })); }
    };
    inp.click();
  }
  function paintMe() {
    const btn = document.querySelector('button[x-ref="popperRef"].avatar'); if (!btn) return;
    const av = window.VMT_ME && window.VMT_ME.av;
    let img = btn.querySelector('img.vmt-av'); const ini = btn.querySelector('.is-initial');
    if (av) { if (!img) { img = document.createElement('img'); img.className = 'vmt-av rounded-full object-cover size-10'; img.alt = ''; btn.appendChild(img); } img.src = '/cnimg/' + av + '.jpg'; if (ini) ini.style.display = 'none'; }
    const box = btn.parentElement && btn.parentElement.querySelector('.popper-box .p-3');
    if (box && !box.querySelector('[data-vmt-av]')) {
      const b = document.createElement('button'); b.setAttribute('data-vmt-av', '1'); b.className = 'btn mb-2 h-9 w-full space-x-2 bg-slate-150 font-medium text-slate-800 hover:bg-slate-200 dark:bg-navy-500 dark:text-navy-50';
      b.innerHTML = '<i class="fa-solid fa-camera"></i><span>Đổi ảnh đại diện</span>'; b.onclick = pickAvatar; box.prepend(b);
    }
  }
  // ---- ten goi nho trong chi tiet don ----
  async function aliasBox(o) {
    const d = o.detail; const anchor = document.querySelector('[x-text="(detail._cu||\'?\').slice(0,2)"]');
    const host = anchor && anchor.closest('.mt-4'); if (!host) return;
    let box = document.getElementById('vmtAlias');
    if (!box) { box = document.createElement('div'); box.id = 'vmtAlias'; box.className = 'mt-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-navy-500'; host.after(box); }
    if (!d || !d.code || !d._cu || o.role === 'kho') { box.style.display = 'none'; return; }
    box.style.display = ''; box.dataset.code = d.code; box.innerHTML = '<span class="text-slate-400">Tên gợi nhớ: đang tải…</span>';
    let j; try { const r = await fetch('/api/alias?owner=' + encodeURIComponent(d._cu) + '&code=' + encodeURIComponent(d.code), { cache: 'no-store' }); j = await r.json(); if (!r.ok) throw new Error(j.error); } catch (e) { box.innerHTML = '<span class="text-error">Không tải được tên gợi nhớ</span>'; return; }
    if (box.dataset.code !== d.code) return;
    const draw = () => {
      box.innerHTML = `<div class="flex items-center justify-between gap-2"><div class="min-w-0"><p class="text-xs text-slate-400 dark:text-navy-300">Tên gợi nhớ (khách đặt)</p><p class="truncate font-medium text-slate-700 dark:text-navy-100">${j.name ? esc(j.name) : '<span class="text-slate-400 font-normal">Chưa đặt</span>'}</p>${j.pend ? `<p class="mt-1 text-xs text-warning">Chờ khách xác nhận: “${esc(j.pend)}” (${esc(j.pendBy)})</p>` : ''}</div><button class="btn h-8 shrink-0 rounded-lg bg-primary/10 px-3 text-xs font-medium text-primary dark:bg-accent-light/10 dark:text-accent-light" data-al-edit>Đặt giúp</button></div>
      <form data-al-form class="mt-2 flex gap-2" style="display:none"><input class="form-input h-8 w-full rounded-lg border border-slate-300 bg-transparent px-2 text-sm dark:border-navy-450" maxlength="40" placeholder="VD: Lô áo đông khách Hà"><button class="btn h-8 rounded-lg bg-primary px-3 text-xs font-medium text-white">Gửi khách</button></form>
      <p class="mt-1 text-tiny text-slate-400">Khách phải đồng ý thì tên mới đổi. Tối đa 40 ký tự.</p>`;
      box.querySelector('[data-al-edit]').onclick = () => { const f = box.querySelector('[data-al-form]'); f.style.display = 'flex'; const i = f.querySelector('input'); i.value = j.pend || j.name || ''; i.focus(); };
      box.querySelector('[data-al-form]').onsubmit = async (e) => {
        e.preventDefault(); const i = e.target.querySelector('input'); const btn = e.target.querySelector('button'); btn.disabled = true;
        try { const r = await fetch('/api/alias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: d._cu, code: d.code, name: i.value }) }); const x = await r.json(); if (!r.ok) throw new Error(x.error); j.pend = x.pend; j.pendBy = (window.VMT_ME && (VMT_ME.name || VMT_ME.username)) || ''; draw(); window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Đã gửi tên gợi nhớ, chờ khách xác nhận' })); }
        catch (x) { btn.disabled = false; window.dispatchEvent(new CustomEvent('vmt-toast', { detail: x.message || 'Không gửi được' })); }
      };
    };
    draw();
  }
  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      init() {
        if (['admin', 'sale'].includes(this.role)) for (const dk of this.desks) {
          if (!['setting', 'sale'].includes(dk.id) || dk.menu.some((m) => m.p === 'thongbao')) continue;
          dk.menu.push(Object.assign({}, MENU));
        }
        if (origInit) origInit.call(this);
        this.$watch('page', (p) => { if (p === 'thongbao') location.href = '/thong-bao'; });
        this.$watch('detail', () => this.$nextTick(() => aliasBox(this)));
        setTimeout(paintMe, 50);
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
