// VS Code entry point: wires the Groovy engine (src/core) to the editor.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageEngine } from './core/api';
import { GroovyServices } from './core/services';
import { CONFIG_SECTION, GroovyConfig, matchesGlob, readConfig, resolveClasspath } from './config';
import { EngineAccess, GROOVY_SELECTOR, errorMessage } from './providers/common';
import { COMPLETION_TRIGGERS, GroovyCompletionProvider } from './providers/completionProvider';
import { GroovyDefinitionProvider } from './providers/definitionProvider';
import { GroovyHoverProvider } from './providers/hoverProvider';
import { GroovySignatureHelpProvider, SIGNATURE_METADATA } from './providers/signatureHelpProvider';

const READY_TIMEOUT_MS = 10_000;
const DOC_DEBOUNCE_MS = 300;
const BATCH_SIZE = 50;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

class GroovyHost implements EngineAccess, vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Groovy IntelliSense');
  private readonly statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  private cfg: GroovyConfig = readConfig();
  private engine?: GroovyServices;
  private ready: Promise<void> = Promise.resolve();
  /** Bumped on every restart / reindex so stale background work stops. */
  private generation = 0;
  /** Bumped on every (re)index so a previous indexing pass stops. */
  private indexGen = 0;
  private disposed = false;
  private indexing = false;
  private readonly indexed = new Set<string>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private watcher?: vscode.FileSystemWatcher;
  private watcherSubs: vscode.Disposable[] = [];
  private restartTimer?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem.command = 'groovyIntellisense.showStatus';
    this.statusItem.name = 'Groovy IntelliSense';
    this.updateStatusBar();
    this.statusItem.show();
  }

  // ----- EngineAccess -----------------------------------------------------------------------------------------

  async getEngine(): Promise<LanguageEngine | undefined> {
    const engine = this.engine;
    if (!engine) return undefined;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.ready,
      new Promise<void>((resolve) => (timer = setTimeout(resolve, READY_TIMEOUT_MS))),
    ]);
    if (timer) clearTimeout(timer);
    return this.engine === engine ? engine : this.engine;
  }

  autoImport(): boolean {
    return this.cfg.autoImport;
  }

  log(msg: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  trace(msg: string): void {
    if (this.cfg.trace) this.log(msg);
  }

  // ----- Lifecycle --------------------------------------------------------------------------------------------

  /** (Re)creates the engine from the current settings and reindexes the workspace. Does not wait for indexing. */
  async start(): Promise<void> {
    const gen = ++this.generation;
    this.disposeEngine();
    this.cfg = readConfig();
    let cacheDir: string | undefined = this.context.globalStorageUri.fsPath;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch {
      cacheDir = undefined;
    }
    let initDone!: () => void;
    this.ready = new Promise<void>((resolve) => (initDone = resolve));
    this.updateStatusBar();
    try {
      this.updateStatusBar('resolviendo dependencias…');
      const classpath = await resolveClasspath(this.cfg, (m) => this.log(m), cacheDir);
      if (gen !== this.generation) {
        initDone();
        return;
      }
      this.log(`Iniciando motor (javaHome="${this.cfg.javaHome || 'auto'}", classpath: ${classpath.length} entrada(s))`);
      if (this.cfg.trace) classpath.forEach((c) => this.log(`  cp: ${c}`));
      const engine = new GroovyServices({
        javaHome: this.cfg.javaHome || undefined,
        classpath,
        cacheDir,
        log: (m) => this.log(m),
      });
      this.engine = engine;
      const t0 = Date.now();
      void engine
        .init()
        .catch((e) => this.log(`Error al iniciar el motor: ${errorMessage(e)}`))
        .finally(() => {
          initDone();
          if (gen !== this.generation) return;
          this.log(`Motor listo en ${Date.now() - t0}ms. ${this.safeStatus()}`);
          this.updateStatusBar();
        });
      this.createWatcher();
      void this.indexWorkspace();
    } catch (e) {
      this.log(`Error al iniciar: ${errorMessage(e)}`);
      initDone();
    }
  }

  scheduleRestart(reason = 'Configuración cambiada', delayMs = 500): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.log(`${reason}: reiniciando el motor`);
      void this.start();
    }, delayMs);
  }

  /** pom.xml changes alter the Maven classpath: restart (debounced, saves come in bursts). */
  onBuildFileChanged(uri: vscode.Uri): void {
    if (this.cfg.mavenMode === 'off' || uri.fsPath.split(path.sep).includes('target')) return;
    this.scheduleRestart(`Cambió ${vscode.workspace.asRelativePath(uri)}`, 2000);
  }

  reloadDependencies(): void {
    this.scheduleRestart('Recarga de dependencias solicitada', 0);
  }

  private disposeEngine(): void {
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
    this.indexed.clear();
    if (this.engine) {
      try {
        this.engine.dispose();
      } catch (e) {
        this.log(`Error al liberar el motor: ${errorMessage(e)}`);
      }
      this.engine = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.indexGen++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.disposeWatcher();
    this.disposeEngine();
    this.statusItem.dispose();
    this.output.dispose();
  }

  // ----- Workspace indexing -----------------------------------------------------------------------------------

  async indexWorkspace(): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    const gen = ++this.indexGen;
    const isStale = () => gen !== this.indexGen || this.engine !== engine;
    this.indexing = true;
    this.updateStatusBar('buscando archivos…');
    const t0 = Date.now();
    try {
      const uris = await vscode.workspace.findFiles(
        this.cfg.indexInclude,
        this.cfg.indexExclude || undefined,
        this.cfg.maxIndexedFiles,
      );
      if (isStale()) return;
      if (uris.length >= this.cfg.maxIndexedFiles) {
        this.log(`Aviso: se alcanzó el límite de ${this.cfg.maxIndexedFiles} archivos indexados (groovyIntellisense.maxIndexedFiles)`);
      }
      const openDocs = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
      let count = 0;
      for (const uri of uris) {
        const key = uri.toString();
        const open = openDocs.get(key);
        const text = open ? open.getText() : await this.readText(uri);
        if (isStale()) return;
        if (text !== undefined) this.update(engine, key, text);
        if (++count % BATCH_SIZE === 0) {
          this.updateStatusBar(`indexando ${count}/${uris.length}`);
          await yieldToLoop();
          if (isStale()) return;
        }
      }
      // Open documents outside the include pattern (e.g. Jenkinsfile) are indexed too.
      for (const doc of vscode.workspace.textDocuments) {
        if (this.isRelevantDoc(doc) && !this.indexed.has(doc.uri.toString())) this.update(engine, doc.uri.toString(), doc.getText());
      }
      this.log(`Indexados ${count} archivo(s) del workspace en ${Date.now() - t0}ms`);
    } catch (e) {
      this.log(`Error indexando el workspace: ${errorMessage(e)}`);
    } finally {
      if (!isStale()) {
        this.indexing = false;
        this.updateStatusBar();
      }
    }
  }

  private update(engine: LanguageEngine, uri: string, text: string): void {
    try {
      engine.updateFile(uri, text);
      this.indexed.add(uri);
    } catch (e) {
      this.log(`Error indexando ${uri}: ${errorMessage(e)}`);
    }
  }

  private remove(uri: string): void {
    if (!this.engine) return;
    // A deleted folder only reports its own uri: drop every indexed file below it.
    const prefix = uri.endsWith('/') ? uri : uri + '/';
    for (const u of [...this.indexed]) {
      if (u === uri || u.startsWith(prefix)) {
        try {
          this.engine.removeFile(u);
        } catch (e) {
          this.log(`Error eliminando ${u}: ${errorMessage(e)}`);
        }
        this.indexed.delete(u);
      }
    }
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch (e) {
      this.trace(`No se pudo leer ${uri.fsPath}: ${errorMessage(e)}`);
      return undefined;
    }
  }

  /** Workspace file matching the include pattern and not excluded. */
  private isIndexable(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri)) return false;
    const rel = vscode.workspace.asRelativePath(uri, false);
    if (!matchesGlob(rel, this.cfg.indexInclude)) return false;
    return !(this.cfg.indexExclude && matchesGlob(rel, this.cfg.indexExclude));
  }

  private isRelevantDoc(doc: vscode.TextDocument): boolean {
    if (doc.uri.scheme !== 'file') return false;
    return doc.languageId === 'groovy' || doc.languageId === 'java' || vscode.languages.match(GROOVY_SELECTOR, doc) > 0;
  }

  // ----- Open documents ---------------------------------------------------------------------------------------

  onDocumentOpened(doc: vscode.TextDocument): void {
    if (this.engine && this.isRelevantDoc(doc)) this.update(this.engine, doc.uri.toString(), doc.getText());
  }

  onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (e.contentChanges.length === 0 || !this.isRelevantDoc(doc)) return;
    const key = doc.uri.toString();
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev);
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        if (this.engine && !doc.isClosed) this.update(this.engine, key, doc.getText());
      }, DOC_DEBOUNCE_MS),
    );
  }

  async onDocumentClosed(doc: vscode.TextDocument): Promise<void> {
    if (!this.isRelevantDoc(doc)) return;
    const key = doc.uri.toString();
    const prev = this.pending.get(key);
    if (prev) clearTimeout(prev);
    this.pending.delete(key);
    // Unsaved edits are discarded on close: go back to the content on disk.
    if (this.isIndexable(doc.uri)) {
      const engine = this.engine;
      const text = await this.readText(doc.uri);
      if (engine && engine === this.engine) {
        if (text !== undefined) this.update(engine, key, text);
        else this.remove(key);
      }
    } else {
      this.remove(key);
    }
  }

  // ----- File system watcher ----------------------------------------------------------------------------------

  private createWatcher(): void {
    this.disposeWatcher();
    const watcher = vscode.workspace.createFileSystemWatcher(this.cfg.indexInclude);
    const onUpsert = async (uri: vscode.Uri) => {
      if (!this.isIndexable(uri)) return;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      if (open) {
        // Open documents are kept in sync by change events; ignore disk writes while dirty.
        if (!open.isDirty && this.engine) this.update(this.engine, uri.toString(), open.getText());
        return;
      }
      const engine = this.engine;
      const text = await this.readText(uri);
      if (engine && engine === this.engine && text !== undefined) {
        this.update(engine, uri.toString(), text);
        this.trace(`Reindexado ${vscode.workspace.asRelativePath(uri)}`);
      }
    };
    this.watcherSubs = [
      watcher,
      watcher.onDidCreate(onUpsert),
      watcher.onDidChange(onUpsert),
      watcher.onDidDelete((uri) => this.remove(uri.toString())),
    ];
    this.watcher = watcher;
  }

  private disposeWatcher(): void {
    this.watcherSubs.forEach((d) => d.dispose());
    this.watcherSubs = [];
    this.watcher = undefined;
  }

  // ----- Commands & status ------------------------------------------------------------------------------------

  async reindex(): Promise<void> {
    if (!this.engine) {
      await this.start();
      return;
    }
    this.indexed.clear();
    await this.indexWorkspace();
    vscode.window.showInformationMessage(`Groovy IntelliSense: workspace reindexado (${this.indexed.size} archivos).`);
  }

  clearCache(): void {
    if (!this.engine) return;
    try {
      this.engine.clearCaches();
      this.log('Caché de clases limpiada');
      vscode.window.showInformationMessage('Groovy IntelliSense: caché de clases limpiada.');
    } catch (e) {
      this.log(`Error limpiando caché: ${errorMessage(e)}`);
    }
  }

  showStatus(): void {
    const status = this.safeStatus();
    const msg = `${status}${this.indexing ? ' (indexando…)' : ''} · ${this.indexed.size} archivo(s) indexados`;
    this.log(`Estado: ${msg}`);
    this.output.show(true);
    vscode.window.showInformationMessage(`Groovy IntelliSense: ${msg}`);
  }

  private safeStatus(): string {
    if (!this.engine) return 'Motor no iniciado';
    try {
      return this.engine.status();
    } catch (e) {
      return `Estado no disponible (${e instanceof Error ? e.message : String(e)})`;
    }
  }

  private updateStatusBar(progress?: string): void {
    const busy = this.indexing || progress !== undefined;
    this.statusItem.text = busy ? `$(sync~spin) Groovy${progress ? ': ' + progress : ''}` : '$(symbol-class) Groovy';
    const tip = new vscode.MarkdownString(`**Groovy IntelliSense**\n\n${this.safeStatus()}\n\nArchivos indexados: ${this.indexed.size}`);
    tip.appendMarkdown('\n\n_Clic para ver el estado_');
    this.statusItem.tooltip = tip;
  }
}

