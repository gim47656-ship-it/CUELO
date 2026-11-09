"use client";

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { type ActivityThrottle, createActivityThrottle } from "@/lib/ask-form/activity-throttle";
import {
  type AskFieldState,
  getOwn,
  firstErrorIndex,
  formDataFromState,
  formErrors,
  initialFormState,
  pickOption,
  spansText,
  toggleOther,
  typeOther,
} from "@/lib/ask-form/answers";
import {
  ASK_FORM_ACTIVITY_PREFIX,
  type AskFieldError,
  type AskFormBlock,
  type AskFormModel,
  type ChoiceField,
  type FormSpan,
  type TextField,
} from "@/lib/ask-form/types";
import type { ExtensionUiRequest } from "@/lib/types";
import type { ExtensionResponseState } from "@/hooks/useAgentSession";

export type AskFormRequest = Extract<ExtensionUiRequest, { method: "form" }>;

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** The card reports edits at most this often so a timed form's server wait restarts without a request per keystroke. */
const ACTIVITY_INTERVAL_MS = 1_000;

/** `<input type>` values the card draws as such; anything else the agent wrote falls back to plain text. */
const INPUT_TYPES: Record<string, true> = {
  text: true, search: true, tel: true, url: true, email: true, number: true, password: true, date: true,
  time: true, "datetime-local": true, month: true, week: true, color: true, range: true,
};

const controlStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  padding: "0 10px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  // The shared :focus-visible ring is the only focus cue; no inline outline override here.
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--seed-font-family)",
  fontSize: "var(--seed-font-size-t4-static)",
};

const secondaryButton: CSSProperties = {
  minHeight: 36,
  padding: "0 12px",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

function errorText(error: AskFieldError, t: Translate): string {
  switch (error.code) {
    case "min":
    case "max":
    case "minLength":
    case "maxLength":
      return t(`chat.formError.${error.code}`, { value: error.value });
    case "pattern":
      return t("chat.formError.pattern", { pattern: error.pattern });
    default:
      return t(`chat.formError.${error.code}`);
  }
}

function Spans({ spans }: { spans: readonly FormSpan[] }) {
  return (
    <>
      {spans.map((span, spanIndex) => {
        const parts: ReactNode[] = [];
        span.text.split("\n").forEach((line, lineIndex) => {
          if (lineIndex > 0) parts.push(<br key={`br-${lineIndex}`} />);
          parts.push(line);
        });
        if (span.style === "code") {
          return (
            <code key={spanIndex} style={{ padding: "0 4px", borderRadius: 4, background: "var(--bg-subtle)", fontFamily: "var(--font-mono)", fontSize: "0.92em" }}>
              {parts}
            </code>
          );
        }
        if (span.style === "strong") return <strong key={spanIndex} style={{ fontWeight: 600 }}>{parts}</strong>;
        if (span.style === "em") return <em key={spanIndex}>{parts}</em>;
        return <span key={spanIndex}>{parts}</span>;
      })}
    </>
  );
}

function FormImage({ src, alt }: { src: string | null; alt: string }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", overflowWrap: "anywhere" }}>
        {alt || t("chat.formImageUnavailable")}
      </p>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a server-resolved data: URI; there is nothing for next/image to optimise
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      style={{ display: "block", maxWidth: "100%", maxHeight: 320, height: "auto", objectFit: "contain", borderRadius: "var(--radius-control)" }}
    />
  );
}

