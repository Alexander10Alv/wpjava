const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  createSession,
  getSession,
  checkAccess,
  touch,
  saveOutbox,
  setReconnectPaused,
  sendWithTimeout,
} = require('./sessionManager');

const fs = require('fs');
const path = require('path');

const chatsPath = path.join(__dirname, 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'chats.js');
const chatsContent = fs.readFileSync(chatsPath, 'utf8');
const tienePatch = chatsContent.includes('Deshabilitado: buildTcTokenFromJid');

console.log('=====================================');
console.log('[VERIFICACION PATCH] chats.js tiene el parche aplicado:', tienePatch);
console.log('=====================================');

const router = express.Router();

// ============================================================
// Emergencia: pausa/reactiva las reconexiones automaticas de Baileys
// SIN reiniciar el proceso. Protegido por EMERGENCY_TOKEN en env.
// Uso: GET /admin/pause?token=...&v=1   (v=1 pausa, v=0 reactiva)
// Si EMERGENCY_TOKEN no esta definido, el endpoint esta deshabilitado.
// ============================================================
router.get('/admin/pause', (req, res) => {
  const token = process.env.EMERGENCY_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Emergency suspend deshabilitado (EMERGENCY_TOKEN no configurado)' });
  }
  const reqToken = req.query.token || '';
  if (reqToken !== token) {
    return res.status(403).json({ error: 'Token invalido' });
  }
  const v = req.query.v;
  if (v !== '1' && v !== '0') {
    return res.status(400).json({ error: 'Parametro v invalido (use v=1 para pausar, v=0 para reactivar)' });
  }
  setReconnectPaused(v === '1');
  console.log(`[admin] Reconexiones ${v === '1' ? 'PAUSADAS' : 'REACTIVADAS'} manualmente`);
  res.json({ ok: true, pausado: v === '1' });
});

router.post('/link', async (req, res) => {
  const userId = uuidv4();
  console.log(`[link] Request: creando sesion userId=${userId}`);
  try {
    await createSession(userId);
    console.log(`[link] Sesion creada userId=${userId}`);
    res.json({ userId, message: 'Sesion creada.' });
  } catch (err) {
    if (err.message === 'LIMIT_REACHED') {
      console.log(`[link] LIMIT_REACHED userId=${userId}`);
      return res.status(503).json({ error: 'La aplicacion esta en modo beta y ya alcanzo el limite de usuarios registrados. Intenta mas tarde.' });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar la sesion' });
  }
});

router.get('/status/:userId', (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) {
    console.log(`[status] Poll userId=${req.params.userId} -> SESION NO ENCONTRADA`);
    return res.status(404).json({ error: 'Sesion no encontrada' });
  }
  const hasQr = session.status === 'waiting_qr' && !!session.qr;
  console.log(`[status] Poll userId=${req.params.userId} -> status=${session.status} qr=${hasQr ? 'SI' : 'NO'}`);
  res.json({
    status: session.status,
    qr: session.status === 'waiting_qr' ? session.qr : null,
    accessCode: session.status === 'connected' ? session.accessCode : null,
  });
});

// J2ME no soporta emojis ni chars fuera de Latin-1 — limpiar nombres
function sanitizeForJ2ME(name) {
  return name ? name.replace(/[^\x20-\xFF]/g, '').trim() : name;
}

