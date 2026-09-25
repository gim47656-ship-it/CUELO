#!/usr/bin/env node

// 정본 하네스 정책의 구조 검사기.
//
// 이 검사기는 정책이 "무엇을 말하는지"를 다시 적지 않는다. 예전에는 harness-policy.json 의
// 객체 전체와 config.yml 의 모델·effort 값, 그리고 AGENTS.md·SOP·notices 의 문장을
// 정규식으로 다시 박아 두었다. 그 결과 정책 문구 한 줄을 고칠 때마다 같은 뜻을 이 파일과
// 생성물에 다시 써야 했고, 검사기는 드리프트가 아니라 표현 변경을 잡아 재작업을 키웠다.
//
// 여기서 지키는 것은 표현이 아니라 계약의 구조다.
//   - 정책 JSON 의 구조적 유효성(키 집합, 타입, 필수 라우팅 모드)
//   - 참조 해석 가능성(*ConfigPath -> config.yml, 역할 이름 -> agent/sop + agent/agents)
//   - 금지된 권한(정책 선언과 생성물 도구 목록 불일치, 역할에 승인되지 않은 도구)
//   - 승인 경계와 high-risk 검수 의무(Main 소유)
// 모델·effort 정본은 config.yml 이고 생성물과의 일치는 `node patches/build-agents.mjs --check`
// 가 바이트로 증명한다. 현재 Main·Maker 기준선도 아래 계약과 대조한다.
//
//   node patches/validate-harness-policy.mjs [--json] [--root <경로>]

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cliArguments = process.argv.slice(2);
let root = defaultRoot;
let requestedJson = false;
const unknownArguments = [];
for (let index = 0; index < cliArguments.length; index += 1) {
  const argument = cliArguments[index];
  if (argument === "--json") {
    requestedJson = true;
    continue;
  }
  if (
    argument === "--root" &&
    index + 1 < cliArguments.length &&
    !cliArguments[index + 1].startsWith("--")
  ) {
    root = resolve(cliArguments[index + 1]);
    index += 1;
    continue;
  }
  unknownArguments.push(argument);
}

const policyPath = "agent/rules/harness-policy.json";
const configPath = "agent/config.yml";
const taskGuardSourcePath = "agent/extensions/command-guard/task-guard.ts";
const taskGuardRulePath = "agent/rules/task-guard.md";
// 발주 지침이 사는 자리들. guard template(정본)과 그것을 실제 발주에 쓰는 두 안내가 갈라지면
// producer는 필수 규칙을 따랐는데 카드 제목이 비는 모순이 다시 생긴다.
const dispatchGuidePaths = ["agent/AGENTS.md", "agent/rules/subagent.md"];
// 준비 참조 계약의 실제 소비자. 정본이 이 경로를 가리키므로 식별자 존재를 여기서 대조한다.
const preparedTaskSourcePath = "agent/extensions/lib/prepared-task.ts";
const makerRoutingSourcePath = "agent/extensions/lib/maker-routing.ts";
const expectedConcurrencyPath = "task.maxConcurrency";
const errors = [];
let checkCount = 0;

// 최상위 키 집합은 구조다. 값이 아니라 절(節)이 사라지거나 오타로 늘어나는 것을 막는다.
const expectedTopLevelKeys = [
  "approvalBoundaries",
  "briefContextRelay",
  "gitFinalization",
  "implementationOwnership",
  "industrialHighRisk",
  "mainLane",
  "maxConcurrencyConfigPath",
  "projectValidation",
  "requiredBriefContext",
  "repeatVsDiagnosis",
  "roles",
  "routing",
  "sameFailureLimit",
  "schemaVersion",
  "validationCadence",
];

const requiredRoutingModes = [
  "reviewPacket",
  "actualSurfaceValidation",
  "routine",
  "large",
  "high-risk",
];

// 역할 종류는 Main·maker 둘뿐이다. 여기 적힌 이름 외의 child 역할이 정책에 다시 생기거나,
// 은퇴한 역할의 정의 파일이 되살아나는 것이 이 검사기가 막는 드리프트다.
const canonicalRoles = ["main", "maker"];
const retiredRoles = ["planner", "scout", "designer", "interaction-tester", "validator", "maker-deep", "checker-deep", "sonic", "checker"];


// 정책이 역할 이름을 담는 자리. 여기 적힌 이름은 실제 역할이거나 `main` 이어야 한다.
const roleReferencePaths = [
  "projectValidation.executionOwner",
  "projectValidation.decisionOwner",
  "projectValidation.routineOwner",
  "implementationOwnership.ordinaryOwner",
  "implementationOwnership.reviewOwner",
  "implementationOwnership.integrationOwner.role",
  "routing.actualSurfaceValidation.executionOwner",
  "routing.actualSurfaceValidation.decisionOwner",
  "routing.actualSurfaceValidation.routineOwner",
  "routing.actualSurfaceValidation.codeAndPolicyReviewOwner",
  "routing.routine.implementation",
  "routing.routine.finalDecisionOwner",
  "routing.large.implementation",
  "routing.large.reviewRouting.integrationRisk.reviewer",
  "routing.large.finalDecisionOwner",
  "routing.high-risk.implementation",
  "routing.high-risk.reviewer",
  "routing.high-risk.finalDecisionOwner",
];

// 실행·수정 도구를 절대 가질 수 없는 읽기 전용 역할. 지금은 그런 역할이 없다 - 검수도 Main이
// 실행 레인 안에서 소유하므로 도구를 뺏을 별도 역할이 존재하지 않는다. 목록이 비어 있어도
// 검사 자체는 남겨 둔다: 읽기 전용 역할이 다시 생기면 그 자리에서 권한 경계가 강제된다.
const executionForbiddenRoles = [];
const executionTools = ["bash", "eval", "edit", "write", "lsp", "sonic", "task"];

// 정책이 선언한 도구 목록 <-> 생성물 머리말. 두 곳이 갈라지면 권한 경계가 문서에만 남는다.
const policyToolContracts = [
  ["maker", "routing.actualSurfaceValidation.tools"],
];

// 편집 전 조향 체크포인트와 high-risk 사전 승인 계약의 payload.
// analyzer가 인식하는 라벨을 그대로 담는다 - maker가 형식을 모르면 그 DM은 통째로 무효가 되고,
// 확정 delta의 `REVISION:`과 같은 구조 계약이다. 라벨 문자열은 관측 정본인
// `evals/analyze-evals.mjs`의 STEERING_* 판정과 1:1이어야 하며, 여기서 그 정규식을 복제하지 않는다.
const preEditPayloadItems = [
  "location-locator - 위치: or LOCATION: - an artifact:// agent:// or local:// url, or a file path with a selector like src/plc.ts:42-58",
  "invariants - 불변식: or INVARIANTS: - one or more items enumerated with -, *, •, 1. or 1)",
  "behaviour-change - 동작 변화: or 동작: or BEHAVIOUR CHANGE: or BEHAVIOR: - one line",
  "check-command - 검사 명령: or 검사: or CHECK COMMAND: or CHECK: - the planned command",
];
// 라벨 집합 자체가 사라지면 그 항목은 영원히 incomplete다. 정책 값에 이 문자열들이 남아 있는지만 본다.
const preEditPayloadLabels = [
  "위치:",
  "LOCATION:",
  "불변식:",
  "INVARIANTS:",
  "동작 변화:",
  "동작:",
  "BEHAVIOUR CHANGE:",
  "BEHAVIOR:",
  "검사 명령:",
  "검사:",
  "CHECK COMMAND:",
  "CHECK:",
];

