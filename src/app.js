// 라우터 + 화면 — D2 학생 플로우 정밀화.
// 홈=진행률 징검다리(세로 serpentine 물길·점등, 가변 코스 길이 대응)+다음액션(썸존)+대기배지+빠른진입.
// 장소상세=비대칭 매거진(풀블리드 사진 히어로·겹친 네이버 지도+접근정보·읽을거리 지면·미션 썸존·도착 체크인).
// 플래너/인증/저널/관리자는 D3~D6.
import { Store } from './store.js';
import { Teacher } from './teacher.js';
import * as Supabase from './supabase.js';   // 교사 사진 모달(#2)·저널 사진 서명 URL 로더. (기존 line~752 참조 누락 import 보강)
import { el, kakaoRouteUrl, naverSearchUrl, MISSION_TYPE, THEME_LABEL, HUB } from './util.js';
import { renderMap, renderAllMap } from './map.js';

const app = () => document.getElementById('app');
let plannerTheme = 'all';   // 코스 플래너 테마 필터(로컬 UI 상태)
let pendingMap = null;      // 렌더 후 초기화할 네이버 지도 {lat,lng,name}
let pendingAllMap = false;   // 렌더 후 전체지도 초기화 플래그
let draft = null;           // 미션 인증 드래프트 { files[], previews[], comment, uploading, progress }
let teacherTab = 'queue';   // 교사 탭 queue|camp(전체현황)|board(조별현황)|photos(사진) — R5
let teacherData = { queue: null, board: null, gallery: null, loading: false, error: null, loaded: false };
let photoModal = null;      // 사진 상세 모달 { refs, group, label, submissionId, urls }
const PLACEHOLDER_PHOTO = 'assets/placeholder_place.svg'; // 앱 공통 placeholder(매니페스트 §6 worker2 지정). url 미확정 19곳 노출
// 히어로 사진 세로 정렬(object-position Y%) — 세로/정방형 사진의 윗부분(머리·지붕·종탑) 잘림 방지. 미지정=50%(중앙).
//   가로형(비율>1.48) 사진은 세로가 꽉 차 Y값 무관 → 등재 불요. (실측 /tmp/hero_prop.png 시각검증)
const HERO_POS_Y = { A1: 0, B2: 16, B7: 12, C2: 18, A7: 22, A4: 38, A8: 38, D5: 38 };
let joining = { code: null, status: 'idle', error: null }; // 조별 링크 자동 입장 상태 idle|pending|done|error
function resetDraft() { if (draft) draft.previews.forEach((u) => URL.revokeObjectURL(u)); draft = { files: [], previews: [], comment: '', uploading: false, progress: 0 }; }

// ── 협동 캠프 현황(#4/#3) — camp_progress 캐시 + 폴링(진입+20s+제출후). 사진/제출/정답 노출 0(집계만). ──
let campCache = { data: null, loadedAt: 0, loading: false };      // camp_progress() 결과(total_score·per_place·uncovered)
let boardTimer = null;                                            // #/board 폴링 인터벌
const FRESH_MS = 8000;                                            // 중복 호출 억제 창

async function loadCamp(force) {
  // ★R4 #2: camp_progress는 public(조 불요) → 게이트는 네트워크(isDemoEnv)만. 교사(조코드 없음)도 로드돼야 함.
  if (Store.isDemoEnv()) { campCache.data = null; return false; }
  if (campCache.loading) return false;
  if (!force && campCache.data && Date.now() - campCache.loadedAt < FRESH_MS) return false;
  campCache.loading = true;
  try { const d = await Store.fetchCampProgress(); campCache.data = d || null; campCache.loadedAt = Date.now(); return !!d; }
  catch (e) { console.warn('[camp] 로드 실패(무시):', e.message); return false; }
  finally { campCache.loading = false; }
}
// 백그라운드 로드 후 캐시 갱신 시에만 1회 재렌더(루프 방지 — fresh면 조기반환).
function kickCamp() { if (Store.isDemoEnv()) return; loadCamp().then((u) => { if (u) render(); }); }

// per-place 다녀간 조 목록(순서대로) — #3 표시·힌트 N 산출.
function placeGroups(id) {
  const pp = campCache.data && campCache.data.per_place;
  if (!pp) return [];
  const row = pp.find((x) => x.place_id === id);
  return row ? (row.groups || []) : [];
}
function coveredCount(id) { return placeGroups(id).length; }   // 그 장소를 다녀간 조 수(힌트 N)

// 경량 토스트(자동 소멸) — 코스 저장 실패 등 비차단 알림.
function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 320); }, 2600);
}

function tabbar(active) {
  const tab = (href, ic, label, on) => el('a', { href, class: on ? 'on' : '' }, [el('span', { class: 'ic' }, ic), label]);
  return el('nav', { class: 'tabbar' }, [
    tab('#/', '⛰', '홈', active === 'home'),
    tab('#/planner', '🗺', '코스', active === 'planner'),
    tab('#/map', '📍', '지도', active === 'map'),
    tab('#/board', '📊', '현황', active === 'board'),
    tab('#/journal', '📖', '저널', active === 'journal'),
  ]);
}

// ── 진행률 징검다리: 세로 serpentine. 완료=물 차오름·점등·✓ / 현재=점멸 링·지금여기 / 예정=흐림 ──
function buildCrossing(course, nextId) {
  const N = course.length;
  const top = 46, step = 92, H = top + (N - 1) * step + 46;
  const pts = course.map((c, i) => ({ xf: i % 2 === 0 ? 0.30 : 0.70, y: top + i * step, ...c }));
  // SVG 물길(세로 S커브)
  let d = `M ${pts[0].xf * 100} ${pts[0].y}`;
  for (let i = 1; i < N; i++) {
    const a = pts[i - 1], b = pts[i], my = (a.y + b.y) / 2;
    d += ` C ${a.xf * 100} ${my} ${b.xf * 100} ${my} ${b.xf * 100} ${b.y}`;
  }
  const svg = `<svg class="river-svg" viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}" fill="none" stroke="var(--river-300)" stroke-width="7" stroke-linecap="round" opacity="0.55"/>
    <path d="${d}" fill="none" stroke="var(--river-700)" stroke-width="2.5" stroke-dasharray="1 7" stroke-linecap="round" opacity="0.7"/>
  </svg>`;

  const wrap = el('div', { class: 'crossing', style: `height:${H}px` });
  wrap.appendChild(el('div', { class: 'river-layer', html: svg }));
  pts.forEach((p) => {
    const place = Store.place(p.placeId);
    const done = Store.visited(p.placeId); const now = p.placeId === nextId;   // 제출=다녀옴(승인 불요)
    const fill = done ? 78 : (now ? 32 : 0);
    const stone = el('a', {
      href: `#/place/${p.placeId}`,
      class: `cstone ${done ? 'done' : now ? 'now' : 'future'}`,
      style: `left:${p.xf * 100}%; top:${p.y}px`,
    }, [
      now ? el('span', { class: 'pin' }, '지금 여기 ▾') : null,
      el('span', { class: 'pebble tex-stone' }, [
        el('span', { class: 'water', style: `height:${fill}%` }),
        el('span', { class: 'lbl' }, place ? place.name : p.placeId),
      ]),
    ]);
    wrap.appendChild(stone);
  });
  return wrap;
}

// 홈 협동 배지 — "우리 캠프 함께 N점 · M/전체곳". 돌물 진행 시각화와 별개(대체 아님). #/board로 연결.
function scoreBadge() {
  if (Store.localMode()) {
    return el('a', { href: '#/board', class: 'score-badge tex-stone organic local' }, [
      el('div', { class: 'sb-main' }, [el('span', { class: 'sb-pts' }, String(Store.localScore())), el('span', { class: 'sb-unit' }, '점')]),
      el('div', { class: 'sb-side' }, [el('div', { class: 'sb-k' }, '우리 조가 더한 점수 (예상)'), el('div', { class: 'sb-rank' }, '캠프 전체 현황은 온라인에서 →')]),
    ]);
  }
  const d = campCache.data;
  const total = d ? d.total_score : 0, covered = d ? d.places_covered : 0, all = d ? d.places_total : Store.seed.places.length;
  return el('a', { href: '#/board', class: 'score-badge tex-stone organic' }, [
    el('div', { class: 'sb-main' }, [el('span', { class: 'sb-pts' }, String(total)), el('span', { class: 'sb-unit' }, '점')]),
    el('div', { class: 'sb-side' }, [
      el('div', { class: 'sb-k' }, '우리 캠프가 함께 모은 점수'),
      el('div', { class: 'sb-rank' }, `${all}곳 중 ${covered}곳 개척 · 전체 현황 →`),
    ]),
  ]);
}

