/*
 * parser.js — Recursive-descent parser -> AST, untuk Lua 5.1 / Luau (subset)
 * ============================================================================
 */
'use strict';
const { Lexer, TT } = require('./lexer');

class ParseError extends Error {}

// ---- AST node helpers (plain objects, mudah di-serialize/debug) ----
function Node(type, extra) { return Object.assign({ type }, extra); }

const BLOCK_FOLLOW = new Set([TT.EOF, TT.ELSE, TT.ELSEIF, TT.END, TT.UNTIL]);

class Parser {
  constructor(src) {
    this.lex = new Lexer(src);
    this.cur = this.lex.next();
    this.aheadTok = null;
  }
  advance() {
    if (this.aheadTok) { this.cur = this.aheadTok; this.aheadTok = null; }
    else this.cur = this.lex.next();
  }
  peekAhead() {
    if (!this.aheadTok) this.aheadTok = this.lex.next();
    return this.aheadTok;
  }
  check(t) { return this.cur.type === t; }
  match(t) { if (this.check(t)) { this.advance(); return true; } return false; }
  expect(t, what) {
    if (!this.check(t)) {
      throw new ParseError(`Parse error line ${this.cur.line}: expected ${what} but got '${this.cur.text}'`);
    }
    const tok = this.cur;
    this.advance();
    return tok;
  }

  parseChunk() {
    const block = this.parseBlock();
    if (!this.check(TT.EOF)) {
      throw new ParseError(`Parse error line ${this.cur.line}: unexpected '${this.cur.text}'`);
    }
    return block;
  }

  blockFollow() { return BLOCK_FOLLOW.has(this.cur.type); }

  parseBlock() {
    const stats = [];
    while (!this.blockFollow()) {
      if (this.check(TT.RETURN)) { stats.push(this.parseReturn()); break; }
      const s = this.parseStatement();
      if (s) stats.push(s);
    }
    return stats;
  }

  parseReturn() {
    const line = this.cur.line;
    this.advance();
    const exprs = [];
    if (!this.blockFollow() && !this.check(TT.SEMI)) {
      exprs.push(this.parseExpr());
      while (this.match(TT.COMMA)) exprs.push(this.parseExpr());
    }
    this.match(TT.SEMI);
    return Node('Return', { line, exprs });
  }

  parseStatement() {
    const line = this.cur.line;
    switch (this.cur.type) {
      case TT.SEMI: this.advance(); return null;
      case TT.IF: return this.parseIf();
      case TT.WHILE: return this.parseWhile();
      case TT.DO: {
        this.advance();
        const body = this.parseBlock();
        this.expect(TT.END, "'end'");
        return Node('DoBlock', { line, body });
      }
      case TT.FOR: return this.parseFor();
      case TT.REPEAT: return this.parseRepeat();
      case TT.FUNCTION: return this.parseFunctionStat();
      case TT.LOCAL: return this.parseLocal();
      case TT.BREAK: this.advance(); return Node('Break', { line });
      case TT.CONTINUE: this.advance(); return Node('Continue', { line });
      case TT.DCOLON: this.advance(); this.advance(); this.expect(TT.DCOLON, "'::'"); return null; // label skip
      default: return this.parseExprStat();
    }
  }

  parseIf() {
    const line = this.cur.line;
    this.advance();
    const clauses = [];
    const cond = this.parseExpr();
    this.expect(TT.THEN, "'then'");
    const body = this.parseBlock();
    clauses.push({ cond, body });
    while (this.check(TT.ELSEIF)) {
      this.advance();
      const c2 = this.parseExpr();
      this.expect(TT.THEN, "'then'");
      const b2 = this.parseBlock();
      clauses.push({ cond: c2, body: b2 });
    }
    let elseBody = null;
    if (this.match(TT.ELSE)) elseBody = this.parseBlock();
    this.expect(TT.END, "'end'");
    return Node('If', { line, clauses, elseBody });
  }

