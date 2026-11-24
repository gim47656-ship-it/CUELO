import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 브라우저 옆 칸 shows the ego lite TaskSpace of one CUELO session. CUELO reaches ego only through
 * ego's pane channel (see channel.ts): never its debug port, its bridge token or its state file.
 */
export type EgoOwnership = "agent" | "user";

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export function isPaneSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isPaneTargetId(value: unknown): value is string {
  return typeof value === "string" && TARGET_ID_PATTERN.test(value);
}

/** Same fixed name the ego_browser tool gives a session's user-profile TaskSpace. */
export function paneSpaceName(sessionId: string): string {
  return `cuelo-${sessionId}-user`;
}

/**
 * Where the running ego app announces its pane channel: beside ego-lite-bridge.json in the default
 * profile of the app root the ego_browser tool uses (linuxAppProfileRoot in
 * Tools/OMP_Global_Config/agent/tools/ego-browser/index.ts). Other ego profiles are not looked at.
 */
export function paneChannelPath(env: Record<string, string | undefined> = process.env): string {
  const profileRoot = env.EGO_LITE_APP_PROFILE_ROOT || join(homedir(), ".local", "share", "ego-lite-gui");
  return join(profileRoot, "chromium-profile", "ego-lite-pane.json");
}
