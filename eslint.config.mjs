import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    // Third-party minified bundles kept beside a private report page are not project source.
    ignores: ["Tools/**", ".omp/**", ".runtime-patch-home/**", ".gitnexus/**", ".next-verify/**", "doc/history/**/*.min.js"],
  },
  {
    // Ratchet: new violations fail lint; existing ones are recorded in eslint-suppressions.json.
    rules: {
      "react-hooks/immutability": "error",
      "react-hooks/refs": "error",
      "react-hooks/set-state-in-effect": "error",
    },
  },
];

export default eslintConfig;
