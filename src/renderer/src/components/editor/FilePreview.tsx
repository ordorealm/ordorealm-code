/**
 * File Preview Component
 * Renders Markdown and HTML files in preview mode
 * @module components/editor/FilePreview
 */

import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useCodePreviewStore } from '@/stores/code-preview-store';
import { useAppearanceStore } from '@/stores/appearance-store';
import 'highlight.js/styles/github-dark.css';

/**
 * Markdown Preview Component
 * Renders Markdown content with syntax highlighting
 */
function MarkdownPreview({ content }: { content: string }): JSX.Element {
  return (
    <div className="markdown-preview h-full overflow-auto p-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Custom heading styles
          h1: ({ children }) => (
            <h1 className="text-2xl font-bold text-text-primary mb-4 pb-2 border-b border-border">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-bold text-text-primary mb-3 mt-6">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-lg font-semibold text-text-primary mb-2 mt-4">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-base font-semibold text-text-primary mb-2 mt-3">
              {children}
            </h4>
          ),
          // Paragraph
          p: ({ children }) => (
            <p className="text-sm text-text-secondary mb-3 leading-relaxed">
              {children}
            </p>
          ),
          // Lists
          ul: ({ children }) => (
            <ul className="list-disc list-inside text-sm text-text-secondary mb-3 space-y-1 ml-4">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside text-sm text-text-secondary mb-3 space-y-1 ml-4">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-sm text-text-secondary">
              {children}
            </li>
          ),
          // Code blocks
          pre: ({ children }) => (
            <pre className="bg-bg-tertiary rounded-lg p-4 mb-4 overflow-x-auto text-sm">
              {children}
            </pre>
          ),
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="bg-bg-tertiary text-accent-indigo px-1.5 py-0.5 rounded text-sm font-mono"
                  {...props}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...props}>
                {children}
              </code>
            );
          },
          // Blockquote
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-accent-indigo pl-4 py-2 mb-4 bg-bg-secondary rounded-r text-sm text-text-secondary italic">
              {children}
            </blockquote>
          ),
          // Links
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-indigo hover:underline"
            >
              {children}
            </a>
          ),
          // Tables
          table: ({ children }) => (
            <div className="overflow-x-auto mb-4">
              <table className="min-w-full border border-border rounded-lg overflow-hidden">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead className="bg-bg-secondary">{children}</thead>
          ),
          tbody: ({ children }) => (
            <tbody className="divide-y divide-border">{children}</tbody>
          ),
          tr: ({ children }) => (
            <tr className="divide-x divide-border">{children}</tr>
          ),
          th: ({ children }) => (
            <th className="px-4 py-2 text-left text-sm font-medium text-text-primary">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-4 py-2 text-sm text-text-secondary">
              {children}
            </td>
          ),
          // Horizontal rule
          hr: () => (
            <hr className="border-border my-6" />
          ),
          // Images
          img: ({ src, alt }) => (
            <img
              src={src}
              alt={alt}
              className="max-w-full h-auto rounded-lg mb-4"
              loading="lazy"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * HTML Preview Component
 * Renders HTML content in a sandboxed iframe
 */
function HtmlPreview({ content }: { content: string }): JSX.Element {
  const effectiveTheme = useAppearanceStore(state => state.effectiveTheme);
  const safetyMode = useCodePreviewStore(state => state.safetyMode);

  // Inject base styles for dark mode support
  const styledContent = useMemo(() => {
    const isDark = effectiveTheme === 'dark';
    const baseStyles = `
      <style>
        :root {
          color-scheme: ${isDark ? 'dark' : 'light'};
          --bg-primary: ${isDark ? '#0d1117' : '#ffffff'};
          --text-primary: ${isDark ? '#e6edf3' : '#1f2937'};
          --text-secondary: ${isDark ? '#8b949e' : '#6b7280'};
          --border-color: ${isDark ? '#30363d' : '#e5e7eb'};
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 14px;
          line-height: 1.6;
          margin: 0;
          padding: 16px;
          background: var(--bg-primary);
          color: var(--text-primary);
        }
        a { color: ${isDark ? '#58a6ff' : '#3b82f6'}; }
        code {
          background: ${isDark ? '#161b22' : '#f3f4f6'};
          padding: 2px 6px;
          border-radius: 4px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
        }
        pre {
          background: ${isDark ? '#161b22' : '#f3f4f6'};
          padding: 12px;
          border-radius: 8px;
          overflow-x: auto;
        }
        blockquote {
          border-left: 4px solid ${isDark ? '#30363d' : '#e5e7eb'};
          padding-left: 16px;
          margin-left: 0;
          color: var(--text-secondary);
        }
        table {
          border-collapse: collapse;
          width: 100%;
        }
        th, td {
          border: 1px solid var(--border-color);
          padding: 8px 12px;
          text-align: left;
        }
        th {
          background: ${isDark ? '#161b22' : '#f9fafb'};
        }
        img { max-width: 100%; height: auto; }
      </style>
    `;
    return baseStyles + content;
  }, [content, effectiveTheme]);

  // Compute sandbox attribute based on safety mode
  // Safe: only allow-same-origin (no JS, no popups)
  // Unsafe: allow-same-origin + allow-scripts + allow-popups
  const sandbox = safetyMode === 'safe'
    ? 'allow-same-origin'
    : 'allow-same-origin allow-scripts allow-popups';

  return (
    <iframe
      key={safetyMode}
      srcDoc={styledContent}
      sandbox={sandbox}
      className="w-full h-full border-0"
      title="HTML Preview"
    />
  );
}

/**
 * FilePreview Component
 * Renders file content based on file type
 */
export function FilePreview(): JSX.Element | null {
  const { currentFile } = useCodePreviewStore();

  if (!currentFile) return null;

  const isMarkdown = currentFile.path.toLowerCase().endsWith('.md') ||
                     currentFile.path.toLowerCase().endsWith('.markdown');

  if (isMarkdown) {
    return <MarkdownPreview content={currentFile.content} />;
  }

  if (currentFile.isHtml) {
    return <HtmlPreview content={currentFile.content} />;
  }

  // Fallback - should not happen as this component is only for previewable files
  return (
    <div className="h-full flex items-center justify-center text-text-muted">
      <p>此文件类型不支持预览</p>
    </div>
  );
}

export default FilePreview;
