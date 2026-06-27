'use strict';

// ── ⚙️ 填入你的設定 ────────────────────────────────────────────────────────────
var GAS_URL = 'https://script.google.com/macros/s/AKfycbxI5mRR6WSHeat1tpUFU6_a9FbjWXNcLF6b3lnmQSA5as7NZkZOnF6iwbe0zs1-Tt0q/exec';   // GAS 部署後的 Web App URL
var LIFF_ID = '2010528907-DEMW7vq5';   // LINE Developer Console 的 LIFF ID
// ─────────────────────────────────────────────────────────────────────────────

var DEV = location.search.includes('dev=true');

// ── State ─────────────────────────────────────────────────────────────────────
var S = {
  view: 'list',
  userId: null, displayName: null, pictureUrl: null, groupId: null,
  bills: { joined: [], notJoined: [] },
  bill: null,
  settlement: null,
};

function $app() { return document.getElementById('app'); }

// ── Settlement (used by mock API) ─────────────────────────────────────────────
function calcSettlement(items, members) {
  var nameMap = {};
  members.forEach(function(m) { nameMap[m.userId] = m.displayName; });
  var bal = {};
  members.filter(function(m) { return m.isActive; }).forEach(function(m) { bal[m.userId] = 0; });
  items.filter(function(i) { return !i.isArchived && i.participantIds.length > 0; }).forEach(function(it) {
    var share = it.amount / it.participantIds.length;
    it.participantIds.forEach(function(uid) {
      if (uid === it.payerId) return;
      bal[uid]        = (bal[uid]        || 0) - share;
      bal[it.payerId] = (bal[it.payerId] || 0) + share;
    });
  });
  var pos = [], neg = [];
  Object.keys(bal).forEach(function(uid) {
    if (bal[uid] >  0.005) pos.push({ uid: uid, v:  bal[uid] });
    if (bal[uid] < -0.005) neg.push({ uid: uid, v: -bal[uid] });
  });
  pos.sort(function(a,b){ return b.v - a.v; }); neg.sort(function(a,b){ return b.v - a.v; });
  var transfers = [], i = 0, j = 0;
  while (i < pos.length && j < neg.length) {
    var t = Math.min(pos[i].v, neg[j].v);
    transfers.push({ from: neg[j].uid, fromName: nameMap[neg[j].uid] || neg[j].uid, to: pos[i].uid, toName: nameMap[pos[i].uid] || pos[i].uid, amount: Math.round(t * 100) / 100 });
    pos[i].v -= t; neg[j].v -= t;
    if (pos[i].v < 0.005) i++;
    if (neg[j].v < 0.005) j++;
  }
  return {
    transfers: transfers,
    balances: Object.keys(bal).map(function(uid) {
      return { userId: uid, displayName: nameMap[uid] || uid, amount: Math.round(bal[uid] * 100) / 100 };
    }),
  };
}

