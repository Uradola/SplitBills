// ── 設定：填入你的 Google Drive 資料夾 ID ────────────────────────────────────
var FOLDER_ID = '1TYyRJMZedPRFfF9fuRRVXSRn2m-o6AsE';

// ── Entry points ──────────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var p = e.parameter;
    var result;
    switch (p.action) {
      case 'getBills':      result = apiBillsList(p.groupId, p.userId); break;
      case 'getBill':       result = apiBillGet(p.billId); break;
      case 'getSettlement': result = apiSettlement(p.billId); break;
      default: result = { error: 'Unknown action: ' + p.action };
    }
    return out(result);
  } catch (err) {
    return out({ error: err.message });
  }
}

function doPost(e) {
  try {
    var p = e.parameter;
    var result;
    switch (p.action) {
      case 'createBill':  result = apiCreateBill(p);  break;
      case 'updateBill':  result = apiUpdateBill(p);  break;
      case 'deleteBill':  result = apiDeleteBill(p);  break;
      case 'joinBill':    result = apiJoinBill(p);    break;
      case 'exitBill':    result = apiExitBill(p);    break;
      case 'lockBill':    result = apiLockBill(p);    break;
      case 'addItem':     result = apiAddItem(p);     break;
      case 'updateItem':  result = apiUpdateItem(p);  break;
      case 'deleteItem':    result = apiDeleteItem(p);    break;
      case 'updateAvatar':  result = apiUpdateAvatar(p);  break;
      default: result = { error: 'Unknown action: ' + p.action };
    }
    return out(result);
  } catch (err) {
    return out({ error: err.message });
  }
}

function out(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Bill CRUD ─────────────────────────────────────────────────────────────────

// ponytail: opens each spreadsheet sequentially; fine for <30 bills, add CacheService if slow
function apiBillsList(groupId, userId) {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var iter = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  var joined = [], notJoined = [];
  while (iter.hasNext()) {
    var file = iter.next();
    if ((file.getDescription() || '').indexOf('groupId:' + groupId) !== 0) continue;
    try {
      var info = readMeta(file.getId());
      var isMember = info.members.some(function(m) { return m.userId === userId && m.isActive; });
      if (isMember) joined.push(info); else notJoined.push(info);
    } catch (e) { /* skip corrupted sheets */ }
  }
  return { joined: joined, notJoined: notJoined };
}

function apiBillGet(billId) {
  var ss = SpreadsheetApp.openById(billId);
  var meta = parseMeta(billId, ss.getSheetByName('帳單資訊'));
  var items = parseItems(ss.getSheetByName('帳目明細'));
  return merge(meta, { items: items });
}

function apiCreateBill(p) {
  var ss = SpreadsheetApp.create(p.billName);
  var id = ss.getId();

  // Move to target folder
  var file = DriveApp.getFileById(id);
  var folder = DriveApp.getFolderById(FOLDER_ID);
  folder.addFile(file);
  var parents = file.getParents();
  while (parents.hasNext()) {
    var par = parents.next();
    if (par.getId() !== FOLDER_ID) par.removeFile(file);
  }
  file.setDescription('groupId:' + p.groupId);

  var now = new Date().toISOString();
  var s1 = ss.getActiveSheet().setName('帳單資訊');
  var s2 = ss.insertSheet('帳目明細');

  s1.getRange(1, 1, 6, 2).setValues([
    ['帳單名稱', p.billName],
    ['描述',     p.description || ''],
    ['群組ID',   p.groupId],
    ['開單人ID', p.creatorId],
    ['已鎖定',   false],
    ['建立時間', now],
  ]);
  s1.getRange(8, 1, 1, 5).setValues([['使用者ID', '顯示名稱', '加入時間', '狀態', '頭貼URL']]);
  var creatorPic = p.pictureUrl ? (saveAvatarToDrive(p.creatorId, p.pictureUrl) || '') : '';
  s1.getRange(9, 1, 1, 5).setValues([[p.creatorId, p.creatorName, now, true, creatorPic]]);
  s2.getRange(1, 1, 1, 7).setValues([['項目ID', '描述', '金額', '付款人ID', '參與者IDs', '已封存', '建立時間']]);

  return { spreadsheetId: id, ok: true };
}

function apiUpdateBill(p) {
  var meta = readMeta(p.billId);
  if (meta.creatorId !== p.userId) throw new Error('只有開單人可以編輯帳單');
  if (meta.isLocked) throw new Error('帳單已鎖定');
  var s1 = SpreadsheetApp.openById(p.billId).getSheetByName('帳單資訊');
  s1.getRange(1, 2).setValue(p.billName);
  s1.getRange(2, 2).setValue(p.description || '');
  DriveApp.getFileById(p.billId).setName(p.billName);
  return { ok: true };
}

function apiDeleteBill(p) {
  var meta = readMeta(p.billId);
  if (meta.creatorId !== p.userId) throw new Error('只有開單人可以刪除帳單');
  DriveApp.getFileById(p.billId).setTrashed(true);
  return { ok: true };
}

function apiLockBill(p) {
  var meta = readMeta(p.billId);
  if (meta.creatorId !== p.userId) throw new Error('只有開單人可以鎖定');
  SpreadsheetApp.openById(p.billId).getSheetByName('帳單資訊').getRange(5, 2).setValue(true);
  return { ok: true };
}

// ── Members ───────────────────────────────────────────────────────────────────

function apiJoinBill(p) {
  var meta = readMeta(p.billId);
  if (meta.isLocked) throw new Error('帳單已鎖定，無法加入');
  var idx = findMember(meta.members, p.userId);
  if (idx !== -1 && meta.members[idx].isActive) throw new Error('您已在此帳單中');
  var s1 = SpreadsheetApp.openById(p.billId).getSheetByName('帳單資訊');
  var pic = p.pictureUrl ? (saveAvatarToDrive(p.userId, p.pictureUrl) || '') : '';
  if (idx !== -1) {
    s1.getRange(9 + idx, 4).setValue(true);
    if (pic) s1.getRange(9 + idx, 5).setValue(pic);
  } else {
    s1.getRange(9 + meta.members.length, 1, 1, 5)
      .setValues([[p.userId, p.displayName, new Date().toISOString(), true, pic]]);
  }
  return { ok: true };
}

function apiExitBill(p) {
  var meta = readMeta(p.billId);
  if (meta.isLocked) throw new Error('帳單已鎖定');
  if (meta.creatorId === p.userId) throw new Error('開單人請直接刪除帳單');
  var idx = findMember(meta.members, p.userId);
  if (idx === -1) throw new Error('您不在此帳單中');
  var ss = SpreadsheetApp.openById(p.billId);
  ss.getSheetByName('帳單資訊').getRange(9 + idx, 4).setValue(false);
  var s2 = ss.getSheetByName('帳目明細');
  var items = parseItems(s2);
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it.isArchived && (it.payerId === p.userId || it.participantIds.indexOf(p.userId) !== -1)) {
      s2.getRange(2 + i, 6).setValue(true);
    }
  }
  return { ok: true };
}

