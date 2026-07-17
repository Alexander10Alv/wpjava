const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
let _baileys = null;
async function B() {
  if (!_baileys) _baileys = await import('@whiskeysockets/baileys');
  return _baileys;
}

const SESSIONS_DIR = process.env.SESSIONS_DIR || '/app/sessions';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '21', 10);

const sessions = new Map();

function genAccessCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

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
    const chats = new Map(Object.entries(chatsObj));
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
      console.log(`[outbox] Enviado a ${jid}`);
    } catch (e) {
      remaining.push({ ...item, retries: (item.retries || 0) + 1 });
      console.log(`[outbox] Error con ${item.jid}, reintento ${(item.retries || 0) + 1}`);
    }
  }
  try {
    fs.writeFileSync(path.join(DATA_DIR, userId, 'outbox.json'), JSON.stringify(remaining));
  } catch (_) {}
}

function cleanupMedia(days) {
  const dirs = [DATA_DIR, SESSIONS_DIR];
  const limit = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const baseDir of dirs) {
    if (!fs.existsSync(baseDir)) continue;
    const walk = (dir) => {
      try {
        for (const e of fs.readdirSync(dir)) {
          const full = path.join(dir, e);
          if (fs.statSync(full).isDirectory()) { walk(full); continue; }
          if (full.endsWith('.ogg') || full.endsWith('.mp3') || full.endsWith('.amr') || full.endsWith('.jpg') || full.endsWith('.jpeg') || full.endsWith('.png')) {
            if (fs.statSync(full).mtimeMs < limit) {
              fs.unlinkSync(full);
            }
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
  if (sessions.has(userId)) {
    return sessions.get(userId);
  }

  if (activeCount() >= MAX_CONCURRENT_SESSIONS) {
    throw new Error('LIMIT_REACHED');
  }

  const userDir = path.join(SESSIONS_DIR, userId);
  fs.mkdirSync(userDir, { recursive: true });

  const baileys = await B();
  const { state, saveCreds } = await baileys.useMultiFileAuthState(userDir);
  const { version } = await baileys.fetchLatestWaWebVersion();
  const sock = baileys.default({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  const savedMeta = loadMeta(userId);
  const lidCache = loadLidCache(userId);
  const { chats: cachedChats, messages: cachedMessages } = loadChatsCache(userId);
  // Combinar mensajes del inbox persistente (no se borra al reconectar)
  const inboxMessages = loadInbox(userId);
  for (const [cid, imsgs] of inboxMessages.entries()) {
    const existing = cachedMessages.get(cid) || [];
    const merged = [...existing];
    for (const im of imsgs) {
      const idx = merged.findIndex(m => m.id === im.id);
      if (idx >= 0) {
        merged[idx] = im;
      } else {
        merged.push(im);
      }
    }
    cachedMessages.set(cid, merged.slice(-10));
  }

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
    }

    if (connection === 'close') {
      const baileys = await B();
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === baileys.DisconnectReason.loggedOut;

      console.log(`[session] ${userId} connection=close, loggedOut=${loggedOut}, statusCode=${statusCode}, chats en memoria: ${entry.chats.size}`);

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
    console.log(`[contacts] Recibidos ${contacts.length} contactos`);
    for (const c of contacts) {
      if (c.id) {
        console.log(`[contacts] ID: ${c.id}, name: ${c.name}, notify: ${c.notify}, phoneNumber: ${c.phoneNumber}, lid: ${c.lid}`);
        entry.contacts[c.id] = c;
        
        // v7: Contact tiene id (preferred), phoneNumber (si id es LID), lid (si id es PN)
        if (c.id.endsWith('@s.whatsapp.net') && c.lid) {
          lidCache[c.lid] = c.id.replace('@s.whatsapp.net', '');
          console.log(`[contacts] Mapeado LID ${c.lid} -> ${lidCache[c.lid]}`);
          saveLidCache(userId, lidCache);
        } else if (c.id.endsWith('@lid') && c.phoneNumber) {
          lidCache[c.id] = c.phoneNumber.replace('@s.whatsapp.net', '');
          console.log(`[contacts] Mapeado LID ${c.id} -> ${lidCache[c.id]}`);
          saveLidCache(userId, lidCache);
        }
        
        // Actualizar nombre del chat si existe
        if (entry.chats.has(c.id)) {
          const chat = entry.chats.get(c.id);
          const newName = c.name || c.notify || chat.name;
          console.log(`[contacts] Actualizando chat ${c.id}: "${chat.name}" -> "${newName}"`);
          if (newName && newName !== chat.name) {
            chat.name = newName;
            saveChatsCache(userId, entry.chats, entry.messages);
          }
        }
        
        // También actualizar si el chat existe por LID
        if (c.lid && entry.chats.has(c.lid)) {
          const chat = entry.chats.get(c.lid);
          const newName = c.name || c.notify || chat.name;
          console.log(`[contacts] Actualizando chat LID ${c.lid}: "${chat.name}" -> "${newName}"`);
          if (newName && newName !== chat.name) {
            chat.name = newName;
            saveChatsCache(userId, entry.chats, entry.messages);
          }
        }
      }
    }
  });

  // Escuchar mapeos LID→PN que Baileys descubra dinámicamente
  sock.ev.on('lid-mapping.update', (mappings) => {
    if (!mappings) return;
    console.log('[lid-mapping] Recibido update:', Object.keys(mappings).length, 'mapeos');
    for (const [lid, pn] of Object.entries(mappings)) {
      const barePn = pn.replace('@s.whatsapp.net', '');
      if (!entry.lidCache[lid]) {
        entry.lidCache[lid] = barePn;
        console.log(`[lid-mapping] Mapeado ${lid} → ${barePn}`);
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
        if (entry.chats.has(jid)) {
          const chat = entry.chats.get(jid);
          if (!chat.name || chat.name === cleanId(jid)) {
            chat.name = numero;
          }
        }
      }
    } catch (_) {}
  }

  sock.ev.on('messaging-history.set', ({ chats, lidPnMappings }) => {
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
            console.log(`[history] Mapeo LID ${lid} → ${barePn} (del historial)`);
          }
        }
      }
    }
    console.log(`[history] Cargando ${chats.length} chats`);
    for (const chat of chats) {
      const normId = (chat.id.endsWith('@lid') && entry.lidCache[chat.id])
        ? entry.lidCache[chat.id] + '@s.whatsapp.net'
        : chat.id;
      if (normId !== chat.id) {
        if (entry.chats.has(chat.id)) {
          if (!entry.chats.has(normId)) {
            entry.chats.set(normId, entry.chats.get(chat.id));
          }
          entry.chats.delete(chat.id);
        }
        if (entry.messages.has(chat.id)) {
          if (entry.messages.has(normId)) {
            const pnMsgs = entry.messages.get(normId);
            for (const lm of entry.messages.get(chat.id)) {
              if (!pnMsgs.find(m => m.id === lm.id)) pnMsgs.push(lm);
            }
            if (pnMsgs.length > 10) pnMsgs.splice(0, pnMsgs.length - 10);
          } else {
            entry.messages.set(normId, entry.messages.get(chat.id));
          }
          entry.messages.delete(chat.id);
        }
      }
      const prev = entry.chats.get(normId);
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
      console.log(`[history] Chat ${normId}: name="${name}" (contact: ${contactName}, chat.name: ${chat.name})`);
      const newLastMsg = prev?.lastMessage || '';
      const newTimestamp = Math.max((chat.conversationTimestamp || 0) * 1000, prev?.lastTimestamp || 0);
      console.log(`[debug2] Chat ${normId} history: convTs=${chat.conversationTimestamp} prevTs=${prev?.lastTimestamp} newTs=${newTimestamp} lastMsg="${newLastMsg}" prevExisted=${!!prev}`);
      entry.chats.set(normId, {
        name,
        lastMessage: newLastMsg,
        lastTimestamp: newTimestamp,
        unreadCount: prev?.unreadCount || 0,
      });
      if (chat.id.endsWith('@lid')) tryResolveLid(chat.id);
    }
    saveChatsCache(userId, entry.chats, entry.messages);
  });

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;

      // Normalizar @lid a @s.whatsapp.net si tenemos mapeo
      const normId = (chatId.endsWith('@lid') && entry.lidCache[chatId])
        ? entry.lidCache[chatId] + '@s.whatsapp.net'
        : chatId;
      if (normId !== chatId) {
        if (entry.chats.has(chatId)) {
          if (!entry.chats.has(normId)) {
            entry.chats.set(normId, entry.chats.get(chatId));
          }
          entry.chats.delete(chatId);
        }
        if (entry.messages.has(chatId)) {
          if (entry.messages.has(normId)) {
            const pnMsgs = entry.messages.get(normId);
            for (const lm of entry.messages.get(chatId)) {
              if (!pnMsgs.find(m => m.id === lm.id)) pnMsgs.push(lm);
            }
            if (pnMsgs.length > 10) pnMsgs.splice(0, pnMsgs.length - 10);
          } else {
            entry.messages.set(normId, entry.messages.get(chatId));
          }
          entry.messages.delete(chatId);
        }
      }

      console.log('[msg]', msg.key.id, 'keys:', Object.keys(msg.message || {}).join(','), 'chatId:', chatId, '-> normId:', normId, 'fromMe:', msg.key.fromMe);

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

      if (!entry.messages.has(normId)) entry.messages.set(normId, []);
      // Evitar duplicados por id
      const existing = entry.messages.get(normId);
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
      
      // Limitar a 10 mensajes por chat en RAM para evitar OOM
      if (existing.length > 10) {
        existing.shift(); // Eliminar el más antiguo
      }

      const agendaName = resolveName(normId);
      const prevChat = entry.chats.get(normId) || {};
      const prevUnread = prevChat.unreadCount || 0;
      const finalLast = isImage ? '[imagen]' : isAudio ? '[audio]' : (text || '');
      const msgTs = (msg.messageTimestamp || 0) * 1000;
      const prevTs = prevChat.lastTimestamp || 0;
      console.log(`[debug2] Chat ${normId} msgTs=${msgTs} prevTs=${prevTs} lastMessage: "${prevChat.lastMessage || ''}" -> "${finalLast}" (isImage:${isImage} isAudio:${isAudio} fromMe:${msg.key.fromMe})`);
      const newUnread = msg.key.fromMe ? prevUnread : prevUnread + 1;

      // Lógica de nombre:
      // 1. Si está en agenda → siempre usar nombre de agenda
      // 2. Si prevName ya fue resuelto por agenda → mantenerlo
      // 3. Si mensaje recibido (no propio) → usar pushName del otro
      // 4. Fallback → "No conocido"
      let finalName;
      if (agendaName) {
        finalName = agendaName;
      } else if (prevChat.name && prevChat.name !== cleanId(normId) && prevChat.name !== 'No conocido') {
        finalName = prevChat.name;
      } else if (!msg.key.fromMe && msg.pushName) {
        finalName = msg.pushName;
      } else {
        finalName = 'No conocido';
      }

      console.log(`[msg] Chat ${normId} name: "${finalName}" (prevName: "${prevChat.name}", pushName: "${msg.pushName}", contact: "${resolveName(normId)}")`);

      entry.chats.set(normId, {
        name: finalName,
        lastMessage: isImage ? '[imagen]' : isAudio ? '[audio]' : (text || ''),
        lastTimestamp: (msg.messageTimestamp || 0) * 1000,
        unreadCount: newUnread,
      });

      if (chatId.endsWith('@lid')) tryResolveLid(chatId);
      touch(userId);
    }
    // Persistir en disco tras cada batch de mensajes
    saveChatsCache(userId, entry.chats, entry.messages);
  });

  // Persistir mensajes entrantes en inbox separado (no se borra al reconectar)
  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const msg of messages) {
      const chatId = msg.key.remoteJid;
      if (!chatId) continue;
      if (!msg.message) continue;
      const normId = (chatId.endsWith('@lid') && entry.lidCache[chatId])
        ? entry.lidCache[chatId] + '@s.whatsapp.net'
        : chatId;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[media]';
      const isImage = !!msg.message?.imageMessage;
      const isAudio = !!msg.message?.audioMessage;
      if (msg.message?.reactionMessage || msg.message?.protocolMessage || msg.message?.senderKeyDistributionMessage) continue;
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
      saveInbox(userId, normId, msgEntry);
    }
  });

  // Presencia: escribiendo o no
  sock.ev.on('presence.update', ({ id, presences }) => {
    for (const [participant, data] of Object.entries(presences)) {
      const isTyping = data.lastKnownPresence === 'composing' || data.lastKnownPresence === 'recording';
      const normId = (id.endsWith('@lid') && entry.lidCache[id])
        ? entry.lidCache[id] + '@s.whatsapp.net'
        : id;
      entry.presence.set(normId, { typing: isTyping, timestamp: Date.now() });
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

// Restaurar sesiones existentes al iniciar el servidor
async function restoreSessions() {
  console.log('[restore] Iniciando restauracion...');
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.log('[restore] Directorio de sesiones no existe, creando...');
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    return;
  }
  const dirs = fs.readdirSync(SESSIONS_DIR);
  console.log(`[restore] Encontradas ${dirs.length} sesiones en disco`);
  
  for (const userId of dirs) {
    const userDir = path.join(SESSIONS_DIR, userId);
    try {
      const stat = fs.statSync(userDir);
      if (!stat.isDirectory()) continue;
      
      // Verificar que tenga credenciales de Baileys
      const credsPath = path.join(userDir, 'creds.json');
      if (!fs.existsSync(credsPath)) continue;
      
      // Verificar que tenga meta.json con accessCode
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
