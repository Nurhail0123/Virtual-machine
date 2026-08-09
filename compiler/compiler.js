/*
 * compiler.js — AST -> custom bytecode (register-based)
 * ============================================================================
 * Setiap fungsi (termasuk chunk utama) dikompilasi jadi 1 "Proto":
 *   { numParams, isVararg, code:[{op,a,b,c,line}], consts:[...], protos:[Proto...],
 *     upvals:[{fromParentLocal:bool, index:int}], maxRegs }
 *
 * Desain penting (v2, disederhanakan dari draft awal):
 *  - JMP  : lompat tanpa syarat, offset di field `a`.
 *  - JMPIF / JMPIFNOT : uji R[a], lompat (offset di field `b`) jika kondisi cocok.
 *    Instruksi test TIDAK PERNAH menyimpan offset di field yang sama dengan
 *    register yang diuji -- ini mencegah tabrakan yang ada di draft pertama.
 *  - CALL args: dikompilasi berurutan ke register setelah fnReg. Jika argumen
 *    TERAKHIR adalah call/vararg yang perlu di-expand, kompilator memakai
 *    penanda eksplisit `argsDynamic=true` pada instruksi CALL (field extra di
 *    metadata instr, bukan encoding angka aneh).
 *  - Numeric for pakai 4 register berurutan: [start/counter, stop, step, loopvar]
 *    -- lihat opcodes.js untuk semantik FORPREP/FORLOOP.
 * ============================================================================
 */
'use strict';
const { OP } = require('./opcodes');

class CompileError extends Error {}

// ---------------- FuncState: state kompilasi 1 fungsi ----------------
class FuncState {
  constructor(parent) {
    this.parent = parent;
    this.code = [];          // instruksi { op,a,b,c,line, ...extra? }
    this.consts = [];
    this.constMap = new Map();
    this.protos = [];
    this.upvals = [];        // { name, fromParentLocal, index }
    this.upvalMap = new Map();
    this.scopes = [{ vars: new Map(), base: 0 }];
    this.nextReg = 0;
    this.maxRegs = 0;
    this.numParams = 0;
    this.isVararg = false;
    this.loopStack = []; // { breakJumps:[idx], continueTarget:pc|-1, continueJumps?:[idx] }
  }

  allocReg() {
    const r = this.nextReg++;
    if (this.nextReg > this.maxRegs) this.maxRegs = this.nextReg;
    return r;
  }
  freeToReg(target) { this.nextReg = target; }

  enterScope() { this.scopes.push({ vars: new Map(), base: this.nextReg }); }
  exitScope() {
    const sc = this.scopes.pop();
    this.nextReg = sc.base;
  }
  declareLocal(name) {
    const r = this.allocReg();
    this.scopes[this.scopes.length - 1].vars.set(name, r);
    return r;
  }
  resolveLocal(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const r = this.scopes[i].vars.get(name);
      if (r !== undefined) return r;
    }
    return -1;
  }

  addConst(v) {
    const key = (typeof v) + ':' + String(v);
    if (this.constMap.has(key)) return this.constMap.get(key);
    const idx = this.consts.length;
    this.consts.push(v);
    this.constMap.set(key, idx);
    return idx;
  }

  resolveUpval(name) {
    if (this.upvalMap.has(name)) return this.upvalMap.get(name);
    if (!this.parent) return -1;
    const parentLocal = this.parent.resolveLocal(name);
    if (parentLocal >= 0) {
      const idx = this.upvals.length;
      this.upvals.push({ name, fromParentLocal: true, index: parentLocal });
      this.upvalMap.set(name, idx);
      return idx;
    }
    const parentUpval = this.parent.resolveUpval(name);
    if (parentUpval >= 0) {
      const idx = this.upvals.length;
      this.upvals.push({ name, fromParentLocal: false, index: parentUpval });
      this.upvalMap.set(name, idx);
      return idx;
    }
    return -1;
  }

  emit(op, a = 0, b = 0, c = 0, line = 0, extra = null) {
    const instr = { op, a, b, c, line };
    if (extra) Object.assign(instr, extra);
    this.code.push(instr);
    return this.code.length - 1;
  }
  here() { return this.code.length; }
  patchJmp(idx, targetPc) { this.code[idx].a = targetPc - idx - 1; }
  patchJmpHere(idx) { this.patchJmp(idx, this.here()); }
  patchB(idx, targetPc) { this.code[idx].b = targetPc - idx - 1; }
  patchBHere(idx) { this.patchB(idx, this.here()); }
}

