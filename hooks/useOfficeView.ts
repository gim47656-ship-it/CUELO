"use client";

import { useCallback, useEffect, useState } from "react";
import { OFFICE_MAIN_KEY, type OfficeMakerAccount } from "@/lib/office/office-roster";
import { OFFICE_CAMERA_FIT, type OfficeCameraView } from "@/lib/office/office-camera";

/** 오피스 화면의 보기. `floor` 는 3D 공간이, `target` 은 고른 대상의 대화가 화면을 다 쓴다. */
export type OfficePane = "floor" | "target";

const NO_ACCOUNTS: ReadonlyMap<string, OfficeMakerAccount> = new Map();

/**
 * `/office` 화면의 상태. 늘 공간부터 보여 주고, 고른 대상은 보기만 바꿀 뿐 어디에도 보내지 않으며,
 * 입력은 언제나 Main 대화로 간다. 장면 확대·옮기기는 대화 보기에 다녀와도 그대로 남는다.
 *
 * `accounts` 는 화면이 이미 읽어 온 Maker 기록에서 본 계정 근거다. 대응을 위해 따로 읽지
 * 않고, 선택해서 연 기록이 알려 준 값만 쌓는다. 세션이 바뀌면 다른 세션의 Maker 이므로 버린다.
 */
export function useOfficeView(sessionId: string | null) {
  const [selected, setSelected] = useState<string>(OFFICE_MAIN_KEY);
  const [pane, setPane] = useState<OfficePane>("floor");
  const [accounts, setAccounts] = useState<ReadonlyMap<string, OfficeMakerAccount>>(NO_ACCOUNTS);
  const [view, setView] = useState<OfficeCameraView>(OFFICE_CAMERA_FIT);

  useEffect(() => {
    setSelected(OFFICE_MAIN_KEY);
    setAccounts(NO_ACCOUNTS);
  }, [sessionId]);

  const select = useCallback((key: string) => {
    setSelected(key);
    setPane("target");
  }, []);

  const recordAccount = useCallback((makerId: string, account: OfficeMakerAccount) => {
    setAccounts((current) => {
      const known = current.get(makerId);
      if (known && known.provider === account.provider && known.credentialId === account.credentialId) return current;
      return new Map(current).set(makerId, account);
    });
  }, []);

  return { selected, select, pane, setPane, accounts, recordAccount, view, setView };
}
