/* =========================================================
   松山YEG 夜の飲食店MAP  ―  バックエンド（Google Apps Script）
   ---------------------------------------------------------
   シートは2枚に分けて使う。

     [フォームの回答 1]  生の回答。運営は触らない
            │  ② 新しい回答を取り込む（メールアドレスは取り込まない）
            ▼
     [MAP掲載]           サイト用のシート。運営が表記を整えて「掲載」にチェック
            │  ③ MAPに反映（位置・写真の公開設定、公開データの作成）
            ▼
     doGet() がMAP掲載シートの掲載分だけをJSONで返す → サイト

   スプレッドシートの「拡張機能 → Apps Script」に貼り付けて使う。

   【公開の安全性について】
   - サイトが読むMAP掲載シートには、メールアドレスが最初から存在しない。
     （氏名は「店舗の代表者」としてサイトに表示する）
   - さらに外部に返す項目は toPublicShop() に書いたものだけに限っている。
   - doGet はURLのパラメータを一切受け付けない（読む場所を外から選ばせない）。
   - 書き込み用の窓口（doPost）は作らない。
   ========================================================= */

const CONFIG = {
  FORM_SHEET: 'フォームの回答 1',
  MAP_SHEET:  'MAP掲載',

  // 回答シートから取り込む列。見出しの「先頭一致」で探すので、
  // 「※MAPに掲載」などの注記が変わってもそのまま動く。
  // メールアドレスはここに無いので、MAP掲載シートには入らない。
  FORM_COLUMNS: {
    timestamp: 'タイムスタンプ',
    owner:     '氏名',
    name:      '店舗名',
    address:   '住所',
    tel:       '連絡先',
    hours:     '営業時間',
    category:  '主な業態',
    image:     '店舗ロゴ',
    capacity:  '最大収容人数'
  },

  // MAP掲載シートの列（「① MAP掲載シートを準備」でこの順に作られる）。
  // 列は見出しの名前で探すので、作成後に並べ替えても動く。
  MAP_COLUMNS: {
    owner:       '氏名',        // 店舗の代表者としてサイトに表示
    name:        '店舗名',
    address:     '住所',
    tel:         '連絡先',
    hours:       '営業時間',    // hh:mm-hh:mm（24時間表記）
    image:       '店舗ロゴ',
    capacity:    '収容人数',
    // ---- 以下は補助列 ----
    publish:     '掲載',
    category:    '業態',        // ジャンルの絞り込みに使う
    area:        'エリア',      // 運営が手で入力（例：中心地）。空欄ならエリアなし
    lat:         '緯度',
    lng:         '経度',
    memo:        '確認メモ',
    respondedAt: '回答日時'
  },

  // 公開データの保存時間。「③ MAPに反映」を押すと作り直される。
  CACHE_SECONDS: 6 * 60 * 60,
  CACHE_KEY: 'public-shops-v2',

  // どの回答まで取り込んだか（スクリプト プロパティに保存）
  LAST_IMPORT_KEY: 'lastImportedAt'
};

/* ---------------------------------------------------------
   公開API：サイトが呼び出す
   --------------------------------------------------------- */

function doGet() {
  try {
    const cached = CacheService.getScriptCache().get(CONFIG.CACHE_KEY);
    return jsonOutput(cached || refreshPublicCache());
  } catch (err) {
    // 詳細はApps Scriptの「実行数」画面でのみ確認できる。外にはシート名などを出さない。
    console.error(err);
    return jsonOutput(JSON.stringify({ error: '店舗データの取得に失敗しました' }));
  }
}

