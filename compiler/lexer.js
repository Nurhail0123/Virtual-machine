/*
 * lexer.js — Tokenizer untuk Lua 5.1 / Luau (subset gabungan)
 * ============================================================================
 */
'use strict';

const TT = {
  EOF: 'eof', NAME: 'name', NUMBER: 'number', STRING: 'string',
  // keywords
  AND:'and', BREAK:'break', DO:'do', ELSE:'else', ELSEIF:'elseif', END:'end',
  FALSE:'false', FOR:'for', FUNCTION:'function', IF:'if', IN:'in',
  LOCAL:'local', NIL:'nil', NOT:'not', OR:'or', REPEAT:'repeat', RETURN:'return',
  THEN:'then', TRUE:'true', UNTIL:'until', WHILE:'while', CONTINUE:'continue',
  // symbols
  PLUS:'+', MINUS:'-', STAR:'*', SLASH:'/', DSLASH:'//', PERCENT:'%', CARET:'^', HASH:'#',
  EQ:'==', NE:'~=', LE:'<=', GE:'>=', LT:'<', GT:'>', ASSIGN:'=',
  LPAREN:'(', RPAREN:')', LBRACE:'{', RBRACE:'}', LBRACKET:'[', RBRACKET:']',
  SEMI:';', COLON:':', DCOLON:'::', COMMA:',', DOT:'.', DDOT:'..', ELLIPSIS:'...',
  PLUS_EQ:'+=', MINUS_EQ:'-=', STAR_EQ:'*=', SLASH_EQ:'/=', DSLASH_EQ:'//=',
  PERCENT_EQ:'%=', CARET_EQ:'^=', DDOT_EQ:'..=',
};

const KEYWORDS = {
  and: TT.AND, break: TT.BREAK, do: TT.DO, else: TT.ELSE, elseif: TT.ELSEIF,
  end: TT.END, false: TT.FALSE, for: TT.FOR, function: TT.FUNCTION, if: TT.IF,
  in: TT.IN, local: TT.LOCAL, nil: TT.NIL, not: TT.NOT, or: TT.OR,
  repeat: TT.REPEAT, return: TT.RETURN, then: TT.THEN, true: TT.TRUE,
  until: TT.UNTIL, while: TT.WHILE, continue: TT.CONTINUE,
};

class LexError extends Error {}

