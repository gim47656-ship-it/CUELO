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
 * 모두 inline으로 둔다. 색은 `@seed-design/css` 다크 역할 토큰과 앱 아이콘의 실제 리터럴이고,
 * 나선 고리 path와 램프 색은 `components/OmpWordmark.tsx`·`public/icons/cuelo-icon.svg`와 같다.
 * 큰 심볼이 이 화면의 진행 표시다: 램프는 진행 중에 대기 신호처럼 숨 쉬고 실패면 붉게 바뀌며,
 * 고리는 관측한 완료 단계만큼만 채운다. 둘 다 스크립트가 이미 쓰는 `#state`의 tone과 단계의
 * `data-state`를 CSS `:has()`로 읽을 뿐 판정은 더하지 않는다.
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
 *   (`mutationBlocked:false`)이 풀린 것을 관측하면 작업 화면 복귀 버튼을 띄우고, 다음 확인에서도
 *   서버가 응답하며 실패·차단 해제가 그대로이고 원래 세션이 그 서버에 있으면 클릭 없이 원래
 *   작업 화면으로 돌아간다. 실패 통지가 원래 세션에 이미 run을 세웠으므로 사용자가 이어서 볼
 *   곳은 그 세션이다. 차단이 안 풀렸거나 값이 없거나, 서버가 무응답이거나, 세션을 확인하지
 *   못하면 넘어가지 않고 실패 표시·버튼을 유지한 채 확인을 이어간다. 실패는 `resume-confirm`으로
 *   성공처럼 확정하지 않는다.
 * - 실패를 처음 관측한 순간 서버에 실패 통지(`failure-notify`)를 한 번 보낸다. 사용자가
 *   버튼을 누르지 않고 탭을 닫아도 배포를 시작한 세션이 실패를 알게 하려는 것이다.
 *   통지가 실패해도 화면 표시는 그대로 둔다(통지는 부가 기능). 통지 결과는 같은 탭의
 *   sessionStorage에 남겨, 돌아간 앱이 resume 명령을 다시 보내지 않고 그 run에만 붙게 한다
 *   (`settleUpdateReturn`, `lib/update-maintenance-client.ts`).
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
  /* SEED 다크 역할 토큰과 CUELO 앱 아이콘의 리터럴. 이 구간에서는 외부 CSS를 받을 수 없어 값을 직접 쓴다. */
  --bg:#16171b;
  --panel:#1b1d22;
  --line:#2a2d34;
  --line-strong:#393d46;
  --text:#eceef2;
  --text-muted:#dcdee3;
  --text-dim:#b0b3ba;
  --text-faint:#868b94;
  --lamp:#f5a524;
  --ok:#22b27f;
  --warn:#ca901c;
  --stop:#ff6e60;
  --font:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard Variable",Pretendard,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji";
  --wordmark:"Plus Jakarta Sans",Geist,ui-sans-serif,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono","JetBrains Mono","Fira Code","Cascadia Code","Noto Sans Mono","DejaVu Sans Mono",Consolas,"Liberation Mono","PingFang SC","Microsoft YaHei",monospace;
  --surface-radius:10px;
  --control-radius:6px;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;padding:0}
