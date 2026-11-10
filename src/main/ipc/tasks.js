'use strict';

// Tâches longues : liste des tâches en attente et en cours, annulation de la tâche affichée.

function register({ handle, tasks }) {
  handle('tasks:list', () => tasks.list());
  handle('task:cancel', () => {
    tasks.cancel();
  });
}

module.exports = { register };
