// Config for the admin panel (src/interaction/static/admin.html) — a separate, older
// palette from the main dashboard's, kept as its own build so the two pages'
// colors don't collide in one shared config.
module.exports = {
  content: ["./src/interaction/static/admin.html"],
  theme: {
    extend: {
      colors: {
        bg: '#040711',
        surface: '#090d1e',
        card: '#0d152d',
        primary: '#38bdf8',
        accent: '#818cf8',
        success: '#34d399',
        warning: '#fbbf24',
        danger: '#f87171',
        secondary: '#94a3b8',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
        sans: ['Space Grotesk', 'sans-serif'],
      },
    },
  },
};
