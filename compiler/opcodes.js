/*
 * opcodes.js
 * ============================================================================
 * Definisi instruction set (opcode) untuk custom bytecode VM.
 * File ini adalah SUMBER KEBENARAN untuk urutan angka opcode.
 * Urutan/nilai di sini HARUS SAMA PERSIS dengan tabel OP di vm/vm_runtime.lua
 * (lihat comment "SYNC WITH opcodes.js" di file itu).
 *
 * Model VM: register-based sederhana (mirip gaya Lua asli), dengan:
 *   - R[n]   : register lokal per-frame (array biasa)
 *   - K[n]   : constants pool per-fungsi (angka, string, dst)
 *   - Upval  : upvalue (referensi ke variabel di closure luar)
 *   - PC     : program counter
 *
 * Format 1 instruksi: { op, a, b, c }  (a/b/c = operand, arti beda tiap opcode)
 * ============================================================================
 */

'use strict';

const OP = {
  // --- Data movement ---
  LOADK: 0,      // R[a] = K[b]              -- load constant
  LOADNIL: 1,    // R[a..a+b] = nil
  LOADBOOL: 2,   // R[a] = (bool)b
  MOVE: 3,       // R[a] = R[b]

  // --- Global / Upvalue / Table ---
  GETGLOBAL: 4,  // R[a] = _G[K[b]]
  SETGLOBAL: 5,  // _G[K[b]] = R[a]
  GETUPVAL: 6,   // R[a] = Upval[b]
  SETUPVAL: 7,   // Upval[b] = R[a]
  NEWTABLE: 8,   // R[a] = {}
  GETTABLE: 9,   // R[a] = R[b][RK(c)]
  SETTABLE: 10,  // R[a][RK(b)] = RK(c)
  GETTABLEK: 11, // R[a] = R[b][K[c]]   (optimized field access by const key)
  SETTABLEK: 12, // R[a][K[b]] = RK(c)

  // --- Arithmetic / Logic ---
  ADD: 13, SUB: 14, MUL: 15, DIV: 16, MOD: 17, POW: 18, IDIV: 19,
  CONCAT: 20,    // R[a] = R[b] .. R[c]
  UNM: 21,       // R[a] = -R[b]
  NOT: 22,       // R[a] = not R[b]
  LEN: 23,       // R[a] = #R[b]
  EQ: 24, LT: 25, LE: 26, // R[a] = comparison(R[b], RK(c))

  // --- Control flow ---
  JMP: 27,       // pc += a  (unconditional, SELALU instruksi terpisah)
  JMPIF: 28,     // if bool(R[a]) == true  then pc += b
  JMPIFNOT: 29,  // if bool(R[a]) == false then pc += b

  // --- Function calls ---
  CALL: 30,      // R[a..a+c-2] = R[a](R[a+1..a+b-1])   b=nargs+1,c=nresults+1 (0=multi)
  RETURN: 31,    // return R[a..a+b-2]                   b-1=nvals (0=multi/all-to-top)
  VARARG: 32,    // R[a..a+b-2] = ...

  // --- Closures ---
  CLOSURE: 33,   // R[a] = closure(Proto[b])  diikuti pseudo-instr utk tiap upvalue
  CLOSE_UPVAL_MOVE: 34, // pseudo-operand penanda upvalue capture dari local R[b]
  CLOSE_UPVAL_UP: 35,   // pseudo-operand penanda upvalue capture dari upval induk[b]

  // --- Table constructor helper ---
  SETLIST: 36,   // R[a][c+i] = R[a+i] untuk i=1..b  (array-part table constructor)

  // --- Loops ---
  // Numeric for pakai 4 register berurutan mulai `a`:
  //   R[a]=start/counter, R[a+1]=stop, R[a+2]=step, R[a+3]=user-visible loop var
  FORPREP: 37,   // validasi start/stop/step bertipe number; lalu pc += b (loncat ke FORLOOP check pertama)
  FORLOOP: 38,   // R[a]+=R[a+2]; jika masih dalam batas: R[a+3]=R[a]; pc += b; else lanjut (keluar loop)
  TFORCALL: 39,  // generic for: panggil iterator R[a](R[a+1],R[a+2]) -> ditaruh mulai R[a+3..a+3+c-1]
  TFORLOOP: 40,  // jika R[a+3] ~= nil: R[a+2]=R[a+3] (update control var), pc += b; else lanjut keluar

  // --- Method call sugar ---
  SELF: 41,      // R[a+1]=R[b]; R[a]=R[b][RK(c)]   utk obj:method()

  HALT: 42,      // stop eksekusi chunk utama
};

const OP_NAMES = Object.fromEntries(Object.entries(OP).map(([k,v]) => [v,k]));

// Flag bit untuk operand RK (register-or-constant), dipakai encoder:
// Jika bit tertinggi (0x100000 dst, kita pakai skema sederhana: nilai negatif-1 encoding)
// di sini kita pakai skema: index >= 0 => register; index < 0 => constant (-(idx)-1)
function RK_IS_CONST(x) { return x < 0; }
function RK_CONST_IDX(x) { return -(x) - 1; }
function RK_ENCODE_CONST(kIdx) { return -(kIdx) - 1; }

module.exports = { OP, OP_NAMES, RK_IS_CONST, RK_CONST_IDX, RK_ENCODE_CONST };
