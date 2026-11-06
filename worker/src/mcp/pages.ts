// The connector sign-in's own pages (ADR 0040): the consent page, a refusal, and the
// dev-only sign-in form. Plain HTML with no script, never framed by another site.

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #fafaf9; --card: #ffffff; --ink: #1c1917; --ink-2: #57534e; --line: #e7e5e4; --accent: #1c1917; --accent-ink: #fafaf9; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --card: #1c1917; --ink: #f5f5f4; --ink-2: #a8a29e; --line: #292524; --accent: #f5f5f4; --accent-ink: #0c0a09; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 440px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 18px; line-height: 1.3; margin: 0 0 12px; font-weight: 600; }
  p { margin: 0 0 12px; color: var(--ink-2); }
  p strong, li strong { color: var(--ink); font-weight: 600; }
  code { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  ul { margin: 0 0 16px; padding-left: 18px; color: var(--ink-2); }
  form { display: flex; gap: 8px; flex-wrap: wrap; margin: 20px 0 0; }
  button, input { font: inherit; border-radius: 8px; padding: 9px 14px; }
  button { cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--ink); }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  input { flex: 1 1 160px; min-width: 0; border: 1px solid var(--line); background: var(--bg); color: var(--ink); }
  .small { font-size: 13px; margin-top: 16px; }
  a { color: inherit; }
`;

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      // Not no-referrer: under it a browser posts the consent form with `Origin: null`,
      // which the answer's same-origin check must refuse. same-origin keeps the referrer
      // from every other site, the app's redirect included.
      "Referrer-Policy": "same-origin",
    },
  });
}

export interface ConsentView {
  person: string;
  repo: string;
  client: string;
  /** The host the app's sign-in goes back to, shown so a lookalike app is noticed. */
  redirectHost: string;
  /** The signed request the Allow button posts back. */
  request: string;
  switchAccount: string;
}

export function consentPage(view: ConsentView): Response {
  return page(
    "Connect to Switchboard",
    `<h1>Let ${escapeHtml(view.client)} read the Switchboard Channel ${escapeHtml(view.repo)}?</h1>
<p>You are signed in as <strong>${escapeHtml(view.person)}</strong>. The app will sign in as you and send its answer to <strong>${escapeHtml(view.redirectHost)}</strong>.</p>
<ul>
<li>It can <strong>read</strong> the Channel: its Tasks and Claims, Updates, Directives, Memory Notes and Agents.</li>
<li>It <strong>cannot change</strong> anything on the Channel or on GitHub.</li>
<li>It loses access when you lose write access to ${escapeHtml(view.repo)}.</li>
</ul>
<p><strong>Allow this only if you just started connecting ${escapeHtml(view.client)} yourself.</strong> If someone sent you this link, cancel: they would get the access.</p>
<form method="post">
<input type="hidden" name="request" value="${escapeHtml(view.request)}">
<button class="primary" type="submit" name="decision" value="allow">Allow read-only access</button>
<button type="submit" name="decision" value="deny">Cancel</button>
</form>
<p class="small">Not ${escapeHtml(view.person)}? <a href="${escapeHtml(view.switchAccount)}">Sign in with another GitHub account</a>.</p>`,
  );
}

/** Why the sign-in stopped here, when the app cannot be told: an unknown app or redirect, or no access. */
export function refusalPage(title: string, reason: string, status: number, retry?: string): Response {
  const again =
    retry === undefined
      ? ""
      : `<p class="small"><a href="${escapeHtml(retry)}">Sign in with another GitHub account</a>.</p>`;
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(reason)}</p>${again}`, status);
}

/** `wrangler dev` without the GitHub App: sign in as any login, still checked for Membership. */
export function devSignInPage(repo: string, back: string): Response {
  return page(
    "Dev sign-in",
    `<h1>Dev sign-in for ${escapeHtml(repo)}</h1>
<p>This Worker runs with the dev-only fake sign-in. Sign in as any GitHub login.</p>
<form method="get" action="/auth/dev/signin">
<input type="hidden" name="repo" value="${escapeHtml(repo)}">
<input type="hidden" name="return" value="${escapeHtml(back)}">
<input name="login" placeholder="GitHub login" required autofocus>
<button class="primary" type="submit">Sign in</button>
</form>`,
  );
}
