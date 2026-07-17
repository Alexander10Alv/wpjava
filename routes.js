const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  createSession,
  getSession,
  checkAccess,
  touch,
  saveOutbox,
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
  const bodyStr = JSON.stringify({ chats });
  const vacios = chats.filter(c => !c.lastMessage).length;
  console.log('[chats] Devolviendo', chats.length, 'chats:', chats.map(c => ({ id: c.id, name: c.name, lastMsg: c.lastMessage })));
  console.log(`[debug3] GET /chats: ${chats.length} chats, ${Buffer.byteLength(bodyStr)} bytes, vacios: ${vacios}`);
  res.json({ chats });
});

router.post('/markAsRead/:userId/:chatId', auth, (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }
  const chat = session.chats.get(chatId);
  if (chat) {
    chat.unreadCount = 0;
    session.chats.set(chatId, chat);
  }
  res.json({ ok: true });
});

router.get('/messages/:userId/:chatId', auth, (req, res) => {
  const session = getSession(req.params.userId);
  const rawChatId = req.params.chatId;
  let normChatId = rawChatId;
  if (!normChatId.includes('@')) {
    normChatId = normChatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (normChatId.endsWith('@lid') && session.lidCache[normChatId]) {
    normChatId = session.lidCache[normChatId] + '@s.whatsapp.net';
  }
  const all = session.messages.get(normChatId) || [];
  console.log('[messages] Solicitado rawChatId:', rawChatId, '-> normChatId:', normChatId, 'total msgs:', all.length);
  const page = parseInt(req.query.page || '0', 10);
  const pageSize = 10;
  const start = Math.max(all.length - pageSize * (page + 1), 0);
  const end = all.length - pageSize * page;
  const messages = all.slice(start, end).map(({ raw, ...m }) => m);
  console.log('[messages] Devolviendo page', page, 'slice', start, '-', end, '=', messages.length, 'mensajes');
  res.json({ messages, hasMore: start > 0 });
});

router.post('/send', async (req, res) => {
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

  // Crear entrada de chat inmediatamente para que aparezca en GET /chats sin esperar a Baileys
  if (session && !session.chats.has(jid)) {
    session.chats.set(jid, { name: 'No conocido', lastMessage: '', lastTimestamp: Date.now(), unreadCount: 0 });
  }

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
    console.log('[send] Enviando a jid:', jid);
    const sent = await session.sock.sendMessage(jid, { text: message });
    console.log('[send] sendMessage OK, sent.key:', JSON.stringify(sent?.key));

    // Agregar mensaje a la lista inmediatamente (no esperar messages.upsert)
    const msgEntry = {
      id: sent?.key?.id || 'pending_' + Date.now(),
      fromMe: true,
      text: message,
      type: 'text',
      timestamp: Math.floor(Date.now() / 1000),
    };
    if (!session.messages.has(jid)) session.messages.set(jid, []);
    const msgs = session.messages.get(jid);
    if (!msgs.find(m => m.id === msgEntry.id)) {
      msgs.push(msgEntry);
      if (msgs.length > 10) msgs.shift();
    }

    // Actualizar chat con el último mensaje
    const chat = session.chats.get(jid);
    if (chat) {
      chat.lastMessage = message;
      chat.lastTimestamp = msgEntry.timestamp * 1000;
    }

    console.log('[send] messages ahora tiene', session.messages.get(jid)?.length, 'mensajes para', jid);
    console.log('[send] chat ahora es:', JSON.stringify(session.chats.get(jid)));

    touch(userId);
    res.json({ ok: true, id: sent?.key?.id || null });
  } catch (err) {
    console.error(err);
    saveOutbox(userId, jid, message);
    console.log(`[send] Encolado tras error para ${jid}`);
    res.json({ queued: true, message: 'Mensaje encolado tras error de envio' });
  }
});

module.exports = router;

// GET /presence/:userId/:chatId?code=XXX
// Devuelve si el otro esta escribiendo en ese chat
router.get('/presence/:userId/:chatId', auth, async (req, res) => {
  const session = getSession(req.params.userId);
  let chatId = req.params.chatId;
  if (!chatId.includes('@')) {
    chatId = chatId.replace(/\D/g, '') + '@s.whatsapp.net';
  } else if (chatId.endsWith('@lid') && session.lidCache[chatId]) {
    chatId = session.lidCache[chatId] + '@s.whatsapp.net';
  }

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
    const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
    let normChatId = chatId;
    if (!normChatId.includes('@')) {
      normChatId = normChatId.replace(/\D/g, '') + '@s.whatsapp.net';
    } else if (normChatId.endsWith('@lid') && session.lidCache && session.lidCache[normChatId]) {
      normChatId = session.lidCache[normChatId] + '@s.whatsapp.net';
    }
    const messages = session.messages.get(normChatId) || [];
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

      // Intentar convertir OGG -> MP3 con ffmpeg (más compatible que AMR)
      try {
        console.log('[media] Intentando conversion ffmpeg...');
        const { execSync } = require('child_process');
        const mp3Path = fspath.join(mediaDir, req.params.messageId + '.mp3');
        execSync(`ffmpeg -y -i "${oggPath}" -ar 22050 -ac 1 -b:a 32k "${mp3Path}"`, { timeout: 15000 });
        buffer = fs.readFileSync(mp3Path);
        console.log('[media] Conversion exitosa, MP3 size:', buffer.length, 'bytes');
        if (buffer.length > 300 * 1024) return res.json({ error: 'Audio muy grande', tooLarge: true });
        const base64 = buffer.toString('base64');
        return res.json({ data: 'data:audio/mpeg;base64,' + base64, type: 'audio' });
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
