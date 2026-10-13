import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The token layer, checked rather than asserted in a comment.
 *
 * Contrast is a property of the two colours actually used together, so this test reads the two
 * theme blocks out of the stylesheet, resolves the pairs the interface really paints, and computes
 * WCAG 2.1 relative-luminance ratios. A comment that claims "5.1:1" is not evidence; this is.
 */

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No ${selector} block in tokens.css`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    if (match[1] !== undefined && match[2] !== undefined) tokens[match[1]] = match[2];
  }
  return tokens;
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const one = luminance(a);
  const two = luminance(b);
  const [light, dark] = one >= two ? [one, two] : [two, one];
  return (light + 0.05) / (dark + 0.05);
}

const light = block(':root');
const dark = block("[data-theme='dark']");

/** Pairs that carry text, with the ratio WCAG 2.1 requires for that size. */
const PAIRS: { fg: string; bg: string; min: number; where: string }[] = [
  { fg: 'ink', bg: 'paper', min: 4.5, where: 'body text on the page' },
  { fg: 'ink', bg: 'surface', min: 4.5, where: 'body text on a panel' },
  { fg: 'ink', bg: 'surface-sunken', min: 4.5, where: 'table rows' },
  { fg: 'muted', bg: 'paper', min: 4.5, where: 'metadata on the page' },
  { fg: 'muted', bg: 'surface', min: 4.5, where: 'metadata on a panel' },
  { fg: 'primary', bg: 'paper', min: 4.5, where: 'accent text' },
  { fg: 'primary', bg: 'surface', min: 4.5, where: 'accent text on a panel' },
  { fg: 'primary-ink', bg: 'primary', min: 4.5, where: 'text on a primary button' },
  { fg: 'ink-soft', bg: 'surface', min: 4.5, where: 'secondary text' },
  { fg: 'ok', bg: 'surface', min: 4.5, where: 'the ok tag' },
  { fg: 'warn', bg: 'surface', min: 4.5, where: 'the warning tag' },
  { fg: 'danger', bg: 'surface', min: 4.5, where: 'the danger tag' },
  { fg: 'teal', bg: 'surface', min: 4.5, where: 'the info tag' },
];

describe.each([
  ['Chart Paper (light)', light],
  ['Night Voyage (dark)', dark],
])('%s theme', (_name, theme) => {
  for (const pair of PAIRS) {
    it(`keeps ${pair.where} readable (${pair.fg} on ${pair.bg})`, () => {
      const fg = theme[pair.fg];
      const bg = theme[pair.bg];
      expect(fg, `--${pair.fg} is missing`).toBeTypeOf('string');
      expect(bg, `--${pair.bg} is missing`).toBeTypeOf('string');
      const ratio = contrast(fg as string, bg as string);
      expect(
        ratio,
        `${pair.where}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the ${pair.min}:1 requirement`,
      ).toBeGreaterThanOrEqual(pair.min);
    });
  }
});

describe('the two themes', () => {
  it('is designed rather than inverted: the accents are not the light values', () => {
    expect(dark.ink).not.toBe(light.ink);
    expect(dark.paper).not.toBe(light.paper);
    expect(dark.primary).not.toBe(light.primary);
    expect(dark.surface).not.toBe(light.surface);
  });

  it('carries no colour outside the token layer', () => {
    // A stray hex in a component stylesheet is how a theme quietly stops being one system.
    for (const file of [
      'base.css',
      'shell.css',
      'files.css',
      'dialogs.css',
      'auth.css',
      'status.css',
      'upload.css',
      'chart.css',
    ]) {
      const stylesheet = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      const stray = [...stylesheet.matchAll(/#[0-9a-fA-F]{3,8}\b/g)]
        .map((match) => match[0])
        .filter((value) => value.toLowerCase() !== '#fff' && value.toLowerCase() !== '#ffffff');
      expect(stray, `${file} contains literal colours: ${stray.join(', ')}`).toEqual([]);
    }
  });
});

describe('reduced motion', () => {
  it('collapses the motion tokens to zero when the operating system asks for less', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const reduced = /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(reduced).toContain('--motion-fast: 0ms');
    expect(reduced).toContain('--motion-slow: 0ms');
    expect(reduced).toContain('--motion-draw: 0ms');
  });

  it('is not the only accommodation: the drawn ornament stops animating too', () => {
    const chart = readFileSync(new URL('./chart.css', import.meta.url), 'utf8');
    const reducedBlock =
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\n\}/.exec(chart)?.[0] ?? '';
    expect(reducedBlock).toContain('.ink-in');
    expect(reducedBlock).toContain('animation: none');
  });
});

describe('higher contrast request', () => {
  it('thickens the rules and steps the chart layer back rather than inventing new colours', () => {
    const block = /@media \(prefers-contrast: more\)[\s\S]*?\n\}/.exec(css)?.[0] ?? '';
    expect(block).toContain('--border-rule: 3px');
    expect(block).toContain('--chartlayer-opacity: 0.12');
    expect(block).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
