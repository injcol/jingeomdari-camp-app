// 조 상태/진행 스토어 — D1은 localStorage(로컬). D4~5에 Supabase(submission/progress/realtime)로 교체.
// 데이터 계약: APP_SPEC §8 런타임 테이블(group_course/_place, progress, submission)과 동형으로 설계.
// ★Supabase 읽기 규칙(D4): 콘텐츠는 place/course/reading(public read), 미션은 반드시
//   mission_public / course_mission_public 뷰로만 조회(answer 숨김). 학생 클라이언트는 mission/course_mission 테이블 직접 조회 금지.
//   프로젝트: fcjfmpmjkhdonaoriaxk.supabase.co (master 계정 세션 생성).
import seed from '../data/seed.js';
import { resizeImage } from './util.js';
import * as Supabase from './supabase.js';

const KEY = 'jgd.state.v1';
const REQUIRED = seed.courses.find((c) => c.type === 'common')?.placeIds ?? ['B11', 'D5', 'C3'];

function demoState() {
  // 시연용 조(3조) + 공통필수 코스. 실제 조 입장/코스플래너는 D2~D3.
  return {
    group: { groupId: 'demo-3', name: '3조', color: '#1f6f74' },
    groupCode: null,                  // 실제 RPC용 조 코드(입장 시 설정). null=로컬 데모.
    // group_course_place: placeId + sortOrder
    course: [...REQUIRED, 'A8'].map((placeId, i) => ({ placeId, sortOrder: i })),
    // progress: placeId -> { checkedIn, status: none|pending|approved }
    progress: {
      D5: { checkedIn: true, status: 'approved' },
      B11: { checkedIn: true, status: 'approved' },
      C3: { checkedIn: true, status: 'pending' },
    },
    // submission(미션 인증) 상태머신: missionId -> { status, scope, placeId, photoRefs[], comment, teacherNote, remoteId, createdAt }
    //   status: idle → uploading → pending → approved | revise (+ queued: 오프라인 보류)
    submissions: {},
  };
}

