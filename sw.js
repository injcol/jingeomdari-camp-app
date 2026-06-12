// 징검다리 여름캠프 — Service Worker (오프라인 캐시) | worker2 | 2026-06-12 (master 승인)
// 전략: 네트워크 우선(HTML·seed.js — 항상 최신) + 캐시 우선(정적 에셋·앱 모듈).
//   캐시명에 배포 버전키 → 새 배포 시 VERSION 교체하면 구버전 캐시 제거(구버전 고착 방지).
//   skipWaiting + clients.claim 즉시 활성. 모든 단계 실패는 네트워크로 폴백(SW가 앱을 깨지 않음).
// ⚠ 새 배포마다 VERSION 갱신(master 재배포 시 본 줄 bump). file://는 SW 미지원(https/localhost 전용).
const VERSION = 'v20260612-185928';
const CACHE = `jgd-${VERSION}`;

// 정적 사전캐시(오프라인 첫 진입 대비). 개별 add로 일부 실패 무시. seed.js는 폴백용(런타임은 네트워크 우선).
const PRECACHE = [
  './', './index.html', './manifest.webmanifest',
  './assets/tokens.css', './assets/app.css', './assets/icon.svg', './assets/placeholder_place.svg',
  './src/app.js', './src/store.js', './src/util.js', './src/map.js', './src/teacher.js',
  './src/supabase.js', './src/supabase_config.js', './src/map_config.js',
  './data/seed.js',
];

// 네트워크 우선 대상: HTML 문서(앱 셸) + 런타임 데이터(seed.js)
function isNetworkFirst(url) {
  return url.pathname.endsWith('/') || url.pathname.endsWith('.html') || url.pathname.endsWith('/data/seed.js');
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u)))).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 구버전(jgd-*) 캐시 전부 제거 → 구버전 고착 방지
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('jgd-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })().catch(() => {}));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                       // 비GET은 SW 미개입(네트워크)
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;        // 외부(Supabase·네이버·카카오·esm) 미개입

  if (isNetworkFirst(url)) {
    // 네트워크 우선: 성공 시 캐시 갱신, 실패(오프라인) 시 캐시 폴백
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch {
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
  } else {
    // 캐시 우선: 히트 즉시, 미스 시 네트워크+캐시. (배포 시 VERSION bump→구캐시 삭제로 갱신)
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) { const c = await caches.open(CACHE); c.put(req, res.clone()); }
        return res;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});
