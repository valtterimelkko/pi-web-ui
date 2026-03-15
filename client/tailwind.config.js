/** @type {import('tailwindcss').Config} */
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
    },
  },
  plugins: [],
};
