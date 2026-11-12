/* =========================================================
   松山YEG 飲食店MAP  ―  画面の組み立て
   ========================================================= */

const MAP_DEFAULT = {
  center: [33.8416, 132.7668],  // 松山市中心部（大街道・二番町あたり）
  zoom: 16,
  maxZoom: 19
};

// 引いた地図では目印の名前を隠して「★」だけにする（吹き出し同士が重ならないように）
const LANDMARK_LABEL_MIN_ZOOM = 15;

// スマホ表示（一覧が下から引き出すシートになる）かどうか
const MOBILE_QUERY = window.matchMedia('(max-width: 899px)');
const isMobile = () => MOBILE_QUERY.matches;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  shops: [],            // 全店舗
  visible: [],          // 絞り込み後の店舗
  markers: new Map(),   // id -> Leafletマーカー
  activeId: null,
  filter: { keyword: '', category: '', area: '' }
};

// スマホのシートの状態（peek: 少しだけ / half: 半分 / full: 全開）
const sheet = { state: 'half', height: 0 };

let map;
let markerLayer;
let landmarkLayer;
const landmarkMarkers = [];

/* ---------------------------------------------------------
   起動
   --------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  initMap();
  initSheet();
  initLightbox();
  renderLandmarks();   // 目印は店舗データの読み込みを待たずに表示する

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
  if (!isMobile()) map.scrollWheelZoom.enable();
  placeAttribution();

  landmarkLayer = L.layerGroup().addTo(map);
  markerLayer = L.layerGroup().addTo(map);

  map.on('zoomend viewreset', updateLandmarkSize);
  updateLandmarkSize();
}

/* 地図の出典表示は、スマホではシートに隠れないよう右上に置く */
function placeAttribution() {
  map.attributionControl.setPosition(isMobile() ? 'topright' : 'bottomright');
}

function updateLandmarkSize() {
  map.getContainer().classList.toggle('lm-compact', map.getZoom() < LANDMARK_LABEL_MIN_ZOOM);
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

    marker.bindPopup(popupHtml(shop, i + 1), { closeButton: true, maxWidth: 260 });
    marker.on('click', () => selectShop(shop.id, { from: 'map' }));

    marker.addTo(markerLayer);
    state.markers.set(shop.id, marker);
  });

  updatePopupPadding();
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

/* 表示中のお店がすべて入るように地図を合わせる。
   目印は含めない（「中心地」で絞り込んだときに、目印のせいで広がらないように）。 */
function fitToMarkers() {
  const points = state.visible.map(s => [s.lat, s.lng]);
  if (points.length === 0) return;

  // 地図コンテナの実サイズを再計測してから範囲を合わせる
  map.invalidateSize({ animate: false });

  // まだ高さ・幅が確定していないときに範囲を計算すると位置がずれるため、
  // ここでは何もしない。サイズが決まった時点で watchMapSize() が呼び直す。
  const size = map.getSize();
  if (size.x < 50 || size.y < 50) return;

  if (points.length === 1) {
    panToVisible(points[0], 17, { animate: false });
  } else {
    // スマホでは、シートに隠れている下側を除いた範囲に収める
    map.fitBounds(L.latLngBounds(points), {
      paddingTopLeft: [40, 40],
      paddingBottomRight: [40, 40 + coveredHeight()],
      maxZoom: 17
    });
  }
  updateLandmarkSize();   // 表示範囲を合わせた直後はズーム変更の通知が来ないことがあるため
}

/* 地図のうち、スマホのシートで隠れている高さ（PCでは0） */
function coveredHeight() {
  if (!isMobile()) return 0;
  return Math.min(sheet.height, map.getSize().y * 0.6);
}

/* 指定した地点が「シートに隠れていない部分」の、上から anchor の位置に来るように移動する。
   ポップアップを開くときは anchor を大きく（下寄りに）して、上に吹き出しの余白を作る。 */
function panToVisible(latlng, zoom, { anchor = 0.5, animate = true } = {}) {
  const mapH = map.getSize().y;
  const visibleH = mapH - coveredHeight();
  const offsetY = mapH / 2 - visibleH * anchor;
  const center = map.unproject(map.project(latlng, zoom).add([0, offsetY]), zoom);

  // OSで「視差効果を減らす／動きを減らす」設定の人には、アニメーションせずに移動する
  if (animate && !REDUCED_MOTION.matches) map.flyTo(center, zoom, { duration: .6 });
  else map.setView(center, zoom, { animate: false });
}

/* ポップアップが開いたとき、シートの下に隠れないように自動で地図をずらす範囲 */
function updatePopupPadding() {
  const options = {
    autoPanPaddingTopLeft: L.point(20, 20),
    autoPanPaddingBottomRight: L.point(20, 20 + coveredHeight())
  };
  [...state.markers.values(), ...landmarkMarkers].forEach(marker => {
    const popup = marker && marker.getPopup();
    if (popup) Object.assign(popup.options, options);
  });
}

