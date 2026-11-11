// @ts-check
'use strict';

// Gestionnaire de tâches longues (installation de modpack, sauvegarde, import…) : file triée par priorité,
// nombre de tâches simultanées limité (globalement, par groupe, une seule à la fois par instance),
// états, annulation, événements vers l'interface et historique dans launcher.db.
//
// Phase 5 (page Activité) : les tâches longues attendent leur tour au lieu d'être refusées (deux à la fois, une seule
// par instance, jamais sur une instance en cours de partie). La préparation d'une partie est une tâche « immédiate » :
// elle démarre toujours tout de suite et ne prend pas de place dans la limite.
// « task:progress » (plus ancienne tâche longue en cours) reste envoyé tel qu'avant la phase 5.
const { EventEmitter } = require('node:events');
const { t } = require('../i18n');

/** @typedef {'queued' | 'running' | 'done' | 'failed' | 'cancelled'} TaskState */
/** @typedef {'high' | 'normal' | 'low'} Priority */
/**
 * @typedef {object} Task
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {string | null} instanceId
 * @property {string | null} group
 * @property {Priority} priority
 * @property {boolean} cancellable
 * @property {boolean} hidden travail de fond : absent de l'Activité, ne compte pas comme occupé
 * @property {boolean} immediate démarre tout de suite, hors limite (préparation d'une partie)
 * @property {any} params
 * @property {TaskState} state
 * @property {number} seq
 * @property {number} createdAt
 * @property {number | null} startedAt
 * @property {number | null} endedAt
 * @property {string | null} error
 * @property {{ label: string, done: number, total: number, doneBytes?: number, totalBytes?: number, speed?: number, eta?: number, step?: number }} progress
 * @property {AbortController} controller
 * @property {(ctx: { signal: AbortSignal, progress: (p: { label?: string, done: number, total: number }) => void }) => any} work
 * @property {(value: any) => void} resolve
 * @property {(error: any) => void} reject
 */

const RANK = { high: 0, normal: 1, low: 2 };
const GROUP_LIMITS = {};
const EVENT_INTERVAL = 100; // au plus 10 envois par seconde de la liste des tâches
// Octets, vitesse, temps restant (téléchargements) et étape (préparation d'une partie) : seulement quand ils sont connus.
const EXTRA_FIELDS = ['doneBytes', 'totalBytes', 'speed', 'eta', 'step'];
const HISTORY_SIZE = 50;

/** Contenu de « task:progress », inchangé depuis la phase 2 : l'interface d'aujourd'hui n'attend que ces quatre champs. @param {Task} task */
const progressPayload = (task) => ({ label: task.progress.label, done: task.progress.done, total: task.progress.total, cancellable: task.cancellable });

class TaskManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {() => any} [options.getWindow] fenêtre qui reçoit « task:progress » et « tasks:changed »
   * @param {{ recordTask: (task: object) => any } | null} [options.history] launcher.db
   * @param {number} [options.limit] tâches simultanées au plus
   * @param {() => number} [options.now]
   * @param {(instanceId: string) => boolean} [options.inGame] instance en cours de partie : ses tâches attendent la fin
   */
  constructor({ getWindow = () => null, history = null, limit = 2, now = Date.now, inGame = () => false } = {}) {
    super();
    this.getWindow = getWindow;
    /** @type {{ recordTask: (task: object) => any, recentTasks?: (limit: number) => any[], clearTasks?: () => any } | null} */
    this.history = history;
    this.inGame = inGame;
    this.limit = limit;
    this.now = now;
    /** @type {Task[]} */
    this.tasks = []; // en attente et en cours
    this.seq = 0;
    /** @type {NodeJS.Timeout | null} */
    this.timer = null;
    this.lastSent = 0;
    /** @type {Task | null} */
    this.shown = null; // tâche dont « task:progress » montre la progression
  }

  /** @param {string} channel @param {any} payload */
  send(channel, payload) {
    const win = this.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  /**
   * Ajoute une tâche ; la promesse rend le résultat de `work`.
   * @param {{ kind: string, label: string, work: Task['work'], instanceId?: string | null, group?: string | null, priority?: Priority, cancellable?: boolean, hidden?: boolean, immediate?: boolean, params?: any }} options
   */
  run({ kind, label, work, instanceId = null, group = null, priority = 'normal', cancellable = false, hidden = false, immediate = false, params = null }) {
    return new Promise((resolve, reject) => {
      const createdAt = this.now();
      /** @type {Task} */
      const task = {
        id: `${createdAt.toString(36)}-${++this.seq}`,
        kind,
        label,
        instanceId,
        group,
        priority: priority in RANK ? priority : 'normal',
        cancellable,
        hidden,
        immediate,
        params,
        state: 'queued',
        seq: this.seq,
        createdAt,
        startedAt: null,
        endedAt: null,
        error: null,
        progress: { label, done: 0, total: 0 },
        controller: new AbortController(),
        work,
        resolve,
        reject,
      };
      this.tasks.push(task);
      if (immediate) this.start(task);
      else {
        this.changed(true);
        this.pump();
      }
    });
  }

  running() {
    return this.tasks.filter((task) => task.state === 'running');
  }

  /** @param {Task} task */
  canStart(task) {
    const running = this.running();
    if (running.filter((r) => !r.immediate).length >= this.limit) return false;
    if (task.group && running.filter((r) => r.group === task.group).length >= (GROUP_LIMITS[task.group] ?? Infinity)) return false;
    if (task.instanceId && (running.some((r) => r.instanceId === task.instanceId) || this.inGame(task.instanceId))) return false;
    return true;
  }

  /** Tâche longue en cours sur cette instance (la partie ne démarre pas pendant ce temps). @param {string} instanceId */
  runningOn(instanceId) {
    const task = this.running().find((r) => r.instanceId === instanceId && !r.immediate);
    return task ? this.snapshot(task) : null;
  }

  /** Démarre ce qui peut l'être, par priorité puis ordre d'arrivée. */
  pump() {
    const queued = this.tasks.filter((task) => task.state === 'queued').sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq);
    for (const task of queued) if (this.canStart(task)) this.start(task);
  }

  /** @param {Task} task */
  start(task) {
    task.state = 'running';
    task.startedAt = this.now();
    this.showProgress();
    this.changed(true);
    const progress = (p) => {
      if (task.state !== 'running') return;
      task.progress = { label: p.label ?? task.label, done: p.done, total: p.total };
      // Téléchargement : octets, vitesse et temps restant ; partie : étape. Pour la page Activité (tasks:changed).
      for (const key of EXTRA_FIELDS) if (p[key] != null) task.progress[key] = p[key];
      if (this.shown === task) this.send('task:progress', progressPayload(task));
      this.changed(false);
    };
    let result;
    try {
      result = Promise.resolve(task.work({ signal: task.controller.signal, progress }));
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (value) => this.settle(task, 'done', null, value),
      // `cancelled` sur l'erreur : arrêtée ailleurs que par le signal (bouton Arrêter de l'accueil).
      (error) => this.settle(task, task.controller.signal.aborted || error?.cancelled === true ? 'cancelled' : 'failed', error),
    );
  }

  /**
   * État final, décidé une seule fois.
   * @param {Task} task @param {TaskState} state @param {any} error @param {any} [value]
   */
  settle(task, state, error, value) {
    if (task.state !== 'running' && task.state !== 'queued') return;
    task.state = state;
    task.endedAt = this.now();
    task.error = error ? String(error.message ?? error) : null;
    this.tasks = this.tasks.filter((other) => other !== task);
    const { label: _label, ...progress } = task.progress;
    this.history?.recordTask({
      id: task.id,
      kind: task.kind,
      label: task.label,
      instanceId: task.instanceId,
      state: task.state,
      createdAt: task.createdAt,
      startedAt: task.startedAt,
      endedAt: task.endedAt,
      error: task.error,
      params: task.params,
      progress,
      hidden: task.hidden,
    });
    if (this.shown === task) this.showProgress();
    this.changed(true);
    this.emit('settled', this.snapshot(task));
    if (state === 'done') task.resolve(value);
    else task.reject(error);
    this.pump();
  }

  /** « task:progress » suit la plus ancienne tâche longue en cours ; null quand il n'y en a plus. */
  showProgress() {
    const [first] = this.running()
      .filter((task) => !task.hidden && !task.immediate)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.seq - b.seq);
    if ((first ?? null) === this.shown) return;
    this.shown = first ?? null;
    this.send('task:progress', first ? progressPayload(first) : null);
  }

  /**
   * Annule une tâche : en attente, elle est retirée ; en cours, elle reçoit le signal si elle l'accepte.
   * Sans identifiant : la tâche affichée (comme l'ancien « task:cancel »).
   * @param {string} [id]
   */
  cancel(id) {
    const task = id == null ? this.shown : this.tasks.find((other) => other.id === id);
    if (!task) return false;
    if (task.state === 'queued') {
      this.settle(task, 'cancelled', new Error(t('ipc.tache_annulee_avant_debut', { task: task.label })));
      return true;
    }
    if (!task.cancellable) return false;
    task.controller.abort();
    return true;
  }

  /** Une tâche en attente ou en cours. */
  busy() {
    return this.tasks.some((task) => !task.hidden);
  }

  /** Nom de la tâche affichée, ou null. */
  current() {
    return this.shown?.label ?? null;
  }

  /** @param {Task} task */
  snapshot(task) {
    const { id, kind, label, instanceId, priority, cancellable, hidden, immediate, params, state, createdAt, startedAt, endedAt, error, progress } = task;
    return { id, kind, label, instanceId, priority, cancellable, hidden, immediate, params, state, createdAt, startedAt, endedAt, error, progress: { ...progress } };
  }

  /** Dernières tâches finies (launcher.db), de la plus récente à la plus ancienne, sans le travail de fond. */
  recent(limit = HISTORY_SIZE) {
    const size = Math.max(1, Math.min(HISTORY_SIZE, Math.floor(Number(limit)) || HISTORY_SIZE));
    // Un peu plus que demandé : le travail de fond est retiré après lecture.
    const rows = this.history?.recentTasks?.(size * 2) ?? [];
    return rows
      // Lignes d'avant la phase 5 : pas de drapeau « travail de fond », le nettoyage est reconnu à son type.
      .filter((row) => !row.hidden && row.kind !== 'temp-cleanup')
      .slice(0, size)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        label: row.label,
        instanceId: row.instance_id,
        state: row.state,
        createdAt: row.created_at,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        error: row.error,
        params: row.params,
        progress: row.progress,
      }));
  }

  /** Efface l'historique des tâches finies (les tâches en cours ne sont pas touchées). */
  clearHistory() {
    this.history?.clearTasks?.();
  }

  /** Tâches en attente et en cours, dans l'ordre où elles passeront. */
  list() {
    return [...this.tasks].sort((a, b) => (a.state === b.state ? 0 : a.state === 'running' ? -1 : 1) || RANK[a.priority] - RANK[b.priority] || a.seq - b.seq).map((task) => this.snapshot(task));
  }

  /**
   * « tasks:changed » : tout de suite pour un changement d'état, sinon au plus toutes les 100 ms.
   * @param {boolean} immediate
   */
  changed(immediate) {
    const flush = () => {
      this.timer = null;
      this.lastSent = this.now();
      this.send('tasks:changed', this.list());
    };
    if (immediate) {
      if (this.timer) clearTimeout(this.timer);
      flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(flush, Math.max(0, EVENT_INTERVAL - (this.now() - this.lastSent)));
    this.timer.unref?.();
  }

  /**
   * Tâche longue lancée depuis l'interface : attend son tour dans la file (`onProgress`, `signal` comme l'ancien runTask).
   * @template T
   * @param {string} label
   * @param {(onProgress: (p: { label?: string, done: number, total: number, doneBytes?: number, totalBytes?: number, speed?: number | null, eta?: number | null }) => void, signal?: AbortSignal) => Promise<T>} work
   * @param {{ cancellable?: boolean, kind?: string, instanceId?: string | null, params?: any, priority?: Priority }} [options]
   * @returns {Promise<T>}
   */
  runLong(label, work, { cancellable = false, kind = 'task', instanceId = null, params = null, priority = 'normal' } = {}) {
    return this.run({
      kind,
      label,
      instanceId,
      params,
      priority,
      cancellable,
      // Les tâches non annulables ne recevaient pas de signal.
      work: ({ signal, progress }) => work(progress, cancellable ? signal : undefined),
    });
  }
}

module.exports = { TaskManager };
