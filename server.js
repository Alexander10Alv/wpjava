require('dotenv').config();
const express = require('express');
const routes = require('./routes');
const {
  cleanupInactive,
  sweepIdle,
  activeCount,
  MAX_CONCURRENT_SESSIONS,
} = require('./sessionManager');

const app = express();
app.use(express.json());

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
app.listen(PORT, () => {
  console.log(`WPJava server escuchando en puerto ${PORT}`);
});

const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_SECONDS || '60', 10) * 1000;
setInterval(sweepIdle, SWEEP_INTERVAL_MS);

const INACTIVE_DAYS = parseInt(process.env.INACTIVE_SESSION_DAYS || '30', 10);
setInterval(() => cleanupInactive(INACTIVE_DAYS), 24 * 60 * 60 * 1000);

process.on('SIGINT', () => {
  console.log('Cerrando servidor...');
  process.exit(0);
});
