'use strict';
const { Parser } = require('./parser');
const { Compiler } = require('./compiler');
const { OP_NAMES } = require('./opcodes');

function dumpProto(proto, indent = '') {
  console.log(`${indent}Proto: params=${proto.numParams} vararg=${proto.isVararg} maxRegs=${proto.maxRegs}`);
  console.log(`${indent}Consts: ${JSON.stringify(proto.consts)}`);
  proto.code.forEach((instr, i) => {
    const name = OP_NAMES[instr.op];
    console.log(`${indent}  [${i}] ${name} a=${instr.a} b=${instr.b} c=${instr.c}`);
  });
  proto.protos.forEach((p, i) => {
    console.log(`${indent}-- SubProto #${i} --`);
    dumpProto(p, indent + '  ');
  });
}

const src = process.argv[2] || `
local x = 10
local y = 20
print(x + y)
`;

try {
  const parser = new Parser(src);
  const ast = parser.parseChunk();
  console.log('=== PARSE OK ===');
  const compiler = new Compiler();
  const proto = compiler.compileChunk(ast);
  console.log('=== COMPILE OK ===');
  dumpProto(proto);
} catch (e) {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
}
