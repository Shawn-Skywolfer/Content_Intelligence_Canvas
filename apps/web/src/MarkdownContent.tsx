import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const PLUGINS = [remarkGfm];
export default function MarkdownContent({ children }: { children: string }) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={PLUGINS} components={{
    th: ({ children, style }) => <th scope="col" style={style}>{children}</th>,
    table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
    a: ({ href, children }) => <a href={href} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{children}</a>,
  }}>{children}</ReactMarkdown></div>;
}