// 안전·승인·검수 의미가 걸린 machine ID. 목록을 늘리는 것은 자유이고, 여기 적힌 항목이 빠지면
// 승인 경계나 검수 대상이 조용히 사라진다. 산문 문구가 아니라 식별자만 본다.
const requiredPolicyMembers = [
  ["approvalBoundaries", ["deletion", "deployment", "cost-incurrence", "compatibility-break"]],
  ["industrialHighRisk", [
    "direct-equipment-operation-or-output",
    "pc-controlled-production-state-transitions",
    "product-quality-formulas-verdicts-or-calibration",
    "measurement-data-loss-duplication-or-corruption",
    "irreversible-data-or-configuration-compatibility",
    "physical-safety-interlocks-or-outputs",
  ]],
  ["projectValidation.forbidden", ["other-owners-files", "install", "deploy", "commit", "verdict"]],
  ["routing.actualSurfaceValidation.actionsRequiringExplicitBriefAndApplicableUserApproval", [
    "deploy",
    "delete",
    "spend-money",
    "send-model-prompts",
    "change-credentials",
    "destructive-or-irreversible-app-actions",
  ]],
  ["routing.large.reviewRouting.integrationRisk.triggers", [
    "public-or-shared-interface",
    "cross-module-contract",
    "shared-state",
    "data-flow",
    "complex-state-transition",
    "multiple-maker-changes-converging-on-one-execution-path",
    "meaningful-existing-caller-regression-risk",
    "auth-authz-or-secret-review",
    "main-cannot-close-with-provided-evidence",
  ]],
  ["routing.high-risk.triggers", [
    "repository-material-risk",
    "industrial-material-risk",
    "legacy-source-encoding-compatibility",
  ]],
  ["routing.reviewPacket.validationEvidence", [
    "slice-id",
    "exact-command",
    "exit-status",
    "raw-output-artifact-or-locator",
  ]],
  // 발주가 사용자 요구에서 벗어났는지 확인하는 세 축. 항목이 빠지면 "Main이 정한 과제"만 검사하고
  // "그 과제가 요구와 맞는지"는 아무도 보지 않는 상태로 조용히 돌아간다.
  ["briefContextRelay.preDispatchCrossCheck", [
    "requirement-omission",
    "unverified-assertion-as-settled-fact",
    "arbitrary-scope-or-acceptance-change",
  ]],
  // 실행 환경이 아니라 고치는 코드의 성질로 high-risk를 판정하는 자리. Main 지침과 하위 역할
  // 지침이 같은 정본을 읽어야 기준이 갈라지지 않는다. 항목은 도메인 중립 분류이며, 프로젝트별
  // 구체 목록은 프로젝트 저장소의 AGENTS.md가 이 분류에 사상한다(여기에 복사하지 않는다).
  ["routing.high-risk.materialRiskDefinition.codeNatureTriggers", [
    "irreversible-state-change",
    "external-side-effect",
    "correctness-defines-product-meaning",
    "state-machine-transition",
    "trust-boundary",
    "compatibility-break",
    "artifact-representation",
  ]],
  ["requiredBriefContext", [
    "repository-scope",
    "user-intent-and-acceptance",
    "preserved-behavior",
    "interfaces-and-ownership",
    "risk-and-approval",
    "validation",
    "language",
    "applicable-upstream-decisions-and-evidence",
  ]],
  ["routing.actualSurfaceValidation.briefRequired", [
    "actual-surface",
    "allowed-actions",
    "expected-observations",
    "artifact-destination",
    "approval-state",
  ]],
  ["projectValidation.evidence", [
    "slice-id",
    "covered-revision-and-inputs",
    "exact-command",
    "cwd",
    "exit-status",
    "duration",
    "concise-observation",
    "raw-artifact-locator",
    "reused-evidence-and-basis",
    "unverified-conditions",
  ]],
  ["routing.reviewPacket.facts", [
    "target-and-contract",
    "changed-paths",
    "final-diff",
    "impact-boundary",
    "validation-evidence",
    "known-unverified",
  ]],
  // 확인된 delta를 owner가 Main에게 넘기는 한 통의 내용물. 이 항목이 줄면 중간 검수가 볼 좌표
  // (어느 revision의 어느 경로를, 어떤 미완 검사와 함께)가 조용히 빠져 Main이 다시 캐묻는다.
  ["mainLane.workerReview.deliveryGuarantee.payload", [
    "revision-id",
    "changed-paths",
    "validation-state-with-each-pending-check-owner",
    "evidence-locators",
  ]],
  // 같은 채널을 단계 진행 보고로 늘리는 것을 막는 항목. 빠지면 저장할 때마다의 알림이나 diff
  // 본문이 허용된 전달로 읽혀, 한 revision 한 통이라는 계약이 무의미해진다.
  ["mainLane.workerReview.deliveryGuarantee.prohibited", [
    "per-file-save-notice",
    "per-step-progress-chatter",
    "inline-diff-or-raw-output-body",
    "second-dm-for-an-unchanged-revision",
  ]],
  // Main이 high-risk를 만지는 두 지점. 한쪽이 빠지면 "다 만든 뒤에야 처음 본다"는 실패 모드로
  // 되돌아가므로 지점 이름 자체를 식별자로 고정한다.
  ["routing.high-risk.mainIntervention.points", [
    "pre-edit-contract",
    "post-convergence-serial-review",
  ]],
  // 편집 전 한 통에 들어가야 하는 것. 이 항목이 줄면 Main이 위치·불변식 없이 승인하게 되어
  // 최종 drift 검수가 대조할 기준을 잃는다. 조향 체크포인트도 같은 4항목을 쓴다.
  ["routing.high-risk.mainIntervention.preEditContract.payload", preEditPayloadItems],
  // 이 채널이 diff·raw output 운반으로 늘어나면 Main 문맥이 child 산출물로 채워진다.
  ["routing.high-risk.mainIntervention.preEditContract.prohibited", [
    "diff-body",
    "raw-output",
    "file-contents",
    "second-dm-per-edit-step",
  ]],
  ["mainLane.workerReview.steeringCheckpoint.payload", preEditPayloadItems],
  ["mainLane.workerReview.steeringCheckpoint.prohibited", [
    "diff-body",
    "raw-output",
    "file-contents",
    "second-dm-per-edit-step",
  ]],
  ["routing.typedJudgmentRouting.deterministicAuthority", [
    "exit-status",
    "file-existence-and-content",
    "path-ownership",
    "task-guard-lock-budget-owned-paths-and-finding-id",
    "user-requirement-cross-check",
    "permission-and-approval",
    "test-result",
    "deployment-approval",
    "high-risk-classification",
    "final-verdict",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.questions", [
    "duplicate-or-overlapping-with-an-existing-maker",
    "additional-instruction-to-an-existing-maker-is-sufficient",
    "identifiable-existing-owner-for-this-slice",
    "maker-class-choice-NORMAL-HARD",
    "hard-dominant-judgment-UI_UX-CODE_SYSTEM-MIXED-UNKNOWN",
    "independent-concrete-effort-choice-for-each-candidate-profile",
    "proposed-scope-conflicts-with-applicable-skill-or-user-contract",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.decisionMapping", [
    "instruct-or-retarget-an-existing-owner-only-when-duplicate-or-additional-instruction-is-true-and-an-identifiable-existing-owner-resolves-otherwise-dispatch-new",
    "duplicate-or-additional-instruction-true-without-an-identifiable-existing-owner-never-selects-an-owner",
    "otherwise-main-selects-one-maker-model-and-its-supported-concrete-effort-from-the-batch-and-passes-an-explicit-model-selector",
    "applicable-skill-or-user-contract-conflict-true-main-resolves-the-specific-conflict-before-the-affected-dispatch-never-let-judge-relax-the-contract",
  ]],
  // 기존 owner 지시는 구조 사실만 로컬 관측한다. 의미와 정식 assessment 필요성은
  // Main이 실제 지시를 보고 결정하며, 관측 불가만으로 judge 호출을 의무화하지 않는다.
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.questions", [
    "observable-action-scope-and-acceptance-signals-with-owned-path-overlap",
    "requested-meaning-and-material-scope-change-remain-unknown-without-semantic-facts",
    "formal-assessment-need-is-a-main-decision-not-inferred-from-structural-counts",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.decisionMapping", [
    "main-reads-the-actual-instruction-and-uses-existing-maker_route-only-when-new-semantic-facts-or-a-material-task-change-need-it-unknown-alone-does-not-require-a-call",
    "preserve-the-existing-owner-and-completed-owner-identity-unless-main-determines-a-real-ownership-change",
    "the-advisory-only-informs-main-s-next-action-it-never-approves-blocks-switches-a-model-or-selects-an-owner",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-retry.questions", [
    "authentication-or-provider-problem-versus-code-problem",
    "validation-environment-problem-rather-than-source-defect",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-retry.decisionMapping", [
    "the-owner-never-infers-same-underlying-cause-or-new-evidence-from-inputChanged-or-interveningTools-and-stops-the-identical-retry-when-the-cause-is-actually-the-same-and-no-new-evidence-or-condition-exists",
    "otherwise-change-the-next-action-from-the-new-evidence-and-use-authentication-or-provider-true-for-that-diagnostic-path-or-false-for-the-code-diagnostic-path",
    "deterministic-exit-status-and-the-actual-error-override-the-authentication-provider-versus-code-result",
    "validation-environment-true-first-repair-or-probe-the-identified-path-dependency-or-runtime-boundary-with-a-focused-command-before-repeating-the-heavy-check-never-edit-product-code-without-causal-evidence",
    "validation-weakening-or-skill-conflict-or-skill-application-blocked-true-hold-only-the-affected-action-and-send-main-one-existing-blocker-or-steering-notification-with-error-and-skill-locators-proposed-action-and-preserved-acceptance-conditions",
    "main-decides-retarget-or-approve-from-source-and-raw-evidence-independent-work-continues-judge-never-authorizes-skipping-a-required-check",
    "changing-or-disabling-a-required-validator-needs-main-prior-decision-even-if-judge-says-safe-or-is-unavailable",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-review.questions", [
    "requirements-and-evidence-are-aligned",
    "acceptance-condition-remains-unverified",
    "report-claims-exceed-observed-evidence",
    "validation-was-weakened-or-required-skill-risk-remains-unaddressed",
    "explicit-TODO_TASKS-lack-an-exact-current-todo-or-item-level-terminal-validation-evidence",
    "terminal-validation-still-claims-a-permission-wait-after-main-explicitly-released-the-focused-command",
  ]],
  ["routing.typedJudgmentRouting.placements.pre-review.decisionMapping", [
    "requirements-and-evidence-are-aligned-false-or-either-other-question-true-do-not-close-pass-and-request-the-exact-missing-evidence-or-send-the-delta-to-rework",
    "all-clear-continues-main-s-deterministic-review-and-never-automatically-passes",
    "validation-weakened-or-required-skill-risk-unaddressed-true-do-not-close-pass-recover-the-original-check-or-send-the-specific-delta-to-its-owner",
    "todo-progress-gap-true-main-distinguishes-the-spawn-bound-incarnation-from-current-TodoTracker-state-and-when-the-same-current-item-is-ready-uses-the-existing-exact-todo-done-operation-before-new-work-never-child-lifecycle-auto-completion-and-never-readds-or-reopens-a-user-removed-replaced-or-reopened-item",
    "validation-permission-conflict-true-main-confirms-the-current-release-and-the-owner-runs-the-authorized-exact-command-instead-of-waiting-again",
  ]],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.questions", [
    "assistant-stop-is-routine-local-confirmation-user-approval-user-choice-external-wait-finished-or-unknown",
  ]],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.decisionMapping", [
    "input-is-only-the-bounded-assistant-stop-summary-with-paths-urls-and-inline-literals-removed-never-full-conversation-user-prompt-TODO-body-code-or-authorization-material",
    "clearly-routine-local-confirmation-may-trigger-the-existing-continuation-message-without-granting-any-permission",
    "consequential-actions-provider-safety-approval-user-choice-external-wait-unknown-and-judge-failure-never-receive-automatic-approval-or-continuation",
    "genuine-new-input-session-change-or-TODO-change-cancels-the-pending-classification-and-discards-late-results",
    "existing-user-authorization-and-point-of-risk-confirmation-boundaries-remain-authoritative-regardless-of-model-family",
  ]],
  // 실장비 인계 한 통에 들어가야 하는 것. 이 항목이 줄면 "무엇을 켜고 무엇이 정상이며 언제 멈추는가"가
  // 빠진 인계가 되어, 사용자가 장비 앞에서 판단할 근거를 잃는다.
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.packet", [
    "what-to-power-on",
    "power-on-and-operate-order",
    "what-appears-when-correct",
    "what-means-stop-immediately-safety",
    "how-to-revert",
  ]],
  ["roles.set", ["main", "maker"]],
  ["roles.retired", [
    "planner",
    "scout",
    "designer",
    "interaction-tester",
    "validator",
    "maker-deep",
    "checker-deep",
    "sonic",
    "checker",
  ]],
];

// 이름이 바뀌면 권한·검수 주체가 달라지는 자리. 설치된 역할 해석만으로는 구현자가 자기 검수자가
// 되는 배치도 통과하므로 여기서 역할 identity를 고정한다.
const criticalRoleIdentities = [
  ["projectValidation.executionOwner", "maker"],
  ["projectValidation.decisionOwner", "main"],
  ["projectValidation.routineOwner", "main"],
  ["routing.actualSurfaceValidation.executionOwner", "maker"],
  ["routing.actualSurfaceValidation.decisionOwner", "main"],
  ["routing.actualSurfaceValidation.routineOwner", "main"],
  ["routing.actualSurfaceValidation.codeAndPolicyReviewOwner", "main"],
  ["routing.large.implementation", "maker"],
  ["routing.large.reviewRouting.integrationRisk.reviewer", "main"],
  ["routing.large.finalDecisionOwner", "main"],
  ["routing.high-risk.implementation", "maker"],
  ["routing.high-risk.reviewer", "main"],
  ["routing.high-risk.finalDecisionOwner", "main"],
  ["routing.routine.finalDecisionOwner", "main"],
  ["routing.routine.implementation", "main"],
  ["implementationOwnership.ordinaryOwner", "maker"],
  ["implementationOwnership.reviewOwner", "main"],
  ["implementationOwnership.integrationOwner.role", "maker"],
];

