"use client";

/**
 * The A2UI renderer for answer cards. Loaded only in the browser, on demand,
 * by `A2uiSessionProvider`: the basic catalog registers custom elements and
 * must never run during SSR or for chats without cards.
 *
 * Catalog: the v1 basic catalog minus every component that loads media or
 * draws decoration on its own (Image is replaced by an inline-only version;
 * Video, AudioPlayer, Icon, Modal and Divider are left out), plus CUELO's
 * Stat, Progress and BarChart. `openUrl` opens only http(s) addresses.
 */

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { Catalog, MessageProcessor, createFunctionImplementation, type ActionPayload, type SurfaceModel } from "@a2ui/web_core";
import { CommonSchemas } from "@a2ui/web_core/v1_0";
import { basicCatalog, ImageApi, OpenUrlApi } from "@a2ui/web_core/catalogs/basic/v1";
import { A2uiSurface, MarkdownComponentContext, createComponentImplementation, type ReactCatalogComponent } from "@a2ui/react";
import { isInlineImageUrl, safeExternalUrl } from "@/lib/a2ui/blocks";
import { CUELO_A2UI_CATALOG_ID, CUELO_A2UI_COMPONENTS } from "@/lib/a2ui/agent-prompt";

const formatValue = (value: unknown): string => {
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("ko-KR") : "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "예" : "아니요";
  return "";
};

const toNumber = (value: unknown): number | null => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
};

const InlineImage = createComponentImplementation(ImageApi, ({ props }) => {
  const label = props.description || "이미지";
  if (!isInlineImageUrl(props.url)) {
    return <span className="a2ui-c-image-alt">{label} (외부 주소 이미지는 표시하지 않아요)</span>;
  }
  // Inline data only: the browser never requests an address the agent wrote.
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="a2ui-c-image" src={props.url} alt={label} />;
});

const StatApi = {
  name: "Stat",
  schema: z.object({
    label: CommonSchemas.DynamicString,
    value: CommonSchemas.DynamicValue,
    delta: CommonSchemas.DynamicString.optional(),
    trend: z.enum(["up", "down", "flat"]).optional(),
  }),
};

const Stat = createComponentImplementation(StatApi, ({ props }) => (
  <span className="a2ui-c-stat">
    <span className="a2ui-c-stat-label">{props.label}</span>
    <span className="a2ui-c-stat-value">{formatValue(props.value)}</span>
    {props.delta ? <span className="a2ui-c-stat-delta" data-trend={props.trend ?? "flat"}>{props.delta}</span> : null}
  </span>
));

const ProgressApi = {
  name: "Progress",
  schema: z.object({
    label: CommonSchemas.DynamicString.optional(),
    value: CommonSchemas.DynamicNumber,
    max: CommonSchemas.DynamicNumber.optional(),
    caption: CommonSchemas.DynamicString.optional(),
  }),
};

const Progress = createComponentImplementation(ProgressApi, ({ props }) => {
  const max = toNumber(props.max) ?? 100;
  const value = Math.min(Math.max(toNumber(props.value) ?? 0, 0), max > 0 ? max : 0);
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="a2ui-c-progress">
      <span className="a2ui-c-progress-head">
        <span className="a2ui-c-progress-label">{props.label}</span>
        <span className="a2ui-c-progress-value">{max === 100 ? `${percent}%` : `${formatValue(value)}/${formatValue(max)} (${percent}%)`}</span>
      </span>
      <span
        className="a2ui-c-progress-track"
        role="progressbar"
        aria-label={props.label || undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <span className="a2ui-c-progress-fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </span>
      {props.caption ? <span className="a2ui-c-progress-caption">{props.caption}</span> : null}
    </span>
  );
});

const BarChartApi = {
  name: "BarChart",
  schema: z.object({
    title: CommonSchemas.DynamicString.optional(),
    labels: CommonSchemas.DynamicStringList,
    values: CommonSchemas.DynamicValue,
    unit: z.string().optional(),
  }),
};

