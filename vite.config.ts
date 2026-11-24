import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the in-chat widget into ONE self-contained HTML file (JS + CSS inlined),
// which the MCP server serves as the ui:// resource.
export default defineConfig({
  root: "widget",
  plugins: [react(), viteSingleFile()],
  build: { outDir: "../dist/widget", emptyOutDir: true },
});
