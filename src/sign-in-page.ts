function escapeHtml(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function signInPage(userId: string | null, connection: { input: unknown; clientName: string; callbackHost: string } | null) {
  const nonce = crypto.randomUUID();
  const data = JSON.stringify({ signedIn: userId !== null, connection: connection?.input ?? null }).replaceAll("<", "\\u003c");
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Careers — Sign in</title>
<style nonce="${nonce}">
body{font:17px/1.6 system-ui,sans-serif;background:#f6f7f9;color:#172033;margin:0;padding:48px 20px}
main{max-width:440px;margin:8vh auto;background:white;padding:32px;border-radius:20px;box-shadow:0 12px 45px #17203310}
h1{margin:0 0 12px;font-size:30px}button{font:inherit;cursor:pointer;border:0;border-radius:10px;padding:12px 18px;margin:6px 6px 6px 0;background:#204eaa;color:white}
button.secondary{background:#e9edf5;color:#172033}button:disabled{opacity:.5;cursor:wait}[hidden]{display:none!important}#status{min-height:26px;overflow-wrap:anywhere}
</style></head><body><main><h1>Careers</h1><p>Your job search, in your own private space.</p>
${connection ? `<p><strong>${escapeHtml(connection.clientName)}</strong> wants access to your Careers data. You will return to <strong>${escapeHtml(connection.callbackHost)}</strong>.</p>` : "<p>Connect your MCP client to this site's <code>/mcp</code> address. It will bring you here to sign in.</p>"}
<div id="sign-in"><button id="login">Sign in with a passkey</button><button id="register" class="secondary">Create a passkey</button><p>No password or email needed.</p></div>
<div id="account" hidden><p>You’re signed in.</p><button id="connect" hidden>Allow connection</button><button id="add" class="secondary">Add another passkey</button><button id="revoke" class="secondary">Disconnect all MCP clients</button><button id="logout" class="secondary">Sign out</button></div>
${connection ? '<button id="deny" class="secondary">Cancel connection</button>' : ""}
<p id="status" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
const state = ${data};
const status = document.getElementById('status');
function showAccount() {
  document.getElementById('sign-in').hidden = state.signedIn;
  document.getElementById('account').hidden = !state.signedIn;
  document.getElementById('connect').hidden = !state.connection;
}
async function post(path, body) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body || {})});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error_description || result.error || 'Please try again.');
  return result;
}
function decode(value) { return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0)); }
function encode(value) { return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,''); }
async function passkey(register) {
  const path = register ? '/auth/register' : '/auth/login';
  const options = await post(path + '/options');
  options.challenge = decode(options.challenge);
  if (register) {
    options.user.id = decode(options.user.id);
    options.excludeCredentials = (options.excludeCredentials || []).map(c => ({...c, id:decode(c.id)}));
  }
  const credential = register ? await navigator.credentials.create({publicKey:options}) : await navigator.credentials.get({publicKey:options});
  if (!credential) throw new Error('Passkey prompt was cancelled.');
  const response = {clientDataJSON:encode(credential.response.clientDataJSON)};
  if (register) response.attestationObject = encode(credential.response.attestationObject);
  else {
    response.authenticatorData = encode(credential.response.authenticatorData);
    response.signature = encode(credential.response.signature);
    response.userHandle = credential.response.userHandle ? encode(credential.response.userHandle) : null;
  }
  await post(path + '/verify', {id:credential.id, rawId:encode(credential.rawId), type:credential.type, clientExtensionResults:credential.getClientExtensionResults(), response});
  state.signedIn = true;
  showAccount();
  status.textContent = register ? 'Passkey saved.' : 'Signed in.';
}
async function connect(allow) {
  const result = await post('/authorize/finish', {request:state.connection, allow});
  location.href = result.redirect;
}
const actions = {
  login:() => passkey(false), register:() => passkey(true), add:() => passkey(true), connect:() => connect(true), deny:() => connect(false),
  revoke:async () => { await post('/auth/revoke'); status.textContent = 'All MCP clients disconnected.'; },
  logout:async () => { await post('/auth/logout'); state.signedIn = false; showAccount(); status.textContent = 'Signed out.'; }
};
for (const [id, action] of Object.entries(actions)) {
  const button = document.getElementById(id);
  if (button) button.addEventListener('click', async () => {
    const buttons = document.querySelectorAll('button');
    buttons.forEach(b => b.disabled = true);
    status.textContent = '';
    try { await action(); } catch (error) { status.textContent = error.name === 'NotAllowedError' ? 'Passkey prompt was cancelled. Try again when ready.' : error.message; }
    finally { buttons.forEach(b => b.disabled = false); }
  });
}
showAccount();
if (!navigator.credentials || !isSecureContext) { status.textContent = 'Use a browser with passkey support over HTTPS (or localhost).'; document.querySelectorAll('#sign-in button').forEach(b => b.disabled = true); }
</script></body></html>`, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  } });
}