/* ---------------------------------------------------------
   目印（js/landmarks.js の LANDMARKS）
   --------------------------------------------------------- */

function landmarks() {
  return typeof LANDMARKS !== 'undefined' && Array.isArray(LANDMARKS) ? LANDMARKS : [];
}

function renderLandmarks() {
  const list = landmarks();

  list.forEach((lm, i) => {
    const marker = L.marker([lm.lat, lm.lng], {
      icon: L.divIcon({
        className: 'landmark-pin',
        html: `<span class="lm"><b aria-hidden="true">★</b><span class="lm-text">${esc(lm.label || lm.name)}</span></span>`,
        iconSize: null,
        popupAnchor: [0, -38]
      }),
      title: lm.name,
      alt: lm.name,
      zIndexOffset: 500       // 通常のお店より手前、選択中のお店より奥
    });
    marker.bindPopup(landmarkPopupHtml(lm), { maxWidth: 260 });
    marker.addTo(landmarkLayer);
    landmarkMarkers[i] = marker;
  });

  if (!list.length) return;

  // 一覧の上に、目印へ移動するボタンを並べる
  const chips = document.getElementById('landmarkChips');
  chips.innerHTML = list.map((lm, i) =>
    `<button type="button" class="chip chip-landmark" data-landmark="${i}">★ ${esc(lm.label || lm.name)}</button>`
  ).join('');
  document.getElementById('landmarkRow').hidden = false;

  chips.addEventListener('click', e => {
    const chip = e.target.closest('[data-landmark]');
    if (chip) focusLandmark(Number(chip.dataset.landmark));
  });

  updatePopupPadding();
}

function landmarkPopupHtml(lm) {
  return `
    <p class="popup-cat popup-cat-landmark">★ ${esc(lm.label || '')}</p>
    <p class="popup-name">${esc(lm.name)}</p>
    ${lm.address ? `<p class="popup-meta">${esc(lm.address)}</p>` : ''}
    <div class="popup-actions">
      <a class="is-primary" href="${mapAppUrl(lm)}" target="_blank" rel="noopener">マップアプリで開く</a>
    </div>`;
}

