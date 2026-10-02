import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { I18nProvider } from "@/hooks/useI18n";
import { OfficePreview } from "./OfficePreview";

export const metadata: Metadata = {
  title: "CUELO office preview",
  robots: { index: false, follow: false },
};

/**
 * 3D 사무실 장면만 띄우는 개발 전용 미리보기. 실제 `OfficeStage`·`OfficeScene3D` 를 고정 참여자로
 * 그리며 AppShell·세션·계정은 만들지 않는다. production 서버에서는 없는 주소다.
 */
export default function OfficePreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <I18nProvider>
      <OfficePreview />
    </I18nProvider>
  );
}
