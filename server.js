require('dotenv').config();
const express = require('express');
const routes = require('./routes');
const {
  cleanupInactive,
  restoreSessions,
  activeCount,
  MAX_CONCURRENT_SESSIONS,
  cleanupMedia,
  checkAccess,
} = require('./sessionManager');
const tcpServer = require('./tcpServer');
tcpServer.init(checkAccess);

const app = express();
app.use((req, res, next) => {
  // /sendaudio, /sendimage, /senddoc reciben datos raw — no parsear como JSON
  if (req.path.startsWith('/sendaudio/') || req.path.startsWith('/sendimage/') || req.path.startsWith('/senddoc/')) return next();
  express.json()(req, res, next);
});

app.get('/', (req, res) => {
  res.json({
    name: 'WPJava server',
    status: 'ok',
    sesionesActivas: activeCount(),
    limiteSesiones: MAX_CONCURRENT_SESSIONS,
  });
});

app.use('/', routes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`WPJava server escuchando en puerto ${PORT}`);
  // Restaurar sesiones existentes
  restoreSessions().catch(err => console.error('[restore] Error:', err));
});

// Limpieza de sesiones inactivas: inmediatamente al arrancar y luego cada 6 horas
// (antes solo cada 24h, dejaba acumularse las carpetas huerfanas un día entero)

const INACTIVE_DAYS = parseInt(process.env.INACTIVE_SESSION_DAYS || '30', 10);
cleanupInactive(INACTIVE_DAYS);
setInterval(() => cleanupInactive(INACTIVE_DAYS), 6 * 60 * 60 * 1000);

// Limpieza de media: imagenes >3 dias, audios >5 dias — una vez al dia
setInterval(() => cleanupMedia(3, 5), 24 * 60 * 60 * 1000);

process.on('SIGINT', () => {
  console.log('Cerrando servidor...');
  process.exit(0);
});