function jsonOutput(body) {
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

/* 公開データを作り直して保存する */
function refreshPublicCache() {
  const body = JSON.stringify({
    shops: buildPublicShops(),
    updatedAt: new Date().toISOString()
  });

  // 保存できるのは1件100KBまで。超えたら保存せず毎回作る。
  if (Utilities.newBlob(body).getBytes().length < 95 * 1024) {
    CacheService.getScriptCache().put(CONFIG.CACHE_KEY, body, CONFIG.CACHE_SECONDS);
  }
  return body;
}

/* MAP掲載シートのうち、掲載チェック済みで位置があるお店だけを返す */
function buildPublicShops() {
  const map = readSheet(CONFIG.MAP_SHEET);
  const mc = findColumns(map.header, CONFIG.MAP_COLUMNS);

  if (mc.publish < 0 || mc.name < 0 || mc.lat < 0 || mc.lng < 0) {
    throw new Error('MAP掲載シートの列が足りません。「MAP管理 → ① MAP掲載シートを準備」を実行してください');
  }

  const shops = [];
  map.values.forEach((row, i) => {
    if (!isChecked(row[mc.publish])) return;
    if (!cell(map.display[i], mc.name)) return;
    if (row[mc.lat] === '' || row[mc.lng] === '') return;

    const lat = Number(row[mc.lat]);
    const lng = Number(row[mc.lng]);
    if (!isFinite(lat) || !isFinite(lng)) return;

    shops.push(toPublicShop(map.display[i], mc, lat, lng));
  });
  return shops;
}

/* 1行分を公開用の形にする。ここに書いた項目以外は外に出ない。 */
function toPublicShop(disp, mc, lat, lng) {
  const name = cell(disp, mc.name);
  const address = cell(disp, mc.address);
  const capacity = cell(disp, mc.capacity).normalize('NFKC');

  return {
    id:       shopId(name),
    name:     name,
    member:   cell(disp, mc.owner),
    category: cell(disp, mc.category),
    area:     cell(disp, mc.area),
    address:  address,
    tel:      cell(disp, mc.tel),
    hours:    cell(disp, mc.hours),
    seats:    /^\d+$/.test(capacity) ? `最大${capacity}名` : capacity,
    image:    driveImageUrl(cell(disp, mc.image)),
    lat:      lat,
    lng:      lng
  };
}

/* ---------------------------------------------------------
   運営用メニュー
   --------------------------------------------------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('MAP管理')
    .addItem('① MAP掲載シートを準備', 'setupMapSheet')
    .addItem('② 新しい回答を取り込む', 'importResponses')
    .addItem('③ MAPに反映（公開）', 'publishMap')
    .addSeparator()
    .addItem('選択した行の位置を住所から取り直す', 'relocateSelectedRows')
    .addItem('MAPに公開される内容を確認', 'previewPublicData')
    .addToUi();
}

/* ① MAP掲載シートを作る。すでにあれば、足りない列だけを右端に追加する。 */
function setupMapSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.MAP_SHEET);
  const created = !sheet;
  if (!sheet) sheet = ss.insertSheet(CONFIG.MAP_SHEET);

  const lastCol = sheet.getLastColumn();
  const header = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const mc = findColumns(header, CONFIG.MAP_COLUMNS);

  let next = lastCol + 1;
  const added = [];
  Object.keys(CONFIG.MAP_COLUMNS).forEach(key => {
    if (mc[key] >= 0) return;
    sheet.getRange(1, next).setValue(CONFIG.MAP_COLUMNS[key]);
    mc[key] = next - 1;
    added.push(CONFIG.MAP_COLUMNS[key]);
    next++;
  });

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');

  // チェックボックスや書式は、ここでは付けない。
  // 取り込み時に、お店の行にだけ付ける（空の行にチェックボックスがあると、
  // シートの「最後の行」が実際より下に判定されてしまうため）。

  SpreadsheetApp.getUi().alert(
    (created ? `「${CONFIG.MAP_SHEET}」シートを作成しました。` : `「${CONFIG.MAP_SHEET}」シートを確認しました。`)
    + (added.length ? `\n追加した列：${added.join('・')}` : '\n列はすべて揃っています。')
    + '\n\n続けて「② 新しい回答を取り込む」を実行してください。'
  );
}