// ---------------- Compiler utama ----------------
class Compiler {
  compileChunk(block) {
    const fs = new FuncState(null);
    fs.isVararg = true;
    this.fs = fs;
    this.compileBlock(block);
    fs.emit(OP.RETURN, 0, 1, 0, 0);
    return this.toProto(fs);
  }

  toProto(fs) {
    return {
      numParams: fs.numParams,
      isVararg: fs.isVararg,
      code: fs.code,
      consts: fs.consts,
      protos: fs.protos,
      upvals: fs.upvals,
      maxRegs: fs.maxRegs,
    };
  }

  compileFunctionBody(funcNode) {
    const parentFs = this.fs;
    const fs = new FuncState(parentFs);
    fs.numParams = funcNode.params.length;
    fs.isVararg = funcNode.isVararg;
    this.fs = fs;
    fs.enterScope();
    for (const p of funcNode.params) fs.declareLocal(p);
    this.compileBlock(funcNode.body);
    fs.emit(OP.RETURN, 0, 1, 0, funcNode.line || 0);
    fs.exitScope();
    const proto = this.toProto(fs);
    this.fs = parentFs;
    const protoIdx = parentFs.protos.length;
    parentFs.protos.push(proto);
    return { protoIdx, upvals: fs.upvals };
  }

  compileBlock(stats) {
    this.fs.enterScope();
    for (const s of stats) this.compileStat(s);
    this.fs.exitScope();
  }

  // =========================== STATEMENTS ===========================
  compileStat(s) {
    const fs = this.fs;
    switch (s.type) {
      case 'ExprStat': {
        const startReg = fs.nextReg;
        if (s.expr.type === 'Call' || s.expr.type === 'MethodCall') {
          this.compileCallExpr(s.expr, startReg, 1); // 1 => buang semua hasil
        } else {
          this.compileExprToNewReg(s.expr);
        }
        fs.freeToReg(startReg);
        break;
      }
      case 'LocalDecl': this.compileLocalDecl(s); break;
      case 'Assign': this.compileAssign(s); break;
      case 'If': this.compileIf(s); break;
      case 'While': this.compileWhile(s); break;
      case 'Repeat': this.compileRepeat(s); break;
      case 'NumericFor': this.compileNumericFor(s); break;
      case 'GenericFor': this.compileGenericFor(s); break;
      case 'DoBlock': this.compileBlock(s.body); break;
      case 'Return': this.compileReturn(s); break;
      case 'Break': this.compileBreak(s); break;
      case 'Continue': this.compileContinue(s); break;
      case 'LocalFuncDecl': this.compileLocalFuncDecl(s); break;
      default: throw new CompileError(`Unknown statement type: ${s.type}`);
    }
  }

  compileLocalDecl(s) {
    const fs = this.fs;
    const startReg = fs.nextReg;
    const n = s.names.length;
    for (let i = 0; i < n; i++) fs.allocReg();
    if (s.exprs.length === 0) {
      for (let i = 0; i < n; i++) fs.emit(OP.LOADNIL, startReg + i, 0, 0, s.line);
    } else {
      this.compileExprListToRegs(s.exprs, startReg, n, s.line);
    }
    fs.nextReg = startReg + n;
    for (let i = 0; i < n; i++) {
      fs.scopes[fs.scopes.length - 1].vars.set(s.names[i], startReg + i);
    }
  }

  compileLocalFuncDecl(s) {
    const fs = this.fs;
    const r = fs.declareLocal(s.name);
    const { protoIdx, upvals } = this.compileFunctionBody(s.func);
    this.emitClosure(r, protoIdx, upvals, s.line);
  }

  emitClosure(destReg, protoIdx, upvals, line) {
    const fs = this.fs;
    fs.emit(OP.CLOSURE, destReg, protoIdx, upvals.length, line);
    for (const uv of upvals) {
      fs.emit(uv.fromParentLocal ? OP.CLOSE_UPVAL_MOVE : OP.CLOSE_UPVAL_UP, 0, uv.index, 0, line);
    }
  }

