/* =========================================================
   現在地の表示
   ・地図左上（拡大・縮小ボタンの下）の「現在地」ボタンで開始する
   ・位置情報はブラウザの中だけで使い、どこにも送らない
   ・一度「許可しない」を選んだ人には、許可し直す手順を案内する
   ========================================================= */

// 現在地がここから離れすぎているときは、地図を動かさない（遠方から下見している人向け）
const LOCATE_MAX_DISTANCE_KM = 20;

const locate = {
  watchId: null,
  latlng: null,
  accuracy: 0,
  waitingFirstFix: false,   // ボタンを押して、最初の位置を待っているところ
  startedAt: 0,
  dot: null,
  circle: null,
  button: null
};

function initLocate() {
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const wrap = L.DomUtil.create('div', 'leaflet-bar locate-control');
      const btn = L.DomUtil.create('button', 'locate-btn', wrap);
      btn.type = 'button';
      btn.title = '現在地を表示';
      btn.setAttribute('aria-label', '現在地を表示');
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor"/>
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2"/>
          <path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>`;
      L.DomEvent.disableClickPropagation(wrap);
      L.DomEvent.on(btn, 'click', onLocateClick);
      locate.button = btn;
      return wrap;
    }
  });
  map.addControl(new LocateControl());
  initLocateHelp();
}

async function onLocateClick() {
  if (!('geolocation' in navigator)) {
    showMapToast('このブラウザでは現在地を使えません。');
    return;
  }

  // すでに表示中なら、現在地へ戻るだけ
  if (locate.watchId !== null && locate.latlng) {
    centerOnLocation();
    return;
  }

  // 前に「許可しない」を選んでいる → 確認は二度と出ないので、許可し直す手順を案内する
  const before = await permissionState();
  if (before === 'denied') {
    openLocateHelp();
    return;
  }

  startWatching(before);
}

function startWatching(stateBefore) {
  stopWatching();
  locate.waitingFirstFix = true;
  locate.startedAt = Date.now();
  setLocateButton('loading');

  locate.watchId = navigator.geolocation.watchPosition(
    pos => onPosition(pos),
    err => onPositionError(err, stateBefore),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
  );
}

function stopWatching() {
  if (locate.watchId !== null) navigator.geolocation.clearWatch(locate.watchId);
  locate.watchId = null;
}

function onPosition(pos) {
  locate.latlng = L.latLng(pos.coords.latitude, pos.coords.longitude);
  locate.accuracy = pos.coords.accuracy || 0;
  drawLocation();
  setLocateButton('active');

  // 地図を動かすのは、ボタンを押した直後の1回だけ（歩いている間は青い点だけが動く）
  if (locate.waitingFirstFix) {
    locate.waitingFirstFix = false;
    centerOnLocation();
  }
}

function onPositionError(err, stateBefore) {
  // 表示中に一時的に取れなくなっただけなら、青い点はそのまま残す
  if (!locate.waitingFirstFix && err.code !== err.PERMISSION_DENIED) return;

  stopWatching();
  locate.waitingFirstFix = false;
  setLocateButton(locate.latlng ? 'active' : '');

  if (err.code === err.PERMISSION_DENIED) {
    clearLocation();
    setLocateButton('');
    // 確認画面を見て人が選ぶには時間がかかる。すぐに断られたときは、確認画面が出ていない
    // （端末の位置情報サービスがオフ、ブラウザ側で拒否済みなど）ので手順を案内する
    const answeredByPerson = Date.now() - locate.startedAt > 800;
    if (stateBefore !== 'denied' && answeredByPerson) {
      // いま確認画面で「許可しない」を選んだところ → 手順の案内までは出さない
      showMapToast('位置情報が許可されなかったため、現在地を表示できません。');
    } else {
      openLocateHelp();
    }
  } else if (err.code === err.TIMEOUT) {
    showMapToast('現在地を取得できませんでした。電波の良い場所で、もう一度お試しください。');
  } else {
    showMapToast('現在地を取得できませんでした。端末の位置情報サービスがオンになっているか確認してください。');
  }
}

function drawLocation() {
  if (!locate.dot) {
    locate.circle = L.circle(locate.latlng, {
      radius: locate.accuracy,
      className: 'locate-accuracy',
      interactive: false
    }).addTo(map);
    locate.dot = L.circleMarker(locate.latlng, {
      radius: 8,
      className: 'locate-dot',
      interactive: false
    }).addTo(map);
  } else {
    locate.circle.setLatLng(locate.latlng).setRadius(locate.accuracy);
    locate.dot.setLatLng(locate.latlng);
  }
}

function clearLocation() {
  if (locate.dot) {
    locate.dot.remove();
    locate.circle.remove();
  }
  locate.dot = locate.circle = locate.latlng = null;
}

function centerOnLocation() {
  const km = map.distance(locate.latlng, MAP_DEFAULT.center) / 1000;
  if (km > LOCATE_MAX_DISTANCE_KM) {
    showMapToast(`現在地は松山の中心部から約${Math.round(km)}km離れているため、地図は動かしません。`);
    return;
  }

  // 誤差が小さいときは街の様子が分かる拡大率、大きいとき（PCなど）は誤差の円が収まる拡大率
  let zoom = Math.max(map.getZoom(), 16);
  if (locate.accuracy > 150) {
    zoom = Math.min(16, map.getBoundsZoom(locate.circle.getBounds().pad(0.2)));
  }
  map.closePopup();
  panToVisible(locate.latlng, zoom);
}

function setLocateButton(mode) {
  const btn = locate.button;
  btn.classList.toggle('is-loading', mode === 'loading');
  btn.classList.toggle('is-active', mode === 'active');
  btn.title = mode === 'active' ? '現在地へ移動' : '現在地を表示';
  btn.setAttribute('aria-label', btn.title);
}

/* 位置情報の許可の状態（granted / denied / prompt）。調べられないブラウザでは '' */
async function permissionState() {
  try {
    if (!navigator.permissions) return '';
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch (e) {
    return '';
  }
}

/* ---------------------------------------------------------
   地図の上の短いお知らせ
   --------------------------------------------------------- */

let toastTimer;

function showMapToast(message) {
  let toast = document.getElementById('mapToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'mapToast';
    toast.className = 'map-toast';
    toast.setAttribute('role', 'status');
    document.querySelector('.map-pane').appendChild(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 5000);
}

/* ---------------------------------------------------------
   許可し直す手順の案内
   --------------------------------------------------------- */

function detectDevice() {
  const ua = navigator.userAgent;
  const inApp = /\bLine\//i.test(ua) ? 'LINE'
    : /Instagram/i.test(ua) ? 'Instagram'
    : /FBAN|FBAV/i.test(ua) ? 'Facebook'
    : '';
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  return { inApp, os: ios ? 'ios' : android ? 'android' : 'pc' };
}

function locateHelpHtml() {
  const { inApp, os } = detectDevice();

  // LINEなどのアプリ内で開いている場合は、まずブラウザで開き直してもらう
  if (inApp) {
    const how = os === 'ios'
      ? '画面右下（または右上）のメニューから「Safariで開く」'
      : '画面右上の「︙」から「他のアプリで開く」→「Chrome」';
    return `
      <p>${inApp}の中で開いているため、現在地を使えないことがあります。</p>
      <ol>
        <li>${how}を選びます</li>
        <li>開いたページで、もう一度「現在地」ボタンを押してください</li>
      </ol>`;
  }

  if (os === 'ios') {
    return `
      <p>前に「許可しない」を選んだため、確認が表示されなくなっています。次の手順で許可し直してください。</p>
      <h3>このサイトだけ許可し直す</h3>
      <ol>
        <li>アドレスバーの左端のボタン（「ぁあ」またはページのアイコン）を押します</li>
        <li>「Webサイトの設定」を開きます</li>
        <li>「位置情報」を「確認」または「許可」にします</li>
        <li>ページを再読み込みして、もう一度「現在地」ボタンを押します</li>
      </ol>
      <h3>それでも表示されないとき</h3>
      <ol>
        <li>「設定」アプリ →「プライバシーとセキュリティ」→「位置情報サービス」をオンにします</li>
        <li>同じ画面の一覧で「Safari Webサイト」を「このAppの使用中」にします</li>
      </ol>`;
  }

  if (os === 'android') {
    return `
      <p>前に「許可しない」を選んだため、確認が表示されなくなっています。次の手順で許可し直してください。</p>
      <h3>このサイトだけ許可し直す（Chrome）</h3>
      <ol>
        <li>アドレスバーの左端のアイコンを押します</li>
        <li>「権限」または「位置情報」を開きます</li>
        <li>「許可」にします（「リセット」が出た場合は押します）</li>
        <li>ページを再読み込みして、もう一度「現在地」ボタンを押します</li>
      </ol>
      <h3>それでも表示されないとき</h3>
      <ol>
        <li>画面の上から下にスワイプし、「位置情報」をオンにします</li>
      </ol>`;
  }

  return `
    <p>前に「許可しない」を選んだため、確認が表示されなくなっています。次の手順で許可し直してください。</p>
    <ol>
      <li>アドレスバーの左端のアイコン（鍵や調整のマーク）を押します</li>
      <li>「位置情報」を「許可」にします（「サイトの設定」から変える場合もあります）</li>
      <li>ページを再読み込みして、もう一度「現在地」ボタンを押します</li>
    </ol>
    <p class="locate-help-note">パソコンは位置の精度が粗く、数百mずれることがあります。</p>`;
}

function initLocateHelp() {
  const box = document.getElementById('locateHelp');
  box.addEventListener('click', e => {
    if (e.target === box || e.target.closest('.js-locate-help-close')) closeLocateHelp();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !box.hidden) closeLocateHelp();
  });
}

function openLocateHelp() {
  document.getElementById('locateHelpBody').innerHTML = locateHelpHtml();
  document.getElementById('locateHelp').hidden = false;
  document.body.classList.add('is-lightbox-open');
  document.getElementById('locateHelpClose').focus();
}

function closeLocateHelp() {
  document.getElementById('locateHelp').hidden = true;
  document.body.classList.remove('is-lightbox-open');
  if (locate.button) locate.button.focus();
}
