#!/usr/bin/env node
// 시드 빌더 — content/* (Phase1 확정본) → ① app/data/seed.js (클라이언트 ES모듈, file:// 호환, 정답 제외)
//                                        ② app/data/seed_data.sql (Supabase SQL Editor용, 정답 포함·서버측)
// 파싱: course_data.md(planner 테이블·recommendedCourses) + missions_final.md(미션/코스미션) + place_data.md(좌표·사진) + readings/*.md(읽을거리)
// 보안: answer(정답)는 seed.js(클라)에 절대 미포함 → seed_data.sql(서버)만. (Supabase mission_public 뷰 원칙 동일)
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, '../..');
const C = (p) => resolve(ROOT, 'content', p);
const REQUIRED = ['B11', 'D5', 'C3'];
const THEME_MAP = { '신앙': 'faith', '이웃': 'neighbor', '역사': 'history', '현대사': 'history', '생태': 'ecology', '흥미': 'fun', '삶': 'fun' };
const upper = (s) => { const n = (String(s).match(/\d+/g) || []).map(Number); return n.length ? Math.max(...n) : null; };

// ── 기본점수(base_points) — 거리=허브 편도 이동시간. 공식: max(10, round(hubMinutes/5)*5) (5단위·최소10). ──
//   ★worker1 확정표(content/base_points_table.md, 2026-06-13 사용자 확정: 양화진50·공통3 유지·공식 그대로) 핀 고정.
//     확정값을 명시 주입 → hubMinutes 우발 변경에도 점수 불변(검토 없이 점수 이동 방지). 공식과 동일값(검증됨).
const BASE_POINTS_OVERRIDE = {
  B11: 10, D5: 10, C3: 20, B6: 15, D3: 10, D4: 15, A5: 10, A7: 25, B1: 25, B2: 25,
  A2: 25, A10: 25, A1: 25, A8: 25, A4: 25, A6: 25, A3: 30, A9: 30, C2: 35, A15: 50,
};
const basePointsFor = (placeId, hubMinutes) =>
  BASE_POINTS_OVERRIDE[placeId] ?? Math.max(10, Math.round((hubMinutes || 0) / 5) * 5);

// ── 1) places (course_data.md 테이블) ──
const courseMd = readFileSync(C('course_data.md'), 'utf8');
const places = [];
for (const line of courseMd.split('\n')) {
  if (!/^\|\s*[A-D]\d+\s*\|/.test(line)) continue;
  const c = line.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 10 || !/^[A-D]\d+$/.test(c[0])) continue;
  const [placeId, name, theme, stay, hub, transfer, routeType, verified, indoor, photoF] = c;
  places.push({
    placeId, name,
    themeTags: [...new Set(theme.split(/[·,]/).map((t) => THEME_MAP[t.trim()]).filter(Boolean))],
    routeCategory: REQUIRED.includes(placeId) ? 'required' : 'select',
    planner: { stayMinutes: upper(stay), hubMinutes: upper(hub), transferCount: Number(transfer) || 0, routeType, verified: verified === 'true' },
    basePoints: basePointsFor(placeId, upper(hub)),   // 점수경쟁제 기본점수(거리 기반)

    indoorRaw: indoor, indoor: /[◎○]|부분/.test(indoor), indoorCooled: indoor.includes('◎'), photoFriendly: /[◎○]/.test(photoF),
    address: null,
    photo: { url: null, source: null, license: null, attribution: null, needsFieldShoot: null, status: null },
    naverMap: { lat: null, lng: null, naverPlaceId: null },
  });
}
const byId = Object.fromEntries(places.map((p) => [p.placeId, p]));

