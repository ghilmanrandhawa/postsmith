/**
 * The in-chat card for Postsmith (an MCP App View). The host renders it in a sandboxed iframe
 * whenever create_post / get_post / schedule_post returns. It shows live progress while the
 * post generates, then the preview with download and schedule actions.
 */
import { type App as McpApp, useApp, useDocumentTheme, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type Status = "queued" | "generating" | "ready" | "failed" | "scheduled";
interface Post {
  id: string;
  platformLabel: string;
  headline: string;
  fullCaption: string;
  status: Status;
  progress: number;
  step: string;
  error: string | null;
  scheduledAt: string | null;
  previewSvg: string | null;
  downloadUrl: string | null;
}
interface Account {
  email: string;
  credits: number;
  topUpUrl: string;
}
interface ToolData {
  post?: Post;
  account?: Account;
  error?: string;
  reason?: string;
}

const isWorking = (p?: Post) => p?.status === "queued" || p?.status === "generating";

function defaultScheduleTime() {
  const d = new Date(Date.now() + 24 * 3600 * 1000);
  d.setMinutes(0, 0, 0);
  d.setHours(9);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

function PostCard() {
  const [data, setData] = useState<ToolData>({});
  const [pending, setPending] = useState<string | null>(null); // headline while the tool call is still running
  const [actionError, setActionError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState(defaultScheduleTime);
  const [copied, setCopied] = useState(false);

  const onAppCreated = useCallback((app: McpApp) => {
    app.ontoolinput = ({ arguments: args }) => {
      if (typeof args?.headline === "string") setPending(args.headline);
    };
    app.ontoolresult = (result) => {
      setPending(null);
      setData((result.structuredContent ?? {}) as ToolData);
    };
  }, []);

  const { app, isConnected, error } = useApp({
    appInfo: { name: "postsmith-card", version: "0.1.0" },
    capabilities: {},
    onAppCreated,
  });
  // Apply the host's theme/fonts from the initial handshake, and follow later changes.
  useHostStyles(app, isConnected ? app?.getHostContext() : undefined);
  const theme = useDocumentTheme();

  const post = data.post;

  // Long-running generation: poll the server until the job finishes.
  const pollRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!app || !isConnected || !post || !isWorking(post)) return;
    pollRef.current = window.setTimeout(async () => {
      try {
        const res = await app.callServerTool({ name: "get_post", arguments: { id: post.id } });
        const next = (res.structuredContent ?? {}) as ToolData;
        if (next.post) setData((d) => ({ ...d, ...next }));
        // Let the model know once it's done, so it can offer next steps without the user asking.
        if (next.post && !isWorking(next.post)) {
          await app.updateModelContext({
            content: [{ type: "text", text: `Post ${next.post.id} finished with status "${next.post.status}".` }],
          });
        }
      } catch {
        setData((d) => ({ ...d })); // retry on the next tick
      }
    }, 1200);
    return () => window.clearTimeout(pollRef.current);
  }, [app, isConnected, post]);

  async function download() {
    if (!app || !post?.downloadUrl) return;
    setActionError(null);
    const res = await app
      .downloadFile({
        contents: [{ type: "resource_link", uri: post.downloadUrl, name: `${post.id}.png`, mimeType: "image/png" }],
      })
      .catch(() => ({ isError: true }));
    if (res.isError) await app.openLink({ url: post.downloadUrl }).catch(() => setActionError("Couldn't open the download link."));
  }

  async function schedule() {
    if (!app || !post) return;
    setActionError(null);
    setScheduling(true);
    try {
      const res = await app.callServerTool({ name: "schedule_post", arguments: { id: post.id, publish_at: new Date(when).toISOString() } });
      const next = (res.structuredContent ?? {}) as ToolData;
      if (res.isError) setActionError(next.error ?? "Scheduling failed.");
      else setData((d) => ({ ...d, ...next }));
    } finally {
      setScheduling(false);
    }
  }

  async function copyCaption() {
    if (!post) return;
    await navigator.clipboard?.writeText(post.fullCaption).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (error) return <div className={`ps ${theme}`}><p className="err">Couldn't connect to the chat: {error.message}</p></div>;

  return (
    <div className={`ps ${theme}`}>
      <header>
        <span className="logo" />
        <strong>Postsmith</strong>
        {post && <span className="chip">{post.platformLabel}</span>}
        {data.account && <span className="credits">{data.account.credits} credit{data.account.credits === 1 ? "" : "s"} left</span>}
      </header>

      {/* Tool call still in flight */}
      {!post && !data.error && (
        <div className="body">
          <p className="step">{pending ? `Starting “${pending}”…` : "Waiting for the brief…"}</p>
          <div className="bar"><div style={{ width: "4%" }} /></div>
        </div>
      )}

      {/* Errors returned by the tool (e.g. out of credits, caption too long) */}
      {!post && data.error && (
        <div className="body">
          <p className="err">{data.reason === "insufficient_credits" ? "You're out of credits." : data.error}</p>
          {data.reason === "insufficient_credits" && data.account && (
            <button onClick={() => app?.openLink({ url: data.account!.topUpUrl })}>Top up credits</button>
          )}
        </div>
      )}

      {post && isWorking(post) && (
        <div className="body">
          <h3>{post.headline}</h3>
          <p className="step">{post.step}…</p>
          <div className="bar"><div style={{ width: `${Math.max(post.progress, 4)}%` }} /></div>
          <p className="muted">Usually takes about 10 seconds. You can keep chatting.</p>
        </div>
      )}

      {post?.status === "failed" && (
        <div className="body">
          <p className="err">{post.error}</p>
        </div>
      )}

      {post && (post.status === "ready" || post.status === "scheduled") && (
        <div className="body">
          {post.previewSvg && <div className="preview" dangerouslySetInnerHTML={{ __html: post.previewSvg }} />}
          <div className="caption">
            <pre>{post.fullCaption}</pre>
            <button className="ghost small" onClick={copyCaption}>{copied ? "Copied" : "Copy caption"}</button>
          </div>
          {post.status === "scheduled" ? (
            <p className="ok">Scheduled for {new Date(post.scheduledAt!).toLocaleString()}</p>
          ) : (
            <div className="actions">
              <button onClick={download}>Download PNG</button>
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Publish time" />
              <button className="ghost" disabled={scheduling} onClick={schedule}>{scheduling ? "Scheduling…" : "Schedule"}</button>
            </div>
          )}
          {actionError && <p className="err">{actionError}</p>}
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PostCard />
  </StrictMode>,
);
