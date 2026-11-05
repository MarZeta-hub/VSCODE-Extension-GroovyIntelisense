import * as vscode from 'vscode';
import { EngineAccess, errorMessage, toRange } from './common';

export class GroovyHoverProvider implements vscode.HoverProvider {
  constructor(private readonly access: EngineAccess) {}

  async provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    try {
      const engine = await this.access.getEngine();
      if (!engine || token.isCancellationRequested) return undefined;
      const res = await engine.hover(doc.uri.toString(), doc.getText(), doc.offsetAt(position));
      if (!res || !res.contents || token.isCancellationRequested) return undefined;
      return new vscode.Hover(new vscode.MarkdownString(res.contents), toRange(doc, res.start, res.end));
    } catch (e) {
      this.access.log(`[hover] error: ${errorMessage(e)}`);
      return undefined;
    }
  }
}