function auth(req, res, next) {
  const { userId } = req.params;
  const code = req.query.code || req.headers['x-access-code'];
  if (!checkAccess(userId, code)) {
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  touch(userId);
  next();
}

// GET /contacts/:userId?code=XXX&page=0 — lista de contactos de Baileys, 12 por pagina
router.get('/contacts/:userId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 12;
  const db = require('./db');

  const contacts = session.contacts || {};
  const totalRaw = Object.keys(contacts).length;

  // Construir array desde Baileys
  const all = [];
  for (const jid in contacts) {
    const c = contacts[jid];
    const name = c.name || c.notify || null;
    if (!name) continue;
    if (!jid.endsWith('@s.whatsapp.net')) continue;
    const phone = jid.replace('@s.whatsapp.net', '');
    all.push({ id: jid, name: sanitizeForJ2ME(name), phone: phone });
  }

  if (all.length > 0) {
    // Guardar/actualizar en BD como respaldo (upsert)
    try {
      for (const contact of all) {
        await db.query(
          `INSERT INTO contacts (userId, contactId, name, phone)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone)`,
          [req.params.userId, contact.id, contact.name, contact.phone]
        );
      }
    } catch (dbErr) {
      console.error('[contacts] Error guardando en BD:', dbErr.message);
    }
  } else {
    // Baileys no tiene contactos — usar respaldo de BD
    try {
      const dbContacts = await db.query(
        `SELECT contactId AS id, name, phone FROM contacts WHERE userId=? ORDER BY name ASC`,
        [req.params.userId]
      );
      const total = dbContacts.length;
      const offset = page * pageSize;
      const slice = dbContacts.slice(offset, offset + pageSize);
      const hasMore = offset + pageSize < total;
      return res.json({ contacts: slice, hasMore, page, total });
    } catch (dbErr) {
      console.error('[contacts] Error leyendo BD:', dbErr.message);
      return res.json({ contacts: [], hasMore: false, page, total: 0 });
    }
  }

  all.sort(function(a, b) {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  const total = all.length;
  const offset = page * pageSize;
  const slice = all.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < total;
  res.json({ contacts: slice, hasMore: hasMore, page: page, total: total });
});

router.get('/chats/:userId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  const offset = page * pageSize;
  try {
    const chats = await require('./db').query(
      `SELECT chatId AS id, name, lastMessage, lastTimestamp, unreadCount
       FROM chats WHERE userId=?
       AND (name != 'No conocido' OR (lastMessage IS NOT NULL AND lastMessage != ''))
       ORDER BY lastTimestamp DESC LIMIT ? OFFSET ?`,
      [req.params.userId, pageSize, offset]
    );
    const countRows = await require('./db').query(
      `SELECT COUNT(*) AS total FROM chats WHERE userId=?
       AND (name != 'No conocido' OR (lastMessage IS NOT NULL AND lastMessage != ''))`,
      [req.params.userId]
    );
    const total = countRows[0].total;
    const hasMore = offset + pageSize < total;
    const respBody = JSON.stringify({ chats, hasMore, page, total });
    res.json({ chats, hasMore, page, total });
  } catch (err) {
    console.error('[chats] DB error:', err.message);
    res.status(500).json({ error: 'Error DB' });
  }
});

router.post('/markAsRead/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }
  const db = require('./db');
  try {
    await db.query(
      'UPDATE chats SET unreadCount=0 WHERE userId=? AND chatId=?',
      [req.params.userId, chatId]
    );
  } catch (_) {}
  // Marcar como leído en WhatsApp solo para chats personales
  if (session?.sock && chatId.endsWith('@s.whatsapp.net')) {
    try {
      const unread = await db.query(
        'SELECT messageId FROM messages WHERE userId=? AND chatId=? AND fromMe=0 AND ack < 4',
        [req.params.userId, chatId]
      );
      if (unread.length > 0) {
        const keys = unread.map(m => ({ remoteJid: chatId, id: m.messageId }));
        await session.sock.readMessages(keys).catch(() => {});
      }
    } catch (_) {}
  }
  res.json({ ok: true });
});

router.get('/messages/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const rawChatId = req.params.chatId;
  let normChatId = rawChatId;
  if (!normChatId.includes('@')) {
    normChatId = normChatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (normChatId.endsWith('@lid') && session.lidCache[normChatId]) {
    normChatId = session.lidCache[normChatId] + '@s.whatsapp.net';
  }
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  try {
    const db = require('./db');
    // Total de mensajes para este chat
    const countRows = await db.query(
      'SELECT COUNT(*) AS total FROM messages WHERE userId=? AND chatId=?',
      [req.params.userId, normChatId]
    );
    const total = countRows[0].total;
    // Paginación hacia atrás: page=0 → últimos 10, page=1 → 10 anteriores
    const offset = Math.max(0, total - pageSize * (page + 1));
    const limit = Math.min(pageSize, total - pageSize * page);
    const messages = await db.query(
      `SELECT messageId AS id, fromMe, text, type, timestamp, pushName, ack, quoted, duration
       FROM messages WHERE userId=? AND chatId=?
       ORDER BY timestamp ASC LIMIT ? OFFSET ?`,
      [req.params.userId, normChatId, limit, offset]
    );
    // Convertir fromMe de tinyint a boolean
    const mapped = messages.map(m => ({ ...m, fromMe: !!m.fromMe, pushName: sanitizeForJ2ME(m.pushName) }));
    const hasMore = offset > 0;
    res.json({ messages: mapped, hasMore });
  } catch (err) {
    console.error('[messages] DB error:', err.message);
    res.status(500).json({ error: 'Error DB' });
  }
});