  compileAssign(s) {
    const fs = this.fs;
    if (s.compoundOp) {
      const target = s.lhs[0];
      const startReg = fs.nextReg;
      const curReg = this.compileExprToNewReg(target);
      const rhsReg = this.compileExprToNewReg(s.rhs[0]);
      const opMap = { '+':OP.ADD,'-':OP.SUB,'*':OP.MUL,'/':OP.DIV,'%':OP.MOD,'^':OP.POW,'//':OP.IDIV,'..':OP.CONCAT };
      const resultReg = fs.allocReg();
      fs.emit(opMap[s.compoundOp], resultReg, curReg, rhsReg, s.line);
      this.assignToTarget(target, resultReg, s.line);
      fs.freeToReg(startReg);
      return;
    }
    const startReg = fs.nextReg;
    const n = s.lhs.length;
    this.compileExprListToRegs(s.rhs, startReg, n, s.line);
    for (let i = 0; i < n; i++) {
      this.assignToTarget(s.lhs[i], startReg + i, s.line);
    }
    fs.freeToReg(startReg);
  }

  assignToTarget(target, valueReg, line) {
    const fs = this.fs;
    if (target.type === 'GlobalVar') {
      const localReg = fs.resolveLocal(target.name);
      if (localReg >= 0) { if (localReg !== valueReg) fs.emit(OP.MOVE, localReg, valueReg, 0, line); return; }
      const upvalIdx = fs.resolveUpval(target.name);
      if (upvalIdx >= 0) { fs.emit(OP.SETUPVAL, valueReg, upvalIdx, 0, line); return; }
      const kIdx = fs.addConst(target.name);
      fs.emit(OP.SETGLOBAL, valueReg, kIdx, 0, line);
    } else if (target.type === 'Index') {
      const baseReg = this.compileExprToNewReg(target.base);
      if (target.key.type === 'StringLit') {
        const kIdx = fs.addConst(target.key.value);
        fs.emit(OP.SETTABLEK, baseReg, kIdx, valueReg, line);
      } else {
        const keyReg = this.compileExprToNewReg(target.key);
        fs.emit(OP.SETTABLE, baseReg, keyReg, valueReg, line);
        fs.freeToReg(keyReg);
      }
      fs.freeToReg(baseReg);
    } else {
      throw new CompileError('Invalid assignment target: ' + target.type);
    }
  }

  compileIf(s) {
    const fs = this.fs;
    const endJumps = [];
    for (let i = 0; i < s.clauses.length; i++) {
      const { cond, body } = s.clauses[i];
      const condReg = this.compileExprToNewReg(cond);
      const skipJump = fs.emit(OP.JMPIFNOT, condReg, 0, 0, cond.line);
      fs.freeToReg(condReg);
      this.compileBlock(body);
      if (i < s.clauses.length - 1 || s.elseBody) {
        endJumps.push(fs.emit(OP.JMP, 0, 0, 0, s.line));
      }
      fs.patchBHere(skipJump);
    }
    if (s.elseBody) this.compileBlock(s.elseBody);
    for (const j of endJumps) fs.patchJmpHere(j);
  }

  compileWhile(s) {
    const fs = this.fs;
    const loopStart = fs.here();
    const condReg = this.compileExprToNewReg(s.cond);
    const exitJump = fs.emit(OP.JMPIFNOT, condReg, 0, 0, s.line);
    fs.freeToReg(condReg);
    fs.loopStack.push({ breakJumps: [], continueTarget: loopStart });
    this.compileBlock(s.body);
    const loop = fs.loopStack.pop();
    fs.emit(OP.JMP, loopStart - fs.here() - 1, 0, 0, s.line);
    fs.patchBHere(exitJump);
    for (const bj of loop.breakJumps) fs.patchJmpHere(bj);
  }

