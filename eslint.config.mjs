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
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
];

export default eslintConfig;