let state = normalize(load());
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return demoState();
}
function normalize(s) {                 // 구버전 영속 상태에 신규 필드 보강
  if (!s.submissions) s.submissions = {};
  if (!('groupCode' in s)) s.groupCode = null;
  return s;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

// production 모드 = https + Supabase 설정 + 조 코드 입장. file://·미입장이면 로컬 데모(네트워크 0).
function isLocalMode() {
  return (typeof location !== 'undefined' && location.protocol === 'file:') || !Supabase.configured() || !state.groupCode;
}

export const Store = {
  seed,
  get group() { return state.group; },
  get course() { return [...state.course].sort((a, b) => a.sortOrder - b.sortOrder); },
  place(id) { return seed.places.find((p) => p.placeId === id) || null; },
  missionsOf(id) { return seed.missions.filter((m) => m.placeId === id); },
  readingFor(id) { return (seed.readings || []).find((r) => (r.servedPlaceIds || []).includes(id)) || null; },
  progress(id) { return state.progress[id] || { checkedIn: false, status: 'none' }; },
  isRequired(id) { return REQUIRED.includes(id); },
  // 진행 카운트(점수 아님 — 시각 표시용)
  crossedCount() { return Object.values(state.progress).filter((p) => p.status === 'approved').length; },
  nextPlace() {
    for (const { placeId } of this.course) {
      const pr = state.progress[placeId];
      if (!pr || pr.status !== 'approved') return placeId;
    }
    return null;
  },
  toggleCheckIn(id) {
    const pr = state.progress[id] || { checkedIn: false, status: 'none' };
    pr.checkedIn = !pr.checkedIn;
    state.progress[id] = pr; save();
  },

  // ── 미션 인증 상태머신 (D4 유닛4) — uploaded→pending→approved/revise ──
  get groupCode() { return state.groupCode; },
  setGroupCode(code) { state.groupCode = code || null; save(); },
  isLocalMode,
  localMode() { return isLocalMode(); },
  // 미션 메타: 콘텐츠는 오프라인 seed 사용(클라엔 정답 없음). production 보강 시에도 *_public 뷰만(supabase.js가 강제).
  missionMeta(missionId) {
    const m = (seed.missions || []).find((x) => x.missionId === missionId);
    if (m) return { ...m, scope: 'place' };
    const cm = (seed.courseMissions || []).find((x) => x.missionId === missionId);
    if (cm) return { ...cm, scope: 'course', placeId: null };
    return null;
  },
  courseMissions() { return seed.courseMissions || []; },
  submission(missionId) { return state.submissions[missionId] || { status: 'idle', photoRefs: [] }; },

  // 제출: 사진 리사이즈 → (production) Storage 업로드 + submit_mission RPC / (로컬) 네트워크 0 모킹.
  // hooks: onPhase(phase), onProgress(0..1). 반환: { status } 또는 throw.
  async submitMission(missionId, { files = [], comment = '', onPhase, onProgress } = {}) {
    const meta = this.missionMeta(missionId);
    if (!meta) throw new Error('unknown_mission');
    const scope = meta.scope, placeId = meta.placeId || null;
    const sub = { status: 'uploading', scope, placeId, photoRefs: [], comment, teacherNote: null, remoteId: null, createdAt: new Date().toISOString() };
    state.submissions[missionId] = sub; save();
    onPhase && onPhase('uploading');     // ①올림

    // 리사이즈/압축(공통)
    const blobs = [];
    for (const f of files) blobs.push(await resizeImage(f));

    if (isLocalMode()) {
      // 로컬 데모: 네트워크 0. 진행률 모사 후 pending. (라이브 쓰기는 master 사전보고 후 production에서만)
      for (let i = 0; i < blobs.length; i++) { onProgress && onProgress((i + 1) / Math.max(1, blobs.length)); sub.photoRefs.push(`local/${missionId}/${i}`); }
      sub.status = 'pending';
      if (scope === 'place' && placeId) this._markProgress(placeId, 'pending');
      save(); onPhase && onPhase('pending');
      return { status: 'pending', local: true };
    }

    // production: 2단계 보안 흐름 (storage v1.1) — request_upload(서버 발급 경로) → Storage 업로드 → finalize(소유권 검증)
    try {
      const { submissionId, groupId } = await Supabase.requestUpload(state.groupCode, missionId, scope);
      sub.remoteId = submissionId;
      const total = blobs.length || 1;
      for (let i = 0; i < blobs.length; i++) {
        const path = Supabase.photoPath(groupId, submissionId);   // {group_id}/{submission_id}/{난수}.jpg
        await Supabase.uploadPhoto(path, blobs[i], (p) => onProgress && onProgress((i + p) / total));
        sub.photoRefs.push(path);
      }
      await Supabase.finalizeSubmission(state.groupCode, submissionId, sub.photoRefs, comment);
      sub.status = 'pending';
      if (scope === 'place' && placeId) this._markProgress(placeId, 'pending');
      save(); onPhase && onPhase('pending');
      return { status: 'pending' };
    } catch (e) {
      // 오프라인/실패 → 보류 큐(연결 시 자동 전송). 사진은 재선택 필요(blob 미영속) → 큐에는 코멘트만.
      sub.status = 'queued'; sub.error = String(e.message || e);
      save(); onPhase && onPhase('queued');
      throw e;
    }
  },
  _markProgress(placeId, status) {
    const pr = state.progress[placeId] || { checkedIn: false, status: 'none' };
    if (!(pr.status === 'approved' && status !== 'approved')) pr.status = status;  // 승인은 강등 안 함
    state.progress[placeId] = pr; save();
  },

  // production 상태 동기화: get_my_status RPC → 승인/보완 반영(+승인 시 장소 점등). 로컬모드는 no-op.
  async refreshStatus() {
    if (isLocalMode()) return;
    const rows = await Supabase.rpc('get_my_status', { p_code: state.groupCode });
    for (const r of rows || []) {
      const cur = state.submissions[r.mission_id];
      if (!cur) continue;
      cur.status = r.status; cur.teacherNote = r.teacher_note || null; cur.remoteId = r.submission_id;
      if (r.status === 'approved' && cur.scope === 'place' && cur.placeId) this._markProgress(cur.placeId, 'approved');
    }
    save();
  },

  // (데모 전용) 교사 승인/보완 미리보기 — 로컬모드에서만 UI 상태 확인용. production은 교사 화면(D5)/RPC가 처리.
  demoReview(missionId, status, note) {
    if (!isLocalMode()) return;
    const sub = state.submissions[missionId]; if (!sub) return;
    sub.status = status; sub.teacherNote = note || null;
    if (status === 'approved' && sub.scope === 'place' && sub.placeId) this._markProgress(sub.placeId, 'approved');
    save();
  },

  // ── 코스 플래너 (D3) — group_course_place 동형. 공통필수 3곳 자동포함·삭제불가·정렬만 ──
  get requiredIds() { return [...REQUIRED]; },
  get recommendedCourses() { return seed.recommendedCourses || []; },
  inCourse(id) { return state.course.some((c) => c.placeId === id); },
  selectablePlaces() { return seed.places.filter((p) => !REQUIRED.includes(p.placeId)); }, // 17곳
  addPlace(id) {
    if (this.inCourse(id) || !this.place(id)) return;
    const max = state.course.reduce((m, c) => Math.max(m, c.sortOrder), -1);
    state.course.push({ placeId: id, sortOrder: max + 1 }); save();
  },
  removePlace(id) {
    if (REQUIRED.includes(id)) return;                 // 공통필수 삭제 불가
    state.course = state.course.filter((c) => c.placeId !== id);
    state.course.sort((a, b) => a.sortOrder - b.sortOrder).forEach((c, i) => { c.sortOrder = i; });
    save();
  },
  move(id, dir) {                                       // dir: -1 위 / +1 아래
    const arr = [...state.course].sort((a, b) => a.sortOrder - b.sortOrder);
    const i = arr.findIndex((c) => c.placeId === id), j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) return;
    [arr[i].sortOrder, arr[j].sortOrder] = [arr[j].sortOrder, arr[i].sortOrder];
    save();
  },
  applyRecommended(rcId) {
    const rc = seed.recommendedCourses.find((r) => r.id === rcId);
    if (rc) rc.placeIds.forEach((pid) => this.addPlace(pid));
  },
  totals() {
    const ids = this.course.map((c) => c.placeId);
    let hub = 0, stay = 0;
    for (const id of ids) {
      const p = this.place(id); if (!p) continue;
      if (p.planner.hubMinutes) hub += p.planner.hubMinutes;
      if (p.planner.stayMinutes) stay += p.planner.stayMinutes;
    }
    return { count: ids.length, hub, stay };
  },
};
