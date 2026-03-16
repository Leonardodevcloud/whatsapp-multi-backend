// src/modules/contacts/index.js
const contactsRoutes = require('./contacts.routes');
const { initContactsTables } = require('./contacts.migration');

function initContactsRoutes(app) {
  app.use('/api/contacts', contactsRoutes);
}

module.exports = { initContactsRoutes, initContactsTables };