router.post('/send', async (req, res) => {
  const { userId, code, chatId, message } = req.body || {};

  if (!userId || !chatId || !message) {
    return res.status(400).json({ error: 'Faltan campos: userId, chatId, message' });
  }
  if (!checkAccess(userId, code)) {
    console.log('[send] 401 - checkAccess falló, userId:', userId);
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  const session = getSession(userId);

  // Normalizar chatId: si viene como +51xxx o 51xxx, convertir a JID de WhatsApp
  let jid = chatId;
  if (!jid.includes('@')) {
    const digits = jid.replace(/\D/g, '');
    jid = digits + '@s.whatsapp.net';
  }
  // Normalizar @lid a @s.whatsapp.net
  if (jid.endsWith('@lid') && session && session.lidCache && session.lidCache[jid]) {
    jid = session.lidCache[jid] + '@s.whatsapp.net';
  }

  // Crear entrada de chat en DB si no existe
  const db = require('./db');
  try {
    await db.query(
      `INSERT IGNORE INTO chats (userId, chatId, name, lastMessage, lastTimestamp, unreadCount)
       VALUES (?, ?, 'No conocido', '', ?, 0)`,
      [userId, jid, Date.now()]
    );
  } catch (_) {}

  if (!session || session.status !== 'connected') {
    saveOutbox(userId, jid, message);
    console.log(`[send] Encolado para ${jid}`);
    return res.json({ queued: true, message: 'Mensaje encolado, se enviara cuando la sesion reconecte' });
  }

  try {
    // Resolver JID canónico para evitar crash #1785
    try {
      const [wa] = await session.sock.onWhatsApp(jid);
      if (wa?.exists && wa?.jid) jid = wa.jid;
    } catch (_) {}
    const sent = await sendWithTimeout(session.sock, jid, { text: message });

    const msgEntry = {
      id: sent?.key?.id || 'pending_' + Date.now(),
      fromMe: true,
      text: message,
      type: 'text',
      timestamp: Math.floor(Date.now() / 1000),
    };

    // Guardar mensaje en DB
    await db.query(
      `INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp)
       VALUES (?, ?, ?, 1, ?, 'text', ?)`,
      [userId, jid, msgEntry.id, message, msgEntry.timestamp]
    );
    // Actualizar chat con último mensaje
    await db.query(
      `UPDATE chats SET lastMessage=?, lastTimestamp=? WHERE userId=? AND chatId=?`,
      [message, msgEntry.timestamp * 1000, userId, jid]
    );

    touch(userId);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (err) {
    console.error(err);
    saveOutbox(userId, jid, message);
    console.log(`[send] Encolado tras error para ${jid}`);
    res.json({ queued: true, message: 'Mensaje encolado tras error de envio' });
  }
});

router.get('/myphoto/:userId', auth, async (req, res) => {
  const userId = req.params.userId;
  const accessCode = req.query.code || req.headers['x-access-code'];
  
  
  const session = getSession(userId);
  
  if (!session) {
    return res.json({ photo: null });
  }
  
  
  try {
    // Obtener URL fresca cada vez para reflejar cambios de foto
    const myJid = session.sock?.user?.id;
    
    if (!myJid) {
      return res.json({ photo: null });
    }
    
    let photoUrl = null;
    try {
      photoUrl = await session.sock.profilePictureUrl(myJid, 'image');
    } catch (profileErr) {
    }
    
    if (!photoUrl) {
      return res.json({ photo: null });
    }

    const https = require('https');
    const http = require('http');
    const client = photoUrl.startsWith('https') ? https : http;
    
    client.get(photoUrl, (imgRes) => {
      const chunks = [];
      imgRes.on('data', c => {
        chunks.push(c);
      });
      imgRes.on('end', async () => {
        let buf = Buffer.concat(chunks);
        
        try {
          const sharp = require('sharp');
          const size = 28;
          const r = size / 2;
          const raw = await sharp(buf)
            .resize(size, size, { fit: 'cover' })
            .raw()
            .ensureAlpha()
            .toBuffer();
          
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const dx = x - r, dy = y - r;
              if (dx * dx + dy * dy > r * r) {
                const i = (y * size + x) * 4;
                raw[i] = 7; raw[i+1] = 94; raw[i+2] = 84; raw[i+3] = 255;
              }
            }
          }
          
          buf = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
          
          const base64 = buf.toString('base64');
          
          res.json({ photo: 'data:image/png;base64,' + base64 });
        } catch (sharpErr) {
          res.json({ photo: null });
        }
      });
    }).on('error', (httpErr) => {
      res.json({ photo: null });
    });
  } catch (catchErr) {
    res.json({ photo: null });
  }
});

