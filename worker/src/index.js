/**
 * Stock Intelligence — Cloudflare Worker
 *
 * Routes:
 *   POST /auth          — verify Google JWT, return session token
 *   POST /analyze       — proxy to Anthropic API (requires valid session token)
 *   OPTIONS *           — CORS preflight
 */

const ALLOWED_EMAILS = ['gorgan.josef@gmail.com'];

// ── CORS ──────────────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function cors(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  });
}

function err(msg, status = 400) {
  return cors(JSON.stringify({ error: msg }), status);
}

// ── Google JWT verification ───────────────────────────────────────────────────

async function getGooglePublicKeys() {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const { keys } = await res.json();
  return keys;
}

async function verifyGoogleJWT(token, clientId) {
  const [headerB64, payloadB64, sigB64] = token.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error('Malformed JWT');

  const header  = JSON.parse(atob(headerB64.replace(/-/g,'+').replace(/_/g,'/')));
  const payload = JSON.parse(atob(payloadB64.replace(/-/g,'+').replace(/_/g,'/')));

  // Basic claims
  if (payload.aud !== clientId)            throw new Error('Wrong audience');
  if (payload.iss !== 'https://accounts.google.com' &&
      payload.iss !== 'accounts.google.com') throw new Error('Wrong issuer');
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');

  // Signature
  const keys = await getGooglePublicKeys();
  const jwk  = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown key id');

  const key = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );

  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig  = Uint8Array.from(atob(sigB64.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
  if (!valid) throw new Error('Invalid signature');

  return payload;
}

// ── Session tokens (HMAC-SHA256 signed, 8h TTL) ───────────────────────────────

async function signSession(email, secret) {
  const exp  = Math.floor(Date.now() / 1000) + 8 * 3600;
  const data = `${email}|${exp}`;
  const key  = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
  return btoa(`${data}|${sigHex}`);
}

async function verifySession(token, secret) {
  let decoded;
  try { decoded = atob(token); } catch { throw new Error('Bad token'); }
  const parts = decoded.split('|');
  if (parts.length !== 3) throw new Error('Bad token');
  const [email, expStr, sigHex] = parts;
  if (Math.floor(Date.now() / 1000) > parseInt(expStr)) throw new Error('Session expired');

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(sigHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const data     = new TextEncoder().encode(`${email}|${expStr}`);
  const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, data);
  if (!valid) throw new Error('Invalid session');
  return email;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleAuth(request, env) {
  const { token } = await request.json();
  if (!token) return err('Missing token');

  let payload;
  try {
    payload = await verifyGoogleJWT(token, env.GOOGLE_CLIENT_ID);
  } catch (e) {
    return err(`Auth failed: ${e.message}`, 401);
  }

  if (!ALLOWED_EMAILS.includes(payload.email)) {
    return err('Access denied', 403);
  }

  const session = await signSession(payload.email, env.SESSION_SECRET);
  return cors(JSON.stringify({ session, email: payload.email, name: payload.name, picture: payload.picture }));
}

async function handleAnalyze(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  if (!sessionToken) return err('Missing session token', 401);

  try {
    await verifySession(sessionToken, env.SESSION_SECRET);
  } catch (e) {
    return err(`Unauthorized: ${e.message}`, 401);
  }

  const body = await request.json();

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'x-api-key':      env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  const data = await anthropicRes.json();
  return cors(JSON.stringify(data), anthropicRes.status);
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/auth')    return handleAuth(request, env);
    if (request.method === 'POST' && url.pathname === '/analyze') return handleAnalyze(request, env);

    return err('Not found', 404);
  }
};