function screenHome() {
  const course = Store.course;
  const nextId = Store.nextPlace();
  const next = nextId ? Store.place(nextId) : null;

  const nextCard = next ? el('a', { href: `#/place/${next.placeId}`, class: 'next tex-stone organic' }, [
    el('div', { class: 'next-ic tex-water organic' }, '→'),
    el('div', { class: 'next-body' }, [
      el('div', { class: 'next-k' }, '다음 징검다리'),
      el('div', { class: 'next-h display' }, next.name),
      el('div', { class: 'next-p' }, `${THEME_LABEL[next.themeTags[0]] || ''} · ${HUB.short} 허브 ${next.planner.routeType} ${next.planner.hubMinutes ?? '-'}분`),
    ]),
  ]) : el('div', { class: 'next tex-stone organic done-all' }, [el('div', { class: 'next-h display' }, '모든 징검다리를 건넜어요 🎉')]);

  const children = [
    el('div', { class: 'top' }, [
      el('div', { class: 'stamp tex-stone organic', style: `box-shadow:0 0 0 3px ${Store.group.color || 'transparent'}, 0 7px 16px -7px rgba(15,58,61,.6)` }, Store.group.name),
      el('div', { class: 'meta' }, [el('b', {}, '징검다리 여름캠프'), el('br'), '높은뜻섬기는교회 청소년부']),
    ]),
    Store.showJoinHint() ? el('div', { class: 'join-hint' }, [el('span', { class: 'jh-ic' }, '🔗'), '선생님께 받은 우리 조 링크로 입장하면 인증·진행이 저장돼요. (지금은 둘러보기)']) : null,
    el('div', { class: 'h-title' }, [
      el('div', { class: 'k' }, '오늘 우리 조의 여정'),
      el('h1', { class: 'display' }, [`강을 건너며 `, el('em', {}, '기록하다')]),
    ]),
    el('div', { class: 'progress-note' }, `건넌 징검다리 ${Store.crossedCount()} · ${course.length}곳 코스`),
    scoreBadge(),
    buildCrossing(course, nextId),
    nextCard,
  ];
  children.push(el('nav', { class: 'quick' }, [
    el('a', { href: '#/planner', class: 'tex-stone organic q-dark' }, [el('span', { class: 'q-ic' }, '🗺'), el('span', { class: 'q-t' }, '코스 플래너'), el('span', { class: 'q-d' }, '공통 3곳 + 선택 담기')]),
    el('a', { href: '#/journal', class: 'tex-paper organic q-light' }, [el('span', { class: 'q-ic' }, '📖'), el('span', { class: 'q-t' }, '조별 저널'), el('span', { class: 'q-d' }, '다녀온 사진 수록')]),
  ]));
  // 코스 미션(장소 비귀속) — 별도 진입
  const cms = Store.courseMissions();
  if (cms.length) children.push(el('section', { class: 'cm-sec' }, [
    el('div', { class: 'cm-k' }, '우리 조 코스 미션'),
    el('div', { class: 'cm-list' }, cms.map((m) => {
      const tt = MISSION_TYPE[m.type] || { label: m.type, icon: '•' };
      const sub = Store.submission(m.missionId);
      const sm = STATUS_META[sub.status] || STATUS_META.idle;
      return el('a', { href: `#/mission/${m.missionId}`, class: 'cm-item' }, [
        el('span', { class: 'cm-ic' }, tt.icon),
        el('span', { class: 'cm-b' }, [el('b', {}, tt.label), el('small', {}, m.brief || '코스 전체 미션')]),
        el('span', { class: `cm-st ${sm.cls}` }, sub.status === 'idle' ? '인증하기' : sm.k),
      ]);
    })),
  ]));
  children.push(el('div', { class: 'grow' }));
  children.push(el('a', { href: '#/teacher', class: 'teacher-link' }, '교사 관리자 →'));
  // 고정 셸 통일: 홈 내용도 .scroll 안으로(바디 잠금 시 잘림 방지). grow로 교사링크 하단 고정 유지.
  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll', style: 'display:flex; flex-direction:column;' }, children),
    tabbar('home'),
  ]);
}

function screenPlace(id) {
  const p = Store.place(id);
  if (!p) return el('main', { class: 'phone tex-paper col' }, [el('div', { class: 'pad' }, '장소를 찾을 수 없습니다.'), el('a', { href: '#/', class: 'btn' }, '홈으로')]);
  const pr = Store.progress(id);
  const kakao = kakaoRouteUrl(p.name, p.naverMap.lat, p.naverMap.lng);
  const naver = naverSearchUrl(p.name, p.naverMap.lat, p.naverMap.lng);

  // 풀블리드 히어로: confirmed(url)만 실사진, 그 외 앱 공통 placeholder 에셋 (저작권 안전: needsFieldShoot/미확정=실사진 금지)
  const hasPhoto = p.photo && p.photo.url;
  const hero = el('header', { class: 'hero' }, [
    el('div', { class: 'photo hero-photo' }, hasPhoto
      ? [el('img', { src: p.photo.url, alt: p.name, style: `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% ${HERO_POS_Y[id] ?? 50}%` })]
      : [el('img', { src: PLACEHOLDER_PHOTO, alt: `${p.name} 실사진 준비 중`, class: 'ph-img' }),
         el('div', { class: 'ph-tag' }, photoStatusLabel(p))]),
    el('div', { class: 'grad' }),
    el('a', { href: '#/', class: 'back' }, '‹'),
    el('div', { class: 'cap' }, [
      el('div', { class: 'k' }, Store.isRequired(id) ? `공통 필수 · ${HUB.short} 허브` : '선택 장소'),
      el('h1', { class: 'display' }, p.name),
      el('div', { class: 'tags' }, p.themeTags.map((t) => el('span', { class: 'chip' }, THEME_LABEL[t] || t))),
    ]),
    hasPhoto ? el('div', { class: 'src' }, `📷 ${p.photo.attribution || p.photo.source || ''}`) : null,
  ]);

  // 네이버 지도(실연동) + 실패 시 placeholder fallback
  const hasCoord = p.naverMap.lat != null && p.naverMap.lng != null;
  const mapWrap = el('div', { class: 'map-wrap' }, [
    el('div', { id: 'place-map', class: 'naver-map' }),
    el('div', { class: 'mapslot map-fallback', id: 'map-fallback' }, [
      el('span', { class: 'badge-map' }, '네이버 지도'),
      el('span', { class: 'pin', style: 'left:50%;top:54%' }, '📍'),
      el('div', { class: 'ph-note' }, hasCoord ? `${p.naverMap.lat}, ${p.naverMap.lng}` : '좌표 준비 중'),
    ]),
  ]);
  pendingMap = hasCoord ? { lat: p.naverMap.lat, lng: p.naverMap.lng, name: p.name } : null;

  // 비대칭: 지도(넓게, 위로 겹침) + 접근정보(좁게)
  const asym = el('div', { class: 'row' }, [
    el('div', { class: 'map-card tex-paper organic' }, [el('div', { class: 'ttl' }, '네이버 지도 · 위치'), mapWrap]),
    el('div', { class: 'access' }, [
      el('div', { class: 'a-item' }, [el('span', { class: 'a-ic' }, '📍'), el('span', {}, [el('b', {}, `${HUB.short} 허브`), ` ${routeLabel(p.planner)}`])]),
      el('div', { class: 'a-item' }, [el('span', { class: 'a-ic' }, '🏠'), el('span', {}, p.address || '주소 — Phase1 확정')]),
      el('div', { class: 'a-item' }, [el('span', { class: 'a-ic' }, '🧭'), el('span', {}, [el('b', {}, '도착하면 직접 체크인'), ' (실시간 위치 없음)'])]),
    ]),
  ]);

  // R2 Critical#2: 길찾기를 하단 고정 썸존 바로(가장 빈번한 액션). 한 손 조작 동선 개선.
  const routeBar = el('div', { class: 'route-bar' }, [
    el('span', { class: 'rb-k' }, '길찾기'),
    el('a', { class: 'btn rb-btn', href: naver || '#', target: '_blank', rel: 'noopener' }, '네이버'),
    el('a', { class: 'btn rb-btn', href: kakao || '#', target: '_blank', rel: 'noopener' }, '카카오맵'),
  ]);

  // 협동 힌트(R2): 미개척 강조. 우리가 가면 (N+1)번째 = P/2^N 기여(반감). N=다녀간 조 수(camp_progress 폴링).
  const pts = Store.basePointsOf(id);
  const nDone = coveredCount(id);
  const gainRaw = pts / Math.pow(2, nDone);
  const gainStr = Number.isInteger(gainRaw) ? String(gainRaw) : gainRaw.toFixed(1);
  const pointHint = el('div', { class: `point-hint tex-water organic ${nDone === 0 ? 'fresh' : ''}` }, [
    el('div', { class: 'ph-pts' }, [el('b', {}, String(pts)), el('small', {}, '기본점')]),
    el('div', { class: 'ph-body' }, [
      el('div', { class: 'ph-k' }, nDone === 0 ? '✨ 아직 아무 조도 안 간 곳!' : `${nDone}개 조가 다녀갔어요`),
      el('div', { class: 'ph-gain' }, nDone === 0
        ? [`지금 가면 캠프에 `, el('b', {}, `+${gainStr}점`), el('small', {}, ' (첫 개척, 만점!)')]
        : [`지금 가면 `, el('b', {}, `+${gainStr}점`), el('small', {}, ` (${nDone + 1}번째 방문)`)]),
    ]),
  ]);

  const rd = Store.readingFor(id);
  const reading = el('section', { class: 'reading tex-paper' }, [
    el('div', { class: 'k' }, '읽을거리 · 묵상'),
    el('h2', { class: 'display' }, (rd && rd.title) || '이 자리의 이야기'),
    ...(rd && rd.body
      ? rd.body.split(/\n\n+/).map((par) => el('p', {}, par))
      : [el('p', { class: 'muted' }, '[읽을거리 준비 중 — content/readings/ 연결 예정]')]),
  ]);

  const missions = el('div', { class: 'mission-wrap' }, Store.missionsOf(id).map((m) => {
    const t = MISSION_TYPE[m.type] || { label: m.type, icon: '•' };
    const sub = Store.submission(m.missionId);
    return el('article', { class: 'mission-card tex-stone organic' }, [
      el('div', { class: 'm-head' }, [
        el('span', { class: 'm-ic tex-water organic' }, t.icon),
        el('div', {}, [el('div', { class: 'm-k' }, `미션 · ${t.label}`), el('div', { class: 'm-brief' }, m.brief || '')]),
      ]),
      m.requiresReservation ? el('div', { class: 'm-note' }, '※ 사전 예약·협의 필요') : null,
      m.fallbackMission ? el('div', { class: 'm-note' }, `↺ 대체: ${m.fallbackMission}`) : null,
      subStatusChip(sub),
      el('a', { class: 'btn block m-cta', href: `#/mission/${m.missionId}` },
        sub.status === 'idle' ? '미션 인증하기' : sub.status === 'revise' ? '보완해서 다시 올리기' : '인증 상태 보기'),
    ]);
  }));

  const checkin = el('button', { class: `checkin organic ${pr.checkedIn ? 'on' : ''}`, onclick: () => { Store.toggleCheckIn(id); render(); } }, [
    el('div', { class: 'sw' }),
    el('div', { class: 'txt' }, [el('b', {}, pr.checkedIn ? '도착 체크인 완료 ✓' : '여기 도착했어요 — 도착 체크인'), el('small', {}, '홈 징검다리에 현재 위치 표시 · 기록을 잊지 마세요')]),
  ]);

  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [hero, el('div', { class: 'sheet' }, [asym, pointHint, reading, missions, checkin])]),
    routeBar,
    tabbar(''),
  ]);
}

