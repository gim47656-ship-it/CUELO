"use client";

import { useEffect, useSyncExternalStore } from "react";
import {
  applyGraphiteWallpaper,
  isGraphiteEnabled,
  setGraphiteEnabled,
  subscribeGraphite,
} from "@/lib/graphite-theme";
import {
  getOfficeCharacters,
  loadOfficeCharacters,
  subscribeOfficeCharacters,
} from "@/lib/hanse-resource-client";

/** 설정 화면의 흑연 테마 스위치. */
export function useGraphiteTheme() {
  const enabled = useSyncExternalStore(subscribeGraphite, isGraphiteEnabled, () => false);
  return { enabled, setEnabled: setGraphiteEnabled };
}

/**
 * 배경을 캐릭터 모드에 맞춘다. 앱 껍데기에서 한 번만 부른다. 모드 변경(`applyOfficeCharacters`)은 꺼져 있는
 * 동안에도 저장해 두어, 다시 켤 때 낡은 배경이 먼저 그려지지 않게 한다. 켜져 있을 때만 서버에서 모드를
 * 읽고, 읽지 못하면 저장된 배경을 그대로 둔다.
 */
export function useGraphiteWallpaperSync() {
  const enabled = useSyncExternalStore(subscribeGraphite, isGraphiteEnabled, () => false);
  useEffect(() => subscribeOfficeCharacters(() => applyGraphiteWallpaper(getOfficeCharacters().mode)), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void loadOfficeCharacters().then((loaded) => {
      if (active && loaded) applyGraphiteWallpaper(getOfficeCharacters().mode);
    });
    return () => {
      active = false;
    };
  }, [enabled]);
}