// POST /logout/:userId?code=XXX — cierra sesion, borra datos del servidor y BD
router.post('/logout/:userId', auth, async (req, res) => {
  const userId = req.params.userId;
  const session = getSession(userId);
  const fs = require('fs');
  const path = require('path');
  const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';

  try {
    if (session) {
      try { session.sock.end(undefined); } catch (_) {}
      const { sessions } = require('./sessionManager');
      sessions.delete(userId);
    }
    // Borrar archivos de sesion
    const userDir = path.join(SESSIONS_DIR, userId);
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
    // Borrar de BD
    const db = require('./db');
    await db.query('DELETE FROM sessions WHERE userId=?', [userId]);
    await db.query('DELETE FROM chats WHERE userId=?', [userId]);
    await db.query('DELETE FROM messages WHERE userId=?', [userId]);
    console.log(`[logout] Sesion ${userId} eliminada completamente`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[logout] Error:', err.message);
    res.status(500).json({ error: 'Error cerrando sesion' });
  }
});

// GET /mediadoc/:userId/:messageId?code=XXX — sirve documento para descarga via navegador
router.get('/mediadoc/:userId/:messageId', auth, async (req, res) => {
  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;
  // Buscar archivo que empiece con msgId + '_'
  try {
    const files = fs.readdirSync(mediaDir);
    const match = files.find(f => f.startsWith(msgId + '_'));
    if (!match) return res.status(404).json({ error: 'Documento no disponible' });
    const filePath = fspath.join(mediaDir, match);
    const fileName = match.substring(msgId.length + 1); // nombre original
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(fs.readFileSync(filePath));
  } catch (err) {
    res.status(500).json({ error: 'Error sirviendo documento' });
  }
});

// GET /mediaoriginal/:userId/:messageId?code=XXX — sirve imagen original sin redimensionar
router.get('/mediaoriginal/:userId/:messageId', auth, async (req, res) => {
  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;
  const jpgPath = fspath.join(mediaDir, msgId + '.jpg');
  if (!fs.existsSync(jpgPath)) return res.status(404).json({ error: 'Imagen no disponible' });
  const buffer = fs.readFileSync(jpgPath);
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Content-Disposition', 'attachment; filename="' + msgId + '.jpg"');
  res.send(buffer);
});

// POST /sendimage/:userId?code=XXX&chatId=XXX — recibe imagen JPEG y la envia por WhatsApp
router.post('/sendimage/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;
  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });
  const session = getSession(userId);
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'Sesion no conectada' });
  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const imgBuffer = Buffer.concat(chunks);
      if (imgBuffer.length === 0) return res.status(400).json({ error: 'Imagen vacia' });
      let jid = chatId;
      if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      if (jid.endsWith('@lid') && session.lidCache?.[jid]) jid = session.lidCache[jid] + '@s.whatsapp.net';
      try { const [wa] = await session.sock.onWhatsApp(jid); if (wa?.exists && wa?.jid) jid = wa.jid; } catch (_) {}
      const sent = await sendWithTimeout(session.sock, jid, { image: imgBuffer, mimetype: 'image/jpeg' });
      const msgId = sent?.key?.id || ('img_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '.jpg'), imgBuffer);
      } catch (_) {}
      await db.query(`INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp) VALUES (?, ?, ?, 1, '[imagen]', 'image', ?)`, [userId, jid, msgId, ts]);
      await db.query(`UPDATE chats SET lastMessage='[imagen]', lastTimestamp=? WHERE userId=? AND chatId=?`, [ts * 1000, userId, jid]);
      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[sendimage] Error:', err.message);
      res.status(500).json({ error: 'Error enviando imagen: ' + err.message });
    }
  });
});

