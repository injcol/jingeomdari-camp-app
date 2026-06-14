// 교사 관리자 로직 (D5) — 승인 큐·승인/보완/숨김. (R4: 동의 관리 제거, 전체 현황은 app.js camp_progress)
// production: design/teacher_admin_rpc_v1.sql RPC(teacher_code 게이트). 로컬(file://): 네트워크 0 목업으로 검증.
// 학생 Store와 분리(역할 격리). 콘텐츠 라벨은 오프라인 seed 사용(정답 없음).
import seed from '../data/seed.js';
import * as Supabase from './supabase.js';

const TKEY = 'jgd.teacher.v1';
let tcode = loadCode();
function loadCode() { try { return localStorage.getItem(TKEY) || null; } catch { return null; } }

function isLocalMode() {
  return (typeof location !== 'undefined' && location.protocol === 'file:') || !Supabase.configured();
}
const missionLabel = (id) => {
  const m = (seed.missions || []).find((x) => x.missionId === id) || (seed.courseMissions || []).find((x) => x.missionId === id);
  return m ? (m.brief || m.type) : id;
};
const placeName = (pid) => { const p = (seed.places || []).find((x) => x.placeId === pid); return p ? p.name : pid; };

// ── 로컬 데모 목업(세션 영속) — 5조 × 제출/승인/동의 ──
function freshMock() {
  const groups = [
    ['g1', '1조', '#1f6f74'], ['g2', '2조', '#b15a37'], ['g3', '3조', '#5d6b39'], ['g4', '4조', '#c79140'], ['g5', '5조', '#175055'],
  ];
  const now = Date.now();
  const ago = (min) => new Date(now - min * 60000).toISOString();
  const subs = [
    { submission_id: 's1', group_id: 'g1', group_name: '1조', mission_id: 'm_B11_1', mission_scope: 'place', place_id: 'B11', photo_refs: ['g1/m_B11_1/0', 'g1/m_B11_1/1'], comment: '연동교회 머릿돌 연도를 찾았어요', status: 'pending', created_at: ago(4), hidden: false },
    { submission_id: 's2', group_id: 'g3', group_name: '3조', mission_id: 'm_D5_1', mission_scope: 'place', place_id: 'D5', photo_refs: ['g3/m_D5_1/0'], comment: '', status: 'pending', created_at: ago(12), hidden: false },
    { submission_id: 's3', group_id: 'g2', group_name: '2조', mission_id: 'm_ALL_1', mission_scope: 'course', place_id: null, photo_refs: ['g2/m_ALL_1/0', 'g2/m_ALL_1/1', 'g2/m_ALL_1/2'], comment: '조원 모두 한 컷', status: 'pending', created_at: ago(28), hidden: false },
    { submission_id: 's4', group_id: 'g1', group_name: '1조', mission_id: 'm_C3_1', mission_scope: 'place', place_id: 'C3', photo_refs: ['g1/m_C3_1/0'], comment: '', status: 'approved', created_at: ago(55), hidden: false },
    { submission_id: 's5', group_id: 'g4', group_name: '4조', mission_id: 'm_B11_2', mission_scope: 'place', place_id: 'B11', photo_refs: ['g4/m_B11_2/0'], comment: '예배당 내부', status: 'pending', created_at: ago(70), hidden: false },
    { submission_id: 's6', group_id: 'g3', group_name: '3조', mission_id: 'm_D5_2', mission_scope: 'place', place_id: 'D5', photo_refs: ['g3/m_D5_2/0'], comment: '', status: 'approved', created_at: ago(95), hidden: false },
  ];
  const totals = { g1: 6, g2: 5, g3: 7, g4: 5, g5: 4 };
  const checkin = { g1: 4, g2: 2, g3: 5, g4: 1, g5: 0 };
  return { groups, subs, totals, checkin };
}
let mock = null;
function M() {
  if (mock) return mock;
  try { const raw = localStorage.getItem(TKEY + '.mock'); if (raw) return (mock = JSON.parse(raw)); } catch {}
  return (mock = freshMock());
}
function saveMock() { try { localStorage.setItem(TKEY + '.mock', JSON.stringify(mock)); } catch {} }
function boardFromMock() {
  const m = M();
  return m.groups.map(([gid, name, color]) => {
    const gs = m.subs.filter((s) => s.group_id === gid);
    return {
      group_id: gid, group_name: name, color,
      total_places: m.totals[gid] || 0,
      approved_count: gs.filter((s) => s.status === 'approved' && s.mission_scope === 'place').length,
      pending_count: gs.filter((s) => s.status === 'pending' && !s.hidden).length,
      checked_in_count: m.checkin[gid] || 0,
      last_activity: gs.reduce((a, s) => (s.created_at > a ? s.created_at : a), null),
    };
  });
}

export const Teacher = {
  get code() { return tcode; },
  setCode(c) { tcode = c || null; try { c ? localStorage.setItem(TKEY, c) : localStorage.removeItem(TKEY); } catch {} },
  clear() { this.setCode(null); },
  isLocalMode,
  localMode() { return isLocalMode(); },
  missionLabel, placeName,

  // 진입 검증: 로컬은 비어있지 않으면 통과(데모) / production은 board RPC로 코드 확인
  async verify(code) {
    if (isLocalMode()) { if (!code) throw new Error('empty_code'); this.setCode(code); return true; }
    await Supabase.rpc('teacher_board', { p_teacher_code: code });   // 실패 시 invalid_teacher_code throw
    this.setCode(code); return true;
  },

  async queue() {
    if (isLocalMode()) return M().subs.filter((s) => s.status === 'pending' && !s.hidden)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return Supabase.rpc('teacher_queue', { p_teacher_code: tcode });
  },
  async board() {
    if (isLocalMode()) return boardFromMock();
    return Supabase.rpc('teacher_board', { p_teacher_code: tcode });
  },
  // R5 #1: 전 조 제출물(승인·대기 포함, hidden 제외) — 사진 갤러리용. 최신순.
  async submissions() {
    if (isLocalMode()) return M().subs.filter((s) => s.status !== 'queued' && !s.hidden)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return Supabase.rpc('teacher_submissions', { p_teacher_code: tcode });
  },
  async review(sid, status, note) {
    if (isLocalMode()) { const s = M().subs.find((x) => x.submission_id === sid); if (s) { s.status = status; s.teacher_note = note || null; } saveMock(); return; }
    return Supabase.rpc('teacher_review', { p_teacher_code: tcode, p_submission_id: sid, p_status: status, p_note: note || null });
  },
  async undo(sid) {
    if (isLocalMode()) { const s = M().subs.find((x) => x.submission_id === sid); if (s) { s.status = 'pending'; s.teacher_note = null; } saveMock(); return; }
    return Supabase.rpc('teacher_undo', { p_teacher_code: tcode, p_submission_id: sid });
  },
  async hide(sid, hidden) {
    if (isLocalMode()) { const s = M().subs.find((x) => x.submission_id === sid); if (s) s.hidden = !!hidden; saveMock(); return; }
    return Supabase.rpc('teacher_hide', { p_teacher_code: tcode, p_submission_id: sid, p_hidden: hidden });
  },
  // 승인된(approved) 목록 — 승인취소 UI용
  async approved() {
    if (isLocalMode()) return M().subs.filter((s) => s.status === 'approved').sort((a, b) => b.created_at.localeCompare(a.created_at));
    const q = await Supabase.rpc('get_my_status', {}).catch(() => null); // production 승인목록은 board/별도 — 여기선 큐만, 승인취소는 카드에서
    return q || [];
  },

  groups() { return M().groups.map(([id, name, color]) => ({ id, name, color })); },
};