const BarChart = createComponentImplementation(BarChartApi, ({ props }) => {
  const labels = Array.isArray(props.labels) ? props.labels.map(String) : [];
  const values = (Array.isArray(props.values) ? props.values : []).map((value) => toNumber(value) ?? 0);
  const rows = labels.map((label, index) => ({ label, value: values[index] ?? 0 }));
  const peak = Math.max(0, ...rows.map((row) => row.value));
  const unit = props.unit ?? "";
  return (
    <span className="a2ui-c-chart">
      {props.title ? <span className="a2ui-c-chart-title">{props.title}</span> : null}
      <span className="a2ui-c-chart-rows" role="list">
        {rows.map((row, index) => (
          <span className="a2ui-c-chart-row" role="listitem" key={`${row.label}-${index}`}>
            <span className="a2ui-c-chart-label">{row.label}</span>
            <span className="a2ui-c-chart-track" aria-hidden="true">
              <span className="a2ui-c-chart-bar" style={{ transform: `scaleX(${peak > 0 ? Math.max(row.value / peak, row.value > 0 ? 0.01 : 0) : 0})` }} />
            </span>
            <span className="a2ui-c-chart-value">{formatValue(row.value)}{unit}</span>
          </span>
        ))}
      </span>
    </span>
  );
});

const SafeOpenUrl = createFunctionImplementation(OpenUrlApi, (args) => {
  const url = safeExternalUrl(args.url);
  if (url) window.open(url, "_blank", "noopener,noreferrer");
});

function buildCatalog(id: string): Catalog<ReactCatalogComponent> {
  const own = [InlineImage, Stat, Progress, BarChart] as ReactCatalogComponent[];
  // The prompt's component list decides which basic components ship; CUELO's own replace same-named ones.
  const listed: readonly string[] = CUELO_A2UI_COMPONENTS;
  const basic = [...basicCatalog.components.values()]
    .filter((component) => listed.includes(component.name) && !own.some((mine) => mine.name === component.name));
  const functions = [...basicCatalog.functions.values()].map((fn) => (fn.name === OpenUrlApi.name ? SafeOpenUrl : fn));
  return new Catalog<ReactCatalogComponent>(id, "1.0", [...basic, ...own], functions);
}

const catalogs = [buildCatalog(CUELO_A2UI_CATALOG_ID), buildCatalog(basicCatalog.id)];

export function createProcessor(onAction: (action: ActionPayload) => void): MessageProcessor<never> {
  return new MessageProcessor(catalogs, onAction) as unknown as MessageProcessor<never>;
}

/** Markdown inside a card's Text: no raw HTML, no images, links only on click and only http(s). */
const cardMarkdownComponents: Components = {
  p: ({ children }) => <span className="a2ui-c-md-p">{children}</span>,
  h1: ({ children }) => <span className="a2ui-c-md-h" role="heading" aria-level={3}>{children}</span>,
  h2: ({ children }) => <span className="a2ui-c-md-h" role="heading" aria-level={3}>{children}</span>,
  h3: ({ children }) => <span className="a2ui-c-md-h" role="heading" aria-level={4}>{children}</span>,
  img: ({ alt }) => <span className="a2ui-c-image-alt">{alt || "이미지"}</span>,
  a: ({ href, children }) => {
    const url = safeExternalUrl(href);
    return url ? <a href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
};

function CardMarkdown({ markdown }: { markdown: string }): ReactNode {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={cardMarkdownComponents}>{markdown}</ReactMarkdown>;
}

export const SurfaceView = memo(function SurfaceView({ surface }: { surface: SurfaceModel<never> }) {
  return (
    <MarkdownComponentContext.Provider value={CardMarkdown}>
      <A2uiSurface surface={surface as unknown as SurfaceModel<ReactCatalogComponent>} />
    </MarkdownComponentContext.Provider>
  );
});