// POST /senddoc/:userId?code=XXX&chatId=XXX&fileName=XXX — recibe archivo y lo envia como documento
router.post('/senddoc/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;
  const fileName = req.query.fileName || 'archivo';
  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });
  const session = getSession(userId);
  if (!session || session.status !== 'connected') return res.status(503).json({ error: 'Sesion no conectada' });
  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const docBuffer = Buffer.concat(chunks);
      if (docBuffer.length === 0) return res.status(400).json({ error: 'Archivo vacio' });
      let jid = chatId;
      if (!jid.includes('@')) jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      if (jid.endsWith('@lid') && session.lidCache?.[jid]) jid = session.lidCache[jid] + '@s.whatsapp.net';
      try { const [wa] = await session.sock.onWhatsApp(jid); if (wa?.exists && wa?.jid) jid = wa.jid; } catch (_) {}
      const sent = await sendWithTimeout(session.sock, jid, {
        document: docBuffer,
        fileName: fileName,
        mimetype: 'application/octet-stream',
      });
      const msgId = sent?.key?.id || ('doc_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);
      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '_' + safeFileName), docBuffer);
      } catch (_) {}
      await db.query(`INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp) VALUES (?, ?, ?, 1, ?, 'document', ?)`, [userId, jid, msgId, '[doc:' + fileName + ']', ts]);
      await db.query(`UPDATE chats SET lastMessage=?, lastTimestamp=? WHERE userId=? AND chatId=?`, ['[doc:' + fileName + ']', ts * 1000, userId, jid]);
      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[senddoc] Error:', err.message);
      res.status(500).json({ error: 'Error enviando documento: ' + err.message });
    }
  });
});

