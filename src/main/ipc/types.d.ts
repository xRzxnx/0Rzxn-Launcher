// Types des messages entre l'interface (preload.js) et le processus principal.
// Contrôlés par test/ipc-contrat.test.js : la liste des canaux doit rester celle de preload.js.

/** Canaux appelés par l'interface (ipcRenderer.invoke). */
export type InvokeChannel =
  | 'accounts:addMicrosoft'
  | 'accounts:addOffline'
  | 'accounts:list'
  | 'accounts:refreshLooks'
  | 'accounts:remove'
  | 'accounts:setActive'
  | 'app:info'
  | 'content:delete'
  | 'content:import'
  | 'content:install'
  | 'content:list'
  | 'content:openFolder'
  | 'content:toggle'
  | 'content:update'
  | 'content:versionPlan'
  | 'crashes:list'
  | 'crashes:open'
  | 'crashes:openFolder'
  | 'crashes:read'
  | 'crashes:share'
  | 'dialog:pickJava'
  | 'discord:status'
  | 'gpu:set'
  | 'gpu:status'
  | 'import:instance'
  | 'import:pickInstances'
  | 'import:scanInstances'
  | 'instances:cleanBackground'
  | 'instances:create'
  | 'instances:delete'
  | 'instances:duplicate'
  | 'instances:export'
  | 'instances:list'
  | 'instances:openFolder'
  | 'instances:pickBackground'
  | 'instances:shortcut'
  | 'instances:update'
  | 'java:openRuntime'
  | 'java:removeRuntime'
  | 'java:runtimes'
  | 'java:system'
  | 'launch:start'
  | 'launch:state'
  | 'launch:stop'
  | 'launcher:get'
  | 'launcher:openFolder'
  | 'launcher:set'
  | 'launcher:setLanguage'
  | 'loaders:available'
  | 'modcheck:resolve'
  | 'modcheck:run'
  | 'modpacks:checkUpdate'
  | 'modpacks:import'
  | 'modpacks:install'
  | 'modpacks:update'
  | 'modrinth:project'
  | 'modrinth:search'
  | 'modrinth:versions'
  | 'modsets:apply'
  | 'modsets:create'
  | 'modsets:delete'
  | 'modsets:rename'
  | 'perf:installPack'
  | 'perf:metrics'
  | 'perf:pack'
  | 'perf:preview'
  | 'perf:ramGuide'
  | 'profiles:create'
  | 'profiles:installMods'
  | 'profiles:plan'
  | 'settings:get'
  | 'settings:update'
  | 'skins:apply'
  | 'skins:copyPlayer'
  | 'skins:import'
  | 'skins:library'
  | 'skins:remove'
  | 'skins:reset'
  | 'skins:setVariant'
  | 'skins:state'
  | 'stats:saveRecapImage'
  | 'storage:clean'
  | 'storage:plan'
  | 'storage:usage'
  | 'system:memory'
  | 'task:cancel'
  | 'tasks:cancel'
  | 'tasks:clearHistory'
  | 'tasks:history'
  | 'tasks:list'
  | 'titlemenu:apply'
  | 'titlemenu:auto'
  | 'titlemenu:disable'
  | 'titlemenu:status'
  | 'ui:get'
  | 'ui:set'
  | 'update:check'
  | 'update:install'
  | 'update:state'
  | 'versions:details'
  | 'versions:list'
  | 'worlds:backup'
  | 'worlds:delete'
  | 'worlds:deleteBackup'
  | 'worlds:list'
  | 'worlds:openFolder'
  | 'worlds:restore';

/** Ligne de log du jeu ou du launcher. */
export interface LogLine {
  time: string;
  tag: string;
  msg: string;
}

/** Partie en cours ou en préparation. */
export interface Run {
  instanceId: string;
  phase: 'preparing' | 'running';
  step: number;
  done: number;
  total: number;
  prepareOnly: boolean;
  startedAt?: number;
  /** Pendant un téléchargement : octets reçus, octets attendus, octets par seconde, secondes restantes. */
  doneBytes?: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
}

/** Changement d'état de la partie (« launch:status »). */
export interface LaunchStatus {
  run: Run | null;
  instanceId?: string;
  error?: string | null;
  cancelled?: boolean;
  prepared?: boolean;
  exited?: boolean;
  code?: number | null;
  crashed?: boolean;
  crash?: { source: string; file: string } | null;
}

/** Progression de la tâche longue (« task:progress ») ; null quand elle se termine. */
export type TaskProgress = { label: string; done: number; total: number; cancellable: boolean } | null;

/** Tâche en attente ou en cours (« tasks:changed »). */
export interface TaskSnapshot {
  id: string;
  kind: string;
  label: string;
  instanceId: string | null;
  priority: 'high' | 'normal' | 'low';
  cancellable: boolean;
  /** Travail de fond (nettoyage…) : absent de la page Activité. */
  hidden: boolean;
  /** Démarre tout de suite, hors limite (préparation d'une partie). */
  immediate: boolean;
  /** De quoi refaire le libellé dans la langue du moment (avec `kind`). */
  params: any;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  progress: { label: string; done: number; total: number; doneBytes?: number; totalBytes?: number; speed?: number; eta?: number; step?: number };
}

/** Tâche finie (« tasks:history », depuis launcher.db). */
export interface TaskRecord {
  id: string;
  kind: string;
  label: string | null;
  instanceId: string | null;
  state: 'done' | 'failed' | 'cancelled' | string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
  params: any;
  progress: { done?: number; total?: number; doneBytes?: number; totalBytes?: number; step?: number } | null;
}

/** Messages envoyés à l'interface (webContents.send) et leur contenu. */
export interface Events {
  'app:launchRequest': string;
  'launch:logs': LogLine[];
  'launch:progress': Run;
  'launch:reset': undefined;
  'launch:status': LaunchStatus;
  'task:progress': TaskProgress;
  'tasks:changed': TaskSnapshot[];
  'update:status': object;
}
