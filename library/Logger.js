const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_MEMORY_LOGS = 500;

const memoryLogs = [];

function pad(n) { return String(n).padStart(2, '0'); }

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3,'0')}`;
}

function todayFile() {
  const d = new Date();
  const name = `log-${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}.txt`;
  return path.join(LOG_DIR, name);
}

function write(level, category, message) {
  const line = `${timestamp()} | ${level.padEnd(5)} | ${category.padEnd(16)} | ${message}`;

  // Consola
  const colors = { INFO: '\x1b[36m', WARN: '\x1b[33m', ERROR: '\x1b[31m', DEBUG: '\x1b[90m' };
  const reset = '\x1b[0m';
  console.log(`${colors[level] || ''}${line}${reset}`);

  // Memoria circular (para /api/logs)
  memoryLogs.push({ ts: timestamp(), level, category, message, line });
  if (memoryLogs.length > MAX_MEMORY_LOGS) memoryLogs.shift();

  // Archivo diario
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(todayFile(), line + '\n', 'utf8');
  } catch (_) {}
}

module.exports = {
  info:  (cat, msg) => write('INFO',  cat, msg),
  warn:  (cat, msg) => write('WARN',  cat, msg),
  error: (cat, msg) => write('ERROR', cat, msg),
  debug: (cat, msg) => write('DEBUG', cat, msg),
  getRecentLogs: (n = 100) => memoryLogs.slice(-n),
};
