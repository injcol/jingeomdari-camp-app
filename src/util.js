// 공용 유틸 — 길찾기 딥링크(네이버·카카오), DOM 헬퍼
// 카카오맵 link/to: 키 불요·실측 HTTP 302 확인(2026-06-12). 네이버: 장소 검색(길찾기 route는 D7 기기 QA에서 앱스킴 보강).

export function kakaoRouteUrl(name, lat, lng) {
  if (lat == null || lng == null) return null;
  return `https://map.kakao.com/link/to/${encodeURIComponent(name)},${lat},${lng}`;
}

export function naverSearchUrl(name, lat, lng) {
  // 웹 유효 URL(검색). TODO(D7): 모바일 앱 nmap://route 스킴 + 웹 폴백으로 길찾기 승격
  if (lat != null && lng != null) {
    return `https://map.naver.com/p/search/${encodeURIComponent(name)}?c=${lng},${lat},15,0,0,0,dh`;
  }
  return `https://map.naver.com/p/search/${encodeURIComponent(name)}`;
}

// 미션 유형 → 한글 라벨/아이콘
export const MISSION_TYPE = {
  observe_quiz: { label: '관찰퀴즈', icon: '🔎' },
  photo_reenact: { label: '사진재현', icon: '📸' },
  interview_experience: { label: '인터뷰·체험', icon: '🗣' },
  reflect_share: { label: '묵상나눔', icon: '🕯' },
};

export const THEME_LABEL = { faith: '신앙', history: '역사·현대사', neighbor: '이웃', ecology: '생태', fun: '흥미' };

// 출발·도착 허브 (오너 지시 2026-07-23: 한국교회100주년기념관 → HIVE hyehwa).
// 좌표=창경궁로29길(명륜2가) OSM 지오코딩. 최근접역=혜화역 4호선(4번 출구 인근).
// ⚠ 각 장소의 hubMinutes·base_points는 옛 허브(종로5가) 기준값 — 미재계산(오너 판단 대기).
export const HUB = {
  name: 'HIVE hyehwa', short: 'HIVE', address: '서울 종로구 창경궁로29길 5',
  lat: 37.583944, lng: 126.997433, nearestStation: '혜화역 4호선 (도보 약 5분)',
};

// DOM 헬퍼: el('div', {class:'x'}, [children|string])
export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 클라이언트 이미지 리사이즈/압축 → JPEG Blob. (Storage 무료티어 한도·업로드 속도 대응 — APP_SPEC §한도)
// 비이미지(영상 등)는 원본 반환. 실패 시 원본으로 graceful fallback.
export function resizeImage(file, maxEdge = 1600, quality = 0.82) {
  return new Promise((resolve) => {
    if (!file || !/^image\//.test(file.type)) return resolve(file);
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      cv.toBlob((b) => { URL.revokeObjectURL(url); resolve(b || file); }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// Blob → base64 문자열(data: 프리픽스 제거). Plan B: upload-photo Edge Function 전송용(JSON body).
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = () => reject(new Error('blob_read_failed'));
    r.readAsDataURL(blob);
  });
}
