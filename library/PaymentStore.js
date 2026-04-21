const EventEmitter = require('events');

const MAX_PAYMENTS = 300;
const MAX_EVENTS   = 500;

class PaymentStore extends EventEmitter {
  constructor() {
    super();
    this.payments      = new Map(); // paymentIntentId → record
    this.webhookEvents = [];        // últimos N eventos de webhook
  }

  // ─── Payments ──────────────────────────────────────────────────────────────

  upsert(paymentIntentId, data) {
    const existing = this.payments.get(paymentIntentId) || {
      id: paymentIntentId,
      createdAt: new Date().toISOString(),
    };
    const updated = { ...existing, ...data, updatedAt: new Date().toISOString() };
    this.payments.set(paymentIntentId, updated);

    if (this.payments.size > MAX_PAYMENTS) {
      this.payments.delete(this.payments.keys().next().value);
    }

    return updated;
  }

  get(paymentIntentId) {
    return this.payments.get(paymentIntentId) || null;
  }

  getRecent(n = 50) {
    return Array.from(this.payments.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, n);
  }

  // ─── Webhook events ────────────────────────────────────────────────────────

  addWebhookEvent(stripeEvent) {
    const obj = stripeEvent.data?.object || {};
    const entry = {
      id:       stripeEvent.id,
      type:     stripeEvent.type,
      ts:       new Date().toISOString(),
      objectId: obj.id || null,
    };

    this.webhookEvents.push(entry);
    if (this.webhookEvents.length > MAX_EVENTS) this.webhookEvents.shift();

    this.emit('webhook', entry);
    return entry;
  }

  getRecentWebhookEvents(n = 100) {
    return this.webhookEvents.slice(-n);
  }
}

// singleton compartido por toda la app
module.exports = new PaymentStore();
