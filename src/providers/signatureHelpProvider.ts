import * as vscode from 'vscode';
import { EngineAccess, errorMessage } from './common';

export const SIGNATURE_METADATA: vscode.SignatureHelpProviderMetadata = {
  triggerCharacters: ['(', ','],
  retriggerCharacters: [')'],
};

export class GroovySignatureHelpProvider implements vscode.SignatureHelpProvider {
  constructor(private readonly access: EngineAccess) {}

  async provideSignatureHelp(
    doc: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.SignatureHelp | undefined> {
    try {
      const engine = await this.access.getEngine();
      if (!engine || token.isCancellationRequested) return undefined;
      const res = await engine.signatureHelp(doc.uri.toString(), doc.getText(), doc.offsetAt(position));
      if (!res || res.signatures.length === 0 || token.isCancellationRequested) return undefined;
      const help = new vscode.SignatureHelp();
      help.signatures = res.signatures.map((s) => {
        const sig = new vscode.SignatureInformation(
          s.label,
          s.documentation ? new vscode.MarkdownString(s.documentation) : undefined,
        );
        sig.parameters = s.params.map(
          (p) =>
            new vscode.ParameterInformation(p.label, p.documentation ? new vscode.MarkdownString(p.documentation) : undefined),
        );
        return sig;
      });
      help.activeSignature = Math.max(0, Math.min(res.activeSignature, help.signatures.length - 1));
      help.activeParameter = Math.max(0, res.activeParameter);
      return help;
    } catch (e) {
      this.access.log(`[signatureHelp] error: ${errorMessage(e)}`);
      return undefined;
    }
  }
}