// ── Mock API (localStorage, dev=true only) ─────────────────────────────────────
function buildMockApi() {
  var KEY = 'sep-mock-' + S.groupId;
  function db() {
    try { var r = localStorage.getItem(KEY); if (r) return JSON.parse(r); } catch(e) {}
    var now = new Date().toISOString();
    var fresh = { bills: [
      { spreadsheetId: 'mock-001', billName: '東京旅遊示範', description: '可自由編輯或刪除', groupId: S.groupId, creatorId: S.userId, isLocked: false, createdAt: now,
        members: [
          { userId: S.userId, displayName: S.displayName, joinedAt: now, isActive: true },
          { userId: 'mock-bob',  displayName: 'Bob',  joinedAt: now, isActive: true },
          { userId: 'mock-cara', displayName: 'Cara', joinedAt: now, isActive: true },
        ],
        items: [
          { itemId: 'i001', description: '來回機票', amount: 15000, payerId: S.userId, participantIds: [S.userId, 'mock-bob', 'mock-cara'], isArchived: false, createdAt: now },
          { itemId: 'i002', description: '飯店 3 晚', amount: 12000, payerId: 'mock-bob', participantIds: [S.userId, 'mock-bob', 'mock-cara'], isArchived: false, createdAt: now },
          { itemId: 'i003', description: '景點門票', amount: 3600, payerId: 'mock-cara', participantIds: [S.userId, 'mock-cara'], isArchived: false, createdAt: now },
        ],
      },
      { spreadsheetId: 'mock-002', billName: '台北聚餐', description: '3月底', groupId: S.groupId, creatorId: 'mock-bob', isLocked: false, createdAt: now,
        members: [{ userId: 'mock-bob', displayName: 'Bob', joinedAt: now, isActive: true }],
        items: [],
      },
    ]};
    localStorage.setItem(KEY, JSON.stringify(fresh)); return fresh;
  }
  function save(d) { localStorage.setItem(KEY, JSON.stringify(d)); }
  function bill(d, id) { return d.bills.find(function(b){ return b.spreadsheetId === id; }); }
  function ok(x) { return Object.assign({ ok: true }, x || {}); }
  function err(m) { return { error: m }; }

  return {
    getBills: function() {
      var d = db();
      return Promise.resolve({
        joined:    d.bills.filter(function(b){ return b.members.some(function(m){ return m.userId === S.userId && m.isActive; }); }),
        notJoined: d.bills.filter(function(b){ return !b.members.some(function(m){ return m.userId === S.userId && m.isActive; }); }),
      });
    },
    getBill: function(id) { var b = bill(db(), id); return Promise.resolve(b ? Object.assign({}, b) : err('找不到帳單')); },
    createBill: function(p) {
      var d = db(), id = 'bill-' + Date.now(), now = new Date().toISOString();
      d.bills.push({ spreadsheetId: id, billName: p.billName, description: p.description || '', groupId: p.groupId, creatorId: p.creatorId, isLocked: false, createdAt: now, members: [{ userId: p.creatorId, displayName: p.creatorName, joinedAt: now, isActive: true }], items: [] });
      save(d); return Promise.resolve({ spreadsheetId: id, ok: true });
    },
    updateBill: function(id, p) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.creatorId !== p.userId) return Promise.resolve(err('只有開單人可以編輯帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定'));
      b.billName = p.billName; b.description = p.description; save(d); return Promise.resolve(ok());
    },
    deleteBill: function(id, p) {
      var d = db(), idx = d.bills.findIndex(function(b){ return b.spreadsheetId === id; });
      if (idx === -1) return Promise.resolve(err('找不到帳單'));
      if (d.bills[idx].creatorId !== S.userId) return Promise.resolve(err('只有開單人可以刪除帳單'));
      d.bills.splice(idx, 1); save(d); return Promise.resolve(ok());
    },
    joinBill: function(id) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定，無法加入'));
      var ex = b.members.find(function(m){ return m.userId === S.userId; });
      if (ex && ex.isActive) return Promise.resolve(err('您已在此帳單中'));
      if (ex) ex.isActive = true;
      else b.members.push({ userId: S.userId, displayName: S.displayName, joinedAt: new Date().toISOString(), isActive: true });
      save(d); return Promise.resolve(ok());
    },
    exitBill: function(id) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定'));
      if (b.creatorId === S.userId) return Promise.resolve(err('開單人請直接刪除帳單'));
      var m = b.members.find(function(m){ return m.userId === S.userId; });
      if (m) m.isActive = false;
      b.items.forEach(function(it) { if (!it.isArchived && (it.payerId === S.userId || it.participantIds.indexOf(S.userId) !== -1)) it.isArchived = true; });
      save(d); return Promise.resolve(ok());
    },
    lockBill: function(id) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.creatorId !== S.userId) return Promise.resolve(err('只有開單人可以鎖定'));
      b.isLocked = true; save(d); return Promise.resolve(ok());
    },
    addItem: function(id, p) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定'));
      var iid = 'item-' + Date.now();
      b.items.push({ itemId: iid, description: p.description, amount: p.amount, payerId: p.payerId, participantIds: p.participantIds, isArchived: false, createdAt: new Date().toISOString() });
      save(d); return Promise.resolve({ itemId: iid, ok: true });
    },
    updateItem: function(id, iid, p) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定'));
      var it = b.items.find(function(x){ return x.itemId === iid; });
      if (!it) return Promise.resolve(err('找不到帳目'));
      it.description = p.description; it.amount = p.amount; it.payerId = p.payerId; it.participantIds = p.participantIds;
      save(d); return Promise.resolve(ok());
    },
    deleteItem: function(id, iid) {
      var d = db(), b = bill(d, id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      if (b.isLocked) return Promise.resolve(err('帳單已鎖定'));
      var it = b.items.find(function(x){ return x.itemId === iid; });
      if (it) it.isArchived = true;
      save(d); return Promise.resolve(ok());
    },
    getSettlement: function(id) {
      var b = bill(db(), id);
      if (!b) return Promise.resolve(err('找不到帳單'));
      return Promise.resolve(calcSettlement(b.items, b.members));
    },
    updateAvatar: function(pictureUrl) {
      var d = db();
      d.bills.forEach(function(b) {
        b.members.forEach(function(m) { if (m.userId === S.userId) m.pictureUrl = pictureUrl; });
      });
      save(d);
      return Promise.resolve({ ok: true });
    },
  };
}

