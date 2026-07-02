const path = require('path');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const SESSIONS_DIR = process.env.SESSIONS_DIR || './sessions';
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10);

const sessions = new Map();

function genAccessCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function cleanId(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@s.whatsapp.net')) return '+' + jid.replace('@s.whatsapp.net', '');
  if (jid.endsWith('@g.us')) return jid.replace('@g.us', '');
  return jid;
}

function saveMeta(userId, accessCode) {
  try {
    const metaPath = path.join(SESSIONS_DIR, userId, 'meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ accessCode }));
  } catch (_) {}
}

function loadMeta(userId) {
  try {
    const metaPath = path.join(SESSIONS_DIR, userId, 'meta.json');
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Cache de LIDs resueltos a numero real, persiste en disco
function loadLidCache(userId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, userId, 'lid_cache.json'), 'utf8'));
  } catch (_) { return {}; }
}

function saveLidCache(userId, cache) {
  try {
    fs.writeFileSync(path.join(SESSIONS_DIR, userId, 'lid_cache.json'), JSON.stringify(cache));
  } catch (_) {}
}

function saveChatsCache(userId, chats, messages) {
  try {
    const dir = path.join(SESSIONS_DIR, userId);
    const chatsObj = {};
    for (const [id, c] of chats.entries()) chatsObj[id] = c;
    fs.writeFileSync(path.join(dir, 'chats_cache.json'), JSON.stringify(chatsObj));
    // Guardar solo los ultimos 20 mensajes por chat para no llenar disco
    const msgsObj = {};
    for (const [id, msgs] of messages.entries()) msgsObj[id] = msgs.slice(-20).map(({ raw, ...m }) => m);
    fs.writeFileSync(path.join(dir, 'messages_cache.json'), JSON.stringify(msgsObj));
  } catch (_) {}
}

function loadChatsCache(userId) {
  try {
    const dir = path.join(SESSIONS_DIR, userId);
    const chatsObj = JSON.parse(fs.readFileSync(path.join(dir, 'chats_cache.json'), 'utf8'));
    const msgsObj = JSON.parse(fs.readFileSync(path.join(dir, 'messages_cache.json'), 'utf8'));
    const chats = new Map(Object.entries(chatsObj));
    const messages = new Map(Object.entries(msgsObj));
    return { chats, messages };
  } catch (_) {
    return { chats: new Map(), messages: new Map() };
  }
}

function touch(userId) {
  const s = sessions.get(userId);
  if (s) s.lastActivity = Date.now();
}

function activeCount() {
  return [...sessions.values()].filter(
    (s) => s.status === 'connected' || s.status === 'connecting' || s.status === 'waiting_qr'
  ).length;
}

