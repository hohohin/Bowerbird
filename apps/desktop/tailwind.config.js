/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // 与官网共用的品牌色阶：暖黑基底、强蓝动作色、荧光绿状态色。
        canvas: "#100e0e",
        panel: "#171515",
        panel2: "#1d1b1b",
        edge: "#292727",
        ink: "#fdfff0",
        muted: "#969692",
        faint: "#666460",
        cold: "#94a3b8",
        accent: "#4868ff",
        "accent-soft": "#dfe5ff",
        lime: "#d9ff52",
      },
      boxShadow: {
        panel: "0 18px 55px rgba(0, 0, 0, 0.34)",
      },
    },
  },
  plugins: [],
};
