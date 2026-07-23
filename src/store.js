// 조 상태/진행 스토어 — D1은 localStorage(로컬). D4~5에 Supabase(submission/progress/realtime)로 교체.
// 데이터 계약: APP_SPEC §8 런타임 테이블(group_course/_place, progress, submission)과 동형으로 설계.
// ★Supabase 읽기 규칙(D4): 콘텐츠는 place/course/reading(public read), 미션은 반드시
//   mission_public / course_mission_public 뷰로만 조회(answer 숨김). 학생 클라이언트는 mission/course_mission 테이블 직접 조회 금지.
//   프로젝트: fcjfmpmjkhdonaoriaxk.supabase.co (master 계정 세션 생성).
import seed from '../data/seed.js';
import { resizeImage, blobToBase64 } from './util.js';
import * as Supabase from './supabase.js';

const KEY = 'jgd.state.v1';
const REQUIRED = seed.courses.find((c) => c.type === 'common')?.placeIds ?? ['B11', 'D5', 'C3'];

function freshState() {
  // 빈 진행 상태 — 프로덕션 신규/미입장 초기값. ★버그#1: 가짜 '완료' 더미 없음(서버 권위로만 점등).
  return {
    group: { groupId: 'demo-3', name: '3조', color: '#1f6f74' },
    groupCode: null,                  // 실제 RPC용 조 코드(입장 시 설정). null=로컬 데모.
    // group_course_place: placeId + sortOrder
    course: [...REQUIRED, 'A8'].map((placeId, i) => ({ placeId, sortOrder: i })),
    // progress: placeId -> { checkedIn, status: none|pending|approved }
    progress: {},
    // submission(미션 인증) 상태머신: missionId -> { status, scope, placeId, photoRefs[], comment, teacherNote, remoteId, createdAt }
    //   status: idle → uploading → pending → approved | revise (+ queued: 오프라인 보류)
    submissions: {},
  };
}
function demoState() {
  // 데모환경(file:// 또는 Supabase 미설정) 전용 — 상태머신·돌물 시각화 미리보기용 더미 진행.
  const s = freshState();
  s.progress = {
    D5: { checkedIn: true, status: 'approved' },
    B11: { checkedIn: true, status: 'approved' },
    C3: { checkedIn: true, status: 'pending' },
  };
  // 데모 제출물(저널·상태머신 미리보기용). 저널=제출분(승인불요)이므로 pending도 게재.
  const now = new Date().toISOString();
  s.submissions = {
    m_B11_1: { status: 'approved', scope: 'place', placeId: 'B11', photoRefs: ['local/m_B11_1/0'], comment: '머릿돌의 연도를 찾았어요', teacherNote: null, remoteId: null, createdAt: now },
    m_C3_1: { status: 'pending', scope: 'place', placeId: 'C3', photoRefs: ['local/m_C3_1/0'], comment: '', teacherNote: null, remoteId: null, createdAt: now },
  };
  return s;
}