function routeLabel(pl) {
  const r = { walk: '도보', noTransfer: '무환승', '1transfer': '1환승', '2transfer': '2환승' }[pl.routeType] || pl.routeType;
  return `${r} · 편도 약 ${pl.hubMinutes ?? '-'}분${pl.transferCount ? ` · 환승 ${pl.transferCount}` : ''}`;
}
function photoStatusLabel(p) {
  return ({ confirmed: '공공누리 제1유형', placeholder: '실사진 준비 중', replace: '실사진 준비 중' })[p.photo && p.photo.status] || '준비 중';
}

// ── 화면 ④ 미션 인증 — 상태머신: idle → uploading(올림) → pending(승인 대기) → approved/revise ──
const STATUS_META = {
  idle: { step: 0, k: '인증 시작', cls: '' },
  uploading: { step: 0, k: '올리는 중', cls: 'up' },
  queued: { step: 0, k: '전송 보류(오프라인)', cls: 'queued' },
  pending: { step: 1, k: '승인 대기', cls: 'pending' },   // R3 #2: 교사 승인 시 인정 → 제출 후 '승인 대기'
  approved: { step: 2, k: '완료', cls: 'approved' },
  revise: { step: 2, k: '보완요청', cls: 'revise' },
};
function subStatusChip(sub) {
  if (!sub || sub.status === 'idle') return null;
  const m = STATUS_META[sub.status] || STATUS_META.idle;
  return el('div', { class: `m-status ${m.cls}` }, [el('span', { class: 'dot' }), `${m.k}${sub.status === 'pending' ? ' · 교사 확인 중' : ''}`]);
}
function stepper(status) {
  const cur = (STATUS_META[status] || STATUS_META.idle).step;
  const revise = status === 'revise';
  const labels = ['올림', '승인 대기', revise ? '보완요청' : '완료'];
  return el('div', { class: 'stepper' }, labels.map((lb, i) => el('div', {
    class: `step ${i < cur ? 'done' : ''} ${i === cur ? 'on' : ''} ${i === 2 && revise ? 'revise' : ''}`,
  }, [el('span', { class: 'sdot' }, i < cur ? '✓' : String(i + 1)), el('span', { class: 'slbl' }, lb)])));
}

function screenMission(missionId) {
  const meta = Store.missionMeta(missionId);
  if (!meta) return stub('미션', '미션을 찾을 수 없습니다.', '');
  const place = meta.placeId ? Store.place(meta.placeId) : null;
  const sub = Store.submission(missionId);
  const t = MISSION_TYPE[meta.type] || { label: meta.type, icon: '•' };
  const backHref = place ? `#/place/${place.placeId}` : '#/';
  if (!draft || draft.missionId !== missionId) { resetDraft(); draft.missionId = missionId; }

  // 헤더
  const head = el('header', { class: 'mh' }, [
    el('a', { href: backHref, class: 'mh-back' }, '‹'),
    el('div', { class: 'mh-k' }, place ? place.name : '코스 미션'),
    el('div', { class: 'mh-sp' }),
  ]);

  const intro = el('div', { class: 'm-intro' }, [
    el('span', { class: 'm-ic tex-water organic' }, t.icon),
    el('div', {}, [
      el('div', { class: 'm-k' }, `${meta.scope === 'course' ? '코스 미션' : '미션'} · ${t.label}`),
      el('h1', { class: 'display' }, meta.brief || '미션 인증'),
      el('div', { class: 'ev' }, (meta.evidenceTypes || []).map((e) => el('span', { class: 'chip' }, EVIDENCE_LABEL[e] || e))),
    ]),
  ]);

  // 본문: 상태별
  let bodyKids;
  if (sub.status === 'approved') {
    bodyKids = [
      el('div', { class: 'm-result approved' }, [
        el('div', { class: 'r-ic' }, '✓'),
        el('h2', { class: 'display' }, '승인되었어요'),
        el('p', {}, place ? '홈 징검다리에 이 장소의 돌이 차오르고 불이 켜졌어요.' : '코스 미션이 승인되었어요.'),
        thumbsRow(sub),
        sub.comment ? el('p', { class: 'r-comment' }, `“${sub.comment}”`) : null,
      ]),
      el('a', { href: backHref, class: 'btn ghost block' }, '장소로 돌아가기'),
      el('a', { href: '#/', class: 'btn block' }, '홈 징검다리 보기'),
    ];
  } else if (sub.status === 'pending') {
    bodyKids = [
      el('div', { class: 'm-result pending' }, [
        el('div', { class: 'r-ic spin' }, '◷'),
        el('h2', { class: 'display' }, '교사 선생님 확인 중'),
        el('p', {}, '제출이 접수됐어요. 승인되면 홈 징검다리에 불이 켜지고 캠프 점수에 반영돼요.'),
        thumbsRow(sub),
        sub.comment ? el('p', { class: 'r-comment' }, `“${sub.comment}”`) : null,
      ]),
      ...demoReviewControls(missionId),
      el('button', { class: 'btn ghost block m-cancel', onclick: () => doCancel(missionId) }, '제출 취소하고 다시 올리기'),
      el('a', { href: backHref, class: 'btn ghost block' }, '장소로 돌아가기'),
    ];
  } else if (sub.status === 'revise') {
    bodyKids = [
      el('div', { class: 'm-result revise' }, [
        el('div', { class: 'r-ic' }, '↺'),
        el('h2', { class: 'display' }, '보완요청'),
        sub.teacherNote ? el('p', { class: 'tnote' }, `선생님 메모: ${sub.teacherNote}`) : el('p', {}, '사진을 다시 올려 주세요.'),
      ]),
      uploadForm(missionId, meta, true),
    ];
  } else if (sub.status === 'queued') {
    bodyKids = [
      el('div', { class: 'm-result queued' }, [
        el('div', { class: 'r-ic' }, '⇅'),
        el('h2', { class: 'display' }, '전송 보류'),
        el('p', {}, '오프라인이라 전송을 보류했어요. 연결되면 자동으로 다시 보냅니다. (사진을 다시 선택해 주세요)'),
      ]),
      uploadForm(missionId, meta, true),
    ];
  } else {
    bodyKids = [uploadForm(missionId, meta, false)];
  }

  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [
      head,
      el('div', { class: 'sheet m-sheet' }, [intro, stepper(sub.status), ...bodyKids]),
    ]),
    tabbar(''),
  ]);
}

