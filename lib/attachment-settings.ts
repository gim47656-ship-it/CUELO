/**
 * Chat attachment settings shared by the server store and the settings UI. No Node imports:
 * the composer and the settings modal load this module in the browser.
 */

/** Days an attachment stays after the first scan that found nothing referring to it. */
export const ATTACHMENT_ORPHAN_GRACE_DAYS = 7;
const MIB = 1024 * 1024;
/** The largest MiB count whose byte size is still a safe integer. */
const MAX_UPLOAD_LIMIT_MB = Math.floor(Number.MAX_SAFE_INTEGER / MIB);

export interface AttachmentSettings {
  /** Per-file cap for `POST /api/attachments`, in MiB. */
  uploadLimitMb: number;
  /** Whether the server deletes managed attachments that stayed unreferenced for the grace period. */
  autoCleanupEnabled: boolean;
  orphanGraceDays: typeof ATTACHMENT_ORPHAN_GRACE_DAYS;
}

export type AttachmentSettingsPatch = Partial<Pick<AttachmentSettings, "uploadLimitMb" | "autoCleanupEnabled">>;

export const DEFAULT_ATTACHMENT_SETTINGS: Readonly<AttachmentSettings> = Object.freeze({
  uploadLimitMb: 100,
  autoCleanupEnabled: true,
  orphanGraceDays: ATTACHMENT_ORPHAN_GRACE_DAYS,
});

export function attachmentUploadLimitBytes(settings: Pick<AttachmentSettings, "uploadLimitMb">): number {
  return settings.uploadLimitMb * MIB;
}

function isUploadLimitMb(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_UPLOAD_LIMIT_MB;
}

/** Settings read back from disk: every field that is missing or invalid falls back to its default. */
export function normalizeAttachmentSettings(value: unknown): AttachmentSettings {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    uploadLimitMb: isUploadLimitMb(record.uploadLimitMb) ? record.uploadLimitMb : DEFAULT_ATTACHMENT_SETTINGS.uploadLimitMb,
    autoCleanupEnabled: typeof record.autoCleanupEnabled === "boolean"
      ? record.autoCleanupEnabled
      : DEFAULT_ATTACHMENT_SETTINGS.autoCleanupEnabled,
    orphanGraceDays: ATTACHMENT_ORPHAN_GRACE_DAYS,
  };
}

/**
 * A `PATCH /api/attachment-settings` body, or the reason it is rejected. `orphanGraceDays` is
 * fixed: it may be echoed back but never changed.
 */
export function parseAttachmentSettingsPatch(value: unknown): { ok: true; patch: AttachmentSettingsPatch } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "Settings must be a JSON object" };
  const patch: AttachmentSettingsPatch = {};
  for (const [key, field] of Object.entries(value)) {
    if (key === "uploadLimitMb") {
      if (!isUploadLimitMb(field)) return { ok: false, error: "uploadLimitMb must be a positive whole number of MB" };
      patch.uploadLimitMb = field;
    } else if (key === "autoCleanupEnabled") {
      if (typeof field !== "boolean") return { ok: false, error: "autoCleanupEnabled must be true or false" };
      patch.autoCleanupEnabled = field;
    } else if (key === "orphanGraceDays") {
      if (field !== ATTACHMENT_ORPHAN_GRACE_DAYS) return { ok: false, error: `orphanGraceDays is fixed at ${ATTACHMENT_ORPHAN_GRACE_DAYS}` };
    } else {
      return { ok: false, error: `Unknown setting: ${key}` };
    }
  }
  return { ok: true, patch };
}

async function readSettingsResponse(response: Response): Promise<AttachmentSettings> {
  const payload = await response.json().catch(() => null) as ({ error?: unknown } & Partial<AttachmentSettings>) | null;
  if (!response.ok || !payload || !isUploadLimitMb(payload.uploadLimitMb) || typeof payload.autoCleanupEnabled !== "boolean") {
    throw new Error(typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`);
  }
  return normalizeAttachmentSettings(payload);
}

export async function fetchAttachmentSettings(init: { signal?: AbortSignal } = {}): Promise<AttachmentSettings> {
  return readSettingsResponse(await fetch("/api/attachment-settings", { cache: "no-store", signal: init.signal }));
}

export async function saveAttachmentSettings(patch: AttachmentSettingsPatch): Promise<AttachmentSettings> {
  return readSettingsResponse(await fetch("/api/attachment-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }));
}
