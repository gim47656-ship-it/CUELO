import type { MetadataRoute } from "next";

// 설치 라벨은 런타임 환경변수에서 읽는다. 같은 소스가 사무실·집 두 PC에서 돌고,
// 폰에는 origin이 달라 별개 앱으로 설치되는데 이름이 같으면 구분할 수 없다.
// 빌드 산출물은 두 PC가 공유하므로 build-time 상수가 아니라 요청 시점에 읽는다.
export const dynamic = "force-dynamic";

/** 예: "사무실" -> "CUELO(사무실)". 비어 있으면 접미사 없이 "CUELO". */
function installName(): string {
  const label = process.env.CUELO_INSTANCE_LABEL?.trim();
  return label ? `CUELO(${label})` : "CUELO";
}

export default function manifest(): MetadataRoute.Manifest {
  const name = installName();
  return {
    id: "/",
    name,
    short_name: name,
    description: "CUELO, a local web view for the omp (oh-my-pi) coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // Same literal as the viewport theme color's dark-mode stop: SEED's
    // `bg.layer-default` in dark mode (gray-100, #16171b). The manifest
    // carries only one value, so the installed splash matches this app's
    // dark-first UI instead of a bright flash before the first paint.
    background_color: "#16171b",
    theme_color: "#16171b",
    categories: ["developer", "productivity"],
    lang: "en",
    icons: [
      {
        src: "/icons/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