  compileRepeat(s) {
    const fs = this.fs;
    const loopStart = fs.here();
    fs.loopStack.push({ breakJumps: [], continueTarget: -1 });
    fs.enterScope();
    for (const st of s.body) this.compileStat(st);
    fs.loopStack[fs.loopStack.length - 1].continueTarget = fs.here();
    const condReg = this.compileExprToNewReg(s.cond);
    fs.exitScope();
    const exitJump = fs.emit(OP.JMPIF, condReg, 0, 0, s.line);
    fs.freeToReg(condReg);
    fs.emit(OP.JMP, loopStart - fs.here() - 1, 0, 0, s.line);
    fs.patchBHere(exitJump);
    const loop = fs.loopStack.pop();
    for (const bj of loop.breakJumps) fs.patchJmpHere(bj);
  }

  // Numeric for: 4 register berurutan [counter, stop, step, loopvar]
  compileNumericFor(s) {
    const fs = this.fs;
    fs.enterScope();
    const baseReg = fs.allocReg();
    this.compileExprInto(s.start, baseReg);
    const stopReg = fs.allocReg();
    this.compileExprInto(s.stop, stopReg);
    const stepReg = fs.allocReg();
    if (s.step) this.compileExprInto(s.step, stepReg);
    else { const k = fs.addConst(1); fs.emit(OP.LOADK, stepReg, k, 0, s.line); }
    const loopVarReg = fs.allocReg();
    // FORPREP: jika loop akan jalan, masuk ke body (offset field b);
    // jika 0 iterasi, langsung skip ke SETELAH FORLOOP (offset field skip).
    const prep = fs.emit(OP.FORPREP, baseReg, 0, 0, s.line);
    const bodyStart = fs.here();
    fs.enterScope();
    fs.scopes[fs.scopes.length - 1].vars.set(s.varName, loopVarReg);
    fs.loopStack.push({ breakJumps: [], continueTarget: -1, continueJumps: [] });
    for (const st of s.body) this.compileStat(st);
    const loop = fs.loopStack.pop();
    fs.exitScope();
    fs.patchB(prep, bodyStart);
    const loopInstrIdx = fs.emit(OP.FORLOOP, baseReg, 0, 0, s.line);
    fs.patchB(loopInstrIdx, bodyStart);
    const afterLoop = fs.here();
    fs.code[prep].skip = afterLoop - prep - 1;
    for (const bj of loop.breakJumps) fs.patchJmpHere(bj);
    for (const cj of (loop.continueJumps || [])) fs.patchJmp(cj, loopInstrIdx);
    fs.exitScope();
  }

  compileGenericFor(s) {
    const fs = this.fs;
    fs.enterScope();
    const startReg = fs.nextReg;
    this.compileExprListToRegs(s.exprs, startReg, 3, s.line); // f, s, ctrl
    fs.nextReg = startReg + 3;
    const nvars = s.names.length;
    for (const nm of s.names) { const r = fs.allocReg(); fs.scopes[fs.scopes.length - 1].vars.set(nm, r); }
    const loopCheck = fs.here();
    fs.emit(OP.TFORCALL, startReg, nvars, 0, s.line);
    // TFORLOOP: field b = offset LOMPAT KE BODY jika iterasi masih lanjut.
    // Jika berhenti (control var nil), TFORLOOP tidak lompat -> lanjut ke instruksi
    // berikutnya, yang HARUS berupa JMP-keluar (exitJump) supaya body tidak tereksekusi.
    const tforLoopIdx = fs.emit(OP.TFORLOOP, startReg, 0, 0, s.line);
    const exitJump = fs.emit(OP.JMP, 0, 0, 0, s.line); // dieksekusi hanya jika TFORLOOP tidak lompat
    const bodyStart = fs.here();
    fs.patchB(tforLoopIdx, bodyStart);
    fs.loopStack.push({ breakJumps: [], continueTarget: -1, continueJumps: [] });
    for (const st of s.body) this.compileStat(st);
    const loop = fs.loopStack.pop();
    fs.emit(OP.JMP, loopCheck - fs.here() - 1, 0, 0, s.line);
    fs.patchJmpHere(exitJump);
    for (const bj of loop.breakJumps) fs.patchJmpHere(bj);
    for (const cj of loop.continueJumps) fs.patchJmp(cj, loopCheck);
    fs.exitScope();
  }

