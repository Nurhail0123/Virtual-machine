#!/usr/bin/env node
/*
 * build.js — Pipeline lengkap: source.lua -> output.lua (ter-virtualisasi)
 * Usage: node build.js input.lua output.lua
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Parser } = require('./compiler/parser');
const { Compiler } = require('./compiler/compiler');
const { serializeProto } = require('./compiler/serialize');

function build(inputPath, outputPath) {
  const src = fs.readFileSync(inputPath, 'utf8');
  const parser = new Parser(src);
  const ast = parser.parseChunk();
  const compiler = new Compiler();
  const mainProto = compiler.compileChunk(ast);
  const protoLiteral = serializeProto(mainProto);

  const vmSource = fs.readFileSync(path.join(__dirname, 'vm', 'vm_runtime.lua'), 'utf8');
  // vm_runtime.lua diakhiri dengan blok "return { runProto=..., runMain=..., ... }"
  // di baris PALING AKHIR file. Kita cari marker unik (bukan 'return {' generik,
  // krn itu juga muncul di fungsi internal spt newCell/vmCall) supaya tidak salah potong.
  const marker = 'return {\n  runProto = runProto,';
  const idx = vmSource.lastIndexOf(marker);
  if (idx === -1) throw new Error('Tidak menemukan marker export akhir di vm_runtime.lua');
  const vmBody = vmSource.slice(0, idx);

  const output = `${vmBody}
local MAIN_PROTO = ${protoLiteral}
runMain(MAIN_PROTO)
`;
  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`OK: ${inputPath} -> ${outputPath} (${mainProto.code.length} instr utama, ${mainProto.protos.length} sub-fungsi)`);
}

const [,, inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node build.js input.lua output.lua');
  process.exit(1);
}
build(inputPath, outputPath);