let state = normalize(load());
let gen = 0;   // ★조 세대(입장/전환마다 증가) — 느린 이전 조 응답이 새 조 상태에 적용되는 것 방지(세대가드)
function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw);
      // ★손상/형식이상 방어: 필드별 엄격 타입 검사 통과분만 채택(비객체·문자열·배열 등 비정상은 초기상태로 폴백)
      const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
      if (isObj(v) && isObj(v.group) && Array.isArray(v.course) && isObj(v.progress)
          && (v.submissions == null || isObj(v.submissions))) return v;
    }
  } catch {}
  // 저장상태 없음 → 데모환경만 더미 진행, 프로덕션은 빈 progress(버그#1: 입장 전 가짜 완료 차단).
  return isDemoEnv() ? demoState() : freshState();
}
function normalize(s) {                 // 구버전 영속 상태에 신규 필드 보강
  if (!s.submissions) s.submissions = {};
  if (!('groupCode' in s)) s.groupCode = null;
  return s;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

// 데모 환경 = file:// 또는 Supabase 미설정 → 항상 로컬 데모(네트워크 0).
function isDemoEnv() {
  return (typeof location !== 'undefined' && location.protocol === 'file:') || !Supabase.configured();
}
// production 모드 = 데모환경 아님 + 조 코드 입장. (미입장이면 쓰기는 로컬 모킹)
function isLocalMode() {
  return isDemoEnv() || !state.groupCode;
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
  // 협동 전환(R2): '다녀옴/완료' = 제출 즉시(pending) 또는 승인(approved). 교사 승인 불요.
  visited(id) { return (state.progress[id] || {}).status === 'approved'; },   // R3 #2: 미션 인정=교사 승인('approved')만(R2 pending 포함 되돌림)
  // 진행 카운트(점수 아님 — 시각 표시용). 제출=다녀옴.
  crossedCount() { return Object.values(state.progress).filter((p) => p.status === 'approved').length; },
  nextPlace() {
    for (const { placeId } of this.course) {
      if (!this.visited(placeId)) return placeId;
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
  isDemoEnv,
  // production 환경인데 아직 미입장 → 홈에 '조별 링크로 입장' 안내(강제 게이트 아님)
  showJoinHint() { return !isDemoEnv() && !state.groupCode; },

  // ── 조별 전용 링크 자동 입장 (#/join/<조코드>) — 학생 타이핑 0 ──
  async joinGroup(code) {
    const myGen = ++gen;            // ★이 입장의 세대
    const rows = await Supabase.rpc('join_group', { p_code: code });
    if (myGen !== gen) return null; // 그 사이 다른 입장 발생 → 폐기(stale)
    const g = Array.isArray(rows) ? rows[0] : rows;
    if (!g || !g.group_id) throw new Error('invalid_group_code');
    state.group = { groupId: g.group_id, name: g.name, color: g.color || '#1f6f74' };
    state.groupCode = code;
    state.progress = {};            // ★버그#1: 입장/재입장 시 더미·타조 잔재 0. 서버 권위로만 재구성.
    state.submissions = {};
    state.course = [...REQUIRED, 'A8'].map((placeId, i) => ({ placeId, sortOrder: i }));  // ★조 전환 코스 오염 방지: 기본코스로 리셋(서버 코스 있으면 loadRemoteCourse가 덮어씀)
    save();
    try { await this.loadRemoteCourse(myGen); } catch {}
    try { await this.refreshStatus(myGen); } catch {}
    return g;
  },
  async loadRemoteCourse(g) {
    const myGen = (g != null) ? g : gen;
    const rows = await Supabase.rpc('get_my_course', { p_code: state.groupCode });
    if (myGen !== gen) return;      // ★세대 바뀜(조 전환) → 폐기
    if (Array.isArray(rows) && rows.length) {
      state.course = rows.map((r) => ({ placeId: r.place_id, sortOrder: r.sort_order })); save();
    }
  },
  // ★버그#2: 코스 서버 저장(전체 교체). 기존 set_my_course RPC 재사용(공통필수3 강제·place검증·anon grant).
  //   localMode면 no-op(이미 localStorage 영속) → 재입장 시 loadRemoteCourse가 빈/기본코스로 덮어쓰는 초기화 방지.
  async saveCourse() {
    if (isLocalMode()) return { local: true };
    const ordered = this.course.map((c) => c.placeId);   // sort_order 순서 → 배열 인덱스=sort_order
    await Supabase.rpc('set_my_course', { p_code: state.groupCode, p_place_ids: ordered });
    return { saved: true };
  },
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
  async submitMission(missionId, { files = [], comment = '', onPhase, onProgress, signal } = {}) {
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

    // production (Plan B): service role Edge Function 'upload-photo' 1회 호출로 일괄 처리
    //   (anon 직접 Storage POST는 정책 깨짐·소유권상 수정불가로 403 → Edge가 request_upload→storage→finalize 우회).
    try {
      const photos = [];
      for (let i = 0; i < blobs.length; i++) {
        photos.push({ content_base64: await blobToBase64(blobs[i]), content_type: blobs[i].type || 'image/jpeg' });
        onProgress && onProgress(((i + 1) / Math.max(1, blobs.length)) * 0.5);   // 인코딩 0→50%
      }
      const res = await Supabase.uploadViaEdge(state.groupCode, missionId, scope, comment, photos, signal);
      onProgress && onProgress(1);                                                // 업로드 완료 100%
      sub.remoteId = res.submission_id;
      sub.photoRefs = Array.isArray(res.photo_refs) ? res.photo_refs : [];
      sub.status = 'pending';
      if (scope === 'place' && placeId) this._markProgress(placeId, 'pending');
      save(); onPhase && onPhase('pending');
      return { status: 'pending' };
    } catch (e) {
      const msg = String(e.message || e);
      // ★사용자 취소(abort) → idle 복귀(서버 제출 미생성 취급, 중복 방지). 큐잉·거부 아님.
      if ((signal && signal.aborted) || (e && e.name === 'AbortError')) {
        sub.status = 'idle'; save();
        const err = new Error('aborted'); err.aborted = true; throw err;
      }
      // 서버가 응답한 거부(HTTP 4xx: 코스 미포함·미등록 미션 등)는 '오프라인 보류'가 아님 →
      // 큐에 넣지 않고 사유를 표면화, 업로드 화면 유지(재시도 가능). 진짜 네트워크 실패만 queued.
      const httpm = msg.match(/upload-photo\s+(\d{3}):\s*([\s\S]*)$/);
      if (httpm) {
        const st = Number(httpm[1]);
        // ★5xx(일시 서버오류)는 거부가 아니라 재시도 보류 → 큐잉. 4xx만 진짜 거부.
        if (st >= 500) {
          sub.status = 'queued'; sub.error = `server_${httpm[1]}`;
          save(); onPhase && onPhase('queued'); throw e;
        }
        let code = '';
        try { code = (JSON.parse(httpm[2]) || {}).error || ''; } catch {}
        sub.status = 'idle'; sub.error = code || `server_${httpm[1]}`;
        save();
        const err = new Error(sub.error); err.serverReject = true; err.reason = sub.error; throw err;
      }
      // 오프라인/네트워크 실패 → 보류 큐(연결 시 재선택 후 재전송). 사진 blob 미영속 → 큐엔 코멘트만.
      sub.status = 'queued'; sub.error = msg;
      save(); onPhase && onPhase('queued');
      throw e;
    }
  },
  _markProgress(placeId, status) {
    const pr = state.progress[placeId] || { checkedIn: false, status: 'none' };
    if (!(pr.status === 'approved' && status !== 'approved')) pr.status = status;  // 낙관적 표시: 승인은 강등 안 함(refreshStatus가 서버권위로 정정)
    state.progress[placeId] = pr; save();
  },
  // ★장소 진행상태를 그 장소 제출들로부터 재계산(승인취소·부분취소 정합). 승인>대기>없음. checkedIn은 보존.
  _recomputePlace(placeId) {
    const subs = Object.values(state.submissions).filter((s) => s.scope === 'place' && s.placeId === placeId);
    let status = 'none';
    if (subs.some((s) => s.status === 'approved')) status = 'approved';
    else if (subs.some((s) => s.status === 'pending')) status = 'pending';
    const pr = state.progress[placeId] || { checkedIn: false, status: 'none' };
    pr.status = status; state.progress[placeId] = pr;
  },

  // R5 #2: 승인 대기(pending/revise) 제출 취소 → 철회·재제출 가능. approved는 거부(서버에서도 차단).
  async cancelSubmission(missionId) {
    const sub = state.submissions[missionId];
    if (!sub) return { cancelled: false };
    if (sub.status === 'approved') throw new Error('not_cancellable');
    if (!isLocalMode()) {
      if (!sub.remoteId) throw new Error('no_remote_id');
      await Supabase.rpc('cancel_submission', { p_code: state.groupCode, p_submission_id: sub.remoteId });
    }
    delete state.submissions[missionId];
    // ★해당 장소 진행상태를 남은 제출들로 재계산(같은 장소 다른 미션이 살아있으면 유지 — D5 등 복수미션 정합).
    if (sub.scope === 'place' && sub.placeId) this._recomputePlace(sub.placeId);
    save();
    if (!isLocalMode()) { try { await this.refreshStatus(); } catch {} }
    return { cancelled: true };
  },

  // production 상태 동기화: get_my_status RPC → 서버 권위로 submissions/progress 재구성. 로컬모드는 no-op.
  async refreshStatus(g) {
    if (isLocalMode()) return;
    const myGen = (g != null) ? g : gen;
    const rows = await Supabase.rpc('get_my_status', { p_code: state.groupCode });
    if (myGen !== gen) return;   // ★세대 바뀜(조 전환 중 느린 응답) → 폐기(#9)
    // ★서버 권위로 제출맵 재구성(승인취소·삭제된 제출 자동 정리). 로컬 진행/보류분은 보존.
    const next = {};
    for (const r of rows || []) {
      const meta = this.missionMeta(r.mission_id);
      const placeId = meta ? meta.placeId : null;
      const prev = state.submissions[r.mission_id] || {};
      next[r.mission_id] = {
        status: r.status, scope: r.mission_scope, placeId,
        photoRefs: prev.photoRefs || [], comment: prev.comment || '',
        teacherNote: r.teacher_note || null, remoteId: r.submission_id, createdAt: r.created_at,
      };
    }
    for (const [mid, s] of Object.entries(state.submissions)) {
      if (s.status === 'uploading') next[mid] = s;                       // ★업로드 진행 중은 서버행보다 로컬 우선(#8 성공결과 유실 방지)
      else if (!next[mid] && s.status === 'queued') next[mid] = s;       // 아직 서버 미도달 보류분 보존
    }
    state.submissions = next;
    // 장소별 진행상태 = 서버 제출 기준 재계산(승인취소 강등·부분취소 반영)
    for (const p of seed.places) this._recomputePlace(p.placeId);
    save();
  },

  // ── 조별 저널 (D6) — 승인=게재 원칙. 완료(approved)된 장소만 지면으로. 승인 사진은 조 업로드(비공개 버킷). ──
  // 각 페이지: { placeId, place, submission(승인 제출, 있으면 사진·코멘트), reading(읽을거리 질문) }
  journal() {
    const SUBMITTED = ['pending', 'approved', 'revise'];        // 저널=제출분 게재(★승인 불요 유지 — R3 #2 ④). queued/idle 제외.
    const pages = [];
    for (const { placeId } of this.course) {
      // ★저널은 visited(승인)와 분리 — 제출만 있으면 게재(승인 불요).
      const sub = Object.values(state.submissions).find((s) => s.placeId === placeId && SUBMITTED.includes(s.status)) || null;
      if (!sub) continue;
      pages.push({ scope: 'place', placeId, place: this.place(placeId), submission: sub, reading: this.readingFor(placeId) });
    }
    // 제출된 코스 미션(장소 비귀속)도 별지로
    for (const [mid, s] of Object.entries(state.submissions)) {
      if (s.scope === 'course' && SUBMITTED.includes(s.status)) {
        const cm = (seed.courseMissions || []).find((x) => x.missionId === mid);
        pages.push({ scope: 'course', missionId: mid, brief: cm ? cm.brief : '코스 미션', submission: s });
      }
    }
    return pages;
  },

  // (데모 전용) 교사 승인/보완 미리보기 — 로컬모드에서만 UI 상태 확인용. production은 교사 화면(D5)/RPC가 처리.
  demoReview(missionId, status, note) {
    if (!isLocalMode()) return;
    const sub = state.submissions[missionId]; if (!sub) return;
    sub.status = status; sub.teacherNote = note || null;
    if (status === 'approved' && sub.scope === 'place' && sub.placeId) this._markProgress(sub.placeId, 'approved');
    save();
  },

  // ── 점수경쟁제 (#4) — 기본점수=거리(허브 이동시간), 분배=균등 P/k. 서버가 권위(leaderboard RPC). ──
  // 기본점수: place.basePoints(worker1 표 확정값) 우선, 없으면 공식 max(10, round(hubMinutes/5)*5) 폴백.
  basePointsOf(id) {
    const p = this.place(id); if (!p) return 0;
    if (p.basePoints != null) return p.basePoints;
    const hm = (p.planner && p.planner.hubMinutes) || 0;
    return Math.max(10, Math.round(hm / 5) * 5);
  },
  // 로컬/데모 미리보기 점수(서버 미연동 시): 우리 조가 다녀온 장소 base_points 합(첫방문=만점 가정). 협동 합계는 온라인 전용.
  localScore() {
    let sc = 0;
    for (const { placeId } of this.course) {
      if (this.visited(placeId)) sc += this.basePointsOf(placeId);
    }
    return Math.round(sc);
  },
  // 협동 캠프 현황 조회(집계만 — 사진/제출/정답 노출 0). #3+#4 동시 충족.
  //   ★R4 #2: camp_progress는 public(조 불요) → isDemoEnv(네트워크)만 차단. 교사(조코드 없음)도 받음.
  async fetchCampProgress() { if (isDemoEnv()) return null; return Supabase.rpc('camp_progress', {}); },

  // ── 코스 플래너 (D3) — group_course_place 동형. 공통필수(REQUIRED) 자동포함·삭제불가·정렬만 ──
  get requiredIds() { return [...REQUIRED]; },
  get recommendedCourses() { return seed.recommendedCourses || []; },
  inCourse(id) { return state.course.some((c) => c.placeId === id); },
  selectablePlaces() { return seed.places.filter((p) => !REQUIRED.includes(p.placeId)); }, // 선택 장소(전체-공통필수)
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