  compileReturn(s) {
    const fs = this.fs;
    const startReg = fs.nextReg;
    if (s.exprs.length === 0) {
      fs.emit(OP.RETURN, startReg, 1, 0, s.line);
      return;
    }
    const lastIsMulti = this.isMultiExpr(s.exprs[s.exprs.length - 1]);
    if (lastIsMulti) {
      this.compileExprListDynamic(s.exprs, startReg);
      fs.emit(OP.RETURN, startReg, 0, 0, s.line, { argsDynamic: true });
    } else {
      this.compileExprListToRegs(s.exprs, startReg, s.exprs.length, s.line);
      fs.emit(OP.RETURN, startReg, s.exprs.length + 1, 0, s.line);
    }
  }

  compileBreak(s) {
    const fs = this.fs;
    if (fs.loopStack.length === 0) throw new CompileError(`'break' outside loop at line ${s.line}`);
    const j = fs.emit(OP.JMP, 0, 0, 0, s.line);
    fs.loopStack[fs.loopStack.length - 1].breakJumps.push(j);
  }

  compileContinue(s) {
    const fs = this.fs;
    if (fs.loopStack.length === 0) throw new CompileError(`'continue' outside loop at line ${s.line}`);
    const loop = fs.loopStack[fs.loopStack.length - 1];
    if (loop.continueTarget >= 0) {
      fs.emit(OP.JMP, loop.continueTarget - fs.here() - 1, 0, 0, s.line);
    } else {
      const j = fs.emit(OP.JMP, 0, 0, 0, s.line);
      loop.continueJumps = loop.continueJumps || [];
      loop.continueJumps.push(j);
    }
  }

  // =========================== EXPRESSIONS ===========================
  isMultiExpr(e) { return e.type === 'Call' || e.type === 'MethodCall' || e.type === 'Vararg'; }

  compileExprToNewReg(e) {
    const fs = this.fs;
    const r = fs.allocReg();
    this.compileExprInto(e, r);
    return r;
  }