// ── Real API (calls GAS) ──────────────────────────────────────────────────────
function buildRealApi() {
  function gasGet(params) {
    var url = new URL(GAS_URL);
    Object.keys(params).forEach(function(k) {
      if (params[k] != null) url.searchParams.set(k, params[k]);
    });
    return fetch(url.toString()).then(function(r) { return r.json(); });
  }
  function gasPost(params) {
    var body = new URLSearchParams();
    Object.keys(params).forEach(function(k) {
      var v = params[k];
      if (v == null) return;
      body.set(k, Array.isArray(v) ? v.join(',') : String(v));
    });
    return fetch(GAS_URL, { method: 'POST', body: body }).then(function(r) { return r.json(); });
  }
  return {
    getBills:     function()        { return gasGet({ action: 'getBills', groupId: S.groupId, userId: S.userId }); },
    getBill:      function(id)      { return gasGet({ action: 'getBill', billId: id }); },
    createBill:   function(p)       { return gasPost(Object.assign({ action: 'createBill', groupId: S.groupId, creatorId: S.userId, creatorName: S.displayName, pictureUrl: S.pictureUrl }, p)); },
    updateBill:   function(id, p)   { return gasPost(Object.assign({ action: 'updateBill', billId: id, userId: S.userId }, p)); },
    deleteBill:   function(id)      { return gasPost({ action: 'deleteBill', billId: id, userId: S.userId }); },
    joinBill:     function(id)      { return gasPost({ action: 'joinBill',  billId: id, userId: S.userId, displayName: S.displayName, pictureUrl: S.pictureUrl }); },
    exitBill:     function(id)      { return gasPost({ action: 'exitBill',  billId: id, userId: S.userId }); },
    lockBill:     function(id)      { return gasPost({ action: 'lockBill',  billId: id, userId: S.userId }); },
    addItem:      function(id, p)   { return gasPost(Object.assign({ action: 'addItem', billId: id }, p)); },
    updateItem:   function(id,i,p)  { return gasPost(Object.assign({ action: 'updateItem', billId: id, itemId: i }, p)); },
    deleteItem:   function(id, i)   { return gasPost({ action: 'deleteItem', billId: id, itemId: i }); },
    getSettlement:function(id)      { return gasGet({ action: 'getSettlement', billId: id }); },
    updateAvatar: function(pictureUrl) { return gasPost({ action: 'updateAvatar', userId: S.userId, groupId: S.groupId, pictureUrl: pictureUrl }); },
  };
}

var api; // set after state init

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type) {
  var el = document.createElement('div');
  el.className = 'toast toast-' + (type || 'info');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(function() { el.classList.add('show'); });
  setTimeout(function() { el.classList.remove('show'); setTimeout(function(){ el.remove(); }, 250); }, 2800);
}

// ── Confirm ───────────────────────────────────────────────────────────────────
function confirm(msg) {
  return new Promise(function(resolve) {
    var ov = document.createElement('div'); ov.className = 'overlay';
    ov.innerHTML = '<div class="dialog glass"><p>' + msg.replace(/\n/g, '<br>') + '</p><div class="dialog-btns"><button class="btn btn-ghost" id="c-no">取消</button><button class="btn btn-danger" id="c-yes">確認</button></div></div>';
    ov.querySelector('#c-no').onclick  = function() { ov.remove(); resolve(false); };
    ov.querySelector('#c-yes').onclick = function() { ov.remove(); resolve(true); };
    document.body.appendChild(ov);
  });
}

