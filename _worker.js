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

  // 1) Guardar respaldo local en KV (siempre)
  await env.AEGIS_SOS.put(key, JSON.stringify({ email, name, createdAt: Date.now() }));

  // 2) Sincronizar con Resend (audiencia + correo de bienvenida) si hay API key
  if (env.RESEND_API_KEY) {
    try {
      const audienceId = await getOrCreateAudience(env);
      if (audienceId) {
        // agregar contacto a la audiencia
        await fetch('https://api.resend.com/audiences/' + audienceId + '/contacts', {
          method:'POST',
          headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
          body: JSON.stringify({ email, first_name: name, unsubscribed: false })
        }).catch(()=>{});
      }
      // correo de bienvenida (best effort)
      await sendWelcomeEmail(env, email, name).catch(()=>{});
    } catch (e) { /* no romper si Resend falla */ }
  }

  return json({ ok:true });
}

async function getOrCreateAudience(env){
  // Cache en KV para no llamar a Resend cada vez
  const cached = await env.AEGIS_SOS.get('config:resend_audience_id');
  if (cached) return cached;
  try {
    // Listar audiencias y buscar "AEGIS Suscriptores"
    const r = await fetch('https://api.resend.com/audiences', {
      headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY}
    });
    const d = await r.json();
    let id = null;
    if (d && d.data && Array.isArray(d.data)) {
      const hit = d.data.find(a => a.name === 'AEGIS Suscriptores');
      if (hit) id = hit.id;
    }
    if (!id) {
      // Crearla
      const c = await fetch('https://api.resend.com/audiences', {
        method:'POST',
        headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
        body: JSON.stringify({ name: 'AEGIS Suscriptores' })
      });
      const cd = await c.json();
      id = cd && cd.id;
    }
    if (id) {
      await env.AEGIS_SOS.put('config:resend_audience_id', id);
    }
    return id;
  } catch (e) { return null; }
}

async function sendWelcomeEmail(env, email, name){
  const firstName = (name || 'amig@').split(' ')[0];
  const fromAddr = env.RESEND_FROM || 'AEGIS <onboarding@resend.dev>';
  const html = `
<!doctype html><html><body style="margin:0;padding:0;background:#070405;color:#f4eaea;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#070405">
<tr><td align="center" style="padding:40px 20px">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#0c131b;border:1px solid rgba(255,42,54,0.25);border-radius:14px;padding:30px;color:#f4eaea">
    <tr><td>
      <div style="font-family:'SFMono-Regular',Menlo,monospace;font-size:11px;letter-spacing:0.3em;color:#ff2a36;text-transform:uppercase;margin-bottom:10px">AEGIS · Tu red de protección</div>
      <h1 style="margin:0 0 16px 0;font-size:24px;font-weight:700;color:#fff">Hola ${firstName}, no estás solo/a.</h1>
      <p style="margin:0 0 12px;line-height:1.6;color:#f4eaea">Gracias por activar tu cuenta AEGIS. A partir de hoy, cuando toques el botón SOS o uses Acompáñame, tu círculo de confianza recibe tu ubicación en vivo y AEGIS te acompaña por voz.</p>
      <p style="margin:0 0 12px;line-height:1.6;color:#f4eaea"><strong style="color:#fff">Tu primer tip de seguridad:</strong> al llegar a tu casa o auto, ten las llaves <em>en la mano antes de bajar</em>, nunca las busques al llegar a la puerta. Esos segundos buscando son los que aprovecha un agresor.</p>
      <p style="margin:0 0 20px;line-height:1.6;color:#f4eaea">Cada semana te mandamos un consejo así de concreto. Nada de spam, prometido.</p>
      <a href="https://app.elartedelproteger.com" style="display:inline-block;background:#ff2a36;color:#1a0203;font-weight:700;padding:14px 24px;border-radius:12px;text-decoration:none;font-size:15px">Abrir AEGIS</a>
      <p style="margin:24px 0 0;font-size:13px;color:#8f7d80;line-height:1.6">¿Quieres profundizar? <a href="https://elartedelproteger.com/manual" style="color:#ff2a36">Conoce el manual "El Arte de Proteger"</a> de Julián Pacheco — método completo de seguridad personal con protocolos, plantillas y curso en video.</p>
      <p style="margin:20px 0 0;font-size:11px;color:#8f7d80;line-height:1.5">AEGIS no es servicio oficial de emergencias. En peligro inmediato llama al 911.<br>¿Quieres dejar de recibir estos correos? Solo respóndenos "baja" y te quitamos.</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
  await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
    body: JSON.stringify({
      from: fromAddr,
      to: [email],
      subject: '🛡️ Bienvenido/a a AEGIS — tu primer tip de seguridad',
      html: html
    })
  });
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