  compileExprListToRegs(exprs, startReg, want, line) {
    const fs = this.fs;
    const n = exprs.length;
    let lastExpanded = false;
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const destReg = startReg + i;
      while (fs.nextReg <= destReg) fs.allocReg();
      if (isLast && this.isMultiExpr(exprs[i]) && i < want) {
        const need = want - i;
        if (exprs[i].type === 'Vararg') fs.emit(OP.VARARG, destReg, need + 1, 0, exprs[i].line);
        else this.compileCallExpr(exprs[i], destReg, need + 1);
        lastExpanded = true; // sisa slot (i+1..want-1) SUDAH terisi oleh expand ini, jangan di-LOADNIL
      } else {
        this.compileExprInto(exprs[i], destReg);
      }
    }
    if (!lastExpanded) {
      for (let i = n; i < want; i++) {
        const destReg = startReg + i;
        while (fs.nextReg <= destReg) fs.allocReg();
        fs.emit(OP.LOADNIL, destReg, 0, 0, line);
      }
    }
  }

  compileExprListDynamic(exprs, startReg) {
    const fs = this.fs;
    const n = exprs.length;
    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const destReg = startReg + i;
      while (fs.nextReg <= destReg) fs.allocReg();
      if (isLast && this.isMultiExpr(exprs[i])) {
        if (exprs[i].type === 'Vararg') fs.emit(OP.VARARG, destReg, 0, 0, exprs[i].line);
        else this.compileCallExpr(exprs[i], destReg, 0);
      } else {
        this.compileExprInto(exprs[i], destReg);
      }
    }
  }

  // Compile call/methodcall, hasil sejumlah nresultsPlus1 (0=all/dynamic) mulai destReg.
  // Invariant: fnReg == destReg (alokasi predictable, argumen selalu tepat setelahnya).
  compileCallExpr(e, destReg, nresultsPlus1) {
    const fs = this.fs;
    fs.freeToReg(destReg);
    fs.nextReg = destReg;

    if (e.type === 'MethodCall') {
      fs.allocReg(); // slot fn (destReg)
      const baseReg = fs.allocReg(); // slot self sementara (destReg+1) -- dipakai utk compile ekspresi objek
      this.compileExprInto(e.base, baseReg);
      const kIdx = fs.addConst(e.method);
      // SELF: R[destReg]=fn, R[destReg+1]=self  (base di baseReg dipakai sbg sumber utk key-lookup)
      fs.emit(OP.SELF, destReg, baseReg, -(kIdx) - 1, e.line);
      fs.nextReg = destReg + 2;
      const argInfo = this.compileArgsFrom(e.args, destReg + 2);
      if (argInfo.dynamic) fs.emit(OP.CALL, destReg, 0, nresultsPlus1, e.line, { argsDynamic: true });
      else fs.emit(OP.CALL, destReg, argInfo.count + 2, nresultsPlus1, e.line);
    } else {
      this.compileExprInto(e.callee, destReg);
      fs.nextReg = destReg + 1;
      const argInfo = this.compileArgsFrom(e.args, destReg + 1);
      if (argInfo.dynamic) fs.emit(OP.CALL, destReg, 0, nresultsPlus1, e.line, { argsDynamic: true });
      else fs.emit(OP.CALL, destReg, argInfo.count + 1, nresultsPlus1, e.line);
    }
    fs.nextReg = destReg + Math.max(1, nresultsPlus1 > 0 ? nresultsPlus1 - 1 : 1);
  }

  compileArgsFrom(args, startReg) {
    const fs = this.fs;
    fs.nextReg = startReg;
    let fixedBefore = 0;
    for (let i = 0; i < args.length; i++) {
      const isLast = i === args.length - 1;
      const r = fs.allocReg();
      if (isLast && this.isMultiExpr(args[i])) {
        if (args[i].type === 'Vararg') fs.emit(OP.VARARG, r, 0, 0, args[i].line);
        else this.compileCallExpr(args[i], r, 0);
        return { count: fixedBefore, dynamic: true };
      } else {
        this.compileExprInto(args[i], r);
        fixedBefore++;
      }
    }
    return { count: fixedBefore, dynamic: false };
  }

  compileExprInto(e, destReg) {
    const fs = this.fs;
    switch (e.type) {
      case 'NilLit': fs.emit(OP.LOADNIL, destReg, 0, 0, e.line); return;
      case 'TrueLit': fs.emit(OP.LOADBOOL, destReg, 1, 0, e.line); return;
      case 'FalseLit': fs.emit(OP.LOADBOOL, destReg, 0, 0, e.line); return;
      case 'NumberLit': { const k = fs.addConst(e.value); fs.emit(OP.LOADK, destReg, k, 0, e.line); return; }
      case 'StringLit': { const k = fs.addConst(e.value); fs.emit(OP.LOADK, destReg, k, 0, e.line); return; }
      case 'Vararg': fs.emit(OP.VARARG, destReg, 2, 0, e.line); return;
      case 'Paren': this.compileExprInto(e.expr, destReg); return;
      case 'GlobalVar': {
        const localReg = fs.resolveLocal(e.name);
        if (localReg >= 0) { if (localReg !== destReg) fs.emit(OP.MOVE, destReg, localReg, 0, e.line); return; }
        const upvalIdx = fs.resolveUpval(e.name);
        if (upvalIdx >= 0) { fs.emit(OP.GETUPVAL, destReg, upvalIdx, 0, e.line); return; }
        const k = fs.addConst(e.name);
        fs.emit(OP.GETGLOBAL, destReg, k, 0, e.line);
        return;
      }
      case 'Index': {
        const saved = fs.nextReg;
        const baseReg = destReg;
        while (fs.nextReg <= baseReg) fs.allocReg();
        this.compileExprInto(e.base, baseReg);
        if (e.key.type === 'StringLit') {
          const k = fs.addConst(e.key.value);
          fs.emit(OP.GETTABLEK, destReg, baseReg, k, e.line);
        } else {
          const keyReg = fs.allocReg();
          this.compileExprInto(e.key, keyReg);
          fs.emit(OP.GETTABLE, destReg, baseReg, keyReg, e.line);
        }
        fs.freeToReg(Math.max(saved, destReg + 1));
        return;
      }
      case 'Call': case 'MethodCall': this.compileCallExpr(e, destReg, 2); return;
      case 'FunctionExpr': {
        const { protoIdx, upvals } = this.compileFunctionBody(e.func);
        this.emitClosure(destReg, protoIdx, upvals, e.line);
        return;
      }
      case 'TableCons': this.compileTableCons(e, destReg); return;
      case 'And': {
        this.compileExprInto(e.left, destReg);
        const j = fs.emit(OP.JMPIFNOT, destReg, 0, 0, e.line);
        this.compileExprInto(e.right, destReg);
        fs.patchBHere(j);
        return;
      }
      case 'Or': {
        this.compileExprInto(e.left, destReg);
        const j = fs.emit(OP.JMPIF, destReg, 0, 0, e.line);
        this.compileExprInto(e.right, destReg);
        fs.patchBHere(j);
        return;
      }
      case 'UnOp': {
        const saved = fs.nextReg;
        const r = fs.allocReg();
        this.compileExprInto(e.expr, r);
        if (e.op === 'not') fs.emit(OP.NOT, destReg, r, 0, e.line);
        else if (e.op === '-') fs.emit(OP.UNM, destReg, r, 0, e.line);
        else if (e.op === '#') fs.emit(OP.LEN, destReg, r, 0, e.line);
        fs.freeToReg(Math.max(saved, destReg + 1));
        return;
      }
      case 'BinOp': {
        const saved = fs.nextReg;
        const lReg = fs.allocReg();
        this.compileExprInto(e.left, lReg);
        const rReg = fs.allocReg();
        this.compileExprInto(e.right, rReg);
        const opMap = { '+':OP.ADD,'-':OP.SUB,'*':OP.MUL,'/':OP.DIV,'%':OP.MOD,'^':OP.POW,'//':OP.IDIV,'..':OP.CONCAT,'==':OP.EQ,'<':OP.LT,'<=':OP.LE };
        if (e.op === '~=') { fs.emit(OP.EQ, destReg, lReg, rReg, e.line); fs.emit(OP.NOT, destReg, destReg, 0, e.line); }
        else if (e.op === '>') fs.emit(OP.LT, destReg, rReg, lReg, e.line);
        else if (e.op === '>=') fs.emit(OP.LE, destReg, rReg, lReg, e.line);
        else fs.emit(opMap[e.op], destReg, lReg, rReg, e.line);
        fs.freeToReg(Math.max(saved, destReg + 1));
        return;
      }
      default: throw new CompileError('Unknown expr type: ' + e.type);
    }
  }

  compileTableCons(e, destReg) {
    const fs = this.fs;
    fs.emit(OP.NEWTABLE, destReg, 0, 0, e.line);
    const saved = fs.nextReg;
    while (fs.nextReg <= destReg) fs.allocReg();
    let arrIdx = 0;
    let pendingStart = -1, pendingCount = 0;
    const flush = () => {
      if (pendingCount > 0) {
        fs.emit(OP.SETLIST, destReg, pendingCount, arrIdx - pendingCount, e.line);
        fs.freeToReg(pendingStart);
        pendingCount = 0; pendingStart = -1;
      }
    };
    for (let i = 0; i < e.fields.length; i++) {
      const f = e.fields[i];
      if (f.key) {
        flush();
        const kReg = fs.allocReg();
        this.compileExprInto(f.key, kReg);
        const vReg = fs.allocReg();
        this.compileExprInto(f.value, vReg);
        fs.emit(OP.SETTABLE, destReg, kReg, vReg, e.line);
        fs.freeToReg(kReg);
      } else {
        const isLast = i === e.fields.length - 1;
        if (isLast && this.isMultiExpr(f.value)) {
          flush();
          const r = fs.allocReg();
          if (f.value.type === 'Vararg') fs.emit(OP.VARARG, r, 0, 0, f.value.line);
          else this.compileCallExpr(f.value, r, 0);
          fs.emit(OP.SETLIST, destReg, 0, arrIdx, e.line, { dynamicList: true });
          fs.freeToReg(r);
        } else {
          if (pendingStart < 0) pendingStart = fs.nextReg;
          const r = fs.allocReg();
          this.compileExprInto(f.value, r);
          pendingCount++;
          arrIdx++;
        }
      }
    }
    flush();
    fs.freeToReg(Math.max(saved, destReg + 1));
  }
}

module.exports = { Compiler, CompileError };
