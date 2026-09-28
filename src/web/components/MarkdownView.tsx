import Markdown, { type Components } from 'react-markdown';

const components: Components = {
  a({ href = '', children }) {
    const external = /^https?:\/\//i.test(href);
    return (
      <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
        {children}
      </a>
    );
  },
  img({ alt = '' }) {
    return <span className="markdown-image-placeholder">[图片：{alt || '无替代文本'}]</span>;
  },
};

export function MarkdownView({ content, label }: { content: string; label: string }) {
  return (
    <article className="markdown-view" aria-label={label}>
      <Markdown components={components}>{content}</Markdown>
    </article>
  );
}
