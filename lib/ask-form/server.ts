/**
 * Server side of the web form card: turn the agent's HTML into the JSON model the browser draws, and
 * check what comes back with the core's own rules before it reaches the model.
 *
 * Imports the core's parser and validators directly. They are Bun/server code, so this file must
 * never be imported from a client component (`answers.ts` is the browser-safe counterpart).
 */
import { getOwn, setOwn } from "./answers";
import {
  defaultFormData as coreDefaultFormData,
  fieldError as coreFieldError,
  isArrayChoice as coreIsArrayChoice,
  textValue as coreTextValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import { loadFormImage, MAX_FORM_IMAGE_BYTES, svgMedia, type FormMedia } from "@oh-my-pi/pi-tui/html-form/media";
import { type FormField, type HtmlForm, parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import type { AskFormBlock, AskFormData, AskFormModel, AskFormValue } from "./types";

/** Largest `activity` payload the server keeps as a form snapshot. */
const MAX_SNAPSHOT_CHARS = 512 * 1024;

export interface PreparedAskForm {
  form: HtmlForm;
  model: AskFormModel;
}

function dataUri(media: FormMedia): string {
  return `data:${media.mime};base64,${Buffer.from(media.bytes).toString("base64")}`;
}

/**
 * Parse `html` and resolve its pictures. Relative image paths resolve against `cwd`; a picture that
 * cannot be read, is too large, or would push the form's pictures past one `MAX_FORM_IMAGE_BYTES`
 * total becomes `src: null`, which the card shows as its alt text.
 */
export async function prepareAskForm(
  html: string,
  options: { cwd: string; signal?: AbortSignal },
): Promise<PreparedAskForm> {
  const form = parseHtmlForm(html);
  const fields = form.fields.filter((field) => field.name);
  const indexOf = new Map<FormField, number>(fields.map((field, index) => [field, index]));
  let pictureBytes = 0;

  const resolvePicture = async (load: () => Promise<FormMedia> | FormMedia): Promise<string | null> => {
    try {
      const media = await load();
      if (pictureBytes + media.bytes.byteLength > MAX_FORM_IMAGE_BYTES) return null;
      pictureBytes += media.bytes.byteLength;
      return dataUri(media);
    } catch {
      return null;
    }
  };

  const sections: AskFormModel["sections"] = [];
  for (const section of form.sections) {
    const blocks: AskFormBlock[] = [];
    for (const block of section.blocks) {
      switch (block.kind) {
        case "field": {
          const index = indexOf.get(block.field);
          if (index !== undefined) blocks.push({ kind: "field", index });
          break;
        }
        case "image":
          blocks.push({
            kind: "image",
            alt: block.alt,
            src: await resolvePicture(() => loadFormImage(block.src, { cwd: options.cwd, signal: options.signal })),
          });
          break;
        case "svg":
          blocks.push({ kind: "image", alt: block.alt, src: await resolvePicture(() => svgMedia(block.markup)) });
          break;
        default:
          blocks.push(block);
      }
    }
    sections.push({ title: section.title, blocks });
  }
  return { form, model: { sections, fields, hidden: form.hidden } };
}

/** Core defaults: hidden pairs, preselected options and prefilled text. */
export function defaultAskFormData(prepared: PreparedAskForm): AskFormData {
  return coreDefaultFormData(prepared.form);
}

/**
 * Check browser-reported answers against the parsed form: only named fields count, values must have
 * the shape their control reports and match an enabled option (or free "Other" text), hidden pairs come
 * from the form rather than the browser, and the core's `fieldError` rules must pass for every field.
 */
export function validateAskFormSubmission(
  prepared: PreparedAskForm,
  raw: unknown,
): { data: AskFormData } | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Invalid answers (answers are not an object)" };
  const submitted = raw as Record<string, unknown>;
  const data: AskFormData = {};
  for (const [name, value] of prepared.form.hidden) setOwn(data, name, value);

  const problems: string[] = [];
  for (const field of prepared.model.fields) {
    const value = normalizeValue(field, getOwn(submitted, field.name));
    if (value === INVALID) {
      problems.push(`${field.name}: wrong value`);
      continue;
    }
    const error = coreFieldError(field, value);
    if (error) problems.push(`${field.name}: ${error}`);
    if (value !== undefined) setOwn(data, field.name, value);
  }
  return problems.length > 0 ? { error: `Invalid answers (${problems.join("; ")})` } : { data };
}

const INVALID = Symbol("invalid");

function normalizeValue(field: FormField, raw: unknown): AskFormValue | undefined | typeof INVALID {
  if (raw === undefined) return undefined;
  if (field.kind === "text") {
    if (typeof raw !== "string" && typeof raw !== "number") return INVALID;
    return coreTextValue(field, String(raw));
  }
  const allowed = new Set(field.options.flatMap((option) => (option.disabled ? [] : [option.value])));
  const accepts = (value: unknown): value is string =>
    typeof value === "string" && (allowed.has(value) || (field.other && value.trim() !== ""));
  if (coreIsArrayChoice(field)) {
    if (!Array.isArray(raw) || !raw.every(accepts)) return INVALID;
    return raw;
  }
  return accepts(raw) ? raw : INVALID;
}

/** Pull the form values out of a browser `activity` payload; undefined when it is not usable. */
export function parseAskFormSnapshot(payload: string): unknown {
  if (payload.length > MAX_SNAPSHOT_CHARS) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/**
 * Values to submit when the wait ends: the browser's latest reported values when they pass validation,
 * otherwise the form defaults. Nothing the user never reported can be invented here.
 */
export function timedOutAskFormData(prepared: PreparedAskForm, snapshot: unknown): AskFormData {
  if (snapshot !== undefined) {
    const checked = validateAskFormSubmission(prepared, snapshot);
    if ("data" in checked) return checked.data;
  }
  return defaultAskFormData(prepared);
}
