const Stripe = require('stripe');
const Logger = require('./Logger');

class StripeTerminal {
  constructor(secretKey) {
    this.stripe = Stripe(secretKey, { apiVersion: '2024-06-20' });
  }

  // ─── Webhook ─────────────────────────────────────────────────────────────────

  verifyWebhook(rawBody, signature, secret) {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }

  // ─── Connection Token ─────────────────────────────────────────────────────

  async createConnectionToken() {
    return this.stripe.terminal.connectionTokens.create();
  }

  // ─── Readers ──────────────────────────────────────────────────────────────

  async listReaders() {
    const result = await this.stripe.terminal.readers.list({ limit: 100 });
    return result.data;
  }

  /**
   * Busca un lector por label, número de serie o ID de Stripe (case-insensitive).
   */
  async findReader(deviceIdentifier) {
    const readers = await this.listReaders();
    const id = deviceIdentifier.toLowerCase();

    return readers.find(r =>
      r.id.toLowerCase() === id ||
      (r.label && r.label.toLowerCase() === id) ||
      (r.serial_number && r.serial_number.toLowerCase() === id)
    ) || null;
  }

  async cancelReaderAction(readerId) {
    return this.stripe.terminal.readers.cancelAction(readerId);
  }

  // ─── Payment Intent ───────────────────────────────────────────────────────

  async createPaymentIntent(amountCents, currency, metadata = {}) {
    return this.stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      payment_method_types: ['card_present'],
      capture_method: 'manual',
      metadata,
    });
  }

  async capturePaymentIntent(paymentIntentId) {
    const pi = await this.stripe.paymentIntents.capture(paymentIntentId);
    const charge = pi.latest_charge
      ? await this.stripe.charges.retrieve(pi.latest_charge)
      : null;

    if (charge) pi.payment_method_details = charge.payment_method_details;
    return pi;
  }

  async cancelPaymentIntent(paymentIntentId) {
    return this.stripe.paymentIntents.cancel(paymentIntentId);
  }

  async getPaymentIntent(paymentIntentId) {
    return this.stripe.paymentIntents.retrieve(paymentIntentId);
  }

  // ─── Refunds ──────────────────────────────────────────────────────────────

  /**
   * Reembolsa un PaymentIntent completo o parcialmente.
   * @param {string} paymentIntentId
   * @param {number|null} amountCents  null = reembolso total
   */
  async createRefund(paymentIntentId, amountCents = null) {
    const params = { payment_intent: paymentIntentId };
    if (amountCents != null) params.amount = amountCents;
    return this.stripe.refunds.create(params);
  }

  // ─── Process on Reader ────────────────────────────────────────────────────

  async processPaymentIntent(readerId, paymentIntentId) {
    return this.stripe.terminal.readers.processPaymentIntent(readerId, {
      payment_intent: paymentIntentId,
    });
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  /**
   * Espera hasta timeoutSeconds a que el PaymentIntent sea requires_capture o
   * failed/cancelled. No bloquea el event loop.
   *
   * Retorna: { success: bool, code: string, message: string }
   */
  async waitForPayment(paymentIntentId, timeoutSeconds = 60, readerId = null) {
    const maxAttempts = timeoutSeconds;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await delay(1000);

      const pi = await this.getPaymentIntent(paymentIntentId);
      Logger.debug('POLLING', `attempt=${attempt + 1} status=${pi.status} id=${paymentIntentId}`);

      switch (pi.status) {
        case 'requires_capture':
        case 'succeeded':
          return { success: true };

        case 'canceled':
          return { success: false, code: '87', message: 'OPERACION CANCELADA' };

        case 'payment_failed': {
          const err = pi.last_payment_error;
          return {
            success: false,
            code: this._mapDeclineCode(err?.decline_code || err?.code || '05'),
            message: err?.message || 'PAGO RECHAZADO',
          };
        }

        case 'requires_payment_method':
          if (pi.last_payment_error) {
            const err = pi.last_payment_error;
            return {
              success: false,
              code: this._mapDeclineCode(err?.decline_code || err?.code || '05'),
              message: err?.message || 'PAGO RECHAZADO',
            };
          }
          break;

        default:
          break;
      }

      if (attempt > 2 && pi.last_payment_error) {
        const err = pi.last_payment_error;
        return {
          success: false,
          code: this._mapDeclineCode(err?.decline_code || err?.code || '05'),
          message: err?.message || 'PAGO RECHAZADO',
        };
      }

      if (attempt > 5 && readerId) {
        try {
          const reader = await this.stripe.terminal.readers.retrieve(readerId);
          if (reader.action?.status === 'failed') {
            return {
              success: false,
              code: '87',
              message: reader.action.failure_message || 'Acción fallida en lector',
            };
          }
        } catch (_) {}
      }
    }

    return { success: false, code: '91', message: 'TIMEOUT: El lector no respondió a tiempo' };
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

  _mapDeclineCode(code) {
    const map = {
      insufficient_funds:      '51',
      lost_card:               '41',
      stolen_card:             '43',
      expired_card:            '33',
      incorrect_pin:           '55',
      invalid_account:         '14',
      card_velocity_exceeded:  '61',
      do_not_honor:            '05',
      fraudulent:              '59',
    };
    return map[code] || '05';
  }
}

module.exports = StripeTerminal;