/* ② まだ取り込んでいない回答を、MAP掲載シートに追加する */
function importResponses() {
  const ui = SpreadsheetApp.getUi();

  const form = readSheet(CONFIG.FORM_SHEET);
  const fc = findColumns(form.header, CONFIG.FORM_COLUMNS);
  if (fc.timestamp < 0 || fc.name < 0) {
    ui.alert(`「${CONFIG.FORM_SHEET}」に「タイムスタンプ」「店舗名」の列が見つかりません。`);
    return;
  }

  const mapSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.MAP_SHEET);
  if (!mapSheet) {
    ui.alert('先に「MAP管理 → ① MAP掲載シートを準備」を実行してください。');
    return;
  }
  const map = readSheet(CONFIG.MAP_SHEET);
  const mc = findColumns(map.header, CONFIG.MAP_COLUMNS);
  if (Object.keys(mc).some(k => mc[k] < 0)) {
    ui.alert('MAP掲載シートの列が足りません。「① MAP掲載シートを準備」を実行してください。');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const lastImported = Number(props.getProperty(CONFIG.LAST_IMPORT_KEY) || 0);

  // MAP掲載にすでにあるお店（店名 → 何行目か / 今回追加する行）
  const known = new Map();
  map.display.forEach((row, i) => {
    const name = cell(row, mc.name);
    if (name) known.set(normalizeName(name), { sheetIndex: i });
  });

  const geocoder = newGeocoder();
  const width = map.header.length;
  const newRows = [];
  const notesForExisting = new Map();   // MAP掲載の行番号(0始まり) → メモ
  let maxTs = lastImported;
  let skipped = 0;   // 前回までに取り込み済みの回答

  form.values.forEach((row, i) => {
    const ts = toTime(row[fc.timestamp]);
    if (!ts) return;
    if (ts <= lastImported) {
      skipped++;
      return;
    }
    maxTs = Math.max(maxTs, ts);

    const disp = form.display[i];
    const name = cell(disp, fc.name);
    if (!name) return;

    // 同じお店がすでにある → 運営が整えた内容を上書きしないよう、メモだけ残す
    const key = normalizeName(name);
    if (known.has(key)) {
      const note = `フォームに新しい回答あり（${formatTime(ts)}）`;
      const target = known.get(key);
      if (target.newRow) {
        target.newRow[mc.memo] = mergeMemo(target.newRow[mc.memo], [note]);
      } else {
        const prev = notesForExisting.get(target.sheetIndex) || map.values[target.sheetIndex][mc.memo];
        notesForExisting.set(target.sheetIndex, mergeMemo(prev, [note]));
      }
      return;
    }

    // 新しいお店 → 行を作る（数字・記号は半角にそろえる。店名・氏名は原文のまま）
    const address = cell(disp, fc.address).normalize('NFKC');
    const rawHours = cell(disp, fc.hours);
    const hours = normalizeHours(rawHours);
    const notes = [];

    const out = new Array(width).fill('');
    out[mc.owner]       = cell(disp, fc.owner);
    out[mc.name]        = name;
    out[mc.address]     = address;
    out[mc.tel]         = cell(disp, fc.tel).normalize('NFKC');
    out[mc.hours]       = hours || rawHours;
    out[mc.image]       = cell(disp, fc.image);
    out[mc.capacity]    = cell(disp, fc.capacity).normalize('NFKC');
    out[mc.publish]     = false;
    out[mc.category]    = cell(disp, fc.category);
    out[mc.respondedAt] = new Date(ts);

    if (!hours && rawHours) {
      notes.push('営業時間を hh:mm-hh:mm の形に直してください');
    } else if (hours && hours !== rawHours) {
      notes.push(`営業時間を自動変換（元の記入：${rawHours}）`);
    }

    if (address) {
      const r = geocodeAddress(geocoder, address);
      if (r.ok) {
        out[mc.lat] = r.lat;
        out[mc.lng] = r.lng;
      }
      if (r.note) notes.push(r.note);
    }
    out[mc.memo] = mergeMemo('', notes);

    newRows.push(out);
    known.set(key, { newRow: out });
  });

  // 何も取り込まれず、MAP掲載にお店も無いのに「取り込み済み」の記録だけが残っている場合は、
  // 最初から取り込み直すか確認する
  if (!newRows.length && !notesForExisting.size && skipped > 0 && known.size === 0) {
    const answer = ui.alert(
      `「${CONFIG.MAP_SHEET}」にお店がありませんが、${formatTime(lastImported)} までの回答は取り込み済みと記録されています。\n\n`
      + '最初から取り込み直しますか？',
      ui.ButtonSet.YES_NO);
    if (answer === ui.Button.YES) {
      props.deleteProperty(CONFIG.LAST_IMPORT_KEY);
      importResponses();
    }
    return;
  }

  // 新しい行は「店舗名などが実際に入っている最後の行」の次に追加する。
  // （getLastRow() だと、チェックボックスだけの行まで数えてシートの最下部に追加されることがある）
  if (newRows.length) {
    const start = lastDataRow(map.values, mc) + 1;
    const needed = start + newRows.length - 1 - mapSheet.getMaxRows();
    if (needed > 0) mapSheet.insertRowsAfter(mapSheet.getMaxRows(), needed);

    applyFormats(mapSheet, start, mc, newRows.length);   // 書き込む前に文字列扱いにしておく
    mapSheet.getRange(start, 1, newRows.length, width).setValues(newRows);
    applyCheckbox(mapSheet, start, mc.publish, newRows.length);
  }

  // 既存のお店へのメモ
  notesForExisting.forEach((memo, i) => {
    mapSheet.getRange(i + 2, mc.memo + 1).setValue(memo);
  });

  props.setProperty(CONFIG.LAST_IMPORT_KEY, String(maxTs));

  ui.alert(
    '取り込みが終わりました。\n\n'
    + `・新しいお店：${newRows.length}件（「掲載」は未チェック）\n`
    + `・すでにあるお店への新しい回答：${notesForExisting.size}件（「確認メモ」を参照）\n`
    + (skipped ? `・前回までに取り込み済みの回答：${skipped}件（${formatTime(lastImported)} まで）\n` : '')
    + `\n「${CONFIG.MAP_SHEET}」のお店：${known.size}件\n\n`
    + '表記を整えて「掲載」にチェックを入れたら、「③ MAPに反映」を押してください。'
  );
}

