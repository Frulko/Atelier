import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rendu Markdown (réponses de l'assistant, connaissances). react-markdown n'interprète PAS le HTML brut : ce qui est écrit
 * comme une balise s'affiche comme du texte. Les liens sont limités à http(s) et mailto, et s'ouvrent à part.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx("md grid gap-3 text-[15px] leading-relaxed [&>*:first-child]:mt-0", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <h3 className="font-display mt-2 text-lg" {...p} />,
          h2: (p) => <h3 className="font-display mt-2 text-base" {...p} />,
          h3: (p) => <h4 className="mt-1 text-[15px] font-semibold" {...p} />,
          h4: (p) => <h4 className="mt-1 text-[15px] font-semibold" {...p} />,
          p: (p) => <p className="whitespace-pre-wrap" {...p} />,
          ul: (p) => <ul className="ml-5 grid list-disc gap-1" {...p} />,
          ol: (p) => <ol className="ml-5 grid list-decimal gap-1" {...p} />,
          blockquote: (p) => <blockquote className="border-l-2 border-line-strong pl-4 text-muted" {...p} />,
          hr: () => <hr className="border-line" />,
          a: ({ href, children: c }) => /^(https?:|mailto:)/i.test(href ?? "") ? <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline-offset-2 hover:underline">{c}</a> : <span>{c}</span>,
          pre: (p) => <pre className="overflow-x-auto rounded-lg border border-line bg-line/40 p-3 font-mono text-[13px] leading-relaxed" {...p} />,
          code: ({ className: c, children: ch, ...rest }) => c ? <code className={c} {...rest}>{ch}</code> : <code className="rounded bg-line/70 px-1 py-0.5 font-mono text-[0.85em]" {...rest}>{ch}</code>,
          table: (p) => <div className="overflow-x-auto"><table className="w-full border-collapse text-sm" {...p} /></div>,
          th: (p) => <th className="border-b border-line-strong px-3 py-1.5 text-left font-medium" {...p} />,
          td: (p) => <td className="border-b border-line px-3 py-1.5" {...p} />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