// ── Items ─────────────────────────────────────────────────────────────────────

function apiAddItem(p) {
  var meta = readMeta(p.billId);
  if (meta.isLocked) throw new Error('帳單已鎖定');
  var s2 = SpreadsheetApp.openById(p.billId).getSheetByName('帳目明細');
  var items = parseItems(s2);
  var id = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  s2.getRange(2 + items.length, 1, 1, 7).setValues([
    [id, p.description, Number(p.amount), p.payerId, p.participantIds, false, new Date().toISOString()]
  ]);
  return { itemId: id, ok: true };
}

function apiUpdateItem(p) {
  var meta = readMeta(p.billId);
  if (meta.isLocked) throw new Error('帳單已鎖定');
  var s2 = SpreadsheetApp.openById(p.billId).getSheetByName('帳目明細');
  var items = parseItems(s2);
  var idx = findItem(items, p.itemId);
  if (idx === -1) throw new Error('找不到帳目');
  s2.getRange(2 + idx, 2, 1, 4).setValues([[p.description, Number(p.amount), p.payerId, p.participantIds]]);
  return { ok: true };
}

function apiDeleteItem(p) {
  var meta = readMeta(p.billId);
  if (meta.isLocked) throw new Error('帳單已鎖定');
  var s2 = SpreadsheetApp.openById(p.billId).getSheetByName('帳目明細');
  var items = parseItems(s2);
  var idx = findItem(items, p.itemId);
  if (idx !== -1) s2.getRange(2 + idx, 6).setValue(true);
  return { ok: true };
}

// ── Settlement ────────────────────────────────────────────────────────────────

