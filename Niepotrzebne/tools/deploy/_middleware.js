// Stem Keys: private access on Cloudflare Pages, one password per device, remembered for a year.
const COOKIE = "sk_auth";

async function token(pw) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("stem-keys:" + pw));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeBack(v) {
  const s = String(v || "/");
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function page(wrong, back) {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="#101318"><title>Stem Keys</title>
<style>
:root { --bg: #101318; --panel: #161a21; --line: #2a303b; --text: #ebe8e1; --dim: #8e94a0; --right: #f3b45b; --err: #ff6b6b; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--text); }
body { font: 15px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; min-height: 100vh; display: grid; place-items: center; padding: 16px; }
form { width: 100%; max-width: 340px; background: var(--panel); border: 1px solid var(--line); border-radius: 18px; padding: 24px; display: grid; gap: 14px; }
h1 { margin: 0; font-size: 22px; letter-spacing: 0.02em; }
p { margin: 0; color: var(--dim); font-size: 14px; }
input { font: inherit; font-size: 17px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; width: 100%; }
input:focus { outline: 2px solid var(--right); outline-offset: 1px; }
button { font: inherit; font-weight: 650; border: 0; border-radius: 12px; padding: 12px; background: var(--text); color: var(--bg); cursor: pointer; }
.err { color: var(--err); }
</style></head><body>
<form method="post" action="/__login">
<h1>Stem Keys</h1>
<p>Prywatna biblioteka. Wpisz hasło, a to urządzenie zapamięta je na rok.</p>
${wrong ? '<p class="err">Złe hasło. Spróbuj jeszcze raz.</p>' : ""}
<input type="password" name="password" autocomplete="current-password" placeholder="Hasło" autofocus required>
<input type="hidden" name="back" value="${esc(back)}">
<button type="submit">Wejdź</button>
</form></body></html>`;
}

function html(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!env.SK_PASSWORD) return html("Stem Keys: brak ustawionego hasła.", 503);
  const t = await token(env.SK_PASSWORD);
  if (url.pathname === "/__login" && request.method === "POST") {
    const form = await request.formData();
    const back = safeBack(form.get("back"));
    if ((form.get("password") || "") === env.SK_PASSWORD) {
      return new Response(null, { status: 303, headers: { Location: back, "Set-Cookie": `${COOKIE}=${t}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax` } });
    }
    return html(page(true, back), 401);
  }
  const cookies = (request.headers.get("Cookie") || "").split(/;\s*/);
  if (cookies.includes(`${COOKIE}=${t}`)) {
    const res = await next();
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex");
    return out;
  }
  return html(page(false, url.pathname + url.search), 401);
}