const EVIDENCE_LABEL = { photo: '사진', group_photo: '단체사진', memo: '메모', voice: '음성', purchase: '구매인증' };

function thumbsRow(sub) {
  const n = (sub.photoRefs || []).length;
  if (!n) return null;
  // 영속 사진은 비공개 버킷(서명URL 필요) → 목록에선 매수만 표기. 방금 올린 미리보기는 draft에서.
  return el('div', { class: 'thumbs' }, [el('span', { class: 'th-mark' }, `🖼 사진 ${n}장 첨부됨`)]);
}

function uploadForm(missionId, meta, isRetry) {
  if (draft.uploading) {
    return el('div', { class: 'up-progress' }, [
      el('div', { class: 'up-k' }, '사진을 올리는 중…'),
      el('div', { class: 'up-track' }, [el('div', { id: 'up-bar', class: 'up-bar', style: `width:${Math.round(draft.progress * 100)}%` })]),
      el('button', { class: 'btn ghost block', onclick: () => cancelUpload() }, '취소'),
    ]);
  }
  const previews = el('div', { class: 'previews' }, draft.previews.map((u, i) => el('div', { class: 'pv' }, [
    el('img', { src: u, alt: '' }),
    el('button', { class: 'pv-x', onclick: () => { URL.revokeObjectURL(u); draft.previews.splice(i, 1); draft.files.splice(i, 1); render(); } }, '×'),
  ])));
  const picker = el('label', { class: 'picker organic' }, [
    el('span', { class: 'pk-ic' }, '📷'),
    el('span', { class: 'pk-t' }, draft.files.length ? '사진 더 추가' : '사진 선택 · 촬영'),
    el('span', { class: 'pk-d' }, '카메라/갤러리 · 여러 장 가능'),
    el('input', {
      type: 'file', accept: 'image/*', multiple: '', class: 'pk-input',
      onchange: (e) => addFiles(e.target.files),
    }),
  ]);
  const commentBox = el('textarea', {
    class: 'cmt', rows: '2', placeholder: '한 줄 기록 (선택) — 무엇을 발견했나요?',
    oninput: (e) => { draft.comment = e.target.value; },
  });
  commentBox.value = draft.comment;
  const can = draft.files.length > 0;
  return el('div', { class: 'up-form' }, [
    draft.files.length ? previews : el('div', { class: 'up-empty' }, '아직 올린 사진이 없어요.'),
    picker,
    commentBox,
    el('button', { class: `btn block submit ${can ? '' : 'off'}`, disabled: can ? null : '', onclick: () => doSubmit(missionId) }, isRetry ? '다시 제출하기' : '제출하기'),
    Store.localMode() ? el('div', { class: 'mode-note' }, '※ 로컬 미리보기 모드 — 실제 업로드/저장은 조 코드 입장 + 온라인에서 작동합니다.') : null,
  ]);
}

function addFiles(fileList) {
  for (const f of fileList) { draft.files.push(f); draft.previews.push(URL.createObjectURL(f)); }
  render();
}
let activeUpload = null;
function cancelUpload() {
  if (activeUpload && activeUpload.handle && activeUpload.handle.xhr) try { activeUpload.handle.xhr.abort(); } catch {}
  draft.uploading = false; activeUpload = null; render();
}
async function doSubmit(missionId) {
  if (!draft.files.length) return;
  draft.uploading = true; draft.progress = 0; render();
  try {
    await Store.submitMission(missionId, {
      files: draft.files, comment: draft.comment,
      onProgress: (p) => { draft.progress = p; const bar = document.getElementById('up-bar'); if (bar) bar.style.width = `${Math.round(p * 100)}%`; },
    });
    draft.uploading = false; resetDraft(); render();
  } catch (e) {
    draft.uploading = false; render();    // queued/실패 상태는 store가 기록 → 화면 갱신
  }
}
// R5 #2: 승인 대기 제출 취소 → 철회·재제출 가능.
async function doCancel(missionId) {
  if (!confirm('제출을 취소할까요? 올린 사진·기록이 지워지고 다시 올릴 수 있어요.')) return;
  try { await Store.cancelSubmission(missionId); resetDraft(); render(); }
  catch (e) { toast('취소에 실패했어요. 잠시 후 다시 시도해 주세요.'); }
}
// (데모) 로컬모드에서 교사 승인/보완 미리보기 — 상태머신 UI 확인용. production엔 미표시.
function demoReviewControls(missionId) {
  if (!Store.localMode()) return [];
  return [el('div', { class: 'demo-rev' }, [
    el('span', { class: 'dr-k' }, '데모: 교사 검토 미리보기'),
    el('button', { class: 'mini', onclick: () => { Store.demoReview(missionId, 'approved'); render(); } }, '승인'),
    el('button', { class: 'mini del', onclick: () => { Store.demoReview(missionId, 'revise', '사진에 안내판이 잘 보이게 다시 찍어볼까요?'); render(); } }, '보완요청'),
  ])];
}

// ── 화면 ⑥ 교사 — 승인 큐 · 전체 현황(협동) · 조별 현황 · 사진 갤러리 (R5 종합 옵저버) ──
async function loadTeacher() {
  teacherData.loading = true; teacherData.error = null; render();
  try {
    const [queue, board, gallery] = await Promise.all([Teacher.queue(), Teacher.board(), Teacher.submissions()]);
    teacherData = { queue, board, gallery, loading: false, error: null, loaded: true };
  } catch (e) {
    teacherData = { ...teacherData, loading: false, error: String(e.message || e), loaded: true };
    if (/invalid_teacher_code/.test(teacherData.error)) Teacher.clear();  // 코드 오류 → 게이트로
  }
  render();
}
async function teacherAct(fn) { try { await fn(); } catch (e) { teacherData.error = String(e.message || e); } await loadTeacher(); }

const TEACHER_TABS = ['queue', 'camp', 'board', 'photos'];
function screenTeacher() {
  if (!Teacher.code) return teacherGate();
  if (!teacherData.loaded && !teacherData.loading) { loadTeacher(); }  // 최초 진입 시 로드
  const hint = (location.hash.match(/^#\/teacher\/(\w+)/) || [])[1];
  teacherTab = TEACHER_TABS.includes(hint) ? hint : 'queue';

  const tabs = el('div', { class: 't-tabs' }, [
    ['queue', '승인'], ['camp', '전체 현황'], ['board', '조별 현황'], ['photos', '사진'],
  ].map(([k, label]) => {
    const n = k === 'queue' && teacherData.queue ? teacherData.queue.length
      : (k === 'photos' && teacherData.gallery ? teacherData.gallery.length : null);
    return el('button', { class: `t-tab ${teacherTab === k ? 'on' : ''}`, onclick: () => { location.hash = k === 'queue' ? '#/teacher' : `#/teacher/${k}`; } },
      [label, n ? el('span', { class: 't-badge' }, String(n)) : null]);
  }));

  let content;
  if (teacherTab === 'camp') content = teacherCampTab();
  else if (teacherData.loading && !teacherData.queue) content = el('div', { class: 't-skel' }, '불러오는 중…');
  else if (teacherTab === 'board') content = teacherBoard();
  else if (teacherTab === 'photos') content = teacherGallery();
  else content = teacherQueue();

  const errBar = teacherData.error && !/invalid_teacher_code/.test(teacherData.error)
    ? el('div', { class: 't-err' }, [`오류: ${teacherData.error}`, el('button', { class: 'mini', onclick: () => loadTeacher() }, '다시')])
    : null;

  return el('main', { class: 'phone tex-paper col' }, [
    el('header', { class: 't-head' }, [
      el('div', {}, [el('div', { class: 't-k' }, '교사 관리자'), el('h1', { class: 'display' }, '인증 검토 · 현황')]),
      el('button', { class: 'mini', onclick: () => { Teacher.clear(); teacherData = { queue: null, board: null, gallery: null, loading: false, error: null, loaded: false }; render(); } }, '나가기'),
    ]),
    tabs, errBar,
    el('div', { class: 'scroll t-body' }, [content]),
    photoModal ? photoModalEl() : null,
  ]);
}

function teacherGate() {
  let code = '';
  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 't-gate' }, [
      el('div', { class: 'tg-ic tex-water organic' }, '🔑'),
      el('h1', { class: 'display' }, '교사 관리자'),
      el('p', { class: 'muted' }, '교사 코드를 입력하세요. 학생 화면과 분리된 검토·승인 영역입니다.'),
      el('input', { class: 'tg-input', type: 'password', placeholder: '교사 코드', inputmode: 'text', oninput: (e) => { code = e.target.value; } }),
      teacherData.error === 'invalid_teacher_code' || /invalid_teacher_code|empty_code/.test(teacherData.error || '')
        ? el('div', { class: 'tg-err' }, '코드가 올바르지 않습니다.') : null,
      el('button', { class: 'btn block', onclick: async () => {
        try { await Teacher.verify(code); teacherData.error = null; loadTeacher(); }
        catch (e) { teacherData.error = String(e.message || e); render(); }
      } }, '입장'),
      Teacher.localMode() ? el('div', { class: 'mode-note' }, '※ 로컬 데모 — 아무 코드나 입장(데모 데이터). 실제 검증은 교사 코드 + 온라인.') : null,
      el('a', { href: '#/', class: 'tg-back' }, '← 학생 화면으로'),
    ]),
  ]);
}

