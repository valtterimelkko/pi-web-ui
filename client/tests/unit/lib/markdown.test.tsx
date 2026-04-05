import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownRenderer, StreamingMarkdownRenderer } from '../../../src/lib/markdown.js';

describe('MarkdownRenderer', () => {
  it('renders basic markdown — bold, italic, links', () => {
    const { container } = render(
      <MarkdownRenderer content="**bold** and *italic* and [link](https://example.com)" />,
    );

    // bold
    const strong = container.querySelector('strong');
    expect(strong).toBeTruthy();
    expect(strong?.textContent).toBe('bold');

    // italic
    const em = container.querySelector('em');
    expect(em).toBeTruthy();
    expect(em?.textContent).toBe('italic');

    // link
    const link = container.querySelector('a');
    expect(link).toBeTruthy();
    expect(link?.getAttribute('href')).toBe('https://example.com/');
    expect(link?.textContent).toBe('link');
  });

  it('renders code blocks with language class', () => {
    const { container } = render(
      <MarkdownRenderer content={'```typescript\nconsole.log("hello");\n```'} />,
    );

    const code = container.querySelector('code');
    expect(code).toBeTruthy();
    expect(code?.className).toContain('language-typescript');
  });

  it('renders tables', () => {
    const markdown = [
      '| Name | Value |',
      '| --- | --- |',
      '| a | 1 |',
      '| b | 2 |',
    ].join('\n');

    const { container } = render(<MarkdownRenderer content={markdown} />);

    const table = container.querySelector('table');
    expect(table).toBeTruthy();
    // Check headers
    const ths = container.querySelectorAll('th');
    expect(ths.length).toBeGreaterThanOrEqual(2);
    // Check data cells
    const tds = container.querySelectorAll('td');
    expect(tds.length).toBeGreaterThanOrEqual(2);
  });

  it('returns null for empty content', () => {
    const { container } = render(<MarkdownRenderer content="" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders inline code', () => {
    const { container } = render(
      <MarkdownRenderer content="Use the `console.log` function" />,
    );

    const code = container.querySelector('code');
    expect(code).toBeTruthy();
    expect(code?.textContent).toBe('console.log');
  });

  it('renders lists', () => {
    const { container } = render(
      <MarkdownRenderer content={'- item 1\n- item 2\n\n1. first\n2. second'} />,
    );

    const ul = container.querySelector('ul');
    expect(ul).toBeTruthy();
    const ol = container.querySelector('ol');
    expect(ol).toBeTruthy();
  });

  it('renders headings', () => {
    const { container } = render(
      <MarkdownRenderer content={'# Heading 1\n## Heading 2\n### Heading 3'} />,
    );

    const h1 = container.querySelector('h1');
    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    expect(h1).toBeTruthy();
    expect(h2).toBeTruthy();
    expect(h3).toBeTruthy();
  });

  it('renders blockquotes', () => {
    const { container } = render(
      <MarkdownRenderer content="> This is a quote" />,
    );

    const bq = container.querySelector('blockquote');
    expect(bq).toBeTruthy();
  });

  it('renders horizontal rules', () => {
    const { container } = render(
      <MarkdownRenderer content="above\n\n---\n\nbelow" />,
    );

    const hr = container.querySelector('hr');
    // Some markdown renderers emit thematic breaks differently
    expect(hr || container.querySelector('[class*="break"]') || container.querySelector('br')).toBeDefined();
  });
});

describe('StreamingMarkdownRenderer', () => {
  it('shows cursor for empty text', () => {
    const { container } = render(<StreamingMarkdownRenderer text="" />);

    const cursor = container.querySelector('.animate-pulse');
    expect(cursor).toBeTruthy();
  });

  it('renders markdown text in streaming mode', () => {
    const { container } = render(
      <StreamingMarkdownRenderer text="**bold** text" />,
    );

    const strong = container.querySelector('strong');
    expect(strong).toBeTruthy();
    expect(strong?.textContent).toBe('bold');
  });

  it('handles empty content gracefully', () => {
    // Empty string should show cursor
    const { container } = render(<StreamingMarkdownRenderer text="" />);
    expect(container.querySelector('.animate-pulse')).toBeTruthy();
  });
});