// ── Bottom sheet ──────────────────────────────────────────────────────────────
function openSheet(title, bodyHtml) {
  return new Promise(function(resolve) {
    var ov = document.createElement('div'); ov.className = 'overlay';
    ov.innerHTML = '<div class="sheet"><div class="sheet-handle"></div><div class="sheet-title">' + title + '</div><form id="sf">' + bodyHtml + '<div class="form-actions"><button type="button" class="btn btn-ghost" id="sf-cancel">取消</button><button type="submit" class="btn btn-primary">確認</button></div></form></div>';
    var form = ov.querySelector('#sf');
    ov.querySelector('#sf-cancel').onclick = function() { ov.remove(); resolve(null); };
    form.onsubmit = function(e) {
      e.preventDefault();
      var data = {};
      new FormData(form).forEach(function(v, k) { data[k] = v; });
      // Collect checkboxes as array
      var cbNames = new Set();
      form.querySelectorAll('input[type=checkbox][name]').forEach(function(cb) { cbNames.add(cb.name); });
      cbNames.forEach(function(name) {
        data[name] = [];
        form.querySelectorAll('input[type=checkbox][name="' + name + '"]:checked').forEach(function(cb) { data[name].push(cb.value); });
      });
      ov.remove(); resolve(data);
    };
    ov.addEventListener('click', function(e) { if (e.target === ov) { ov.remove(); resolve(null); } });
    document.body.appendChild(ov);
  });
}

// ── Loader ────────────────────────────────────────────────────────────────────
function setHandler(id, fn) { var el = document.getElementById(id); if (el) el.onclick = fn; }

function setLoading(on) {
  var el = document.getElementById('g-loader');
  if (el) el.remove();
  if (!on) return;
  el = document.createElement('div'); el.id = 'g-loader'; el.className = 'loader';
  el.innerHTML = '<div class="spinner"></div>';
  document.body.appendChild(el);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return 'NT$' + Number(n).toLocaleString('zh-TW'); }
function initial(s) { return String(s || '?')[0].toUpperCase(); }
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function memberName(uid) {
  if (!S.bill) return uid;
  var m = S.bill.members.find(function(m){ return m.userId === uid; });
  return m ? m.displayName : uid;
}
function activeMembers() {
  return (S.bill ? S.bill.members : []).filter(function(m){ return m.isActive; });
}

// ── Header HTML ───────────────────────────────────────────────────────────────
function headerHTML(opts) {
  return '<header class="header glass"><div class="header-inner"><div class="header-left">' +
    (opts.back ? '<button class="header-back" id="back-btn">‹</button>' : '<div class="header-logo">💰</div>') +
    '<div class="header-titles"><h1>' + esc(opts.title) + '</h1>' + (opts.sub ? '<p>' + esc(opts.sub) + '</p>' : '') + '</div>' +
    '</div>' + (S.pictureUrl ? '<img class="avatar" src="' + esc(S.pictureUrl) + '" />' : '') +
    '</div></header>';
}

// ── View: List ────────────────────────────────────────────────────────────────
function loadList() {
  setLoading(true);
  api.getBills().then(function(r) {
    if (r.error) { toast(r.error, 'error'); setLoading(false); return; }
    S.bills = r; renderList(); setLoading(false);
  }).catch(function(e) { toast('載入失敗：' + e.message, 'error'); setLoading(false); });
}

function billCard(b, joined) {
  var count = b.members.filter(function(m){ return m.isActive; }).length;
  var actions = joined
    ? '<button class="icon-btn edit" data-act="edit" data-id="' + b.spreadsheetId + '" title="編輯">✏️</button>' +
      '<button class="icon-btn exit" data-act="exit" data-id="' + b.spreadsheetId + '" data-name="' + esc(b.billName) + '" title="退出">🚪</button>'
    : b.isLocked
      ? '<span class="tag tag-locked" style="margin-right:8px">已鎖定</span>'
      : '<button class="icon-btn join" data-act="join" data-id="' + b.spreadsheetId + '" data-name="' + esc(b.billName) + '" title="加入">➕</button>';
  return '<div class="card glass">' +
    '<div class="card-main" data-act="open" data-id="' + b.spreadsheetId + '">' +
    '<div class="card-emoji">' + (b.isLocked ? '🔒' : '🧾') + '</div>' +
    '<div class="card-body"><h3>' + esc(b.billName) + '</h3>' +
    (b.description ? '<p class="card-desc">' + esc(b.description) + '</p>' : '') +
    '<div class="card-meta"><span>' + count + ' 人</span><span class="dot">·</span>' +
    '<span class="tag ' + (b.isLocked ? 'tag-locked' : 'tag-active') + '">' + (b.isLocked ? '已鎖定' : '進行中') + '</span></div>' +
    '</div></div><div class="card-actions">' + actions + '</div></div>';
}

