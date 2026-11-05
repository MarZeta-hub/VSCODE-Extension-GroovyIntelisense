// Shared bits for the VS Code providers: document selector and access to the (lazily initialized) engine.
import * as vscode from 'vscode';
import { LanguageEngine } from '../core/api';

export const GROOVY_SELECTOR: vscode.DocumentSelector = [
  { language: 'groovy' },
  { scheme: 'file', pattern: '**/*.{groovy,gvy,gy,gsh}' },
  { pattern: '**/Jenkinsfile' },
];

export interface EngineAccess {
  /** Resolves with the engine once it is ready (or after a timeout), undefined when unavailable. */
  getEngine(): Promise<LanguageEngine | undefined>;
  autoImport(): boolean;
  log(msg: string): void;
  trace(msg: string): void;
}

export function toRange(doc: vscode.TextDocument, start: number, end: number): vscode.Range {
  return new vscode.Range(doc.positionAt(start), doc.positionAt(Math.max(start, end)));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.stack ?? e.message : String(e);
}
