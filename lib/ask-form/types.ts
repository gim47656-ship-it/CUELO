import type { FormField, FormSpan } from "@oh-my-pi/pi-tui/html-form/parse";

export type { ChoiceField, FormField, FormSpan, TextField } from "@oh-my-pi/pi-tui/html-form/parse";

/** Submitted value of one control, as the core's `HtmlFormValue` defines it. */
export type AskFormValue = string | number | string[];

/** Answers by control `name` (the core's `HtmlFormData`). */
export type AskFormData = Record<string, AskFormValue>;

/**
 * One renderable unit of a section. Unlike the core's block, a field is referenced by its index in
 * {@link AskFormModel.fields} and a picture is already resolved to a `data:` URI (or null when it
 * could not be loaded), so the browser never fetches an address the agent wrote.
 */
export type AskFormBlock =
  | { kind: "text"; spans: FormSpan[]; heading: boolean }
  | { kind: "list"; items: FormSpan[][]; ordered: boolean }
  | { kind: "pre"; text: string }
  | { kind: "table"; rows: FormSpan[][][]; headerRows: number }
  | { kind: "image"; src: string | null; alt: string }
  | { kind: "field"; index: number };

export interface AskFormSection {
  title: FormSpan[];
  blocks: AskFormBlock[];
}

/**
 * JSON form model the server sends to the browser: the parsed `<form>` with named fields only.
 * It carries text spans and values, never markup, so nothing the model wrote reaches the DOM as HTML.
 */
export interface AskFormModel {
  sections: AskFormSection[];
  /** Named fields in document order; `AskFormBlock` `field` blocks point here. */
  fields: FormField[];
  hidden: [name: string, value: string][];
}

/** Why a value is not acceptable, as a code the UI turns into text in its own language. */
export type AskFieldError =
  | { code: "required" }
  | { code: "selectAtLeastOne" }
  | { code: "enterNumber" }
  | { code: "min"; value: number }
  | { code: "max"; value: number }
  | { code: "minLength"; value: number }
  | { code: "maxLength"; value: number }
  | { code: "email" }
  | { code: "url" }
  | { code: "pattern"; pattern: string };

/** `extension_ui_input` data a timed form sends: this prefix, then the form's current values as JSON. */
export const ASK_FORM_ACTIVITY_PREFIX = "activity:form:";
