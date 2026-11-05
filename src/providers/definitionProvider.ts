import * as vscode from 'vscode';
import { EngineAccess, errorMessage } from './common';

export class GroovyDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly access: EngineAccess) {}

  async provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[] | undefined> {
    try {
      const engine = await this.access.getEngine();
      if (!engine || token.isCancellationRequested) return undefined;
      const locs = await engine.definition(doc.uri.toString(), doc.getText(), doc.offsetAt(position));
      if (!locs.length || token.isCancellationRequested) return undefined;
      return locs.map((l) => new vscode.Location(vscode.Uri.parse(l.uri), new vscode.Position(l.line, l.character)));
    } catch (e) {
      this.access.log(`[definition] error: ${errorMessage(e)}`);
      return undefined;
    }
  }
}
