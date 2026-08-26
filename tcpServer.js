/**
 * Servidor TCP para push de eventos en tiempo real hacia clientes J2ME.
 * Puerto: TCP_PORT (default 3001).
 * 
 * Protocolo: una linea JSON por evento, terminada en \n
 * Cliente se autentica enviando: {"type":"auth","userId":"...","code":"..."}\n
 * Servidor responde: {"type":"auth_ok"}\n  o  {"type":"auth_fail"}\n
 * Heartbeat: servidor envia {"type":"ping"}\n cada 30s, cliente responde {"type":"pong"}\n
 * 
 * Eventos que el servidor empuja al cliente autenticado:
 *   {"type":"msg",  "chatId":"...","text":"...","fromMe":false,"ts":1234567890,"msgType":"text"}
 *   {"type":"chat", "chatId":"...","name":"...","lastMessage":"...","lastTimestamp":123,"unreadCount":1}
 *   {"type":"ack",  "chatId":"...","msgId":"...","status":3}
 *   {"type":"presence","chatId":"...","typing":true,"online":false}
 */

const net = require('net');

// Map: userId -> Socket  (un socket por usuario)
const clients = new Map();

const TCP_PORT = parseInt(process.env.TCP_PORT || '3001', 10);

let _checkAccess = null; // inyectado desde server.js

function init(checkAccessFn) {
  _checkAccess = checkAccessFn;

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 15000);

    let userId = null;
    let authenticated = false;
    let buffer = '';
    let pingInterval = null;
    let pongTimeout = null;

    socket.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        handleLine(line);
      }
    });

    function handleLine(line) {
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; }

      if (!authenticated) {
        if (obj.type === 'auth') {
          if (_checkAccess && _checkAccess(obj.userId, obj.code)) {
            userId = obj.userId;
            authenticated = true;
            // Si ya habia un socket anterior del mismo usuario, cerrarlo
            const prev = clients.get(userId);
            if (prev && prev !== socket) {
              try { prev.destroy(); } catch (_) {}
            }
            clients.set(userId, socket);
            send(socket, { type: 'auth_ok' });
            startPing();
            console.log(`[tcp] Cliente autenticado: ${userId}`);
          } else {
            send(socket, { type: 'auth_fail' });
            socket.destroy();
          }
        }
        return;
      }

      // Mensajes post-autenticacion
      if (obj.type === 'pong') {
        if (pongTimeout) { clearTimeout(pongTimeout); pongTimeout = null; }
      }
    }

    function startPing() {
      pingInterval = setInterval(() => {
        if (!send(socket, { type: 'ping' })) { cleanup('send_failed'); return; }
        // Si no recibimos pong en 15s, cerrar
        pongTimeout = setTimeout(() => {
          console.log(`[tcp] Timeout pong para ${userId}, cerrando`);
          cleanup('pong_timeout');
        }, 15000);
      }, 30000);
    }

    function cleanup(reason) {
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      if (pongTimeout)  { clearTimeout(pongTimeout);  pongTimeout  = null; }
      if (userId && clients.get(userId) === socket) {
        clients.delete(userId);
        console.log(`[tcp] Disconnect userId=${userId} reason=${reason || 'unknown'}`);
      }
      try { socket.destroy(); } catch (_) {}
    }

    socket.on('error', (err) => cleanup('error_' + (err.code || err.message)));
    socket.on('close', (hadError) => cleanup(hadError ? 'close_hadError' : 'close'));
    socket.on('end', () => cleanup('end'));
  });

  server.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`[tcp] Servidor TCP escuchando en puerto ${TCP_PORT}`);
  });

  server.on('error', (e) => {
    console.error('[tcp] Error en servidor TCP:', e.message);
  });
}

/** Envia un objeto JSON como linea al socket. Devuelve false si fallo */
function send(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

/** Empuja un evento a un usuario conectado. Llamado desde sessionManager. */
function push(userId, obj) {
  const socket = clients.get(userId);
  if (!socket) {
    return false;
  }
  return send(socket, obj);
}

module.exports = { init, push };