function apiSettlement(billId) {
  var ss = SpreadsheetApp.openById(billId);
  var meta  = parseMeta(billId, ss.getSheetByName('帳單資訊'));
  var items = parseItems(ss.getSheetByName('帳目明細'));

  var nameMap = {};
  meta.members.forEach(function(m) { nameMap[m.userId] = m.displayName; });

  var bal = {};
  meta.members.filter(function(m) { return m.isActive; })
    .forEach(function(m) { bal[m.userId] = 0; });

  items.filter(function(i) { return !i.isArchived && i.participantIds.length > 0; })
    .forEach(function(it) {
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
  pos.sort(function(a, b) { return b.v - a.v; });
  neg.sort(function(a, b) { return b.v - a.v; });

  var transfers = [], i = 0, j = 0;
  while (i < pos.length && j < neg.length) {
    var t = Math.min(pos[i].v, neg[j].v);
    transfers.push({
      from: neg[j].uid, fromName: nameMap[neg[j].uid] || neg[j].uid,
      to:   pos[i].uid, toName:   nameMap[pos[i].uid] || pos[i].uid,
      amount: Math.round(t * 100) / 100,
    });
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

// ── Sheet helpers ─────────────────────────────────────────────────────────────

function readMeta(spreadsheetId) {
  return parseMeta(spreadsheetId, SpreadsheetApp.openById(spreadsheetId).getSheetByName('帳單資訊'));
}

function parseMeta(spreadsheetId, sheet) {
  var nRows = Math.max(sheet.getLastRow(), 9);
  var data  = sheet.getRange(1, 1, nRows, 5).getValues();
  var members = [];
  for (var i = 8; i < data.length; i++) {
    if (!data[i][0]) continue;
    members.push({
      userId:      String(data[i][0]),
      displayName: String(data[i][1] || ''),
      joinedAt:    String(data[i][2] || ''),
      isActive:    data[i][3] !== false && String(data[i][3]) !== 'FALSE',
      pictureUrl:  String(data[i][4] || ''),
    });
  }
  return {
    spreadsheetId: spreadsheetId,
    billName:    String(data[0][1] || ''),
    description: String(data[1][1] || ''),
    groupId:     String(data[2][1] || ''),
    creatorId:   String(data[3][1] || ''),
    isLocked:    data[4][1] === true || String(data[4][1]) === 'TRUE',
    createdAt:   String(data[5][1] || ''),
    members:     members,
  };
}

function parseItems(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var data = sheet.getRange(2, 1, last - 1, 7).getValues();
  return data.filter(function(r) { return r[0]; }).map(function(r) {
    return {
      itemId:         String(r[0]),
      description:    String(r[1] || ''),
      amount:         Number(r[2]) || 0,
      payerId:        String(r[3] || ''),
      participantIds: r[4] ? String(r[4]).split(',').filter(Boolean) : [],
      isArchived:     r[5] === true || String(r[5]) === 'TRUE',
      createdAt:      String(r[6] || ''),
    };
  });
}

function findMember(members, userId) {
  for (var i = 0; i < members.length; i++) { if (members[i].userId === userId) return i; }
  return -1;
}

function findItem(items, itemId) {
  for (var i = 0; i < items.length; i++) { if (items[i].itemId === itemId) return i; }
  return -1;
}

function merge(a, b) {
  var c = {};
  Object.keys(a).forEach(function(k) { c[k] = a[k]; });
  Object.keys(b).forEach(function(k) { c[k] = b[k]; });
  return c;
}

// ── Avatar (Drive storage) ────────────────────────────────────────────────────

function getAvatarFolder() {
  var parent = DriveApp.getFolderById(FOLDER_ID);
  var iter = parent.getFoldersByName('avatars');
  return iter.hasNext() ? iter.next() : parent.createFolder('avatars');
}

// ponytail: delete-then-create to keep one file per user; Drive trash auto-purges after 30 days
function saveAvatarToDrive(userId, lineUrl) {
  try {
    var folder = getAvatarFolder();
    var old = folder.getFilesByName(userId);
    while (old.hasNext()) old.next().setTrashed(true);
    var blob = UrlFetchApp.fetch(lineUrl, { muteHttpExceptions: true }).getBlob().setName(userId);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return 'https://drive.google.com/uc?id=' + file.getId() + '&export=view';
  } catch (e) {
    return '';
  }
}

// Called from frontend on init (fire-and-forget); updates avatar in all group bills
function apiUpdateAvatar(p) {
  if (!p.userId || !p.pictureUrl || !p.groupId) return { ok: true };
  var driveUrl = saveAvatarToDrive(p.userId, p.pictureUrl);
  if (!driveUrl) return { ok: true };
  var iter = DriveApp.getFolderById(FOLDER_ID).getFilesByType(MimeType.GOOGLE_SHEETS);
  while (iter.hasNext()) {
    var file = iter.next();
    if ((file.getDescription() || '').indexOf('groupId:' + p.groupId) !== 0) continue;
    try {
      var s1 = SpreadsheetApp.openById(file.getId()).getSheetByName('帳單資訊');
      if (!s1 || s1.getLastRow() < 9) continue;
      var col = s1.getRange(9, 1, s1.getLastRow() - 8, 1).getValues();
      for (var i = 0; i < col.length; i++) {
        if (String(col[i][0]) === p.userId) { s1.getRange(9 + i, 5).setValue(driveUrl); break; }
      }
    } catch (e) { /* skip */ }
  }
  return { ok: true, driveUrl: driveUrl };
}
