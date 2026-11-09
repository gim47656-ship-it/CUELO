/**
 * Value shapes and validation of an agent HTML form, shared by the browser card and the server.
 *
 * The core's `@oh-my-pi/pi-tui/html-form/data` imports its HTML parser, which the browser bundle must
 * not carry, so these few rules are written out here. `answers.test.mjs` runs them against the core's
 * own `choiceValue`, `textValue`, `fieldError` and `defaultFormData` so a core change shows up as a
 * failing test rather than as a form that accepts different values than the core.
 */
import type {
  AskFieldError,
  AskFormData,
  AskFormModel,
  AskFormValue,
  ChoiceField,
  FormField,
  TextField,
} from "./types";

/** Label of the free-text answer the UI adds to radio and checkbox groups (core `OTHER_LABEL`). */
export const OTHER_LABEL = "Other";

/** A checkbox group or multi-select reports an array; a lone checkbox reports its value or nothing. */
export function isArrayChoice(field: ChoiceField): boolean {
  return field.multi && field.options.length > 1;
}

/**
 * Value a choice field contributes for its checked option indices and, when the user chose "Other",
 * that text. Blank Other text counts as no answer.
 */
export function choiceValue(
  field: ChoiceField,
  checked: ReadonlySet<number>,
  other?: string,
): AskFormValue | undefined {
  const typed = field.other ? other?.trim() : undefined;
  const values = field.options.flatMap((option, index) =>
    checked.has(index) && !option.disabled ? [option.value] : [],
  );
  if (isArrayChoice(field)) return typed ? [...values, typed] : values;
  return typed || values[0];
}

/** A number for non-empty numeric `number`/`range` inputs, else the text. */
export function textValue(field: TextField, text: string): AskFormValue {
  if ((field.type === "number" || field.type === "range") && text.trim() !== "") {
    const number = Number(text);
    if (Number.isFinite(number)) return number;
  }
  return text;
}