  parseWhile() {
    const line = this.cur.line;
    this.advance();
    const cond = this.parseExpr();
    this.expect(TT.DO, "'do'");
    const body = this.parseBlock();
    this.expect(TT.END, "'end'");
    return Node('While', { line, cond, body });
  }

  parseRepeat() {
    const line = this.cur.line;
    this.advance();
    const body = this.parseBlock();
    this.expect(TT.UNTIL, "'until'");
    const cond = this.parseExpr();
    return Node('Repeat', { line, body, cond });
  }

  parseFor() {
    const line = this.cur.line;
    this.advance();
    const firstName = this.expect(TT.NAME, 'name').text;
    if (this.check(TT.ASSIGN)) {
      this.advance();
      const start = this.parseExpr();
      this.expect(TT.COMMA, "','");
      const stop = this.parseExpr();
      let step = null;
      if (this.match(TT.COMMA)) step = this.parseExpr();
      this.expect(TT.DO, "'do'");
      const body = this.parseBlock();
      this.expect(TT.END, "'end'");
      return Node('NumericFor', { line, varName: firstName, start, stop, step, body });
    } else {
      const names = [firstName];
      while (this.match(TT.COMMA)) names.push(this.expect(TT.NAME, 'name').text);
      this.expect(TT.IN, "'in'");
      const exprs = [this.parseExpr()];
      while (this.match(TT.COMMA)) exprs.push(this.parseExpr());
      this.expect(TT.DO, "'do'");
      const body = this.parseBlock();
      this.expect(TT.END, "'end'");
      return Node('GenericFor', { line, names, exprs, body });
    }
  }

  parseFunctionStat() {
    const line = this.cur.line;
    this.advance();
    let base = this.expect(TT.NAME, 'name').text;
    let target = Node('GlobalVar', { line, name: base });
    let isMethod = false;
    while (this.check(TT.DOT) || this.check(TT.COLON)) {
      const colon = this.check(TT.COLON);
      this.advance();
      const field = this.expect(TT.NAME, 'name').text;
      target = Node('Index', { line, base: target, key: Node('StringLit', { value: field }) });
      if (colon) { isMethod = true; break; }
    }
    const fbody = this.parseFuncBody(isMethod);
    const fexpr = Node('FunctionExpr', { line, func: fbody });
    return Node('Assign', { line, lhs: [target], rhs: [fexpr], compoundOp: null });
  }

  parseFuncBody(isMethod) {
    const line = this.cur.line;
    const params = [];
    let isVararg = false;
    if (isMethod) params.push('self');
    this.expect(TT.LPAREN, "'('");
    if (!this.check(TT.RPAREN)) {
      for (;;) {
        if (this.check(TT.ELLIPSIS)) { this.advance(); isVararg = true; break; }
        params.push(this.expect(TT.NAME, 'param name').text);
        if (this.match(TT.COLON)) this.skipTypeAnnotation(); // Luau: param: Type
        if (!this.match(TT.COMMA)) break;
      }
    }
    this.expect(TT.RPAREN, "')'");
    if (this.match(TT.COLON)) this.skipTypeAnnotation(); // Luau: return type annotation
    const body = this.parseBlock();
    this.expect(TT.END, "'end'");
    return { line, params, isVararg, body };
  }

  skipTypeAnnotation() {
    let depth = 0;
    for (;;) {
      if (depth === 0 && [TT.COMMA, TT.ASSIGN, TT.RPAREN, TT.DO, TT.END, TT.SEMI, TT.EOF].includes(this.cur.type)) break;
      if ([TT.LPAREN, TT.LBRACE, TT.LBRACKET].includes(this.cur.type)) depth++;
      if ([TT.RPAREN, TT.RBRACE, TT.RBRACKET].includes(this.cur.type)) { if (depth === 0) break; depth--; }
      this.advance();
    }
  }

