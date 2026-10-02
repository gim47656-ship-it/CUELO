/**
 * Model role slots the public CUELO harness routes Makers to.
 *
 * omp's core does not know these ids, so a profile that never assigned one would not list it.
 * The Model roles panel shows each missing slot as "not set" so the user can pick a model there
 * instead of editing YAML first. `install.mjs` runs before dependencies exist and keeps its own
 * copy; `install.test.mjs` checks that the two lists stay identical.
 */
export const HARNESS_ROLES = [
  "implSonnet",
  "implOpus",
  "implDeepSeek",
  "makerHardUiOpus",
  "makerHardCodeOpus",
  "makerHardCodeSonnet",
] as const;