async function createSession(userId) {
  if (sessions.has(userId)) {
    return sessions.get(userId);
  }

  if (activeCount() >= MAX_CONCURRENT_SESSIONS) {
    throw new Error('LIMIT_REACHED');
  }

  const userDir = path.join(SESSIONS_DIR, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(userDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  const savedMeta = loadMeta(userId);
  const lidCache = loadLidCache(userId);
  const { chats: cachedChats, messages: cachedMessages } = loadChatsCache(userId);

  const entry = {
    sock,
    contacts: {}, // contactos capturados manualmente
    lidCache,
    status: 'connecting',
    qr: null,
    accessCode: savedMeta.accessCode || null,
    chats: cachedChats,
    messages: cachedMessages,
    presence: new Map(), // chatId -> { typing: bool, timestamp }
    lastActivity: Date.now(),
    saveCreds,
  };
  sessions.set(userId, entry);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qr = await QRCode.toDataURL(qr);
      entry.status = 'waiting_qr';
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      if (!entry.accessCode) {
        entry.accessCode = genAccessCode();
      }
      saveMeta(userId, entry.accessCode);
      console.log(`[session] ${userId} conectado, code: ${entry.accessCode}`);
      touch(userId);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        sessions.delete(userId);
        fs.rmSync(userDir, { recursive: true, force: true });
        console.log(`[session] ${userId} cerro sesion, datos eliminados`);
      } else {
        entry.status = 'reconnecting';
        console.log(`[session] ${userId} desconectado, reintentando...`);
        setTimeout(() => {
          sessions.delete(userId);
          createSession(userId).catch((e) => console.error('Error reconectando', e));
        }, 3000);
      }
    }
  });

  // Capturar contactos de la agenda cuando Baileys los sincroniza
  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (c.id) entry.contacts[c.id] = c;
    }
  });

  // Resolver nombre de un jid usando contacts + lidCache
  function resolveName(jid) {
    if (!jid) return null;
    const contact = entry.contacts[jid];
    if (contact?.name) return contact.name;
    if (contact?.notify) return contact.notify;
    if (jid.endsWith('@lid') && lidCache[jid]) return lidCache[jid];
    return null;
  }

  // Intentar resolver @lid a numero real en background (sin bloquear)
  async function tryResolveLid(jid) {
    if (!jid.endsWith('@lid') || lidCache[jid]) return;
    try {
      const [result] = await sock.onWhatsApp(jid);
      if (result?.exists && result?.jid) {
        const numero = '+' + result.jid.replace('@s.whatsapp.net', '');
        lidCache[jid] = numero;
        saveLidCache(userId, lidCache);
        // Actualizar nombre en chats si ya existe
        if (entry.chats.has(jid)) {
          const chat = entry.chats.get(jid);
          if (!chat.name || chat.name === cleanId(jid)) {
            chat.name = numero;
          }
        }
      }
    } catch (_) {}
  }

  sock.ev.on('messaging-history.set', ({ chats }) => {
    for (const chat of chats) {
      const prev = entry.chats.get(chat.id);
      const name = chat.name || resolveName(chat.id) || prev?.name || cleanId(chat.id);
      entry.chats.set(chat.id, {
        name,
        lastMessage: prev?.lastMessage || '',
        lastTimestamp: chat.conversationTimestamp || prev?.lastTimestamp || 0,
        unreadCount: prev?.unreadCount || 0,
      });
      // Intentar resolver @lid en background
      if (chat.id.endsWith('@lid')) tryResolveLid(chat.id);
    }
    saveChatsCache(userId, entry.chats, entry.messages);
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Log para debug de mensajes entrantes
      console.log('[msg]', msg.key.id, 'keys:', Object.keys(msg.message || {}).join(','));

      // Ignorar solo mensajes completamente vacios (sin message object)
      if (!msg.message) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '[media]';

      const isImage = !!msg.message?.imageMessage;
      const isAudio = !!msg.message?.audioMessage;

      // Ignorar reacciones y mensajes de protocolo que no tienen contenido visible
      if (msg.message?.reactionMessage || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;

      if (!entry.messages.has(chatId)) entry.messages.set(chatId, []);
      // Evitar duplicados por id
      const existing = entry.messages.get(chatId);
      if (existing.find(m => m.id === msg.key.id)) continue;

      const msgEntry = {
        id: msg.key.id,
        fromMe: !!msg.key.fromMe,
        text: isImage ? '[imagen]' : isAudio ? '[audio]' : text,
        type: isImage ? 'image' : isAudio ? 'audio' : 'text',
        timestamp: msg.messageTimestamp,
        pushName: msg.pushName || null,
        raw: (isImage || isAudio) ? msg : undefined,
      };
      if (isAudio) {
        msgEntry.duration = msg.message.audioMessage.seconds || 0;
      }
      existing.push(msgEntry);

      const name = resolveName(chatId) || msg.pushName ||
                   entry.chats.get(chatId)?.name || cleanId(chatId);

      // Incrementar unreadCount solo para mensajes recibidos (no propios)
      const prevChat = entry.chats.get(chatId) || {};
      const prevUnread = prevChat.unreadCount || 0;
      const newUnread = msg.key.fromMe ? prevUnread : prevUnread + 1;

      entry.chats.set(chatId, {
        name,
        lastMessage: isImage ? '[imagen]' : isAudio ? '[audio]' : (text || ''),
        lastTimestamp: msg.messageTimestamp,
        unreadCount: newUnread,
      });

      if (chatId.endsWith('@lid')) tryResolveLid(chatId);
      touch(userId);
    }
    // Persistir en disco tras cada batch de mensajes
    saveChatsCache(userId, entry.chats, entry.messages);
  });

  // Presencia: escribiendo o no
  sock.ev.on('presence.update', ({ id, presences }) => {
    for (const [participant, data] of Object.entries(presences)) {
      const isTyping = data.lastKnownPresence === 'composing' || data.lastKnownPresence === 'recording';
      entry.presence.set(id, { typing: isTyping, timestamp: Date.now() });
    }
  });

  // Visto: actualizar ack de mensajes enviados (1=enviado, 2=entregado, 3=leido)
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      const chatId = update.key.remoteJid;
      if (!chatId || !update.update?.status) continue;
      const msgs = entry.messages.get(chatId);
      if (!msgs) continue;
      const msg = msgs.find(m => m.id === update.key.id);
      if (msg) msg.ack = update.update.status;
    }
  });

  return entry;
}

function getSession(userId) {
  return sessions.get(userId);
}

function checkAccess(userId, code) {
  const s = sessions.get(userId);
  return !!(s && s.accessCode && code && s.accessCode === code);
}

function cleanupInactive(days) {
  const limitMs = days * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [userId, entry] of sessions.entries()) {
    if (now - entry.lastActivity > limitMs) {
      try { entry.sock.end(undefined); } catch (_) {}
      sessions.delete(userId);
      fs.rmSync(path.join(SESSIONS_DIR, userId), { recursive: true, force: true });
      console.log(`[cleanup] Sesion eliminada por inactividad: ${userId}`);
    }
  }
}

module.exports = {
  sessions,
  createSession,
  getSession,
  checkAccess,
  touch,
  activeCount,
  cleanupInactive,
  cleanId,
  MAX_CONCURRENT_SESSIONS,
};