  parseLocal() {
    const line = this.cur.line;
    this.advance();
    if (this.match(TT.FUNCTION)) {
      const name = this.expect(TT.NAME, 'name').text;
      const fbody = this.parseFuncBody(false);
      return Node('LocalFuncDecl', { line, name, func: fbody });
    }
    const names = [this.expect(TT.NAME, 'name').text];
    if (this.match(TT.COLON)) this.skipTypeAnnotation();
    while (this.match(TT.COMMA)) {
      names.push(this.expect(TT.NAME, 'name').text);
      if (this.match(TT.COLON)) this.skipTypeAnnotation();
    }
    let exprs = [];
    if (this.match(TT.ASSIGN)) {
      exprs.push(this.parseExpr());
      while (this.match(TT.COMMA)) exprs.push(this.parseExpr());
    }
    return Node('LocalDecl', { line, names, exprs });
  }

  parseExprStat() {
    const line = this.cur.line;
    const e = this.parseSuffixedExpr();
    if (this.check(TT.ASSIGN) || this.check(TT.COMMA)) {
      const lhs = [e];
      while (this.match(TT.COMMA)) lhs.push(this.parseSuffixedExpr());
      this.expect(TT.ASSIGN, "'='");
      const rhs = [this.parseExpr()];
      while (this.match(TT.COMMA)) rhs.push(this.parseExpr());
      return Node('Assign', { line, lhs, rhs, compoundOp: null });
    }
    const compoundMap = {
      [TT.PLUS_EQ]: '+', [TT.MINUS_EQ]: '-', [TT.STAR_EQ]: '*', [TT.SLASH_EQ]: '/',
      [TT.DSLASH_EQ]: '//', [TT.PERCENT_EQ]: '%', [TT.CARET_EQ]: '^', [TT.DDOT_EQ]: '..',
    };
    if (compoundMap[this.cur.type]) {
      const op = compoundMap[this.cur.type];
      this.advance();
      const rhs = this.parseExpr();
      return Node('Assign', { line, lhs: [e], rhs: [rhs], compoundOp: op });
    }
    return Node('ExprStat', { line, expr: e });
  }

  // ---------------- Expressions ----------------
  parsePrimaryExpr() {
    const line = this.cur.line;
    if (this.check(TT.LPAREN)) {
      this.advance();
      const e = this.parseExpr();
      this.expect(TT.RPAREN, "')'");
      return Node('Paren', { line, expr: e });
    }
    if (this.check(TT.NAME)) {
      const name = this.cur.text;
      this.advance();
      return Node('GlobalVar', { line, name }); // resolved local/global/upval saat compile
    }
    throw new ParseError(`Parse error line ${line}: unexpected symbol near '${this.cur.text}'`);
  }

  parseSuffixedExpr() {
    let e = this.parsePrimaryExpr();
    for (;;) {
      const line = this.cur.line;
      if (this.check(TT.DOT)) {
        this.advance();
        const field = this.expect(TT.NAME, 'name').text;
        e = Node('Index', { line, base: e, key: Node('StringLit', { value: field }) });
      } else if (this.check(TT.LBRACKET)) {
        this.advance();
        const key = this.parseExpr();
        this.expect(TT.RBRACKET, "']'");
        e = Node('Index', { line, base: e, key });
      } else if (this.check(TT.COLON)) {
        this.advance();
        const method = this.expect(TT.NAME, 'name').text;
        const args = this.parseArgs();
        e = Node('MethodCall', { line, base: e, method, args });
      } else if (this.check(TT.LPAREN) || this.check(TT.STRING) || this.check(TT.LBRACE)) {
        const args = this.parseArgs();
        e = Node('Call', { line, callee: e, args });
      } else break;
    }
    return e;
  }