// ── 2) place_data.md 병합 (좌표) + 사진은 photo_manifest_final.md 권위 적용 ──
// ⚠ 저작권 안전 불변원칙(photo_manifest_final §6·§89): confirmed(A5)만 실 url·출처. 나머지 19곳은
//    needsFieldShoot=true·url/출처 null → 앱 공통 placeholder 노출. A1=replace(소녀상 대체). 임의 실사진 등재 금지.
const A5_URL = 'https://www.kogl.or.kr/recommend/recommendView.do?recommendIdx=3120';
const A5_ATTR = "본 저작물은 한국관광공사에서 공공누리 제1유형으로 개방한 '청계광장'을 이용하였으며, 공공누리(www.kogl.or.kr)에서 무료로 다운로드할 수 있습니다.";
for (const line of readFileSync(C('place_data.md'), 'utf8').split('\n')) {
  if (!/^\|\s*[A-D]\d+\s*\|/.test(line)) continue;
  const c = line.split('|').slice(1, -1).map((x) => x.trim());
  if (c.length < 8 || !/^-?\d/.test(c[2])) continue;
  const [placeId, , lat, lng] = c;
  const p = byId[placeId]; if (!p) continue;
  p.naverMap.lat = Number(lat); p.naverMap.lng = Number(lng);   // 좌표는 유지
  // 사진: 매니페스트 최종본 권위 — place_data.md의 구 status/license는 무시(원격 미확정 conditional 강등 반영)
  if (placeId === 'A5') {
    p.photo = { url: A5_URL, source: '한국관광공사(공공누리 포털)', license: '공공누리 제1유형', attribution: A5_ATTR, needsFieldShoot: false, status: 'confirmed' };
  } else {
    p.photo = { url: null, source: null, license: null, attribution: null, needsFieldShoot: true, status: placeId === 'A1' ? 'replace' : 'placeholder' };
  }
}

