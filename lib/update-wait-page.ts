export type UpdateWaitPageInput = {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
  resumeUrl: string;
};

/**
 * 업데이트 대기 탭이 그리는 화면 전체. 이 화면은 서버가 새 버전으로 바뀌는 동안에도
 * 보여야 하므로 외부 CSS·폰트·이미지·스크립트를 하나도 참조하지 않고 스타일·로고·동작을
 * 모두 inline으로 둔다. 색은 `@seed-design/css` 다크 역할 토큰의 실제 리터럴이고,
 * 심볼 path와 그라디언트는 `components/OmpWordmark.tsx`의 CUELO 워드마크와 같다.
 *
 * 표시 규칙:
 * - 화면에 쓰는 진행 정보는 `/api/update-maintenance` 응답에서 실제로 관측한 값뿐이다.
 *   전체 완료 퍼센트나 예상 시간은 데이터에 없으므로 만들지 않는다. 진행선은 관측한
 *   단계(`DRAINING`→`QUIESCENT`→`CUTOVER`→`SERVICE_READY`)까지만 채운다.
 * - 단계를 아직 받지 못했거나 모르는 값이면 성공·실패 어느 쪽으로도 단정하지 않는다.
 * - 복귀 판정(정확한 request/stage 일치, `deploymentCompleted`·`writeSafe`·`mutationBlocked`)과
 *   확인 주기는 서버 계약 그대로이며 이 화면은 그 조건을 바꾸지 않는다.
 * - 확인 요청에는 상한을 둔다. 한 번의 늦은 응답이나 무응답이 확인 루프를 끝내면 화면이
 *   마지막 단계에 얼어붙어, worker가 이미 기록한 종료 상태를 사용자가 영영 못 본다.
 * - 종료 상태가 실패면 worker가 남긴 `terminalError`를 그대로 보여 준다. 쓰기 차단
 *   (`mutationBlocked`)이 풀린 것을 관측한 뒤에만 작업 화면 복귀 버튼을 띄우고, 자동으로
 *   이동하지는 않는다 — 실패를 사용자가 읽고 직접 가야 한다. 차단이 아직 안 풀렸으면 실패
 *   표시를 유지한 채 확인을 이어간다. 그 순간 루프를 끊으면 버튼이 영영 안 뜨는 또 하나의
 *   무한대기가 된다.
 * - 실패를 처음 관측한 순간 서버에 실패 통지(`failure-notify`)를 한 번 보낸다. 사용자가
 *   버튼을 누르지 않고 탭을 닫아도 배포를 시작한 세션이 실패를 알게 하려는 것이다.
 *   통지가 실패해도 화면 표시는 그대로 둔다(통지는 부가 기능).
 */
