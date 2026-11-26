// Reads vendor quotations and brand price lists with Claude, for the office team only
// (storekeepers type their items by hand).
// The Anthropic API key lives only on the server, as the Vercel environment
// variable ANTHROPIC_API_KEY. The website never sees it.
//
// GET  /api/read  -> {ready:true|false}  (is the key set up?)
// POST /api/read  -> {result:{...}}      (needs a signed-in person)
//   body: {prompt:"...", images:[{type:"image/jpeg", data:"<base64>"}]}

const Anthropic = require('@anthropic-ai/sdk');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sptzqdmxrctnlloxjgeq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_3giQunKA0R5rokf5bPtE_A_BFbh670V'; // public by design
// Which Claude model reads the files. Set ANTHROPIC_MODEL in Vercel to change it without a code change.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const MAX_IMAGES = 5;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
};

// Only active people of the company may use it: check the Supabase login.
async function signedInRole(token) {
  if (!token) return null;
  const h = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token };
  const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: h });
  if (!u.ok) return null;
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/my_role', {
    method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!r.ok) return null;
  return (await r.json()) || null;
}

function firstJson(text) {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

module.exports = async (req, res) => {
  const ready = !!process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return send(res, 200, { ready });
  if (req.method !== 'POST') return send(res, 405, { error: 'method' });
  if (!ready) return send(res, 503, { error: 'not_configured' });

  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let role = null;
  try { role = await signedInRole(token); } catch { role = null; }
  if (!role) return send(res, 401, { error: 'not_granted' });
  if (role === 'store') return send(res, 403, { error: 'not_granted' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.slice(0, 120000) : '';
  const images = Array.isArray(body?.images) ? body.images.slice(0, MAX_IMAGES) : [];
  if (!prompt) return send(res, 400, { error: 'failed' });
  for (const im of images) {
    if (!IMAGE_TYPES.includes(im?.type) || typeof im?.data !== 'string' || !im.data) {
      return send(res, 400, { error: 'image_rejected' });
    }
  }

  const content = [
    ...images.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.type, data: im.data } })),
    { type: 'text', text: prompt },
  ];

  const client = new Anthropic();
  try {
    // Server-side refusal fallback exists for Opus and Sonnet, not for Haiku.
    const fallback = /haiku/.test(MODEL) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    const msg = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      ...fallback,
      messages: [{ role: 'user', content }],
    });
    if (msg.stop_reason === 'refusal') return send(res, 422, { error: 'image_rejected' });
    const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const result = firstJson(text);
    if (!result) return send(res, 502, { error: 'failed' });
    return send(res, 200, { result });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return send(res, 503, { error: 'not_configured' });
    if (e instanceof Anthropic.RateLimitError) return send(res, 429, { error: 'rate_limited' });
    if (e instanceof Anthropic.BadRequestError) return send(res, 400, { error: 'image_rejected' });
    if (e instanceof Anthropic.APIError) return send(res, 502, { error: 'failed' });
    return send(res, 500, { error: 'failed' });
  }
};
