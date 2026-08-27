const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const db = require('./db');
const tcpServer = require('./tcpServer');
let _baileys = null;
async function B() {
  if (!_baileys) _baileys = await import('@whiskeysockets/baileys');
  return _baileys;
}

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '48', 10);

const sessions = new Map();

function genAccessCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Convierte timestamp protobuf ({ low, high, unsigned }) o número a milliseconds
function toMs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'object' && 'low' in ts) {
    // Long protobuf: reconstruir como número de 64 bits (low es unsigned)
    const val = (ts.high >>> 0) * 4294967296 + (ts.low >>> 0);
    return val * 1000;
  }
  const n = Number(ts);
  // Si ya viene en ms (>1e12) no multiplicar
  return n > 1e12 ? n : n * 1000;
}

// ---- DB helpers ----

async function dbUpsertSession(userId, accessCode, status) {
  try {
    await db.query(
      `INSERT INTO sessions (userId, accessCode, status, lastActivity)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE accessCode=VALUES(accessCode), status=VALUES(status), lastActivity=VALUES(lastActivity)`,
      [userId, accessCode, status, Date.now()]
    );
  } catch (_) {}
}

async function dbUpsertChat(userId, chatId, name, lastMessage, lastTimestamp, unreadCount) {
  try {
    await db.query(
      `INSERT INTO chats (userId, chatId, name, lastMessage, lastTimestamp, unreadCount)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name=VALUES(name), lastMessage=VALUES(lastMessage),
         lastTimestamp=VALUES(lastTimestamp), unreadCount=VALUES(unreadCount)`,
      [userId, chatId, name || 'No conocido', lastMessage || '', lastTimestamp || 0, unreadCount || 0]
    );
  } catch (_) {}
}

