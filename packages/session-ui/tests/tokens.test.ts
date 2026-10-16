/**
 * Token defaults must reproduce Pi Web UI's pre-extraction palette exactly
 * (the values client/tailwind.config.js hard-coded before step 1a), and the
 * preset must route every semantic colour through a token.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..');
const css = readFileSync(resolve(ROOT, 'src/tokens.css'), 'utf8');
const preset = createRequire(resolve(ROOT, 'package.json'))('./tailwind-preset.cjs');

function token(name: string): string {
  const match = css.match(new RegExp(`--sv-${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`missing token --sv-${name}`);
  return match[1].trim();
}

const hex = (value: string): string => '#' + value.split(/\s+/).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

describe('session-ui tokens', () => {
  it.each([
    ['canvas', '#fcfcfb'], ['canvas-dark', '#18181b'],
    ['surface', '#ffffff'], ['surface-subtle', '#fafaf9'], ['surface-dark', '#27272a'], ['surface-dark-subtle', '#202023'],
    ['content-primary', '#0b0b0b'], ['content-secondary', '#52514e'], ['content-muted', '#898781'],
    ['content-primary-dark', '#f4f4f5'], ['content-secondary-dark', '#a1a1aa'], ['content-muted-dark', '#71717a'],
  ])('--sv-%s defaults to %s', (name, expected) => {
    expect(hex(token(name))).toBe(expected);
  });

  it.each([
    ['outline-subtle', 'rgba(11, 11, 11, 0.08)'], ['outline-default', 'rgba(11, 11, 11, 0.12)'],
    ['outline-subtle-dark', 'rgba(255, 255, 255, 0.08)'], ['outline-default-dark', 'rgba(255, 255, 255, 0.12)'],
  ])('--sv-%s defaults to %s', (name, expected) => {
    expect(token(name)).toBe(expected);
  });

  it('preset colours all resolve through --sv-* variables', () => {
    const colours = preset.theme.extend.colors as Record<string, Record<string, string> | string>;
    const semantic = ['canvas', 'surface', 'content', 'outline'].flatMap((family) => Object.values(colours[family] as Record<string, string>));
    expect(semantic.length).toBe(16);
    const values = Object.values(colours).flatMap((entry) => (typeof entry === 'string' ? [entry] : Object.values(entry)));
    for (const value of values) expect(value).toMatch(/var\(--sv-[a-z0-9-]+\)/);
  });

  it('preset exposes an absolute content glob for the host config', () => {
    expect(preset.sessionUiContent).toEqual([resolve(ROOT, 'src/**/*.{ts,tsx}')]);
  });
});