function focusLandmark(i) {
  const lm = landmarks()[i];
  const marker = landmarkMarkers[i];
  if (!lm || !marker) return;

  if (sheet.state === 'full') setSheet('half');
  panToVisible([lm.lat, lm.lng], Math.max(map.getZoom(), 16), { anchor: 0.8 });
  setTimeout(() => marker.openPopup(), 650);
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
    ${shop.image ? `<div class="card-img-wrap">
      <img class="card-img js-zoom" src="${esc(shop.image)}" alt="${esc(shop.name)}"
           loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.remove()">
      <span class="zoom-hint" aria-hidden="true">拡大表示</span>
    </div>` : ''}
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
    ${shop.image ? `<img class="popup-img js-zoom" src="${esc(shop.image)}" alt="${esc(shop.name)}"
         referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
    <p class="popup-cat">${no}. ${esc(shop.category)}</p>
    <p class="popup-name">${esc(shop.name)}</p>
    ${meta ? `<p class="popup-meta">${esc(meta)}</p>` : ''}
    <div class="popup-actions">
      <button type="button" class="js-scroll" data-id="${esc(shop.id)}">詳しく見る</button>
      <a class="is-primary" href="${mapAppUrl(shop)}" target="_blank" rel="noopener">マップで開く</a>
    </div>`;
}

/* スマホではGoogleマップアプリ、PCではブラウザのGoogleマップが開く。
   住所がある場所は「名前＋住所」で検索して店舗・施設の情報ページに、
   住所が無い場所は緯度経度でその地点にピンを立てる。（お店と目印の両方で使う） */
function mapAppUrl(place) {
  const query = place.address
    ? `${place.name} ${place.address}`
    : `${place.lat},${place.lng}`;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/* ---------------------------------------------------------
   絞り込み
   --------------------------------------------------------- */

function buildFilterChips() {
  renderOptions('categoryChips', 'category', uniqueValues('category'), 'chip');

  // エリアはスイッチ型。値が1つも無ければ行ごと隠す
  const areas = uniqueValues('area');
  renderOptions('areaChips', 'area', areas, 'seg-btn');
  document.getElementById('areaRow').hidden = areas.length === 0;
}

function uniqueValues(key) {
  return [...new Set(state.shops.map(s => s[key]).filter(Boolean))];
}

function renderOptions(containerId, key, values, className) {
  document.getElementById(containerId).innerHTML = [
    `<button type="button" class="${className} is-on" aria-pressed="true" data-key="${key}" data-value="">すべて</button>`,
    ...values.map(v =>
      `<button type="button" class="${className}" aria-pressed="false" data-key="${key}" data-value="${esc(v)}">${esc(v)}</button>`)
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
    // 一覧から選択 → 地図を動かしてポップアップを開く（スマホは地図が見えるようにシートを半分に）
    if (sheet.state === 'full') setSheet('half');
    panToVisible([shop.lat, shop.lng], Math.max(map.getZoom(), 17), { anchor: 0.8 });
    const marker = state.markers.get(id);
    if (marker) setTimeout(() => marker.openPopup(), 650);
  } else {
    // 地図から選択 → 一覧の該当カードまでスクロール（スマホはシートを半分まで出す）
    if (sheet.state !== 'half') {
      setSheet('half');
      panToVisible([shop.lat, shop.lng], map.getZoom(), { anchor: 0.8 });
    }
    scrollToCard(id);
  }
}

function scrollToCard(id) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;

  if (isMobile()) {
    // シートの中だけをスクロールする
    const body = document.getElementById('sheetBody');
    const top = body.scrollTop + card.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
    body.scrollTo({ top, behavior: 'smooth' });
  } else {
    // ページをスクロール。上に固定されている絞り込み欄の高さぶん下げる
    const filtersH = document.querySelector('.filters').offsetHeight;
    const top = window.scrollY + card.getBoundingClientRect().top - filtersH - 12;
    window.scrollTo({ top, behavior: 'smooth' });
  }
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
   スマホのシート（Googleマップの候補一覧のように、下から引き出す）
   - 上部（つまみ・件数）をドラッグ：いつでも高さを変えられる
   - 一覧部分をスワイプ：全開でなければシートが動く。全開のときは中身がスクロールし、
     一番上で下に引くとシートが下がる
   --------------------------------------------------------- */

function sheetSnaps() {
  const H = document.querySelector('.layout').clientHeight;
  return {
    peek: Math.round(Math.min(150, H * 0.3)),
    half: Math.round(H * 0.5),
    full: Math.round(Math.max(H - 56, H * 0.6))
  };
}

function setSheet(name, { animate = true } = {}) {
  sheet.state = name;
  if (!isMobile()) return;
  setSheetHeight(sheetSnaps()[name], animate);
}

function setSheetHeight(px, animate) {
  const el = document.getElementById('sheet');
  el.classList.toggle('is-dragging', !animate);
  el.style.height = `${px}px`;
  el.dataset.state = sheet.state;
  sheet.height = px;
  if (map) updatePopupPadding();
}

/* 指を離したときに、どの段階（少しだけ／半分／全開）に吸着させるかを決める。
   - ゆっくり離したとき：一番近い段階
   - さっと払ったとき：払った向きに1段階だけ進む（大きく引っぱって次の段階を越えていれば、近い方） */
const SHEET_ORDER = ['peek', 'half', 'full'];

function snapSheet(height, velocity, fromState) {
  const snaps = sheetSnaps();
  const nearest = SHEET_ORDER.reduce((best, key) =>
    Math.abs(snaps[key] - height) < Math.abs(snaps[best] - height) ? key : best, 'half');

  if (Math.abs(velocity) < 0.4) {
    setSheet(nearest);
    return;
  }

  const step = velocity < 0 ? 1 : -1;   // 上向き（velocity < 0）なら高くなる方へ
  let target = Math.min(2, Math.max(0, SHEET_ORDER.indexOf(fromState) + step));
  const nearestIndex = SHEET_ORDER.indexOf(nearest);
  if ((step > 0 && nearestIndex > target) || (step < 0 && nearestIndex < target)) target = nearestIndex;
  setSheet(SHEET_ORDER[target]);
}

function initSheet() {
  const el = document.getElementById('sheet');
  const head = document.getElementById('sheetHead');
  const body = document.getElementById('sheetBody');

  const clampHeight = h => {
    const snaps = sheetSnaps();
    return Math.max(snaps.peek * 0.7, Math.min(snaps.full, h));
  };

  // ドラッグ中の位置と速さを記録する
  let drag = null;
  const startDrag = y => {
    drag = { startY: y, startH: el.offsetHeight, fromState: sheet.state, lastY: y, lastT: performance.now(), v: 0 };
  };
  const moveDrag = y => {
    const now = performance.now();
    drag.v = (y - drag.lastY) / Math.max(now - drag.lastT, 1);   // px/ms（下向きが正）
    drag.lastY = y;
    drag.lastT = now;
    setSheetHeight(clampHeight(drag.startH - (y - drag.startY)), false);
  };
  const endDrag = () => {
    const moved = Math.abs(drag.lastY - drag.startY);
    if (moved < 6) {
      // つまみをタップしたときは段階を1つ進める
      setSheet({ peek: 'half', half: 'full', full: 'half' }[sheet.state]);
    } else {
      snapSheet(el.offsetHeight, drag.v, drag.fromState);
    }
    drag = null;
  };

  // 上部（つまみ・件数）：マウスでも指でもドラッグできる
  head.addEventListener('pointerdown', e => {
    if (!isMobile()) return;
    head.setPointerCapture(e.pointerId);
    startDrag(e.clientY);
  });
  head.addEventListener('pointermove', e => { if (drag) moveDrag(e.clientY); });
  head.addEventListener('pointerup', () => { if (drag) endDrag(); });
  head.addEventListener('pointercancel', () => { if (drag) endDrag(); });

  // 一覧部分：指のスワイプで、シートを動かすか中身をスクロールするかを判断する
  let touch = null;
  body.addEventListener('touchstart', e => {
    if (!isMobile() || e.touches.length !== 1) return;
    touch = { y: e.touches[0].clientY, mode: null };
  }, { passive: true });

  body.addEventListener('touchmove', e => {
    if (!touch) return;
    const y = e.touches[0].clientY;
    const dy = y - touch.y;

    if (!touch.mode) {
      if (Math.abs(dy) < 6) return;
      const atTop = body.scrollTop <= 0;
      touch.mode = (sheet.state !== 'full' || (dy > 0 && atTop)) ? 'sheet' : 'scroll';
      if (touch.mode === 'sheet') startDrag(touch.y);
    }
    if (touch.mode === 'sheet') {
      e.preventDefault();   // 中身のスクロールを止めてシートを動かす
      moveDrag(y);
    }
  }, { passive: false });

  const endTouch = () => {
    if (touch && touch.mode === 'sheet' && drag) endDrag();
    touch = null;
  };
  body.addEventListener('touchend', endTouch);
  body.addEventListener('touchcancel', endTouch);

  // 検索欄に入力するときは全開にする（キーボードで隠れないように）
  document.getElementById('keyword').addEventListener('focus', () => {
    if (isMobile()) setSheet('full');
  });

  // PC表示とスマホ表示が切り替わったとき
  MOBILE_QUERY.addEventListener('change', () => {
    if (isMobile()) {
      setSheet(sheet.state, { animate: false });
      map.scrollWheelZoom.disable();
    } else {
      el.style.height = '';
      sheet.height = 0;
      map.scrollWheelZoom.enable();
    }
    placeAttribution();
    updatePopupPadding();
  });

  setSheet('half', { animate: false });
}

/* ---------------------------------------------------------
   画像の拡大表示
   --------------------------------------------------------- */

function initLightbox() {
  const box = document.getElementById('lightbox');
  const close = () => {
    box.hidden = true;
    document.getElementById('lightboxImg').removeAttribute('src');
    document.body.classList.remove('is-lightbox-open');
  };

  box.addEventListener('click', e => {
    if (!e.target.closest('img')) close();   // 画像の外か「×」を押したら閉じる
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !box.hidden) close();
  });

  // 一覧とポップアップの画像を押したら拡大する
  document.addEventListener('click', e => {
    const img = e.target.closest('.js-zoom');
    if (!img) return;
    e.stopPropagation();
    openLightbox(img.currentSrc || img.src, img.alt);
  }, true);
}

function openLightbox(src, caption) {
  const img = document.getElementById('lightboxImg');
  const large = src.replace(/([?&]sz=)w\d+/, '$1w1600');   // Googleドライブの画像は大きいサイズで開く

  // 大きいサイズが読めなかったときは、一覧と同じサイズで表示し直す
  img.onerror = () => {
    img.onerror = null;
    if (img.src !== src) img.src = src;
  };
  img.referrerPolicy = 'no-referrer';
  img.src = large;
  img.alt = caption;
  document.getElementById('lightboxCaption').textContent = caption;
  document.getElementById('lightbox').hidden = false;
  document.body.classList.add('is-lightbox-open');
  document.getElementById('lightboxClose').focus();
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

  // ジャンル（チップ）・エリア（スイッチ）
  document.querySelectorAll('[data-filter-group]').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('[data-key]');
      if (!btn) return;

      state.filter[btn.dataset.key] = btn.dataset.value;
      group.querySelectorAll('[data-key]').forEach(b => {
        const on = b === btn;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-pressed', String(on));
      });
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
    if (sheet.state === 'peek') setSheet('half');
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
    if (isMobile()) setSheet(sheet.state, { animate: false });
    map.invalidateSize({ animate: false });
    if (!state.activeId) fitToMarkers();
  }, 150);

  if (window.ResizeObserver) {
    new ResizeObserver(refresh).observe(el);
  } else {
    window.addEventListener('resize', refresh);
  }
}

/* URLの #s1234abcd のような指定で、そのお店を開いた状態にする */
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
