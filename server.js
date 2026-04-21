require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const StripeTerminal = require('./library/StripeTerminal');
const Logger = require('./library/Logger');

const app = express();
const PORT = process.env.PORT || 8001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'views/public')));

let terminal = null;
let stripeKey = process.env.STRIPE_SECRET_KEY || '';

function getTerminal() {
  if (!terminal && stripeKey) {
    terminal = new StripeTerminal(stripeKey);
  }
  return terminal;
}

// ─── UI ──────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  const t = getTerminal();
  res.render('kiosk', {
    stripeKey: stripeKey ? stripeKey.substring(0, 12) + '...' : '',
    keyConfigured: !!stripeKey,
    port: PORT,
  });
});

app.get('/monitor', (req, res) => {
  res.render('monitor', { port: PORT });
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────

app.post('/api/config/key', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk_')) {
    return res.status(400).json({ status: 'error', message: 'Clave inválida. Debe empezar con sk_' });
  }
  stripeKey = key;
  terminal = new StripeTerminal(stripeKey);
  Logger.info('CONFIG', `Stripe key actualizada: ${key.substring(0, 12)}...`);
  res.json({ status: 'success', message: 'Clave configurada correctamente' });
});

// ─── STATUS ──────────────────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const readers = await t.listReaders();
    res.json({
      status: 'success',
      keyConfigured: true,
      readers: readers.map(r => ({
        id: r.id,
        label: r.label,
        serial: r.serial_number,
        status: r.status,
        deviceType: r.device_type,
        location: r.location,
      })),
    });
  } catch (e) {
    Logger.error('STATUS', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/list_readers', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const readers = await t.listReaders();
    res.json({ status: 'success', readers });
  } catch (e) {
    Logger.error('LIST_READERS', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── CONNECTION TOKEN (para que el lector se conecte) ────────────────────────

app.post('/connection_token', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ error: 'Stripe key no configurada' });

  try {
    const token = await t.createConnectionToken();
    Logger.info('CONNECTION_TOKEN', 'Token generado para lector');
    res.json({ secret: token.secret });
  } catch (e) {
    Logger.error('CONNECTION_TOKEN', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── PAGO PRINCIPAL (compatible con totem_kiosko) ────────────────────────────
//
//  GET /pago/:device/:type/:amount
//    device : label o número de serie del lector
//    type   : "ctl" | "chip" | "qr"
//    amount : monto en formato decimal "100.50"
//
//  Respuesta idéntica al formato de red-enlace-api:
//  { status: "success", message: [ {name, value}, ... ] }

app.get('/pago/:device/:type/:amount', async (req, res) => {
  const { device, type, amount } = req.params;
  const t = getTerminal();

  if (!t) {
    Logger.error('PAGO', 'Stripe key no configurada');
    return res.json(buildErrorResponse('98', 'Stripe key no configurada'));
  }

  const validTypes = ['ctl', 'chip', 'qr'];
  if (!validTypes.includes(type)) {
    return res.json(buildErrorResponse('12', `Tipo de pago inválido: ${type}`));
  }

  const amountCents = Math.round(parseFloat(amount) * 100);
  if (isNaN(amountCents) || amountCents <= 0) {
    return res.json(buildErrorResponse('12', `Monto inválido: ${amount}`));
  }

  // Stripe requiere mínimo $0.50
  if (amountCents < 50) {
    Logger.warn('PAGO', `Monto muy bajo: ${amount} (mínimo $0.50)`);
    return res.json(buildErrorResponse('12', `Monto mínimo es $0.50. Recibido: $${amount}`));
  }

  Logger.info('API_IN', `[PAGO] device=${device} type=${type} amount=${amount} (${amountCents} centavos)`);

  try {
    // 1. Buscar el lector (resuelve alias de .env: DEVICE_device001=PRUEBA)
    const aliasKey = `DEVICE_${device}`;
    const resolvedDevice = process.env[aliasKey] || device;
    const reader = await t.findReader(resolvedDevice);
    if (!reader) {
      Logger.error('PAGO', `Lector no encontrado: ${device}`);
      return res.json(buildErrorResponse('96', `Lector no encontrado: ${device}`));
    }

    if (reader.status !== 'online') {
      Logger.warn('PAGO', `Lector offline: ${reader.id} (${reader.label})`);
      return res.json(buildErrorResponse('91', `Lector offline: ${reader.label || reader.id}`));
    }

    Logger.info('PAGO', `Lector encontrado: ${reader.id} (${reader.label || reader.serial_number})`);

    // 2. Crear PaymentIntent
    const currency = process.env.CURRENCY || 'usd';
    const paymentIntent = await t.createPaymentIntent(amountCents, currency, {
      device,
      type,
      totem: process.env.TOTEM_ID || 'totem001',
    });
    Logger.info('PAGO', `PaymentIntent creado: ${paymentIntent.id}`);

    // 3. Enviar al lector
    await t.processPaymentIntent(reader.id, paymentIntent.id);
    Logger.info('PAGO', `Procesando en lector ${reader.id}...`);

    // 4. Esperar resultado (polling no-bloqueante)
    const result = await t.waitForPayment(paymentIntent.id, 60, reader.id);

    if (!result.success) {
      Logger.warn('API_OUT', `Pago fallido: ${result.message}`);
      return res.json(buildErrorResponse(result.code || '05', result.message));
    }

    // 5. Capturar
    const captured = await t.capturePaymentIntent(paymentIntent.id);
    Logger.info('PAGO', `PaymentIntent capturado: ${captured.id}`);

    const response = buildSuccessResponse(captured, reader, amountCents, type);
    Logger.info('API_OUT', `Pago aprobado: authCode=${captured.id} amount=${amount}`);
    res.json(response);

  } catch (e) {
    Logger.error('PAGO', e.message);
    res.json(buildErrorResponse('96', e.message));
  }
});

// ─── CANCELAR PAGO ───────────────────────────────────────────────────────────

app.get('/cancelar/:paymentIntentId', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const cancelled = await t.cancelPaymentIntent(req.params.paymentIntentId);
    Logger.info('CANCELAR', `PaymentIntent cancelado: ${cancelled.id}`);
    res.json({ status: 'success', paymentIntentId: cancelled.id });
  } catch (e) {
    Logger.error('CANCELAR', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── CANCELAR ACCIÓN EN LECTOR ───────────────────────────────────────────────

app.get('/cancelar_lector/:device', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const reader = await t.findReader(req.params.device);
    if (!reader) return res.status(404).json({ status: 'error', message: 'Lector no encontrado' });

    await t.cancelReaderAction(reader.id);
    Logger.info('CANCELAR_LECTOR', `Acción cancelada en lector ${reader.id}`);
    res.json({ status: 'success', readerId: reader.id });
  } catch (e) {
    Logger.error('CANCELAR_LECTOR', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── LOGS API ─────────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  res.json({ status: 'success', logs: Logger.getRecentLogs(lines) });
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildSuccessResponse(captured, reader, amountCents, type) {
  const pm = captured.payment_method_details;
  const card = pm?.card_present || pm?.interac_present || {};
  const now = new Date();

  // Formato que espera el tótem: "YYYY-MM-DD" y "HH:MM:SS"
  const year  = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day   = String(now.getDate()).padStart(2, '0');
  const hours   = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  // purchaseAmount en decimal "25.00" (como envía el tótem y espera de vuelta)
  const amountFormatted = (amountCents / 100).toFixed(2);
  const authCode = card.authorization_code || captured.id.slice(-6).toUpperCase();
  const last4 = card.last4 || '0000';
  const brand = card.brand || '';

  const paymentMethodNames = { ctl: 'Tarjeta NFC', chip: 'Tarjeta Chip', qr: 'QR' };

  return {
    status: 'success',
    message: [
      { name: 'responseCode',    value: '00' },
      { name: 'authCode',        value: authCode },
      { name: 'purchaseAmount',  value: amountFormatted },
      { name: 'receiptNumber',   value: captured.id.slice(-6).toUpperCase() },
      { name: 'RRN',             value: captured.id },
      { name: 'terminalID',      value: reader.id },
      { name: 'transactionDate', value: `${year}-${month}-${day}` },
      { name: 'transactionTime', value: `${hours}:${minutes}:${seconds}` },
      { name: 'last4Digits',     value: last4 },
      { name: 'cardBINTarjeta',  value: brand },
      { name: 'paymentMethod',   value: paymentMethodNames[type] || 'Tarjeta' },
      { name: 'errorMessage',    value: '' },
      { name: 'paymentIntentId', value: captured.id },
    ],
  };
}

function buildErrorResponse(code, message) {
  const errorMessages = {
    '00': 'TRANS. APROBADA',
    '05': 'NO AUTORIZADA',
    '12': 'TRANS. INVALIDA',
    '14': 'TARJETA INVALIDA',
    '51': 'FONDOS INSUFICIENTES',
    '55': 'PIN INVALIDO',
    '87': 'OPERACION CANCELADA',
    '91': 'TERMINAL OFFLINE',
    '96': 'ERROR SISTEMA',
    '98': 'NO CONFIGURADO',
    '99': 'ERROR DESCONOCIDO',
  };

  return {
    status: 'error',
    message: [
      { name: 'responseCode', value: code },
      { name: 'errorMessage', value: message || errorMessages[code] || 'ERROR' },
    ],
  };
}

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  Logger.info('SERVER', `Stripe Terminal API corriendo en http://localhost:${PORT}`);
  if (!stripeKey) {
    Logger.warn('SERVER', 'STRIPE_SECRET_KEY no configurada. Ve a http://localhost:' + PORT + ' para configurar.');
  } else {
    Logger.info('SERVER', `Stripe key cargada: ${stripeKey.substring(0, 12)}...`);
  }
});
