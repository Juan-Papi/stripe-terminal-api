const Stripe = require('stripe');
const Logger = require('./Logger');

class StripeConnect {
  constructor(secretKey) {
    this.stripe = Stripe(secretKey, { apiVersion: '2024-06-20' });
  }

  // ─── Accounts ─────────────────────────────────────────────────────────────

  async createAccount(email, country = 'US', businessName = null) {
    const params = {
      type: 'express',
      country,
      email,
      capabilities: {
        card_payments: { requested: true },
        transfers:     { requested: true },
      },
    };
    if (businessName) params.business_profile = { name: businessName };
    const account = await this.stripe.accounts.create(params);
    Logger.info('CONNECT', `Cuenta creada: ${account.id} (${email})`);
    return account;
  }

  async getAccount(accountId) {
    return this.stripe.accounts.retrieve(accountId);
  }

  async listAccounts(limit = 100) {
    const result = await this.stripe.accounts.list({ limit });
    return result.data;
  }

  async deleteAccount(accountId) {
    const result = await this.stripe.accounts.del(accountId);
    Logger.info('CONNECT', `Cuenta eliminada: ${accountId}`);
    return result;
  }

  // ─── Onboarding ───────────────────────────────────────────────────────────

  async createAccountLink(accountId, refreshUrl, returnUrl) {
    const link = await this.stripe.accountLinks.create({
      account:     accountId,
      refresh_url: refreshUrl,
      return_url:  returnUrl,
      type:        'account_onboarding',
    });
    Logger.info('CONNECT', `Onboarding link creado para: ${accountId}`);
    return link;
  }

  // ─── Balance ──────────────────────────────────────────────────────────────

  async getAccountBalance(accountId) {
    return this.stripe.balance.retrieve({ stripeAccount: accountId });
  }
}

module.exports = StripeConnect;