let host: GroovyHost | undefined;

export function activate(context: vscode.ExtensionContext): void {
  host = new GroovyHost(context);
  const h = host;
  const pomWatcher = vscode.workspace.createFileSystemWatcher('**/pom.xml');
  context.subscriptions.push(
    pomWatcher,
    pomWatcher.onDidChange((u) => h.onBuildFileChanged(u)),
    pomWatcher.onDidCreate((u) => h.onBuildFileChanged(u)),
    pomWatcher.onDidDelete((u) => h.onBuildFileChanged(u)),
    vscode.commands.registerCommand('groovyIntellisense.reloadDependencies', () => h.reloadDependencies()),
    h,
    vscode.languages.registerCompletionItemProvider(GROOVY_SELECTOR, new GroovyCompletionProvider(h), ...COMPLETION_TRIGGERS),
    vscode.languages.registerSignatureHelpProvider(GROOVY_SELECTOR, new GroovySignatureHelpProvider(h), SIGNATURE_METADATA),
    vscode.languages.registerHoverProvider(GROOVY_SELECTOR, new GroovyHoverProvider(h)),
    vscode.languages.registerDefinitionProvider(GROOVY_SELECTOR, new GroovyDefinitionProvider(h)),
    vscode.workspace.onDidOpenTextDocument((d) => h.onDocumentOpened(d)),
    vscode.workspace.onDidChangeTextDocument((e) => h.onDocumentChanged(e)),
    vscode.workspace.onDidCloseTextDocument((d) => void h.onDocumentClosed(d)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) h.scheduleRestart();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => h.scheduleRestart()),
    vscode.commands.registerCommand('groovyIntellisense.reindex', () => h.reindex()),
    vscode.commands.registerCommand('groovyIntellisense.clearCache', () => h.clearCache()),
    vscode.commands.registerCommand('groovyIntellisense.showStatus', () => h.showStatus()),
  );
  // Providers are registered already; the engine initializes in the background.
  void h.start();
}

export function deactivate(): void {
  host?.dispose();
  host = undefined;
}
