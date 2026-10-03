import { Suspense } from "react";
import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { I18nProvider } from "@/hooks/useI18n";

export const metadata: Metadata = {
  title: "Office — CUELO",
};

/**
 * 3D 사무실 전용 화면. 대화 화면의 「오피스」가 새 탭으로 연다. 같은 `?session=`·`?cwd=` 주소 규칙과
 * 세션 목록·대화 스트림을 그대로 쓰므로 직접 열거나 새로고침해도 같은 세션이 열린다.
 */
export default function OfficePage() {
  return (
    <Suspense>
      <I18nProvider>
        <AppShell variant="office" />
      </I18nProvider>
    </Suspense>
  );
}