function fmtAgo(iso) {
  if (!iso) return '';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return '방금'; if (min < 60) return `${min}분 전`;
  const h = Math.round(min / 60); return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

function teacherQueue() {
  const q = teacherData.queue || [];
  if (!q.length) return el('div', { class: 't-empty' }, [el('div', { class: 'te-ic' }, '✓'), el('p', {}, '대기 중인 인증이 없어요.')]);
  return el('div', { class: 't-queue' }, q.map((s) => {
    const where = s.mission_scope === 'course' ? '코스 미션' : Teacher.placeName(s.place_id);
    const n = (s.photo_refs || []).length;
    return el('article', { class: 't-card' }, [
      el('div', { class: 'tc-top' }, [
        el('span', { class: 'tc-grp' }, s.group_name),
        el('span', { class: 'tc-where' }, where),
        el('span', { class: 'tc-time' }, fmtAgo(s.created_at)),
      ]),
      el('div', { class: 'tc-mission' }, Teacher.missionLabel(s.mission_id)),
      el('button', { class: 'tc-thumbs', onclick: () => { photoModal = { refs: s.photo_refs || [], group: s.group_name, label: where, submissionId: s.submission_id, urls: null, loading: false, error: null }; render(); } },
        [el('span', { class: 'tt-ic' }, '🖼'), `사진 ${n}장 보기`]),
      s.comment ? el('div', { class: 'tc-comment' }, `“${s.comment}”`) : null,
      // R2 Critical#1: 승인=대형 단독 1차 액션(48px+), 보완·숨김은 물리적으로 분리된 하단 행
      el('button', { class: 'btn tc-ok', onclick: () => teacherAct(() => Teacher.review(s.submission_id, 'approved', null)) }, '✓ 승인'),
      el('div', { class: 'tc-acts2' }, [
        el('button', { class: 'btn ghost tc-rev', onclick: () => {
          const note = prompt('보완요청 메모(학생에게 표시):', '');
          if (note !== null) teacherAct(() => Teacher.review(s.submission_id, 'revise', note));
        } }, '보완요청'),
        el('button', { class: 'tc-hide', onclick: () => { if (confirm('이 사진을 숨길까요? (큐·저널에서 제외)')) teacherAct(() => Teacher.hide(s.submission_id, true)); } }, '숨김'),
      ]),
    ]);
  }));
}

// R4 #2: 교사 '전체 현황' 탭 = 학생 #/board 협동 보드 재사용(camp_progress). teacher_board 카운트표 대체.
//   camp_progress는 승인(approved) 반영 + 폴링 → 기존 '업데이트 안 됨' 해소. 캠프 총점·M/20 개척·장소별 다녀간 조·미개척.
function teacherCampTab() {
  if (Teacher.localMode()) return el('div', { class: 'pad' }, [el('p', { class: 'muted' }, '데모(로컬) 모드 — 전체 현황(협동)은 온라인(교사 코드 입장)에서 표시됩니다.')]);
  kickCamp();
  const d = campCache.data;
  return d ? campBoardBody(d, null) : el('div', { class: 't-skel' }, '전체 현황을 불러오는 중…');
}

// R5 #1: 조별 현황 부활 — teacher_board 카운트표(조별 승인/대기/체크인/최근활동).
function teacherBoard() {
  const b = teacherData.board || [];
  if (!b.length) return el('div', { class: 't-skel' }, '불러오는 중…');
  return el('div', { class: 't-board' }, b.map((g) => {
    const total = g.total_places || 0, done = g.approved_count || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const stale = (g.pending_count || 0) > 0 && (!g.last_activity || (Date.now() - new Date(g.last_activity).getTime()) > 45 * 60000);
    return el('div', { class: `tb-row ${stale ? 'stale' : ''}` }, [
      el('div', { class: 'tb-head' }, [
        el('span', { class: 'tb-dot', style: `background:${g.color || 'var(--river-500)'}` }),
        el('b', {}, g.group_name),
        el('span', { class: 'tb-meta' }, `완료 ${done}/${total} · 체크인 ${g.checked_in_count || 0}`),
      ]),
      el('div', { class: 'tb-track' }, [el('div', { class: 'tb-fill', style: `width:${pct}%; background:${g.color || 'var(--river-500)'}` })]),
      el('div', { class: 'tb-foot' }, [
        (g.pending_count || 0) > 0 ? el('span', { class: 'tb-pend' }, `승인 대기 ${g.pending_count}`) : el('span', { class: 'tb-clear' }, '대기 없음'),
        el('span', { class: 'tb-act' }, g.last_activity ? `최근 ${fmtAgo(g.last_activity)}` : '활동 없음'),
        stale ? el('span', { class: 'tb-stale' }, '⚠ 정체') : null,
      ]),
    ]);
  }));
}

// R5 #1: 사진 갤러리 — 전 조 제출물(승인·대기 포함, hidden 제외). 실제 이미지=teacher-photo 서명URL(모달). 읽기전용+숨김.
const STAT_LABEL = { pending: '승인 대기', approved: '승인됨', revise: '보완요청', uploaded: '업로드 중' };
function teacherGallery() {
  if (teacherData.loading && !teacherData.gallery) return el('div', { class: 't-skel' }, '불러오는 중…');
  const g = teacherData.gallery || [];
  if (!g.length) return el('div', { class: 't-empty' }, [el('div', { class: 'te-ic' }, '📷'), el('p', {}, '아직 제출된 사진이 없어요.')]);
  return el('div', { class: 't-queue' }, g.map((s) => {
    const where = s.mission_scope === 'course' ? '코스 미션' : Teacher.placeName(s.place_id);
    const n = (s.photo_refs || []).length;
    return el('article', { class: 't-card' }, [
      el('div', { class: 'tc-top' }, [
        el('span', { class: 'tc-grp' }, s.group_name),
        el('span', { class: 'tc-where' }, where),
        el('span', { class: `tc-stat st-${s.status}` }, STAT_LABEL[s.status] || s.status),
        el('span', { class: 'tc-time' }, fmtAgo(s.created_at)),
      ]),
      el('div', { class: 'tc-mission' }, Teacher.missionLabel(s.mission_id)),
      el('button', { class: 'tc-thumbs', onclick: () => { photoModal = { refs: s.photo_refs || [], group: s.group_name, label: where, submissionId: s.submission_id, urls: null, loading: false, error: null }; render(); } },
        [el('span', { class: 'tt-ic' }, '🖼'), `사진 ${n}장 보기`]),
      s.comment ? el('div', { class: 'tc-comment' }, `“${s.comment}”`) : null,
      el('div', { class: 'tc-acts2' }, [   // 읽기전용 + 부적절 콘텐츠 숨김만
        el('button', { class: 'tc-hide', onclick: () => { if (confirm('이 사진을 숨길까요? (갤러리·저널·현황에서 제외)')) teacherAct(() => Teacher.hide(s.submission_id, true)); } }, '숨김'),
      ]),
    ]);
  }));
}

// #2 수정: 교사 모달이 placeholder만 표시하던 버그 → teacher-photo 서명 URL <img> 렌더(저널 패턴 재사용).
async function loadModalPhotos() {
  const m = photoModal; if (!m || !m.submissionId) return;
  m.loading = true;
  try {
    const data = await Supabase.teacherPhotoUrls(Teacher.code, m.submissionId);   // { urls:[{ref,signedUrl,...}] }
    if (photoModal === m) { m.urls = ((data && data.urls) || []).filter((u) => u.signedUrl); m.loading = false; render(); }
  } catch (e) {
    if (photoModal === m) { m.error = String(e.message || e); m.loading = false; render(); }
  }
}
function photoModalEl() {
  const m = photoModal;
  const n = m.refs.length;
  // production: 최초 렌더 시 서명 URL 1회 로드(teacher-photo). 로컬 데모는 placeholder.
  if (!Teacher.localMode() && m.submissionId && m.urls == null && !m.loading && !m.error && n > 0) loadModalPhotos();
  let photosEl;
  if (Teacher.localMode()) {
    photosEl = n ? m.refs.map((_p, i) => el('div', { class: 'pm-ph' }, [el('span', { class: 'pm-ph-ic' }, '🖼'), el('small', {}, `사진 ${i + 1}`)])) : [el('div', { class: 'pm-empty' }, '첨부 사진 없음')];
  } else if (n === 0) {
    photosEl = [el('div', { class: 'pm-empty' }, '첨부 사진 없음')];
  } else if (m.error) {
    photosEl = [el('div', { class: 'pm-empty' }, '사진을 불러오지 못했어요.'), el('button', { class: 'mini', onclick: () => { m.error = null; m.urls = null; render(); } }, '다시 시도')];
  } else if (m.urls == null) {
    photosEl = [el('div', { class: 'pm-empty' }, '사진 불러오는 중…')];
  } else if (m.urls.length === 0) {
    photosEl = [el('div', { class: 'pm-empty' }, '첨부 사진 없음')];
  } else {
    photosEl = m.urls.map((u) => el('div', { class: 'pm-ph loaded' }, [el('img', { src: u.signedUrl, alt: '제출 사진', loading: 'lazy' })]));
  }
  return el('div', { class: 'pm-scrim', onclick: (e) => { if (e.target.classList.contains('pm-scrim')) { photoModal = null; render(); } } }, [
    el('div', { class: 'pm-box' }, [
      el('div', { class: 'pm-head' }, [el('b', {}, `${m.group} · ${m.label}`), el('button', { class: 'pm-x', onclick: () => { photoModal = null; render(); } }, '×')]),
      el('div', { class: 'pm-photos' }, photosEl),
      el('div', { class: 'pm-note' }, Teacher.localMode()
        ? '※ 로컬 데모 — 실제 원본은 비공개 버킷의 만료형 서명 URL로 표시(production).'
        : '비공개 버킷 · 만료형 서명 URL(약 5분). 외부 저장 자제.'),
    ]),
  ]);
}
// ── D3 코스 플래너 — 공통 3 고정 + 선택 17 담기·순서·합산 + 추천 예시 (조별 자율 계획) ──
const ROUTE_ICON = { walk: '🚶 도보', noTransfer: '🚈 무환승', '1transfer': '🔁 1환승', '2transfer': '🔁 2환승' };
const THEME_FILTERS = [['all', '전체'], ['faith', '신앙'], ['history', '역사'], ['neighbor', '이웃'], ['ecology', '생태'], ['fun', '흥미']];

function screenPlanner() {
  const course = Store.course;
  const t = Store.totals();
  const overloaded = t.hub + t.stay > 360;

  // 내 코스(순서 행): 공통필수=잠금, 선택=↑↓·제거
  const rows = course.map(({ placeId }, idx) => {
    const p = Store.place(placeId); const req = Store.isRequired(placeId);
    return el('div', { class: `pl-row ${req ? 'req' : ''}` }, [
      el('span', { class: 'pl-no' }, String(idx + 1)),
      el('div', { class: 'pl-info' }, [
        el('div', { class: 'pl-name' }, [p ? p.name : placeId, req ? el('span', { class: 'lock' }, ' 🔒 공통필수') : null]),
        el('div', { class: 'pl-sub' }, p ? `${ROUTE_ICON[p.planner.routeType] || p.planner.routeType} · 허브 ${p.planner.hubMinutes ?? '-'}분 · 체류 ~${p.planner.stayMinutes ?? '-'}분 · 🏅 ${Store.basePointsOf(placeId)}점` : ''),
      ]),
      el('div', { class: 'pl-ctl' }, [
        el('button', { class: 'mini', disabled: idx === 0 ? '' : null, onclick: () => { Store.move(placeId, -1); render(); } }, '↑'),
        el('button', { class: 'mini', disabled: idx === course.length - 1 ? '' : null, onclick: () => { Store.move(placeId, 1); render(); } }, '↓'),
        req ? el('span', { class: 'mini ghost-lock' }, '고정') : el('button', { class: 'mini del', onclick: () => { Store.removePlace(placeId); render(); } }, '제거'),
      ]),
    ]);
  });

  // 추천 예시 칩 (flow=bookend 흐름 서술 — title 힌트)
  const recs = el('div', { class: 'rec-chips' }, Store.recommendedCourses.map((rc) =>
    el('button', { class: 'rec-chip', title: rc.flow || '', onclick: () => { Store.applyRecommended(rc.id); render(); } }, [el('b', {}, rc.title), el('span', {}, ` +${rc.placeIds.length}곳`)])));

  // 선택 장소 풀(17곳, 테마 필터)
  const pool = Store.selectablePlaces().filter((p) => plannerTheme === 'all' || p.themeTags.includes(plannerTheme));
  const filterBar = el('div', { class: 'filter-bar' }, THEME_FILTERS.map(([k, label]) =>
    el('button', { class: `chip ${plannerTheme === k ? 'on' : ''}`, onclick: () => { plannerTheme = k; render(); } }, label)));
  const poolGrid = el('div', { class: 'pool' }, pool.map((p) => {
    const added = Store.inCourse(p.placeId);
    const ppts = Store.basePointsOf(p.placeId), pn = coveredCount(p.placeId);
    const pgain = ppts / Math.pow(2, pn), pgainStr = Number.isInteger(pgain) ? String(pgain) : pgain.toFixed(1);
    return el('div', { class: `pcard tex-paper organic ${added ? 'added' : ''}` }, [
      el('div', { class: 'pc-name display' }, p.name),
      el('div', { class: 'pc-sub' }, `${ROUTE_ICON[p.planner.routeType] || ''} · 허브 ${p.planner.hubMinutes ?? '-'}분${p.indoorCooled ? ' · 냉방' : ''}`),
      el('div', { class: `pc-pts ${pn === 0 ? 'fresh' : ''}` }, pn === 0 ? `✨ 미개척 · 지금 가면 +${pgainStr}점(만점)` : `🏅 ${pn}개 조 다녀감 · 지금 +${pgainStr}점`),
      el('div', { class: 'pc-tags' }, p.themeTags.map((tg) => el('span', { class: 'chip' }, THEME_LABEL[tg] || tg))),
      added
        ? el('button', { class: 'btn ghost block', onclick: () => { Store.removePlace(p.placeId); render(); } }, '담음 ✓ (빼기)')
        : el('button', { class: 'btn block', onclick: () => { Store.addPlace(p.placeId); render(); } }, '+ 담기'),
    ]);
  }));

  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [
      el('div', { class: 'pl-head' }, [
        el('h1', { class: 'display' }, '코스 플래너'),
        el('p', { class: 'muted' }, '공통 필수 3곳은 고정, 나머지 17곳에서 우리 조가 직접 골라 순서를 정해요. (추천 예시는 참고일 뿐 자유 수정)'),
        el('div', { class: 'hub-note' }, [el('span', { class: 'hub-ic' }, '🚩'), el('span', {}, [el('b', {}, `${HUB.name}`), ` 출발·복귀 · 최근접 ${HUB.nearestStation}`])]),
      ]),
      el('div', { class: 'sum-bar tex-stone organic' }, [
        el('div', {}, [el('b', {}, `총 ${t.count}곳`), ` · 예상 이동 약 ${t.hub}분 · 체류 약 ${t.stay}분`]),
        el('div', { class: 'sum-note' }, overloaded ? '⚠ 이동·체류가 많아요 — 폭염·시간을 고려하세요 (막지 않음)' : '이동·체류 대략값 · 참고용'),
      ]),
      el('h2', { class: 'sec' }, '우리 조 코스'),
      el('div', { class: 'pl-list' }, rows),
      el('h2', { class: 'sec' }, '추천 예시 불러오기'),
      el('p', { class: 'rec-note' }, `흐름 추천 — ${HUB.short} 출발 → 연동교회 묵상 → 테마 코스 → 광장시장 식사 → 허브 복귀 (자율 변경 가능)`),
      recs,
      el('h2', { class: 'sec' }, '선택 장소 담기 (17곳)'),
      filterBar,
      pool.length ? poolGrid : el('p', { class: 'muted pad0' }, '이 테마의 남은 장소가 없어요.'),
      el('button', { class: 'btn block start-btn', onclick: async (e) => {
        const btn = e.currentTarget; btn.disabled = true; const orig = btn.textContent; btn.textContent = '저장 중…';
        try { await Store.saveCourse(); location.hash = '#/'; }       // ★버그#2: 서버 저장 후 이동(재입장 유지)
        catch (err) { toast('코스 저장에 실패했어요. 잠시 후 다시 시도해 주세요.'); btn.disabled = false; btn.textContent = orig; }
      } }, '이 코스로 시작하기'),
    ]),
    tabbar('planner'),
  ]);
}

