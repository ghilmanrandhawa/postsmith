import { config } from "../config.js";
import type { User } from "../users.js";

const esc = (v: unknown) =>
  String(v ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;" })[c]!);

const SCOPE_TEXT: Record<string, string> = {
  "posts:write": "Create and schedule posts, using your credits",
  "posts:read": "See your posts and credit balance",
};

const css = `
:root{--bg:#f7f6f3;--card:#fff;--ink:#1b1b1f;--muted:#6b6b76;--line:#e6e4df;--brand:#0f4c81;--brand-2:#2bb3c0;--ok:#1f7a4d;--warn:#a1520c}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1b1c20;--ink:#ececf1;--muted:#9a9aa6;--line:#2c2d33;--brand:#5aa9e6;--brand-2:#2bb3c0;--ok:#4cc38a;--warn:#f0a35e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--brand)}main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
header{display:flex;align-items:center;justify-content:space-between;max-width:760px;margin:0 auto;padding:20px 16px}
.logo{font-weight:800;letter-spacing:.3px;text-decoration:none;color:var(--ink);display:flex;gap:10px;align-items:center}
.logo i{width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,var(--brand),var(--brand-2));display:inline-block}
nav a{margin-left:16px;color:var(--muted);text-decoration:none}nav a:hover{color:var(--ink)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin:16px 0}
h1{font-size:clamp(28px,5vw,42px);line-height:1.15;margin:8px 0 12px;letter-spacing:-.5px}h2{font-size:20px;margin:0 0 12px}
.muted{color:var(--muted)}.big{font-size:44px;font-weight:800;letter-spacing:-1px}
label{display:block;font-weight:600;margin:14px 0 6px}input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);font:inherit}
button,.btn{display:inline-block;border:0;border-radius:9px;padding:11px 18px;font:inherit;font-weight:650;cursor:pointer;text-decoration:none;background:var(--brand);color:#fff}
button.secondary,.btn.secondary{background:transparent;color:var(--ink);border:1px solid var(--line)}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.grow{flex:1}
.err{background:#fde8e8;color:#8a1c1c;padding:10px 12px;border-radius:9px;margin:12px 0}.ok{color:var(--ok);font-weight:600}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px}
code.url{display:block;padding:12px;border-radius:9px;background:var(--bg);border:1px solid var(--line);overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left}
ol li{margin:6px 0}.pack{flex:1;min-width:200px}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}.steps div{padding:14px;border:1px solid var(--line);border-radius:12px}
`;

function layout(title: string, body: string, user?: User) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Postsmith</title><style>${css}</style></head><body>
<header><a class="logo" href="/"><i></i>Postsmith</a><nav>${
    user ? `<a href="/account">Account</a><a href="/logout">Log out</a>` : `<a href="/login">Log in</a><a href="/signup">Sign up</a>`
  }</nav></header><main>${body}</main></body></html>`;
}

export const errorPage = (message: string) =>
  layout("Something went wrong", `<div class="card"><h2>Something went wrong</h2><p>${esc(message)}</p></div>`);

export function homePage(user?: User) {
  return layout(
    "Social posts from your AI chat",
    `<p class="muted">ChatGPT · Claude · any MCP client</p>
<h1>Turn a one-line brief into a finished social post — without leaving the chat.</h1>
<p class="muted">Ask your assistant for a post. Postsmith writes it, renders the image, shows a live preview in the conversation, and lets you download or schedule it.</p>
<div class="row"><a class="btn" href="${user ? "/account" : "/signup"}">${user ? "Go to your account" : `Create an account — ${config.signupCredits} free credits`}</a></div>
<div class="card"><h2>Connect it</h2>
<p>Add this URL as an app/connector. You'll be asked to sign in and approve access once.</p>
<code class="url">${esc(config.mcpUrl)}</code>
<div class="steps" style="margin-top:16px">
<div><strong>ChatGPT</strong><br><span class="muted">Settings → Apps → Advanced → Developer mode, then Create app with the URL above (OAuth).</span></div>
<div><strong>Claude</strong><br><span class="muted">Settings → Connectors → Add custom connector, paste the URL.</span></div>
<div><strong>Grok / API</strong><br><span class="muted">Pass the URL as a remote MCP tool with a bearer token from the OAuth flow.</span></div>
</div></div>`,
    user,
  );
}

export function authPage(kind: "signup" | "login", opts: { next: string; error?: string; email?: string }) {
  const isSignup = kind === "signup";
  const other = isSignup ? "login" : "signup";
  return layout(
    isSignup ? "Create account" : "Log in",
    `<div class="card" style="max-width:440px;margin:24px auto">
<h2>${isSignup ? "Create your Postsmith account" : "Log in to Postsmith"}</h2>
${isSignup ? `<p class="muted">You get ${config.signupCredits} free credits. One credit = one finished post.</p>` : ""}
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
<form method="post" action="/${kind}">
<input type="hidden" name="next" value="${esc(opts.next)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(opts.email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${isSignup ? "new-password" : "current-password"}" minlength="8" required>
<p><button type="submit" style="width:100%">${isSignup ? "Create account" : "Log in"}</button></p>
</form>
<p class="muted">${isSignup ? "Already have an account?" : "New here?"} <a href="/${other}?next=${encodeURIComponent(opts.next)}">${isSignup ? "Log in" : "Create an account"}</a></p>
</div>`,
  );
}

export function consentPage(o: { user: User; clientName: string; redirectHost: string; scopes: string[]; hidden: Record<string, string> }) {
  const hidden = Object.entries(o.hidden)
    .filter(([k]) => k !== "decision")
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return layout(
    "Approve access",
    `<div class="card" style="max-width:480px;margin:24px auto">
<h2>Connect ${esc(o.clientName)} to Postsmith?</h2>
<p class="muted">Signed in as <strong>${esc(o.user.email)}</strong> · ${o.user.credits} credit(s) · <a href="/logout?next=${encodeURIComponent("/login")}">not you?</a></p>
<p>${esc(o.clientName)} (<span class="mono">${esc(o.redirectHost)}</span>) will be able to:</p>
<ul>${o.scopes.map((s) => `<li>${esc(SCOPE_TEXT[s] ?? s)}</li>`).join("")}</ul>
<p class="muted">You can disconnect it any time from your account page.</p>
<form method="post" action="/oauth/authorize" class="row">${hidden}
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny" class="secondary">Cancel</button>
</form></div>`,
    o.user,
  );
}

const fmtDate = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function accountPage(o: {
  user: User;
  toppedUp: boolean;
  billingMode: "stripe" | "dev";
  apps: { grant_id: string; client_name: string | null; expires_at: number }[];
  posts: { id: string; platformLabel: string; headline: string; status: string; downloadUrl: string | null }[];
  ledger: { delta: number; reason: string; created_at: number }[];
}) {
  const packs = config.creditPacks
    .map(
      (p) => `<form class="pack card" method="post" action="/billing/checkout" style="margin:0">
<input type="hidden" name="pack" value="${p.id}"><div class="big">${p.credits}</div><div class="muted">credits · $${(p.priceCents / 100).toFixed(2)}</div>
<p><button type="submit">${o.billingMode === "stripe" ? "Buy with Stripe" : "Add (dev mode)"}</button></p></form>`,
    )
    .join("");
  return layout(
    "Account",
    `<h1>Your account</h1><p class="muted">${esc(o.user.email)}</p>
<div class="card" id="credits"><div class="row"><div class="grow"><div class="muted">Credits</div><div class="big">${o.user.credits}</div></div>
${o.toppedUp ? `<div class="ok">Credits added — head back to the chat and try again.</div>` : ""}</div>
<div class="row" style="margin-top:12px">${packs}</div>
${o.billingMode === "stripe" ? `<p class="muted">Stripe test mode: use card 4242 4242 4242 4242, any future date, any CVC.</p>` : `<p class="muted">Stripe isn't configured on this server, so top-ups are free (dev mode).</p>`}
</div>
<div class="card"><h2>Connected apps</h2>${
      o.apps.length
        ? `<table>${o.apps
            .map(
              (a) => `<tr><td>${esc(a.client_name ?? "Unnamed app")}</td><td class="muted">until ${fmtDate(a.expires_at)}</td>
<td style="text-align:right"><form method="post" action="/account/disconnect" style="margin:0"><input type="hidden" name="grant" value="${esc(a.grant_id)}"><button class="secondary">Disconnect</button></form></td></tr>`,
            )
            .join("")}</table>`
        : `<p class="muted">Nothing connected yet. Add <span class="mono">${esc(config.mcpUrl)}</span> in ChatGPT or Claude.</p>`
    }</div>
<div class="card"><h2>Recent posts</h2>${
      o.posts.length
        ? `<table>${o.posts
            .map(
              (p) => `<tr><td>${esc(p.headline)}</td><td class="muted">${esc(p.platformLabel)}</td><td>${esc(p.status)}</td>
<td style="text-align:right">${p.downloadUrl ? `<a href="${esc(p.downloadUrl)}">PNG</a>` : ""}</td></tr>`,
            )
            .join("")}</table>`
        : `<p class="muted">No posts yet — ask your assistant for one.</p>`
    }</div>
<div class="card"><h2>Credit history</h2><table>${o.ledger
      .map((l) => `<tr><td class="mono">${l.delta > 0 ? "+" : ""}${l.delta}</td><td>${esc(l.reason)}</td><td class="muted">${fmtDate(l.created_at)}</td></tr>`)
      .join("")}</table></div>`,
    o.user,
  );
}
