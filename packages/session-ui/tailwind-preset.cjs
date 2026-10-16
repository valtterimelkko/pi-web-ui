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

const content = [`${__dirname}/src/**/*.{ts,tsx}`];

module.exports = {
  content,
  theme: {
    extend: {
      colors: {
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
