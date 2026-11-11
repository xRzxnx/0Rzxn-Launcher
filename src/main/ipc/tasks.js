'use strict';

// Tâches longues (page Activité) : en attente et en cours, historique, annulation.
const { text } = require('./handle');

function register({ handle, tasks }) {
  handle('tasks:list', () => tasks.list());
  handle('tasks:history', (limit) => tasks.recent(limit));
  // Par identifiant : rien sans identifiant (l'ancien task:cancel visait la tâche affichée).
  handle('tasks:cancel', (id) => Boolean(text(id)) && tasks.cancel(text(id)));
  handle('tasks:clearHistory', () => {
    tasks.clearHistory();
  });
  // Ancien canal (avant la page Activité) : annule la tâche longue affichée.
  handle('task:cancel', () => {
    tasks.cancel();
  });
}

module.exports = { register };
