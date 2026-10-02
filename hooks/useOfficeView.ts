"use client";

import { useCallback, useEffect, useState } from "react";
import { OFFICE_MAIN_KEY, type OfficeMakerAccount } from "@/lib/office/office-roster";

/** 좁은 화면에서 오피스가 보여 주는 칸. 넓은 화면에서는 두 칸이 나란히 있어 쓰지 않는다. */
export type OfficePane = "floor" | "target";

const NO_ACCOUNTS: ReadonlyMap<string, OfficeMakerAccount> = new Map();

/**
 * 오피스 보기의 화면 상태. 열림 여부는 기억하지 않는다 — 앱을 다시 열면 늘 대화 보기에서
 * 시작한다. 고른 대상은 보기만 바꿀 뿐 어디에도 보내지 않으며, 입력은 언제나 Main 대화로 간다.
 *
 * `accounts` 는 화면이 이미 읽어 온 Maker 기록에서 본 계정 근거다. 대응을 위해 따로 읽지
 * 않고, 선택해서 연 기록이 알려 준 값만 쌓는다. 세션이 바뀌면 다른 세션의 Maker 이므로 버린다.
 */
export function useOfficeView(sessionId: string | null) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>(OFFICE_MAIN_KEY);
  const [pane, setPane] = useState<OfficePane>("floor");
  const [accounts, setAccounts] = useState<ReadonlyMap<string, OfficeMakerAccount>>(NO_ACCOUNTS);

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

  const toggle = useCallback(() => {
    // 오피스를 열 때 좁은 화면은 자리부터 보여 준다. 넓은 화면에서는 이 값을 쓰지 않는다.
    if (!open) setPane("floor");
    setOpen(!open);
  }, [open]);

  return { open, toggle, selected, select, pane, setPane, accounts, recordAccount };
}
