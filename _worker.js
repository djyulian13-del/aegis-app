/* PJ ALERT — Worker con archivos estáticos + API de SOS en vivo.
   - Rutas /api/sos/* manejan el seguimiento en tiempo real (lectura/escritura en KV).
   - Cualquier otra ruta cae a los archivos estáticos del proyecto. */

const TTL = 24 * 60 * 60; // 24 horas
const MAX_HISTORY = 60; // redeploy

function b64u(s){return btoa(unescape(encodeURIComponent(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');} function unb64u(s){s=(s||'').replace(/-/g,'+').replace(/_/g,'/');try{return decodeURIComponent(escape(atob(s)));}catch(_){return '';}} function unsubUrl(email){return 'https://app.elartedelproteger.com/api/unsub?e='+b64u(email);} function unsubFooter(email){return '<div style="margin-top:26px;padding-top:16px;border-top:1px solid rgba(0,0,0,.08);font:400 12px/1.6 -apple-system,system-ui,sans-serif;color:#9a9a9a;text-align:center;">Recibes este correo porque te registraste en PJ ALERT.<br>Si ya no quieres recibirlos, <a href="'+unsubUrl(email)+'" style="color:#9a9a9a;">date de baja aqu&iacute;</a>.</div>';} async function handleUnsub(request,env){const url=new URL(request.url);let email=unb64u(url.searchParams.get('e')||'').trim();if(email){try{await env.AEGIS_SOS.delete('sub:'+email);await env.AEGIS_SOS.delete('sub:'+email.toLowerCase());}catch(_){}}if(request.method==='POST'){return new Response('ok',{status:200});}const page='<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Baja confirmada</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0405;color:#fff;font-family:-apple-system,system-ui,sans-serif;text-align:center;"><div style="max-width:440px;padding:32px;"><div style="font-size:44px;line-height:1;margin-bottom:14px;color:#ff5c5c;">&#10003;</div><h1 style="margin:0 0 10px;font-size:22px;">Listo, te diste de baja</h1><p style="margin:0;color:#cbb6b8;font-size:15px;line-height:1.6;">Ya no recibir&aacute;s m&aacute;s correos de PJ ALERT'+(email?(' en <b>'+email+'</b>'):'')+'. Si fue un error, puedes volver a registrarte en la app cuando quieras.</p></div></body></html>';return new Response(page,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});} export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (path === '/api/sos/update' && request.method === 'POST') return cors(await sosUpdate(request, env));
    if (path === '/api/sos/get'    && request.method === 'GET')  return cors(await sosGet(request, env));
    if (path === '/api/sos/status' && request.method === 'POST') return cors(await sosStatus(request, env)); if (path === '/api/sos/alert' && request.method === 'POST') return cors(await sosAlert(request, env));
    if (path === '/api/acomp/start'   && request.method === 'POST') return cors(await acompStart(request, env));
    if (path === '/api/acomp/ping'    && request.method === 'POST') return cors(await acompPing(request, env));
    if (path === '/api/acomp/extend'  && request.method === 'POST') return cors(await acompExtend(request, env));
    if (path === '/api/acomp/checkin' && request.method === 'POST') return cors(await acompCheckin(request, env));
    if (path === '/api/review'    && request.method === 'POST') return cors(await reviewAdd(request, env));
    if (path === '/api/reviews'   && request.method === 'GET')  return cors(await reviewsGet(request, env));
    if (path === '/api/subscribe'  && request.method === 'POST') return cors(await subscribe(request, env)); if (path === '/api/unsub') return await handleUnsub(request, env);
    if (path === '/api/admin/stats' && request.method === 'GET') return cors(await adminStats(request, env));
    if (path === '/api/admin/broadcast' && request.method === 'POST') return cors(await broadcast(request, env)); if (path === '/api/admin/rebuild' && request.method === 'POST') return cors(await adminRebuild(request, env));

    // Resto: archivos estáticos
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(acompSweep(env));
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
  const isNew = !entry;
  if (!entry) {
    entry = { user: typeof data.user==='string' ? data.user.slice(0,40) : 'Persona', createdAt: Date.now(), history: [], status: [], safe: false };
  } else if (data.user && !entry.user) {
    entry.user = data.user.slice(0,40);
  }
  // contadores SOS (solo en el primer update por sesión)
  if (isNew) {
    const country = (request.cf && request.cf.country) || 'XX';
    await incrCounter(env, 'stats:sos_count');
    await incrCounter(env, 'stats:sos_country:' + country);
    await pushRecent(env, 'stats:recent_sos', {
      id: data.id, user: entry.user, country, ts: Date.now()
    }, 50);
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
  if (existing && !data.force) { try { await sendWelcomeEmail(env, email, name); } catch(e){} return json({ ok:true, already:true }); }

  const country = (request.cf && request.cf.country) || 'XX';

  // 1) Guardar respaldo local en KV (siempre)
  await env.AEGIS_SOS.put(key, JSON.stringify({ email, name, country, createdAt: existing && existing.createdAt || Date.now() }));

  // 1b) Contadores y lista de recientes (solo si es nuevo)
  if (!existing) {
    await incrCounter(env, 'stats:subs_count');
    await incrCounter(env, 'stats:country:' + country);
    await pushRecent(env, 'stats:recent_subs', {
      email, name, country, ts: Date.now()
    }, 50);
  }

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
    // Listar audiencias y buscar "PJ ALERT Suscriptores"
    const r = await fetch('https://api.resend.com/audiences', {
      headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY}
    });
    const d = await r.json();
    let id = null;
    if (d && d.data && Array.isArray(d.data)) {
      const hit = d.data.find(a => a.name === 'PJ ALERT Suscriptores');
      if (hit) id = hit.id;
    }
    if (!id) {
      // Crearla
      const c = await fetch('https://api.resend.com/audiences', {
        method:'POST',
        headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
        body: JSON.stringify({ name: 'PJ ALERT Suscriptores' })
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
  const fromAddr = env.RESEND_FROM || 'PJ ALERT <aegis@elartedelproteger.com>';
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PJ ALERT · Sistema activado</title></head>
<body style="margin:0;padding:0;background:#070405;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f4eaea;">
<div style="display:none;max-height:0;overflow:hidden;color:#070405;">${firstName}, tu sistema PJ ALERT está activo. Aquí va tu primer protocolo de seguridad y lo que sigue.</div>
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
  <span style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:11px;letter-spacing:.42em;color:#ff2a36;text-transform:uppercase;">● PJ ALERT · Sistema activado</span>
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
      <div style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:.32em;color:#ff2a36;text-transform:uppercase;margin-bottom:8px;">▸ Protocolo de bienvenida</div>
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
      <a href="https://app.elartedelproteger.com" style="display:inline-block;padding:16px 38px;color:#1a0203;text-decoration:none;font-weight:800;font-size:16px;letter-spacing:.02em;">⚡ Abrir PJ ALERT</a>
    </td></tr>
  </table>
</td></tr>

<!-- INSTALAR -->
<tr><td style="padding:20px 24px 0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0c131b;border:1px solid rgba(255,255,255,.08);border-radius:14px;">
    <tr><td style="padding:18px 18px 16px;">
      <div style="font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:.32em;color:#ff2a36;text-transform:uppercase;margin-bottom:10px;">▸ Instala PJ ALERT en tu teléfono</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td width="44" valign="top"><div style="width:34px;height:34px;border-radius:9px;background:rgba(0,122,255,.12);border:1px solid rgba(0,122,255,.4);text-align:center;line-height:34px;font-size:16px;color:#5ea8ff;">📱</div></td>
          <td valign="top" style="padding:0 0 12px 12px;">
            <div style="font-size:14px;font-weight:700;color:#f4eaea;margin-bottom:2px;">iPhone</div>
            <div style="font-size:13px;line-height:1.5;color:#a89798;">Abre la app en <strong style="color:#f4eaea;">Safari</strong> → toca el botón compartir <span style="color:#5ea8ff;">⬆️</span> → "<strong style="color:#f4eaea;">Añadir a pantalla de inicio</strong>".</div>
          </td>
        </tr>
        <tr>
          <td width="44" valign="top"><div style="width:34px;height:34px;border-radius:9px;background:rgba(60,200,120,.12);border:1px solid rgba(60,200,120,.4);text-align:center;line-height:34px;font-size:16px;color:#7dd99f;">🤖</div></td>
          <td valign="top" style="padding:0 0 0 12px;">
            <div style="font-size:14px;font-weight:700;color:#f4eaea;margin-bottom:2px;">Android</div>
            <div style="font-size:13px;line-height:1.5;color:#a89798;">Abre la app en <strong style="color:#f4eaea;">Chrome</strong> → toca el menú <strong style="color:#f4eaea;">⋮</strong> → "<strong style="color:#f4eaea;">Instalar aplicación</strong>" (o "Añadir a pantalla principal").</div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
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
          <div style="font-size:15px;font-weight:600;color:#f4eaea;margin-bottom:3px;">Comparte PJ ALERT con quien te importa.</div>
          <div style="font-size:13px;line-height:1.55;color:#8f7d80;">Si tú tienes red de protección, ellos también merecen una. <a href="https://wa.me/?text=No%20est%C3%A1s%20solo%2Fa.%20Activ%C3%A9%20PJ ALERT%2C%20una%20app%20gratis%20de%20protecci%C3%B3n%20personal%3A%20https%3A%2F%2Fapp.elartedelproteger.com" style="color:#ff2a36;text-decoration:underline;">Mandar PJ ALERT por WhatsApp →</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>
</td></tr>

<!-- DISCLAIMER BOX -->
<tr><td align="center" style="padding:4px 24px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#8f0c14" style="background-color:#8f0c14;border-radius:10px;">
    <tr><td bgcolor="#8f0c14" style="background-color:#8f0c14;padding:16px 18px;border-radius:10px;">
      <p style="margin:0;font-size:13px;line-height:1.55;color:#ffffff;text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <strong style="color:#ffffff;">⚠ Importante:</strong> PJ ALERT <strong style="color:#ffffff;">NO</strong> es un servicio oficial de emergencias y <strong style="color:#ffffff;">NO</strong> sustituye al 911. Si tu vida está en peligro inmediato, <strong style="color:#ffffff;">llama primero al 911</strong>.
      </p>
    </td></tr>
  </table>
</td></tr>

<!-- FOOTER -->
<tr><td align="center" style="padding:18px 24px 40px;border-top:1px solid rgba(255,255,255,.06);">
  <p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:#8f7d80;">
    <strong style="color:#f4eaea;">PJ ALERT</strong> · Tu red de protección<br>
    <a href="https://elartedelproteger.com" style="color:#ff2a36;text-decoration:none;">elartedelproteger.com</a>
  </p>
  <p style="margin:10px 0 0;font-size:11px;color:#8f7d80;line-height:1.5;">¿No quieres más correos? Responde "baja" y te saco de la lista.</p>
</td></tr>

</table></td></tr></table></body></html>`;
  await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer ' + env.RESEND_API_KEY, 'Content-Type':'application/json'},
    body: JSON.stringify({
      from: fromAddr,
      to: [email],
      subject: `🛡 Estoy contigo, ${firstName}. Tu sistema PJ ALERT está activo.`,
      html: html + unsubFooter(email), headers: { 'List-Unsubscribe': '<' + unsubUrl(email) + '>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    })
  });
}

// ============================================================
// STATS / ADMIN DASHBOARD
// ============================================================

async function incrCounter(env, key){
  const cur = parseInt(await env.AEGIS_SOS.get(key) || '0', 10);
  await env.AEGIS_SOS.put(key, String(cur + 1));
}

async function pushRecent(env, key, item, max){
  const cur = await env.AEGIS_SOS.get(key, 'json') || [];
  cur.unshift(item);
  if (cur.length > max) cur.length = max;
  await env.AEGIS_SOS.put(key, JSON.stringify(cur));
}

async function broadcast(request, env){ const u=new URL(request.url); const key=u.searchParams.get('key')||request.headers.get('x-admin-key')||''; if(!env.ADMIN_KEY||key!==env.ADMIN_KEY) return json({ok:false,error:'unauthorized'},401); let b; try{ b=await request.json(); }catch(e){ return json({ok:false,error:'bad body'},400); } const subject=(b.subject||'').toString(); const html=(b.html||'').toString(); if(!subject||!html||!env.RESEND_API_KEY) return json({ok:false,error:'missing'},400); const fromAddr=env.RESEND_FROM||'PJ ALERT <aegis@elartedelproteger.com>'; const listing=await env.AEGIS_SOS.list({prefix:'sub:'}); let sent=0,failed=0; for(const k of listing.keys){ const email=k.name.slice(4); try{ const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:fromAddr,to:[email],subject:subject,html:html+unsubFooter(email),headers:{'List-Unsubscribe':'<'+unsubUrl(email)+'>','List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}})}); if(r.ok)sent++;else failed++; }catch(e){ failed++; } } return json({ok:true,total:listing.keys.length,sent,failed}); } async function adminStats(request, env){
  // Auth: ?key=... o header x-admin-key
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key') || '';
  const expected = env.ADMIN_KEY || '';
  if (!expected) return json({ error:'ADMIN_KEY not configured' }, 500);
  if (key !== expected) return json({ error:'unauthorized' }, 401);

  const [subs_count, sos_count, recent_subs, recent_sos] = await Promise.all([
    env.AEGIS_SOS.get('stats:subs_count').then(v => parseInt(v||'0',10)),
    env.AEGIS_SOS.get('stats:sos_count').then(v => parseInt(v||'0',10)),
    env.AEGIS_SOS.get('stats:recent_subs','json').then(v => v||[]),
    env.AEGIS_SOS.get('stats:recent_sos','json').then(v => v||[])
  ]);

  // Países: enumerar prefijos stats:country: y stats:sos_country:
  const [subC, sosC] = await Promise.all([
    env.AEGIS_SOS.list({ prefix: 'stats:country:' }),
    env.AEGIS_SOS.list({ prefix: 'stats:sos_country:' })
  ]);

  async function readCountries(listing, prefix){
    const out = {};
    for (const k of listing.keys){
      const code = k.name.slice(prefix.length);
      const v = parseInt(await env.AEGIS_SOS.get(k.name) || '0', 10);
      out[code] = v;
    }
    return out;
  }
  const subs_by_country = await readCountries(subC, 'stats:country:');
  const sos_by_country = await readCountries(sosC, 'stats:sos_country:');

  const reviews = (await env.AEGIS_SOS.get('stats:reviews','json')) || [];
  return json({
    subs_count, sos_count,
    subs_by_country, sos_by_country,
    recent_subs, recent_sos,
    reviews,
    generated_at: Date.now()
  });
}

// Admin: recalcular stats desde KV + (opcional) borrar correos de prueba
async function adminRebuild(request, env){
  const url = new URL(request.url);
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key') || '';
  if (!env.ADMIN_KEY) return json({ error:'ADMIN_KEY not configured' }, 500);
  if (key !== env.ADMIN_KEY) return json({ error:'unauthorized' }, 401);

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const removeEmails = Array.isArray(body.removeEmails) ? body.removeEmails : [];

  // Reset opcional de contadores de SOS de prueba
  if (body.resetSos) {
    await env.AEGIS_SOS.put('stats:sos_count', '0');
    await env.AEGIS_SOS.put('stats:recent_sos', JSON.stringify([]));
    const scs = await env.AEGIS_SOS.list({ prefix: 'stats:sos_country:' });
    for (const k of scs.keys) await env.AEGIS_SOS.delete(k.name);
  }

  if (body.hideReview || body.showReview) {
    const rid = body.hideReview || body.showReview;
    const arr = (await env.AEGIS_SOS.get('stats:reviews','json')) || [];
    for (const rv of arr){ if(rv.id===rid) rv.hidden = !!body.hideReview; }
    await env.AEGIS_SOS.put('stats:reviews', JSON.stringify(arr));
  }

  // borrar correos solicitados
  for (const e of removeEmails) {
    await env.AEGIS_SOS.delete('sub:' + String(e).toLowerCase());
  }

  // listar todos los suscriptores
  const subs = [];
  let cursor = undefined;
  do {
    const listing = await env.AEGIS_SOS.list({ prefix: 'sub:', cursor });
    for (const k of listing.keys) {
      const v = await env.AEGIS_SOS.get(k.name, 'json');
      if (v && v.email) subs.push(v);
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);

  // contar por país
  const countries = {};
  for (const s of subs) {
    const c = s.country || 'XX';
    countries[c] = (countries[c] || 0) + 1;
  }

  // contador total
  await env.AEGIS_SOS.put('stats:subs_count', String(subs.length));

  // limpiar contadores de país viejos
  const oldCountryKeys = await env.AEGIS_SOS.list({ prefix: 'stats:country:' });
  for (const k of oldCountryKeys.keys) await env.AEGIS_SOS.delete(k.name);
  for (const [c, n] of Object.entries(countries)) {
    await env.AEGIS_SOS.put('stats:country:' + c, String(n));
  }

  // recientes
  const recent = subs
    .filter(s => s.createdAt)
    .sort((a,b) => (b.createdAt||0) - (a.createdAt||0))
    .slice(0, 50)
    .map(s => ({ email: s.email, name: s.name || '', country: s.country || 'XX', ts: s.createdAt }));
  await env.AEGIS_SOS.put('stats:recent_subs', JSON.stringify(recent));

  return json({
    ok: true,
    total_subs: subs.length,
    removed: removeEmails.length,
    countries
  });
}

// ============================================================
// ACOMPANAME (check-in con alerta server-side via cron)
// ============================================================
const ACOMP_TTL = 12 * 60 * 60;
function acompRid(){ return Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4); }
function escapeHtmlW(s){ return (s||'').toString().replace(/[&<>"]/g, function(ch){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]; }); }

async function acompStart(request, env){
  let d; try { d = await request.json(); } catch(e){ return json({ ok:false, error:'bad json' }, 400); }
  if (!d) return json({ ok:false }, 400);
  const mins = Math.max(1, Math.min(720, parseInt(d.mins,10) || 15));
  const now = Date.now();
  const id = acompRid();
  const e = {
    id: id,
    name: (d.name||'Alguien').toString().slice(0,40),
    dest: (d.dest||'su destino').toString().slice(0,60),
    mins: mins,
    contactName: (d.contactName||'tu contacto').toString().slice(0,40),
    contactPhone: (d.contactPhone||'').toString().replace(/[^0-9]/g,'').slice(0,20),
    contactEmail: (d.contactEmail||'').toString().slice(0,120),
    userEmail: (d.userEmail||'').toString().slice(0,120),
    lat: (typeof d.lat==='number') ? d.lat : null,
    lng: (typeof d.lng==='number') ? d.lng : null,
    startedAt: now,
    until: now + mins*60000,
    active: true,
    alerted: false
  };
  await env.AEGIS_SOS.put('acomp:'+id, JSON.stringify(e), { expirationTtl: ACOMP_TTL });
  return json({ ok:true, id: id });
}
async function acompGet(env, id){
  if (!id || typeof id !== 'string') return null;
  return await env.AEGIS_SOS.get('acomp:'+id.slice(0,40), 'json');
}
async function acompPing(request, env){
  let d; try { d = await request.json(); } catch(e){ return json({ ok:false }, 400); }
  const e = await acompGet(env, d && d.id);
  if (!e || !e.active) return json({ ok:true, inactive:true });
  if (typeof d.lat==='number') e.lat = d.lat;
  if (typeof d.lng==='number') e.lng = d.lng;
  await env.AEGIS_SOS.put('acomp:'+e.id, JSON.stringify(e), { expirationTtl: ACOMP_TTL });
  return json({ ok:true });
}
async function acompExtend(request, env){
  let d; try { d = await request.json(); } catch(e){ return json({ ok:false }, 400); }
  const e = await acompGet(env, d && d.id);
  if (!e || !e.active) return json({ ok:true, inactive:true });
  const add = Math.max(1, Math.min(180, parseInt(d.mins,10) || 15));
  e.until += add*60000; e.mins += add; e.alerted = false;
  await env.AEGIS_SOS.put('acomp:'+e.id, JSON.stringify(e), { expirationTtl: ACOMP_TTL });
  return json({ ok:true, until:e.until });
}
async function acompCheckin(request, env){
  let d; try { d = await request.json(); } catch(e){ return json({ ok:false }, 400); }
  const e = await acompGet(env, d && d.id);
  if (!e) return json({ ok:true, notFound:true });
  e.active = false; e.arrived = !(d && d.cancelled);
  await env.AEGIS_SOS.put('acomp:'+e.id, JSON.stringify(e), { expirationTtl: 6*60*60 });
  return json({ ok:true });
}
async function acompSweep(env){
  const now = Date.now();
  let cursor;
  do {
    const listing = await env.AEGIS_SOS.list({ prefix:'acomp:', cursor: cursor });
    for (const k of listing.keys){
      const e = await env.AEGIS_SOS.get(k.name, 'json');
      if (e && e.active && !e.alerted && now >= e.until){
        try { await sendAcompAlert(env, e); } catch(err){}
        e.alerted = true; e.active = false;
        await env.AEGIS_SOS.put(k.name, JSON.stringify(e), { expirationTtl: 6*60*60 });
      }
    }
    cursor = listing.list_complete ? undefined : listing.cursor;
  } while (cursor);
}
async function sendAcompAlert(env, e){
  if (!env.RESEND_API_KEY) return;
  const to = [];
  if (e.contactEmail) to.push(e.contactEmail);
  if (e.userEmail && to.indexOf(e.userEmail) < 0) to.push(e.userEmail);
  if (!to.length) return;
  const fromAddr = env.RESEND_FROM || 'PJ ALERT <aegis@elartedelproteger.com>';
  const hasLoc = (e.lat!=null && e.lng!=null);
  const mapUrl = hasLoc ? ('https://www.google.com/maps?q='+e.lat+','+e.lng) : '';
  const waUrl = e.contactPhone ? ('https://wa.me/'+e.contactPhone) : '';
  const hora = new Date(e.until).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit',timeZone:'America/Mexico_City'});
  const name = escapeHtmlW(e.name); const dest = escapeHtmlW(e.dest);
  const html = '<!doctype html><html lang="es"><body style="margin:0;background:#070405;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#f4eaea">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#070405"><tr><td align="center" style="padding:30px 16px">' +
    '<table role="presentation" width="100%" style="max-width:560px">' +
    '<tr><td style="background:#8f0c14;border-radius:12px 12px 0 0;padding:18px 22px"><div style="font-size:12px;letter-spacing:.2em;color:#ffd7da">&#9888;&#65039; ALERTA PJ ALERT</div><div style="font-size:22px;font-weight:800;color:#fff;margin-top:6px">' + name + ' no confirm&#243; que lleg&#243;</div></td></tr>' +
    '<tr><td style="background:#0c131b;padding:22px;border:1px solid rgba(255,42,54,.25);border-top:none">' +
    '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#e4d8da">' + name + ' activ&#243; <b>Acomp&#225;&#241;ame</b> en PJ ALERT rumbo a <b>' + dest + '</b> y deb&#237;a confirmar su llegada antes de las <b>' + hora + '</b>. No lo hizo. Por favor, <b>verifica que est&#233; bien.</b></p>' +
    (hasLoc ? '<p style="margin:0 0 8px;font-size:13px;color:#8f7d80">&#128205; &Uacute;ltima ubicaci&#243;n conocida:</p><a href="' + mapUrl + '" style="display:inline-block;background:#1a4fa1;color:#fff;text-decoration:none;padding:11px 16px;border-radius:9px;font-weight:700;font-size:14px;margin-bottom:14px">Ver en el mapa</a><br>' : '<p style="margin:0 0 14px;font-size:13px;color:#8f7d80">No hay ubicaci&#243;n registrada en esta sesi&#243;n.</p>') +
    (waUrl ? '<a href="' + waUrl + '" style="display:inline-block;background:#1f9e74;color:#fff;text-decoration:none;padding:11px 16px;border-radius:9px;font-weight:700;font-size:14px">Escribirle por WhatsApp</a>' : '') +
    '<table role="presentation" width="100%" style="background:rgba(255,42,54,.07);border-left:3px solid #ff2a36;border-radius:6px;margin-top:18px"><tr><td style="padding:12px 14px;font-size:13px;line-height:1.5;color:#ffb3b8"><b>Qu&#233; hacer:</b> respira, intenta contactarle, y si no responde o algo se siente mal, <b>llama al 911</b> con su ubicaci&#243;n. No vayas solo/a.</td></tr></table>' +
    '</td></tr>' +
    '<tr><td style="background:#0c131b;border-radius:0 0 12px 12px;border:1px solid rgba(255,42,54,.25);border-top:none;padding:14px 22px;text-align:center"><span style="font-size:11px;color:#8f7d80">PJ ALERT &middot; El Arte de Proteger &middot; no sustituye a los servicios de emergencia oficiales</span></td></tr>' +
    '</table></td></tr></table></body></html>';
  await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},
    body: JSON.stringify({ from: fromAddr, to: to, subject: '\uD83D\uDEA8 ALERTA PJ ALERT: '+e.name+' no confirmo llegada', html: html })
  });
}

async function sosAlert(request, env){ let b; try{ b=await request.json(); }catch(e){ return json({ok:false,error:'bad body'},400); } const sosId=(b.sosId||'').toString().slice(0,60); const name=(b.name||'Alguien').toString().slice(0,40); let emails=Array.isArray(b.emails)?b.emails:[]; emails=emails.filter(function(x){return typeof x==='string'&&/.+@.+\..+/.test(x);}).slice(0,5); if(!sosId||!emails.length||!env.RESEND_API_KEY) return json({ok:false,error:'missing'},400); const link='https://app.elartedelproteger.com/sos.html?id='+encodeURIComponent(sosId); const fromAddr=env.RESEND_FROM||'PJ ALERT <aegis@elartedelproteger.com>'; const subject='ALERTA SOS de '+name+' - puede necesitar ayuda'; const html='<div style="font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:0 auto;background:#0a0405;color:#ffffff;border-radius:16px;overflow:hidden;"><div style="background:#e21621;padding:22px 20px;text-align:center;font-size:20px;font-weight:800;letter-spacing:.04em;">ALERTA SOS</div><div style="padding:24px 22px;"><p style="font-size:16px;line-height:1.5;margin:0 0 16px;"><b>'+name+'</b> activ&oacute; una alerta de emergencia en PJ ALERT y te eligi&oacute; como contacto de confianza.</p><p style="font-size:15px;line-height:1.5;color:#cbb6b8;margin:0 0 22px;">Abre el enlace para ver su <b style="color:#ffffff;">ubicaci&oacute;n en vivo</b> (se actualiza sola). Si crees que est&aacute; en peligro, ll&aacute;male y, si es necesario, marca al 911.</p><div style="text-align:center;"><a href="'+link+'" style="display:inline-block;background:#e21621;color:#ffffff;font-size:16px;font-weight:800;text-decoration:none;padding:15px 32px;border-radius:99px;">Ver ubicaci&oacute;n en vivo</a></div><p style="font-size:12px;color:#8f7d80;margin:22px 0 0;word-break:break-all;text-align:center;">'+link+'</p></div></div>'; let sent=0,failed=0; for(const email of emails){ try{ const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:fromAddr,to:[email],subject:subject,html:html})}); if(r.ok)sent++;else failed++; }catch(e){ failed++; } } return json({ok:true,total:emails.length,sent,failed}); } async function reviewAdd(request, env){
  let d; try{ d=await request.json(); }catch(e){ return json({ok:false},400); }
  if(!d) return json({ok:false},400);
  const stars = Math.max(1, Math.min(5, parseInt(d.stars,10)||0));
  if(!stars) return json({ok:false, error:'stars'},400);
  const text = (d.text||'').toString().slice(0,400).replace(/[<>]/g,'');
  const name = (d.name||'Alguien').toString().slice(0,40).replace(/[<>]/g,'');
  const country = (request.cf && request.cf.country) || 'XX';
  const rev = { id:acompRid(), stars:stars, text:text, name:name, country:country, ts:Date.now(), hidden:false };
  const arr = (await env.AEGIS_SOS.get('stats:reviews','json')) || [];
  arr.unshift(rev);
  if(arr.length>200) arr.length=200;
  await env.AEGIS_SOS.put('stats:reviews', JSON.stringify(arr));
  return json({ ok:true });
}
async function reviewsGet(request, env){
  const arr = (await env.AEGIS_SOS.get('stats:reviews','json')) || [];
  const visible = arr.filter(function(r){ return !r.hidden; });
  const count = visible.length;
  const avg = count ? (visible.reduce(function(s,r){ return s+(r.stars||0); },0)/count) : 0;
  const list = visible.slice(0,50).map(function(r){ return { stars:r.stars, text:r.text, name:r.name, ts:r.ts, country:r.country }; });
  return json({ ok:true, count:count, avg:Math.round(avg*10)/10, reviews:list });
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
