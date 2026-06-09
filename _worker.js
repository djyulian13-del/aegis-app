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
  // Si ya estaba y no piden reenvío explícito, no spammeamos
  if (existing && !data.force) return json({ ok:true, already:true });

  // 1) Guardar respaldo local en KV (siempre)
  await env.AEGIS_SOS.put(key, JSON.stringify({ email, name, createdAt: existing && existing.createdAt || Date.now() }));

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
  const firstName = (name || 'amig@').toString().split(/\s+/)[0] || 'amig@';
  const fromAddr = env.RESEND_FROM || 'AEGIS <onboarding@resend.dev>';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AEGIS · Sistema activado</title></head>
<body style="margin:0;padding:0;background:#070405;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f4eaea;">
<div style="display:none;max-height:0;overflow:hidden;color:#070405;">${firstName}, tu sistema AEGIS está activo. Aquí va tu primer protocolo de seguridad y lo que sigue.</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#070405;">
<tr><td align="center" style="padding:0;background:linear-gradient(180deg,#2a070a 0%,#120607 30%,#070405 100%);">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;">

<!-- HERO -->
<tr><td align="center" style="padding:48px 24px 8px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="width:86px;height:86px;background:#070405;border-radius:50%;border:1px solid rgba(255,42,54,.45);box-shadow:0 0 40px rgba(255,42,54,.35) inset;">
    <div style="font-size:34px;line-height:84px;color:#ff5c5c;">🛡</div>
  </td></tr></table>
</td></tr>

<tr><td align="center" style="padding:18px 24px 0;">
  <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;letter-spacing:.42em;color:#ff2a36;text-transform:uppercase;">● AEGIS · Sistema activado</span>
</td></tr>

<tr><td align="center" style="padding:14px 24px 0;">
  <h1 style="margin:0;font-size:32px;line-height:1.15;font-weight:700;color:#f4eaea;letter-spacing:-.5px;">Estoy contigo, ${firstName}.</h1>
</td></tr>

<tr><td align="center" style="padding:14px 32px 28px;">
  <p style="margin:0;font-size:15px;line-height:1.6;color:#a89798;">Tu llave de iniciación quedó activa. Desde ahora, cuando toques el botón SOS o uses Acompáñame, tu círculo recibe tu ubicación <strong style="color:#f4eaea">en vivo</strong> y yo me quedo a tu lado por voz.</p>
</td></tr>

<!-- PROTOCOLO 1 -->
<tr><td style="padding:0 24px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0c131b;border:1px solid rgba(255,42,54,.25);border-radius:16px;">
    <tr><td style="padding:24px 24px 22px;">
      <div style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:.32em;color:#ff2a36;text-transform:uppercase;margin-bottom:8px;">▸ Protocolo de iniciación · #01</div>
      <h2 style="margin:0 0 14px;font-size:20px;font-weight:700;color:#f4eaea;line-height:1.25;">Las llaves SIEMPRE en la mano</h2>
      <p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:#e4d8da;">Al llegar a tu casa o auto, ten las llaves <strong style="color:#fff;">en la mano antes de bajar</strong>. Nunca las busques al llegar a la puerta.</p>
      <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#e4d8da;">Esos 8 a 15 segundos buscando llaves son los que un agresor necesita para alcanzarte.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:rgba(255,42,54,.06);border-left:3px solid #ff2a36;border-radius:6px;margin-top:8px;">
        <tr><td style="padding:12px 14px;">
          <div style="font-size:13px;line-height:1.5;color:#ffb3b8;"><strong>Truco de profesional:</strong> tu llave del auto, sola, sin llavero ruidoso. Las dos manos libres son tu primera línea de defensa.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</td></tr>