/* 店舗名・住所・回答日時のどれかが入っている最後の行番号（シートの行番号。お店が無ければ見出しの1） */
function lastDataRow(values, mc) {
  const keyCols = [mc.name, mc.address, mc.respondedAt];
  for (let i = values.length - 1; i >= 0; i--) {
    if (keyCols.some(c => values[i][c] !== '' && values[i][c] != null)) return i + 2;
  }
  return 1;
}

/* ③ 位置の補完と写真の公開設定を行い、公開データを作り直す */
function publishMap() {
  const ui = SpreadsheetApp.getUi();
  const map = readSheet(CONFIG.MAP_SHEET);
  const mc = findColumns(map.header, CONFIG.MAP_COLUMNS);
  if (Object.keys(mc).some(k => mc[k] < 0)) {
    ui.alert('MAP掲載シートの列が足りません。「① MAP掲載シートを準備」を実行してください。');
    return;
  }

  const geocoder = newGeocoder();
  const count = { located: 0, shared: 0, imageError: 0, noLocation: 0, badHours: 0 };
  const out = { lat: [], lng: [], memo: [] };

  map.values.forEach((row, i) => {
    const disp = map.display[i];
    let lat = row[mc.lat];
    let lng = row[mc.lng];
    const notes = [];
    const address = cell(disp, mc.address);

    // 位置が空なら住所から求める（入っている値は上書きしない）
    if ((lat === '' || lng === '') && address) {
      const r = geocodeAddress(geocoder, address);
      if (r.ok) {
        lat = r.lat;
        lng = r.lng;
        count.located++;
      }
      if (r.note) notes.push(r.note);
    }


    if (isChecked(row[mc.publish])) {
      // 掲載するお店の写真だけを「リンクを知っている全員が閲覧可」にする
      const fileId = driveFileId(cell(disp, mc.image));
      if (fileId) {
        try {
          if (shareImage(fileId)) count.shared++;
        } catch (err) {
          console.error(err);
          notes.push('写真を公開設定にできませんでした');
          count.imageError++;
        }
      }
      if (lat === '' || lng === '') {
        notes.push('位置が未入力のため、MAPに表示されません');
        count.noLocation++;
      }
      const hours = cell(disp, mc.hours);
      if (hours && !HOURS_FORMAT.test(hours)) {
        notes.push('営業時間が hh:mm-hh:mm の形ではありません（このまま表示されます）');
        count.badHours++;
      }
    }

    out.lat.push([lat]);
    out.lng.push([lng]);
    out.memo.push([mergeMemo(row[mc.memo], notes)]);
  });

  if (map.values.length) {
    writeColumn(map.sheet, mc.lat, out.lat);
    writeColumn(map.sheet, mc.lng, out.lng);
    writeColumn(map.sheet, mc.memo, out.memo);

    // 手で追加した行にもチェックボックスを付ける（お店が入っている行まで）
    const lastRow = lastDataRow(map.values, mc);
    if (lastRow >= 2) applyCheckbox(map.sheet, 2, mc.publish, lastRow - 1);
  }

  SpreadsheetApp.flush();
  const published = JSON.parse(refreshPublicCache()).shops.length;

  ui.alert(
    'MAPに反映しました。\n\n'
    + `・MAPに表示されるお店：${published}件\n`
    + `・住所から位置を取得：${count.located}件\n`
    + `・写真を公開設定に変更：${count.shared}件\n`
    + (count.imageError ? `・写真の公開に失敗：${count.imageError}件（「確認メモ」を参照）\n` : '')
    + (count.noLocation ? `・位置が無く表示できないお店：${count.noLocation}件（「確認メモ」を参照）\n` : '')
    + (count.badHours ? `・営業時間の形式が違うお店：${count.badHours}件（「確認メモ」を参照）\n` : '')
    + '\nサイトを再読み込みすると反映されます。'
  );
}

