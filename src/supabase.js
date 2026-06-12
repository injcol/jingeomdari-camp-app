// 경량 Supabase 클라이언트 (무번들·file:// 안전) — REST/RPC + Storage. D4 유닛4.
// ★학생 클라이언트 데이터 접근 원칙 (이 파일이 강제):
//   · 콘텐츠 미션은 mission_public / course_mission_public 뷰로만 조회(answer 숨김). base mission/course_mission 직접 조회 금지.
//   · 런타임(조/제출/진행)은 SECURITY DEFINER RPC로만 (design/rls_runtime_v1.sql). 테이블 직접 접근 금지.
//   · 사진은 비공개 버킷(mission-photos). 외부공유는 서명 URL + consent_export 게이팅(호출측).
// file://(검증) 환경에서는 네트워크 호출이 실패 → 앱이 로컬 모드로 graceful fallback (store.js).
// ⚠ 라이브 DB 쓰기(submit_mission 등)·Storage 업로드 실측은 master 사전보고 후에만 가동.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase_config.js';

export const PHOTO_BUCKET = 'mission-photos';                 // 비공개 버킷 (design/storage_policy_v1.sql)
export const ALLOWED_VIEWS = ['mission_public', 'course_mission_public']; // 학생 클라가 읽을 수 있는 유일한 미션 소스

// 설정 여부(키 존재 + http(s) 엔드포인트). file://여도 configured는 true일 수 있으나, 실제 호출은 네트워크에서 판가름.
export function configured() {
  return /^https?:\/\//.test(SUPABASE_URL) && typeof SUPABASE_ANON_KEY === 'string' && SUPABASE_ANON_KEY.length > 20;
}

const baseHeaders = (extra = {}) => ({
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  ...extra,
});

// ── 런타임 RPC (SECURITY DEFINER 함수만 — 테이블 직접 접근 X) ──
export async function rpc(fn, args = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} → ${res.status}: ${await res.text().catch(() => '')}`);
  return res.status === 204 ? null : res.json();
}

// ── 콘텐츠 미션 조회 — 반드시 *_public 뷰만 (answer 컬럼 없음). 다른 테이블/뷰 호출은 거부. ──
export async function selectView(view, query = '') {
  if (!ALLOWED_VIEWS.includes(view)) {
    throw new Error(`forbidden source: ${view} — mission_public/course_mission_public 뷰만 허용(answer 노출 방지)`);
  }
  const sep = query ? '&' : '';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${view}?select=*${sep}${query}`, { headers: baseHeaders() });
  if (!res.ok) throw new Error(`select ${view} → ${res.status}`);
  return res.json();
}
export const fetchMissionsPublic = () => selectView('mission_public');
export const fetchCourseMissionsPublic = () => selectView('course_mission_public');

// ── 미션 사진 제출 2단계 흐름 (storage v1.1 보안 모델) ──
// ① requestUpload: 조코드/미션 검증 후 submission(uploaded) 발급 → { submission_id, group_id }.
//    경로는 서버 발급 규칙 '{group_id}/{submission_id}/{난수UUID}.jpg' 로만(클라가 난수 파일명 생성).
export async function requestUpload(code, missionId, scope) {
  const rows = await rpc('request_upload', { p_code: code, p_mission_id: missionId, p_scope: scope });
  const r = Array.isArray(rows) ? rows[0] : rows;
  if (!r || !r.submission_id) throw new Error('request_upload_failed');
  return { submissionId: r.submission_id, groupId: r.group_id };
}
export function photoPath(groupId, submissionId) {
  const rnd = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${groupId}/${submissionId}/${rnd}.jpg`;        // insert 정책 storage_path_ok() 와 정합
}
// ② finalizeSubmission: 업로드 완료 경로로 소유권 검증 후 status=pending.
export async function finalizeSubmission(code, submissionId, photoRefs, comment) {
  return rpc('finalize_submission', { p_code: code, p_submission_id: submissionId, p_photo_refs: photoRefs, p_comment: comment });
}
// 교사 사진 열람: teacher_code+submission_id로 제출물 photo_refs만 획득(임의 path 서명 금지, H2).
// 실제 서명 URL은 Edge Function 'teacher-photo'(service role)가 발급 — 키 세션 구현. 여기선 권한 검증된 경로만 반환.
export async function teacherPhotoRefs(teacherCode, submissionId) {
  return rpc('teacher_photo_refs', { p_teacher_code: teacherCode, p_submission_id: submissionId });
}

// ── Storage 비공개 버킷 업로드 (XHR로 진행률·취소). path는 requestUpload가 발급한 서버 경로만 전달. 반환=객체 경로 ──
// handle.xhr 로 취소(abort) 가능.
export function uploadPhoto(path, blob, onProgress) {
  const handle = { xhr: null };
  const promise = new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    handle.xhr = xhr;
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${encodeURI(path)}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${SUPABASE_ANON_KEY}`);
    xhr.setRequestHeader('x-upsert', 'true');
    if (blob.type) xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300)
      ? resolve(path)
      : reject(new Error(`upload ${xhr.status}: ${xhr.responseText || ''}`));
    xhr.onerror = () => reject(new Error('upload_network_error'));
    xhr.onabort = () => reject(new Error('upload_aborted'));
    xhr.send(blob);
  });
  promise.handle = handle;
  return promise;
}

// ── 비공개 사진 서명 URL ──
// ⚠ codex storage H2: anon은 비공개 버킷 객체를 직접 서명하지 않는다(select 정책 부재=보안 경계).
//   교사 열람·저널 외부공유는 Edge Function 'teacher-photo'(service role)가 teacher_photo_refs로
//   권한·제출물 검증 + consent 게이트 후 만료형 서명 URL 발급(키 세션 구현). 클라 직접 서명 함수는 두지 않음.
export async function teacherPhotoUrls(teacherCode, submissionId) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/teacher-photo`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ teacher_code: teacherCode, submission_id: submissionId }),
  });
  if (!res.ok) throw new Error(`teacher-photo ${res.status}`);
  return res.json();   // { urls: [{ ref, signedUrl, expiresAt }] }
}

// 저널 production 사진(조 게이트) — group-photo Edge Function. 본 조 approved 제출의 서명 URL.
export async function groupPhotoUrls(groupCode, { submissionId, purpose = 'journal' } = {}) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/group-photo`, {
    method: 'POST',
    headers: baseHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ group_code: groupCode, submission_id: submissionId, purpose }),
  });
  if (!res.ok) throw new Error(`group-photo ${res.status}`);
  return res.json();   // { group, photos: [{ submission_id, urls:[{ref,signedUrl}] }] }
}

// 네트워크 가용성(production 모드 판정 보조). file://·오프라인이면 false.
export function online() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
