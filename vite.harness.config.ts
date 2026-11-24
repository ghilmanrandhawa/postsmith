import { defineConfig } from "vite";

// Dev-only page that plays the role of ChatGPT/Claude so the widget can be tested locally.
export default defineConfig({ root: "harness", server: { port: 5174 } });
