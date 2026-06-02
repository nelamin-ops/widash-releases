import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "rma-new": "#60A5FA",
        "rma-progress": "#A78BFA",
        "rma-waiting": "#FBBF24",
        "rma-escalated": "#F87171",
      },
      backdropBlur: { glass: "24px" },
      borderRadius: { panel: "24px" },
      animation: {
        spectrum: "spectrum 8s linear infinite",
      },
      keyframes: {
        spectrum: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
