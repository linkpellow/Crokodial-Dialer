/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'crokodial-green': '#84cc16',
        'call-green': '#34C759',
        'keypad-dark': '#1a3d1a',
      },
      boxShadow: {
        'keypad-inset': 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.15)',
        'keypad-hover': 'inset 0 1px 4px rgba(0,0,0,0.25), inset 0 -1px 0 rgba(255,255,255,0.08), 0 2px 8px rgba(0,0,0,0.2)',
        'call-glow': '0 0 24px rgba(52,199,89,0.45), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.2)',
        'call-glow-hover': '0 0 32px rgba(52,199,89,0.55), 0 6px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.25)',
        'glass': '0 8px 32px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.08)',
      },
      backdropBlur: {
        xs: '2px',
      },
    },
  },
  plugins: [],
};
