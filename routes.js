const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  createSession,
  getSession,
  checkAccess,
  touch,
} = require('./sessionManager');

const router = express.Router();

router.post('/link', async (req, res) => {
  const userId = uuidv4();
  try {
    await createSession(userId);
    res.json({ userId, message: 'Sesion creada.' });
  } catch (err) {
    if (err.message === 'LIMIT_REACHED') {
      return res.status(503).json({ error: 'La aplicacion esta en modo beta y ya alcanzo el limite de usuarios registrados. Intenta mas tarde.' });
    }
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar la sesion' });
  }
});

router.get('/status/:userId', (req, res) => {
  const session = getSession(req.params.userId);
  if (!session) return res.status(404).json({ error: 'Sesion no encontrada' });
  res.json({
    status: session.status,
    qr: session.status === 'waiting_qr' ? session.qr : null,
    accessCode: session.status === 'connected' ? session.accessCode : null,
  });
});

function auth(req, res, next) {
  const { userId } = req.params;
  const code = req.query.code || req.headers['x-access-code'];
  if (!checkAccess(userId, code)) {
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  touch(userId);
  next();
}

router.get('/chats/:userId', auth, (req, res) => {
  const session = getSession(req.params.userId);
  const chats = [...session.chats.entries()]
    .map(([id, c]) => ({ id, ...c, unreadCount: c.unreadCount || 0 }))
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp);
  res.json({ chats });
});

router.post('/markAsRead/:userId/:chatId', auth, (req, res) => {
  const session = getSession(req.params.userId);
  const chatId = req.params.chatId;
  const chat = session.chats.get(chatId);
  if (chat) {
    chat.unreadCount = 0;
    session.chats.set(chatId, chat);
  }
  res.json({ ok: true });
});

router.get('/messages/:userId/:chatId', auth, (req, res) => {
  const session = getSession(req.params.userId);
  const all = session.messages.get(req.params.chatId) || [];
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  const start = Math.max(all.length - pageSize * (page + 1), 0);
  const end = all.length - pageSize * page;
  const messages = all.slice(start, end).map(({ raw, ...m }) => m);
  res.json({ messages, hasMore: start > 0 });
});

router.post('/send', async (req, res) => {
  // DEBUG TEMPORAL - borrar cuando funcione
  console.log('[send] body:', JSON.stringify(req.body));
  console.log('[send] headers content-type:', req.headers['content-type']);

  const { userId, code, chatId, message } = req.body || {};

  console.log('[send] userId:', userId);
  console.log('[send] code:', code);
  console.log('[send] chatId:', chatId);

  if (!userId || !chatId || !message) {
    return res.status(400).json({ error: 'Faltan campos: userId, chatId, message' });
  }
  if (!checkAccess(userId, code)) {
    console.log('[send] 401 - checkAccess falló');
    const session = getSession(userId);
    console.log('[send] accessCode esperado:', session?.accessCode);
    return res.status(401).json({ error: 'Codigo de acceso invalido' });
  }
  const session = getSession(userId);
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Sesion no conectada' });
  }
  // Normalizar chatId: si viene como +51xxx o 51xxx, convertir a JID de WhatsApp
  let jid = chatId;
  if (!jid.includes('@')) {
    const digits = jid.replace(/\D/g, '');
    jid = digits + '@s.whatsapp.net';
  }
  try {
    const sent = await session.sock.sendMessage(jid, { text: message });
    touch(userId);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo enviar el mensaje' });
  }
});

module.exports = router;

// GET /presence/:userId/:chatId?code=XXX
// Devuelve si el otro esta escribiendo en ese chat
router.get('/presence/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const chatId = req.params.chatId;

  // Suscribirse a la presencia de ese chat (necesario para recibir updates)
  try {
    await session.sock.presenceSubscribe(chatId);
  } catch (_) {}

  const data = session.presence?.get(chatId);
  const isTyping = data && (Date.now() - data.timestamp < 15000) && data.typing;
  res.json({ typing: !!isTyping });
});

// GET /media/:userId/:messageId?code=XXX&chatId=XXX
// Imagenes: escala a 240x320 y devuelve base64
// Audios: sirve bytes directos con limite 300KB
router.get('/media/:userId/:messageId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  const { chatId } = req.query;
  console.log('[media] Request - userId:', req.params.userId, 'messageId:', req.params.messageId, 'chatId:', chatId);
  
  if (!chatId) return res.status(400).json({ error: 'Falta chatId' });

  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const messages = session.messages.get(chatId) || [];
    console.log('[media] Total messages in chat:', messages.length);
    
    const msg = messages.find(m => m.id === req.params.messageId);
    console.log('[media] Message found:', !!msg, 'has raw:', !!msg?.raw, 'type:', msg?.type);
    
    if (!msg || !msg.raw) return res.status(404).json({ error: 'Mensaje no encontrado' });

    const isAudio = msg.type === 'audio';
    console.log('[media] isAudio:', isAudio);

    if (isAudio) {
      const fspath = require('path');
      const fs = require('fs');
      const mediaDir = fspath.join(process.env.SESSIONS_DIR || './sessions', req.params.userId, 'media');
      const amrPath = fspath.join(mediaDir, req.params.messageId + '.amr');
      const oggPath = fspath.join(mediaDir, req.params.messageId + '.ogg');

      let buffer;

      // Si ya tenemos el AMR en disco, servirlo directo
      if (fs.existsSync(amrPath)) {
        console.log('[media] Sirviendo AMR cacheado');
        buffer = fs.readFileSync(amrPath);
        const base64 = buffer.toString('base64');
        return res.json({ data: 'data:audio/amr;base64,' + base64, type: 'audio' });
      }

      // Descargar OGG original
      if (!fs.existsSync(oggPath)) {
        console.log('[media] Descargando audio original...');
        buffer = await downloadMediaMessage(msg.raw, 'buffer', {});
        console.log('[media] Audio descargado, size:', buffer.length, 'bytes');
        if (buffer.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        fs.mkdirSync(mediaDir, { recursive: true });
        fs.writeFileSync(oggPath, buffer);
      }

      // Intentar convertir OGG -> AMR-NB con ffmpeg
      try {
        console.log('[media] Intentando conversion ffmpeg...');
        const { execSync } = require('child_process');
        execSync(`ffmpeg -y -i "${oggPath}" -ar 8000 -ac 1 -ab 12800 "${amrPath}"`, { timeout: 15000 });
        buffer = fs.readFileSync(amrPath);
        console.log('[media] Conversion exitosa, AMR size:', buffer.length, 'bytes');
        if (buffer.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        const base64 = buffer.toString('base64');
        return res.json({ data: 'data:audio/amr;base64,' + base64, type: 'audio' });
      } catch (ffmpegErr) {
        // ffmpeg no disponible, enviar OGG original
        console.log('[media] ffmpeg no disponible, enviando OGG original');
        buffer = fs.readFileSync(oggPath);
        if (buffer.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        const base64 = buffer.toString('base64');
        return res.json({ data: 'data:audio/ogg;base64,' + base64, type: 'audio' });
      }
    }

    // Imagen
    console.log('[media] Procesando imagen...');
    let buffer = await downloadMediaMessage(msg.raw, 'buffer', {});
    try {
      const sharp = require('sharp');
      buffer = await sharp(buffer)
        .resize(240, 320, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    } catch (sharpErr) { /* sharp no disponible */ }

    const base64 = buffer.toString('base64');
    res.json({ data: 'data:image/jpeg;base64,' + base64, type: 'image' });
  } catch (err) {
    console.error('[media] Error:', err);
    res.status(500).json({ error: 'No se pudo descargar el media' });
  }
});