// 권한·승인·검수·증거 계약이 실제로 사는 중첩 자리. 문장 내용이 아니라 존재와 타입만 본다.
const requiredPolicyShapes = [
  ["projectValidation.sourceAccess", "string"],
  ["projectValidation.allowedWrites", "string"],
  ["projectValidation.forbidden", "list"],
  ["routing.actualSurfaceValidation.repositoryAccess", "string"],
  ["routing.actualSurfaceValidation.actionsRequiringExplicitBriefAndApplicableUserApproval", "list"],
  ["routing.reviewPacket.terminalEvidence", "string"],
  ["routing.reviewPacket.validationEvidence", "list"],
  ["routing.high-risk.unresolvedSafetyRisk", "string"],
  ["mainLane.workerReview.owner", "string"],
  ["mainLane.workerReview.scope", "string"],
  ["mainLane.workerReview.deliveryGuarantee.owner", "string"],
  ["mainLane.workerReview.deliveryGuarantee.when", "string"],
  ["mainLane.workerReview.deliveryGuarantee.channel", "string"],
  ["mainLane.workerReview.deliveryGuarantee.terminalDelta", "string"],
  ["roles.coreBuiltinAgents.suppression", "string"],
  ["roles.coreBuiltinAgents.restoredByFileDeletion", "list"],
  ["briefContextRelay.userRequirementVerbatim", "string"],
  ["briefContextRelay.acceptanceConditions", "string"],
  ["briefContextRelay.interpretationSeparation", "string"],
  ["briefContextRelay.acceptanceObservability", "string"],
  ["briefContextRelay.newContractEvidence", "string"],
  ["briefContextRelay.acceptanceChangeOwner", "string"],
  ["briefContextRelay.taskBriefLanguage", "string"],
  ["briefContextRelay.childVisibleLanguage", "string"],
  ["briefContextRelay.languageVerbatimCarveOut", "string"],
  ["briefContextRelay.conversationalStyle", "string"],
  ["briefContextRelay.bilingualFallback", "string"],
  ["mainLane.characterRouting.intentForms", "string"],
  ["mainLane.characterRouting.selectorSource", "string"],
  ["mainLane.characterRouting.toolCapableSummon", "string"],
  ["mainLane.characterRouting.webOnlySummon", "string"],
  ["mainLane.characterRouting.sessionSwitch", "string"],
  ["mainLane.characterRouting.anthropicAccountMapping", "string"],
  ["mainLane.characterRouting.failure", "string"],
  ["mainLane.characterRouting.conversationalPrecedence", "string"],
  ["mainLane.characterRouting.voiceEnforcement", "string"],
  ["routing.reviewPacket.acceptanceEvidenceMap", "string"],
  ["routing.reviewPacket.taskProgress.metadataLocation", "string"],
  ["routing.reviewPacket.taskProgress.taskTitle", "string"],
  ["routing.reviewPacket.taskProgress.todoTasks", "string"],
  ["routing.reviewPacket.taskProgress.stableIdentity", "string"],
  ["routing.reviewPacket.taskProgress.canonicalTodoSource", "string"],
  ["routing.reviewPacket.taskProgress.mainAcceptanceReceipt", "string"],
  ["routing.reviewPacket.taskProgress.neverAcceptance", "list"],
  ["routing.reviewPacket.taskProgress.terminalBinding", "string"],
  ["routing.reviewPacket.taskProgress.advisoryFlow", "string"],
  ["routing.reviewPacket.taskProgress.validationRelease", "string"],
  ["routing.reviewPacket.taskProgress.dedupe", "string"],
  ["routing.dispatchAssumptionCheck.owner", "string"],
  ["routing.dispatchAssumptionCheck.question", "string"],
  ["routing.dispatchAssumptionCheck.whenItMatches", "string"],
  ["routing.dispatchAssumptionCheck.whenItContradicts", "string"],
  ["routing.dispatchAssumptionCheck.neverBlocking", "string"],
  ["routing.dispatchAssumptionCheck.mainDuty", "string"],
  ["routing.typedJudgmentRouting.mode", "string"],
  ["routing.typedJudgmentRouting.backendConfigPath", "string"],
  ["routing.typedJudgmentRouting.evidence", "string"],
  ["routing.typedJudgmentRouting.input", "string"],
  ["routing.typedJudgmentRouting.batching", "string"],
  ["routing.typedJudgmentRouting.booleanActionThreshold", "string"],
  ["routing.typedJudgmentRouting.applicability", "string"],
  ["routing.typedJudgmentRouting.failure", "string"],
  ["routing.typedJudgmentRouting.telemetry", "string"],
  ["routing.typedJudgmentRouting.deterministicAuthority", "list"],
  ["routing.typedJudgmentRouting.neverEveryToolCall", "string"],
  ["routing.typedJudgmentRouting.skillSelection", "string"],
  ["routing.typedJudgmentRouting.authority", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.owner", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.when", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.questions", "list"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch.decisionMapping", "list"],
  ["routing.typedJudgmentRouting.placements.pre-retry.owner", "string"],
  ["routing.typedJudgmentRouting.placements.pre-retry.when", "string"],
  ["routing.typedJudgmentRouting.placements.pre-retry.questions", "list"],
  ["routing.typedJudgmentRouting.placements.pre-retry.decisionMapping", "list"],
  ["routing.typedJudgmentRouting.placements.pre-review.owner", "string"],
  ["routing.typedJudgmentRouting.placements.pre-review.when", "string"],
  ["routing.typedJudgmentRouting.placements.pre-review.questions", "list"],
  ["routing.typedJudgmentRouting.placements.pre-review.decisionMapping", "list"],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.owner", "string"],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.when", "string"],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.questions", "list"],
  ["routing.typedJudgmentRouting.placements.turn-end-confirmation.decisionMapping", "list"],
  // 런타임이 스스로 관측하는 경계와 그 밖에 남는 수동 경계. 이 구분이 사라지면 훅이 이미
  // 답한 질문을 지침이 다시 시키거나, 반대로 관측 불가 판단까지 자동으로 넘긴다.
  ["routing.typedJudgmentRouting.observation.autoBoundaries", "string"],
  ["routing.typedJudgmentRouting.observation.emission", "string"],
  ["routing.typedJudgmentRouting.observation.manualBoundary", "string"],
  ["routing.typedJudgmentRouting.observation.readAndSupplement", "string"],
  ["routing.typedJudgmentRouting.observation.runtimeSource", "string"],
  ["routing.typedJudgmentRouting.observation.retrySignals", "string"],
  ["routing.typedJudgmentRouting.observation.taskProgressSignals", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.owner", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.when", "string"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.questions", "list"],
  ["routing.typedJudgmentRouting.placements.pre-dispatch-existing-owner-message.decisionMapping", "list"],
  ["routing.high-risk.materialRiskDefinition.codeNatureAuthority", "string"],
  ["routing.high-risk.materialRiskDefinition.fixtureOrMockNeverReduces", "string"],
  ["routing.high-risk.materialRiskDefinition.modePrecedence", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.when", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.owner", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.channel", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.blocking", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.mainReply", "string"],
  ["routing.high-risk.mainIntervention.preEditContract.record", "string"],
  ["routing.high-risk.mainIntervention.finalReview.added", "string"],
  ["routing.high-risk.mainIntervention.finalReview.unapproved", "string"],
  ["routing.effortSelection.owner", "string"],
  ["routing.effortSelection.mechanism", "string"],
  ["routing.effortSelection.decidedAt", "string"],
  ["routing.effortSelection.gradingInput", "string"],
  ["routing.effortSelection.criteriaUse", "string"],
  ["routing.effortSelection.criteria.low", "string"],
  ["routing.effortSelection.criteria.medium", "string"],
  ["routing.effortSelection.criteria.high", "string"],
  ["routing.effortSelection.criteria.xhigh", "string"],
  ["routing.effortSelection.failure", "string"],
  ["routing.effortSelection.retry", "string"],
  ["routing.effortSelection.parallelism", "string"],
  ["routing.effortSelection.validationExecution", "string"],
  ["mainLane.workerReview.steeringCheckpoint.when", "string"],
  ["mainLane.workerReview.steeringCheckpoint.channel", "string"],
  ["mainLane.workerReview.steeringCheckpoint.blocking", "string"],
  ["mainLane.workerReview.steeringCheckpoint.mainReply", "string"],
  ["mainLane.workerReview.steeringCheckpoint.mainBatching", "string"],
  ["mainLane.workerReview.steeringCheckpoint.advisorRejected", "string"],
  ["mainLane.workerReview.steeringCheckpoint.silentApproval", "string"],
  ["mainLane.workerReview.steeringCheckpoint.unansweredAdvisory", "string"],
  ["routing.effortSelection.riskIsOrthogonal", "string"],
  ["mainLane.workerReview.purposeScope", "string"],
  ["mainLane.workerReview.composition", "string"],
  ["mainLane.workerReview.finalScope", "string"],
  ["routing.high-risk.materialRiskDefinition.projectOverlay", "string"],
  ["routing.high-risk.materialRiskDefinition.axesAreIndependent", "string"],
  // 사람만 할 수 있는 확인의 인계. 두 객체의 값이 비면 "넘긴다"는 조항만 남고 넘길 내용이 사라진다.
  ["implementationOwnership.writerValidation.userObservation.whenPreferred", "string"],
  ["implementationOwnership.writerValidation.userObservation.agentStillOwns", "string"],
  ["implementationOwnership.writerValidation.userObservation.agentScreenshotWhen", "string"],
  ["implementationOwnership.writerValidation.userObservation.handoffFormat", "string"],
  ["implementationOwnership.writerValidation.userObservation.neverBlocks", "string"],
  ["implementationOwnership.writerValidation.userObservation.groundTruth", "string"],
  ["implementationOwnership.writerValidation.userObservation.reporting", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.when", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.agentDone", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.state", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.packet", "list"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.closure", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.onFailure", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.safety", "string"],
  ["implementationOwnership.writerValidation.deviceVerificationHandoff.record", "string"],
  // 사용자가 최종 테스트에 참여하지 않을 때의 배분. 기준은 Main, 실행은 maker, 판정은 Main이라는
  // 세 문장이 비면 "사용자가 안 보니 통과"가 들어온다.
  ["implementationOwnership.writerValidation.userAbsentAcceptance.when", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.criteriaOwner", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.runner", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.independentRunnerWhen", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.runnerAuthority", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.evidence", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.verdict", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.stillUserOnly", "string"],
  ["implementationOwnership.writerValidation.userAbsentAcceptance.unreachable", "string"],
  // 검증 범위 계약과 명시적 인수 계약의 핵심 문장. 이 다섯 줄이 비면 "무엇을 다시 검사하는가"와
  // "무엇을 인수하는가"가 자리마다 달라진다.
  ["mainLane.ownershipScope", "string"],
  ["implementationOwnership.writerValidation.scopeDecision", "string"],
  ["implementationOwnership.writerValidation.acceptanceCheck", "string"],
  ["implementationOwnership.writerValidation.reuseScope", "string"],
  ["implementationOwnership.writerValidation.surfaceSetup", "string"],
  ["implementationOwnership.writerValidation.heavyArtifactOwner", "string"],
  ["implementationOwnership.writerValidation.staleEnvironment", "string"],
  // 관측 경계의 새 두 문장. 비면 구조 판정이 다시 외부 judge나 차단으로 흐른다.
  ["routing.typedJudgmentRouting.observation.localStructuralPlacements", "string"],
  ["routing.typedJudgmentRouting.observation.ownerMessageAdvisory", "string"],
];

// 확인된 delta 전달 계약의 자식 키 집합. 이 자리는 누가·언제·어떤 채널로 무엇을 보내고 무엇을
// 보내지 않는가를 담으므로, 키가 빠지면 그 조항 하나가 조용히 사라지고 낯선 키는 다른 계약을
// 몰래 들여온다. 그래서 다른 자리와 달리 키 집합을 정확히 대조한다.
const deliveryGuaranteeKeys = ["owner", "when", "channel", "payload", "prohibited", "terminalDelta"];

// 편집 전 개입 계약이 사는 자리들. 조향 체크포인트와 high-risk 사전 승인 계약은
// 같은 형식을 공유하므로, deliveryGuarantee와 마찬가지로 키 집합을 정확히 대조한다. 키가 빠지면
// 조항 하나가 조용히 사라지고, 낯선 키는 승인 조건을 몰래 바꾼다.
const mainInterventionKeys = ["points", "preEditContract", "finalReview"];
const preEditContractKeys = [
  "when",
  "owner",
  "channel",
  "payload",
  "prohibited",
  "blocking",
  "mainReply",
  "record",
];
const highRiskFinalReviewKeys = ["added", "unapproved"];
const effortSelectionKeys = [
  "owner", "mechanism", "decidedAt", "gradingInput", "criteriaUse", "criteria", "riskIsOrthogonal",
  "failure", "retry", "parallelism", "validationExecution",
];
const steeringCheckpointKeys = [
  "when",
  "channel",
  "payload",
  "prohibited",
  "blocking",
  "exemption",
  "mainReply",
  "mainBatching",
  "advisorRejected",
  "silentApproval",
  "unansweredAdvisory",
];
const characterRoutingKeys = [
  "intentForms",
  "selectorSource",
  "toolCapableSummon",
  "webOnlySummon",
  "sessionSwitch",
  "anthropicAccountMapping",
  "failure",
  "conversationalPrecedence",
  "voiceEnforcement",
];
// 최종 판정 직전의 stateless 상담 계약. child가 아니라 도구 없는 1회 질의이므로 TaskBudget이
// 세지 않는다 - 그래서 "판정을 대신 맡기지 않는다"와 "raw를 넣지 않는다"를 이 키집합이 지킨다.
// 키가 빠지면 상담이 사실상 검수 위임으로 번지고, 낯선 키는 다른 계약을 몰래 들여온다.
const finalVerdictConsultKeys = [
  "when",
  "useWhen",
  "neverAJustification",
  "channel",
  "notAChild",
  "input",
  "prohibited",
  "output",
  "evidence",
];

const typedJudgmentRoutingKeys = [
  "mode",
  "backendConfigPath",
  "evidence",
  "input",
  "batching",
  "booleanActionThreshold",
  "placements",
  "observation",
  "applicability",
  "failure",
  "telemetry",
  "deterministicAuthority",
  "neverEveryToolCall",
  "skillSelection",
  "authority",
];
const typedJudgmentPlacementKeys = ["pre-dispatch", "pre-dispatch-existing-owner-message", "pre-retry", "pre-review", "turn-end-confirmation"];
const typedJudgmentPlacementContractKeys = ["owner", "when", "questions", "decisionMapping"];

// 6 Pro 상담 자리 계약. 이 모델은 도구가 없고 왕복이 분 단위라 "어디에 두는가"가 곧 비용이다.
// 자리(placements)·트리거·상한·fail-open 중 하나라도 빠지면 상담이 전 세션으로 번지거나
// 응답 없는 탭 앞에서 세션이 멈춘다. 그래서 키 집합을 통째로 고정한다.
const web6ConsultKeys = [
  "what",
  "shape",
  "channel",
  "placements",
  "neverPlacedAt",
  "trigger",
  "input",
  "prohibited",
  "cap",
  "failOpen",
  "authority",
  "disclosure",
];

// 작성자 검증 계약의 자식 키 집합. 이 자리는 "검증을 어디까지 agent가 하고 무엇을 사람에게 넘기는가"를
// 담으므로, 키가 빠지면 그 조항 하나가 조용히 사라지고 낯선 키는 다른 계약을 몰래 들여온다.
const writerValidationKeys = [
  "owner",
  "scope",
  "scopeDecision",
  "acceptanceCheck",
  "reuseScope",
  "surfaceSetup",
  "heavyArtifactOwner",
  "endConditions",
  "staleEnvironment",
  "afterRework",
  "blanketSkipInstruction",
  "precedence",
  "projectWide",
  "sharedArtifactConflicts",
  "unchangedInput",
  "relatedDefects",
  "weakeningExpectationsOrHidingFailures",
  "evidence",
  "unrunConditions",
  "userObservation",
  "deviceVerificationHandoff",
  "userAbsentAcceptance",
];
// 검증 종료 조건은 변경 종류별로 갈린다. 네 칸 중 하나가 빠지면 그 종류의 변경이 조용히
// 더 무거운 검사나 더 가벼운 검사로 흘러간다 — 문서·문구 변경에 실제 화면 검사를 요구하거나,
// 국소 로직 변경을 diff 확인으로 닫는 식이다.
const writerValidationEndConditionKeys = ["docsAndComments", "screenText", "localLogic", "integration"];
// 명시적 소유권 인수 계약의 자식 키 집합. 인수 조건·인계물·제외 범위·사후 검증 규칙 중 하나가
// 빠지면 "Main이 작은 잔여 수정을 직접 마감한다"가 조건 없는 전면 인계로 읽힌다.
const mainTakeoverKeys = [
  "eligible",
  "precondition",
  "excluded",
  "excludedFallback",
  "concurrency",
  "afterTakeover",
  "evidenceRule",
];
// 준비 참조 복원과 판단 재사용 계약. 키 하나가 빠지면 복원 범위·오류 조건·재사용 범위 중 하나가
// 조용히 사라지고, 소비 경로가 바뀐 문장은 다음 발주를 막는다. 그래서 키 집합을 정확히 대조한다.
const preparedReferenceKeys = ["produce", "consume", "restore", "linkage", "errors", "sessionScope", "preserved"];
const preparedReferenceErrorKeys = [
  "mixed-full-and-reference-in-one-call",
  "variant-reference-syntax",
  "different-session-or-batch",
  "unknown-or-cleared-reference",
  "name-mismatch",
  "missing-session-id",
];
const judgmentReuseKeys = [
  "sameInputs",
  "policyOrCandidateChange",
  "ownerRevisionChange",
  "activeOwnerCollision",
  "sessionChange",
];
// 사람만 할 수 있는 확인을 agent가 흉내내지 않고 넘기는 두 계약. 같은 인계의 두 경우(사용자가 보는
// 화면, 실장비)이므로 둘 다 키 집합을 정확히 대조한다.
const userObservationKeys = [
  "whenPreferred",
  "agentStillOwns",
  "agentScreenshotWhen",
  "handoffFormat",
  "neverBlocks",
  "groundTruth",
  "reporting",
];
const deviceVerificationHandoffKeys = [
  "when",
  "agentDone",
  "state",
  "packet",
  "closure",
  "onFailure",
  "safety",
  "record",
];
// 사용자 미참여 인수 실행의 키 집합. 실행자를 구현자와 분리할 수 있다는 조항과 실행자가 판정하지
// 않는다는 조항이 함께 있어야 폐지한 검수 전용 역할이 이름만 바꿔 돌아오지 않는다.
const userAbsentAcceptanceKeys = [
  "when",
  "criteriaOwner",
  "runner",
  "independentRunnerWhen",
  "runnerAuthority",
  "evidence",
  "verdict",
  "stillUserOnly",
  "unreachable",
];

// 위임 판단 기준의 키 집합. 이 세 키는 문구가 아니라 **선택지 도메인**이다(runtime `decisionQuestions`가
// criteria 객체를 그대로 choice로 쓰고 `recommendations.delegation`으로 돌려준다). 키가 늘면 유령 선택지가
// 생기고, 키가 사라지면 기준이 조용히 약해진다.
const delegationCriteriaKeys = ["MAIN", "MAKER", "UNKNOWN"];

// 누적 child budget의 기계 판독 계약. 새 범용 숫자 설정 엔진을 만들지 않고 이 네 자리만 runtime과
// 운영 규칙에 맞춘다. 키가 늘면 역할별 예외 budget 같은 두 번째 계약이 조용히 생긴 것이므로 거부한다.
const taskBudgetKeys = [
  "runtimeLimits",
  "cancelRefundLimit",
  "redirectPreservesUsage",
  "concurrencyIsSeparate",
];
const taskBudgetRuntimeLimitKeys = ["primaryMaker", "reworkMaker", "total"];

// 역할이 실제로 가질 수 있는 도구. 금지 목록만 두면 새 도구(git_finalize 등)가 조용히 통과한다.
const roleToolAllowlists = {
  maker: ["read", "bash", "edit", "write", "grep", "glob", "lsp", "eval", "generate_image", "ast_grep", "ast_edit", "debug", "todo", "web_search", "checkpoint"],
};

const modelOrProviderIdPattern = /(?:\b(?:anthropic|openai(?:-codex)?|opencode(?:-[a-z]+)?|cursor)\/|\b(?:gpt|claude|gemini|grok|deepseek|qwen|kimi|glm|llama|mistral)-[a-z0-9._-]+)/i;
const allowedNumericPolicyPaths = new Set([
  "$.schemaVersion",
  "$.sameFailureLimit",
  "$.routing.taskBudget.runtimeLimits.primaryMaker",
  "$.routing.taskBudget.runtimeLimits.reworkMaker",
  "$.routing.taskBudget.runtimeLimits.total",
  "$.routing.taskBudget.cancelRefundLimit",
]);

function check(condition, message) {
  checkCount += 1;
  if (!condition) errors.push(message);
}

function readText(relativePath) {
  try {
    return readFileSync(join(root, relativePath), "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n");
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
    return "";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isStringList(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}


function valueAt(source, dottedPath) {
  let current = source;
  for (const key of dottedPath.split(".")) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function stripYamlComment(value) {
  let singleQuoted = false;
  let doubleQuoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'" && !doubleQuoted) singleQuoted = !singleQuoted;
    if (character === '"' && !singleQuoted && value[index - 1] !== "\\") {
      doubleQuoted = !doubleQuoted;
    }
    if (
      character === "#" &&
      !singleQuoted &&
      !doubleQuoted &&
      (index === 0 || /\s/.test(value[index - 1]))
    ) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function parseYamlScalar(value) {
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readYamlScalarAtPath(text, dottedPath) {
  const wanted = dottedPath.split(".");
  const stack = [];
  const lines = text.split("\n");

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (/^\t/.test(line)) {
      throw new Error(`${lineNumber + 1}행이 탭 들여쓰기를 사용한다.`);
    }

    const match = /^( *)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;

    const indent = match[1].length;
    const key = match[2];
    const rawValue = stripYamlComment(match[3]);
    while (stack.length > 0 && stack.at(-1).indent >= indent) stack.pop();

    const currentPath = [...stack.map((entry) => entry.key), key];
    if (currentPath.length === wanted.length && currentPath.every((part, index) => part === wanted[index])) {
      if (rawValue === "") {
        throw new Error(`${dottedPath}가 스칼라가 아니라 매핑이다.`);
      }
      return parseYamlScalar(rawValue);
    }

    if (rawValue === "") stack.push({ indent, key });
  }

  throw new Error(`${dottedPath}를 찾지 못했다.`);
}

// 정책 안에는 모델·공급자 id와 임의의 숫자가 없어야 한다. 모델 정본은 config.yml뿐이고,
// 숫자 한도는 runtime과 exact 일치를 검사하는 routing.taskBudget의 네 필드만 추가로 허용한다.
function scanPolicyData(value, dataPath = "$") {
  if (typeof value === "number") {
    check(
      allowedNumericPolicyPaths.has(dataPath),
      `${dataPath}에 허용되지 않은 숫자가 있다. 정책 숫자는 schemaVersion, sameFailureLimit, routing.taskBudget의 검증된 한도만 허용한다.`,
    );
    return;
  }

  if (typeof value === "string") {
    check(!modelOrProviderIdPattern.test(value), `${dataPath}에 모델 또는 공급자 id가 있다.`);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanPolicyData(entry, `${dataPath}[${index}]`));
    return;
  }

  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    scanPolicyData(entry, `${dataPath}.${key}`);
  }
}

/** `*ConfigPath` 로 끝나는 모든 키의 값을 모은다. 이 값은 config.yml 에서 해석돼야 한다. */
function collectConfigReferences(value, dataPath = "$", found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectConfigReferences(entry, `${dataPath}[${index}]`, found));
    return found;
  }
  if (!isPlainObject(value)) return found;
  for (const [key, entry] of Object.entries(value)) {
    if (key.endsWith("ConfigPath")) {
      // 값이 문자열이 아니어도 건너뛰지 않는다. 건너뛰면 `modelConfigPath: []` 같은 값이
      // "참조가 없음"으로 취급돼 해석 실패가 사라진다.
      found.push([`${dataPath}.${key}`, entry]);
      continue;
    }
    collectConfigReferences(entry, `${dataPath}.${key}`, found);
  }
  return found;
}

/** 생성물 머리말의 `tools: [...]` 목록. 없으면 null. */
function readAgentTools(role) {
  const text = readText(`agent/agents/${role}.md`);
  const match = /^tools:\s*\[([^\]]*)\]\s*$/m.exec(text);
  if (match === null) return null;
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}


/** 생성물 머리말의 `thinking-level:` 값. 없으면 null. */
function readAgentThinkingLevel(role) {
  const match = /^thinking-level:\s*(\S+)\s*$/m.exec(readText(`agent/agents/${role}.md`));
  return match === null ? null : match[1];
}


if (unknownArguments.length > 0) {
  errors.push(`알 수 없는 인자: ${unknownArguments.join(", ")}`);
}

const rawPolicy = readText(policyPath);
let policy = null;
if (rawPolicy !== "") {
  try {
    policy = JSON.parse(rawPolicy);
    if (!isPlainObject(policy)) {
      errors.push(`${policyPath}: 최상위 값은 객체여야 한다.`);
      policy = null;
    }
  } catch (error) {
    errors.push(`${policyPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  errors.push(`${policyPath}: 파일이 비어 있다.`);
}

// runtime 상수와 사람이 읽는 운영 규칙을 좁은 정규식으로 읽는다. 이 값들은 policy의
// routing.taskBudget과 exact 일치해야 하며, 다른 정책 숫자를 읽는 범용 파서는 의도적으로 두지 않는다.
const rawTaskGuardSource = readText(taskGuardSourcePath);
const runtimeBudgetMatch =
  /export const TASK_BUDGET_LIMITS = Object\.freeze\(\{\s*primaryMaker:\s*(\d+),\s*reworkMaker:\s*(\d+),\s*total:\s*(\d+),\s*\}\);/m.exec(
    rawTaskGuardSource,
  );
const runtimeRefundMatch =
  /export const CANCEL_REFUND_LIMIT = (\d+);/.exec(rawTaskGuardSource);
const runtimeTaskBudget =
  runtimeBudgetMatch && runtimeRefundMatch
    ? {
        primaryMaker: Number(runtimeBudgetMatch[1]),
        reworkMaker: Number(runtimeBudgetMatch[2]),
        total: Number(runtimeBudgetMatch[3]),
        cancelRefundLimit: Number(runtimeRefundMatch[1]),
      }
    : null;
if (rawTaskGuardSource !== "" && runtimeBudgetMatch === null) {
  errors.push(`${taskGuardSourcePath}: TASK_BUDGET_LIMITS 정적 객체를 읽지 못했다.`);
}
if (rawTaskGuardSource !== "" && runtimeRefundMatch === null) {
  errors.push(`${taskGuardSourcePath}: CANCEL_REFUND_LIMIT 정적 상수를 읽지 못했다.`);
}

const rawTaskGuardRule = readText(taskGuardRulePath);
const ruleBudgetMatch =
  /runtime hard budget은 사용자 입력당 `primary Maker (\d+)`, `rework Maker (\d+)`, `총 child (\d+)`/.exec(
    rawTaskGuardRule,
  );
const ruleRefundMatch = /요청당 `(\d+)` 슬롯까지만 환불해/.exec(rawTaskGuardRule);
const ruleTaskBudget =
  ruleBudgetMatch && ruleRefundMatch
    ? {
        primaryMaker: Number(ruleBudgetMatch[1]),
        reworkMaker: Number(ruleBudgetMatch[2]),
        total: Number(ruleBudgetMatch[3]),
        cancelRefundLimit: Number(ruleRefundMatch[1]),
      }
    : null;
if (rawTaskGuardRule !== "" && ruleBudgetMatch === null) {
  errors.push(`${taskGuardRulePath}: runtime hard budget 문구에서 누적 한도를 읽지 못했다.`);
}
if (rawTaskGuardRule !== "" && ruleRefundMatch === null) {
  errors.push(`${taskGuardRulePath}: 취소 환불 상한 문구를 읽지 못했다.`);
}

// 발주 template과 그것을 실제 발주에 쓰는 안내가 같은 소비 계약을 봐야 한다. subagent 카드 제목은
// `TASK_GUARD` 밖의 공유 메타 `TASK_TITLE`에서 오고, 그 줄이 template에서 guard 필드 안쪽이나 앞으로
// 들어가면 소비자는 제목을 읽지 못하거나 뒤 guard 필드가 블록에서 잘린다. 소비자 파서를 여기서
// 다시 구현하지 않고, guard 필드 여섯 이름과의 순서만 본다.
const taskGuardFence = /```text\r?\n([\s\S]*?)```/.exec(rawTaskGuardRule);
const taskGuardTemplateLines = taskGuardFence
  ? taskGuardFence[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  : [];
const guardMarkerIndex = taskGuardTemplateLines.findIndex((line) => line === "TASK_GUARD:");
check(
  guardMarkerIndex >= 0,
  `${taskGuardRulePath}: 발주 template에서 TASK_GUARD 블록을 읽지 못했다(정본 template이 사라지면 producer가 필드 없이 발주한다).`,
);
const guardFieldNames = [
  "WORK_CLASS",
  "PURPOSE",
  "BLOCKS_PRIMARY",
  "PRIMARY_DELIVERABLE",
  "OWNED_PATHS",
  "FINDING_ID",
];
let guardFieldEnd = guardMarkerIndex;
while (
  guardFieldEnd + 1 < taskGuardTemplateLines.length &&
  guardFieldNames.some((name) => taskGuardTemplateLines[guardFieldEnd + 1].startsWith(`${name}:`))
) {
  guardFieldEnd += 1;
}
for (const name of ["TASK_TITLE", "TODO_TASKS"]) {
  const index = taskGuardTemplateLines.findIndex((line) => line.startsWith(`${name}:`));
  check(
    index > guardFieldEnd,
    `${taskGuardRulePath}: 발주 template의 ${name}이 마지막 guard 필드 뒤에 있지 않다(guard 필드로 만들거나 앞에 두면 카드 제목이 비거나 뒤 guard 필드가 블록에서 잘린다).`,
  );
}
// 정본 template을 가리키지 않는 안내는 producer가 필수 규칙을 지키고도 제목을 빠뜨리게 만든다.
for (const path of dispatchGuidePaths) {
  const guide = readText(path);
  check(
    guide.includes("rule://task-guard") && guide.includes("TASK_TITLE"),
    `${path}: 발주 지침이 rule://task-guard의 공유 메타(TASK_TITLE)를 가리키지 않는다(정본 template과 실제 발주 안내가 갈라진다).`,
  );
}

// 설치된 역할 정본. 조각과 생성물이 모두 있어야 정책이 그 이름을 라우팅에 쓸 수 있다.
const knownRoles = new Set();
const sopDirectory = join(root, "agent", "sop");
const agentsDirectory = join(root, "agent", "agents");
if (existsSync(sopDirectory) && existsSync(agentsDirectory)) {
  const fragments = new Set(
    readdirSync(sopDirectory)
      .filter((name) => name.endsWith(".md") && !name.startsWith("_"))
      .map((name) => name.slice(0, -3)),
  );
  for (const name of readdirSync(agentsDirectory).filter((name) => name.endsWith(".md"))) {
    const role = name.slice(0, -3);
    if (fragments.has(role)) knownRoles.add(role);
  }
} else {
  errors.push("agent/sop 또는 agent/agents 디렉터리가 없다.");
}

if (policy !== null) {
  const actualTopLevelKeys = Object.keys(policy).sort();
  check(
    actualTopLevelKeys.join("\u0000") === [...expectedTopLevelKeys].sort().join("\u0000"),
    `정책 최상위 키 집합이 다르다: ${actualTopLevelKeys.join(", ")}`,
  );
  check(policy.schemaVersion === 5, "schemaVersion은 5여야 한다.");
  check(
    Number.isSafeInteger(policy.sameFailureLimit) && policy.sameFailureLimit > 0,
    "sameFailureLimit는 양의 정수여야 한다.",
  );
  check(isStringList(policy.approvalBoundaries), "approvalBoundaries는 비지 않은 고유 문자열 목록이어야 한다.");
  check(isStringList(policy.industrialHighRisk), "industrialHighRisk는 비지 않은 고유 문자열 목록이어야 한다.");
  check(isStringList(policy.requiredBriefContext), "requiredBriefContext는 비지 않은 고유 문자열 목록이어야 한다.");
  check(
    policy.maxConcurrencyConfigPath === expectedConcurrencyPath,
    `maxConcurrencyConfigPath는 "${expectedConcurrencyPath}"여야 한다.`,
  );
  for (const key of ["repeatVsDiagnosis", "briefContextRelay", "gitFinalization", "mainLane", "projectValidation", "implementationOwnership", "validationCadence", "routing", "roles"]) {
    check(isPlainObject(policy[key]), `${key}는 객체여야 한다.`);
  }

  // 역할 종류는 정확히 Main·maker 둘이다. 늘어나면 2역할 계약이 조용히 깨진다.
  const declaredRoles = Array.isArray(policy.roles?.set) ? policy.roles.set : [];
  check(
    declaredRoles.length === canonicalRoles.length &&
      canonicalRoles.every((role, index) => declaredRoles[index] === role),
    `roles.set은 ${canonicalRoles.join(", ")} 순서 그대로여야 한다: ${declaredRoles.join(", ")}`,
  );
  for (const role of ["maker"]) {
    check(knownRoles.has(role), `roles.set의 ${role}에 해당하는 agent/sop + agent/agents 정의가 없다.`);
  }
  // 은퇴한 역할이 정의 파일로 되살아나면 선택 가능한 child가 다시 늘어난다.
  const revived = retiredRoles.filter((role) => knownRoles.has(role));
  check(revived.length === 0, `은퇴한 역할 정의가 남아 있다: ${revived.join(", ")}`);
  const unexpected = [...knownRoles].filter((role) => !canonicalRoles.includes(role));
  check(unexpected.length === 0, `허용되지 않은 역할 정의가 있다: ${unexpected.sort().join(", ")}`);
  check(
    valueAt(policy, "roles.main.thinkingConfigPath") === "defaultThinkingLevel",
    'roles.main.thinkingConfigPath는 "defaultThinkingLevel"이어야 한다.',
  );
  check(valueAt(policy, "roles.main.thinkingMode") === "auto", 'roles.main.thinkingMode는 "auto"여야 한다.');
  check(valueAt(policy, "roles.main.autoThinkingFloor") === null, "roles.main.autoThinkingFloor는 null이어야 한다.");
  check(
    valueAt(policy, "roles.maker.thinkingMode") === "dispatch-selected-concrete-effort",
    'roles.maker.thinkingMode는 "dispatch-selected-concrete-effort"여야 한다.',
  );
  check(
    valueAt(policy, "roles.maker.defaultThinkingLevel") === "medium" &&
      readAgentThinkingLevel("maker") === "medium",
    "Maker의 기본 추론은 medium이어야 한다.",
  );
  check(
    valueAt(policy, "roles.maker.effortLevels") === "resolved-model-supported-concrete-levels-not-a-fixed-coarse-mapping",
    "Maker 추론은 선택 모델의 지원 concrete level을 사용해야 한다.",
  );

  const routing = isPlainObject(policy.routing) ? policy.routing : {};
  for (const mode of requiredRoutingModes) {
    check(isPlainObject(routing[mode]), `routing.${mode}가 없거나 객체가 아니다.`);
  }

  const typedJudgmentRouting = valueAt(routing, "typedJudgmentRouting");
  check(isPlainObject(typedJudgmentRouting), "routing.typedJudgmentRouting이 없거나 객체가 아니다.");
  const actualTypedJudgmentKeys = isPlainObject(typedJudgmentRouting)
    ? Object.keys(typedJudgmentRouting).sort()
    : [];
  check(
    actualTypedJudgmentKeys.join("\u0000") === [...typedJudgmentRoutingKeys].sort().join("\u0000"),
    `routing.typedJudgmentRouting의 키 집합이 다르다: ${actualTypedJudgmentKeys.join(", ")}`,
  );
  const typedJudgmentPlacements = isPlainObject(typedJudgmentRouting?.placements)
    ? typedJudgmentRouting.placements
    : {};
  check(
    Object.keys(typedJudgmentPlacements).sort().join("\u0000") ===
      [...typedJudgmentPlacementKeys].sort().join("\u0000"),
    `routing.typedJudgmentRouting.placements의 키 집합이 다르다: ${Object.keys(typedJudgmentPlacements).sort().join(", ")}`,
  );
  const requiredMemberLookup = new Map(requiredPolicyMembers);
  for (const placement of typedJudgmentPlacementKeys) {
    const contract = isPlainObject(typedJudgmentPlacements[placement])
      ? typedJudgmentPlacements[placement]
      : {};
    check(
      Object.keys(contract).sort().join("\u0000") ===
        [...typedJudgmentPlacementContractKeys].sort().join("\u0000"),
      `routing.typedJudgmentRouting.placements.${placement}의 키 집합이 다르다: ${Object.keys(contract).sort().join(", ")}`,
    );
    for (const field of ["questions", "decisionMapping"]) {
      const path = `routing.typedJudgmentRouting.placements.${placement}.${field}`;
      check(
        JSON.stringify(contract[field]) === JSON.stringify(requiredMemberLookup.get(path)),
        `${path}가 live decision 계약과 다르다.`,
      );
    }
  }
  check(
    typedJudgmentPlacements["pre-dispatch"]?.owner === "main" &&
      typedJudgmentPlacements["pre-dispatch-existing-owner-message"]?.owner === "main" &&
      typedJudgmentPlacements["pre-retry"]?.owner === "the-owner-about-to-retry" &&
      typedJudgmentPlacements["pre-review"]?.owner === "main" &&
      typedJudgmentPlacements["turn-end-confirmation"]?.owner === "main",
    "typed judgment placement의 실행 주체가 다르다.",
  );
  check(
    typedJudgmentRouting?.mode === "live-decision-support",
    "typed judgment는 live-decision-support여야 한다.",
  );
  check(
    typedJudgmentRouting?.booleanActionThreshold ===
      "true-when-probability-is-greater-than-or-equal-to-0.5-false-otherwise",
    "typed judgment 확률형 bool은 0.5 이상일 때 true여야 한다.",
  );
  check(
    typedJudgmentRouting?.applicability ===
      "apply-a-result-only-when-any-owner-it-points-to-actually-exists-and-it-does-not-contradict-deterministic-evidence-otherwise-ignore-that-placement-result-and-run-the-existing-procedure",
    "typed judgment는 owner 부재나 deterministic evidence 모순에서 결과를 무시하고 기존 절차로 fail-open해야 한다.",
  );
  check(
    typedJudgmentRouting?.failure ===
      "judge-failure-timeout-or-missing-credentials-is-indeterminate-and-runs-the-existing-procedure-never-fall-back-to-a-general-model",
    "typed judgment 호출 실패·timeout·credential 부재는 기존 절차로 fail-open해야 한다.",
  );
  check(
    JSON.stringify(typedJudgmentRouting?.deterministicAuthority) ===
      JSON.stringify(requiredMemberLookup.get("routing.typedJudgmentRouting.deterministicAuthority")),
    "typed judgment deterministic authority 목록이 다르다.",
  );
  check(
    typedJudgmentRouting?.skillSelection === "candidate-advisory-only-never-an-automatic-gate",
    "skill selection은 후보 advisory만 허용하고 자동 gate를 금지해야 한다.",
  );
  check(
    typedJudgmentRouting?.authority ===
      "high-risk-classification-approval-and-final-acceptance-remain-main-authority",
    "high-risk 분류·승인·최종 수용은 Main 권한으로 남아야 한다.",
  );

  const taskBudget = valueAt(routing, "taskBudget");
  check(isPlainObject(taskBudget), "routing.taskBudget이 없거나 객체가 아니다.");
  const actualTaskBudgetKeys = isPlainObject(taskBudget)
    ? Object.keys(taskBudget).sort()
    : [];
  check(
    actualTaskBudgetKeys.join("\u0000") === [...taskBudgetKeys].sort().join("\u0000"),
    `routing.taskBudget의 키 집합이 다르다: ${actualTaskBudgetKeys.join(", ")}`,
  );
  const runtimeLimits = isPlainObject(taskBudget?.runtimeLimits)
    ? taskBudget.runtimeLimits
    : {};
  const actualRuntimeLimitKeys = Object.keys(runtimeLimits).sort();
  check(
    actualRuntimeLimitKeys.join("\u0000") ===
      [...taskBudgetRuntimeLimitKeys].sort().join("\u0000"),
    `routing.taskBudget.runtimeLimits의 키 집합이 다르다: ${actualRuntimeLimitKeys.join(", ")}`,
  );
  check(
    taskBudget?.redirectPreservesUsage === true,
    "routing.taskBudget.redirectPreservesUsage는 true여야 한다.",
  );
  check(
    taskBudget?.concurrencyIsSeparate === true,
    "routing.taskBudget.concurrencyIsSeparate는 true여야 한다.",
  );
  for (const [label, contract] of [
    [taskGuardSourcePath, runtimeTaskBudget],
    [taskGuardRulePath, ruleTaskBudget],
  ]) {
    if (contract === null) continue;
    for (const key of taskBudgetRuntimeLimitKeys) {
      check(
        runtimeLimits[key] === contract[key],
        `routing.taskBudget.runtimeLimits.${key}가 ${label}의 ${contract[key]}와 다르다.`,
      );
    }
    check(
      taskBudget?.cancelRefundLimit === contract.cancelRefundLimit,
      `routing.taskBudget.cancelRefundLimit가 ${label}의 ${contract.cancelRefundLimit}와 다르다.`,
    );
  }

  // routine: Main end-to-end 소유. 어떤 child 역할도 붙지 않는 것이 기본값이다.
  check(routing.routine?.default === true, "routing.routine.default는 true여야 한다.");
  check(
    isNonEmptyString(routing.routine?.childDispatch),
    "routing.routine.childDispatch 계약이 없다.",
  );

  // 검수 의무: integration-risk large 와 high-risk 는 검수를 잃을 수 없다. 검수 주체는 Main이다.
  const integrationRisk = valueAt(routing, "large.reviewRouting.integrationRisk") ?? {};
  const independentOnly = valueAt(routing, "large.reviewRouting.independentOnly") ?? {};
  check(integrationRisk.reviewRequired === true, "integration-risk large는 검수가 필수여야 한다.");
  check(isStringList(integrationRisk.triggers), "integration-risk large의 trigger 목록이 비었다.");
  check(independentOnly.reviewRequired === false, "independent-only large는 검수를 강제하지 않아야 한다.");
  check(routing["high-risk"]?.reviewRequired === true, "high-risk는 검수가 필수여야 한다.");
  check(routing["high-risk"]?.overlapAllowed === false, "high-risk는 검증·검수 overlap을 허용하면 안 된다.");
  check(
    isNonEmptyString(routing["high-risk"]?.reviewTiming) &&
      isNonEmptyString(routing["high-risk"]?.serialException),
    "high-risk의 직렬 안전 순서 계약이 없다.",
  );
  check(isStringList(routing["high-risk"]?.triggers), "high-risk trigger 목록이 비었다.");

  // 검수 주체는 Main 하나다. 검수는 구현과 분리된 별도 역할이 아니라 Main이 중간·최종 두 단계로
  // 소유하는 계약이므로, reviewer가 다른 이름이면 그 계약이 조용히 다른 주체로 옮겨간 것이다.
  for (const [label, reviewer] of [
    ["integration-risk large", integrationRisk.reviewer],
    ["high-risk", routing["high-risk"]?.reviewer],
  ]) {
    check(
      reviewer === "main",
      `${label}의 reviewer는 main이어야 한다(검수는 Main이 중간·최종으로 소유한다).`,
    );
  }

  // Main의 중간 검수 계약. 검수 주체가 사라진 자리를 이 계약이 대신하므로 owner·trigger·경계가
  // 모두 있어야 한다. 경계는 산문이 아니라 식별자 목록이므로 목록의 존재만 본다.
  const workerReview = valueAt(policy, "mainLane.workerReview");
  check(isPlainObject(workerReview), "mainLane.workerReview가 없거나 객체가 아니다.");
  check(
    workerReview?.owner === "main",
    'mainLane.workerReview.owner는 "main"이어야 한다(중간 검수는 Main이 소유한다).',
  );
  check(
    isStringList(workerReview?.triggers),
    "mainLane.workerReview.triggers는 비지 않은 고유 문자열 목록이어야 한다.",
  );
  check(
    isStringList(workerReview?.boundaries),
    "mainLane.workerReview.boundaries는 비지 않은 고유 문자열 목록이어야 한다.",
  );

  // 확정 delta는 owner가 Main에게 넘긴다. 이 전달자가 사라지면 "확정 변경분이 랜딩하면 검수한다"는
  // trigger는 문서에만 남고 실제로는 child의 terminal 결과까지 아무도 그 delta를 보지 않는다.
  const deliveryGuarantee = valueAt(policy, "mainLane.workerReview.deliveryGuarantee");
  check(
    isPlainObject(deliveryGuarantee),
    "mainLane.workerReview.deliveryGuarantee가 없거나 객체가 아니다.",
  );
  const actualGuaranteeKeys = isPlainObject(deliveryGuarantee)
    ? Object.keys(deliveryGuarantee).sort()
    : [];
  check(
    actualGuaranteeKeys.join("\u0000") === [...deliveryGuaranteeKeys].sort().join("\u0000"),
    `mainLane.workerReview.deliveryGuarantee의 키 집합이 다르다: ${actualGuaranteeKeys.join(", ")}`,
  );

  // 부모 알림 허용 목록과 그 채널은 한 쌍이다. 허용 항목과 전달 계약이 서로를 가리키지 않으면
  // "언제 보내는가"가 두 정본으로 갈라져 owner가 보낼지 말지 판단할 근거를 잃는다.
  const parentNotifications = valueAt(policy, "mainLane.parentNotifications");
  const allowedNotifications = Array.isArray(parentNotifications?.allowedOnly)
    ? parentNotifications.allowedOnly
    : [];
  check(
    allowedNotifications.includes("confirmed-delta-landed"),
    'mainLane.parentNotifications.allowedOnly에 "confirmed-delta-landed"가 없다(owner가 넘기는 확정 delta는 허용된 알림이다).',
  );
  check(
    isNonEmptyString(parentNotifications?.confirmedDeltaRelay) &&
      parentNotifications.confirmedDeltaRelay.includes("mainLane.workerReview.deliveryGuarantee"),
    "mainLane.parentNotifications.confirmedDeltaRelay가 mainLane.workerReview.deliveryGuarantee를 가리키지 않는다(두 키가 갈라지면 전달 조건이 두 정본이 된다).",
  );

  // 편집 전 조향 체크포인트를 알림 게이트가 막지 않아야 한다.
  check(
    allowedNotifications.includes("pre-edit-steering-checkpoint"),
    'mainLane.parentNotifications.allowedOnly에 "pre-edit-steering-checkpoint"가 없다(편집 전 조향 체크포인트 DM이 알림 게이트에 막힌다).',
  );
  for (const consumer of [
    "mainLane.workerReview.steeringCheckpoint",
    "routing.high-risk.mainIntervention.preEditContract",
  ]) {
    check(
      isNonEmptyString(parentNotifications?.preEditSteeringCheckpointRelay) &&
        parentNotifications.preEditSteeringCheckpointRelay.includes(consumer),
      `mainLane.parentNotifications.preEditSteeringCheckpointRelay가 ${consumer}를 가리키지 않는다(허용 항목과 소비처가 갈라지면 체크포인트 조건이 두 정본이 된다).`,
    );
  }

  // 사람만 할 수 있는 확인의 인계. state가 pending-user-device-check를 담지 않으면 그 항목이 PASS로
  // 닫히거나, 사용자 확인 없는 trigger 코드 live 승격이 열린다.
  const deviceHandoffState = valueAt(
    policy,
    "implementationOwnership.writerValidation.deviceVerificationHandoff.state",
  );
  check(
    isNonEmptyString(deviceHandoffState) && deviceHandoffState.includes("pending-user-device-check"),
    'implementationOwnership.writerValidation.deviceVerificationHandoff.state는 "pending-user-device-check"를 담아야 한다(실장비 확인 항목은 PASS가 아니다).',
  );
  // 인계 알림이 허용 알림 목록과 갈라지면 owner가 인계를 보낼지 판단할 근거를 잃거나, 반대로
  // 인계가 단계 진행 보고로 읽힌다.
  check(
    isNonEmptyString(parentNotifications?.deviceHandoffNotice) &&
      parentNotifications.deviceHandoffNotice.includes(
        "implementationOwnership.writerValidation.deviceVerificationHandoff",
      ),
    "mainLane.parentNotifications.deviceHandoffNotice가 implementationOwnership.writerValidation.deviceVerificationHandoff를 가리키지 않는다(허용 항목과 소비처가 갈라지면 인계 조건이 두 정본이 된다).",
  );

  // Main 개입 2지점·발주 등급 계약·작성자 검증 인계의 자리. 존재와 키 집합을 함께 본다: 키 하나가
  // 빠진 계약은 경고가 아니라 실패다. 그 자리가 곧 "언제 멈추고 무엇을 승인받으며 무엇을 사람에게
  // 넘기는가"이기 때문이다.
  for (const [path, expectedKeys, label] of [
    ["routing.high-risk.mainIntervention", mainInterventionKeys, "Main의 high-risk 2지점 개입"],
    ["routing.high-risk.mainIntervention.preEditContract", preEditContractKeys, "편집 전 승인 계약"],
    ["routing.high-risk.mainIntervention.finalReview", highRiskFinalReviewKeys, "최종 drift 검수"],
    ["routing.effortSelection", effortSelectionKeys, "발주 추론 계약"],
    ["mainLane.workerReview.steeringCheckpoint", steeringCheckpointKeys, "편집 전 조향 체크포인트"],
    ["implementationOwnership.writerValidation", writerValidationKeys, "작성자 검증 계약"],
    ["implementationOwnership.writerValidation.endConditions", writerValidationEndConditionKeys, "변경 종류별 검증 종료 조건"],
    ["implementationOwnership.reworkRouting.mainTakeover", mainTakeoverKeys, "명시적 소유권 인수 계약"],
    ["routing.modelSelection.preparedReference", preparedReferenceKeys, "준비 참조 복원 계약"],
    ["routing.modelSelection.judgmentReuse", judgmentReuseKeys, "판단 재사용·owner 충돌 계약"],
    ["routing.modelSelection.delegationCriteria", delegationCriteriaKeys, "위임 판단 기준(MAIN·MAKER·UNKNOWN)"],
    ["implementationOwnership.writerValidation.userObservation", userObservationKeys, "사용자 관찰 우선 계약"],
    ["implementationOwnership.writerValidation.deviceVerificationHandoff", deviceVerificationHandoffKeys, "실장비 확인 인계 계약"],
    ["implementationOwnership.writerValidation.userAbsentAcceptance", userAbsentAcceptanceKeys, "사용자 미참여 인수 실행 계약"],
    ["mainLane.workerReview.finalVerdictConsult", finalVerdictConsultKeys, "최종 판정 직전 상담 계약"],
    ["mainLane.web6Consult", web6ConsultKeys, "6 Pro 상담 자리 계약"],
    ["mainLane.characterRouting", characterRoutingKeys, "캐릭터 summon·session switch runtime 계약"],
  ]) {
    const node = valueAt(policy, path);
    check(isPlainObject(node), `${path}(${label})가 없거나 객체가 아니다.`);
    const actualKeys = isPlainObject(node) ? Object.keys(node).sort() : [];
    check(
      actualKeys.join("\u0000") === [...expectedKeys].sort().join("\u0000"),
      `${path}의 키 집합이 다르다: ${actualKeys.join(", ")}`,
    );
  }

  // 명시적 소유권 인수는 조건 없는 전면 인계가 아니다. 인수 대상·인계물·제외 범위·사후 검증 규칙이
  // 한 자리에서 함께 있어야 "작은 잔여 수정을 Main이 직접 마감한다"가 핵심·상태·데이터·권한·고위험
  // 변경까지 열어 주지 않는다. 그래서 문구 존재만 보지 않고 제외 범위는 식별자로 대조한다.
  const mainTakeover = valueAt(policy, "implementationOwnership.reworkRouting.mainTakeover") ?? {};
  const mainTakeoverExcluded = Array.isArray(mainTakeover.excluded) ? new Set(mainTakeover.excluded) : new Set();
  const missingTakeoverExclusions = [
    "unconfirmed-cause",
    "broad-scope",
    "core-logic",
    "state-machine-transition",
    "data-meaning",
    "permission-or-trust-boundary",
    "high-risk",
  ].filter((member) => !mainTakeoverExcluded.has(member));
  check(
    missingTakeoverExclusions.length === 0,
    `implementationOwnership.reworkRouting.mainTakeover.excluded에 빠진 제외 범위가 있다: ${missingTakeoverExclusions.join(", ")}(빠지면 그 성질의 변경까지 Main이 조용히 인수한다).`,
  );
  for (const [member, needle, why] of [
    ["precondition", "frozen-delta", "인계물이 frozen 변경본이라는 조건이 사라진다"],
    ["precondition", "valid-evidence", "인계물에 유효 검증 증거가 포함된다는 조건이 사라진다"],
    ["excludedFallback", "owner-rework", "제외 범위가 기존 owner 재작업으로 돌아간다는 문장이 사라진다"],
    ["afterTakeover", "only-the-checks-this-delta-invalidates", "인수 뒤 영향 검사만 다시 한다는 조건이 사라진다"],
    ["evidenceRule", "independently-reviewed", "Main 자신의 delta를 독립 검수로 표시하지 않는다는 금지가 사라진다"],
  ]) {
    check(
      isNonEmptyString(mainTakeover[member]) && mainTakeover[member].includes(needle),
      `implementationOwnership.reworkRouting.mainTakeover.${member}가 "${needle}"를 담지 않는다(${why}).`,
    );
  }
  // 인수 계약은 한 곳에만 있어야 한다. 네 자리가 서로를 가리키지 않으면 같은 조각이 자리마다 다른
  // 소유권 규칙으로 읽히고, "전면 인계 금지 + 예외 한 줄"이 그대로 되살아난다.
  for (const [path, needle] of [
    ["implementationOwnership.noOverlap.settledResidualHandoff", "reworkRouting.mainTakeover"],
    ["mainLane.workerReview.reuse", "reworkRouting.mainTakeover"],
    ["mainLane.dispatchBehavior", "implementationOwnership.noOverlap"],
    ["mainLane.ownershipScope", "reworkRouting.mainTakeover"],
  ]) {
    const value = valueAt(policy, path);
    check(
      isNonEmptyString(value) && value.includes(needle),
      `${path}가 ${needle}를 가리키지 않는다(소유권 규칙이 두 정본으로 갈라진다).`,
    );
  }
  // 검증 범위도 같은 이유로 문구 존재를 본다. 이 문장들이 사라지면 격리 서버·전체 production build가
  // 다시 모든 변경의 기본 절차가 되고, 이미 확인된 조건을 새 revision에서 반복하게 된다.
  for (const [member, needle, why] of [
    ["acceptanceCheck", "already-confirmed", "같은 revision·환경에서 이미 확인된 조건을 반복하지 않는다는 조건이 사라진다"],
    ["reuseScope", "rework-invalidated", "재작업이 무효화한 검사만 다시 한다는 조건이 사라진다"],
    ["surfaceSetup", "never-the-default", "격리 서버·전체 production build가 기본 검증이 아니라는 문장이 사라진다"],
    ["heavyArtifactOwner", "requests-that-artifact", "Main이 곧 만들 산출물을 owner가 요청한다는 조건이 사라진다"],
    ["staleEnvironment", "never-verification", "오래된 운영 화면이 수정본 검증이 아니라는 문장이 사라진다"],
  ]) {
    const value = valueAt(policy, `implementationOwnership.writerValidation.${member}`);
    check(
      isNonEmptyString(value) && value.includes(needle),
      `implementationOwnership.writerValidation.${member}가 "${needle}"를 담지 않는다(${why}).`,
    );
  }

  // 준비 참조·판단 재사용 계약은 실제 소비 경로가 있을 때만 정본이다. 소비자가 사라진 문장은
  // 과거 설명이고, 소비자가 바뀐 문장은 다음 발주를 막는다. 그래서 식별자 존재와 핵심 조건만 본다.
  const preparedReference = valueAt(policy, "routing.modelSelection.preparedReference") ?? {};
  const preparedReferenceErrors = Array.isArray(preparedReference.errors) ? new Set(preparedReference.errors) : new Set();
  const missingReferenceErrors = preparedReferenceErrorKeys.filter((member) => !preparedReferenceErrors.has(member));
  check(
    missingReferenceErrors.length === 0,
    `routing.modelSelection.preparedReference.errors에 빠진 오류 조건이 있다: ${missingReferenceErrors.join(", ")}(빠지면 잘못된 참조가 조용히 통과한다).`,
  );
  for (const [path, needle, why] of [
    ["routing.modelSelection.preparedReference.linkage", "session-local-task-name", "연결 키가 preparedId로 오해되면 이름·의미 필드 계약이 무너진다"],
    ["routing.modelSelection.judgmentReuse.sameInputs", "never-ask-again", "같은 입력의 재사용과 재질문 금지가 사라진다"],
    ["routing.modelSelection.judgmentReuse.activeOwnerCollision", "blocks-dispatch-new", "active owner 경로 충돌이 dispatch-new를 막는다는 조건이 사라진다"],
    ["routing.typedJudgmentRouting.observation.localStructuralPlacements", "without-a-judge-call", "구조 판정이 로컬 확정이라는 문장이 사라진다"],
    ["routing.typedJudgmentRouting.observation.ownerMessageAdvisory", "main-owns-the-meaning-and-explicit-assessment-decision", "owner-message 의미와 정식 assessment 판단의 Main 소유가 사라진다"],
  ]) {
    const value = valueAt(policy, path);
    check(
      isNonEmptyString(value) && value.includes(needle),
      `${path}가 "${needle}"를 담지 않는다(${why}).`,
    );
  }
  // 정본이 가리키는 소비 경로가 실제로 있는지 확인한다. 파서를 복제하지 않고 식별자만 본다.
  for (const [path, members] of [
    [preparedTaskSourcePath, ["PREPARED_CONTEXT", "PREPARED_TASK", "resolvePreparedTaskInput", "storePreparedTaskBatch", "clearPreparedTaskSession"]],
    [makerRoutingSourcePath, ["resolvePreparedTaskInput", "storePreparedTaskBatch"]],
  ]) {
    const source = readText(path);
    const missing = members.filter((member) => !source.includes(member));
    check(
      missing.length === 0,
      `${path}에 prepared 참조 소비 식별자가 없다: ${missing.join(", ")}(정본이 가리키는 소비 경로가 사라졌다).`,
    );
  }
  // Maker 후보 표. 후보마다 등급과 허용 강도 구간이 있어야 task hook이 구간 밖 강도를 막는다.
  // 강도 이름은 effortSelection.criteria의 단계로만 쓴다. 그 밖(max 포함)은 Jev 질문과 hook이 이해하지 못한다.
  {
    const profiles = valueAt(policy, "routing.modelSelection.profiles");
    const grades = Object.keys(valueAt(policy, "routing.modelSelection.criteria") ?? {});
    const levels = Object.keys(valueAt(policy, "routing.effortSelection.criteria") ?? {});
    check(isPlainObject(profiles) && Object.keys(profiles).length > 0, "routing.modelSelection.profiles가 비어 있다.");
    for (const [profile, entry] of Object.entries(isPlainObject(profiles) ? profiles : {})) {
      const where = `routing.modelSelection.profiles.${profile}`;
      check(
        isPlainObject(entry) && Object.keys(entry).sort().join(",") === "allowedEfforts,modelConfigPath,workClass",
        `${where}는 modelConfigPath·workClass·allowedEfforts만 가져야 한다(옛 minimumEffort 등은 hook이 읽지 않는다).`,
      );
      check(grades.includes(entry?.workClass), `${where}.workClass는 modelSelection.criteria의 등급(${grades.join(", ")}) 중 하나여야 한다.`);
      const allowed = entry?.allowedEfforts;
      check(
        isStringList(allowed) && allowed.length > 0 && new Set(allowed).size === allowed.length && allowed.every((level) => levels.includes(level)),
        `${where}.allowedEfforts는 effortSelection.criteria 단계(${levels.join(", ")}) 안의 중복 없는 비지 않은 목록이어야 한다.`,
      );
    }
  }

  // 상담은 판정 위임이 아니다. 두 문장이 사라지면 "좋은 모델에게 물어본다"가 조용히 "좋은 모델이
  // 판정한다"로 바뀌고, 그 순간 폐지한 검수 전용 역할이 이름만 바꿔 되살아난다. 산문이 아니라
  // 식별자만 본다: 출력은 이견 목록이어야 하고, 입력에 raw를 넣는 것은 금지여야 한다.
  const consultOutput = valueAt(policy, "mainLane.workerReview.finalVerdictConsult.output");
  check(
    isNonEmptyString(consultOutput) && consultOutput.includes("objections"),
    "mainLane.workerReview.finalVerdictConsult.output이 이견 목록(objections)으로 제한되지 않는다(상담이 판정 위임으로 번진다).",
  );
  const consultProhibited = valueAt(policy, "mainLane.workerReview.finalVerdictConsult.prohibited");
  for (const member of ["diff-body", "raw-build-or-test-output", "asking-the-model-to-decide-acceptance"]) {
    check(
      Array.isArray(consultProhibited) && consultProhibited.includes(member),
      `mainLane.workerReview.finalVerdictConsult.prohibited에 "${member}"가 없다(Main 컨텍스트 비용 원칙과 판정 권한이 함께 무너진다).`,
    );
  }

  // 6 Pro는 도구가 없고 왕복이 분 단위다. 그래서 이 계약이 지켜야 하는 것은 "어디에 두는가"와
  // "언제 저절로 켜지는가" 둘이다. 자리 목록이 흐려지면 상담이 maker 내부와 diff 검수까지 번져
  // 세션이 대기로 멈추고, 일반 세션 트리거가 느슨해지면 사용자가 부르지도 않았는데 모든 세션이
  // 분 단위로 느려진다. fail-open과 상한이 그 둘의 마지막 방벽이다.
  const web6Placements = valueAt(policy, "mainLane.web6Consult.placements");
  for (const slot of ["dispatch-design", "final-verdict", "competing-hypotheses", "irreversible-design-choice"]) {
    check(
      isPlainObject(web6Placements) && isNonEmptyString(web6Placements[slot]),
      `mainLane.web6Consult.placements.${slot}이 없다(6 Pro를 둘 자리가 흐려진다).`,
    );
  }
  const web6NeverPlaced = valueAt(policy, "mainLane.web6Consult.neverPlacedAt");
  for (const member of ["maker-internal-implementation-consult", "diff-review", "validation-execution"]) {
    check(
      Array.isArray(web6NeverPlaced) && web6NeverPlaced.includes(member),
      `mainLane.web6Consult.neverPlacedAt에 "${member}"가 없다(도구가 필요한 자리에 도구 없는 모델이 들어가 세션이 멈춘다).`,
    );
  }
  const web6Ordinary = valueAt(policy, "mainLane.web6Consult.trigger.ordinarySession");
  check(
    isNonEmptyString(web6Ordinary) && web6Ordinary.includes("explicit"),
    "mainLane.web6Consult.trigger.ordinarySession이 명시 지시(explicit)로 제한되지 않는다(일반 세션까지 분 단위 왕복을 떠안는다).",
  );
  const web6Bound = valueAt(policy, "mainLane.web6Consult.trigger.boundSession");
  check(
    isNonEmptyString(web6Bound),
    "mainLane.web6Consult.trigger.boundSession이 없다(6PRO로 연 세션에서 자동 개입 근거가 사라진다).",
  );
  const web6FailOpen = valueAt(policy, "mainLane.web6Consult.failOpen");
  check(
    isNonEmptyString(web6FailOpen) && web6FailOpen.includes("never-blocks"),
    "mainLane.web6Consult.failOpen이 차단 금지를 담지 않는다(응답 없는 탭 앞에서 작업이 멈춘다).",
  );
  const web6Authority = valueAt(policy, "mainLane.web6Consult.authority");
  check(
    isNonEmptyString(web6Authority) && web6Authority.includes("advice-only"),
    "mainLane.web6Consult.authority가 조언 전용으로 제한되지 않는다(상담이 판정 위임으로 번진다).",
  );

  // 트리거는 특정 도메인의 어휘가 아니라 결과의 성질이다. 전역 정본이 산업 설비 목록만 들고 있으면
  // 웹·데이터·인프라 프로젝트에서 이 계약이 "우리 얘기가 아니다"로 읽히고 감시가 통째로 빠진다.
  // 그래서 도메인 사례를 최소 세 축으로 강제하고, 각 축이 7분류를 그 도메인 말로 사상하는지 본다.
  const domainExamples = valueAt(policy, "routing.high-risk.materialRiskDefinition.domainExamples");
  check(
    isPlainObject(domainExamples),
    "routing.high-risk.materialRiskDefinition.domainExamples가 없다(트리거가 한 도메인 어휘에 묶인다).",
  );
  const mappedDomains = ["web-or-app", "game-or-realtime", "native-or-desktop", "linux-or-server", "ai-or-ml", "data-or-infra"];
  for (const domain of [...mappedDomains, "industrial-or-embedded"]) {
    check(
      isPlainObject(domainExamples) && Array.isArray(domainExamples[domain]) && domainExamples[domain].length > 0,
      `routing.high-risk.materialRiskDefinition.domainExamples.${domain}이 비어 있다(그 도메인에서 트리거가 해석되지 않는다).`,
    );
  }
  const codeNatureTriggers = valueAt(policy, "routing.high-risk.materialRiskDefinition.codeNatureTriggers");
  for (const domain of mappedDomains) {
    const rows = isPlainObject(domainExamples) && Array.isArray(domainExamples[domain]) ? domainExamples[domain].join("\n") : "";
    for (const trigger of Array.isArray(codeNatureTriggers) ? codeNatureTriggers : []) {
      check(
        rows.includes(trigger),
        `domainExamples.${domain}에 "${trigger}" 사상이 없다(그 분류가 이 도메인에서 사문화된다).`,
      );
    }
  }
  // 멀티플랫폼 차이는 별개의 가벼운 사례가 아니라 기존 분류로 들어온다. 이 단서가 없으면
  // "플랫폼마다 다른 것"이 감면 사유처럼 읽힌다.
  const crossPlatform = valueAt(policy, "routing.high-risk.materialRiskDefinition.domainExamples.crossPlatform");
  check(
    isNonEmptyString(crossPlatform) && crossPlatform.includes("never-as-a-separate-lighter-case"),
    "domainExamples.crossPlatform이 플랫폼 차이를 별개 완화 사례로 두지 못하게 막지 않는다.",
  );
  const universalAuthority = valueAt(policy, "routing.high-risk.materialRiskDefinition.universalAuthority");
  check(
    isNonEmptyString(universalAuthority) && universalAuthority.includes("never-the-definition"),
    "routing.high-risk.materialRiskDefinition.universalAuthority가 도메인 목록을 정의로 쓰지 못하게 막지 않는다.",
  );

  // 트리거 목록은 codeNatureTriggers 하나다. 개입 계약이 그 경로를 참조하지 않으면 목록을 다시 적은
  // 것이고, 두 정본은 반드시 갈라진다. 추론 강도와 위험 개입은 독립이다.
  for (const path of [
    "routing.high-risk.mainIntervention.preEditContract.when",
    "mainLane.workerReview.steeringCheckpoint.when",
  ]) {
    const value = valueAt(policy, path);
    check(
      isNonEmptyString(value) && value.includes("codeNatureTriggers"),
      `${path}가 routing.high-risk.materialRiskDefinition.codeNatureTriggers를 참조하지 않는다(트리거 목록이 두 정본으로 갈라진다).`,
    );
  }


  // 검수는 게이트 1회가 아니라 세 접점의 누적 과정이다. 접점 이름이 값에서 사라지면 정책이 다시
  // "최종 한 번"으로 읽히고, 조향으로 아낀 재확인이 최종에서 그대로 되돌아온다.
  const reviewComposition = valueAt(policy, "mainLane.workerReview.composition");
  for (const contact of ["pre-edit-steering", "confirmed-delta-review", "final-judgement"]) {
    check(
      isNonEmptyString(reviewComposition) && reviewComposition.includes(contact),
      `mainLane.workerReview.composition이 ${contact} 접점을 담지 않는다(검수는 게이트 1회가 아니라 누적 과정이다).`,
    );
  }
  const reviewFinalScope = valueAt(policy, "mainLane.workerReview.finalScope");
  for (const term of ["not-yet-reviewed", "drift", "without-a-new-doubt"]) {
    check(
      isNonEmptyString(reviewFinalScope) && reviewFinalScope.includes(term),
      `mainLane.workerReview.finalScope가 ${term} 조건을 담지 않는다(최종 판정은 미검수 delta와 drift만 보고 이미 검수한 delta는 새 의심 없이 다시 읽지 않는다).`,
    );
  }
  const reviewPurposeScope = valueAt(policy, "mainLane.workerReview.purposeScope");
  for (const term of ["direction-check", "acceptance"]) {
    check(
      isNonEmptyString(reviewPurposeScope) && reviewPurposeScope.includes(term),
      `mainLane.workerReview.purposeScope가 ${term} 구분을 담지 않는다(purpose 값과 모순되면 조향·중간 검수가 최종 수용으로 읽힌다).`,
    );
  }

  // 편집 전 한 통은 analyzer가 인식하는 라벨로만 판정된다. 라벨이 정책에서 사라지면 maker는 형식을
  // 알 수 없고 그 DM은 통째로 미완이 된다. 여기서 정규식을 복제하지 않고 문자열 존재만 본다.
  const steeringPayload = valueAt(policy, "mainLane.workerReview.steeringCheckpoint.payload");
  const steeringPayloadText = Array.isArray(steeringPayload) ? steeringPayload.join("\n") : "";
  for (const label of preEditPayloadLabels) {
    check(
      steeringPayloadText.includes(label),
      `mainLane.workerReview.steeringCheckpoint.payload에 인식 라벨 "${label}"이 없다(그 항목은 영원히 미완으로 판정된다).`,
    );
  }
  // high-risk 사전 승인 계약은 같은 한 통을 쓴다. 두 목록이 갈라지면 같은 DM이 어느 경로로 오느냐에
  // 따라 다른 형식으로 판정된다.
  check(
    JSON.stringify(valueAt(policy, "routing.high-risk.mainIntervention.preEditContract.payload")) ===
      JSON.stringify(steeringPayload),
    "routing.high-risk.mainIntervention.preEditContract.payload와 mainLane.workerReview.steeringCheckpoint.payload가 다르다(같은 한 통이 두 형식으로 갈라진다).",
  );

  for (const path of roleReferencePaths) {
    const role = valueAt(policy, path);
    check(
      role === "main" || (isNonEmptyString(role) && knownRoles.has(role)),
      `${path}의 "${role}"는 설치된 역할(agent/sop + agent/agents)로 해석되지 않는다.`,
    );
  }

  // 안전에 필요한 최소 member. 목록 자체가 있는지가 아니라 이 식별자들이 남아 있는지를 본다.
  for (const [path, members] of requiredPolicyMembers) {
    const value = valueAt(policy, path);
    const present = Array.isArray(value) ? new Set(value) : new Set();
    const missing = members.filter((member) => !present.has(member));
    check(missing.length === 0, `${path}에 필수 항목이 없다: ${missing.join(", ")}`);
  }

  // 권한·검수 주체 identity.
  for (const [path, expected] of criticalRoleIdentities) {
    check(valueAt(policy, path) === expected, `${path}는 "${expected}"여야 한다.`);
  }

  // 권한·승인·검수·증거 계약이 담기는 자리의 존재와 타입.
  for (const [path, shape] of requiredPolicyShapes) {
    const value = valueAt(policy, path);
    check(
      shape === "list" ? isStringList(value) : isNonEmptyString(value),
      `${path}가 없거나 ${shape === "list" ? "비지 않은 문자열 목록" : "비지 않은 문자열"}이 아니다.`,
    );
  }

  scanPolicyData(policy);
}

let concurrencyValue = null;
const rawConfig = readText(configPath);
if (rawConfig === "") {
  errors.push(`${configPath}: 파일이 비어 있다.`);
} else {
  try {
    concurrencyValue = readYamlScalarAtPath(rawConfig, expectedConcurrencyPath);
    check(
      Number.isSafeInteger(concurrencyValue) && concurrencyValue > 0,
      `${configPath}의 ${expectedConcurrencyPath}는 양의 정수여야 한다.`,
    );
  } catch (error) {
    errors.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // 모델·effort 값 자체는 config.yml 이 정본이다. 여기서는 정책이 가리키는 경로가 실제로
  // 해석되는지만 본다. 값 비교는 `node patches/build-agents.mjs --check` 가 바이트로 한다.
  if (policy !== null) {
    for (const [locator, reference] of collectConfigReferences(policy)) {
      if (!isNonEmptyString(reference)) {
        check(false, `${locator}는 비지 않은 문자열 config 경로여야 한다: ${JSON.stringify(reference)}`);
        continue;
      }
      try {
        const value = readYamlScalarAtPath(rawConfig, reference);
        check(
          value !== null && value !== "",
          `${locator}가 가리키는 ${configPath}의 ${reference}가 비어 있다.`,
        );
      } catch (error) {
        check(false, `${locator}가 가리키는 ${reference}를 ${configPath}에서 해석하지 못했다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 위임 역할의 모델 정본은 config.yml 이다. 위 `*ConfigPath` 해석 검사가 그것을 덮는다.
  }


  // 배경 실행은 PC별 기본값에 맡기지 않는다. 이 둘이 꺼지면 SubAgent 와 긴 명령이 다시 Main 의
  // 턴을 붙잡아 MAIN LANE 계약이 문서에만 남는다.
  for (const [path, label] of [
    ["async.enabled", "SubAgent·async job 배경 실행"],
    ["bash.autoBackground.enabled", "긴 bash 명령 자동 background"],
  ]) {
    try {
      check(readYamlScalarAtPath(rawConfig, path) === true, `${configPath}의 ${path}는 true여야 한다(${label}).`);
    } catch (error) {
      errors.push(`${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// 역할 권한은 생성물 머리말이 실제로 주는 힘이다. 문구가 아니라 도구 목록을 본다.
for (const role of knownRoles) {
  if (!executionForbiddenRoles.includes(role)) continue;
  const tools = readAgentTools(role);
  check(tools !== null, `agent/agents/${role}.md에 tools 머리말이 없다.`);
  if (tools === null) continue;
  const forbidden = tools.filter((tool) => executionTools.includes(tool));
  check(
    forbidden.length === 0,
    `${role}는 읽기 전용 역할인데 실행·수정 도구(${forbidden.join(", ")})를 가진다.`,
  );
}

// 금지 목록만으로는 새로 생긴 도구가 조용히 통과한다. 승인된 도구 밖은 전부 거부한다. 모델 변종은
// family의 승인 목록을 그대로 쓰므로, 목록을 늘리지 않고도 같은 권한 경계가 적용된다.
for (const role of knownRoles) {
  const allowed = roleToolAllowlists[role];
  check(
    Array.isArray(allowed),
    `${role}의 승인된 도구 목록이 없다(resource: roleToolAllowlists).`,
  );
  if (!Array.isArray(allowed)) continue;
  const tools = readAgentTools(role);
  check(tools !== null, `agent/agents/${role}.md에 tools 머리말이 없다.`);
  if (tools === null) continue;
  const extra = tools.filter((tool) => !allowed.includes(tool));
  check(
    extra.length === 0,
    `${role}의 도구(${extra.join(", ")})는 이 역할에 승인된 목록(${allowed.join(", ")}) 밖이다.`,
  );
}
if (policy !== null) {
  for (const [role, path] of policyToolContracts) {
    const declared = valueAt(policy, path);
    const tools = knownRoles.has(role) ? readAgentTools(role) : null;
    check(
      isStringList(declared) &&
        tools !== null &&
        declared.length === tools.length &&
        declared.every((tool, index) => tool === tools[index]),
      `${path}의 도구 목록이 agent/agents/${role}.md의 tools와 다르다.`,
    );
  }
}

const result = {
  ok: errors.length === 0,
  checks: checkCount,
  concurrency: {
    path: expectedConcurrencyPath,
    value: concurrencyValue,
  },
  ...(errors.length === 0 ? {} : { errors }),
};

if (requestedJson) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (result.ok) {
  process.stdout.write(
    `하네스 정책 일치 (${checkCount}개 검사; ${expectedConcurrencyPath}=${concurrencyValue}).\n`,
  );
} else {
  process.stderr.write(`하네스 정책 드리프트 (${errors.length}건):\n`);
  for (const error of errors) process.stderr.write(`- ${error}\n`);
}

if (!result.ok) process.exitCode = 1;