<!-- CTA -->
<tr><td align="center" style="padding:28px 24px 8px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="background:linear-gradient(180deg,#ff5c5c 0%,#ff2a36 50%,#8f0c14 100%);border-radius:99px;box-shadow:0 10px 30px -10px rgba(255,42,54,.6);">
      <a href="https://app.elartedelproteger.com" style="display:inline-block;padding:16px 38px;color:#1a0203;text-decoration:none;font-weight:800;font-size:16px;letter-spacing:.02em;">⚡ Abrir AEGIS</a>
    </td></tr>
  </table>
  <p style="margin:14px 0 0;font-size:12px;color:#8f7d80;">Tip: en iPhone abre la app desde Safari → compartir → "Añadir a inicio".</p>
</td></tr>

<!-- LO QUE SIGUE -->
<tr><td style="padding:36px 24px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid rgba(255,255,255,.08);">
    <tr><td align="center" style="padding:24px 0 18px;">
      <span style="font-family:'SFMono-Regular',Menlo,monospace;font-size:10px;letter-spacing:.4em;color:#8f7d80;text-transform:uppercase;">↘ Lo que sigue</span>
    </td></tr>

    <tr><td style="padding:0 0 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td width="48" valign="top"><div style="width:38px;height:38px;border-radius:50%;background:rgba(255,42,54,.1);border:1px solid rgba(255,42,54,.35);text-align:center;line-height:38px;font-size:16px;color:#ff2a36;">📅</div></td>
        <td valign="top" style="padding-left:14px;">
          <div style="font-size:15px;font-weight:600;color:#f4eaea;margin-bottom:3px;">Cada martes, un protocolo nuevo.</div>
          <div style="font-size:13px;line-height:1.55;color:#8f7d80;">Concretos y reales: viajes, transporte, casa, citas, agresión. Nada de relleno.</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:0 0 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td width="48" valign="top"><div style="width:38px;height:38px;border-radius:50%;background:rgba(255,42,54,.1);border:1px solid rgba(255,42,54,.35);text-align:center;line-height:38px;font-size:16px;color:#ff2a36;">📖</div></td>
        <td valign="top" style="padding-left:14px;">
          <div style="font-size:15px;font-weight:600;color:#f4eaea;margin-bottom:3px;">¿Quieres el método completo?</div>
          <div style="font-size:13px;line-height:1.55;color:#8f7d80;">El manual <a href="https://elartedelproteger.com/manual" style="color:#ff2a36;text-decoration:underline;">El Arte de Proteger</a> — 17 capítulos, plantillas y curso en video para llevar tu seguridad al siguiente nivel.</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:0 0 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        <td width="48" valign="top"><div style="width:38px;height:38px;border-radius:50%;background:rgba(255,42,54,.1);border:1px solid rgba(255,42,54,.35);text-align:center;line-height:38px;font-size:16px;color:#ff2a36;">👥</div></td>
        <td valign="top" style="padding-left:14px;">
          <div style="font-size:15px;font-weight:600;color:#f4eaea;margin-bottom:3px;">Comparte AEGIS con quien te importa.</div>
          <div style="font-size:13px;line-height:1.55;color:#8f7d80;">Si tú tienes red de protección, ellos también merecen una. <a href="https://wa.me/?text=No%20est%C3%A1s%20solo%2Fa.%20Activ%C3%A9%20AEGIS%2C%20una%20app%20gratis%20de%20protecci%C3%B3n%20personal%3A%20https%3A%2F%2Fapp.elartedelproteger.com" style="color:#ff2a36;text-decoration:underline;">Mandar AEGIS por WhatsApp →</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td align="center" style="padding:24px 24px 40px;border-top:1px solid rgba(255,255,255,.06);">
  <p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#8f7d80;">
    <strong style="color:#f4eaea;">AEGIS</strong> · Tu red de protección · Hecho en Querétaro, México<br>
    Por <a href="https://elartedelproteger.com" style="color:#ff2a36;text-decoration:none;">Julián Pacheco</a>
  </p>
  <p style="margin:8px 0 0;font-size:10px;color:#5d4f51;line-height:1.5;">⚠ AEGIS NO es servicio oficial de emergencias. En peligro inmediato, llama al 911.<br>¿No quieres más correos? Responde "baja" y te saco de la lista.</p>
</td></tr>

</table></td></tr></table></body></html>`;
  await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
    body: JSON.stringify({
      from: fromAddr,
      to: [email],
      subject: `🛡 Estoy contigo, ${firstName}. Tu sistema AEGIS está activo.`,
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