function renderList() {
  S.view = 'list';
  var j = S.bills.joined, nj = S.bills.notJoined;
  $app().innerHTML = headerHTML({ title: '分帳帳單', sub: DEV ? '示範模式' : '群組帳單管理' }) +
    '<main class="main">' +
    '<section class="section"><div class="section-head"><h2>我的帳單</h2><span class="badge">' + j.length + '</span></div>' +
    '<div>' + (j.length === 0 ? '<p class="empty">尚未加入任何帳單</p>' : j.map(function(b){ return billCard(b, true); }).join('')) + '</div></section>' +
    '<section class="section"><div class="section-head"><h2>可加入的帳單</h2><span class="badge">' + nj.length + '</span></div>' +
    '<div>' + (nj.length === 0 ? '<p class="empty">沒有可加入的帳單</p>' : nj.map(function(b){ return billCard(b, false); }).join('')) + '</div></section>' +
    '</main><button class="fab" id="fab-new">＋</button>';

  document.getElementById('fab-new').onclick = onCreateBill;
  $app().onclick = function(e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var act = el.dataset.act, id = el.dataset.id, name = el.dataset.name;
    if (act === 'open') { loadBill(id); return; }
    if (act === 'edit') { var b = j.concat(nj).find(function(x){ return x.spreadsheetId === id; }); onEditBill(b); return; }
    if (act === 'join') {
      confirm('確定要加入「' + name + '」嗎？').then(function(ok) {
        if (!ok) return;
        setLoading(true);
        api.joinBill(id).then(function(r) {
          setLoading(false);
          if (r.error) { toast(r.error, 'error'); return; }
          toast('已加入帳單！', 'success'); loadList();
        }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
      });
      return;
    }
    if (act === 'exit') {
      confirm('確定要退出「' + name + '」嗎？\n退出後，您相關的帳目將被封存。').then(function(ok) {
        if (!ok) return;
        setLoading(true);
        api.exitBill(id).then(function(r) {
          setLoading(false);
          if (r.error) { toast(r.error, 'error'); return; }
          toast('已退出帳單', 'success'); loadList();
        }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
      });
    }
  };
}

// ── View: Bill Detail ─────────────────────────────────────────────────────────
function loadBill(id) {
  setLoading(true);
  api.getBill(id).then(function(r) {
    setLoading(false);
    if (r.error) { toast(r.error, 'error'); return; }
    S.bill = r; renderBill();
  }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
}

function itemCard(item, locked) {
  var pName = memberName(item.payerId);
  var pNames = item.participantIds.map(function(u){ return '<span class="participant-chip">' + esc(memberName(u)) + '</span>'; }).join('');
  return '<div class="card item-card glass">' +
    '<div class="item-top"><div class="item-name">' + esc(item.description) + '</div><div class="item-amount">' + fmt(item.amount) + '</div></div>' +
    '<div class="item-meta"><span>付款：</span><span class="payer-chip">' + esc(pName) + '</span><span>分攤：</span>' + pNames + '</div>' +
    (!locked ? '<div class="item-actions"><button class="icon-btn edit" data-act="edit-item" data-id="' + item.itemId + '" title="編輯">✏️</button><button class="icon-btn del" data-act="del-item" data-id="' + item.itemId + '" data-name="' + esc(item.description) + '" title="刪除">🗑</button></div>' : '') +
    '</div>';
}

function renderBill() {
  S.view = 'bill';
  var b = S.bill, isCreator = b.creatorId === S.userId;
  var actMs = activeMembers();
  var visible = b.items.filter(function(i){ return !i.isArchived; });
  var total = visible.reduce(function(s, i){ return s + i.amount; }, 0);

  var creatorBtns = isCreator
    ? (!b.isLocked ? '<button class="btn btn-warn btn-sm" id="btn-lock">🔒 結算並鎖定</button>' : '<button class="btn btn-primary btn-sm" id="btn-settle">📊 查看結算</button>') +
      (!b.isLocked ? '<button class="btn btn-ghost btn-sm" id="btn-edit-bill">✏️ 編輯</button>' : '') +
      '<button class="btn btn-danger btn-sm" id="btn-del-bill">🗑 刪除帳單</button>'
    : (!b.isLocked ? '' : '<button class="btn btn-ghost btn-sm" id="btn-settle">📊 查看結算</button>');

  $app().innerHTML = headerHTML({ back: true, title: b.billName, sub: b.isLocked ? '🔒 已鎖定' : '✅ 進行中' }) +
    '<main class="main">' +
    '<div class="bill-meta-card glass">' +
    (b.description ? '<p class="bill-meta-desc">' + esc(b.description) + '</p>' : '') +
    '<div class="bill-stats"><span class="tag ' + (b.isLocked ? 'tag-locked' : 'tag-active') + '">' + (b.isLocked ? '已鎖定' : '進行中') + '</span>' +
    '<span class="tag" style="background:rgba(0,0,0,.06)">👥 ' + actMs.length + ' 人</span>' +
    '<span class="tag" style="background:rgba(0,0,0,.06)">📋 ' + visible.length + ' 筆</span></div>' +
    (creatorBtns ? '<div class="bill-actions">' + creatorBtns + '</div>' : '') + '</div>' +

    '<div class="glass" style="border-radius:var(--radius);margin-bottom:20px;overflow:hidden">' +
    '<button class="members-toggle open" id="mtoggle">成員 <span style="color:var(--text-3);font-weight:400">(' + actMs.length + ')</span><span class="chevron">▾</span></button>' +
    '<div class="members-list" id="mlist">' +
    b.members.map(function(m) {
      var av = m.pictureUrl
        ? '<div class="member-avatar"><img src="' + esc(m.pictureUrl) + '" onerror="this.parentNode.innerHTML=\'' + initial(m.displayName) + '\'" /></div>'
        : '<div class="member-avatar">' + initial(m.displayName) + '</div>';
      return '<div class="member-row ' + (m.isActive ? '' : 'member-inactive') + '">' +
        av + '<span class="member-name">' + esc(m.displayName) + '</span>' +
        (m.userId === b.creatorId ? '<span class="member-tag">開單人</span>' : '') +
        (!m.isActive ? '<span class="member-tag">已退出</span>' : '') + '</div>';
    }).join('') + '</div></div>' +

    '<div class="section-head" style="padding:0 4px;margin-bottom:12px">' +
    '<h2 style="font-size:13px;font-weight:700;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em">帳目明細</h2>' +
    '<span class="badge">' + visible.length + '</span></div>' +
    (visible.length === 0 ? '<p class="empty">尚無帳目，點擊下方 ＋ 新增</p>' : '') +
    '<div id="items-list">' + visible.map(function(i){ return itemCard(i, b.isLocked); }).join('') + '</div>' +
    (visible.length > 0 ? '<div class="glass" style="border-radius:var(--radius);padding:16px 20px;margin-top:8px;text-align:center"><div style="font-size:12px;color:var(--text-3);margin-bottom:4px">總金額</div><div style="font-size:22px;font-weight:700;color:var(--primary-text)">' + fmt(total) + '</div></div>' : '') +
    '</main>' + (!b.isLocked ? '<button class="fab" id="fab-item">＋</button>' : '');

  document.getElementById('back-btn').onclick = function() { loadList(); };
  document.getElementById('mtoggle').onclick = function() {
    var btn = document.getElementById('mtoggle'), list = document.getElementById('mlist');
    list.style.display = btn.classList.toggle('open') ? '' : 'none';
  };
  setHandler('btn-lock',     onLockBill);
  setHandler('btn-settle',   onViewSettlement);
  setHandler('btn-del-bill', onDeleteBill);
  setHandler('btn-edit-bill', function() { onEditBill(b); });
  setHandler('fab-item',     onAddItem);

  document.getElementById('items-list').onclick = function(e) {
    var el = e.target.closest('[data-act]'); if (!el) return;
    var act = el.dataset.act, id = el.dataset.id, name = el.dataset.name;
    if (act === 'edit-item') {
      onEditItem(b.items.find(function(i){ return i.itemId === id; }));
    } else if (act === 'del-item') {
      confirm('確定要刪除「' + name + '」嗎？').then(function(ok) {
        if (!ok) return;
        setLoading(true);
        api.deleteItem(b.spreadsheetId, id).then(function(r) {
          setLoading(false);
          if (r.error) { toast(r.error, 'error'); return; }
          toast('已刪除', 'success'); loadBill(b.spreadsheetId);
        }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
      });
    }
  };
}

function onLockBill() {
  setLoading(true);
  api.getSettlement(S.bill.spreadsheetId).then(function(r) {
    setLoading(false);
    if (r.error) { toast(r.error, 'error'); return; }
    S.settlement = r; renderSettlement(true);
  }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
}

function onViewSettlement() {
  setLoading(true);
  api.getSettlement(S.bill.spreadsheetId).then(function(r) {
    setLoading(false);
    if (r.error) { toast(r.error, 'error'); return; }
    S.settlement = r; renderSettlement(false);
  }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
}

function onDeleteBill() {
  confirm('確定要刪除「' + S.bill.billName + '」嗎？\n此操作無法復原。').then(function(ok) {
    if (!ok) return;
    setLoading(true);
    api.deleteBill(S.bill.spreadsheetId).then(function(r) {
      setLoading(false);
      if (r.error) { toast(r.error, 'error'); return; }
      toast('帳單已刪除', 'success'); S.bill = null; loadList();
    }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
  });
}

// ── View: Settlement ──────────────────────────────────────────────────────────
function renderSettlement(showLock) {
  S.view = 'settlement';
  var transfers = S.settlement.transfers, balances = S.settlement.balances;
  $app().innerHTML = headerHTML({ back: true, title: '結算結果', sub: S.bill.billName }) +
    '<main class="main">' +
    '<div class="settle-card glass"><div class="settle-section-title">轉帳清單（最少 ' + transfers.length + ' 筆）</div>' +
    (transfers.length === 0 ? '<p class="settle-empty">✅ 所有人都平帳了！</p>' :
      transfers.map(function(t){ return '<div class="transfer-row"><span class="t-from">' + esc(t.fromName) + '</span><span class="t-arrow">→</span><span class="t-to">' + esc(t.toName) + '</span><span class="t-amount">' + fmt(t.amount) + '</span></div>'; }).join('')) +
    '</div><div class="settle-card glass"><div class="settle-section-title">個人餘額</div>' +
    balances.map(function(b) {
      var cls = b.amount > 0 ? 'b-pos' : b.amount < 0 ? 'b-neg' : 'b-zero';
      return '<div class="balance-row"><span class="b-name">' + esc(b.displayName) + '</span><span class="b-amount ' + cls + '">' + (b.amount > 0 ? '+' : '') + fmt(b.amount) + '</span></div>';
    }).join('') + '</div>' +
    (showLock ? '<div style="margin-top:20px;display:flex;gap:10px"><button class="btn btn-ghost" id="s-back" style="flex:1;justify-content:center">返回帳單</button><button class="btn btn-warn" id="s-lock" style="flex:1;justify-content:center">🔒 確認鎖定</button></div>' : '') +
    '</main>';

  document.getElementById('back-btn').onclick = function() { renderBill(); };
  setHandler('s-back', function() { renderBill(); });
  setHandler('s-lock', function() {
    confirm('確定要鎖定帳單嗎？\n鎖定後將無法再新增或修改帳目。').then(function(ok) {
      if (!ok) return;
      setLoading(true);
      api.lockBill(S.bill.spreadsheetId).then(function(r) {
        setLoading(false);
        if (r.error) { toast(r.error, 'error'); return; }
        toast('帳單已鎖定！', 'success'); loadBill(S.bill.spreadsheetId);
      }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
    });
  });
}

// ── Forms: Bill ───────────────────────────────────────────────────────────────
function onCreateBill() {
  openSheet('新增帳單', '<div class="field"><label>帳單名稱 *</label><input name="billName" required maxlength="50" placeholder="例：東京旅遊分帳" /></div><div class="field"><label>描述（選填）</label><textarea name="description" placeholder="簡短說明…"></textarea></div>')
    .then(function(data) {
      if (!data || !data.billName.trim()) return;
      setLoading(true);
      api.createBill({ billName: data.billName.trim(), description: data.description.trim() || '' }).then(function(r) {
        setLoading(false);
        if (r.error) { toast(r.error, 'error'); return; }
        toast('帳單已建立！', 'success'); loadBill(r.spreadsheetId);
      }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
    });
}

function onEditBill(b) {
  openSheet('編輯帳單', '<div class="field"><label>帳單名稱 *</label><input name="billName" required maxlength="50" value="' + esc(b.billName) + '" /></div><div class="field"><label>描述</label><textarea name="description">' + esc(b.description || '') + '</textarea></div>')
    .then(function(data) {
      if (!data || !data.billName.trim()) return;
      setLoading(true);
      api.updateBill(b.spreadsheetId, { billName: data.billName.trim(), description: data.description.trim() || '' }).then(function(r) {
        setLoading(false);
        if (r.error) { toast(r.error, 'error'); return; }
        toast('已更新', 'success');
        if (S.view === 'list') loadList(); else loadBill(b.spreadsheetId);
      }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
    });
}

// ── Forms: Item ───────────────────────────────────────────────────────────────
function itemFormHTML(item) {
  var ms = activeMembers();
  var payerOpts = ms.map(function(m) {
    return '<option value="' + m.userId + '"' + (item && item.payerId === m.userId ? ' selected' : '') + '>' + esc(m.displayName) + '</option>';
  }).join('');
  var checks = ms.map(function(m) {
    var chk = !item || item.participantIds.indexOf(m.userId) !== -1 ? ' checked' : '';
    return '<label class="cb-row"><input type="checkbox" name="participantIds" value="' + m.userId + '"' + chk + ' /><span>' + esc(m.displayName) + '</span></label>';
  }).join('');
  return '<div class="field"><label>描述 *</label><input name="description" required maxlength="60" placeholder="例：晚餐" value="' + esc(item ? item.description : '') + '" /></div>' +
    '<div class="field"><label>金額 (NT$) *</label><input name="amount" type="number" min="0" step="1" required placeholder="0" value="' + (item ? item.amount : '') + '" /></div>' +
    '<div class="field"><label>付款人</label><select name="payerId">' + payerOpts + '</select></div>' +
    '<div class="field"><label>分攤成員</label><div class="checkboxes">' + checks + '</div></div>';
}

function onAddItem() {
  openSheet('新增帳目', itemFormHTML(null)).then(function(data) {
    if (!data) return;
    if (!data.description.trim() || !data.amount || !data.participantIds.length) { toast('請填寫完整資訊並選擇分攤成員', 'error'); return; }
    setLoading(true);
    api.addItem(S.bill.spreadsheetId, { description: data.description.trim(), amount: parseFloat(data.amount), payerId: data.payerId, participantIds: data.participantIds }).then(function(r) {
      setLoading(false);
      if (r.error) { toast(r.error, 'error'); return; }
      toast('已新增帳目！', 'success'); loadBill(S.bill.spreadsheetId);
    }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
  });
}

function onEditItem(item) {
  openSheet('編輯帳目', itemFormHTML(item)).then(function(data) {
    if (!data) return;
    if (!data.description.trim() || !data.amount || !data.participantIds.length) { toast('請填寫完整資訊並選擇分攤成員', 'error'); return; }
    setLoading(true);
    api.updateItem(S.bill.spreadsheetId, item.itemId, { description: data.description.trim(), amount: parseFloat(data.amount), payerId: data.payerId, participantIds: data.participantIds }).then(function(r) {
      setLoading(false);
      if (r.error) { toast(r.error, 'error'); return; }
      toast('已更新', 'success'); loadBill(S.bill.spreadsheetId);
    }).catch(function(e) { setLoading(false); toast(e.message, 'error'); });
  });
}

// ── Load script ───────────────────────────────────────────────────────────────
function loadScript(src) {
  return new Promise(function(resolve, reject) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = function() { reject(new Error('無法載入 LIFF SDK')); };
    document.head.appendChild(s);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
  var params = new URLSearchParams(location.search);

  if (DEV) {
    S.userId      = params.get('userId')  || 'dev-user-001';
    S.displayName = params.get('name')    || 'Dev User';
    S.pictureUrl  = '';
    S.groupId     = params.get('groupId') || 'dev-group-001';
    api = buildMockApi();
    loadList();
    return;
  }

  if (!GAS_URL || GAS_URL.indexOf('YOUR_') === 0) {
    $app().innerHTML = '<div class="error-screen"><div class="ei">⚙️</div><p>請先在 <code>app.js</code> 頂部填入 <code>GAS_URL</code> 和 <code>LIFF_ID</code></p></div>';
    return;
  }

  loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js').then(function() {
    return liff.init({ liffId: LIFF_ID });
  }).then(function() {
    if (!liff.isLoggedIn()) { liff.login(); return; }
    return liff.getProfile().then(function(profile) {
      S.userId = profile.userId;
      S.displayName = profile.displayName;
      S.pictureUrl = profile.pictureUrl;
      var ctx = liff.getContext();
      S.groupId = (ctx && ctx.groupId) || params.get('groupId');
      if (!S.groupId) {
        $app().innerHTML = '<div class="error-screen"><div class="ei">⚠️</div><p>請從 LINE 群組中開啟此頁面</p><pre style="font-size:10px;text-align:left;margin-top:12px;padding:8px;background:rgba(0,0,0,.06);border-radius:8px;overflow:auto;white-space:pre-wrap">' + esc(JSON.stringify(ctx, null, 2)) + '</pre></div>';
        return;
      }
      api = buildRealApi();
      loadList();
      if (S.pictureUrl) api.updateAvatar(S.pictureUrl).catch(function() {});
    });
  }).catch(function(e) {
    console.error(e);
    $app().innerHTML = '<div class="error-screen"><div class="ei">❌</div><p>' + esc(e.message) + '</p></div>';
  });
}

init();