function ContextBlock({ block, id }: { block: Exclude<AskFormBlock, { kind: "field" }>; id: string }) {
  const textStyle: CSSProperties = { margin: 0, color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", lineHeight: 1.55, overflowWrap: "anywhere" };
  switch (block.kind) {
    case "text":
      return (
        <p id={id} style={{ ...textStyle, fontWeight: block.heading ? 600 : 400 }}>
          <Spans spans={block.spans} />
        </p>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List style={{ ...textStyle, paddingInlineStart: 22 }}>
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}><Spans spans={item} /></li>
          ))}
        </List>
      );
    }
    case "pre":
      return (
        <pre
          tabIndex={0}
          style={{ margin: 0, padding: "8px 10px", overflowX: "auto", maxWidth: "100%", border: "1px solid var(--hairline)", borderRadius: "var(--radius-control)", background: "var(--bg-subtle)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.5 }}
        >
          {block.text}
        </pre>
      );
    case "table":
      return (
        <div tabIndex={0} style={{ maxWidth: "100%", overflowX: "auto", border: "1px solid var(--hairline)", borderRadius: "var(--radius-control)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "var(--seed-font-size-t3-static)", fontVariantNumeric: "tabular-nums" }}>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const Cell = rowIndex < block.headerRows ? "th" : "td";
                    return (
                      <Cell
                        key={cellIndex}
                        scope={rowIndex < block.headerRows ? "col" : undefined}
                        style={{ padding: "6px 10px", borderBottom: "1px solid var(--hairline)", color: rowIndex < block.headerRows ? "var(--text-muted)" : "var(--text)", fontWeight: rowIndex < block.headerRows ? 600 : 400, textAlign: "left", verticalAlign: "top", minWidth: 72 }}
                      >
                        <Spans spans={cell} />
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return <FormImage src={block.src} alt={block.alt} />;
  }
}

interface FieldProps {
  id: string;
  index: number;
  state: AskFieldState;
  error: AskFieldError | undefined;
  /** Id of the text block the agent put right before the field, which names a group without its own label. */
  captionId: string | undefined;
  /** Plain-text fallback name: the section title or the field's `name`. */
  fallbackName: string;
  onChange: (index: number, next: AskFieldState) => void;
}

function FieldShell({
  field,
  id,
  index,
  error,
  children,
  hasLabel,
}: {
  field: ChoiceField | TextField;
  id: string;
  index: number;
  error: AskFieldError | undefined;
  children: ReactNode;
  hasLabel: boolean;
}) {
  const { t } = useI18n();
  return (
    <div data-field={index} style={{ display: "grid", gap: 6, minWidth: 0 }}>
      {(hasLabel || field.required) && (
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          {hasLabel && (
            <label
              id={`${id}-label`}
              htmlFor={field.kind === "text" || field.select ? id : undefined}
              style={{ color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", fontWeight: 600, lineHeight: 1.5 }}
            >
              <Spans spans={field.label} />
            </label>
          )}
          {field.required && (
            <span style={{ marginLeft: hasLabel ? 0 : "auto", color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontWeight: 600 }}>
              {t("chat.formRequired")}
            </span>
          )}
        </div>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} style={{ margin: 0, display: "flex", alignItems: "flex-start", gap: 6, color: "var(--danger)", fontSize: "var(--seed-font-size-t3-static)", fontWeight: 500, lineHeight: 1.45 }}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" style={{ flex: "none", marginTop: 2 }}>
            <circle cx="7" cy="7" r="5.5" />
            <path d="M7 4v3.4M7 9.6v.1" />
          </svg>
          <span>{errorText(error, t)}</span>
        </p>
      )}
    </div>
  );
}

function ChoiceControl({ field, id, index, state, error, captionId, fallbackName, onChange }: FieldProps & { field: ChoiceField }) {
  const { t } = useI18n();
  const otherRef = useRef<HTMLInputElement | null>(null);
  if (state.kind !== "choice") return null;
  const hasLabel = field.label.length > 0;
  const group = {
    "aria-labelledby": hasLabel ? `${id}-label` : captionId,
    "aria-label": hasLabel || captionId ? undefined : fallbackName,
    "aria-required": field.required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  } as const;

  if (field.select && !field.multi) {
    return (
      <FieldShell field={field} id={id} index={index} error={error} hasLabel={hasLabel}>
        <select
          id={id}
          {...group}
          value={String(state.checked[0] ?? "")}
          onChange={(event) => onChange(index, pickOption(field, state, Number(event.target.value)))}
          style={{ ...controlStyle, height: 36 }}
        >
          {field.options.map((option, optionIndex) => (
            <option key={optionIndex} value={optionIndex} disabled={option.disabled}>
              {spansText(option.label)}
            </option>
          ))}
        </select>
      </FieldShell>
    );
  }

  const inputType = field.multi ? "checkbox" : "radio";
  const rowStyle = (checked: boolean, disabled: boolean): CSSProperties => ({
    display: "grid",
    gridTemplateColumns: "16px minmax(0, 1fr)",
    alignItems: "start",
    gap: 9,
    minHeight: 40,
    padding: "9px 10px",
    border: `1px solid ${checked ? "var(--border-strong)" : "transparent"}`,
    borderRadius: "var(--radius-control)",
    background: checked ? "var(--bg-selected)" : "transparent",
    color: disabled ? "var(--text-dim)" : "var(--text)",
    cursor: disabled ? "not-allowed" : "pointer",
    fontSize: "var(--seed-font-size-t4-static)",
    lineHeight: 1.5,
    overflowWrap: "anywhere",
  });
  const inputStyle: CSSProperties = { width: 16, height: 16, margin: "3px 0 0", accentColor: "var(--seed-color-fg-neutral)" };
  const name = `${id}-choice`;

  return (
    <FieldShell field={field} id={id} index={index} error={error} hasLabel={hasLabel}>
      <div role={field.multi ? "group" : "radiogroup"} {...group} style={{ display: "grid", gap: 4 }}>
        {field.options.map((option, optionIndex) => {
          const checked = state.checked.includes(optionIndex);
          return (
            <label key={optionIndex} style={rowStyle(checked, option.disabled)}>
              <input
                type={inputType}
                name={name}
                checked={checked}
                disabled={option.disabled}
                aria-required={field.required && !field.multi ? true : undefined}
                onChange={() => onChange(index, pickOption(field, state, optionIndex))}
                style={inputStyle}
              />
              <span><Spans spans={option.label} /></span>
            </label>
          );
        })}
        {field.other && (
          <div style={{ display: "grid", gap: 6 }}>
            <label style={rowStyle(state.otherOn, false)}>
              <input
                type={inputType}
                name={name}
                checked={state.otherOn}
                onChange={() => {
                  onChange(index, toggleOther(field, state));
                  if (!state.otherOn || !field.multi) otherRef.current?.focus();
                }}
                style={inputStyle}
              />
              <span>{t("chat.formOther")}</span>
            </label>
            <input
              ref={otherRef}
              type="text"
              value={state.other}
              aria-label={t("chat.formOther")}
              placeholder={t("chat.formOtherPlaceholder")}
              onChange={(event) => onChange(index, typeOther(field, state, event.target.value))}
              style={{ ...controlStyle, height: 36, width: "calc(100% - 35px)", marginInlineStart: 35 }}
            />
          </div>
        )}
      </div>
    </FieldShell>
  );
}

function TextControl({ field, id, index, state, error, captionId, fallbackName, onChange }: FieldProps & { field: TextField }) {
  if (state.kind !== "text") return null;
  const hasLabel = field.label.length > 0;
  const type = Object.hasOwn(INPUT_TYPES, field.type) ? field.type : "text";
  const common = {
    id,
    value: state.text,
    placeholder: field.placeholder || undefined,
    "aria-labelledby": hasLabel ? undefined : captionId,
    "aria-label": hasLabel || captionId ? undefined : fallbackName,
    "aria-required": field.required || undefined,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  } as const;
  const border = error ? "1px solid var(--danger)" : controlStyle.border;
  return (
    <FieldShell field={field} id={id} index={index} error={error} hasLabel={hasLabel}>
      {field.multiline ? (
        <textarea
          {...common}
          rows={Math.max(2, field.rows)}
          onChange={(event) => onChange(index, { kind: "text", text: event.target.value })}
          style={{ ...controlStyle, padding: "8px 10px", border, lineHeight: 1.5, resize: "vertical" }}
        />
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            {...common}
            type={type}
            min={type === "number" || type === "range" ? field.min : undefined}
            max={type === "number" || type === "range" ? field.max : undefined}
            step={type === "number" ? "any" : undefined}
            onChange={(event) => onChange(index, { kind: "text", text: event.target.value })}
            style={{ ...controlStyle, height: type === "color" ? 40 : 36, border, ...(type === "range" ? { padding: 0 } : {}), fontVariantNumeric: "tabular-nums" }}
          />
          {type === "range" && (
            <output htmlFor={id} style={{ minWidth: 32, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", fontVariantNumeric: "tabular-nums" }}>
              {state.text}
            </output>
          )}
        </div>
      )}
    </FieldShell>
  );
}

/**
 * The agent's HTML form drawn from its JSON model (lib/ask-form): sections, context blocks and fields
 * in one scrollable body, with the title row and the Cancel/Submit bar kept in view. The caller wraps it
 * in the shared response surface. Values live here; a timed form reports them to the server (at most
 * once a second) so the wait restarts and the server holds the latest values to submit at the deadline.
 */
export function AskForm({
  request,
  onRespond,
  onActivity,
  delivery,
}: {
  request: AskFormRequest;
  onRespond: (request: AskFormRequest, response: { value: string } | { cancelled: true }) => void;
  onActivity?: (request: AskFormRequest, data: string) => void;
  delivery?: ExtensionResponseState | null;
}) {
  const { t } = useI18n();
  const uid = useId();
  const model: AskFormModel = request.form;
  const [states, setStates] = useState<AskFieldState[]>(() => initialFormState(model));
  const statesRef = useRef(states);
  const [showErrors, setShowErrors] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  const requestRef = useRef(request);
  requestRef.current = request;
  const sending = delivery?.status === "sending";

  const throttleRef = useRef<ActivityThrottle | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = createActivityThrottle(() => {
      const current = requestRef.current;
      onActivityRef.current?.(current, ASK_FORM_ACTIVITY_PREFIX + JSON.stringify(formDataFromState(current.form, statesRef.current)));
    }, ACTIVITY_INTERVAL_MS);
  }
  useEffect(() => () => throttleRef.current?.cancel(), []);

  const updateField = useCallback((index: number, next: AskFieldState) => {
    const copy = statesRef.current.slice();
    copy[index] = next;
    statesRef.current = copy;
    setStates(copy);
    if (requestRef.current.timeout && onActivityRef.current) throttleRef.current?.notify();
  }, []);

  const data = formDataFromState(model, states);
  const errors = showErrors ? formErrors(model, data) : {};
  const hasErrors = Object.keys(errors).length > 0;

  const submit = () => {
    if (sending) return;
    const submitted = formDataFromState(model, statesRef.current);
    const found = formErrors(model, submitted);
    if (Object.keys(found).length > 0) {
      setShowErrors(true);
      const index = firstErrorIndex(model, found);
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-field="${index}"] input, [data-field="${index}"] select, [data-field="${index}"] textarea`)
        ?.focus();
      return;
    }
    onRespond(request, { value: JSON.stringify(submitted) });
  };

  const fieldProps = (index: number, captionId: string | undefined, fallbackName: string): FieldProps => {
    const field = model.fields[index];
    return {
      id: `${uid}-f${index}`,
      index,
      state: states[index],
      error: showErrors && field.name ? getOwn(errors, field.name) : undefined,
      captionId,
      fallbackName: fallbackName || field.name,
      onChange: updateField,
    };
  };

  return (
    <div data-ask-form="" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", fontWeight: 600 }}>{t("chat.agentQuestion")}</div>
        <div style={{ marginTop: 2, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)" }}>{t("chat.agentFormHint")}</div>
        {request.timeout ? (
          <div style={{ marginTop: 2, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)" }}>
            {t("chat.askFormAutoSubmitHint", { seconds: Math.round(request.timeout / 1000) })}
          </div>
        ) : null}
      </div>

      <div
        ref={bodyRef}
        onKeyDown={(event) => {
          // Plain Enter stays inside the control: a form this long must not submit on a stray key.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submit();
        }}
        style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: 16 }}
      >
        <div style={{ display: "grid", gap: 20, minWidth: 0 }}>
          {model.sections.map((section, sectionIndex) => {
            const title = spansText(section.title);
            let captionId: string | undefined;
            return (
              <section
                key={sectionIndex}
                aria-labelledby={title ? `${uid}-s${sectionIndex}` : undefined}
                style={{ display: "grid", gap: 12, minWidth: 0, paddingTop: sectionIndex === 0 ? 0 : 20, borderTop: sectionIndex === 0 ? "none" : "1px solid var(--hairline)" }}
              >
                {title && (
                  <h3 id={`${uid}-s${sectionIndex}`} style={{ margin: 0, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", fontWeight: 600, lineHeight: 1.4 }}>
                    <Spans spans={section.title} />
                  </h3>
                )}
                {section.blocks.map((block, blockIndex) => {
                  if (block.kind !== "field") {
                    const blockId = `${uid}-s${sectionIndex}b${blockIndex}`;
                    captionId = block.kind === "text" ? blockId : undefined;
                    return <ContextBlock key={blockIndex} block={block} id={blockId} />;
                  }
                  const field = model.fields[block.index];
                  const caption = captionId;
                  captionId = undefined;
                  const props = fieldProps(block.index, caption, title);
                  return field.kind === "choice"
                    ? <ChoiceControl key={blockIndex} {...props} field={field} />
                    : <TextControl key={blockIndex} {...props} field={field} />;
                })}
              </section>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
        {hasErrors && (
          <p role="alert" style={{ margin: 0, marginRight: "auto", color: "var(--danger)", fontSize: "var(--seed-font-size-t3-static)" }}>
            {t("chat.formInvalid")}
          </p>
        )}
        <button type="button" onClick={() => onRespond(request, { cancelled: true })} style={secondaryButton}>
          {t("chat.cancel")}
        </button>
        <button
          type="button"
          aria-disabled={sending || undefined}
          onClick={submit}
          style={{
            minHeight: 36,
            padding: "0 14px",
            border: "1px solid transparent",
            borderRadius: "var(--radius-control)",
            background: sending ? "var(--seed-color-bg-disabled)" : "var(--seed-color-bg-neutral-inverted)",
            color: sending ? "var(--seed-color-fg-disabled)" : "var(--seed-color-fg-neutral-inverted)",
            cursor: sending ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {sending ? t("chat.responseSending") : t("chat.submitAnswer")}
        </button>
      </div>
    </div>
  );
}
