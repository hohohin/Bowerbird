/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 主题色由 styles.css 的 RGB 令牌提供，保留 Tailwind 的 /opacity 语法。
        canvas: "rgb(var(--bb-bg-rgb) / <alpha-value>)",
        panel: "rgb(var(--bb-surface-rgb) / <alpha-value>)",
        panel2: "rgb(var(--bb-surface-2-rgb) / <alpha-value>)",
        edge: "rgb(var(--bb-line-rgb) / <alpha-value>)",
        ink: "rgb(var(--bb-ink-rgb) / <alpha-value>)",
        muted: "rgb(var(--bb-muted-rgb) / <alpha-value>)",
        faint: "rgb(var(--bb-faint-rgb) / <alpha-value>)",
        cold: "rgb(var(--bb-cold-rgb) / <alpha-value>)",
        accent: "rgb(var(--bb-blue-rgb) / <alpha-value>)",
        "accent-soft": "rgb(var(--bb-blue-soft-rgb) / <alpha-value>)",
        lime: "rgb(var(--bb-lime-rgb) / <alpha-value>)",
      },
      boxShadow: {
        panel: "0 18px 55px rgb(var(--bb-shadow-rgb) / 34%)",
      },
    },
  },
  plugins: [],
};
