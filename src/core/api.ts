// Public, vscode-independent API of the Groovy language engine. Implemented by GroovyServices (services.ts),
// consumed by the VS Code providers (src/providers/*).
import { SourceLocation } from './model';

export type CandidateKind =
  | 'method' | 'field' | 'property' | 'variable' | 'class' | 'interface' | 'enum' | 'enumMember' | 'keyword'
  | 'snippet' | 'module' | 'constructor' | 'constant' | 'typeParameter';

export interface TextEdit {
  /** Offsets in the document text. */
  start: number;
  end: number;
  newText: string;
}

export interface CompletionCandidate {
  label: string;
  kind: CandidateKind;
  /** Shown right after the label, e.g. `(String s, int i)`. */
  labelDetail?: string;
  /** Shown right aligned, e.g. return type or package. */
  description?: string;
  /** One line detail shown in the details pane header. */
  detail?: string;
  /** Markdown documentation. */
  documentation?: string;
  /** Text to insert; when `isSnippet` it uses VS Code snippet syntax ($1, ${1:name}, $0). Defaults to label. */
  insertText?: string;
  isSnippet?: boolean;
  sortText?: string;
  filterText?: string;
  /** Extra edits applied on accept (e.g. auto-import). */
  additionalEdits?: TextEdit[];
  /** Open the parameter hints after inserting (methods with parameters). */
  triggerSignatureHelp?: boolean;
  /** Re-trigger completion after inserting (e.g. after inserting a package segment). */
  retriggerCompletion?: boolean;
  deprecated?: boolean;
  /** Mark as preselected. */
  preselect?: boolean;
}

export interface CompletionResult {
  items: CompletionCandidate[];
  /** True when the list was truncated and should be recomputed as the user keeps typing. */
  isIncomplete: boolean;
  /** Offsets of the word being completed (replacement range). */
  replaceStart: number;
  replaceEnd: number;
}

export interface SignatureParam {
  label: string;
  documentation?: string;
}

export interface SignatureInfo {
  label: string;
  documentation?: string;
  params: SignatureParam[];
}

export interface SignatureResult {
  signatures: SignatureInfo[];
  activeSignature: number;
  activeParameter: number;
}

export interface HoverResult {
  /** Markdown content. */
  contents: string;
  start: number;
  end: number;
}

export interface LanguageEngine {
  complete(uri: string, text: string, offset: number): Promise<CompletionResult>;
  signatureHelp(uri: string, text: string, offset: number): Promise<SignatureResult | undefined>;
  hover(uri: string, text: string, offset: number): Promise<HoverResult | undefined>;
  definition(uri: string, text: string, offset: number): Promise<SourceLocation[]>;
  /** Re-index a workspace file (open document changes or file system changes). */
  updateFile(uri: string, text: string): void;
  removeFile(uri: string): void;
  /** Drops computed member caches (after configuration changes). */
  clearCaches(): void;
  /** Short human readable status (JDK found, classes indexed...). */
  status(): string;
}
