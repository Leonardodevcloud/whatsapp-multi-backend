// src/modules/users/index.js
const usersRoutes = require('./users.routes');

function initUsersRoutes(app) {
  app.use('/api/users', usersRoutes);
}

module.exports = { initUsersRoutes };