// ── 화면 ⑤ 조별 저널 — 승인 사진이 채워지는 지면(비대칭 매거진, 페이지마다 리듬 변주) ──
function journalPhotoTiles(sub, variant) {
  // 조 업로드 사진(비공개 버킷). production은 서명 URL(group-photo Edge)로 로더가 채움, 데모/미보유는 브랜디드 타일.
  const n = sub && sub.photoRefs ? sub.photoRefs.length : (variant ? 2 : 1);
  const tiles = [];
  for (let i = 0; i < Math.max(1, n); i++) {
    tiles.push(el('div', { class: 'jp-photo tex-stone' }, [
      el('span', { class: 'jp-cam' }, '🖼'),
      el('span', { class: 'jp-src' }, '조 업로드 사진'),
    ]));
  }
  const attrs = { class: `jp-photos ${variant ? 'grid' : 'full'}` };
  if (sub && sub.remoteId) attrs['data-sub'] = sub.remoteId;   // production 로더 매칭 키
  return el('div', attrs, tiles);
}

// production 저널 사진 로더 — group-photo 서명 URL로 placeholder 타일을 실사진으로 교체. 실패 시 placeholder 유지.
async function loadJournalPhotos() {
  if (Store.localMode() || !Store.groupCode) return;
  let data;
  try { data = await Supabase.groupPhotoUrls(Store.groupCode, { purpose: 'journal' }); }
  catch (e) { console.warn('[journal] 사진 로드 실패(placeholder 유지):', e.message); return; }
  for (const p of (data && data.photos) || []) {
    const box = document.querySelector(`.jp-photos[data-sub="${p.submission_id}"]`);
    if (!box) continue;
    const urls = (p.urls || []).filter((u) => u.signedUrl);
    if (!urls.length) continue;
    box.innerHTML = '';
    urls.forEach((u) => {
      const cell = el('div', { class: 'jp-photo loaded' }, [el('img', { src: u.signedUrl, alt: '조 업로드 사진', loading: 'lazy' })]);
      box.appendChild(cell);
    });
  }
}