// POST /sendaudio/:userId?code=XXX&chatId=XXX — recibe audio AMR crudo y lo envia por WhatsApp
router.post('/sendaudio/:userId', async (req, res) => {
  const userId = req.params.userId;
  const code = req.query.code || req.headers['x-access-code'];
  const chatId = req.query.chatId;

  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });
  if (!checkAccess(userId, code)) return res.status(401).json({ error: 'Codigo de acceso invalido' });

  const session = getSession(userId);
  if (!session || session.status !== 'connected') {
    return res.status(503).json({ error: 'Sesion no conectada' });
  }

  const fspath = require('path');
  const fs = require('fs');
  const db = require('./db');

  // Leer body como buffer (audio/amr raw)
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const audioBuffer = Buffer.concat(chunks);
      console.log(`[sendaudio] REQUEST userId=${userId} chatId=${chatId} bytes=${audioBuffer.length}`);
      if (audioBuffer.length === 0) return res.status(400).json({ error: 'Audio vacio' });
      if (audioBuffer.length > 300 * 1024) return res.status(400).json({ error: 'Audio muy grande (max 300KB)' });

      // Normalizar chatId
      let jid = chatId;
      if (!jid.includes('@')) {
        jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
      }
      if (jid.endsWith('@lid') && session.lidCache && session.lidCache[jid]) {
        jid = session.lidCache[jid] + '@s.whatsapp.net';
      }
      console.log(`[sendaudio] JID normalizado: ${jid}`);

      // Resolver JID canonico
      try {
        const [wa] = await session.sock.onWhatsApp(jid);
        if (wa?.exists && wa?.jid) jid = wa.jid;
      } catch (_) {}

      // Convertir AMR a OGG/Opus con ffmpeg (requerido por WhatsApp para reproduccion correcta)
      const os = require('os');
      const crypto = require('crypto');
      const tmpId = crypto.randomBytes(8).toString('hex');
      const tmpAmr = fspath.join(os.tmpdir(), tmpId + '.amr');
      const tmpOgg = fspath.join(os.tmpdir(), tmpId + '.ogg');
      fs.writeFileSync(tmpAmr, audioBuffer);

      let oggBuffer = null;
      let durationSec = 0;
      try {
        const { execSync } = require('child_process');
        const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
        execSync(`"${ffmpegBin}" -y -i "${tmpAmr}" -avoid_negative_ts make_zero -ar 48000 -ac 1 -c:a libopus -b:a 32k -application voip -frame_duration 20 "${tmpOgg}"`, { timeout: 20000 });
        oggBuffer = fs.readFileSync(tmpOgg);
        // Calcular duracion aproximada del audio original
        const durationOut = execSync(`"${ffmpegBin}" -i "${tmpAmr}" 2>&1 || true`).toString();
        const durMatch = durationOut.match(/Duration:\s*(\d+):(\d+):(\d+)/);
        if (durMatch) {
          durationSec = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
        }
      } catch (convErr) {
        console.error('[sendaudio] ffmpeg conversion error:', convErr.message);
        // Fallback: intentar enviar AMR directo si ffmpeg falla
        oggBuffer = audioBuffer;
      } finally {
        try { fs.unlinkSync(tmpAmr); } catch (_) {}
      }
      console.log(`[sendaudio] Conversion AMR(${audioBuffer.length}B) -> OGG(${oggBuffer.length}B) dur=${durationSec}s`);
      console.log(`[sendaudio] tmpOgg existe antes de enviar: ${fs.existsSync(tmpOgg)}`);

      // Enviar audio como PTT (nota de voz) con OGG/Opus desde buffer directo
      const sent = await sendWithTimeout(session.sock, jid, {
        audio: oggBuffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        seconds: durationSec || 1,
      });
      console.log(`[sendaudio] ENVIADO ok msgId=${sent?.key?.id} jid=${jid}`);
      try { fs.unlinkSync(tmpOgg); } catch (_) {}

      const msgId = sent?.key?.id || ('voice_' + Date.now());
      const ts = Math.floor(Date.now() / 1000);

      // Guardar OGG en disco para /media
      try {
        const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', userId, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(fspath.join(mediaDir, msgId + '.ogg'), oggBuffer);
        console.log(`[sendaudio] OGG guardado en disco: ${msgId}.ogg (${oggBuffer.length}B)`);
      } catch (_) {}

      // Guardar en DB
      await db.query(
        `INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp, duration)
         VALUES (?, ?, ?, 1, '[audio]', 'audio', ?, ?)`,
        [userId, jid, msgId, ts, durationSec || 0]
      );
      await db.query(
        `UPDATE chats SET lastMessage='[audio]', lastTimestamp=? WHERE userId=? AND chatId=?`,
        [ts * 1000, userId, jid]
      );

      touch(userId);
      res.json({ ok: true, id: msgId });
    } catch (err) {
      console.error('[sendaudio] Error:', err.message);
      if (err && err.stack) console.error('[sendaudio] Stack:', err.stack);
      res.status(500).json({ error: 'Error enviando audio: ' + err.message });
    }
  });
});

module.exports = router;

