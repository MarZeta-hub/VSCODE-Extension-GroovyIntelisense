// Tolerant Groovy/Java tokenizer. Comments are not emitted as tokens but collected separately.

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'gstring' | 'regex' | 'op';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  /** True when at least one line break separates this token from the previous one. */
  nl: boolean;
  /** For strings: false when the closing delimiter was not found. */
  terminated?: boolean;
}

export interface Comment {
  start: number;
  end: number;
  text: string;
  block: boolean;
}

export interface TokenizeResult {
  tokens: Token[];
  comments: Comment[];
}

export const KEYWORDS = new Set([
  'as', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default', 'do', 'else', 'enum',
  'extends', 'false', 'finally', 'for', 'goto', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'new',
  'null', 'package', 'return', 'super', 'switch', 'this', 'throw', 'throws', 'trait', 'true', 'try', 'var', 'while',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'transient', 'volatile',
  'strictfp', 'void', 'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'record', 'sealed',
  'permits', 'yield',
]);

/** Keywords that behave like values in expressions (a slashy string cannot follow them). */
const VALUE_KEYWORDS = new Set(['this', 'super', 'true', 'false', 'null']);

// Note: `>>`, `>>>` and `>>=` are intentionally not produced so that nested generics (`List<List<String>>`) tokenize as single `>`.
const OPERATORS = [
  '..<', '<=>', '===', '!==', '==~', '<<=', '**=', '?.@',
  '?.', '*.', '.&', '.@', '::', '..', '->', '=~', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=',
  '/=', '%=', '&=', '|=', '^=', '**', '<<', '?:', '?[',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '@', '=', '>', '<', '!', '~', '?', ':', '+', '-', '*', '/', '&', '|',
  '^', '%', '#', '\\',
];

export const DOT_OPERATORS = new Set(['.', '?.', '*.', '.&', '.@', '?.@', '::']);

function isIdentStart(c: string): boolean {
  return /[A-Za-z_$À-￿]/.test(c);
}

function isIdentPart(c: string): boolean {
  return /[A-Za-z0-9_$À-￿]/.test(c);
}