export function renderUpdateWaitPage(input: UpdateWaitPageInput): string {
  const data = JSON.stringify(input).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#16171b">
<title>CUELO 업데이트</title>
<style>
:root{
  color-scheme:dark;
  /* SEED 다크 역할 토큰의 리터럴. SEED CSS를 내려받을 수 없는 구간이라 값을 직접 쓴다. */
  --bg:#16171b;
  --panel:#1d2025;
  --line:#393d46;
  --line-strong:#868b94;
  --text:#f3f4f5;
  --text-muted:#dcdee3;
  --text-dim:#b0b3ba;
  --text-faint:#868b94;
  --ok:#22b27f;
  --warn:#ca901c;
  --stop:#ff6e60;
  --info:#41a2f9;
  --font:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard Variable",Pretendard,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";
  --wordmark:"Plus Jakarta Sans",Geist,ui-sans-serif,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Fira Code","Cascadia Code","Noto Sans Mono","DejaVu Sans Mono",Consolas,"Liberation Mono","PingFang SC","Microsoft YaHei",monospace;
  --brand:linear-gradient(135deg,oklch(0.7 0.24 340),oklch(0.62 0.21 295) 50%,oklch(0.81 0.14 200));
  --surface-radius:8px;
  --control-radius:4px;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;padding:0}
body{
  background:var(--bg);
  color:var(--text);
  font-family:var(--font);
  font-size:16px;
  line-height:1.6;
  overflow-wrap:anywhere;
  -webkit-text-size-adjust:100%;
}
.shell{
  width:100%;
  max-width:640px;
  margin:0 auto;
  padding:40px 24px 32px;
  display:flex;
  flex-direction:column;
  gap:20px;
}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand-mark{width:22px;height:22px;flex:none;display:block}
.brand-name{
  font-family:var(--wordmark);
  font-size:15px;
  font-weight:700;
  letter-spacing:-0.025em;
  white-space:nowrap;
}
.brand-tag{
  font-size:13px;
  font-weight:500;
  color:var(--text-faint);
  border-left:1px solid var(--line);
  padding-left:10px;
  white-space:nowrap;
}
.work,.cleanup{
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--surface-radius);
}
.work{padding:24px}
.state{margin:0 0 8px;font-size:13px;font-weight:600}
.state[data-tone="neutral"]{color:var(--text-dim)}
.state[data-tone="info"]{color:var(--info)}
.state[data-tone="warn"]{color:var(--warn)}
.state[data-tone="stop"]{color:var(--stop)}
h1{margin:0 0 8px;font-size:20px;font-weight:700;line-height:1.35;letter-spacing:-0.01em}
.status{margin:0;font-size:14px;line-height:1.6;color:var(--text-muted)}
.steps{list-style:none;margin:20px 0 0;padding:0;display:flex;flex-direction:column}
.step{
  display:grid;
  grid-template-columns:14px minmax(0,1fr) auto;
  column-gap:12px;
  align-items:center;
  padding:7px 0;
}
.tick{
  grid-column:1;
  justify-self:center;
  position:relative;
  z-index:1;
  width:11px;
  height:11px;
  border-radius:50%;
  background:var(--bg);
  border:1.5px solid var(--line);
}
.step+.step .tick::before{
  content:"";
  position:absolute;
  left:50%;
  transform:translateX(-50%);
  bottom:100%;
  width:1.5px;
  height:15px;
  background:var(--line);
}
.step-name{grid-column:2;min-width:0;font-size:14px;font-weight:500;color:var(--text-dim)}
.step-state{grid-column:3;font-size:12px;font-weight:500;color:var(--text-faint);white-space:nowrap}
.step[data-state="done"] .tick{background:var(--line-strong);border-color:var(--line-strong)}
.step[data-state="done"] .step-name{color:var(--text)}
.step[data-state="done"]+.step .tick::before{background:var(--line-strong)}
.step[data-state="current"] .tick{
  background:var(--brand);
  border-color:transparent;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--info) 18%,transparent);
}
.step[data-state="current"] .step-name{color:var(--text)}
.step[data-state="current"] .step-state{color:var(--info)}
.step[data-state="stopped"] .tick{background:var(--stop);border-color:var(--stop)}
.step[data-state="stopped"] .step-name{color:var(--text)}
.step[data-state="stopped"] .step-state{color:var(--stop)}
@media (prefers-reduced-motion:no-preference){
  .step[data-state="current"] .tick{animation:cuelo-tick 2s ease-in-out infinite}
  @keyframes cuelo-tick{
    0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--info) 18%,transparent)}
    50%{box-shadow:0 0 0 6px color-mix(in srgb,var(--info) 6%,transparent)}
  }
}
.meta{display:flex;flex-wrap:wrap;gap:6px 24px;min-width:0}
.meta-item{display:flex;align-items:baseline;gap:8px;min-width:0}
.meta-label{font-size:12px;color:var(--text-faint)}
.meta-value{font-size:13px;color:var(--text-muted);font-variant-numeric:tabular-nums}
.meta-value[data-tone="warn"]{color:var(--warn)}
.meta-value[data-tone="stop"]{color:var(--stop)}
.cleanup{padding:20px 24px 18px}
.cleanup-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.cleanup h2{margin:0;font-size:14px;font-weight:600}
.chip{
  border:1px solid var(--line);
  border-radius:var(--control-radius);
  padding:2px 8px;
  font-size:12px;
  font-weight:600;
  color:var(--text-dim);
  white-space:nowrap;
}
.chip[data-tone="ok"]{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--line))}
.chip[data-tone="warn"]{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.cleanup-rows{margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px}
.cleanup-rows>div{display:grid;grid-template-columns:88px minmax(0,1fr);gap:12px;align-items:baseline}
.cleanup-rows dt{margin:0;font-size:12px;color:var(--text-faint)}
.cleanup-rows dd{margin:0;min-width:0;font-size:13px;color:var(--text-muted)}
.mono{font-family:var(--mono);font-size:12px}
.actions{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin:20px 0 0}
.actions button{
  font:inherit;
  font-size:14px;
  font-weight:600;
  color:var(--text);
  background:var(--bg);
  border:1px solid var(--line-strong);
  border-radius:var(--control-radius);
  padding:9px 16px;
  cursor:pointer;
}
.actions button:hover{border-color:var(--text-dim)}
.actions button:focus-visible{outline:2px solid var(--info);outline-offset:2px}
.actions .hint{margin:0;font-size:13px;line-height:1.6;color:var(--text-dim)}
.foot{margin:0;display:flex;gap:6px;font-size:11px;color:var(--text-faint)}
.foot .mono{font-size:11px}
@media (max-width:400px){
  .shell{padding:28px 20px 24px;gap:16px}
  .work{padding:20px}
  .cleanup{padding:16px 20px 14px}
  h1{font-size:18px}
}
</style>
</head>
<body>
<main class="shell">
<header class="brand">
<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="cuelo-mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="oklch(0.7 0.24 340)"></stop><stop offset=".5" stop-color="oklch(0.62 0.21 295)"></stop><stop offset="1" stop-color="oklch(0.81 0.14 200)"></stop></linearGradient></defs><path fill="url(#cuelo-mark)" d="M4 6 C7.5 1.8 15.5 2 19 6.2 L22.5 12 L19.3 16.2 C16.4 21.3 8.5 22.2 4.2 17.8 L7 15.2 C10 19.7 15.3 18.7 17 14.2 L19 12 L16.2 9 C14.1 6.4 9.8 6.1 6.8 9.1 Z"></path></svg>
<span class="brand-name">CUELO</span>
<span class="brand-tag">업데이트</span>
</header>
<section class="work">
<p class="state" id="state" data-tone="neutral">상태 확인 중</p>
<h1 id="task-title">업데이트 상태를 확인하고 있습니다</h1>
<p class="status" id="status" role="status" aria-live="polite">이 탭은 업데이트가 끝나면 같은 작업 화면으로 자동 복귀합니다.</p>
<ol class="steps" id="steps">
<li class="step" data-state="pending"><span class="tick" aria-hidden="true"></span><span class="step-name">세션 정지</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="tick" aria-hidden="true"></span><span class="step-name">교체 준비</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="tick" aria-hidden="true"></span><span class="step-name">패키지 교체</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="tick" aria-hidden="true"></span><span class="step-name">새 버전 확인</span><span class="step-state">대기</span></li>
</ol>
<div class="actions" id="failure-actions" hidden>
<button type="button" id="return-button">작업 화면으로 돌아가기</button>
<p class="hint" id="failure-hint" hidden></p>
</div>
</section>
<div class="meta">
<span class="meta-item"><span class="meta-label">화면 경과</span><span class="meta-value" id="elapsed">0초</span></span>
<span class="meta-item"><span class="meta-label">연결</span><span class="meta-value" id="link" data-tone="neutral">확인 중</span></span>
</div>
<section class="cleanup" id="cleanup" aria-labelledby="cleanup-title" hidden>
<div class="cleanup-head"><h2 id="cleanup-title">임시 산출물 정리</h2><span class="chip" id="cleanup-phase" data-tone="neutral">대기</span></div>
<dl class="cleanup-rows">
<div><dt>현재 대상</dt><dd class="mono" id="cleanup-target">대상 선택 중</dd></div>
<div><dt>완료</dt><dd class="mono" id="cleanup-count">0 / 0</dd></div>
<div><dt>경과</dt><dd class="mono" id="cleanup-elapsed">0초</dd></div>
<div id="cleanup-result-row" hidden><dt>결과</dt><dd class="mono" id="cleanup-result"></dd></div>
</dl>
</section>
<p class="foot" id="foot">요청 <span class="mono" id="request"></span></p>
</main>
<script>
const state=${data};
const el=function(id){return document.getElementById(id);};
const stateEl=el("state"),titleEl=el("task-title"),statusEl=el("status"),stepsEl=el("steps");
const elapsedEl=el("elapsed"),linkEl=el("link"),footEl=el("foot"),requestEl=el("request");
const cleanupEl=el("cleanup"),cleanupPhaseEl=el("cleanup-phase"),cleanupTargetEl=el("cleanup-target");
const cleanupCountEl=el("cleanup-count"),cleanupElapsedEl=el("cleanup-elapsed");
const cleanupResultRowEl=el("cleanup-result-row"),cleanupResultEl=el("cleanup-result");
const failureActionsEl=el("failure-actions"),returnButtonEl=el("return-button"),failureHintEl=el("failure-hint");

/* 실제 phase 계약(DRAINING→QUIESCENT→CUTOVER→SERVICE_READY)만 단계로 쓴다. */
const STAGES=[
  {title:"실행 중인 세션을 정리하고 있습니다",detail:"업데이트를 시작해 실행 중인 세션을 멈추는 중입니다. 이 탭은 업데이트가 끝나면 같은 작업 화면으로 자동 복귀합니다."},
  {title:"교체 준비를 마무리하고 있습니다",detail:"모든 세션이 멈춘 것을 확인했습니다. 새 버전 패키지를 교체할 준비를 하고 있습니다."},
  {title:"새 버전으로 교체하고 있습니다",detail:"패키지 파일을 새 버전으로 바꾸는 중입니다. 이 구간에서는 화면 응답이 잠시 끊길 수 있습니다."},
  {title:"새 버전이 응답하는지 확인하고 있습니다",detail:"새 버전 서비스가 이 업데이트의 요청과 단계로 응답하는지 확인하고 있습니다."}
];
const PHASE_INDEX={DRAINING:0,QUIESCENT:1,CUTOVER:2,SERVICE_READY:3};
const CLEANUP_LABELS={running:"정리 중",succeeded:"정리 완료",failed:"정리 실패 · 증거 보존",skipped:"정리 건너뜀","pending-approval":"정리 승인 대기"};

let stopped=false;
let failed=false;
let failureNotified=false;
let resumeConfirmed=false;
let confirmingResume=false;
let failedPolls=0;
let linkIntervalMs=0;
let resuming=false;
let rank=-1;
const startedAt=performance.now();

function setState(text,tone){stateEl.textContent=text;stateEl.dataset.tone=tone;}
function renderSteps(reached,stoppedAt){
  const items=stepsEl.children;
  for(let i=0;i<items.length;i++){
    const item=items[i];
    const value=i===stoppedAt?"stopped":(i<reached?"done":(i===reached?"current":"pending"));
    item.dataset.state=value;
    item.lastElementChild.textContent=value==="done"?"완료":(value==="current"?"진행 중":(value==="stopped"?"중단":"대기"));
    if(value==="current")item.setAttribute("aria-current","step");else item.removeAttribute("aria-current");
  }
}
function fmtElapsed(seconds){
  const total=Math.max(0,Math.floor(seconds));
  if(total<60)return total+"초";
  const minutes=Math.floor(total/60);
  if(minutes<60)return minutes+"분 "+(total%60)+"초";
  return Math.floor(minutes/60)+"시간 "+(minutes%60)+"분";
}
function tick(){
  elapsedEl.textContent=fmtElapsed((performance.now()-startedAt)/1000);
  renderCleanupElapsed();
}
function renderLink(){
  let text="확인 중";
  let tone="neutral";
  if(failed||stopped){
    text=failedPolls>0?"중단 · 서버 응답 대기 · "+failedPolls+"회":"중단";
    tone="stop";
  }
  else if(resuming){text="복귀 확인 중";}
  else if(failedPolls>0){text="서버 응답 대기 · "+failedPolls+"회";tone="warn";}
  else if(linkIntervalMs>=1000){text="연결됨 · "+(linkIntervalMs/1000)+"초 간격 확인";}
  linkEl.textContent=text;
  linkEl.dataset.tone=tone;
}
function renderUnknown(){
  setState(failedPolls>0?"연결 확인 중":"상태 확인 중","neutral");
  titleEl.textContent="업데이트 상태를 확인하고 있습니다";
  statusEl.textContent=failedPolls>0
    ?"서버 응답을 기다리는 중입니다. 업데이트가 끝났는지 실패했는지는 아직 확인되지 않았습니다."
    :"이 탭은 업데이트가 끝나면 같은 작업 화면으로 자동 복귀합니다.";
  renderSteps(-1,-1);
}
function renderPhase(index,statusOverride,reached){
  if(index<0){renderUnknown();return;}
  setState("업데이트 진행 중","info");
  titleEl.textContent=STAGES[index].title;
  statusEl.textContent=statusOverride||STAGES[index].detail;
  renderSteps(reached,-1);
}
/* worker가 남긴 terminalError는 원인 문장 전체다. 화면 폭을 넘겨 레이아웃을 밀지 않도록
   자르고, textContent로만 넣어 HTML로 해석되지 않게 한다(별도 이스케이프가 필요 없다). */
const TERMINAL_ERROR_MAX=300;
function clipTerminalError(value){
  const text=typeof value==="string"?value.trim():"";
  if(!text)return "";
  return text.length>TERMINAL_ERROR_MAX?text.slice(0,TERMINAL_ERROR_MAX)+"…":text;
}
function renderFailed(body){
  setState("업데이트 중단","stop");
  titleEl.textContent="업데이트가 중단되었습니다";
  const detail=clipTerminalError(body&&body.terminalError);
  statusEl.textContent=detail
    ?"업데이트가 중단되었습니다. "+detail
    :"업데이트가 중단되었습니다. 기존 서비스 복구 상태는 배포 evidence를 확인하세요.";
  renderSteps(rank,rank);
}
/* 실패를 이미 본 뒤에는 진행 표시로 되돌아가지 않는다. 종료 receipt는 사라지지 않으므로
   이 경로는 방어용이다. */
function renderFailureWaitingForRelease(){
  failureActionsEl.hidden=false;
  returnButtonEl.hidden=true;
  failureHintEl.hidden=false;
  failureHintEl.textContent="업데이트 쓰기가 아직 잠겨 있습니다. 잠금이 풀리면 작업 화면으로 돌아가기 버튼이 나타납니다.";
}
/* 쓰기 차단이 풀린 것을 관측한 뒤에만 돌아갈 길을 준다. 자동 이동은 하지 않는다 —
   실패를 사용자가 읽고 직접 가야 한다. */
function renderFailureReturnReady(){
  failureActionsEl.hidden=false;
  returnButtonEl.hidden=false;
  failureHintEl.hidden=true;
  failureHintEl.textContent="";
}
returnButtonEl.addEventListener("click",function(){location.replace(state.resumeUrl);});

let cleanupElapsedBase=0;
let cleanupObservedAt=performance.now();
let cleanupRunning=false;
let cleanupReceiptKey="";
function observedCleanupElapsed(now=performance.now()){
  return cleanupRunning
    ?Math.max(0,cleanupElapsedBase+(now-cleanupObservedAt)/1000)
    :Math.max(0,cleanupElapsedBase);
}
function renderCleanupElapsed(){
  if(cleanupEl.hidden)return;
  cleanupElapsedEl.textContent=Math.floor(observedCleanupElapsed())+"초";
}
function showCleanup(cleanup){
  if(!cleanup||cleanup.phase!=="ARTIFACT_CLEANUP")return null;
  cleanupEl.hidden=false;
  const now=performance.now();
  const reportedElapsed=Number.isFinite(cleanup.elapsedSeconds)?Math.max(0,cleanup.elapsedSeconds):0;
  const nextReceiptKey=[
    cleanup.updatedAtUtc,cleanup.status,cleanup.currentTarget,
    cleanup.completedCount,cleanup.totalCount,reportedElapsed
  ].join("|");
  if(nextReceiptKey!==cleanupReceiptKey){
    const elapsedBeforeReceipt=observedCleanupElapsed(now);
    cleanupElapsedBase=cleanup.status==="running"
      ?Math.max(elapsedBeforeReceipt,reportedElapsed)
      :reportedElapsed;
    cleanupObservedAt=now;
    cleanupRunning=cleanup.status==="running";
    cleanupReceiptKey=nextReceiptKey;
  }
  cleanupPhaseEl.textContent=CLEANUP_LABELS[cleanup.status]||"상태 확인 중";
  cleanupPhaseEl.dataset.tone=cleanup.status==="succeeded"?"ok":(cleanup.status==="failed"?"warn":"neutral");
  cleanupTargetEl.textContent=cleanup.currentTarget||(
    cleanup.status==="running"?"대상 선택 중":"없음"
  );
  cleanupCountEl.textContent=String(cleanup.completedCount)+" / "+String(cleanup.totalCount);
  if(cleanup.status!=="running"){
    cleanupResultRowEl.hidden=false;
    cleanupResultEl.textContent="삭제 "+(Number(cleanup.removedCount)||0)+"건 · 보존 "
      +(Number(cleanup.keptCount)||0)+"건 · 실패 "+(Number(cleanup.failureCount)||0)+"건";
  }else{
    cleanupResultRowEl.hidden=true;
  }
  renderCleanupElapsed();
  if(cleanup.status==="running")return "배포 안전 확인이 끝나 비필수 임시 산출물을 정리하고 있습니다.";
  if(cleanup.status==="failed")return "배포는 완료됐지만 임시 산출물 정리에 실패했습니다. 실패 증거는 보존했습니다.";
  return null;
}

async function confirmResume(){
  if(resumeConfirmed)return true;
  if(confirmingResume)return false;
  confirmingResume=true;
  try{
    if(state.sessionId){
      const detail=await fetch("/api/sessions/"+encodeURIComponent(state.sessionId)+"?deferThinking=1&deferMedia=1",{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
      if(!detail.ok)return false;
      const session=await detail.json();
      if(session.sessionId!==state.sessionId)return false;
    }
    const response=await fetch("/api/update-maintenance",{
      method:"POST",
      cache:"no-store",
      headers:{"Content-Type":"application/json","Cache-Control":"no-cache"},
      body:JSON.stringify({
        action:"resume-confirm",
        requestId:state.requestId,
        stageHash:state.stageHash,
        clientId:state.clientId,
        sessionId:state.sessionId
      })
    });
    if(!response.ok)return false;
    resumeConfirmed=true;
    return true;
  }catch{
    return false;
  }finally{
    confirmingResume=false;
  }
}
function schedule(ms){
  linkIntervalMs=ms;
  renderLink();
  setTimeout(check,ms);
}
/* 확인 요청에 상한을 둔다. 응답이 영영 오지 않으면 이 루프가 그 자리에서 끝나 화면이
   마지막 단계에 얼어붙고, worker가 이미 기록한 종료 상태를 영원히 못 본다. 늦은 응답은
   버리고 다음 확인으로 넘어간다. */
const POLL_TIMEOUT_MS=5000;
const POLL_RETRY_MS=1000;
async function pollStatus(){
  const query=new URLSearchParams({requestId:state.requestId,stageHash:state.stageHash});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),POLL_TIMEOUT_MS);
  try{
    const response=await fetch("/api/update-maintenance?"+query,{cache:"no-store",headers:{"Cache-Control":"no-cache"},signal:controller.signal});
    return response.ok?await response.json():null;
  }catch{
    return null;
  }finally{
    clearTimeout(timer);
  }
}
/* 실패를 처음 본 순간 한 번만 알린다. 버튼을 누르지 않고 탭을 닫아도 배포를 시작한 세션이
   실패를 알게 하는 것이 목적이므로, 화면 표시와 독립적으로 보낸다. 통지가 실패해도 화면은
   그대로 실패를 보여 준다 — 통지는 부가 기능이다. */
async function notifyFailureOnce(){
  if(failureNotified)return;
  failureNotified=true;
  if(!state.requestId||!state.clientId)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),POLL_TIMEOUT_MS);
  try{
    await fetch("/api/update-maintenance",{
      method:"POST",
      cache:"no-store",
      headers:{"Content-Type":"application/json","Cache-Control":"no-cache"},
      signal:controller.signal,
      body:JSON.stringify({
        action:"failure-notify",
        requestId:state.requestId,
        stageHash:state.stageHash,
        clientId:state.clientId,
        sessionId:state.sessionId
      })
    });
  }catch{
    /* 통지 실패는 실패 표시를 막지 않는다. */
  }finally{
    clearTimeout(timer);
  }
}
/* 종료 상태가 실패일 때의 화면과 다음 확인 간격을 정한다. 쓰기 차단이 풀린 것을 관측한
   뒤에만 돌아가기 버튼을 띄우고 확인을 끝낸다. 아직 잠겨 있으면 실패 표시를 유지한 채
   확인을 이어간다 — 그 순간 루프를 끊으면 버튼이 영영 안 뜨는 또 하나의 무한대기가 된다. */