// GET /contactphoto/:userId/:chatId?code=XXX — foto de perfil de un contacto, recortada circular
router.get('/contactphoto/:userId/:chatId', auth, async (req, res) => {
  const userId = req.params.userId;
  const chatIdParam = req.params.chatId;
  const accessCode = req.query.code || req.headers['x-access-code'];
  const full = req.query.full === '1'; // si full=1, devolver foto sin recortar
  
  
  const session = getSession(userId);
  console.log(`[contactphoto] userId=${userId} chatId=${chatIdParam} full=${full} status=${session?.status || 'NO_SESSION'}`);

  if (!session?.sock) {
    console.log(`[contactphoto] RESP null — sin sock userId=${userId}`);
    return res.json({ photo: null, error: 'No socket' });
  }
  
  let jid = chatIdParam;
  
  if (!jid.includes('@')) {
    jid = jid.replace(/\D/g, '') + '@s.whatsapp.net';
  }
  
  if (jid.endsWith('@lid') && session.lidCache?.[jid]) {
    const originalJid = jid;
    jid = session.lidCache[jid] + '@s.whatsapp.net';
  } else if (jid.endsWith('@lid')) {
  }
  
  
try {
    // Timeout de 8s para evitar bug #2498 de Baileys
    let photoUrl = null;
    try {
      const picType = full ? 'image' : 'preview';
      console.log(`[contactphoto] profilePictureUrl jid=${jid} type=${picType}`);
      photoUrl = await Promise.race([
        session.sock.profilePictureUrl(jid, picType),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
      ]);
      console.log(`[contactphoto] profilePictureUrl OK jid=${jid} url=${photoUrl ? 'SI(' + photoUrl.length + ')' : 'NO'}`);
    } catch (e) {
      console.log(`[contactphoto] profilePictureUrl ERROR jid=${jid} msg=${e?.message}`);
    }

    if (!photoUrl) {
      console.log(`[contactphoto] RESP null — sin URL jid=${jid}`);
      return res.json({ photo: null });
    }

    const https = require('https');
    const http = require('http');
    const client = photoUrl.startsWith('https') ? https : http;
    
    client.get(photoUrl, (imgRes) => {
      const chunks = [];
      imgRes.on('data', c => {
        chunks.push(c);
      });
      imgRes.on('end', async () => {
        let buf = Buffer.concat(chunks);
        try {
          const sharp = require('sharp');
          if (full) {
            // Foto completa: redimensionar a 240x320 (pantalla Nokia) con cover para llenar
            buf = await sharp(buf)
              .resize(240, 320, { fit: 'cover', position: 'centre' })
              .jpeg({ quality: 80 })
              .toBuffer();
            const base64full = buf.toString('base64');
            console.log(`[contactphoto] RESP full OK jid=${jid} bytes=${buf.length}`);
            return res.json({ photo: 'data:image/jpeg;base64,' + base64full });
          }
          const size = 30;
          const r = size / 2;
          const raw = await sharp(buf)
            .resize(size, size, { fit: 'cover' })
            .raw()
            .ensureAlpha()
            .toBuffer();
          
          // Color fondo verde del header para avatar contacto (0x075E54)
          for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
              const dx = x - r, dy = y - r;
              if (dx * dx + dy * dy > r * r) {
                const i = (y * size + x) * 4;
                raw[i] = 0x07; raw[i+1] = 0x5E; raw[i+2] = 0x54; raw[i+3] = 255;
              }
            }
          }
          
          buf = await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
          
          const base64 = buf.toString('base64');
          console.log(`[contactphoto] RESP preview OK jid=${jid} bytes=${buf.length}`);
          
          res.json({ photo: 'data:image/png;base64,' + base64 });
        } catch (sharpErr) {
          console.log(`[contactphoto] sharp ERROR jid=${jid} msg=${sharpErr?.message}`);
          res.json({ photo: null });
        }
      });
    }).on('error', (httpErr) => {
      console.log(`[contactphoto] descarga URL ERROR jid=${jid} msg=${httpErr?.message}`);
      res.json({ photo: null });
    });
  } catch (catchErr) {
    console.log(`[contactphoto] catch general ERROR jid=${jid} msg=${catchErr?.message}`);
    res.json({ photo: null });
  }
});

