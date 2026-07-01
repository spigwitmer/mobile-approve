import type { PermissionSnapshot } from "./types.js"

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}

function formatPattern(pattern: string | string[] | undefined): string {
  if (!pattern) return ""
  return Array.isArray(pattern) ? pattern.join(" | ") : pattern
}

function formatMetadata(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return ""
  const lines: string[] = []
  for (const [k, v] of Object.entries(meta)) {
    const value = typeof v === "string" ? v : JSON.stringify(v)
    if (value.length > 1024) continue
    lines.push(`${escapeHtml(k)}: ${escapeHtml(value)}`)
  }
  return lines.join("\n")
}

export function renderReviewPage(input: {
  requestId: string
  callbackUrl: string
  expiresAtMs: number
  permission: PermissionSnapshot
}): string {
  const { requestId, callbackUrl, expiresAtMs, permission } = input
  const title = escapeHtml(permission.title || permission.type || "permission")
  const pattern = formatPattern(permission.pattern)
  const patternArray = Array.isArray(permission.pattern)
    ? permission.pattern
    : permission.pattern
      ? [permission.pattern]
      : []
  const metadata = formatMetadata(permission.metadata)
  const expired = Date.now() > expiresAtMs

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>opencode permission</title>
<style>
  :root { color-scheme: dark light; }
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    margin: 0; padding: 16px;
    background: #0b0b0c; color: #e7e7ea;
    line-height: 1.4;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #9aa0a6; font-size: 13px; margin-bottom: 16px; }
  .panel {
    background: #1a1b1f;
    border: 1px solid #2a2b31;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 12px;
  }
  pre {
    background: #11121a;
    padding: 10px;
    border-radius: 8px;
    overflow-x: auto;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
  }
  .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #9aa0a6; margin-bottom: 4px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  button, input[type="text"], textarea {
    font: inherit;
  }
  button {
    width: 100%;
    min-height: 44px;
    padding: 10px 14px;
    border: 1px solid #2a2b31;
    border-radius: 8px;
    background: #1f2026;
    color: #e7e7ea;
    cursor: pointer;
  }
  button:active { background: #2a2b31; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.danger { background: #7f1d1d; border-color: #7f1d1d; color: #fff; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input[type="text"], textarea {
    width: 100%;
    background: #11121a;
    color: #e7e7ea;
    border: 1px solid #2a2b31;
    border-radius: 8px;
    padding: 8px;
  }
  textarea { min-height: 64px; resize: vertical; }
  .stack > * + * { margin-top: 8px; }
  .status { font-size: 13px; margin-top: 8px; min-height: 18px; }
  .expired { color: #f87171; }
  details { margin-top: 8px; }
  details > summary {
    cursor: pointer;
    color: #9aa0a6;
    font-size: 13px;
    list-style: none;
  }
  details > summary::-webkit-details-marker { display: none; }
  details[open] > summary { margin-bottom: 8px; }
</style>
</head>
<body>
<h1>opencode wants to act</h1>
<div class="sub">${title}</div>

<div class="panel">
  <div class="label">tool</div>
  <pre>${escapeHtml(permission.type)}</pre>
  ${
    pattern
      ? `<div class="label" style="margin-top:8px">pattern</div><pre>${escapeHtml(
          pattern
        )}</pre>`
      : ""
  }
  ${
    metadata
      ? `<div class="label" style="margin-top:8px">metadata</div><pre>${metadata}</pre>`
      : ""
  }
</div>

<div class="panel stack">
  <button data-action="once" class="primary" ${
    expired ? "disabled" : ""
  }>Allow once</button>
  <button data-action="reject" class="danger" ${
    expired ? "disabled" : ""
  }>Reject</button>
  <div>
    <div class="label" style="margin-bottom:6px">Allow always — pattern</div>
    ${
      patternArray.length > 1
        ? `<div class="stack" id="always-radios">${patternArray
            .map(
              (p, i) =>
                `<label style="display:flex;align-items:center;gap:8px;padding:6px 4px"><input type="radio" name="always" value="${escapeAttr(
                  p
                )}" ${i === 0 ? "checked" : ""} ${
                    expired ? "disabled" : ""
                  }><code style="font-size:12px">${escapeHtml(p)}</code></label>`
            )
            .join("")}<label style="display:flex;align-items:center;gap:8px;padding:6px 4px"><input type="radio" name="always" value="__custom__" ${
            expired ? "disabled" : ""
          }><input type="text" id="always-pattern" placeholder="custom pattern (supports *)" style="flex:1" ${
            expired ? "disabled" : ""
          }></label></div>`
        : `<input type="text" id="always-pattern" value="${escapeAttr(
            pattern
          )}" ${expired ? "disabled" : ""}>`
    }
    <div class="row" style="margin-top:8px">
      <button data-action="always" ${
        expired ? "disabled" : ""
      }>Allow always this pattern</button>
    </div>
  </div>
