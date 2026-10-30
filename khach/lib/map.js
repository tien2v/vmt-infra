'use strict';
// Doi snapshot Gobiz (dang bang, do n8n day sang trang admin) thanh du lieu cho tung khach.
// Chi dua ra truong khach duoc xem: bo ghi chu noi bo, nhan vien mua hang, tai khoan mua.

const iso = (s) => (s ? String(s).replace(' ', 'T') + ':00+07:00' : null);
const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function groupBy(arr, key) {
  const g = new Map();
  for (const x of arr || []) {
    const k = x[key];
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(x);
  }
  return g;
}
const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const byCaDesc = (a, b) => (a.ca < b.ca ? 1 : a.ca > b.ca ? -1 : 0);

function brandOf(grp) { return String(grp || '').toLowerCase() === 'vmtglobal' ? 'yellow' : 'green'; }

// Tra ve { gen, byUser: Map<username, {cust, orders, shipments, peer}> }
function buildIndex(raw) {
  const items = groupBy(raw.items, 'oid');
  const ofees = groupBy(raw.ofees, 'oid');
  const oms = groupBy((raw.oms || []).slice().sort(byTs), 'oid');
  const sfees = groupBy(raw.sfees, 'sid');
  const sms = groupBy((raw.sms || []).slice().sort(byTs), 'sid');
  const custById = new Map();
  for (const c of raw.customers || []) custById.set(c.id, c);
  const byUser = new Map();
  const slot = (u, c) => {
    const k = String(u || '').toLowerCase();
    if (!byUser.has(k)) byUser.set(k, { cust: c || null, orders: [], shipments: [], peer: [] });
    const s = byUser.get(k);
    if (c && !s.cust) s.cust = c;
    return s;
  };
  const fee = (f) => ({ t: f.t, prov: n(f.pa), act: n(f.aa), q: null, p: null, free: !!f.free });
  const ms = (m) => ({ t: iso(m.ts), s: m.st });

  for (const o of (raw.orders || []).slice().sort(byCaDesc)) {
    const c = custById.get(o.cid); if (!c) continue;
    slot(c.u, c).orders.push({
      code: o.code, status: o.st, mk: o.mk, shop: o.shop, img: o.img, cust: c.u, custName: c.fn,
      emdPct: n(o.emdp), emd: n(o.emd), qty: n(o.oq), bought: n(o.pq), recv: n(o.rq), value: n(o.tv), rate: n(o.rate),
      wh: o.rw, to: o.dw, w: n(o.aw), vol: null, dw: null, fee: n(o.fee), paid: n(o.paid), refund: n(o.refund), unpaid: n(o.unpaid),
      claim: n(o.claim), cnShip: n(o.mship), ship: null, created: iso(o.ca), modified: iso(o.lt), statusAt: iso(o.lt), note: o.note || null, staff: null,
      items: (items.get(o.id) || []).map((x) => ({
        name: x.n, tname: null, url: x.url, img: x.img,
        props: (x.vp || []).filter((v) => v && v.value).map((v) => v.value),
        qty: n(x.q), bought: n(x.pq), recv: n(x.rq), price: n(x.sp), aprice: n(x.ap), sku: null,
      })),
      fees: (ofees.get(o.id) || []).map(fee), ms: (oms.get(o.id) || []).map(ms),
    });
  }
  for (const s of (raw.ships || []).slice().sort(byCaDesc)) {
    const c = custById.get(s.cid); if (!c) continue;
    slot(c.u, c).shipments.push({
      code: s.code, status: s.st, cust: c.u, custName: c.fn, wh: s.rw, to: s.dw, img: s.img, note: s.note || null,
      fee: n(s.fee), value: n(s.tv), rate: n(s.rate), w: n(s.aw), vol: n(s.vol), dw: n(s.dimw), nw: n(s.nw),
      paid: n(s.paid), refund: n(s.refund), unpaid: n(s.unpaid), claim: n(s.claim), ship: null, shop: s.shop || null,
      wb: null, expPk: n(s.ep), pk: n(s.ap), created: iso(s.ca), modified: iso(s.lt), statusAt: iso(s.lt),
      fees: (sfees.get(s.id) || []).map(fee), ms: (sms.get(s.id) || []).map(ms),
    });
  }
  for (const p of (raw.peer || []).slice().sort(byCaDesc)) {
    if (!p.cu) continue;
    slot(p.cu, null).peer.push({
      code: p.code, status: p.st, ptype: p.pt, method: p.pm, cust: p.cu, amt: n(p.amount), vnd: n(p.xa), rate: n(p.rate), cur: p.cur,
      ben: p.bn || null, benName: p.bn || null, bank: null, note: p.note || p.memo || null,
      paid: n(p.paid), refund: n(p.refund), unpaid: n(p.unpaid), fee: n(p.fee), created: iso(p.ca), modified: iso(p.lt), statusAt: iso(p.lt),
    });
  }
  return { gen: raw.gen, from: raw.from || null, byUser };
}

// Chon khach cho tai khoan test: uu tien khach co du 3 loai (dat hang, ky gui, thanh toan ho), roi nhieu don dat hang nhat
const cmp = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function busiest(index, grp) {
  let best = null, bestK = null;
  for (const [u, s] of index.byUser) {
    if (!s.cust || (grp && String(s.cust.grp || '').toLowerCase() !== grp)) continue;
    const kinds = (s.orders.length > 0) + (s.shipments.length > 0) + (s.peer.length > 0);
    const k = [s.orders.length > 0 ? 1 : 0, kinds, Math.min(s.orders.length, 40), s.orders.length + s.shipments.length + s.peer.length];
    if (!bestK || cmp(k, bestK) > 0) { best = u; bestK = k; }
  }
  return best;
}

module.exports = { buildIndex, brandOf, busiest };