// GET /presence/:userId/:chatId?code=XXX
// Devuelve si el otro esta escribiendo, en linea, y su ultima conexion
router.get('/presence/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }
  try { await session.sock.presenceSubscribe(chatId); } catch (_) {}
  const data = session.presence?.get(chatId);
  const fresh = data && (Date.now() - data.timestamp < 15000);
  const isTyping = fresh && (data.typing || data.recording);
  const isOnline = fresh && data.online;
  let lastSeenFormatted = null;
  if (!isTyping && !isOnline && data?.lastSeen) {
    const diffMin = Math.floor((Date.now() / 1000 - data.lastSeen) / 60);
    if (diffMin < 1) lastSeenFormatted = 'hace instantes';
    else if (diffMin < 60) lastSeenFormatted = 'hace ' + diffMin + ' min';
    else if (diffMin < 1440) lastSeenFormatted = 'hace ' + Math.floor(diffMin / 60) + ' h';
    else lastSeenFormatted = 'hace ' + Math.floor(diffMin / 1440) + ' d';
  }
  res.json({ typing: !!isTyping, online: !!isOnline, lastSeen: lastSeenFormatted });
});

// GET /media/:userId/:messageId?code=XXX&chatId=XXX
// Imagenes: escala a 240x320 y devuelve base64
// Audios: sirve bytes directos con limite 300KB
router.get('/media/:userId/:messageId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const { chatId } = req.query;
  console.log(`[media] REQUEST msgId=${req.params.messageId} userId=${req.params.userId} chatId=${chatId}`);

  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });

  const fspath = require('path');
  const fs = require('fs');
  const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
  const msgId = req.params.messageId;

  try {
    // --- AUDIO: buscar en disco ---
    const amrPath = fspath.join(mediaDir, msgId + '.amr');
    const oggPath = fspath.join(mediaDir, msgId + '.ogg');
    const mp3Path = fspath.join(mediaDir, msgId + '.mp3');

    if (fs.existsSync(amrPath)) {
      const amrBuf = fs.readFileSync(amrPath);
      console.log(`[media] AUDIO AMR msgId=${msgId} bytes=${amrBuf.length} en base64`);
      return res.json({ data: 'data:audio/amr;base64,' + amrBuf.toString('base64'), type: 'audio' });
    }
    if (fs.existsSync(mp3Path)) {
      const buf = fs.readFileSync(mp3Path);
      console.log(`[media] AUDIO MP3 msgId=${msgId} bytes=${buf.length}`);
      if (buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
      return res.json({ data: 'data:audio/mpeg;base64,' + buf.toString('base64'), type: 'audio' });
    }
    if (fs.existsSync(oggPath)) {
      const buf = fs.readFileSync(oggPath);
      console.log(`[media] AUDIO OGG msgId=${msgId} bytes=${buf.length}, convirtiendo a MP3...`);
      if (buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
      try {
        const { execSync } = require('child_process');
        const ffmpegBin = process.env.FFMPEG_PATH || 'ffmpeg';
        execSync(`"${ffmpegBin}" -y -i "${oggPath}" -af "volume=2.5" -ar 22050 -ac 1 -b:a 32k "${mp3Path}"`, { timeout: 15000 });
        const mp3Buf = fs.readFileSync(mp3Path);
        if (mp3Buf.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        console.log(`[media] AUDIO OGG->MP3 ok msgId=${msgId} bytes=${mp3Buf.length}`);
        return res.json({ data: 'data:audio/mpeg;base64,' + mp3Buf.toString('base64'), type: 'audio' });
      } catch (convErr) {
        console.log(`[media] AUDIO OGG->MP3 fallo, devolviendo OGG:`, convErr.message);
        return res.json({ data: 'data:audio/ogg;base64,' + buf.toString('base64'), type: 'audio' });
      }
    }

    // --- IMAGEN: buscar en disco ---
    const jpgPath = fspath.join(mediaDir, msgId + '.jpg');
    if (fs.existsSync(jpgPath)) {
      let buffer = fs.readFileSync(jpgPath);
      try {
        const sharp = require('sharp');
        buffer = await sharp(buffer)
          .resize(240, 320, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
      } catch (_) {}
      return res.json({ data: 'data:image/jpeg;base64,' + buffer.toString('base64'), type: 'image' });
    }

    console.log('[media] Archivo no encontrado en disco para:', msgId, 'ts=' + Date.now());
    return res.status(404).json({ error: 'Media no disponible' });

  } catch (err) {
    console.error('[media] Error:', err);
    res.status(500).json({ error: 'No se pudo descargar el media' });
  }
});