// ── 3) missions + courseMissions (missions_final.md) — answer 내부 보관 ──
const parseVal = (v) => { v = v.trim(); if (v === 'null') return null; if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((x) => x.trim()).filter(Boolean); return v.replace(/^"|"$/g, ''); };
const misMd = readFileSync(C('missions_final.md'), 'utf8').split('\n');
const missionsFull = [], courseMissionsFull = [];
// 경량화(worker1 2026-06-12): '## 활성 미션' 섹션=active, '## 예비 미션' 섹션=비활성(행 유지·삭제 금지).
let activeSection = true;
for (let i = 0; i < misMd.length; i++) {
  if (/^##\s*활성\s*미션/.test(misMd[i])) { activeSection = true; continue; }
  if (/^##\s*예비\s*미션/.test(misMd[i])) { activeSection = false; continue; }
  const m = misMd[i].match(/^- \*\*(m_[A-Za-z0-9_]+)\*\* — (.+)$/); if (!m) continue;
  // 두 형식 지원: 활성=key:value 파이프 / 예비=<type>|[ev] | key:value — <인라인 brief>
  let spec = m[2], inlineBrief = null;
  const di = spec.indexOf(' — ');                       // 활성 m[2]엔 내부 em-dash 없음(검증). 예비는 brief 구분자.
  if (di > -1) { inlineBrief = spec.slice(di + 3).trim(); spec = spec.slice(0, di); }
  const MTYPES = ['observe_quiz', 'photo_reenact', 'interview_experience', 'reflect_share'];
  const f = {};
  for (let part of spec.split('|')) {
    part = part.trim(); if (!part) continue;
    const k = part.indexOf(':');
    if (k > 0 && /^[A-Za-z]+$/.test(part.slice(0, k).trim())) f[part.slice(0, k).trim()] = parseVal(part.slice(k + 1));
    else if (MTYPES.includes(part)) f.type = part;                       // 예비: 베어 type 토큰
    else if (part.startsWith('[') && part.endsWith(']')) f.evidenceTypes = parseVal(part); // 예비: 베어 [ev]
  }
  const brief = inlineBrief || ((misMd[i + 1] && misMd[i + 1].match(/^\s+- (.+)$/)) ? RegExp.$1.trim() : null);
  const rec = { missionId: m[1], type: f.type ?? null, evidenceTypes: Array.isArray(f.evidenceTypes) ? f.evidenceTypes : [], requiresReservation: f.requiresReservation === 'true', outdoor: f.outdoor === 'true', fallbackMission: f.fallbackMission ?? f.fallback ?? null, answer: f.answer ?? null, active: activeSection, brief };
  if (m[1].startsWith('m_ALL')) courseMissionsFull.push({ ...rec, scope: 'course', placeId: null });
  else { rec.placeId = m[1].replace(/^m_/, '').replace(/_\d+$/, ''); missionsFull.push(rec); }
}
// 가드: type은 DB NOT NULL — 누락 시 즉시 실패(서버 INSERT 23502 사전 차단)
const _nullType = [...missionsFull, ...courseMissionsFull].filter((x) => !x.type);
if (_nullType.length) { console.error('BUILD 실패: type 누락 미션 →', _nullType.map((x) => x.missionId).join(',')); process.exit(1); }

// ── 4) courses + recommendedCourses ──
const courses = [{ courseId: 'common', type: 'common', placeIds: [...REQUIRED] }];
const recommendedCourses = [];
for (const line of courseMd.split('\n')) {
  const m = line.match(/\{\s*id:"([^"]+)",\s*title:"([^"]+)",\s*placeIds:\[([^\]]*)\](?:,\s*dir:"([^"]*)")?(?:,\s*est:"([^"]*)")?(?:,\s*flow:"([^"]*)")?/);
  if (!m) continue;
  const placeIds = m[3].split(',').map((s) => s.replace(/["\s]/g, '')).filter(Boolean);
  recommendedCourses.push({ id: m[1], title: m[2], placeIds, dir: m[4] || null, est: m[5] || null, flow: m[6] || null });
  courses.push({ courseId: m[1], type: 'recommended', placeIds });
}

// ── 5) readings (readings/*.md frontmatter + body) ──
const readings = [];
const RDIR = resolve(ROOT, 'content/readings');
for (const fn of readdirSync(RDIR).filter((f) => f.endsWith('.md')).sort()) {
  const raw = readFileSync(resolve(RDIR, fn), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/); if (!m) continue;
  const fm = m[1], body = m[2].trim();
  const g = (k) => { const mm = fm.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return mm ? mm[1].trim().replace(/^"|"$/g, '') : null; };
  const served = (g('servedPlaceIds') || '').replace(/[\[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const srcRefs = (fm.match(/^sourceRef:\n((?:\s+- .+\n?)*)/m)?.[1] || '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  readings.push({ readingId: g('readingId'), servedPlaceIds: served, theme: g('theme'), wordTarget: upper(g('wordTarget')), operationalNote: g('operationalNote'), title: g('title'), sourceRefs: srcRefs, body });
}

// ════════ write seed.js (클라이언트 — 정답 제외 + 활성만) ════════
// 경량화: 클라 번들엔 활성 미션만(예비 미노출). 서버 seed_data.sql엔 전체(active 컬럼)로 행 보존.
const clientMissions = missionsFull.filter((m) => m.active).map(({ answer, active, ...m }) => ({ ...m, hasAnswer: !!answer }));
const clientCourseMissions = courseMissionsFull.filter((m) => m.active).map(({ answer, active, ...m }) => ({ ...m, hasAnswer: !!answer }));
const clientReadings = readings.map(({ sourceRefs, operationalNote, wordTarget, ...r }) => r); // 본문·제목·테마·servedPlaceIds (오프라인 표시용)
const seed = {
  meta: { generatedAt: new Date().toISOString().slice(0, 10), source: 'content/*', note: 'answer 제외(클라). 운영정보 일부 후속 보강' },
  places, missions: clientMissions, courseMissions: clientCourseMissions, courses, recommendedCourses, readings: clientReadings,
};
const outJs = resolve(ROOT, 'app/data/seed.js');
mkdirSync(dirname(outJs), { recursive: true });
writeFileSync(outJs, '// AUTO-GENERATED by app/scripts/build_seed.mjs — 직접 수정 금지\nexport default ' + JSON.stringify(seed, null, 2) + ';\n');

// ════════ write seed_data.sql (Supabase SQL Editor — 정답 포함) ════════
const s = (v) => v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
const arr = (a, cast) => a && a.length ? `ARRAY[${a.map(s).join(',')}]${cast ? '::' + cast : ''}` : (cast ? `ARRAY[]::${cast}` : `ARRAY[]`);
const b = (v) => v ? 'true' : 'false';
const n = (v) => v == null ? 'null' : v;
let sql = `-- AUTO-GENERATED by app/scripts/build_seed.mjs — Supabase SQL Editor에서 Run (service key 불요)\n-- 정답(answer) 포함: 서버측 mission/course_mission 테이블. anon은 mission_public 뷰로만 조회(answer 숨김).\n-- 멱등: 재실행 시 on conflict do update.\nbegin;\n\n`;
sql += `insert into place (place_id,name,theme_tags,route_category,stay_minutes,hub_minutes,transfer_count,route_type,verified,indoor,photo_friendly,photo_url,photo_source,photo_license,photo_attribution,needs_field_shoot,lat,lng,base_points) values\n`;
sql += places.map((p) => `(${s(p.placeId)},${s(p.name)},${arr(p.themeTags, 'theme_tag[]')},${s(p.routeCategory)},${n(p.planner.stayMinutes)},${n(p.planner.hubMinutes)},${n(p.planner.transferCount)},${s(p.planner.routeType)},${b(p.planner.verified)},${b(p.indoor)},${b(p.photoFriendly)},${s(p.photo.url)},${s(p.photo.source)},${s(p.photo.license)},${s(p.photo.attribution)},${b(p.photo.needsFieldShoot)},${n(p.naverMap.lat)},${n(p.naverMap.lng)},${n(p.basePoints)})`).join(',\n');
sql += `\non conflict (place_id) do update set name=excluded.name,theme_tags=excluded.theme_tags,route_category=excluded.route_category,stay_minutes=excluded.stay_minutes,hub_minutes=excluded.hub_minutes,transfer_count=excluded.transfer_count,route_type=excluded.route_type,verified=excluded.verified,indoor=excluded.indoor,photo_friendly=excluded.photo_friendly,photo_url=excluded.photo_url,photo_source=excluded.photo_source,photo_license=excluded.photo_license,photo_attribution=excluded.photo_attribution,needs_field_shoot=excluded.needs_field_shoot,lat=excluded.lat,lng=excluded.lng,base_points=excluded.base_points;\n\n`;

sql += `insert into course (course_id,type,place_ids) values\n`;
sql += courses.map((c) => `(${s(c.courseId)},${s(c.type)},${arr(c.placeIds)})`).join(',\n');
sql += `\non conflict (course_id) do update set type=excluded.type,place_ids=excluded.place_ids;\n\n`;

sql += `insert into mission (mission_id,place_id,type,evidence_types,requires_reservation,outdoor,fallback_mission,answer,active) values\n`;
sql += missionsFull.map((m) => `(${s(m.missionId)},${s(m.placeId)},${s(m.type)},${arr(m.evidenceTypes, 'evidence_type[]')},${b(m.requiresReservation)},${b(m.outdoor)},${s(m.fallbackMission)},${s(m.answer)},${b(m.active)})`).join(',\n');
sql += `\non conflict (mission_id) do update set place_id=excluded.place_id,type=excluded.type,evidence_types=excluded.evidence_types,requires_reservation=excluded.requires_reservation,outdoor=excluded.outdoor,fallback_mission=excluded.fallback_mission,answer=excluded.answer,active=excluded.active;\n\n`;

sql += `insert into course_mission (mission_id,scope,type,evidence_types,requires_reservation,outdoor,fallback_mission,answer,active) values\n`;
sql += courseMissionsFull.map((m) => `(${s(m.missionId)},'course',${s(m.type)},${arr(m.evidenceTypes, 'evidence_type[]')},${b(m.requiresReservation)},${b(m.outdoor)},${s(m.fallbackMission)},${s(m.answer)},${b(m.active)})`).join(',\n');
sql += `\non conflict (mission_id) do update set type=excluded.type,evidence_types=excluded.evidence_types,requires_reservation=excluded.requires_reservation,outdoor=excluded.outdoor,fallback_mission=excluded.fallback_mission,answer=excluded.answer,active=excluded.active;\n\n`;

sql += `insert into reading (reading_id,served_place_ids,theme,word_target,operational_note,source_ref) values\n`;
sql += readings.map((r) => `(${s(r.readingId)},${arr(r.servedPlaceIds)},${s(r.theme)},${n(r.wordTarget)},${s(r.operationalNote)},${s(r.sourceRefs.join(' ; '))})`).join(',\n');
sql += `\non conflict (reading_id) do update set served_place_ids=excluded.served_place_ids,theme=excluded.theme,word_target=excluded.word_target,operational_note=excluded.operational_note,source_ref=excluded.source_ref;\n\n`;
sql += `commit;\n`;
writeFileSync(resolve(ROOT, 'app/data/seed_data.sql'), sql);

console.log(`seed.js: places=${places.length} missions=${clientMissions.length} courseMissions=${clientCourseMissions.length} courses=${courses.length} recommended=${recommendedCourses.length} readings=${clientReadings.length}`);
console.log(`seed_data.sql: place/course/mission/course_mission/reading INSERT 생성 (정답 포함). 좌표누락 ${places.filter((p) => p.naverMap.lat == null).length} / 사진url ${places.filter((p) => p.photo.url).length}`);
console.log(`reading 매핑: ${readings.filter((r) => !r.servedPlaceIds.length).length ? 'servedPlaceIds 없는 읽을거리 있음' : '전 읽을거리 servedPlaceIds 보유'}`);
