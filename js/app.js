/* =========================================================
   松山YEG 夜の飲食店MAP  ―  画面の組み立て
   ========================================================= */

const MAP_DEFAULT = {
  center: [33.8416, 132.7668],  // 松山市中心部（大街道・二番町あたり）
  zoom: 16,
  maxZoom: 19
};

const state = {
  shops: [],            // 全店舗
  visible: [],          // 絞り込み後の店舗
  markers: new Map(),   // id -> Leafletマーカー
  activeId: null,
  filter: { keyword: '', category: '', area: '' }
};

let map;
let markerLayer;

/* ---------------------------------------------------------
   起動
   --------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  initMap();

  try {
    state.shops = await loadShops();
  } catch (err) {
    showLoadError(err);
    return;
  }

  buildFilterChips();
  applyFilter();
  bindEvents();
  openFromHash();
}

/* ---------------------------------------------------------
   地図
   --------------------------------------------------------- */

function initMap() {
  map = L.map('map', {
    center: MAP_DEFAULT.center,
    zoom: MAP_DEFAULT.zoom,
    scrollWheelZoom: false,   // ページスクロールを邪魔しない
    tap: true
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: MAP_DEFAULT.maxZoom,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  // PCではホイールズーム可、スマホはピンチのみ
  if (window.matchMedia('(min-width: 900px)').matches) {
    map.scrollWheelZoom.enable();
  }

  markerLayer = L.layerGroup().addTo(map);
}

function renderMarkers() {
  markerLayer.clearLayers();
  state.markers.clear();

  state.visible.forEach((shop, i) => {
    const marker = L.marker([shop.lat, shop.lng], {
      icon: createPinIcon(i + 1, shop.id === state.activeId),
      title: shop.name,
      alt: shop.name
    });

    marker.bindPopup(popupHtml(shop, i + 1), { closeButton: true, autoPanPadding: [30, 30] });
    marker.on('click', () => selectShop(shop.id, { from: 'map' }));

    marker.addTo(markerLayer);
    state.markers.set(shop.id, marker);
  });

  fitToMarkers();
}

function createPinIcon(no, isActive) {
  return L.divIcon({
    className: `shop-pin${isActive ? ' is-active' : ''}`,
    html: `<span><i>${no}</i></span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -28]
  });
}

function fitToMarkers() {
  if (state.visible.length === 0) return;

  // 地図コンテナの実サイズを再計測してから範囲を合わせる
  // （sticky配置のため、初期化直後はサイズが確定していないことがある）
  map.invalidateSize({ animate: false });

  // まだ高さ・幅が確定していないときに範囲を計算すると位置がずれるため、
  // ここでは何もしない。サイズが決まった時点で watchMapSize() が呼び直す。
  const size = map.getSize();
  if (size.x < 50 || size.y < 50) return;

  if (state.visible.length === 1) {
    const s = state.visible[0];
    map.setView([s.lat, s.lng], 17);
    return;
  }

  const bounds = L.latLngBounds(state.visible.map(s => [s.lat, s.lng]));
  map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
}

/* ---------------------------------------------------------
   一覧
   --------------------------------------------------------- */

function renderList() {
  const list = document.getElementById('shopList');
  const empty = document.getElementById('emptyState');

  list.innerHTML = state.visible.map((shop, i) => cardHtml(shop, i + 1)).join('');
  empty.hidden = state.visible.length > 0;

  document.getElementById('resultCount').textContent =
    `${state.visible.length}件のお店${isFiltered() ? `（全${state.shops.length}件中）` : ''}`;
}

function cardHtml(shop, no) {
  const info = [
    ['住所', esc(shop.address)],
    ['営業', esc(shop.hours)],
    ['定休', esc(shop.closed)],
    ['予算', esc(shop.budget)],
    ['収容人数', esc(shop.seats)],
    ['TEL', shop.tel ? `<a href="tel:${esc(shop.tel.replace(/[^\d+]/g, ''))}">${esc(shop.tel)}</a>` : ''],
    ['サイト', link(shop.website, '公式サイト')],
    ['SNS', link(shop.instagram, 'Instagram')],
    ['代表者', esc(shop.member)]
  ].filter(([, v]) => v);

  return `
  <li class="shop-card${shop.id === state.activeId ? ' is-active' : ''}" id="card-${esc(shop.id)}" data-id="${esc(shop.id)}">
    ${shop.image ? `<img class="card-img" src="${esc(shop.image)}" alt="${esc(shop.name)}"
         loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <div class="card-head">
      <div class="card-no">${no}</div>
      <div class="card-title">
        <p class="card-cat">${esc(shop.category)}</p>
        <h2 class="card-name">${esc(shop.name)}</h2>
        <p class="card-area">${esc(shop.area)}</p>
      </div>
    </div>

    ${shop.description ? `<p class="card-desc">${esc(shop.description)}</p>` : ''}

    ${info.length ? `<dl class="card-info">
      ${info.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
    </dl>` : ''}

    ${shop.tags.length ? `<div class="card-tags">
      ${shop.tags.map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
    </div>` : ''}

    <div class="card-actions">
      <button type="button" class="btn js-focus" data-id="${esc(shop.id)}">地図で見る</button>
      <a class="btn btn-primary" href="${mapAppUrl(shop)}" target="_blank" rel="noopener">マップアプリで開く</a>
    </div>
  </li>`;
}

function popupHtml(shop, no) {
  const meta = [shop.area, shop.hours].filter(Boolean).join(' / ');

  return `
    <p class="popup-cat">${no}. ${esc(shop.category)}</p>
    <p class="popup-name">${esc(shop.name)}</p>
    ${meta ? `<p class="popup-meta">${esc(meta)}</p>` : ''}
    <div class="popup-actions">
      <button type="button" class="js-scroll" data-id="${esc(shop.id)}">詳しく見る</button>
      <a class="is-primary" href="${mapAppUrl(shop)}" target="_blank" rel="noopener">マップで開く</a>
    </div>`;
}

/* スマホではGoogleマップアプリ、PCではブラウザのGoogleマップが開く。
   住所がある店は「店名＋住所」で検索して店舗情報ページに、
   住所が無い店は緯度経度でその地点にピンを立てる。 */
function mapAppUrl(shop) {
  const query = shop.address
    ? `${shop.name} ${shop.address}`
    : `${shop.lat},${shop.lng}`;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/* ---------------------------------------------------------
   絞り込み
   --------------------------------------------------------- */

function buildFilterChips() {
  renderChips('categoryChips', 'category', uniqueValues('category'), 'すべてのジャンル');
  renderChips('areaChips', 'area', uniqueValues('area'), 'すべてのエリア');
}

function uniqueValues(key) {
  return [...new Set(state.shops.map(s => s[key]).filter(Boolean))];
}

function renderChips(containerId, key, values, allLabel) {
  const el = document.getElementById(containerId);
  el.innerHTML = [
    `<button type="button" class="chip is-on" data-key="${key}" data-value="">${allLabel}</button>`,
    ...values.map(v => `<button type="button" class="chip" data-key="${key}" data-value="${esc(v)}">${esc(v)}</button>`)
  ].join('');
}

function applyFilter() {
  const kw = state.filter.keyword.toLowerCase();

  state.visible = state.shops.filter(shop => {
    if (state.filter.category && shop.category !== state.filter.category) return false;
    if (state.filter.area && shop.area !== state.filter.area) return false;
    if (!kw) return true;

    const haystack = [
      shop.name, shop.category, shop.area, shop.description,
      shop.address, shop.member, shop.tags.join(' ')
    ].join(' ').toLowerCase();

    return haystack.includes(kw);
  });

  if (state.activeId && !state.visible.some(s => s.id === state.activeId)) {
    state.activeId = null;
  }

  renderList();
  renderMarkers();
}

function isFiltered() {
  return Boolean(state.filter.keyword || state.filter.category || state.filter.area);
}

/* ---------------------------------------------------------
   お店の選択（地図 ⇄ 一覧の連動）
   --------------------------------------------------------- */

function selectShop(id, { from }) {
  const shop = state.visible.find(s => s.id === id);
  if (!shop) return;

  state.activeId = id;
  updateActiveStyles();

  if (from === 'list') {
    // 一覧から選択 → 地図を動かしてポップアップを開く
    map.flyTo([shop.lat, shop.lng], Math.max(map.getZoom(), 17), { duration: .6 });
    const marker = state.markers.get(id);
    if (marker) setTimeout(() => marker.openPopup(), 620);
  } else {
    // 地図から選択 → 一覧の該当カードまでスクロール
    scrollToCard(id);
  }
}

function scrollToCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateActiveStyles() {
  document.querySelectorAll('.shop-card').forEach(card => {
    card.classList.toggle('is-active', card.dataset.id === state.activeId);
  });

  state.visible.forEach((shop, i) => {
    const marker = state.markers.get(shop.id);
    if (!marker) return;

    const isActive = shop.id === state.activeId;
    marker.setIcon(createPinIcon(i + 1, isActive));
    marker.setZIndexOffset(isActive ? 1000 : 0);   // 選択中のピンを手前に
  });
}

/* ---------------------------------------------------------
   イベント
   --------------------------------------------------------- */

function bindEvents() {
  // キーワード検索
  const keyword = document.getElementById('keyword');
  keyword.addEventListener('input', debounce(() => {
    state.filter.keyword = keyword.value.trim();
    applyFilter();
  }, 250));

  // ジャンル・エリアのチップ
  document.querySelectorAll('.chip-row').forEach(row => {
    row.addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;

      state.filter[chip.dataset.key] = chip.dataset.value;
      row.querySelectorAll('.chip').forEach(c => c.classList.toggle('is-on', c === chip));
      applyFilter();
    });
  });

  // 一覧のカード（「地図で見る」ボタン、またはカード本体のタップ）
  document.getElementById('shopList').addEventListener('click', e => {
    if (e.target.closest('a')) return;   // リンクはそのまま

    const card = e.target.closest('.shop-card');
    if (card) selectShop(card.dataset.id, { from: 'list' });
  });

  // ポップアップ内の「詳しく見る」
  document.getElementById('map').addEventListener('click', e => {
    const btn = e.target.closest('.js-scroll');
    if (!btn) return;
    map.closePopup();
    scrollToCard(btn.dataset.id);
  });

  watchMapSize();

  // 全体表示に戻す
  document.getElementById('resetView').addEventListener('click', () => {
    state.activeId = null;
    map.closePopup();
    updateActiveStyles();
    fitToMarkers();
  });
}

/* 地図コンテナの大きさが変わったら（横向きへの回転、ウィンドウ幅の変更、
   表示直後にサイズが確定したときなど）、地図を測り直して表示範囲を合わせる */
function watchMapSize() {
  const el = document.getElementById('map');

  const refresh = debounce(() => {
    map.invalidateSize({ animate: false });
    if (!state.activeId) fitToMarkers();
  }, 150);

  if (window.ResizeObserver) {
    new ResizeObserver(refresh).observe(el);
  } else {
    window.addEventListener('resize', refresh);
  }
}

/* URLの #y003 のような指定で、そのお店を開いた状態にする */
function openFromHash() {
  const id = decodeURIComponent(location.hash.replace('#', ''));
  if (id && state.shops.some(s => s.id === id)) {
    selectShop(id, { from: 'list' });
    scrollToCard(id);
  }
}

/* ---------------------------------------------------------
   ユーティリティ
   --------------------------------------------------------- */

function showLoadError(err) {
  console.error(err);
  document.getElementById('shopList').innerHTML = `
    <li class="load-error">
      <p><strong>店舗データを読み込めませんでした。</strong></p>
      <p>${esc(err.message)}</p>
      ${location.protocol === 'file:' ? `
      <p>ファイルを直接ダブルクリックして開いた場合、ブラウザの制限でデータを読み込めません。
         <code>README.md</code> の手順でローカルサーバーから開いてください。</p>` : ''}
    </li>`;
}

/* http/https のURLだけをリンクにする（不正なURLの混入を防ぐ） */
function link(url, label) {
  if (!/^https?:\/\//i.test(url)) return '';
  return `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
