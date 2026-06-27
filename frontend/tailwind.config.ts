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
        // Rainbow sweep that travels across the text gradient (working
        // indicator). Pairs with bg-[length:200%] + bg-clip-text.
        "rainbow-sweep": "rainbow-sweep 2.5s linear infinite",
      },
      keyframes: {
        spectrum: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "rainbow-sweep": {
          "0%": { "background-position": "0% 50%" },
          "100%": { "background-position": "200% 50%" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
