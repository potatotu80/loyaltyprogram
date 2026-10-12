'use strict';

const twilio = require('twilio');

const normalizePhone = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const compact = trimmed.replace(/[\s()-]/g, '');
  return compact.startsWith('00') ? `+${compact.slice(2)}` : compact;
};

const isValidDialTarget = (value) => /^\+[1-9]\d{7,14}$/.test(value);

module.exports = {
  async voice(ctx) {
    const callerId = (process.env.TWILIO_VOICE_CALLER_ID || '').trim();
    const to = normalizePhone(ctx.request.body?.To || ctx.query?.To);

    if (!callerId) {
      return ctx.internalServerError('TWILIO_VOICE_CALLER_ID is not configured.');
    }

    if (!to || !isValidDialTarget(to)) {
      return ctx.badRequest('A valid E.164 destination number is required.');
    }

    const response = new twilio.twiml.VoiceResponse();
    response.dial({ callerId }).number(to);

    ctx.type = 'text/xml; charset=utf-8';
    ctx.body = response.toString();
  },
};
