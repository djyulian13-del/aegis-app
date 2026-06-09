/* AEGIS — Worker con archivos estáticos + API de SOS en vivo.
   - Rutas /api/sos/* manejan el seguimiento en tiempo real (lectura/escritura en KV).
   - Cualquier otra ruta cae a los archivos estáticos del proyecto. */

const TTL = 24 * 60 * 60; // 24 horas
const MAX_HISTORY = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (path === '/api/sos/update' && request.method === 'POST') return cors(await sosUpdate(request, env));
    if (path === '/api/sos/get'    && request.method === 'GET')  return cors(await sosGet(request, env));
    if (path === '/api/sos/status' && request.method === 'POST') return cors(await sosStatus(request, env));
    if (path === '/api/subscribe'  && request.method === 'POST') return cors(await subscribe(request, env));

    // Resto: archivos estáticos
    return env.ASSETS.fetch(request);
  }
};

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return res;
}

function json(obj, status=200){
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type':'application/json' } });
}

async function sosUpdate(request, env) {
  let data;
  try { data = await request.json(); } catch (e) { return json({ ok:false, error:'bad json' }, 400); }
  if (!data || typeof data.id !== 'string' || data.id.length < 4 || data.id.length > 64) {
    return json({ ok:false, error:'bad id' }, 400);
  }
  const key = 'sos:' + data.id;
  let entry = await env.AEGIS_SOS.get(key, 'json');
  if (!entry) {
    entry = { user: typeof data.user==='string' ? data.user.slice(0,40) : 'Persona', createdAt: Date.now(), history: [], status: [], safe: false };
  } else if (data.user && !entry.user) {
    entry.user = data.user.slice(0,40);
  }
  if (typeof data.lat === 'number' && typeof data.lng === 'number') {
    entry.history.push({ lat:data.lat, lng:data.lng, acc:Math.round(data.accuracy||0), ts:Date.now() });
    if (entry.history.length > MAX_HISTORY) entry.history = entry.history.slice(-MAX_HISTORY);
  }
  if (data.safe === true) entry.safe = true;
  entry.lastUpdate = Date.now();
  await env.AEGIS_SOS.put(key, JSON.stringify(entry), { expirationTtl: TTL });
  return json({ ok:true });
}

async function sosGet(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return json({ notFound:true }, 400);
  const entry = await env.AEGIS_SOS.get('sos:' + id, 'json');
  if (!entry) return json({ notFound:true });
  return json(entry);
}

async function subscribe(request, env) {
  let data;
  try { data = await request.json(); } catch (e) { return json({ ok:false }, 400); }
  if (!data || typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return json({ ok:false, error:'bad email' }, 400);
  }
  const email = data.email.toLowerCase().slice(0, 120);
  const name = (data.name || '').toString().slice(0, 50);
  const key = 'sub:' + email;
  const existing = await env.AEGIS_SOS.get(key, 'json');
  if (existing) return json({ ok:true, already:true });
  await env.AEGIS_SOS.put(key, JSON.stringify({ email, name, createdAt: Date.now() }));
  return json({ ok:true });
}

async function sosStatus(request, env) {
  let data;
  try { data = await request.json(); } catch (e) { return json({ ok:false, error:'bad json' }, 400); }
  if (!data || typeof data.id !== 'string' || typeof data.action !== 'string') return json({ ok:false, error:'bad request' }, 400);
  const allowed = ['voy_en_camino','llame_911','atendida'];
  if (allowed.indexOf(data.action) < 0) return json({ ok:false, error:'bad action' }, 400);
  const key = 'sos:' + data.id;
  const entry = await env.AEGIS_SOS.get(key, 'json');
  if (!entry) return json({ notFound:true });
  entry.status.push({
    who: typeof data.who==='string' ? data.who.slice(0,40) : 'Contacto',
    action: data.action,
    ts: Date.now()
  });
  await env.AEGIS_SOS.put(key, JSON.stringify(entry), { expirationTtl: TTL });
  return json({ ok:true });
}
