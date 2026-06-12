// 네이버 지도(NCP Web Dynamic Map) 로더/렌더 — 등록 referer: http://localhost:5173 (배포 도메인은 NCP 콘솔 추가)
// 실패(키/referer 불일치·오프라인) 시 placeholder 유지(graceful degrade).
import { NCP_CLIENT_ID } from './map_config.js';

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
    const pos = new maps.LatLng(lat, lng);
    const map = new maps.Map(container, { center: pos, zoom: 16, scaleControl: false, mapDataControl: false, logoControlOptions: { position: maps.Position.BOTTOM_LEFT } });
    new maps.Marker({ position: pos, map, title: name || '' });
    if (fallbackEl) fallbackEl.style.display = 'none';
    return map;
  });
}
