/*
 * serialize.js — Ubah Proto (hasil compiler.js) jadi source-code Lua
 * berupa literal table, supaya bisa langsung dimuat oleh vm_runtime.lua
 * tanpa perlu JSON parser di sisi Lua.
 * ============================================================================
 */
'use strict';

function luaStringLiteral(s) {
  // escape aman: gunakan format panjang [==[ ... ]==] jika ada karakter aneh,
  // atau escape biasa untuk kasus umum.
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) out += '\\' + code;
    else out += ch;
  }
  out += '"';
  return out;
}

function luaConstLiteral(v) {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return v.toString();
  }
  if (typeof v === 'string') return luaStringLiteral(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return 'nil';
}

function serializeInstr(instr) {
  let s = `{op=${instr.op},a=${instr.a},b=${instr.b},c=${instr.c}`;
  if (instr.argsDynamic) s += ',argsDynamic=true';
  if (instr.dynamicList) s += ',dynamicList=true';
  if (typeof instr.skip === 'number') s += `,skip=${instr.skip}`;
  s += '}';
  return s;
}

function serializeProto(proto) {
  const parts = [];
  parts.push(`numParams=${proto.numParams}`);
  parts.push(`isVararg=${proto.isVararg ? 'true' : 'false'}`);
  parts.push(`maxRegs=${proto.maxRegs}`);
  parts.push(`code={${proto.code.map(serializeInstr).join(',')}}`);
  parts.push(`consts={${proto.consts.map(luaConstLiteral).join(',')}}`);
  parts.push(`protos={${proto.protos.map(serializeProto).join(',')}}`);
  return `{${parts.join(',')}}`;
}

module.exports = { serializeProto, luaStringLiteral };
