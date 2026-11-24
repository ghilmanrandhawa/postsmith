import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

const q = new URLSearchParams(location.search);
const server = q.get("server") ?? "http://localhost:3000";
const token = q.get("token") ?? "";
const log = (m: string) => (document.getElementById("log")!.textContent += m + "\n");

const client = new Client({ name: "harness", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${server}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
log("connected to " + server);

const resource = await client.readResource({ uri: "ui://postsmith/post.html" });
const iframe = document.getElementById("app") as HTMLIFrameElement;

const bridge = new AppBridge(client, { name: "harness", version: "1.0.0" }, { openLinks: {}, serverTools: {}, logging: {}, downloadFile: {} } as never, {
  hostContext: { theme: q.get("theme") === "dark" ? "dark" : "light" },
} as never);
bridge.onsizechange = ({ height }) => { if (height) iframe.style.height = `${height}px`; };
bridge.onopenlink = async ({ url }) => { log("openLink " + url); return {}; };
bridge.ondownloadfile = async (p) => { log("downloadFile " + JSON.stringify(p.contents.map((c: any) => c.uri))); return {}; };
bridge.onupdatemodelcontext = async (p) => { log("model context: " + JSON.stringify(p.content)); return {}; };

const args = {
  platform: q.get("platform") ?? "linkedin",
  brief: "We just launched same-day delivery across Lahore",
  headline: "Same-day delivery is here",
  caption: "Order before 2pm and it's at your door tonight. Live now across Lahore.",
  hashtags: ["Lahore", "SameDayDelivery"],
  theme: q.get("look") ?? "sunset",
};

bridge.oninitialized = async () => {
  log("view initialized");
  await bridge.sendToolInput({ arguments: args });
  const result = await client.callTool({ name: q.get("tool") ?? "create_post", arguments: args });
  log("create_post → " + (result.content as any)[0].text.split("\n")[0]);
  await bridge.sendToolResult(result as never);
};

iframe.srcdoc = (resource.contents[0] as { text: string }).text;
await new Promise((r) => iframe.addEventListener("load", r, { once: true }));
await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
