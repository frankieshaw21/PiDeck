import React, { useEffect, useId, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cjkStrong } from "./cjk-strong.js";
import DOMPurify from "dompurify";

function Diagram({ source }: { source: string }) {
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setSvg(null);
    const timer = window.setTimeout(() => {
      void import("mermaid").then(async ({ default: mermaid }) => {
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, flowchart: { htmlLabels: false } });
        if (!(await mermaid.parse(source, { suppressErrors: true }))) return;
        const result = await mermaid.render(id, source);
        if (active) setSvg(DOMPurify.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ["foreignObject"] }));
      }).catch(() => { /* Keep the source visible while incomplete or invalid. */ });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [id, source]);
  return svg ? <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} /> : <pre><code>{source}</code></pre>;
}

export const MarkdownMessage = React.memo(function MarkdownMessage({ text }: { text: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, cjkStrong]} skipHtml components={{
    pre({ children }) {
      const child = React.Children.toArray(children)[0];
      if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) && /(?:^|\s)language-mermaid(?:\s|$)/.test(child.props.className ?? "")) {
        return <Diagram source={String(child.props.children ?? "").replace(/\n$/, "")} />;
      }
      return <pre>{children}</pre>;
    },
    a({ href, children }) {
      return <a href={href} onClick={(event) => { event.preventDefault(); if (href) void window.piHarness.openExternal(href); }}>{children}</a>;
    },
    img({ alt }) { return <span>{alt ?? ""}</span>; },
  }}>{text}</ReactMarkdown></div>;
});