/* 住所を直したあとに、選択した行の位置を求め直す */
function relocateSelectedRows() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== CONFIG.MAP_SHEET) {
    ui.alert(`「${CONFIG.MAP_SHEET}」シートで、位置を取り直したい行を選択してから実行してください。`);
    return;
  }

  const range = sheet.getActiveRange();
  const first = Math.max(range.getRow(), 2);
  const last = range.getLastRow();
  if (last < first) {
    ui.alert('お店の行を選択してから実行してください。');
    return;
  }

  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const mc = findColumns(header, CONFIG.MAP_COLUMNS);
  const geocoder = newGeocoder();
  let done = 0;
  let failed = 0;

  for (let r = first; r <= last; r++) {
    const address = String(sheet.getRange(r, mc.address + 1).getDisplayValue()).trim();
    if (!address) continue;

    const res = geocodeAddress(geocoder, address);
    const memoCell = sheet.getRange(r, mc.memo + 1);
    if (res.ok) {
      sheet.getRange(r, mc.lat + 1, 1, 1).setValue(res.lat);
      sheet.getRange(r, mc.lng + 1, 1, 1).setValue(res.lng);
      done++;
    } else {
      failed++;
    }
    if (res.note) memoCell.setValue(mergeMemo(memoCell.getValue(), [res.note]));
  }

  ui.alert(
    `位置を取り直しました：${done}件` + (failed ? `／取得できず：${failed}件（「確認メモ」を参照）` : '')
    + '\n\nサイトに出すには「③ MAPに反映」を押してください。'
  );
}

/* 外部に返る内容を、運営が事前に確認するためのもの */
function previewPublicData() {
  const shops = buildPublicShops();
  const fields = shops.length ? Object.keys(shops[0]).join(', ') : '（なし）';
  const list = shops
    .map((s, n) => `${n + 1}. ${s.name}（${s.area || 'エリア未設定'}）`)
    .join('\n');

  SpreadsheetApp.getUi().alert(
    `MAPに公開されるお店：${shops.length}件\n\n`
    + (list || '（掲載チェック済みで、位置が入っているお店がありません）')
    + `\n\n外部に返す項目：${fields}`
    + '\n\n※サイトに出すには「③ MAPに反映」を押してください。'
  );
}

/* ---------------------------------------------------------
   位置・写真
   --------------------------------------------------------- */

function newGeocoder() {
  return Maps.newGeocoder().setRegion('jp').setLanguage('ja');
}

function geocodeAddress(geocoder, address) {
  let query = String(address).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!query.includes('愛媛県')) query = '愛媛県' + query;

  let res;
  try {
    res = geocoder.geocode(query);
    Utilities.sleep(150);
  } catch (err) {
    console.error(err);
    return { ok: false, note: '位置の取得に失敗しました（時間をおいて再実行してください）' };
  }

  if (res.status !== 'OK' || !res.results || !res.results.length) {
    return { ok: false, note: '住所から位置を特定できませんでした（緯度・経度を手入力してください）' };
  }

  const top = res.results[0];
  const lat = top.geometry.location.lat;
  const lng = top.geometry.location.lng;

  // 愛媛県のおおよその範囲から外れたら、誤変換とみなして保存しない
  if (lat < 32.8 || lat > 34.4 || lng < 132.0 || lng > 133.8) {
    return { ok: false, note: '愛媛県外の位置になったため保存していません（緯度・経度を手入力してください）' };
  }

  const rough = top.partial_match || top.geometry.location_type === 'APPROXIMATE';
  return {
    ok: true,
    lat: lat,
    lng: lng,
    note: rough ? '位置がおおよそです。地図で確認してください' : ''
  };
}

/* すでに公開設定なら false、今回変更したら true */
function shareImage(fileId) {
  const file = DriveApp.getFileById(fileId);
  if (file.getSharingAccess() === DriveApp.Access.ANYONE_WITH_LINK) return false;
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return true;
}

/* フォームのアップロード欄のURL（複数ある場合は先頭）からファイルIDを取り出す */
function driveFileId(value) {
  const first = String(value || '').split(/[,\s]+/)[0];
  const m = first.match(/[?&]id=([-\w]+)/) || first.match(/\/d\/([-\w]+)/);
  return m ? m[1] : '';
}