async function applyFailure(body){
  failed=true;
  await notifyFailureOnce();
  renderFailed(body);
  renderLink();
  if(body.mutationBlocked===false){
    stopped=true;
    renderFailureReturnReady();
    return null;
  }
  renderFailureWaitingForRelease();
  return POLL_RETRY_MS;
}
/* 관측한 응답 하나를 화면에 반영하고 다음 확인까지의 간격을 돌려준다.
   null이면 이 화면은 더 확인하지 않는다 — 종료를 표시했거나 복귀 화면으로 이동했다. */
async function applyStatus(body){
  const cleanupStatus=showCleanup(body.cleanup);
  if(body.terminalStatus&&body.terminalStatus!=="succeeded"&&body.writeSafe!==true)return applyFailure(body);
  if(failed)return applyFailure(body);
  const exactService=body.phase==="SERVICE_READY"&&body.service&&body.service.ready===true&&body.service.requestId===state.requestId&&body.service.stageHash===state.stageHash;
  if(exactService){
    const completed=body.deploymentCompleted===true&&body.writeSafe===true;
    rank=Math.max(rank,3);
    renderPhase(3,cleanupStatus,completed?4:rank);
    resuming=true;
    renderLink();
    const confirmed=await confirmResume();
    resuming=false;
    if(confirmed&&completed&&body.mutationBlocked===false){
      location.replace(state.resumeUrl);
      return null;
    }
    statusEl.textContent=confirmed
      ?"세션 복귀를 확인했습니다. rollback·쓰기 안전 증거를 확인하고 있습니다."
      :"새 서비스에서 같은 세션을 확인하고 있습니다.";
    return POLL_RETRY_MS;
  }
  const index=Object.prototype.hasOwnProperty.call(PHASE_INDEX,body.phase)?PHASE_INDEX[body.phase]:-1;
  if(index<0){
    renderUnknown();
    if(cleanupStatus)statusEl.textContent=cleanupStatus;
  }else{
    rank=Math.max(rank,index);
    renderPhase(index,cleanupStatus,rank);
  }
  return body.phase==="CUTOVER"?15000:(body.phase==="QUIESCENT"?5000:1000);
}
async function check(){
  if(stopped)return;
  const body=await pollStatus();
  if(stopped)return;
  let delay=POLL_RETRY_MS;
  if(!body){
    failedPolls+=1;
    /* 실패를 이미 본 뒤의 무응답은 실패 표시를 지우지 않는다. */
    if(!failed)renderUnknown();
    renderLink();
  }else{
    failedPolls=0;
    try{
      const next=await applyStatus(body);
      if(next===null)return;
      delay=next;
    }catch{
      /* 표시 갱신이 실패해도 확인 자체는 이어진다. 다음 응답이 정본을 다시 읽는다. */
      delay=POLL_RETRY_MS;
    }
  }
  if(stopped)return;
  schedule(delay);
}
if(state.requestId)requestEl.textContent=state.requestId.slice(0,8)+"…";else footEl.hidden=true;
tick();
renderLink();
setInterval(tick,1000);
setTimeout(check,1000);
</script>
</body>
</html>`;
}