class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.line = 1;
  }
  peek(off = 0) { const i = this.pos + off; return i < this.src.length ? this.src[i] : null; }
  advanceChar() {
    const c = this.peek();
    if (c === '\n') this.line++;
    if (c !== null) this.pos++;
    return c;
  }
  isDigit(c) { return c !== null && c >= '0' && c <= '9'; }
  isAlpha(c) { return c !== null && (/[A-Za-z_]/.test(c)); }
  isAlnum(c) { return c !== null && (/[A-Za-z0-9_]/.test(c)); }

  skipWhitespaceAndComments() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.advanceChar(); continue; }
      if (c === '-' && this.peek(1) === '-') {
        this.pos += 2;
        if (this.peek() === '[') {
          const save = this.pos;
          let eq = 0, p = this.pos + 1;
          while (this.src[p] === '=') { eq++; p++; }
          if (this.src[p] === '[') {
            this.pos = p + 1;
            const close = ']' + '='.repeat(eq) + ']';
            const endp = this.src.indexOf(close, this.pos);
            if (endp === -1) { this.pos = this.src.length; }
            else {
              for (let i = this.pos; i < endp; i++) if (this.src[i] === '\n') this.line++;
              this.pos = endp + close.length;
            }
            continue;
          } else {
            this.pos = save;
          }
        }
        while (this.peek() !== null && this.peek() !== '\n') this.advanceChar();
        continue;
      }
      break;
    }
  }

  next() {
    this.skipWhitespaceAndComments();
    const line = this.line;
    const c = this.peek();
    if (c === null) return { type: TT.EOF, text: '', line };

    if (this.isAlpha(c)) {
      let id = '';
      while (this.isAlnum(this.peek())) id += this.advanceChar();
      const kw = KEYWORDS[id];
      return { type: kw || TT.NAME, text: id, line };
    }
    if (this.isDigit(c) || (c === '.' && this.isDigit(this.peek(1)))) {
      let num = '';
      let isHex = false;
      if (c === '0' && (this.peek(1) === 'x' || this.peek(1) === 'X')) {
        num += this.advanceChar(); num += this.advanceChar();
        isHex = true;
        while (/[0-9a-fA-F]/.test(this.peek() || '')) num += this.advanceChar();
      } else {
        while (this.isDigit(this.peek())) num += this.advanceChar();
        if (this.peek() === '.') { num += this.advanceChar(); while (this.isDigit(this.peek())) num += this.advanceChar(); }
        if (this.peek() === 'e' || this.peek() === 'E') {
          num += this.advanceChar();
          if (this.peek() === '+' || this.peek() === '-') num += this.advanceChar();
          while (this.isDigit(this.peek())) num += this.advanceChar();
        }
      }
      const value = isHex ? parseInt(num, 16) : parseFloat(num);
      return { type: TT.NUMBER, text: num, value, line };
    }
    if (c === '"' || c === "'") {
      const quote = this.advanceChar();
      let s = '';
      while (this.peek() !== null && this.peek() !== quote) {
        let ch = this.advanceChar();
        if (ch === '\\') {
          const e = this.advanceChar();
          switch (e) {
            case 'n': s += '\n'; break;
            case 't': s += '\t'; break;
            case 'r': s += '\r'; break;
            case 'a': s += '\x07'; break;
            case 'b': s += '\b'; break;
            case 'f': s += '\f'; break;
            case 'v': s += '\v'; break;
            case '\\': s += '\\'; break;
            case '"': s += '"'; break;
            case "'": s += "'"; break;
            case '\n': s += '\n'; break;
            default:
              if (this.isDigit(e)) {
                let d = e;
                for (let i = 0; i < 2 && this.isDigit(this.peek()); i++) d += this.advanceChar();
                s += String.fromCharCode(parseInt(d, 10));
              } else {
                s += e;
              }
          }
        } else {
          s += ch;
        }
      }
      this.advanceChar(); // closing quote
      return { type: TT.STRING, text: s, line };
    }
    if (c === '[' && (this.peek(1) === '[' || this.peek(1) === '=')) {
      const save = this.pos;
      let p = this.pos + 1, eq = 0;
      while (this.src[p] === '=') { eq++; p++; }
      if (this.src[p] === '[') {
        this.pos = p + 1;
        if (this.peek() === '\n') this.advanceChar();
        const close = ']' + '='.repeat(eq) + ']';
        const endp = this.src.indexOf(close, this.pos);
        let s;
        if (endp === -1) { s = this.src.slice(this.pos); this.pos = this.src.length; }
        else {
          s = this.src.slice(this.pos, endp);
          for (const ch of s) if (ch === '\n') this.line++;
          this.pos = endp + close.length;
        }
        return { type: TT.STRING, text: s, line };
      } else {
        this.pos = save;
      }
    }

    this.advanceChar();
    switch (c) {
      case '+': if (this.peek() === '=') { this.advanceChar(); return { type: TT.PLUS_EQ, text:'+=', line }; } return { type: TT.PLUS, text:'+', line };
      case '-': if (this.peek() === '=') { this.advanceChar(); return { type: TT.MINUS_EQ, text:'-=', line }; } return { type: TT.MINUS, text:'-', line };
      case '*': if (this.peek() === '=') { this.advanceChar(); return { type: TT.STAR_EQ, text:'*=', line }; } return { type: TT.STAR, text:'*', line };
      case '/':
        if (this.peek() === '/') { this.advanceChar(); if (this.peek()==='=') { this.advanceChar(); return {type:TT.DSLASH_EQ,text:'//=',line}; } return { type: TT.DSLASH, text:'//', line }; }
        if (this.peek() === '=') { this.advanceChar(); return { type: TT.SLASH_EQ, text:'/=', line }; }
        return { type: TT.SLASH, text:'/', line };
      case '%': if (this.peek() === '=') { this.advanceChar(); return { type: TT.PERCENT_EQ, text:'%=', line }; } return { type: TT.PERCENT, text:'%', line };
      case '^': if (this.peek() === '=') { this.advanceChar(); return { type: TT.CARET_EQ, text:'^=', line }; } return { type: TT.CARET, text:'^', line };
      case '#': return { type: TT.HASH, text:'#', line };
      case '=': if (this.peek() === '=') { this.advanceChar(); return { type: TT.EQ, text:'==', line }; } return { type: TT.ASSIGN, text:'=', line };
      case '~': if (this.peek() === '=') { this.advanceChar(); return { type: TT.NE, text:'~=', line }; } throw new LexError(`Unexpected '~' at line ${line}`);
      case '<': if (this.peek() === '=') { this.advanceChar(); return { type: TT.LE, text:'<=', line }; } return { type: TT.LT, text:'<', line };
      case '>': if (this.peek() === '=') { this.advanceChar(); return { type: TT.GE, text:'>=', line }; } return { type: TT.GT, text:'>', line };
      case '(': return { type: TT.LPAREN, text:'(', line };
      case ')': return { type: TT.RPAREN, text:')', line };
      case '{': return { type: TT.LBRACE, text:'{', line };
      case '}': return { type: TT.RBRACE, text:'}', line };
      case '[': return { type: TT.LBRACKET, text:'[', line };
      case ']': return { type: TT.RBRACKET, text:']', line };
      case ';': return { type: TT.SEMI, text:';', line };
      case ':': if (this.peek() === ':') { this.advanceChar(); return { type: TT.DCOLON, text:'::', line }; } return { type: TT.COLON, text:':', line };
      case ',': return { type: TT.COMMA, text:',', line };
      case '.':
        if (this.peek() === '.') {
          this.advanceChar();
          if (this.peek() === '.') { this.advanceChar(); return { type: TT.ELLIPSIS, text:'...', line }; }
          if (this.peek() === '=') { this.advanceChar(); return { type: TT.DDOT_EQ, text:'..=', line }; }
          return { type: TT.DDOT, text:'..', line };
        }
        return { type: TT.DOT, text:'.', line };
    }
    throw new LexError(`Unexpected character '${c}' at line ${line}`);
  }
}

module.exports = { Lexer, TT, LexError };