function driveImageUrl(value) {
  const id = driveFileId(value);
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w800` : '';
}

/* ---------------------------------------------------------
   ユーティリティ
   --------------------------------------------------------- */

/* 値（数値・日付の判定用）と表示文字列（電話番号の先頭0などをそのまま保つ）の両方を読む */
function readSheet(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error(`シート「${name}」が見つかりません`);

  const range = sheet.getDataRange();
  const values = range.getValues();
  const display = range.getDisplayValues();

  return {
    sheet: sheet,
    header: values[0].map(String),
    values: values.slice(1),
    display: display.slice(1)
  };
}

/* 見出しから列番号（0始まり）を探す。完全一致を優先し、なければ先頭一致。見つからなければ -1。 */
function findColumns(header, spec) {
  const normalized = header.map(h => String(h).replace(/\s+/g, ''));
  const result = {};

  Object.keys(spec).forEach(key => {
    const target = spec[key].replace(/\s+/g, '');
    let idx = normalized.indexOf(target);
    if (idx < 0) idx = normalized.findIndex(h => h.startsWith(target));
    result[key] = idx;
  });

  return result;
}

function writeColumn(sheet, colIndex, rows) {
  sheet.getRange(2, colIndex + 1, rows.length, 1).setValues(rows);
}

/* 連絡先・営業時間は文字列として扱う（先頭の0が消えたり、「17:00」が時刻に変換されたりしないように） */
function applyFormats(sheet, startRow, mc, numRows) {
  sheet.getRange(startRow, mc.tel + 1, numRows, 1).setNumberFormat('@');
  sheet.getRange(startRow, mc.hours + 1, numRows, 1).setNumberFormat('@');
  sheet.getRange(startRow, mc.respondedAt + 1, numRows, 1).setNumberFormat('yyyy/mm/dd hh:mm');
}

function applyCheckbox(sheet, startRow, colIndex, numRows) {
  sheet.getRange(startRow, colIndex + 1, numRows, 1)
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

function cell(row, idx) {
  return idx >= 0 ? String(row[idx] == null ? '' : row[idx]).trim() : '';
}

function isChecked(value) {
  return value === true || /^(true|○|◯|✓|✔)$/i.test(String(value).trim());
}

/* 既存のメモに、まだ書かれていない内容だけを「 / 」区切りで足す */
function mergeMemo(current, notes) {
  const items = String(current || '').split(' / ').map(s => s.trim()).filter(Boolean);
  notes.forEach(n => { if (n && !items.includes(n)) items.push(n); });
  return items.join(' / ');
}

function toTime(value) {
  if (value instanceof Date) return value.getTime();
  const t = new Date(value).getTime();
  return isFinite(t) ? t : 0;
}

function formatTime(ms) {
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy/MM/dd HH:mm');
}

/* ---------------------------------------------------------
   営業時間を hh:mm-hh:mm（24時間表記）にそろえる
     「17時～0時」     → 17:00-00:00
     「21:00〜翌3:00」  → 21:00-03:00
     「18:00〜25:00」   → 18:00-01:00
     「9：30〜20：00」  → 09:30-20:00
   開始・終了の2つが読み取れなければ '' を返す（元の記入のまま残す）。
   --------------------------------------------------------- */

const HOURS_FORMAT = /^\d{2}:\d{2}-\d{2}:\d{2}$/;

function normalizeHours(text) {
  const s = String(text || '').normalize('NFKC');
  const re = /(\d{1,2})\s*(?::\s*(\d{1,2})|時\s*(?:(\d{1,2})\s*分|(半))?)/g;
  const times = [];
  let m;
  while ((m = re.exec(s)) !== null && times.length < 2) {
    const h = Number(m[1]);
    const min = m[2] !== undefined ? Number(m[2])
              : m[3] !== undefined ? Number(m[3])
              : m[4] ? 30 : 0;
    if (h > 47 || min > 59) return '';
    times.push(pad2(h % 24) + ':' + pad2(min));
  }
  return times.length === 2 ? times[0] + '-' + times[1] : '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}


function normalizeName(name) {
  return String(name).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/* 店名から決まるID。行を並べ替えてもIDが変わらないので、共有URL（#id）が切れない。 */
function shopId(name) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, normalizeName(name), Utilities.Charset.UTF_8);
  return 's' + bytes.slice(0, 4)
    .map(b => ((b + 256) % 256).toString(16).padStart(2, '0'))
    .join('');
}
