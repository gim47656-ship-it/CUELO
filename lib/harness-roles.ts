/**
 * Model role slots used by the public CUELO harness.
 *
 * The Model roles panel exposes unassigned tool and Maker slots so users can choose their own
 * models without editing YAML. Built-in roles such as `judge` retain the core's presentation.
 * `install.mjs` also accepts `judge` explicitly and runs before dependencies exist.
 */
export const HARNESS_ROLES = [
  "implSonnet",
  "implOpus",
  "implDeepSeek",
  "makerHardUiOpus",
  "makerHardCodeOpus",
  "makerHardCodeSonnet",
  "crossReviewOpenAI",
  "crossReviewAnthropic",
  "crossReviewAdvisory",
  "skim",
  "draft",
  "ocr",
] as const;
