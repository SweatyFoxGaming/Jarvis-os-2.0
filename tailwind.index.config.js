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
        bg: '#01040c',
        surface: '#050b18',
        card: '#0b1830',
        glass: '#0d0f15',
        primary: '#50D2FF',
        accent: '#50D2FF',
        glow: '#FF78DC',
        success: '#5FBF8F',
        warning: '#D9A85C',
        danger: '#D97A7A',
        text: '#EDEFF3',
        secondary: '#7fa8cc',
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Space Grotesk', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
};
