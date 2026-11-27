"use client";

import { useMemo, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { rehypeFileLineLinks, resolveLocalFileHref, resolveLocalFileLink, type OpenFileHandler } from "@/lib/file-links";
import { encodeFilePathForApi } from "@/lib/file-paths";
import { markdownRehypePlugins, markdownRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { MermaidBlock, CodeBlock } from "./MermaidBlock";
import { A2uiFence, A2uiMarkdownSource } from "./a2ui/A2uiSession";
import { A2UI_LANG } from "@/lib/a2ui/blocks";

const fileLinkRehypePlugins = [rehypeFileLineLinks, ...(markdownRehypePlugins ?? [])];

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: OpenFileHandler;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile }: MarkdownBodyProps) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(children), [children]);
  // Stable renderer identities keep stateful blocks mounted across message hover updates.
  const components = useMemo<Components>(() => ({
    code({ className, children, node, ...props }) {
      const lang = className?.replace("language-", "").toLowerCase() ?? "";
      const raw = String(children);
      const isBlock = className?.includes("language-") || raw.includes("\n");
      if (isBlock) {
        if (lang === "mermaid") {
          return <MermaidBlock code={raw.replace(/\n$/, "")} isStreaming={isStreaming} />;
        }
        if (lang === A2UI_LANG) {
          return <A2uiFence code={raw.replace(/\n$/, "")} offset={node?.position?.start.offset} isStreaming={isStreaming} />;
        }
        return <CodeBlock code={raw.replace(/\n$/, "")} lang={lang} isStreaming={isStreaming} />;
      }
      return (
        <code
          className="markdown-inline-code"
          {...props}
        >
          {children}
        </code>
      );
    },
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      const linkedFile = onOpenFile ? resolveLocalFileLink(href, cwd) : null;
      const openFile = onOpenFile;
      if (!linkedFile || !openFile) {
        return (
          <a href={href} {...props} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (event.defaultPrevented || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const target = event.currentTarget.getAttribute("target");
        if (target && target !== "_self") return;
        event.preventDefault();
        openFile(linkedFile.filePath, linkedFile.lines);
      };

      return (
        <a href={href} {...props} onClick={handleClick}>
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      delete props.node;
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? `/api/files/${encodeFilePathForApi(filePath)}?type=read`
        : src;
      // Dynamic local paths are served directly by the file API.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={imageSrc} alt={alt ?? ""} loading="lazy" {...props} />;
    },
    table({ children }) {
      return (
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  }), [cwd, isStreaming, onOpenFile]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <A2uiMarkdownSource.Provider value={normalizedMarkdown}>
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={onOpenFile ? fileLinkRehypePlugins : markdownRehypePlugins}
          components={components}
        >
          {normalizedMarkdown}
        </ReactMarkdown>
      </A2uiMarkdownSource.Provider>
    </div>
  );
}
