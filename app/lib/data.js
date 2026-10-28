'use strict';
// Gom du lieu tho tu n8n (dang bang) thanh dang trang admin dung, va loc theo vai tro.

function clean(o, drop = []) {
  const r = {};
  for (const k in o) if (o[k] !== null && o[k] !== undefined && !drop.includes(k)) r[k] = o[k];
  return r;
}
function groupBy(arr, key, map) {
  const g = new Map();
  for (const x of arr || []) {
    const k = x[key];
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(map(x));
  }
  return g;
}
const byTs = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);
const byCaDesc = (a, b) => (a.ca < b.ca ? 1 : a.ca > b.ca ? -1 : 0);

function prepare(d) {
  const items = groupBy(d.items, 'oid', (x) => {
    const vp = (x.vp || []).filter((v) => v && v.value).map((v) => (v.name || '') + ': ' + v.value).join(' · ');
    return [x.n, x.url, x.img, vp, x.q, x.pq, x.rq, x.sp, x.ap];
  });
  const ofees = groupBy(d.ofees, 'oid', (x) => [x.t, x.pa, x.aa, x.free]);
  const oms = groupBy((d.oms || []).slice().sort(byTs), 'oid', (x) => [x.ts, x.st]);
  const sfees = groupBy(d.sfees, 'sid', (x) => [x.t, x.pa, x.aa, x.free]);
  const sms = groupBy((d.sms || []).slice().sort(byTs), 'sid', (x) => [x.ts, x.st]);
  const cust = {};
  for (const c of d.customers || []) cust[c.id] = [c.code, c.u, c.fn, c.grp, c.bal];

  const orders = (d.orders || []).slice().sort(byCaDesc).map((o) => {
    const r = clean(o, ['emdp']);
    r.it = items.get(o.id) || []; r.fe = ofees.get(o.id) || []; r.ms = oms.get(o.id) || [];
    r.ok = !(Number(o.unpaid) > 0);
    return r;
  });
  const ships = (d.ships || []).slice().sort(byCaDesc).map((s) => {
    const r = clean(s);
    r.fe = sfees.get(s.id) || []; r.ms = sms.get(s.id) || [];
    r.ok = !(Number(s.unpaid) > 0);
    return r;
  });
  const dr = (d.dr || []).map((x) => {
    const r = clean(x);
    if (r.sm && typeof r.sm === 'object') { if (r.sm.name) r.sm = r.sm.name; else delete r.sm; }
    return r;
  });
  return {
    gen: d.gen, from: d.from || null, cust, orders, ships,
    peer: (d.peer || []).slice().sort(byCaDesc).map((p) => clean(p)),
    dr, wd: (d.wd || []).map((x) => clean(x)), neg: (d.neg || []).map((x) => clean(x)), claims: (d.claims || []).map((x) => clean(x)),
  };
}

// Vai tro nao nhan duoc gi. Loc ngay tren may chu de nhan vien khong xem duoc du lieu ngoai phan viec.
const MONEY_ORDER = ['tv', 'rate', 'emd', 'fee', 'paid', 'refund', 'unpaid', 'claim', 'mship'];
const MONEY_SHIP = ['tv', 'rate', 'fee', 'paid', 'refund', 'unpaid', 'claim'];

function stripMoney(o, keys) {
  const r = Object.assign({}, o);
  for (const k of keys) delete r[k];
  r.fe = [];
  if (r.it) r.it = r.it.map((x) => { const y = x.slice(); y[7] = null; y[8] = null; return y; });
  return r;
}

function forRole(base, role) {
  const out = { gen: base.gen, from: base.from, received: base.received, role };
  const cust = (noBal) => {
    if (!noBal) return base.cust;
    const c = {};
    for (const k in base.cust) { const v = base.cust[k].slice(); v[4] = null; c[k] = v; }
    return c;
  };
  switch (role) {
    case 'admin':
    case 'tc':
      return Object.assign(out, base, { role });
    case 'sale':
      return Object.assign(out, { cust: base.cust, orders: base.orders, ships: base.ships, peer: base.peer, dr: base.dr, neg: base.neg, claims: base.claims, wd: [] });
    case 'order':
      return Object.assign(out, { cust: cust(true), orders: base.orders, ships: [], peer: [], dr: [], wd: [], neg: [], claims: base.claims });
    case 'kho':
      return Object.assign(out, {
        cust: cust(true),
        orders: base.orders.map((o) => stripMoney(o, MONEY_ORDER)),
        ships: base.ships.map((s) => stripMoney(s, MONEY_SHIP)),
        dr: base.dr, peer: [], wd: [], neg: [], claims: [],
      });
    default:
      return Object.assign(out, { cust: {}, orders: [], ships: [], peer: [], dr: [], wd: [], neg: [], claims: [] });
  }
}

module.exports = { prepare, forRole };
