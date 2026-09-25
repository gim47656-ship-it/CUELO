"use client";

import { useCallback, useEffect, useState } from "react";
import { Menu } from "@seed-design/react";

const DISMISSED_KEY = "cuelo-notification-prompt-dismissed";

type Permission = NotificationPermission | null;

interface NotificationPermissionState {
  permission: Permission;
  dismissed: boolean;
  request: () => void;
  dismiss: () => void;
}

export function useNotificationPermission(): NotificationPermissionState {
  const [permission, setPermission] = useState<Permission>(null);
  const [dismissed, setDismissed] = useState(false);

  const refresh = useCallback(() => {
    setPermission("Notification" in window ? Notification.permission : null);
  }, []);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISSED_KEY) === "1");
    } catch {
      // 비공개 모드에서 저장소를 쓰지 못해도 권한 요청은 계속 허용한다.
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const request = useCallback(() => {
    if (!("Notification" in window) || Notification.permission !== "default") return;
    // 사용자 제스처를 유지하도록 클릭 핸들러에서 즉시 호출한다.
    void Notification.requestPermission().then(setPermission, refresh);
  }, [refresh]);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // 저장소를 쓸 수 없어도 현재 페이지에서는 안내를 닫는다.
    }
  }, []);

  return { permission, dismissed, request, dismiss };
}

type NotificationPermissionProps = NotificationPermissionState & {
  variant: "banner" | "menu";
  locale: string;
};

export function NotificationPermission({ variant, locale, permission, dismissed, request, dismiss }: NotificationPermissionProps) {
  const ko = locale === "ko";
  if (permission === null || permission === "granted") return null;

  if (variant === "banner") {
    if (permission !== "default" || dismissed) return null;
    return (
      <div className="workspace-update-banner" role="region" aria-label={ko ? "알림 권한 안내" : "Notification permission"}>
        <span className="workspace-update-banner-detail" style={{ fontFamily: "inherit", fontSize: "inherit", color: "inherit" }}>
          {ko ? "백그라운드 작업 완료 알림을 받으세요." : "Get notified when background work finishes."}
        </span>
        <button type="button" className="workspace-update-banner-dismiss" onClick={request}>
          {ko ? "알림 켜기" : "Enable notifications"}
        </button>
        <button type="button" className="workspace-update-banner-dismiss" onClick={dismiss} aria-label={ko ? "알림 권한 안내 닫기" : "Dismiss notification prompt"}>
          {ko ? "닫기" : "Dismiss"}
        </button>
      </div>
    );
  }

  return (
    <Menu.Item disabled={permission === "denied"} onClick={permission === "default" ? request : undefined}>
      <Menu.ItemBody>
        <Menu.ItemLabel>{permission === "default" ? (ko ? "알림 켜기" : "Enable notifications") : (ko ? "알림 차단됨" : "Notifications blocked")}</Menu.ItemLabel>
        {permission === "denied" && (
          <Menu.ItemDescription>
            {ko ? "주소창 옆 사이트 설정에서 알림을 허용하세요." : "Allow notifications in site settings beside the address bar."}
          </Menu.ItemDescription>
        )}
      </Menu.ItemBody>
    </Menu.Item>
  );
}
