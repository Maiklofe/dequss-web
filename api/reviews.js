// API de reseñas de DEQUSS (Vercel Serverless Function).
// Guarda las reseñas en Upstash Redis (Vercel → Storage → Upstash for Redis).
//
// GET    /api/reviews            → lista de reseñas publicadas (más nuevas primero)
// POST   /api/reviews            → publica una reseña { nombre, marca, estrellas, texto }
// DELETE /api/reviews?id=XXXX    → borra una reseña (header x-admin-key = ADMIN_KEY)

const KEY = 'dequss:reviews';
const MAX_STORED = 300;
const MAX_PER_HOUR = 3;

// Busca las credenciales de Upstash sin importar el prefijo que haya puesto Vercel
// (KV_REST_API_URL, STORAGE_KV_REST_API_URL, UPSTASH_REDIS_REST_URL, etc.).
function redisConfig() {
  const env = process.env;
  const names = Object.keys(env);
  const pick = (re, exclude) => {
    const n = names.find((k) => re.test(k) && !(exclude && exclude.test(k)) && env[k]);
    return n ? env[n] : null;
  };
  const url = pick(/(REST_API_URL|REDIS_REST_URL)$/);
  const token = pick(/(REST_API_TOKEN|REDIS_REST_TOKEN)$/, /READ_ONLY/);
  return url && token && /^https:\/\//.test(url) ? { url: url.replace(/\/$/, ''), token } : null;
}

async function redis(cfg, command) {
  const r = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || 'Redis error');
  return data.result;
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readList(raw) {
  return (raw || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = redisConfig();
  if (!cfg) {
    if (req.method === 'GET') return res.status(200).json({ reviews: [], configured: false });
    return res.status(503).json({ error: 'Las reseñas todavía no están activadas.' });
  }

  try {
    if (req.method === 'GET') {
      const raw = await redis(cfg, ['LRANGE', KEY, '0', '99']);
      return res.status(200).json({ reviews: readList(raw) });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};

      // Trampa para bots: campo oculto que una persona nunca completa.
      if (body.web) return res.status(200).json({ ok: true, review: null });

      const nombre = clean(body.nombre, 60);
      const marca = clean(body.marca, 60);
      const texto = clean(body.texto, 600);
      const estrellas = Math.round(Number(body.estrellas));

      if (nombre.length < 2) return res.status(400).json({ error: 'Escribí tu nombre.' });
      if (!(estrellas >= 1 && estrellas <= 5)) return res.status(400).json({ error: 'Elegí una puntuación de 1 a 5 estrellas.' });
      if (texto.length < 10) return res.status(400).json({ error: 'Contanos un poco más (mínimo 10 caracteres).' });
      if (/(https?:\/\/|www\.)/i.test(texto + ' ' + nombre)) return res.status(400).json({ error: 'Las reseñas no pueden incluir links.' });

      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anon').split(',')[0].trim();
      const rlKey = 'dequss:rl:' + ip;
      const count = await redis(cfg, ['INCR', rlKey]);
      if (count === 1) await redis(cfg, ['EXPIRE', rlKey, '3600']);
      if (count > MAX_PER_HOUR) return res.status(429).json({ error: 'Ya enviaste varias reseñas. Probá de nuevo más tarde.' });

      const review = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        nombre, marca, estrellas, texto,
        fecha: new Date().toISOString()
      };
      await redis(cfg, ['LPUSH', KEY, JSON.stringify(review)]);
      await redis(cfg, ['LTRIM', KEY, '0', String(MAX_STORED - 1)]);
      return res.status(201).json({ ok: true, review });
    }

    if (req.method === 'DELETE') {
      const admin = process.env.ADMIN_KEY;
      if (!admin || req.headers['x-admin-key'] !== admin) return res.status(401).json({ error: 'No autorizado.' });
      const id = String((req.query && req.query.id) || '');
      const raw = await redis(cfg, ['LRANGE', KEY, '0', '-1']);
      const target = (raw || []).find((s) => { try { return JSON.parse(s).id === id; } catch (e) { return false; } });
      if (!target) return res.status(404).json({ error: 'No encontré esa reseña.' });
      await redis(cfg, ['LREM', KEY, '1', target]);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'Método no permitido.' });
  } catch (e) {
    return res.status(500).json({ error: 'No pudimos procesar la reseña. Probá de nuevo en un rato.' });
  }
};