function screenJournal() {
  const pages = Store.journal();
  const crossed = Store.crossedCount();

  const cover = el('header', { class: 'jr-cover tex-paper' }, [
    el('div', { class: 'jr-k' }, '조별 탐방 저널'),
    el('h1', { class: 'display' }, Store.group.name),
    el('div', { class: 'jr-sub' }, `${HUB.short}에서 출발한 우리의 하루 · 건넌 징검다리 ${crossed}`),
    el('div', { class: 'jr-rule' }),
  ]);

  let body;
  if (!pages.length) {
    body = el('div', { class: 'jr-empty' }, [
      el('div', { class: 'jr-empty-art tex-paper' }, [el('span', {}, '◌')]),
      el('p', { class: 'display' }, '첫 미션을 인증하면'),
      el('p', { class: 'muted' }, '여기 저널의 첫 장이 채워져요. 장소에 도착해 미션을 인증해 보세요.'),
      el('a', { href: '#/', class: 'btn' }, '홈 징검다리로'),
    ]);
  } else {
    body = el('div', { class: 'jr-pages' }, pages.map((pg, i) => {
      const variant = i % 2 === 1;            // 페이지마다 리듬 변주(풀블리드 ↔ 그리드)
      if (pg.scope === 'course') {
        return el('section', { class: 'jr-page course' }, [
          el('div', { class: 'jr-no' }, `별지`),
          el('h2', { class: 'display' }, '코스 미션'),
          journalPhotoTiles(pg.submission, true),
          el('p', { class: 'jr-cap' }, pg.brief || ''),
          pg.submission && pg.submission.comment ? el('p', { class: 'jr-quote' }, `“${pg.submission.comment}”`) : null,
        ]);
      }
      const rd = pg.reading;
      const q = rd && rd.body ? (rd.body.match(/\*\*질문\.\*\*\s*([^\n]+)/) || [])[1] : null;
      return el('section', { class: `jr-page ${variant ? 'v' : ''}` }, [
        el('a', { href: `#/place/${pg.placeId}`, class: 'jr-no' }, `${String(i + 1).padStart(2, '0')} · ${pg.place ? pg.place.name : pg.placeId}`),
        journalPhotoTiles(pg.submission, variant),
        el('div', { class: 'jr-text' }, [
          el('h2', { class: 'display' }, pg.place ? pg.place.name : pg.placeId),
          pg.submission && pg.submission.comment ? el('p', { class: 'jr-quote' }, `“${pg.submission.comment}”`) : null,
          q ? el('p', { class: 'jr-q' }, [el('span', { class: 'jr-q-k' }, '오늘의 질문 — '), q]) : null,
        ]),
      ]);
    }));
  }

  const exportBar = pages.length ? el('div', { class: 'jr-export' }, [
    el('button', { class: 'btn block', onclick: () => exportJournal() }, '📄 PDF로 저장'),
    el('p', { class: 'jr-export-note' }, '인쇄 창에서 “PDF로 저장(대상: PDF)”을 고르면 파일로 보관·공유할 수 있어요. 다녀온 장소·사진·기록이 담겨요.'),
  ]) : null;

  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [cover, body, exportBar]),
    tabbar('journal'),
  ]);
}

// #1 저널 내보내기 — 클릭 시 **동기적으로** window.print() (사용자 제스처 컨텍스트 유지).
//   ★버그 원인: 이전 async 체인(loadJournalPhotos().then(setTimeout(print))) → print가 제스처 밖에서 호출돼 브라우저가 무시.
//   사진은 저널 진입 시 이미 로드됨(render의 loadJournalPhotos). @media print가 크롬 숨기고 지면만 출력 → 'PDF로 저장'.
function exportJournal() {
  if (typeof window.print === 'function') window.print();
}

// ── 조별 전용 링크 자동 입장 (#/join/<조코드>) — 학생 타이핑 0 ──
async function doJoin(code) {
  joining = { code, status: 'pending', error: null }; render();
  try {
    await Store.joinGroup(code);
    joining = { code, status: 'done', error: null };
    location.hash = '#/';                 // 입장 성공 → 홈
  } catch (e) {
    joining = { code, status: 'error', error: String(e.message || e) };
  }
  render();
}

function screenJoin(code) {
  if (Store.isDemoEnv()) {
    return el('main', { class: 'phone tex-paper col' }, [el('div', { class: 'join-box' }, [
      el('div', { class: 'jn-ic tex-water organic' }, '🔗'),
      el('h1', { class: 'display' }, '조별 링크 입장'),
      el('p', { class: 'muted' }, '이 환경(로컬·오프라인)에서는 데모 모드로 동작해요. 실제 입장은 배포된 조별 링크에서 작동합니다.'),
      el('a', { href: '#/', class: 'btn' }, '데모 홈으로'),
    ])]);
  }
  if (joining.code !== code || joining.status === 'idle') doJoin(code);
  if (joining.status === 'error') {
    return el('main', { class: 'phone tex-paper col' }, [el('div', { class: 'join-box' }, [
      el('div', { class: 'jn-ic tex-water organic err' }, '!'),
      el('h1', { class: 'display' }, '입장할 수 없어요'),
      el('p', { class: 'muted' }, '조별 링크가 올바르지 않거나 만료됐어요. 선생님께 받은 우리 조 링크를 다시 확인해 주세요.'),
      el('button', { class: 'btn', onclick: () => doJoin(code) }, '다시 시도'),
      el('a', { href: '#/', class: 'jn-back' }, '둘러보기(데모)'),
    ])]);
  }
  return el('main', { class: 'phone tex-paper col' }, [el('div', { class: 'join-box' }, [
    el('div', { class: 'jn-ic tex-water organic' }, '⛰'),
    el('h1', { class: 'display' }, '우리 조로 입장 중…'),
    el('p', { class: 'muted' }, '잠시만 기다려 주세요.'),
  ])]);
}

// ── 전체지도 — 전체 장소 마커(허브 포함) 단일 네이버 지도 + 오프라인 장소 리스트 ──
function screenAllMap() {
  const courseIds = new Set(Store.course.map((c) => c.placeId));
  const places = Store.seed.places;

  const mapWrap = el('div', { class: 'amap-wrap' }, [
    el('div', { id: 'all-map', class: 'naver-map' }),
    el('div', { class: 'mapslot map-fallback', id: 'all-map-fallback' }, [
      el('span', { class: 'badge-map' }, '네이버 지도'),
      el('div', { class: 'ph-note' }, '지도를 불러오는 중 · 아래 목록에서 장소를 확인하세요'),
    ]),
  ]);
  pendingAllMap = true;

  const legend = el('div', { class: 'amap-legend' }, [
    el('span', {}, [el('i', { class: 'lg hub' }, '🚩'), '허브']),
    el('span', {}, [el('i', { class: 'lg course', style: `--c:${Store.group.color}` }), '우리 코스']),
    el('span', {}, [el('i', { class: 'lg done' }, '✓'), '완료']),
    el('span', {}, [el('i', { class: 'lg plain' }), '그 외']),
  ]);

  // 오프라인/항상 가용 장소 리스트(코스→그 외 순, 클릭 상세)
  const sorted = [...places].sort((a, b) => (courseIds.has(b.placeId) - courseIds.has(a.placeId)));
  const list = el('div', { class: 'amap-list' }, sorted.map((p) => {
    const inC = courseIds.has(p.placeId); const done = Store.progress(p.placeId).status === 'approved';
    return el('a', { href: `#/place/${p.placeId}`, class: `amap-item ${inC ? 'course' : ''}`, style: inC ? `--c:${Store.group.color}` : '' }, [
      el('span', { class: 'ai-dot' }, done ? '✓' : ''),
      el('span', { class: 'ai-b' }, [el('b', {}, p.name), el('small', {}, p.themeTags.map((t) => THEME_LABEL[t] || t).join(' · '))]),
      inC ? el('span', { class: 'ai-tag' }, '우리 코스') : null,
    ]);
  }));

  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [
      el('div', { class: 'pl-head' }, [
        el('h1', { class: 'display' }, '전체 지도'),
        el('p', { class: 'muted' }, `${HUB.short} 허브와 탐방 장소 ${places.length}곳. 마커를 누르면 장소로 이동해요.`),
      ]),
      el('div', { class: 'amap-card tex-paper organic' }, [mapWrap]),
      legend,
      el('h2', { class: 'sec' }, '장소 목록'),
      list,
    ]),
    tabbar('map'),
  ]);
}

