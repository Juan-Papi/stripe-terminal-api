require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const StripeTerminal = require('./library/StripeTerminal');
const StripeConnect  = require('./library/StripeConnect');
const Logger         = require('./library/Logger');
const PaymentStore   = require('./library/PaymentStore');

const app  = express();
const PORT = process.env.PORT || 8001;

let terminal = null;
let connect  = null;
let stripeKey = process.env.STRIPE_SECRET_KEY || '';

function getTerminal() {
  if (!terminal && stripeKey) terminal = new StripeTerminal(stripeKey);
  return terminal;
}

function getConnect() {
  if (!connect && stripeKey) connect = new StripeConnect(stripeKey);
  return connect;
}

// ─── SSE clients ─────────────────────────────────────────────────────────────

const sseClients = new Set();

PaymentStore.on('webhook', (entry) => {
  const data = `event: webhook\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); } catch (_) { sseClients.delete(res); }
  }
});

// ─── WEBHOOK (debe ir antes de express.json para recibir raw body) ────────────

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig           = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const t             = getTerminal();

  let event;
  try {
    if (webhookSecret && t) {
      event = t.verifyWebhook(req.body, sig, webhookSecret);
    } else {
      if (!webhookSecret) Logger.warn('WEBHOOK', 'STRIPE_WEBHOOK_SECRET no configurado — omitiendo verificación de firma');
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    Logger.error('WEBHOOK', `Firma inválida: ${err.message}`);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  handleWebhookEvent(event);
  res.json({ received: true });
});

// ─── MIDDLEWARE GLOBAL ────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use('/public', express.static(path.join(__dirname, 'views/public')));

// ─── UI ──────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
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
  terminal  = new StripeTerminal(stripeKey);
  connect   = new StripeConnect(stripeKey);
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
        id: r.id, label: r.label, serial: r.serial_number,
        status: r.status, deviceType: r.device_type, location: r.location,
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

// ─── CONNECTION TOKEN ─────────────────────────────────────────────────────────

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

// ─── PAGO PRINCIPAL ───────────────────────────────────────────────────────────
//
//  GET /pago/:device/:type/:amount
//    device : label o número de serie del lector
//    type   : "ctl" | "chip" | "qr"
//    amount : monto en formato decimal "100.50"
//
//  Respuesta compatible con totem_kiosko:
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

  if (amountCents < 50) {
    Logger.warn('PAGO', `Monto muy bajo: ${amount} (mínimo $0.50)`);
    return res.json(buildErrorResponse('12', `Monto mínimo es $0.50. Recibido: $${amount}`));
  }

  Logger.info('API_IN', `[PAGO] device=${device} type=${type} amount=${amount} (${amountCents} centavos)`);

  try {
    const aliasKey      = `DEVICE_${device}`;
    const resolvedDevice = process.env[aliasKey] || device;
    const reader        = await t.findReader(resolvedDevice);

    if (!reader) {
      Logger.error('PAGO', `Lector no encontrado: ${device}`);
      return res.json(buildErrorResponse('96', `Lector no encontrado: ${device}`));
    }

    if (reader.status !== 'online') {
      Logger.warn('PAGO', `Lector offline: ${reader.id} (${reader.label})`);
      return res.json(buildErrorResponse('91', `Lector offline: ${reader.label || reader.id}`));
    }

    Logger.info('PAGO', `Lector encontrado: ${reader.id} (${reader.label || reader.serial_number})`);

    const currency = process.env.CURRENCY || 'usd';
    const merchantId = req.query.merchant || null;
    let applicationFeeAmount = null;
    if (req.query.fee != null) {
      applicationFeeAmount = Math.round(parseFloat(req.query.fee) * 100);
      if (isNaN(applicationFeeAmount) || applicationFeeAmount < 0) applicationFeeAmount = null;
    }

    const connectOptions = merchantId ? { merchantId, applicationFeeAmount } : null;

    const paymentIntent = await t.createPaymentIntent(
      amountCents,
      currency,
      { device, type, totem: process.env.TOTEM_ID || 'totem001', ...(merchantId && { merchant: merchantId }) },
      connectOptions,
    );
    Logger.info('PAGO', `PaymentIntent creado: ${paymentIntent.id}`);

    // Registrar en el store
    PaymentStore.upsert(paymentIntent.id, {
      device, type, amount, amountCents,
      status: 'created',
      readerId: reader.id,
    });

    await t.processPaymentIntent(reader.id, paymentIntent.id);
    Logger.info('PAGO', `Procesando en lector ${reader.id}...`);

    PaymentStore.upsert(paymentIntent.id, { status: 'processing' });

    const result = await t.waitForPayment(paymentIntent.id, 60, reader.id);

    if (!result.success) {
      Logger.warn('API_OUT', `Pago fallido: ${result.message}`);
      PaymentStore.upsert(paymentIntent.id, { status: 'failed', failReason: result.message });
      return res.json(buildErrorResponse(result.code || '05', result.message));
    }

    const captured = await t.capturePaymentIntent(paymentIntent.id);
    Logger.info('PAGO', `PaymentIntent capturado: ${captured.id}`);

    PaymentStore.upsert(paymentIntent.id, { status: 'captured' });

    const response = buildSuccessResponse(captured, reader, amountCents, type);
    Logger.info('API_OUT', `Pago aprobado: authCode=${captured.id} amount=${amount}`);
    res.json(response);

  } catch (e) {
    Logger.error('PAGO', e.message);
    res.json(buildErrorResponse('96', e.message));
  }
});

// ─── CANCELAR PAGO ────────────────────────────────────────────────────────────

app.get('/cancelar/:paymentIntentId', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const cancelled = await t.cancelPaymentIntent(req.params.paymentIntentId);
    Logger.info('CANCELAR', `PaymentIntent cancelado: ${cancelled.id}`);
    PaymentStore.upsert(cancelled.id, { status: 'canceled' });
    res.json({ status: 'success', paymentIntentId: cancelled.id });
  } catch (e) {
    Logger.error('CANCELAR', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── CANCELAR ACCIÓN EN LECTOR ────────────────────────────────────────────────

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

// ─── REEMBOLSO ────────────────────────────────────────────────────────────────
//
//  POST /api/refund
//  body: { paymentIntentId: "pi_...", amount?: "25.00" }   ← amount opcional
//
//  Reembolso total si no se especifica amount.

app.post('/api/refund', async (req, res) => {
  const t = getTerminal();
  if (!t) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  const { paymentIntentId, amount } = req.body;
  if (!paymentIntentId) {
    return res.status(400).json({ status: 'error', message: 'paymentIntentId es requerido' });
  }

  let amountCents = null;
  if (amount != null) {
    amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      return res.status(400).json({ status: 'error', message: `Monto inválido: ${amount}` });
    }
  }

  try {
    const refund = await t.createRefund(paymentIntentId, amountCents);
    Logger.info('REFUND', `Reembolso creado: ${refund.id} PI=${paymentIntentId} amount=${refund.amount}`);
    PaymentStore.upsert(paymentIntentId, {
      refunded: true,
      refundId: refund.id,
      amountRefunded: refund.amount,
    });
    res.json({
      status:  'success',
      refundId: refund.id,
      amount:   (refund.amount / 100).toFixed(2),
      currency: refund.currency,
      piStatus: refund.status,
    });
  } catch (e) {
    Logger.error('REFUND', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── STRIPE CONNECT ───────────────────────────────────────────────────────────
//
//  POST /api/connect/account
//  body: { email, country?, businessName? }
//  → Crea una cuenta Express para el comercio y retorna su ID (acct_xxx)
//
//  POST /api/connect/account-link
//  body: { accountId, refreshUrl, returnUrl }
//  → Genera la URL de onboarding para que el comercio complete sus datos
//
//  GET  /api/connect/accounts
//  → Lista todas las cuentas conectadas
//
//  GET  /api/connect/account/:accountId
//  → Detalles y estado de una cuenta (charges_enabled, payouts_enabled, etc.)
//
//  DELETE /api/connect/account/:accountId
//  → Elimina una cuenta (solo funciona en modo test)

app.post('/api/connect/account', async (req, res) => {
  const c = getConnect();
  if (!c) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  const { email, country, businessName } = req.body;
  if (!email) return res.status(400).json({ status: 'error', message: 'email es requerido' });

  try {
    const account = await c.createAccount(email, country || 'US', businessName || null);
    res.json({
      status:    'success',
      accountId: account.id,
      email:     account.email,
      country:   account.country,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
    });
  } catch (e) {
    Logger.error('CONNECT', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/connect/account-link', async (req, res) => {
  const c = getConnect();
  if (!c) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  const { accountId, refreshUrl, returnUrl } = req.body;
  if (!accountId) return res.status(400).json({ status: 'error', message: 'accountId es requerido' });

  const baseUrl = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
  const finalRefreshUrl = refreshUrl || `${baseUrl}/connect/refresh?account=${accountId}`;
  const finalReturnUrl  = returnUrl  || `${baseUrl}/connect/return?account=${accountId}`;

  try {
    const link = await c.createAccountLink(accountId, finalRefreshUrl, finalReturnUrl);
    res.json({ status: 'success', url: link.url, expiresAt: link.expires_at });
  } catch (e) {
    Logger.error('CONNECT', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/connect/accounts', async (req, res) => {
  const c = getConnect();
  if (!c) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const accounts = await c.listAccounts();
    res.json({
      status: 'success',
      accounts: accounts.map(a => ({
        id:             a.id,
        email:          a.email,
        country:        a.country,
        businessName:   a.business_profile?.name || null,
        chargesEnabled: a.charges_enabled,
        payoutsEnabled: a.payouts_enabled,
        detailsSubmitted: a.details_submitted,
      })),
    });
  } catch (e) {
    Logger.error('CONNECT', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/connect/account/:accountId', async (req, res) => {
  const c = getConnect();
  if (!c) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const a = await c.getAccount(req.params.accountId);
    res.json({
      status: 'success',
      account: {
        id:               a.id,
        email:            a.email,
        country:          a.country,
        businessName:     a.business_profile?.name || null,
        chargesEnabled:   a.charges_enabled,
        payoutsEnabled:   a.payouts_enabled,
        detailsSubmitted: a.details_submitted,
        requirements:     a.requirements,
      },
    });
  } catch (e) {
    Logger.error('CONNECT', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.delete('/api/connect/account/:accountId', async (req, res) => {
  const c = getConnect();
  if (!c) return res.status(503).json({ status: 'error', message: 'Stripe key no configurada' });

  try {
    const result = await c.deleteAccount(req.params.accountId);
    res.json({ status: 'success', deleted: result.deleted, id: result.id });
  } catch (e) {
    Logger.error('CONNECT', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── PAYMENT STORE ────────────────────────────────────────────────────────────

app.get('/api/payments', (req, res) => {
  const n = parseInt(req.query.limit) || 50;
  res.json({ status: 'success', payments: PaymentStore.getRecent(n) });
});

app.get('/api/payments/:id', (req, res) => {
  const payment = PaymentStore.get(req.params.id);
  if (!payment) return res.status(404).json({ status: 'error', message: 'No encontrado' });
  res.json({ status: 'success', payment });
});

// ─── WEBHOOK EVENTS ───────────────────────────────────────────────────────────

app.get('/api/webhook-events', (req, res) => {
  const n = parseInt(req.query.limit) || 100;
  res.json({ status: 'success', events: PaymentStore.getRecentWebhookEvents(n) });
});

// ─── SSE STREAM (para monitor en tiempo real) ─────────────────────────────────

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write('event: ping\ndata: connected\n\n');
  sseClients.add(res);

  req.on('close', () => sseClients.delete(res));
});

// ─── LOGS ─────────────────────────────────────────────────────────────────────

app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines) || 100;
  res.json({ status: 'success', logs: Logger.getRecentLogs(lines) });
});

// ─── WEBHOOK HANDLER ─────────────────────────────────────────────────────────

function handleWebhookEvent(event) {
  const obj = event.data?.object || {};

  switch (event.type) {
    case 'payment_intent.succeeded':
      Logger.info('WEBHOOK', `payment_intent.succeeded: ${obj.id} amount=${obj.amount}`);
      PaymentStore.upsert(obj.id, {
        status: 'succeeded', webhookConfirmed: true,
        amount: obj.amount, currency: obj.currency,
      });
      break;

    case 'payment_intent.requires_capture':
      Logger.info('WEBHOOK', `payment_intent.requires_capture: ${obj.id}`);
      PaymentStore.upsert(obj.id, { status: 'requires_capture' });
      break;

    case 'payment_intent.payment_failed': {
      const err = obj.last_payment_error;
      Logger.warn('WEBHOOK', `payment_intent.payment_failed: ${obj.id} — ${err?.message}`);
      PaymentStore.upsert(obj.id, {
        status: 'failed', webhookConfirmed: true,
        error: err?.message, declineCode: err?.decline_code,
      });
      break;
    }

    case 'payment_intent.canceled':
      Logger.info('WEBHOOK', `payment_intent.canceled: ${obj.id}`);
      PaymentStore.upsert(obj.id, { status: 'canceled', webhookConfirmed: true });
      break;

    case 'charge.refunded':
      Logger.info('WEBHOOK', `charge.refunded: ${obj.id} refunded=${obj.amount_refunded}`);
      if (obj.payment_intent) {
        PaymentStore.upsert(obj.payment_intent, {
          refunded: true, amountRefunded: obj.amount_refunded,
        });
      }
      break;

    case 'terminal.reader.action_succeeded':
      Logger.info('WEBHOOK', `terminal.reader.action_succeeded: reader=${obj.id}`);
      break;

    case 'terminal.reader.action_failed':
      Logger.warn('WEBHOOK', `terminal.reader.action_failed: reader=${obj.id} — ${obj.action?.failure_message}`);
      break;

    case 'account.updated': {
      const enabled = obj.charges_enabled ? 'habilitado' : 'pendiente';
      Logger.info('WEBHOOK', `account.updated: ${obj.id} charges=${enabled}`);
      break;
    }

    case 'account.application.deauthorized':
      Logger.warn('WEBHOOK', `account.application.deauthorized: ${obj.id}`);
      break;

    default:
      Logger.debug('WEBHOOK', `Evento recibido (no manejado): ${event.type}`);
  }

  PaymentStore.addWebhookEvent(event);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function buildSuccessResponse(captured, reader, amountCents, type) {
  const pm   = captured.payment_method_details;
  const card = pm?.card_present || pm?.interac_present || {};
  const now  = new Date();

  const pad = n => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const amountFormatted = (amountCents / 100).toFixed(2);
  const authCode = card.authorization_code || captured.id.slice(-6).toUpperCase();

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
      { name: 'transactionDate', value: date },
      { name: 'transactionTime', value: time },
      { name: 'last4Digits',     value: card.last4 || '0000' },
      { name: 'cardBINTarjeta',  value: card.brand || '' },
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

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  Logger.info('SERVER', `Stripe Terminal API corriendo en http://localhost:${PORT}`);
  if (!stripeKey) {
    Logger.warn('SERVER', 'STRIPE_SECRET_KEY no configurada. Ve a http://localhost:' + PORT + ' para configurar.');
  } else {
    Logger.info('SERVER', `Stripe key cargada: ${stripeKey.substring(0, 12)}...`);
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    Logger.warn('SERVER', 'STRIPE_WEBHOOK_SECRET no configurado — los webhooks no verificarán firma.');
  }
});
