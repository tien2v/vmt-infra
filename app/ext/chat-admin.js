/* Tin nhan khach trong giao dien admin (Lineone). File nay KHONG thuoc template, nap sau cn-admin / kh-admin.
   Them muc menu "Tin nhắn khách" (mo trang /chat), so tin chua doc, keu + bao khi khach nhan moi. */
(function () {
  const ROLES = ['admin', 'sale', 'order', 'tc'];
  const MENU = { t: 'Tin nhắn khách', p: 'chat', i: 'fa-comments' };
  let lastId = null, ac = null;
  addEventListener('pointerdown', () => { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } }, { passive: true });
  function ding() { if (!ac) return; try { const t = ac.currentTime; for (const [f, d] of [[880, 0], [1320, 0.11]]) { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22); o.connect(g).connect(ac.destination); o.start(t + d); o.stop(t + d + 0.25); } } catch (e) {} }
  function extend(o) {
    const origInit = o.init;
    Object.assign(o, {
      chatN: 0,
      init() {
        for (const d of this.desks) {
          if (!['overview', 'sale', 'order', 'tc'].includes(d.id) || d.menu.some((m) => m.p === 'chat')) continue;
          d.menu.splice(1, 0, Object.assign({}, MENU));
        }
        if (origInit) origInit.call(this);
        this.$watch('page', (p) => { if (p === 'chat') location.href = '/chat'; });
        if (ROLES.includes(this.role)) { this.chatPoll(); setInterval(() => this.chatPoll(), 20000); }
      },
      async chatPoll() {
        if (document.hidden && lastId !== null) return;
        try {
          const r = await fetch('/api/chat/summary', { cache: 'no-store' }); if (!r.ok) return;
          const j = await r.json(); this.chatN = j.unread || 0;
          for (const d of this.desks) for (const m of d.menu) if (m.p === 'chat') m.n = this.chatN || undefined;
          if (lastId !== null && j.lastId > lastId) {
            ding();
            window.dispatchEvent(new CustomEvent('vmt-toast', { detail: 'Khách vừa nhắn tin · mở Tin nhắn khách' }));
            try { if (window.Notification && Notification.permission === 'granted') { const n = new Notification('Tin nhắn khách', { body: (j.unread || 1) + ' cuộc chat chưa đọc', tag: 'vmt-chat' }); n.onclick = () => { focus(); location.href = '/chat'; }; } } catch (e) {}
          }
          lastId = j.lastId || 0;
        } catch (e) {}
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