export function tokenize(text: string): TokenizeResult {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const n = text.length;
  let i = 0;
  let nl = false;

  if (text.startsWith('#!')) {
    while (i < n && text[i] !== '\n') i++;
  }

  const push = (kind: TokenKind, start: number, end: number, terminated?: boolean) => {
    const t: Token = { kind, text: text.slice(start, end), start, end, nl };
    if (terminated !== undefined) t.terminated = terminated;
    tokens.push(t);
    nl = false;
  };

  const prevSignificant = (): Token | undefined => tokens[tokens.length - 1];

  const slashyAllowed = (): boolean => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.kind === 'op') return !(p.text === ')' || p.text === ']' || p.text === '}');
    if (p.kind === 'keyword') return !VALUE_KEYWORDS.has(p.text);
    return false;
  };

  /** Scans a `${ ... }` interpolation starting at the `{`; returns the index after the matching `}`. */
  const skipInterpolation = (j: number): number => {
    let depth = 0;
    while (j < n) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return j + 1;
      } else if (c === '"' || c === "'") {
        const q = c;
        j++;
        while (j < n && text[j] !== q && text[j] !== '\n') {
          if (text[j] === '\\') j++;
          j++;
        }
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = text[i];

    if (c === '\n') { nl = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === ' ' || c === '﻿') { i++; continue; }

    // Comments
    if (c === '/' && text[i + 1] === '/') {
      const s = i;
      while (i < n && text[i] !== '\n') i++;
      comments.push({ start: s, end: i, text: text.slice(s, i), block: false });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const s = i;
      const e = text.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      const body = text.slice(s, i);
      if (body.includes('\n')) nl = true;
      comments.push({ start: s, end: i, text: body, block: true });
      continue;
    }

    // Strings
    if (c === '"' || c === "'") {
      const s = i;
      const triple = text.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      i += delim.length;
      let terminated = false;
      let interpolated = false;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (!triple && text[i] === '\n') break;
        if (c === '"' && text[i] === '$' && text[i + 1] === '{') {
          interpolated = true;
          i = skipInterpolation(i + 1);
          continue;
        }
        if (c === '"' && text[i] === '$' && isIdentStart(text[i + 1] ?? '')) interpolated = true;
        if (text.startsWith(delim, i)) { i += delim.length; terminated = true; break; }
        i++;
      }
      push(interpolated ? 'gstring' : 'string', s, Math.min(i, n), terminated);
      continue;
    }

    // Dollar-slashy string $/ ... /$
    if (c === '$' && text[i + 1] === '/') {
      const s = i;
      const e = text.indexOf('/$', i + 2);
      i = e < 0 ? n : e + 2;
      push('regex', s, i, e >= 0);
      continue;
    }

    // Slashy string /regex/
    if (c === '/' && text[i + 1] !== '=' && slashyAllowed()) {
      const s = i;
      i++;
      let terminated = false;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '\n') break;
        if (text[i] === '$' && text[i + 1] === '{') { i = skipInterpolation(i + 1); continue; }
        if (text[i] === '/') { i++; terminated = true; break; }
        i++;
      }
      if (terminated) { push('regex', s, i, true); continue; }
      i = s; // not a regex after all: fall through to operator
    }

    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? '') && !(prevSignificant()?.kind === 'ident'))) {
      const s = i;
      if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(text[i])) i++;
      } else if (c === '0' && /[bB]/.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[01_]/.test(text[i])) i++;
      } else {
        while (i < n && /[0-9_]/.test(text[i])) i++;
        if (text[i] === '.' && /[0-9]/.test(text[i + 1] ?? '')) {
          i++;
          while (i < n && /[0-9_]/.test(text[i])) i++;
        }
        if (/[eE]/.test(text[i] ?? '') && /[0-9+-]/.test(text[i + 1] ?? '')) {
          i += 2;
          while (i < n && /[0-9]/.test(text[i])) i++;
        }
      }
      if (/[lLgGiIdDfF]/.test(text[i] ?? '') && !isIdentPart(text[i + 1] ?? '')) i++;
      push('number', s, i);
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(c)) {
      const s = i;
      i++;
      while (i < n && isIdentPart(text[i])) i++;
      const word = text.slice(s, i);
      const p = prevSignificant();
      const afterDot = p !== undefined && p.kind === 'op' && DOT_OPERATORS.has(p.text);
      push(KEYWORDS.has(word) && !afterDot ? 'keyword' : 'ident', s, i);
      continue;
    }

    // Operators
    let matched = false;
    for (const op of OPERATORS) {
      if (text.startsWith(op, i)) {
        // `?.` followed by a digit is a ternary with a decimal number: `a ?.5 : 1`
        if (op === '?.' && /[0-9]/.test(text[i + 2] ?? '')) continue;
        push('op', i, i + op.length);
        i += op.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      push('op', i, i + 1);
      i++;
    }
  }

  return { tokens, comments };
}

export function isIdentLike(t: Token | undefined): boolean {
  return !!t && (t.kind === 'ident' || (t.kind === 'keyword' && (t.text === 'this' || t.text === 'super')));
}

export function isOp(t: Token | undefined, text?: string): boolean {
  return !!t && t.kind === 'op' && (text === undefined || t.text === text);
}

/** Index of the token that contains or ends at `offset`, or the last token whose start is < offset. -1 if none. */
export function tokenIndexBefore(tokens: Token[], offset: number): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].start < offset) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '?[': ']' };
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Given the index of an opening bracket, returns the index of the matching closer (or tokens.length). */
export function matchForward(tokens: Token[], openIdx: number): number {
  let depth = 0;
  for (let j = openIdx; j < tokens.length; j++) {
    const t = tokens[j];
    if (t.kind !== 'op') continue;
    if (OPENERS[t.text]) depth++;
    else if (CLOSERS[t.text]) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length;
}

/** Given the index of a closing bracket, returns the index of the matching opener (or -1). */
export function matchBackward(tokens: Token[], closeIdx: number): number {
  let depth = 0;
  for (let j = closeIdx; j >= 0; j--) {
    const t = tokens[j];
    if (t.kind !== 'op') continue;
    if (CLOSERS[t.text]) depth++;
    else if (OPENERS[t.text]) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}
