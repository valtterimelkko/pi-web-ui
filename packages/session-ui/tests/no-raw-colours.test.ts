/**
 * The cards style colour only through tokens: semantic names (canvas, surface,
 * content, outline) or the sv-* palette. A raw Tailwind palette utility
 * (`text-emerald-600`, `bg-white`) or an arbitrary colour (`bg-[#fff]`) would
 * bypass the --sv-* variables and so escape a host's restyling.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const preset = createRequire(resolve(ROOT, 'package.json'))('./tailwind-preset.cjs');
const tokensCss = readFileSync(resolve(SRC, 'tokens.css'), 'utf8');
const tailwindColors = createRequire(resolve(ROOT, 'package.json'))('tailwindcss/colors') as Record<string, Record<string, string> | string>;

const PALETTE = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const PROPS = 'bg|text|border|ring|divide|from|to|via|fill|stroke|outline|decoration|placeholder|shadow|caret|accent';
const RAW = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:${PROPS})(?:-[trblxy])?-(?:(?:${PALETTE})-\\d{2,3}|white|black|\\[(?:#|rgb|hsl))`, 'g');
const TOKEN_USE = new RegExp(`(?<![\\w-])(?:[a-z-]+:)*(?:${PROPS})-(sv-[a-z-]+?(?:-\\d+)?)(?:/\\d+)?(?![\\w-])`, 'g');

const sources = readdirSync(SRC).filter((name) => /\.(ts|tsx)$/.test(name))
  .map((name) => ({ name, text: readFileSync(resolve(SRC, name), 'utf8') }));

describe('session-ui colours go through tokens', () => {
  it.each(sources.map((s) => [s.name, s.text]))('%s has no raw palette or arbitrary colour utilities', (_name, text) => {
    expect((text as string).match(RAW) ?? []).toEqual([]);
  });

  it('detects a raw utility (the check itself works)', () => {
    expect('x text-emerald-600 dark:bg-white hover:border-[#fff] bg-sv-ok-50'.match(RAW)).toEqual([
      'text-emerald-600', 'dark:bg-white', 'hover:border-[#',
    ]);
  });

  it('every sv-* colour used has a preset entry backed by a --sv-* variable', () => {
    const palette = preset.theme.extend.colors as Record<string, unknown>;
    const used = new Set(sources.flatMap((s) => [...s.text.matchAll(TOKEN_USE)].map((m) => m[1])));
    expect(used.size).toBeGreaterThan(40);
    for (const name of used) {
      expect(palette[name], name).toBe(`rgb(var(--${name}) / <alpha-value>)`);
      expect(tokensCss, name).toMatch(new RegExp(`--${name}:\\s*\\d+ \\d+ \\d+;`));
    }
  });

  it('palette token defaults equal the Tailwind shades the cards used before', () => {
    const declared = [...tokensCss.matchAll(/(--sv-[a-z-]+(?:-\d+)?):\s*(\d+ \d+ \d+);\s*\/\* ([a-z]+)(?:-(\d+))? /g)];
    expect(declared.length).toBeGreaterThan(40);
    for (const [, name, channels, hue, shade] of declared) {
      const family = tailwindColors[hue];
      const hex = (shade ? (family as Record<string, string>)[shade] : family) as string;
      const full = hex.length === 4 ? '#' + [...hex.slice(1)].map((c) => c + c).join('') : hex;
      const rgb = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16)).join(' ');
      expect(channels, name).toBe(rgb);
    }
  });

  it('dark remaps only target token classes the cards use', () => {
    const remapped = [...tokensCss.matchAll(/^\.dark \.(?:hover\\:)?((?:bg|text|border)-sv-[a-z]+(?:-[a-z]+)*(?:-\d+)?)[\s:]/gm)].map((m) => m[1]);
    expect(remapped.length).toBe(33);
    const all = sources.map((s) => s.text).join('\n');
    for (const cls of remapped) expect(all, cls).toMatch(new RegExp(`(?<![\\w-])${cls}(?![\\w/-])`));
  });
});