function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${pattern})$`, "v");
  } catch {
    return undefined;
  }
}

/** Why `value` is not acceptable for `field`, or undefined when it is. */
export function fieldError(field: FormField, value: AskFormValue | undefined): AskFieldError | undefined {
  if (field.kind === "choice") {
    const empty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!field.required || !empty) return undefined;
    return isArrayChoice(field) ? { code: "selectAtLeastOne" } : { code: "required" };
  }
  const text = value === undefined ? "" : String(value);
  if (text.trim() === "") return field.required ? { code: "required" } : undefined;
  if (field.type === "number" || field.type === "range") {
    const number = Number(text);
    if (!Number.isFinite(number)) return { code: "enterNumber" };
    if (field.min !== undefined && number < field.min) return { code: "min", value: field.min };
    if (field.max !== undefined && number > field.max) return { code: "max", value: field.max };
  }
  if (field.minLength !== undefined && text.length < field.minLength) return { code: "minLength", value: field.minLength };
  if (field.maxLength !== undefined && text.length > field.maxLength) return { code: "maxLength", value: field.maxLength };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+$/.test(text)) return { code: "email" };
  if (field.type === "url" && !URL.canParse(text)) return { code: "url" };
  if (field.pattern && compilePattern(field.pattern)?.test(text) === false) {
    return { code: "pattern", pattern: field.pattern.length > 40 ? `${field.pattern.slice(0, 39)}…` : field.pattern };
  }
  return undefined;
}

/** The core's English wording of an error, kept for server messages and for the parity test. */
export function describeFieldErrorEnglish(error: AskFieldError): string {
  switch (error.code) {
    case "required": return "Required";
    case "selectAtLeastOne": return "Select at least one";
    case "enterNumber": return "Enter a number";
    case "min": return `Must be at least ${error.value}`;
    case "max": return `Must be at most ${error.value}`;
    case "minLength": return `Needs at least ${error.value} characters`;
    case "maxLength": return `At most ${error.value} characters`;
    case "email": return "Enter an email address";
    case "url": return "Enter a full URL";
    case "pattern": return `Must match ${error.pattern}`;
  }
}

/** What the user has done to one field: checked options and "Other" text, or the typed text. */
export type AskFieldState =
  | { kind: "choice"; checked: number[]; otherOn: boolean; other: string }
  | { kind: "text"; text: string };

export function initialFieldState(field: FormField): AskFieldState {
  if (field.kind === "text") return { kind: "text", text: field.value };
  return {
    kind: "choice",
    checked: field.options.flatMap((option, index) => (option.checked ? [index] : [])),
    otherOn: false,
    other: "",
  };
}

export function initialFormState(model: AskFormModel): AskFieldState[] {
  return model.fields.map(initialFieldState);
}

/** Value one field reports for its state; undefined when it contributes nothing. */
export function fieldValue(field: FormField, state: AskFieldState): AskFormValue | undefined {
  if (field.kind === "text") return textValue(field, state.kind === "text" ? state.text : "");
  if (state.kind !== "choice") return undefined;
  return choiceValue(field, new Set(state.checked), state.otherOn ? state.other : undefined);
}

/** Form data for the given field states: hidden pairs first, then each named field that has a value. */
export function formDataFromState(model: AskFormModel, states: readonly AskFieldState[]): AskFormData {
  const data: AskFormData = {};
  for (const [name, value] of model.hidden) setOwn(data, name, value);
  model.fields.forEach((field, index) => {
    const state = states[index];
    if (!field.name || !state) return;
    const value = fieldValue(field, state);
    if (value !== undefined) setOwn(data, field.name, value);
  });
  return data;
}

/** Data the form submits untouched (the core's `defaultFormData`). */
export function defaultFormData(model: AskFormModel): AskFormData {
  return formDataFromState(model, initialFormState(model));
}

/** Errors by field name for `data`; empty when every field is acceptable. */
export function formErrors(model: AskFormModel, data: AskFormData): Record<string, AskFieldError> {
  const errors: Record<string, AskFieldError> = {};
  for (const field of model.fields) {
    if (!field.name || getOwn(errors, field.name)) continue;
    const error = fieldError(field, getOwn(data, field.name));
    if (error) setOwn(errors, field.name, error);
  }
  return errors;
}

/** Index of the first field in document order that has an error, for focusing it. */
export function firstErrorIndex(model: AskFormModel, errors: Record<string, AskFieldError>): number {
  return model.fields.findIndex((field) => field.name !== "" && getOwn(errors, field.name) !== undefined);
}

/** Plain text of spans (the core's `spansText`). */
export function spansText(spans: readonly { text: string }[]): string {
  return spans.map((span) => span.text).join("");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The question the first field answers, for a notification title: its own label, else the text block
 * right before it, else its section title, else a lone option's label, else its name. Mirrors the core's
 * `fieldQuestions` for one field; empty when the form has no named field.
 */
export function firstAskFormQuestion(model: AskFormModel): string {
  for (const section of model.sections) {
    const title = spansText(section.title);
    let caption = "";
    for (const block of section.blocks) {
      if (block.kind === "field") {
        const field = model.fields[block.index];
        const own = spansText(field.label);
        const lone = field.kind === "choice" && field.options.length === 1 ? spansText(field.options[0].label) : "";
        return oneLine(own || caption || title || lone || field.name);
      }
      caption = block.kind === "text" ? spansText(block.spans) : "";
    }
  }
  return "";
}

export type AskChoiceState = Extract<AskFieldState, { kind: "choice" }>;

/** The user picks option `optionIndex`: a checkbox group toggles it, a radio group or select takes only it. */
export function pickOption(field: ChoiceField, state: AskChoiceState, optionIndex: number): AskChoiceState {
  if (!field.multi) return { ...state, checked: [optionIndex], otherOn: false };
  const checked = state.checked.includes(optionIndex)
    ? state.checked.filter((index) => index !== optionIndex)
    : [...state.checked, optionIndex].sort((a, b) => a - b);
  return { ...state, checked };
}

/** The user clicks the "Other" row: a checkbox group toggles it, a radio group moves the choice to it. */
export function toggleOther(field: ChoiceField, state: AskChoiceState): AskChoiceState {
  return field.multi ? { ...state, otherOn: !state.otherOn } : { ...state, checked: [], otherOn: true };
}

/** The user types in the "Other" box: non-blank text selects Other (and, for radios, drops the option). */
export function typeOther(field: ChoiceField, state: AskChoiceState, other: string): AskChoiceState {
  const typed = other.trim() !== "";
  return {
    ...state,
    other,
    otherOn: typed ? true : state.otherOn,
    checked: typed && !field.multi ? [] : state.checked,
  };
}

/**
 * Answers and errors are keyed by names the agent wrote, so a name like `__proto__` or `constructor`
 * must behave as an ordinary key: written as an own property and read only when it is one.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: NoInfer<T>): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function getOwn<T>(source: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}