body{
  word-break:keep-all;
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
  max-width:600px;
  min-height:100vh;
  margin:0 auto;
  padding:64px 24px 48px;
  display:flex;
  flex-direction:column;
  justify-content:center;
  gap:28px;
}
.hero{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:24px;align-items:center}
.mark{width:104px;height:104px;display:block;overflow:visible}
.ring{fill:none;stroke-width:10;stroke-linecap:round}
.ring-base{stroke:var(--line-strong)}
.ring-fill{
  stroke:var(--text);
  stroke-dasharray:100;
  stroke-dashoffset:100;
  opacity:0;
  transition:stroke-dashoffset .7s cubic-bezier(.2,.7,.2,1),opacity .2s,stroke .3s;
}
.lamp{fill:var(--lamp);opacity:.35;transition:fill .3s,opacity .3s}
.halo{fill:var(--lamp);opacity:0;transform-box:fill-box;transform-origin:center}
/* 고리는 관측한 완료 단계만큼만 채운다(4단계 = 25씩). 없는 퍼센트를 만들지 않는다. */
.shell:has(.step:nth-child(1)[data-state="done"]) .ring-fill{opacity:1;stroke-dashoffset:75}
.shell:has(.step:nth-child(2)[data-state="done"]) .ring-fill{stroke-dashoffset:50}
.shell:has(.step:nth-child(3)[data-state="done"]) .ring-fill{stroke-dashoffset:25}
.shell:has(.step:nth-child(4)[data-state="done"]) .ring-fill{stroke-dashoffset:0}
.shell:has(#state[data-tone="info"]) .lamp,
.shell:has(#state[data-tone="warn"]) .lamp{opacity:1}
.shell:has(#state[data-tone="info"]) .halo{opacity:.2}
.shell:has(#state[data-tone="stop"]) .lamp{fill:var(--stop);opacity:1}
.shell:has(#state[data-tone="stop"]) .ring-fill{stroke:var(--text-dim)}
@media (prefers-reduced-motion:no-preference){
  .shell:has(#state[data-tone="info"]) .halo{animation:cue-standby 2.4s ease-in-out infinite}
  @keyframes cue-standby{
    0%,100%{opacity:.06;transform:scale(.75)}
    50%{opacity:.3;transform:scale(1.25)}
  }
}
.brand-line{display:flex;align-items:baseline;gap:8px;margin:0 0 14px;min-width:0}
.brand-name{
  font-family:var(--wordmark);
  font-size:15px;
  font-weight:800;
  letter-spacing:-0.025em;
  white-space:nowrap;
}
.brand-tag{font-size:12px;color:var(--text-faint);white-space:nowrap}
.state{margin:0 0 4px;font-size:13px;font-weight:600}
.state[data-tone="neutral"]{color:var(--text-faint)}
.state[data-tone="info"]{color:var(--lamp)}
.state[data-tone="warn"]{color:var(--warn)}
.state[data-tone="stop"]{color:var(--stop)}
h1{
  margin:0;
  font-family:var(--wordmark),var(--font);
  font-size:25px;
  font-weight:700;
  line-height:1.3;
  letter-spacing:-0.02em;
  text-wrap:balance;
}
.status{margin:0;max-width:52ch;font-size:14px;line-height:1.7;color:var(--text-dim)}
.sheet{background:var(--panel);border:1px solid var(--line);border-radius:var(--surface-radius);overflow:hidden}
.steps{list-style:none;margin:0;padding:0}
.step{
  position:relative;
  display:grid;
  grid-template-columns:32px minmax(0,1fr) auto;
  column-gap:12px;
  align-items:center;
  padding:12px 20px;
  transition:background .3s;
}
.step+.step{border-top:1px solid var(--line)}
.step::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent}
.cue{font-family:var(--mono);font-size:12px;font-weight:600;color:var(--text-faint);font-variant-numeric:tabular-nums}
.step-name{min-width:0;font-size:14px;font-weight:500;color:var(--text-faint)}
.step-state{font-size:12px;font-weight:500;color:var(--text-faint);white-space:nowrap}
.step[data-state="done"] .cue{color:var(--text-dim)}
.step[data-state="done"] .step-name{color:var(--text-muted)}
.step[data-state="done"] .step-state{color:var(--text-dim)}
.step[data-state="current"]{background:color-mix(in srgb,var(--lamp) 7%,transparent)}
.step[data-state="current"]::before{background:var(--lamp)}
.step[data-state="current"] .cue,
.step[data-state="current"] .step-state{color:var(--lamp)}
.step[data-state="current"] .step-name{color:var(--text)}
.step[data-state="stopped"]{background:color-mix(in srgb,var(--stop) 8%,transparent)}
.step[data-state="stopped"]::before{background:var(--stop)}
.step[data-state="stopped"] .cue,
.step[data-state="stopped"] .step-state{color:var(--stop)}
.step[data-state="stopped"] .step-name{color:var(--text)}
.meta{display:flex;flex-wrap:wrap;gap:6px 24px;min-width:0;margin-top:-12px;padding:0 4px}
.meta-item{display:flex;align-items:baseline;gap:8px;min-width:0}
.meta-label{font-size:12px;color:var(--text-faint)}
.meta-value{font-size:13px;color:var(--text-dim);font-variant-numeric:tabular-nums}
.meta-value[data-tone="warn"]{color:var(--warn)}
.meta-value[data-tone="stop"]{color:var(--stop)}
.cleanup{padding:18px 20px 16px}
.cleanup-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.cleanup h2{margin:0;font-size:14px;font-weight:600}
.chip{
  border:1px solid var(--line-strong);
  border-radius:999px;
  padding:1px 10px;
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
.actions{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin:-8px 0 0}
.actions button{
  font:inherit;
  font-size:14px;
  font-weight:600;
  color:var(--bg);
  background:var(--text);
  border:0;
  border-radius:var(--control-radius);
  padding:10px 18px;
  cursor:pointer;
}
.actions button:hover{background:#ffffff}
.actions button:focus-visible{outline:2px solid var(--lamp);outline-offset:3px}
.actions .hint{margin:0;font-size:13px;line-height:1.6;color:var(--text-dim)}
.foot{margin:0;padding:0 4px;display:flex;gap:6px;font-size:11px;color:var(--text-faint)}
.foot .mono{font-size:11px}
@media (max-width:480px){
  .shell{padding:36px 20px 24px;gap:22px}
  .hero{column-gap:16px}
  .mark{width:68px;height:68px}
  .brand-line{margin-bottom:8px}
  h1{font-size:20px}
  .step{padding:11px 16px;grid-template-columns:28px minmax(0,1fr) auto}
  .cleanup{padding:16px}
}
</style>
</head>
<body>
<main class="shell">
<header class="hero">
<svg class="mark" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
<path class="ring ring-base" pathLength="100" d="M77.9 30.5 A34 34 0 0 0 16 50 A26 26 0 0 0 68 50"></path>
<path class="ring ring-fill" pathLength="100" d="M77.9 30.5 A34 34 0 0 0 16 50 A26 26 0 0 0 68 50"></path>
<circle class="halo" cx="42" cy="50" r="16"></circle>
<circle class="lamp" cx="42" cy="50" r="8.5"></circle>
</svg>
<div>
<p class="brand-line"><span class="brand-name">CUELO</span><span class="brand-tag">업데이트</span></p>
<p class="state" id="state" data-tone="neutral">상태 확인 중</p>
<h1 id="task-title">업데이트 상태를 확인하고 있습니다</h1>
</div>
</header>
<p class="status" id="status" role="status" aria-live="polite">이 탭은 업데이트가 끝나면 같은 작업 화면으로 자동 복귀합니다.</p>
<div class="actions" id="failure-actions" hidden>
<button type="button" id="return-button">작업 화면으로 돌아가기</button>
<p class="hint" id="failure-hint" hidden></p>
</div>
<section class="sheet" aria-label="업데이트 단계">
<ol class="steps" id="steps">
<li class="step" data-state="pending"><span class="cue" aria-hidden="true">Q1</span><span class="step-name">세션 정지</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="cue" aria-hidden="true">Q2</span><span class="step-name">교체 준비</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="cue" aria-hidden="true">Q3</span><span class="step-name">패키지 교체</span><span class="step-state">대기</span></li>
<li class="step" data-state="pending"><span class="cue" aria-hidden="true">Q4</span><span class="step-name">새 버전 확인</span><span class="step-state">대기</span></li>
</ol>
</section>
<div class="meta">
<span class="meta-item"><span class="meta-label">화면 경과</span><span class="meta-value" id="elapsed">0초</span></span>
<span class="meta-item"><span class="meta-label">연결</span><span class="meta-value" id="link" data-tone="neutral">확인 중</span></span>
</div>
<section class="sheet cleanup" id="cleanup" aria-labelledby="cleanup-title" hidden>
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
let failureReleaseSeen=false;
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
/* 쓰기 차단이 풀린 것을 관측한 뒤에만 돌아갈 길을 준다. 버튼으로 바로 갈 수 있고, 다음
   확인에서 같은 상태와 원래 세션을 확인하면 자동으로 간다. */
function renderFailureReturnReady(sessionPending){
  failureActionsEl.hidden=false;
  returnButtonEl.hidden=false;
  failureHintEl.hidden=false;
  failureHintEl.textContent=sessionPending
    ?"원래 세션을 아직 확인하지 못했습니다. 확인되면 자동으로 돌아갑니다. 바로 가려면 버튼을 누르세요."
    :"잠시 뒤 원래 작업 화면으로 자동으로 돌아갑니다.";
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

/* 이 탭의 원래 세션이 지금 응답하는 서버에 같은 id로 있는지. 세션 없는 화면은 확인할 것이 없다. */
async function sessionMatches(){
  if(!state.sessionId)return true;
  try{
    const detail=await fetch("/api/sessions/"+encodeURIComponent(state.sessionId)+"?deferThinking=1&deferMedia=1",{cache:"no-store",headers:{"Cache-Control":"no-cache"}});
    if(!detail.ok)return false;
    const session=await detail.json();
    return session.sessionId===state.sessionId;
  }catch{
    return false;
  }
}
async function confirmResume(){
  if(resumeConfirmed)return true;
  if(confirmingResume)return false;
  confirmingResume=true;
  try{
    if(!(await sessionMatches()))return false;
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
   그대로 실패를 보여 준다 — 통지는 부가 기능이다. 서버는 원래 세션에 run을 세운 뒤에 답한다.
   돌아간 앱의 Wake는 GET·SSE로 그 세션을 다시 읽기만 하고 명령을 보내지 않으므로, 서버가
   run을 세우지 않았다고 확정해 답한 경우만 빼고(응답 유실·오류 포함) 깨우라고 복귀 기록에
   남긴다. 키는 lib/update-maintenance-client.ts의 FAILURE_RETURN_KEY와 같다. */
async function notifyFailureOnce(){
  if(failureNotified)return;
  failureNotified=true;
  if(!state.requestId||!state.clientId)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),POLL_TIMEOUT_MS);
  let wake=true;
  try{
    const response=await fetch("/api/update-maintenance",{
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
    const result=response.ok?await response.json():null;
    const notice=result&&result.notice;
    if(notice&&notice.notice===false&&(notice.reason==="no-terminal-result"||notice.reason==="deployment-succeeded"||notice.reason==="no-initiator"))wake=false;
  }catch{
    /* 통지 실패는 실패 표시를 막지 않는다. */
  }finally{
    clearTimeout(timer);
  }
  try{
    sessionStorage.setItem("ompweb-update-failure-return-v1",JSON.stringify({
      schemaVersion:1,
      requestId:state.requestId,
      stageHash:state.stageHash,
      clientId:state.clientId,
      sessionId:state.sessionId,
      wake:wake
    }));
  }catch{
    /* 저장이 막히면 돌아간 앱은 기존 복귀 확인으로 떨어진다. 실패 표시는 그대로다. */
  }
}
/* 종료 상태가 실패일 때의 화면과 다음 확인 간격을 정한다. 쓰기 차단이 풀린 것을 처음 본
   응답에서는 버튼과 안내만 띄우고, 다음 신선한 응답도 실패·차단 해제이며 원래 세션이
   확인되면 그 세션 화면으로 돌아간다. 잠겨 있거나 값이 없으면 실패 표시를 유지한 채 확인을
   이어간다 — 그 순간 루프를 끊으면 버튼이 영영 안 뜨는 또 하나의 무한대기가 된다. */
async function applyFailure(body){
  failed=true;
  await notifyFailureOnce();
  renderFailed(body);
  renderLink();
  if(body.mutationBlocked!==false){
    failureReleaseSeen=false;
    renderFailureWaitingForRelease();
    return POLL_RETRY_MS;
  }
  if(failureReleaseSeen&&await sessionMatches()){
    stopped=true;
    location.replace(state.resumeUrl);
    return null;
  }
  renderFailureReturnReady(failureReleaseSeen);
  failureReleaseSeen=true;
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
    /* 무응답 사이에 서버 상태가 바뀌었을 수 있으므로 자동 복귀는 다시 두 번의 응답을 본다. */
    failureReleaseSeen=false;
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
