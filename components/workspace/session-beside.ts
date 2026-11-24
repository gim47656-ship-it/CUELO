import { createContext, useContext } from "react";
import type { SessionInfo } from "@/lib/types";

/** Drag payload type for a session row dropped onto the conversation to open it beside. */
export const SESSION_DRAG_TYPE = "application/x-cuelo-session";

/**
 * 옆 창 controls the shell lends to the session list. `null` when the layout cannot show two
 * panes at all (compact or phone): the list then shows no 「옆에 열기」 and rows are not draggable.
 */
export interface SessionBesideControls {
  /** The session shown in the second pane, or null when none is shown. */
  besideSessionId: string | null;
  /** Why a session cannot open beside right now (the window is too narrow), or null when it can. */
  blockedReason: string | null;
  openBeside: (session: SessionInfo) => void;
}

export const SessionBesideContext = createContext<SessionBesideControls | null>(null);

export function useSessionBeside(): SessionBesideControls | null {
  return useContext(SessionBesideContext);
}

/** Reads the session id a session row's drag carries, or null when the drag carries something else. */
export function readSessionDragId(data: DataTransfer): string | null {
  const id = data.getData(SESSION_DRAG_TYPE).trim();
  return id || null;
}