  parseArgs() {
    if (this.check(TT.STRING)) {
      const s = Node('StringLit', { value: this.cur.text, line: this.cur.line });
      this.advance();
      return [s];
    }
    if (this.check(TT.LBRACE)) return [this.parseTableConstructor()];
    this.expect(TT.LPAREN, "'('");
    const args = [];
    if (!this.check(TT.RPAREN)) {
      args.push(this.parseExpr());
      while (this.match(TT.COMMA)) args.push(this.parseExpr());
    }
    this.expect(TT.RPAREN, "')'");
    return args;
  }

  parseTableConstructor() {
    const line = this.cur.line;
    this.expect(TT.LBRACE, "'{'");
    const fields = [];
    while (!this.check(TT.RBRACE)) {
      if (this.check(TT.LBRACKET)) {
        this.advance();
        const key = this.parseExpr();
        this.expect(TT.RBRACKET, "']'");
        this.expect(TT.ASSIGN, "'='");
        const value = this.parseExpr();
        fields.push({ key, value });
      } else if (this.check(TT.NAME) && this.peekAhead().type === TT.ASSIGN) {
        const key = Node('StringLit', { value: this.cur.text });
        this.advance(); this.advance();
        const value = this.parseExpr();
        fields.push({ key, value });
      } else {
        fields.push({ key: null, value: this.parseExpr() });
      }
      if (!this.match(TT.COMMA) && !this.match(TT.SEMI)) break;
    }
    this.expect(TT.RBRACE, "'}'");
    return Node('TableCons', { line, fields });
  }

  parseSimpleExpr() {
    const line = this.cur.line;
    switch (this.cur.type) {
      case TT.NUMBER: { const v = this.cur.value; this.advance(); return Node('NumberLit', { line, value: v }); }
      case TT.STRING: { const v = this.cur.text; this.advance(); return Node('StringLit', { line, value: v }); }
      case TT.NIL: this.advance(); return Node('NilLit', { line });
      case TT.TRUE: this.advance(); return Node('TrueLit', { line });
      case TT.FALSE: this.advance(); return Node('FalseLit', { line });
      case TT.ELLIPSIS: this.advance(); return Node('Vararg', { line });
      case TT.LBRACE: return this.parseTableConstructor();
      case TT.FUNCTION: { this.advance(); const fb = this.parseFuncBody(false); return Node('FunctionExpr', { line, func: fb }); }
      default: return this.parseSuffixedExpr();
    }
  }

  unopPriority() { return 8; }

  binopPriority(t) {
    switch (t) {
      case TT.OR: return [1, 1];
      case TT.AND: return [2, 2];
      case TT.LT: case TT.GT: case TT.LE: case TT.GE: case TT.NE: case TT.EQ: return [3, 3];
      case TT.DDOT: return [5, 4]; // right assoc
      case TT.PLUS: case TT.MINUS: return [6, 6];
      case TT.STAR: case TT.SLASH: case TT.DSLASH: case TT.PERCENT: return [7, 7];
      case TT.CARET: return [10, 9]; // right assoc
      default: return [-1, -1];
    }
  }

  parseExpr(limit = 0) {
    let e;
    if (this.check(TT.NOT) || this.check(TT.MINUS) || this.check(TT.HASH)) {
      const op = this.check(TT.NOT) ? 'not' : (this.check(TT.MINUS) ? '-' : '#');
      const line = this.cur.line;
      this.advance();
      const operand = this.parseExpr(this.unopPriority());
      e = Node('UnOp', { line, op, expr: operand });
    } else {
      e = this.parseSimpleExpr();
    }
    for (;;) {
      const [lp, rp] = this.binopPriority(this.cur.type);
      if (lp <= limit) break;
      const opTok = this.cur.type;
      const line = this.cur.line;
      this.advance();
      const rhs = this.parseExpr(rp);
      if (opTok === TT.AND) e = Node('And', { line, left: e, right: rhs });
      else if (opTok === TT.OR) e = Node('Or', { line, left: e, right: rhs });
      else e = Node('BinOp', { line, op: opTok, left: e, right: rhs });
    }
    return e;
  }
}

module.exports = { Parser, ParseError };
