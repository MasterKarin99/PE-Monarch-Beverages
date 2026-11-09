'use strict';
// Envoi des liens de connexion (uniquement). Facultatif : sans SMTP, les liens
// sont générés par l'équipe dans la plateforme, ou affichés dans les journaux du serveur.
const nodemailer = require('nodemailer');

function makeMailer(cfg) {
  if (!cfg.host) return { enabled: false, send: async () => { throw new Error('SMTP non configuré'); } };
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port, secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return {
    enabled: true,
    send: ({ to, subject, text, html }) => transport.sendMail({ from: cfg.from, to, subject, text, html }),
  };
}

module.exports = { makeMailer };
