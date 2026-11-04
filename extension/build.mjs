// Builds the MV3 extension into dist/: React pages (ESM), background worker (ESM module),
// and the two content scripts (IIFE — content scripts can't be ES modules).
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const watch = process.argv.includes("--watch") ? {} : null;
const common = {
  configFile: false,
  root: here,
  envDir: here,
  resolve: {
    alias: { "@": resolve(here, ".."), "~": resolve(here, "src"), react: resolve(here, "node_modules/react"), "react-dom": resolve(here, "node_modules/react-dom") },
    dedupe: ["react", "react-dom"],
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  logLevel: "warn",
};

await build({
  ...common,
  plugins: [react(), tailwind()],
  publicDir: "public",
  build: {
    outDir: "dist", emptyOutDir: true, target: "chrome120", watch, sourcemap: false,
    rollupOptions: { input: Object.fromEntries(["popup", "sidepanel", "approve", "onboarding", "ledger"].map((p) => [p, resolve(here, `${p}.html`)])) },
  },
});

for (const [name, entry, format] of [["background", "src/background/index.ts", "es"], ["provider", "src/content/provider.ts", "iife"], ["bridge", "src/content/bridge.ts", "iife"]]) {
  await build({
    ...common,
    publicDir: false,
    build: {
      outDir: "dist", emptyOutDir: false, target: "chrome120", watch, minify: true,
      lib: { entry: resolve(here, entry), formats: [format], name: `tailor_${name}`, fileName: () => `${name}.js` },
      rollupOptions: { output: { codeSplitting: false } },
    },
  });
}
console.log("built extension → dist/");
