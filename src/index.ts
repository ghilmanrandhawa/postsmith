import { createApp } from "./app.js";
import { config } from "./config.js";
import { recoverInterruptedJobs } from "./posts.js";

recoverInterruptedJobs();
createApp().listen(config.port, () => {
  console.log(`Postsmith running at ${config.baseUrl}`);
  console.log(`MCP endpoint: ${config.mcpUrl}`);
});