async function dbInsertMessage(userId, chatId, msgEntry) {
  try {
    await db.query(
      `INSERT IGNORE INTO messages (userId, chatId, messageId, fromMe, text, type, timestamp, pushName, ack, quoted, duration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, chatId, msgEntry.id, msgEntry.fromMe ? 1 : 0,
       msgEntry.text || '', msgEntry.type || 'text',
       msgEntry.timestamp || 0, msgEntry.pushName || null, msgEntry.ack || 0,
       msgEntry.quotedText || null, msgEntry.duration || 0]
    );
  } catch (_) {}
}

async function dbDeleteSession(userId) {
  try {
    await db.query('DELETE FROM sessions WHERE userId=?', [userId]);
    await db.query('DELETE FROM chats WHERE userId=?', [userId]);
    await db.query('DELETE FROM messages WHERE userId=?', [userId]);
  } catch (_) {}
}

async function dbGetAccessCode(userId) {
  try {
    const rows = await db.query('SELECT accessCode FROM sessions WHERE userId=?', [userId]);
    return rows[0]?.accessCode || null;
  } catch (_) { return null; }
}

// ---- fin DB helpers ----

function cleanId(jid) {
  if (!jid) return jid;
  if (jid.endsWith('@s.whatsapp.net')) return '+' + jid.replace('@s.whatsapp.net', '');
  if (jid.endsWith('@g.us')) return jid.replace('@g.us', '');
  if (jid.endsWith('@lid')) return jid.replace('@lid', ''); // Mostrar solo el numero LID
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
    // Guardar solo los ultimos 10 mensajes por chat para reducir uso de RAM
    const msgsObj = {};
    for (const [id, msgs] of messages.entries()) msgsObj[id] = msgs.slice(-10).map(({ raw, ...m }) => m);
    fs.writeFileSync(path.join(dir, 'messages_cache.json'), JSON.stringify(msgsObj));
  } catch (_) {}
}

function loadChatsCache(userId) {
  try {
    const dir = path.join(SESSIONS_DIR, userId);
    const chatsObj = JSON.parse(fs.readFileSync(path.join(dir, 'chats_cache.json'), 'utf8'));
    const msgsObj = JSON.parse(fs.readFileSync(path.join(dir, 'messages_cache.json'), 'utf8'));
    const chats = new Map(
      Object.entries(chatsObj).map(([id, c]) => [id, { ...c, lastTimestamp: toMs(c.lastTimestamp) }])
    );
    const messages = new Map(Object.entries(msgsObj));
    return { chats, messages };
  } catch (_) {
    return { chats: new Map(), messages: new Map() };
  }
}

// --- Persistencia separada de inbox/outbox (no se borra al reconectar) ---

function saveInbox(userId, chatId, msgEntry) {
  try {
    const dir = path.join(DATA_DIR, userId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'inbox.json');
    let data = [];
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    if (data.find(m => m.id === msgEntry.id && m.chatId === chatId)) return;
    data.push({ chatId, ...msgEntry });
    if (data.length > 200) data = data.slice(-200);
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
}

function loadInbox(userId) {
  try {
    const file = path.join(DATA_DIR, userId, 'inbox.json');
    if (!fs.existsSync(file)) return new Map();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const map = new Map();
    for (const item of data) {
      if (!map.has(item.chatId)) map.set(item.chatId, []);
      map.get(item.chatId).push(item);
    }
    return map;
  } catch (_) { return new Map(); }
}

function saveOutbox(userId, jid, message) {
  try {
    const dir = path.join(DATA_DIR, userId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'outbox.json');
    let data = [];
    if (fs.existsSync(file)) {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    data.push({ jid, message, timestamp: Date.now(), retries: 0 });
    if (data.length > 100) data = data.slice(-100);
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (_) {}
}

function loadOutbox(userId) {
  try {
    const file = path.join(DATA_DIR, userId, 'outbox.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return []; }
}

async function processOutbox(userId, sock) {
  const items = loadOutbox(userId);
  if (items.length === 0) return;
  console.log(`[outbox] Enviando ${items.length} mensajes pendientes...`);
  const remaining = [];
  for (const item of items) {
    try {
      let jid = item.jid;
      try {
        const [wa] = await sock.onWhatsApp(jid);
        if (wa?.exists && wa?.jid) jid = wa.jid;
      } catch (_) {}
      await sock.sendMessage(jid, { text: item.message });
    } catch (e) {
      remaining.push({ ...item, retries: (item.retries || 0) + 1 });
      console.log(`[outbox] Error con ${item.jid}, reintento ${(item.retries || 0) + 1}`);
    }
  }
  try {
    fs.writeFileSync(path.join(DATA_DIR, userId, 'outbox.json'), JSON.stringify(remaining));
  } catch (_) {}
}

function cleanupMedia(imageDays, audioDays) {
  const dirs = [DATA_DIR, SESSIONS_DIR];
  const imgLimit   = Date.now() - imageDays * 24 * 60 * 60 * 1000;
  const audioLimit = Date.now() - audioDays  * 24 * 60 * 60 * 1000;
  for (const baseDir of dirs) {
    if (!fs.existsSync(baseDir)) continue;
    const walk = (dir) => {
      try {
        for (const e of fs.readdirSync(dir)) {
          const full = path.join(dir, e);
          if (fs.statSync(full).isDirectory()) { walk(full); continue; }
          const mtime = fs.statSync(full).mtimeMs;
          if (full.endsWith('.jpg') || full.endsWith('.jpeg') || full.endsWith('.png')) {
            if (mtime < imgLimit) fs.unlinkSync(full);
          } else if (full.endsWith('.ogg') || full.endsWith('.mp3') || full.endsWith('.amr')) {
            if (mtime < audioLimit) fs.unlinkSync(full);
          }
        }
      } catch (_) {}
    };
    walk(baseDir);
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
  console.log(`[link] createSession INICIO userId=${userId}`);
  if (sessions.has(userId)) {
    console.log(`[link] createSession ya existia userId=${userId}`);
    return sessions.get(userId);
  }

  if (activeCount() >= MAX_CONCURRENT_SESSIONS) {
    console.log(`[link] LIMIT_REACHED userId=${userId}`);
    throw new Error('LIMIT_REACHED');
  }

  const userDir = path.join(SESSIONS_DIR, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const baileys = await B();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(userDir);
  console.log(`[link] Auth state cargado userId=${userId}, hay creds=${!!state.creds?.me}`);
  const { version } = await baileys.fetchLatestWaWebVersion();
  console.log(`[link] Version WA: ${version.join('.')}`);
  const sock = baileys.default({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  const savedMeta = loadMeta(userId);
  const lidCache = loadLidCache(userId);
  const dbCode = await dbGetAccessCode(userId);

  const entry = {
    sock,
    contacts: {},
    lidCache,
    status: 'connecting',
    qr: null,
    accessCode: savedMeta.accessCode || dbCode || null,
    presence: new Map(),
    myPhotoUrl: null,
    lastActivity: Date.now(),
    saveCreds,
  };
  sessions.set(userId, entry);
  console.log(`[link] Entrada creada, status=connecting userId=${userId}`);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    console.log(`[link] connection.update userId=${userId} connection=${connection} qr=${qr ? 'SI' : 'NO'} isNewLogin=${update.isNewLogin}`);

    if (qr) {
      entry.qr = await QRCode.toDataURL(qr);
      entry.status = 'waiting_qr';
      console.log(`[link] QR generado userId=${userId} (dataURL ${entry.qr.length} chars)`);
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      if (!entry.accessCode) {
        entry.accessCode = genAccessCode();
      }
      saveMeta(userId, entry.accessCode);
      console.log(`[session] ${userId} conectado, code: ${entry.accessCode}`);
      await dbUpsertSession(userId, entry.accessCode, 'connected');

      // Sembrar lidCache desde signalRepository (mapeos ya conocidos por Baileys)
      try {
        if (sock.signalRepository?.lidMapping && typeof sock.signalRepository.lidMapping.getPNForLID === 'function') {
          const lids = Object.keys(entry.lidCache);
          for (const lid of lids) {
            if (!entry.lidCache[lid] && lid.endsWith('@lid')) {
              const pn = sock.signalRepository.lidMapping.getPNForLID(lid);
              if (pn) {
                entry.lidCache[lid] = pn.replace('@s.whatsapp.net', '');
              }
            }
          }
          saveLidCache(userId, entry.lidCache);
        }
      } catch (_) {}

      touch(userId);
      processOutbox(userId, entry.sock).catch(e => console.error('[outbox] Error:', e));

      // Obtener foto de perfil propia
      try {
        const myJid = sock.user?.id;
        if (myJid) {
          const url = await sock.profilePictureUrl(myJid, 'image');
          entry.myPhotoUrl = url || null;
        }
      } catch (_) { entry.myPhotoUrl = null; }
    }

    if (connection === 'close') {
      const baileys = await B();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;

      console.log(`[session] ${userId} connection=close, loggedOut=${loggedOut}, statusCode=${statusCode}`);
      console.log(`[link] error en disconnect:`, lastDisconnect?.error?.message || 'ninguno');

      if (loggedOut) {
        sessions.delete(userId);
        fs.rmSync(userDir, { recursive: true, force: true });
        await dbDeleteSession(userId);
        console.log(`[session] ${userId} cerro sesion, datos eliminados`);
        } else {
          entry.status = 'reconnecting';
          // Cerrar explicitamente el socket viejo para que Baileys no
          // reconecte en paralelo con el nuevo (evita sockets fantasma)
          try { sock.end(undefined); } catch (_) {}
          console.log(`[link] Reintentando en 3s userId=${userId}`);
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
      if (c.id) {
        entry.contacts[c.id] = c;
        
        if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
          lidCache[c.lid] = c.id.replace('@s.whatsapp.net', '');
          saveLidCache(userId, lidCache);
        } else if (c.id.endsWith('@lid') && c.phoneNumber) {
          lidCache[c.id] = c.phoneNumber.replace('@s.whatsapp.net', '');
          saveLidCache(userId, lidCache);
        }

        // Actualizar nombre en DB si existe el chat
        const newName = c.name || c.notify;
        if (newName) {
          db.query('UPDATE chats SET name=? WHERE userId=? AND chatId=? AND (name="No conocido" OR name=?)',
            [newName, userId, c.id, cleanId(c.id)]).catch(() => {});
          if (c.lid) {
            db.query('UPDATE chats SET name=? WHERE userId=? AND chatId=? AND (name="No conocido" OR name=?)',
              [newName, userId, c.lid, cleanId(c.lid)]).catch(() => {});
          }
        }

        // Guardar respaldo de contactos en DB para fallback tras reconexión
        if (c.id.endsWith('@s.whatsapp.net') && newName) {
          const phone = c.id.replace('@s.whatsapp.net', '');
          db.query(
            `INSERT INTO contacts (userId, contactId, name, phone)
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone)`,
            [userId, c.id, newName, phone]
          ).catch(() => {});
        }
      }
    }
  });

  // Escuchar mapeos LID→PN que Baileys descubra dinámicamente
  sock.ev.on('lid-mapping.update', (mappings) => {
    if (!mappings) return;
    for (const [lid, pn] of Object.entries(mappings)) {
      const barePn = pn.replace('@s.whatsapp.net', '');
      if (!entry.lidCache[lid]) {
        entry.lidCache[lid] = barePn;
      }
    }
    saveLidCache(userId, entry.lidCache);
  });

  // Resolver nombre de un jid usando contacts + lidCache (con salto lid→phone→name)
  function resolveName(jid) {
    if (!jid) return null;
    
    // Paso 1: Si es formato de teléfono directo, buscar en contacts
    if (jid.endsWith('@s.whatsapp.net')) {
      const contact = entry.contacts[jid];
      if (contact?.name) return contact.name;
      if (contact?.notify) return contact.notify;
      return null;
    }
    
    // Paso 2: Si es @lid, primero resolver a número de teléfono
    if (jid.endsWith('@lid')) {
      const phoneJid = lidCache[jid]; // Buscar en cache
      if (phoneJid) {
        // Paso 3: Ahora buscar el nombre con el número real
        const contact = entry.contacts[phoneJid + '@s.whatsapp.net'];
        if (contact?.name) return contact.name;
        if (contact?.notify) return contact.notify;
      }
      return null;
    }
    
    return null;
  }

  // Intentar resolver @lid a numero real en background (sin bloquear)
  async function tryResolveLid(jid) {
    if (!jid.endsWith('@lid') || lidCache[jid]) return;
    try {
      let numero = null;
      // v7: signalRepository.lidMapping.getPNForLID() reemplaza onWhatsApp para LIDs
      if (sock.signalRepository?.lidMapping) {
        const pn = sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) numero = pn.replace('@s.whatsapp.net', '');
      }
      if (!numero) {
        const [result] = await sock.onWhatsApp(jid);
        if (result?.exists && result?.jid) {
          numero = result.jid.replace('@s.whatsapp.net', '');
        }
      }
      if (numero) {
        lidCache[jid] = numero;
        saveLidCache(userId, lidCache);
        // Actualizar nombre en DB si existía como LID
        db.query(
          'UPDATE chats SET chatId=? WHERE userId=? AND chatId=?',
          [numero + '@s.whatsapp.net', userId, jid]
        ).catch(() => {});
      }
    } catch (_) {}
  }

  sock.ev.on('messaging-history.set', async ({ chats, contacts, lidPnMappings }) => {
    // Procesar mapeos LID→PN del historial ANTES de los chats
    if (lidPnMappings && Array.isArray(lidPnMappings)) {
      for (const m of lidPnMappings) {
        const lid = m.lid || m.id;
        const pn = m.pn || m.phoneNumber;
        if (lid && pn) {
          const barePn = pn.replace('@s.whatsapp.net', '');
          if (!entry.lidCache[lid]) {
            entry.lidCache[lid] = barePn;
            saveLidCache(userId, entry.lidCache);
          }
        }
      }
    }
    // Poblar entry.contacts desde el bulk inicial (contacts.upsert solo llega con cambios individuales)
    if (contacts && Array.isArray(contacts)) {
      for (const c of contacts) {
        if (c.id) {
          entry.contacts[c.id] = c;
          if (c.id.endsWith('@s.whatsapp.net') && (c.name || c.notify)) {
            const phone = c.id.replace('@s.whatsapp.net', '');
            const cname = c.name || c.notify;
            db.query(
              `INSERT INTO contacts (userId, contactId, name, phone)
               VALUES (?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE name=VALUES(name), phone=VALUES(phone)`,
              [userId, c.id, cname, phone]
            ).catch(() => {});
          }
        }
      }
    }
    for (const chat of chats) {
      const normId = (chat.id.endsWith('@lid') && entry.lidCache[chat.id])
        ? entry.lidCache[chat.id] + '@s.whatsapp.net'
        : chat.id;
      // Obtener datos previos de DB
      let prev = null;
      try {
        const rows = await db.query('SELECT * FROM chats WHERE userId=? AND chatId=?', [userId, normId]);
        if (rows.length > 0) prev = rows[0];
      } catch (_) {}
      const contactName = resolveName(normId);
      let name;
      if (contactName) {
        name = contactName;
      } else if (chat.name) {
        name = chat.name;
      } else if (prev?.name && prev.name !== cleanId(normId) && prev.name !== 'No conocido') {
        name = prev.name;
      } else {
        name = 'No conocido';
      }
      const newLastMsg = prev?.lastMessage || '';
      const rawTs = chat.conversationTimestamp;
      const newTimestamp = prev?.lastTimestamp || toMs(rawTs);
      dbUpsertChat(userId, normId, name, newLastMsg, newTimestamp, prev?.unreadCount || 0);
      if (chat.id.endsWith('@lid')) tryResolveLid(chat.id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Normalizar @lid a @s.whatsapp.net si tenemos mapeo
      const normId = (chatId.endsWith('@lid') && entry.lidCache[chatId])
        ? entry.lidCache[chatId] + '@s.whatsapp.net'
        : chatId;

      // Log de todo lo que llega, antes de cualquier filtro

      // Ignorar solo mensajes completamente vacios (sin message object)
      if (!msg.message) continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '[media]';

      const isImage = !!msg.message?.imageMessage;
      const isAudio = !!msg.message?.audioMessage;
      const isDoc = !!msg.message?.documentMessage;
      const isSticker = !!msg.message?.stickerMessage;
      const docFileName = isDoc ? (msg.message.documentMessage.fileName || 'documento') : null;
      const docMime = isDoc ? (msg.message.documentMessage.mimetype || 'application/octet-stream') : null;

      // Extraer texto del mensaje citado (reply)
      const contextInfo = msg.message?.extendedTextMessage?.contextInfo
        || msg.message?.imageMessage?.contextInfo
        || msg.message?.audioMessage?.contextInfo
        || null;
      let quotedText = null;
      if (contextInfo?.quotedMessage) {
        const qm = contextInfo.quotedMessage;
        quotedText = qm.conversation
          || qm.extendedTextMessage?.text
          || (qm.imageMessage ? '[imagen]' : null)
          || (qm.audioMessage ? '[audio]' : null)
          || (qm.stickerMessage ? '[sticker]' : null)
          || (qm.documentMessage ? '[doc]' : null)
          || null;
        if (quotedText && quotedText.length > 40) quotedText = quotedText.substring(0, 40);
      }

      // Ignorar reacciones y mensajes de protocolo que no tienen contenido visible
      // senderKeyDistributionMessage es normal en grupos (clave de cifrado) y puede venir
      // junto con conversation/extendedTextMessage — solo descartar si NO hay contenido real
      const hasRealContent = msg.message?.conversation
        || msg.message?.extendedTextMessage
        || msg.message?.imageMessage
        || msg.message?.audioMessage
        || msg.message?.videoMessage
        || msg.message?.stickerMessage
        || msg.message?.documentMessage;
      if (msg.message?.reactionMessage || msg.message?.protocolMessage
          || (msg.message?.senderKeyDistributionMessage && !hasRealContent)) {
        continue;
      }

      const msgEntry = {
        id: msg.key.id,
        fromMe: !!msg.key.fromMe,
        text: isImage ? (msg.message?.imageMessage?.caption || '[imagen]') : isSticker ? '[sticker]' : isAudio ? '[audio]' : isDoc ? ('[doc:' + docFileName + ']') : text,
        type: isImage ? 'image' : isSticker ? 'image' : isAudio ? 'audio' : isDoc ? 'document' : 'text',
        timestamp: toMs(msg.messageTimestamp) / 1000,
        pushName: msg.pushName || null,
        raw: (isImage || isSticker || isAudio || isDoc) ? msg : undefined,
        quotedText: quotedText || null,
      };
      if (isAudio) msgEntry.duration = msg.message.audioMessage.seconds || 0;
      if (isDoc) { msgEntry.fileName = docFileName; msgEntry.mimeType = docMime; }

      // Guardar mensaje en DB
      await dbInsertMessage(userId, normId, msgEntry);

      if (isImage || isSticker) {
        console.log(`[media-recv] id=${msg.key.id} ts=${Date.now()} keys=${JSON.stringify(Object.keys(msg.message || {}))} isImage=${isImage} isSticker=${isSticker}`);
      }

      // Descargar y persistir media en disco al recibirla
      if ((isImage || isSticker || isAudio || isDoc) && msg.key.id) {
        (async () => {
          try {
            console.log(`[media] Descargando msgId=${msg.key.id} ts=${Date.now()} tipo=${isAudio ? 'audio' : isImage ? 'imagen' : isSticker ? 'sticker' : 'doc'} chatId=${normId}`);
            const { downloadMediaMessage } = await import('@whiskeysockets/baileys');
            const mediaDir = path.join(SESSIONS_DIR, userId, 'media');
            fs.mkdirSync(mediaDir, { recursive: true });
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            console.log(`[media] Descargado msgId=${msg.key.id} ts=${Date.now()} bytes=${buffer.length}`);
            if (isImage) {
              fs.writeFileSync(path.join(mediaDir, msg.key.id + '.jpg'), buffer);
            } else if (isSticker) {
              // Convertir .webp a .jpg para compatibilidad con J2ME
              try {
                const sharp = require('sharp');
                const jpgBuffer = await sharp(buffer)
                  .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 80 })
                  .toBuffer();
                fs.writeFileSync(path.join(mediaDir, msg.key.id + '.jpg'), jpgBuffer);
              } catch (sharpErr) {
                // Si sharp falla, guardar webp de todas formas (fallback)
                fs.writeFileSync(path.join(mediaDir, msg.key.id + '.jpg'), buffer);
              }
            } else if (isDoc) {
              // Guardar con nombre original para que el navegador lo descargue bien
              const safeFileName = (docFileName || 'doc').replace(/[^a-zA-Z0-9._-]/g, '_');
              fs.writeFileSync(path.join(mediaDir, msg.key.id + '_' + safeFileName), buffer);
            } else {
              fs.writeFileSync(path.join(mediaDir, msg.key.id + '.ogg'), buffer);
              console.log(`[media] AUDIO guardado: ${msg.key.id}.ogg (${buffer.length} bytes)`);
            }
          } catch (e) {
            console.log(`[media] Error descargando media ${msg.key.id} ts=${Date.now()}:`, e.message);
          }
        })();
      }

      // Obtener estado previo del chat de DB para calcular unread y nombre
      let prevChat = null;
      try {
        const rows = await db.query('SELECT * FROM chats WHERE userId=? AND chatId=?', [userId, normId]);
        if (rows.length > 0) prevChat = rows[0];
      } catch (_) {}

      const agendaName = resolveName(normId);
      const prevUnread = prevChat?.unreadCount || 0;
      const finalLast = isImage ? '[imagen]' : isSticker ? '[sticker]' : isAudio ? '[audio]' : isDoc ? ('[doc:' + docFileName + ']') : (text || '');
      const msgTs = toMs(msg.messageTimestamp);
      const newUnread = msg.key.fromMe ? prevUnread : prevUnread + 1;

      let finalName;
      if (agendaName) {
        finalName = agendaName;
      } else if (prevChat?.name && prevChat.name !== cleanId(normId) && prevChat.name !== 'No conocido') {
        finalName = prevChat.name;
      } else if (!msg.key.fromMe && msg.pushName) {
        finalName = msg.pushName;
      } else {
        finalName = 'No conocido';
      }

      await dbUpsertChat(userId, normId, finalName,
        isImage ? '[imagen]' : isSticker ? '[sticker]' : isAudio ? '[audio]' : isDoc ? ('[doc:' + docFileName + ']') : (text || ''),
        msgTs, newUnread);

      // Push TCP: notificar al cliente J2ME en tiempo real
      tcpServer.push(userId, {
        type: 'msg',
        chatId: normId,
        text: msgEntry.text,
        fromMe: msgEntry.fromMe,
        ts: msgEntry.timestamp,
        msgType: msgEntry.type,
        msgId: msgEntry.id,
        quoted: msgEntry.quotedText || null,
        sender: (typeof msgEntry.pushName === 'string' ? msgEntry.pushName.replace(/[^\x20-\xFF]/g, '').trim() : msgEntry.pushName),
        duration: msgEntry.duration || 0,
      });
      // Push TCP: actualizar la lista de chats
      tcpServer.push(userId, {
        type: 'chat',
        chatId: normId,
        name: finalName,
        lastMessage: finalLast,
        lastTimestamp: msgTs,
        unreadCount: newUnread,
      });

      if (chatId.endsWith('@lid')) tryResolveLid(chatId);
      touch(userId);
    }
  });

  // Presencia: escribiendo, en linea, ultima conexion
  sock.ev.on('presence.update', ({ id, presences }) => {
    for (const [participant, p] of Object.entries(presences)) {
      if (!p) continue;
      const normId = (id.endsWith('@lid') && entry.lidCache[id])
        ? entry.lidCache[id] + '@s.whatsapp.net'
        : id;
      entry.presence.set(normId, {
        typing:    p.lastKnownPresence === 'composing',
        recording: p.lastKnownPresence === 'recording',
        online:    p.lastKnownPresence === 'available',
        lastSeen:  p.lastSeen || null,
        timestamp: Date.now()
      });
      // Push TCP: notificar presencia en tiempo real
      tcpServer.push(userId, {
        type: 'presence',
        chatId: normId,
        typing: p.lastKnownPresence === 'composing',
        online: p.lastKnownPresence === 'available',
      });
    }
  });

  // Visto: actualizar ack de mensajes enviados (1=enviado, 2=entregado, 3=leido)
  sock.ev.on('messages.update', (updates) => {
    for (const update of updates) {
      let chatId = update.key.remoteJid;
      if (!chatId || !update.update?.status) continue;
      if (chatId.endsWith('@lid') && entry.lidCache[chatId]) {
        chatId = entry.lidCache[chatId] + '@s.whatsapp.net';
      }
      const ackStatus = update.update.status;
      const msgId = update.key.id;
      // Retry: si el UPDATE no afecta filas (mensaje aun no en DB), reintentar tras 3s
      db.query(
        'UPDATE messages SET ack=? WHERE userId=? AND chatId=? AND messageId=? AND ack < ?',
        [ackStatus, userId, chatId, msgId, ackStatus]
      ).then(result => {
        if (result.affectedRows === 0) {
          setTimeout(() => {
            db.query(
              'UPDATE messages SET ack=? WHERE userId=? AND chatId=? AND messageId=? AND ack < ?',
              [ackStatus, userId, chatId, msgId, ackStatus]
            ).catch(() => {});
          }, 3000);
        }
        // Push TCP: notificar cambio de ack
        tcpServer.push(userId, { type: 'ack', chatId, msgId, status: ackStatus });
      }).catch(() => {});
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

// Restaurar sesiones existentes al iniciar el servidor
async function restoreSessions() {
  console.log('[restore] Iniciando...');
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    return;
  }
  const dirs = fs.readdirSync(SESSIONS_DIR);
  console.log(`[restore] ${dirs.length} sesiones en disco`);
  
  for (const userId of dirs) {
    const userDir = path.join(SESSIONS_DIR, userId);
    try {
      const stat = fs.statSync(userDir);
      if (!stat.isDirectory()) continue;
      
      const credsPath = path.join(userDir, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      
      const meta = loadMeta(userId);
      if (!meta.accessCode) continue;
      
      console.log(`[restore] Restaurando sesion ${userId}...`);
      await createSession(userId);
    } catch (err) {
      console.log(`[restore] Error restaurando ${userId}:`, err.message);
    }
  }
  console.log(`[restore] Completado. Sesiones activas: ${activeCount()}`);
}

module.exports = {
  sessions,
  createSession,
  getSession,
  checkAccess,
  touch,
  activeCount,
  cleanupInactive,
  restoreSessions,
  cleanId,
  saveOutbox,
  cleanupMedia,
  MAX_CONCURRENT_SESSIONS,
};
