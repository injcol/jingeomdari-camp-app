// 네이버 지도(NCP Web Dynamic Map) 로더/렌더 — 등록 referer: http://localhost:5173 (배포 도메인은 NCP 콘솔 추가)
// 실패(키/referer 불일치·오프라인) 시 placeholder 유지(graceful degrade).
import { NCP_CLIENT_ID } from './map_config.js';
import { esc } from './util.js';

let loadPromise = null;
export let mapAuthOk = true;
// NCP 인증 실패 콜백(네이버 SDK가 전역 호출)
window.navermap_authFailure = function () { mapAuthOk = false; console.warn('[map] NCP auth failure (referer/clientId 확인)'); };

export function loadNaverMaps() {
  if (window.naver && window.naver.maps) return Promise.resolve(window.naver.maps);
  if (loadPromise) return loadPromise;
  loadPromise = new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NCP_CLIENT_ID}`;
    sc.async = true;
    sc.onload = () => (window.naver && window.naver.maps) ? resolve(window.naver.maps) : reject(new Error('maps_not_ready'));
    sc.onerror = () => reject(new Error('script_load_error'));
    document.head.appendChild(sc);
  });
  return loadPromise;
}

// container에 지도+마커 렌더. 성공 시 fallback 요소 숨김. 실패 시 reject(placeholder 유지)
export function renderMap(container, fallbackEl, lat, lng, name) {
  if (lat == null || lng == null) return Promise.reject(new Error('no_coords'));
  return loadNaverMaps().then((maps) => {
    // P1: 컨테이너 높이 보장(0높이면 SDK가 0크기로 그림). CSS 명시높이 + 안전망.
    if (!container.offsetHeight) {
      const h = (container.parentElement && container.parentElement.offsetHeight) || 172;
      container.style.height = h + 'px';
    }
    const pos = new maps.LatLng(lat, lng);
    const map = new maps.Map(container, { center: pos, zoom: 16, scaleControl: false, mapDataControl: false, logoControlOptions: { position: maps.Position.BOTTOM_LEFT } });
    new maps.Marker({ position: pos, map, title: name || '' });
    // 레이아웃 확정 후 resize 트리거 — 0→실측 크기로 타일 재배치(보이지 않던 결함 방지)
    requestAnimationFrame(() => { try { maps.Event.trigger(map, 'resize'); } catch {} });
    if (fallbackEl) fallbackEl.style.display = 'none';
    return map;
  });
}

// 전체지도: 단일 인스턴스에 허브🚩 + 전체 장소 마커. 조 코스=조 색 강조, 완료=✓.
// items: [{ id, name, lat, lng, theme, inCourse, done }], hub: { name, lat, lng }, color: 조 색
export function renderAllMap(container, fallbackEl, items, hub, color, arrival) {
  return loadNaverMaps().then((maps) => {
    if (!container.offsetHeight) {                       // P1 패턴: 0높이 안전망
      const h = (container.parentElement && container.parentElement.offsetHeight) || 360;
      container.style.height = h + 'px';
    }
    const bounds = new maps.LatLngBounds();
    const center = new maps.LatLng(hub.lat, hub.lng);
    const map = new maps.Map(container, { center, zoom: 13, scaleControl: false, mapDataControl: false, logoControlOptions: { position: maps.Position.BOTTOM_LEFT } });
    const iw = new maps.InfoWindow({ borderWidth: 0, disableAnchor: false, backgroundColor: 'transparent', pixelOffset: new maps.Point(0, -6) });

    const pin = (cls, label, c) => ({ content: `<div class="mpin ${cls}" style="--c:${c}">${label}</div>`, anchor: new maps.Point(14, 14) });
    // 출발 허브
    new maps.Marker({ position: center, map, icon: pin('hub', '🚩', '#175055'), title: `출발 · ${hub.name}`, zIndex: 100 });
    bounds.extend(center);
    // 도착(복귀) 허브
    if (arrival && arrival.lat != null) {
      const acenter = new maps.LatLng(arrival.lat, arrival.lng);
      new maps.Marker({ position: acenter, map, icon: pin('hub arrival', '🏁', '#b15a37'), title: `도착 · ${arrival.name}`, zIndex: 100 });
      bounds.extend(acenter);
    }
    // 장소
    items.forEach((it) => {
      if (it.lat == null || it.lng == null) return;
      const pos = new maps.LatLng(it.lat, it.lng);
      bounds.extend(pos);
      const cls = it.done ? 'done' : it.inCourse ? 'course' : 'plain';
      const c = it.inCourse ? (color || '#1f6f74') : '#736a5d';
      const mk = new maps.Marker({ position: pos, map, icon: pin(cls, it.done ? '✓' : '', c), title: it.name, zIndex: it.inCourse ? 50 : 10 });
      maps.Event.addListener(mk, 'click', () => {
        iw.setContent(`<div class="iw"><div class="iw-h">${esc(it.name)}</div>${it.theme ? `<div class="iw-t">${esc(it.theme)}</div>` : ''}<a class="iw-go" href="#/place/${it.id}">장소 상세 ›</a></div>`);
        iw.open(map, mk);
      });
    });
    try { map.fitBounds(bounds); } catch {}
    requestAnimationFrame(() => { try { maps.Event.trigger(map, 'resize'); map.fitBounds(bounds); } catch {} });
    if (fallbackEl) fallbackEl.style.display = 'none';
    return map;
  });
}
