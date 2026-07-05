/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 中性深色基底，参考图库类工具的常见配色
        canvas: "#0f1115",
        panel: "#171a21",
        panel2: "#1f2430",
        edge: "#2a3140",
        ink: "#e6e9ef",
        muted: "#8b93a3",
        accent: "#7c9cff",
      },
    },
  },
  plugins: [],
};
