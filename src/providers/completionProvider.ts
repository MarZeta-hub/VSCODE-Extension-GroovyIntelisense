import * as vscode from 'vscode';
import { CandidateKind, CompletionCandidate } from '../core/api';
import { EngineAccess, errorMessage, toRange } from './common';

export const COMPLETION_TRIGGERS = ['.', '@', ':'];

const KIND_MAP: Record<CandidateKind, vscode.CompletionItemKind> = {
  method: vscode.CompletionItemKind.Method,
  field: vscode.CompletionItemKind.Field,
  property: vscode.CompletionItemKind.Property,
  variable: vscode.CompletionItemKind.Variable,
  class: vscode.CompletionItemKind.Class,
  interface: vscode.CompletionItemKind.Interface,
  enum: vscode.CompletionItemKind.Enum,
  enumMember: vscode.CompletionItemKind.EnumMember,
  keyword: vscode.CompletionItemKind.Keyword,
  snippet: vscode.CompletionItemKind.Snippet,
  module: vscode.CompletionItemKind.Module,
  constructor: vscode.CompletionItemKind.Constructor,
  constant: vscode.CompletionItemKind.Constant,
  typeParameter: vscode.CompletionItemKind.TypeParameter,
};

export class GroovyCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly access: EngineAccess) {}

  async provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext,
  ): Promise<vscode.CompletionList | undefined> {
    const offset = doc.offsetAt(position);
    const text = doc.getText();
    // ':' only triggers for method references (`::`).
    if (context.triggerKind === vscode.CompletionTriggerKind.TriggerCharacter && context.triggerCharacter === ':') {
      if (offset < 2 || text.charAt(offset - 2) !== ':') return undefined;
    }
    try {
      const engine = await this.access.getEngine();
      if (!engine || token.isCancellationRequested) return undefined;
      const t0 = Date.now();
      const res = await engine.complete(doc.uri.toString(), text, offset);
      if (token.isCancellationRequested) return undefined;
      this.access.trace(`completion: ${res.items.length} items en ${Date.now() - t0}ms (incomplete=${res.isIncomplete})`);

      // Ranges must be single-line and contain the cursor.
      let start = doc.positionAt(Math.min(res.replaceStart, offset));
      let end = doc.positionAt(Math.max(res.replaceEnd, offset));
      if (start.line !== position.line) start = position;
      if (end.line !== position.line) end = position;
      const range = { inserting: new vscode.Range(start, position), replacing: new vscode.Range(start, end) };
      const autoImport = this.access.autoImport();
      const items = res.items.map((c) => this.toItem(doc, c, range, autoImport));
      return new vscode.CompletionList(items, res.isIncomplete);
    } catch (e) {
      this.access.log(`[completion] error: ${errorMessage(e)}`);
      return undefined;
    }
  }

  private toItem(
    doc: vscode.TextDocument,
    c: CompletionCandidate,
    range: { inserting: vscode.Range; replacing: vscode.Range },
    autoImport: boolean,
  ): vscode.CompletionItem {
    const item = new vscode.CompletionItem(
      { label: c.label, detail: c.labelDetail, description: c.description },
      KIND_MAP[c.kind] ?? vscode.CompletionItemKind.Text,
    );
    if (c.detail) item.detail = c.detail;
    if (c.documentation) item.documentation = new vscode.MarkdownString(c.documentation);
    const insert = c.insertText ?? c.label;
    item.insertText = c.isSnippet ? new vscode.SnippetString(insert) : insert;
    if (c.sortText) item.sortText = c.sortText;
    // Without an explicit filterText VS Code would filter on the label object's `label`, which is what we want.
    if (c.filterText) item.filterText = c.filterText;
    item.range = range;
    if (autoImport && c.additionalEdits?.length) {
      item.additionalTextEdits = c.additionalEdits.map((e) => new vscode.TextEdit(toRange(doc, e.start, e.end), e.newText));
    }
    if (c.triggerSignatureHelp) {
      item.command = { title: 'Parameter hints', command: 'editor.action.triggerParameterHints' };
    } else if (c.retriggerCompletion) {
      item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
    }
    if (c.deprecated) item.tags = [vscode.CompletionItemTag.Deprecated];
    if (c.preselect) item.preselect = true;
    return item;
  }
}
