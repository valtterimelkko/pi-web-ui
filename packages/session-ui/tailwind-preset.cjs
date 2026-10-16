/**
 * Tailwind preset for @pi-web-ui/session-ui (command-centre step 1a).
 *
 * Maps the cards' semantic colour and font names onto the `--sv-*` variables
 * in src/tokens.css (import that file once in the host's CSS). Tailwind does
 * not merge `content` from presets, so the host must ALSO add `content` (the
 * absolute glob exported here) to its own config, or the cards' classes are
 * purged.
 */
const channel = (name) => `rgb(var(--sv-${name}) / <alpha-value>)`;

// Palette tokens (src/tokens.css), in Tailwind's default palette order so the
// generated utilities keep their relative order (it decides ties on one element).
const palette = {
  'sv-white': 'rgb(var(--sv-white) / <alpha-value>)',
  'sv-neutral-slate-100': 'rgb(var(--sv-neutral-slate-100) / <alpha-value>)',
  'sv-neutral-slate-200': 'rgb(var(--sv-neutral-slate-200) / <alpha-value>)',
  'sv-neutral-slate-800': 'rgb(var(--sv-neutral-slate-800) / <alpha-value>)',
  'sv-neutral-slate-900': 'rgb(var(--sv-neutral-slate-900) / <alpha-value>)',
  'sv-neutral-50': 'rgb(var(--sv-neutral-50) / <alpha-value>)',
  'sv-neutral-100': 'rgb(var(--sv-neutral-100) / <alpha-value>)',
  'sv-neutral-200': 'rgb(var(--sv-neutral-200) / <alpha-value>)',
  'sv-neutral-300': 'rgb(var(--sv-neutral-300) / <alpha-value>)',
  'sv-neutral-400': 'rgb(var(--sv-neutral-400) / <alpha-value>)',
  'sv-neutral-500': 'rgb(var(--sv-neutral-500) / <alpha-value>)',
  'sv-neutral-600': 'rgb(var(--sv-neutral-600) / <alpha-value>)',
  'sv-neutral-700': 'rgb(var(--sv-neutral-700) / <alpha-value>)',
  'sv-neutral-800': 'rgb(var(--sv-neutral-800) / <alpha-value>)',
  'sv-neutral-900': 'rgb(var(--sv-neutral-900) / <alpha-value>)',
  'sv-neutral-plain-100': 'rgb(var(--sv-neutral-plain-100) / <alpha-value>)',
  'sv-neutral-plain-800': 'rgb(var(--sv-neutral-plain-800) / <alpha-value>)',
  'sv-error-50': 'rgb(var(--sv-error-50) / <alpha-value>)',
  'sv-error-200': 'rgb(var(--sv-error-200) / <alpha-value>)',
  'sv-error-300': 'rgb(var(--sv-error-300) / <alpha-value>)',
  'sv-error-400': 'rgb(var(--sv-error-400) / <alpha-value>)',
  'sv-error-500': 'rgb(var(--sv-error-500) / <alpha-value>)',
  'sv-error-600': 'rgb(var(--sv-error-600) / <alpha-value>)',
  'sv-error-700': 'rgb(var(--sv-error-700) / <alpha-value>)',
  'sv-error-900': 'rgb(var(--sv-error-900) / <alpha-value>)',
  'sv-error-950': 'rgb(var(--sv-error-950) / <alpha-value>)',
  'sv-warn-50': 'rgb(var(--sv-warn-50) / <alpha-value>)',
  'sv-warn-200': 'rgb(var(--sv-warn-200) / <alpha-value>)',
  'sv-warn-300': 'rgb(var(--sv-warn-300) / <alpha-value>)',
  'sv-warn-400': 'rgb(var(--sv-warn-400) / <alpha-value>)',
  'sv-warn-500': 'rgb(var(--sv-warn-500) / <alpha-value>)',
  'sv-warn-600': 'rgb(var(--sv-warn-600) / <alpha-value>)',
  'sv-warn-700': 'rgb(var(--sv-warn-700) / <alpha-value>)',
  'sv-warn-800': 'rgb(var(--sv-warn-800) / <alpha-value>)',
  'sv-warn-900': 'rgb(var(--sv-warn-900) / <alpha-value>)',
  'sv-warn-950': 'rgb(var(--sv-warn-950) / <alpha-value>)',
  'sv-ok-green-50': 'rgb(var(--sv-ok-green-50) / <alpha-value>)',
  'sv-ok-green-200': 'rgb(var(--sv-ok-green-200) / <alpha-value>)',
  'sv-ok-green-600': 'rgb(var(--sv-ok-green-600) / <alpha-value>)',
  'sv-ok-50': 'rgb(var(--sv-ok-50) / <alpha-value>)',
  'sv-ok-100': 'rgb(var(--sv-ok-100) / <alpha-value>)',
  'sv-ok-200': 'rgb(var(--sv-ok-200) / <alpha-value>)',
  'sv-ok-300': 'rgb(var(--sv-ok-300) / <alpha-value>)',
  'sv-ok-400': 'rgb(var(--sv-ok-400) / <alpha-value>)',
  'sv-ok-500': 'rgb(var(--sv-ok-500) / <alpha-value>)',
  'sv-ok-600': 'rgb(var(--sv-ok-600) / <alpha-value>)',
  'sv-ok-700': 'rgb(var(--sv-ok-700) / <alpha-value>)',
  'sv-ok-800': 'rgb(var(--sv-ok-800) / <alpha-value>)',
  'sv-ok-900': 'rgb(var(--sv-ok-900) / <alpha-value>)',
  'sv-ok-950': 'rgb(var(--sv-ok-950) / <alpha-value>)',
  'sv-info-sky-50': 'rgb(var(--sv-info-sky-50) / <alpha-value>)',
  'sv-info-sky-200': 'rgb(var(--sv-info-sky-200) / <alpha-value>)',
  'sv-info-sky-300': 'rgb(var(--sv-info-sky-300) / <alpha-value>)',
  'sv-info-sky-400': 'rgb(var(--sv-info-sky-400) / <alpha-value>)',
  'sv-info-sky-700': 'rgb(var(--sv-info-sky-700) / <alpha-value>)',
  'sv-info-sky-800': 'rgb(var(--sv-info-sky-800) / <alpha-value>)',
  'sv-info-sky-950': 'rgb(var(--sv-info-sky-950) / <alpha-value>)',
  'sv-info-50': 'rgb(var(--sv-info-50) / <alpha-value>)',
  'sv-info-200': 'rgb(var(--sv-info-200) / <alpha-value>)',
  'sv-info-500': 'rgb(var(--sv-info-500) / <alpha-value>)',
  'sv-info-600': 'rgb(var(--sv-info-600) / <alpha-value>)',
  'sv-info-700': 'rgb(var(--sv-info-700) / <alpha-value>)',
};

const content = [`${__dirname}/src/**/*.{ts,tsx}`];

module.exports = {
  content,
  theme: {
    extend: {
      colors: {
        ...palette,
        canvas: { DEFAULT: channel('canvas'), dark: channel('canvas-dark') },
        surface: {
          DEFAULT: channel('surface'),
          subtle: channel('surface-subtle'),
          dark: channel('surface-dark'),
          'dark-subtle': channel('surface-dark-subtle'),
        },
        content: {
          primary: channel('content-primary'),
          secondary: channel('content-secondary'),
          muted: channel('content-muted'),
          'primary-dark': channel('content-primary-dark'),
          'secondary-dark': channel('content-secondary-dark'),
          'muted-dark': channel('content-muted-dark'),
        },
        outline: {
          subtle: 'var(--sv-outline-subtle)',
          default: 'var(--sv-outline-default)',
          'subtle-dark': 'var(--sv-outline-subtle-dark)',
          'default-dark': 'var(--sv-outline-default-dark)',
        },
      },
      fontFamily: {
        sans: ['var(--sv-font-sans)'],
        mono: ['var(--sv-font-mono)'],
      },
    },
  },
};
module.exports.sessionUiContent = content;
