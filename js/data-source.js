/* =========================================================
   データ取得層
   ---------------------------------------------------------
   お店のデータをどこから読むかは、このファイルだけで完結します。
   本番はGAS（スプレッドシートを読むWebアプリ）から読み込みます。
   （GASの準備手順は README.md を参照）
   ========================================================= */

const SOURCE = {
  // GASを「ウェブアプリ」としてデプロイしたときのURL（…/exec で終わるもの）
  gasUrl: 'https://script.google.com/macros/s/AKfycbwoQROqwEtzhwbhBHzz8V-4zM5dCQw41lv0h7oWL7cyQq_bbwXa6YguFeLW9jAxusM45A/exec'
};

/* ---------------------------------------------------------
   公開関数：お店データの配列を返す
   --------------------------------------------------------- */

async function loadShops() {
  const rows = await fetchFromGas();

  return rows
    .map(normalizeShop)
    .filter(shop => shop !== null);
}

/* ---------------------------------------------------------
   取得：GAS
   --------------------------------------------------------- */

async function fetchFromGas() {
  if (!SOURCE.gasUrl) {
    throw new Error('GASのURLが未設定です（js/data-source.js の SOURCE.gasUrl）');
  }

  const res = await fetch(SOURCE.gasUrl);
  if (!res.ok) {
    throw new Error(`店舗データを読み込めませんでした（${res.status}）`);
  }

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return Array.isArray(data.shops) ? data.shops : [];
}

/* ---------------------------------------------------------
   正規化
   画面で扱う形にそろえる（GASが返さない項目は空文字になり、画面には出ない）。
   緯度経度が無い行は地図に置けないため除外する。
   --------------------------------------------------------- */

function normalizeShop(raw, index) {
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);

  if (raw.lat === '' || raw.lng === '' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.warn('緯度経度が不正のため除外しました:', raw.name || `(${index + 1}件目)`);
    return null;
  }

  return {
    id:          String(raw.id || `shop-${index + 1}`),
    name:        str(raw.name) || '（店名未設定）',
    category:    str(raw.category),
    area:        str(raw.area),
    member:      str(raw.member),
    description: str(raw.description),
    address:     str(raw.address),
    tel:         str(raw.tel),
    hours:       str(raw.hours),
    closed:      str(raw.closed),
    budget:      str(raw.budget),
    seats:       str(raw.seats),
    website:     str(raw.website),
    instagram:   str(raw.instagram),
    image:       /^https:\/\//i.test(str(raw.image)) ? str(raw.image) : '',
    tags:        splitTags(raw.tags),
    lat,
    lng
  };
}

function str(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

function splitTags(v) {
  if (Array.isArray(v)) return v.map(t => String(t).trim()).filter(Boolean);
  return str(v).split(/[,、]/).map(t => t.trim()).filter(Boolean);
}