</div>

<details>
  <summary>More options</summary>
  <div class="panel stack">
    <div>
      <div class="label" style="margin-bottom:6px">Approve with a modified command (deny + tell the agent)</div>
      <textarea id="command" placeholder="e.g. rm -rf build/.cache"></textarea>
      <div class="row" style="margin-top:8px">
        <button data-action="approve-modified" ${
          expired ? "disabled" : ""
        }>Approve modified</button>
      </div>
    </div>
    <div>
      <div class="label" style="margin-bottom:6px">Deny with a hint for the agent</div>
      <textarea id="hint" placeholder="e.g. use npm prune --production instead"></textarea>
      <div class="row" style="margin-top:8px">
        <button data-action="deny-with-hint" class="danger" ${
          expired ? "disabled" : ""
        }>Deny + send hint</button>
      </div>
    </div>
  </div>
</details>

<div id="status" class="status"></div>

<script>
(function() {
  const requestId = ${JSON.stringify(requestId)};
  const callbackUrl = ${JSON.stringify(callbackUrl)};
  const expiresAtMs = ${JSON.stringify(expiresAtMs)};
  const $status = document.getElementById('status');

  function checkExpiry() {
    if (Date.now() > expiresAtMs) {
      $status.textContent = 'Expired — the plugin fell back to default-deny.';
      $status.className = 'status expired';
      document.querySelectorAll('button, input, textarea').forEach(el => el.disabled = true);
    }
  }
  checkExpiry();
  setInterval(checkExpiry, 1000);

  function setButtonsDisabled(disabled) {
    document.querySelectorAll('button').forEach(b => b.disabled = disabled);
    document.querySelectorAll('input, textarea').forEach(el => el.disabled = disabled);
  }

  async function submit(payload) {
    setButtonsDisabled(true);
    $status.textContent = 'Submitting...';
    $status.className = 'status';
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ requestId, receivedAt: Date.now() }, payload)),
      });
      if (!res.ok) {
        const text = await res.text();
        $status.textContent = 'Failed: ' + res.status + ' ' + text;
        $status.className = 'status expired';
        return;
      }
      $status.textContent = 'Decision sent. You can close this page.';
      $status.className = 'status';
    } catch (e) {
      $status.textContent = 'Network error: ' + (e && e.message ? e.message : String(e));
      $status.className = 'status expired';
      setButtonsDisabled(false);
    }
  }

  document.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action');
      switch (action) {
        case 'once':
          submit({ status: 'allow', scope: 'once' });
          break;
        case 'reject':
          submit({ status: 'deny', scope: 'once' });
          break;
        case 'always': {
          let p;
          const radios = document.querySelectorAll('input[name="always"]');
          if (radios.length > 0) {
            const selected = Array.from(radios).find(r => r.checked);
            if (!selected) { p = null; }
            else if (selected.value === '__custom__') {
              p = document.getElementById('always-pattern').value.trim();
            } else {
              p = selected.value;
            }
          } else {
            p = document.getElementById('always-pattern').value.trim();
          }
          if (!p) {
            $status.textContent = 'Pattern cannot be empty.';
            $status.className = 'status expired';
            setButtonsDisabled(false);
            return;
          }
          submit({ status: 'allow', scope: 'always', patterns: [p] });
          break;
        }
        case 'approve-modified': {
          const cmd = document.getElementById('command').value.trim();
          if (!cmd) {
            $status.textContent = 'Enter a modified command first.';
            $status.className = 'status expired';
            setButtonsDisabled(false);
            return;
          }
          submit({
            status: 'deny',
            scope: 'once',
            command: cmd,
            agentHint: 'The user wants you to run this command instead:\\n\\n' + cmd + '\\n\\nPlease run it (re-confirming with the user if it looks destructive) and then continue with your task.',
          });
          break;
        }
        case 'deny-with-hint': {
          const hint = document.getElementById('hint').value.trim();
          if (!hint) {
            $status.textContent = 'Enter a hint for the agent first.';
            $status.className = 'status expired';
            setButtonsDisabled(false);
            return;
          }
          submit({ status: 'deny', scope: 'once', agentHint: hint });
          break;
        }
      }
    });
  });
})();
</script>
</body>
</html>`
}