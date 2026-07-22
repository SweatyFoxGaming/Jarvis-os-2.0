// Config for the main dashboard (src/interaction/static/index.html). Colors/fonts here
// must stay in sync with what used to be the inline `tailwind.config = {...}`
// script when this ran on the CDN Play build — see README for why that's
// gone (production shouldn't load a JIT compiler + arbitrary script from a
// third-party host on every page load).
module.exports = {
  content: ["./src/interaction/static/index.html"],
  theme: {
    extend: {
      colors: {
        bg: '#050608',
        surface: '#0B0D12',
        card: '#12141B',
        glass: '#0D0F15',
        primary: '#8FB8E8',
        accent: '#8FB8E8',
        success: '#5FBF8F',
        warning: '#D9A85C',
        danger: '#D97A7A',
        text: '#EDEFF3',
        secondary: '#767C8C',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
};
