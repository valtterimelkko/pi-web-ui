/** @type {import('tailwindcss').Config} */
import typography from '@tailwindcss/typography';

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Pi brand colors - teal/ocean blue accent
        pi: {
          primary: '#0D9488',    // teal-600
          hover: '#0F766E',      // teal-700
          light: '#F0FDFA',      // teal-50
          dark: '#111827',       // gray-900
          surface: '#FFFFFF',
          sidebar: '#F9FAFB',    // gray-50
          border: '#E5E7EB',     // gray-200
          code: '#F9FAFB',       // gray-50
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      typography: {
        DEFAULT: {
          css: {
            // Custom table styles for better visibility
            table: {
              borderCollapse: 'collapse',
              width: '100%',
              marginTop: '0.75rem',
              marginBottom: '0.75rem',
            },
            'th, td': {
              border: '1px solid #E5E7EB',
              padding: '0.5rem 0.75rem',
              textAlign: 'left',
            },
            th: {
              backgroundColor: '#F9FAFB',
              fontWeight: '600',
              color: '#374151',
            },
            'tr:nth-child(even)': {
              backgroundColor: '#F9FAFB',
            },
            // Better inline code styling
            'code::before': {
              content: '""',
            },
            'code::after': {
              content: '""',
            },
            code: {
              backgroundColor: '#F3F4F6',
              padding: '0.2rem 0.4rem',
              borderRadius: '0.25rem',
              fontSize: '0.875em',
              fontWeight: '500',
              color: '#374151',
            },
            'pre code': {
              backgroundColor: 'transparent',
              padding: '0',
              borderRadius: '0',
              fontSize: 'inherit',
              fontWeight: 'inherit',
              color: 'inherit',
            },
          },
        },
        sm: {
          css: {
            'th, td': {
              padding: '0.375rem 0.5rem',
              fontSize: '0.875rem',
            },
          },
        },
      },
    },
  },
  plugins: [typography],
};