// ── 전체 현황(#/board) — 협동 보드(#3+#4). 캠프 합계 + 장소별 다녀간 조 + 미개척. 경쟁/순위 없음. ──
function screenBoard() {
  const head = el('div', { class: 'pl-head' }, [
    el('h1', { class: 'display' }, '우리 캠프 현황'),
    el('p', { class: 'muted' }, `모든 조의 발자취가 모여 캠프 점수가 돼요. 아직 아무도 안 간 곳을 먼저 찾으면 만점! 함께 ${Store.seed.places.length}곳을 개척해요.`),
  ]);

  if (Store.localMode()) {
    return el('main', { class: 'phone tex-paper col' }, [
      el('div', { class: 'scroll' }, [head,
        el('div', { class: 'board-local tex-stone organic' }, [
          el('div', { class: 'bl-pts' }, [el('b', {}, String(Store.localScore())), ' 점 (우리 조 예상 기여)']),
          el('p', { class: 'muted' }, '지금은 둘러보기(로컬) 모드예요. 선생님께 받은 우리 조 링크로 입장하면 캠프 전체 협동 현황이 표시됩니다.'),
        ]),
      ]),
      tabbar('board'),
    ]);
  }

  const d = campCache.data;
  const body = d ? campBoardBody(d, Store.group.groupId) : el('div', { class: 't-skel' }, '캠프 현황을 불러오는 중…');
  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'scroll' }, [head, el('p', { class: 'board-note muted' }, '약 20초마다 자동 갱신 · 제출 즉시 반영(승인 불요)'), body]),
    tabbar('board'),
  ]);
}

// 협동 보드 본문(학생 #/board + 교사 옵저버 현황 탭 공용). myId=null이면 me 하이라이트 없음.
function campBoardBody(d, myId) {
  const covered = d.places_covered || 0, all = d.places_total || Store.seed.places.length;
  const pct = all ? Math.round((covered / all) * 100) : 0;
  const headline = el('div', { class: 'camp-head tex-stone organic' }, [
    el('div', { class: 'ch-main' }, [el('span', { class: 'ch-pts' }, String(d.total_score || 0)), el('span', { class: 'ch-unit' }, '점')]),
    el('div', { class: 'ch-cov' }, `${all}곳 중 ${covered}곳 개척`),
    el('div', { class: 'ch-track' }, [el('div', { class: 'ch-fill', style: `width:${pct}%` })]),
  ]);
  // 장소별: 다녀간 조 배지(순서) / 미개척 강조 (#3). 미개척을 위로.
  const rows = (d.per_place || []).slice().sort((a, b) => (a.groups.length - b.groups.length) || (b.base_points - a.base_points));
  const placeList = el('div', { class: 'camp-places' }, rows.map((pp) => {
    const fresh = (pp.groups || []).length === 0;
    return el('a', { href: `#/place/${pp.place_id}`, class: `camp-place ${fresh ? 'fresh' : ''}` }, [
      el('div', { class: 'cp-top' }, [
        el('span', { class: 'cp-name' }, pp.name),
        fresh ? el('span', { class: 'cp-fresh' }, `✨ 미개척 +${pp.base_points}`) : el('span', { class: 'cp-pts' }, `🏅 ${pp.base_points}`),
      ]),
      fresh
        ? el('div', { class: 'cp-empty' }, '아직 아무 조도 안 갔어요 — 먼저 가면 만점!')
        : el('div', { class: 'cp-groups' }, (pp.groups || []).map((g) => el('span', {
            class: `cp-gchip ${g.group_id === myId ? 'me' : ''}`, style: `--c:${g.color || 'var(--river-500)'}`,
            title: `${g.group_name} · ${g.rank}번째 · +${g.points}`,
          }, [el('i', { class: 'cp-gdot' }), `${g.group_name}`]))),
    ]);
  }));
  return el('div', {}, [headline, el('h2', { class: 'sec' }, '장소별 발자취 · 미개척 먼저'), placeList]);
}

function stub(title, msg, tab) {
  return el('main', { class: 'phone tex-paper col' }, [
    el('div', { class: 'pad' }, [el('h1', { class: 'display' }, title), el('p', { class: 'muted' }, msg)]),
    el('div', { class: 'grow' }), tabbar(tab),
  ]);
}

function render() {
  const h = location.hash || '#/';
  const root = app(); root.innerHTML = '';
  pendingMap = null; pendingAllMap = false;
  const mPlace = h.match(/^#\/place\/([A-D]\d+)/);
  const mMission = h.match(/^#\/mission\/(m_[A-Za-z0-9_]+)/);
  const mJoin = h.match(/^#\/join\/([A-Za-z0-9]+)/);
  if (!mMission && draft) { draft.previews.forEach((u) => URL.revokeObjectURL(u)); draft = null; }  // 미션 이탈 시 드래프트 정리
  if (mJoin) root.appendChild(screenJoin(mJoin[1]));
  else if (mMission) root.appendChild(screenMission(mMission[1]));
  else if (mPlace) { root.appendChild(screenPlace(mPlace[1])); kickCamp(); }
  else if (h.startsWith('#/teacher')) root.appendChild(screenTeacher());
  else if (h.startsWith('#/map')) root.appendChild(screenAllMap());
  else if (h.startsWith('#/planner')) { root.appendChild(screenPlanner()); kickCamp(); }
  else if (h.startsWith('#/board')) root.appendChild(screenBoard());
  else if (h.startsWith('#/journal')) { root.appendChild(screenJournal()); requestAnimationFrame(() => loadJournalPhotos()); }
  else { root.appendChild(screenHome()); kickCamp(); }
  window.scrollTo(0, 0);
  // 협동 현황 실시간 폴링(20s) — 학생 #/board + 교사 '전체 현황' 탭. 진입 시 즉시 로드 + 인터벌, 이탈 시 정리.
  const campView = () => location.hash.startsWith('#/board') || (location.hash.startsWith('#/teacher') && teacherTab === 'board');
  if (campView()) {
    kickCamp();
    if (!Store.localMode() && !boardTimer) boardTimer = setInterval(() => {
      loadCamp(true).then((u) => { if (u && campView()) render(); });
    }, 20000);
  } else if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
  if (pendingMap) {
    const m = pendingMap;
    requestAnimationFrame(() => {
      const c = document.getElementById('place-map'), fb = document.getElementById('map-fallback');
      if (c) renderMap(c, fb, m.lat, m.lng, m.name).catch((e) => console.warn('[map] fallback:', e.message));
    });
  }
  if (pendingAllMap) {
    requestAnimationFrame(() => {
      const c = document.getElementById('all-map'), fb = document.getElementById('all-map-fallback');
      if (!c) return;
      const courseIds = new Set(Store.course.map((x) => x.placeId));
      const items = Store.seed.places.map((p) => ({
        id: p.placeId, name: p.name, lat: p.naverMap.lat, lng: p.naverMap.lng,
        theme: p.themeTags.map((t) => THEME_LABEL[t] || t).join(' · '),
        inCourse: courseIds.has(p.placeId), done: Store.visited(p.placeId),
      }));
      renderAllMap(c, fb, items, HUB, Store.group.color).catch((e) => console.warn('[allmap] fallback:', e.message));
    });
  }
}

window.addEventListener('hashchange', render);
// 재연결 시 승인/보완 상태 동기화(production). 로컬모드는 no-op.
window.addEventListener('online', () => { Store.refreshStatus().then(() => loadCamp(true)).then(render).catch(() => {}); });
render();
// 초기 동기화: 이미 입장한 production 상태면 서버에서 코스·진행 갱신(새로고침 유지) + 캠프 현황 갱신.
if (!Store.localMode() && !location.hash.startsWith('#/join')) {
  Store.loadRemoteCourse().then(() => Store.refreshStatus()).then(() => loadCamp(true)).then(render).catch(() => {});
}
