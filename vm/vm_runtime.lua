--[[
  vm_runtime.lua (v3 - bersih)
  ============================================================================
  VM runtime murni Lua untuk mengeksekusi custom bytecode dari compiler.js.
  Ditulis supaya jalan di Lua 5.1 MAUPUN Luau tanpa perubahan.

  SYNC WITH opcodes.js -- nilai numerik opcode di bawah HARUS SAMA PERSIS.

  Model register: setiap Proto punya "regs" (array 0-based secara logis,
  disimpan 1-based di Lua via regs[i+1]). Upvalue disimpan sbg "cell"
  ({[1]=value}) yang di-share by-reference antara pemilik local & closure
  anak yang meng-capture-nya.
  ============================================================================
]]

local OP = {
  LOADK=0, LOADNIL=1, LOADBOOL=2, MOVE=3,
  GETGLOBAL=4, SETGLOBAL=5, GETUPVAL=6, SETUPVAL=7,
  NEWTABLE=8, GETTABLE=9, SETTABLE=10, GETTABLEK=11, SETTABLEK=12,
  ADD=13, SUB=14, MUL=15, DIV=16, MOD=17, POW=18, IDIV=19,
  CONCAT=20, UNM=21, NOT=22, LEN=23, EQ=24, LT=25, LE=26,
  JMP=27, JMPIF=28, JMPIFNOT=29,
  CALL=30, RETURN=31, VARARG=32,
  CLOSURE=33, CLOSE_UPVAL_MOVE=34, CLOSE_UPVAL_UP=35,
  SETLIST=36,
  FORPREP=37, FORLOOP=38, TFORCALL=39, TFORLOOP=40,
  SELF=41, HALT=42,
}

local tunpack = table.unpack or unpack

--------------------------------------------------------------------------
-- Cell (upvalue box)
--------------------------------------------------------------------------
local function newCell(v) return { v } end

--------------------------------------------------------------------------
-- Indexing dgn metatable support
--------------------------------------------------------------------------
local function vmIndexGet(base, key)
  local tb = type(base)
  if tb == 'table' then
    local v = base[key]
    if v ~= nil then return v end
    local mt = getmetatable(base)
    if mt then
      local idx = rawget(mt, '__index')
      if type(idx) == 'table' then return vmIndexGet(idx, key) end
      if type(idx) == 'function' then return idx(base, key) end
    end
    return nil
  elseif tb == 'string' then
    return string[key]
  else
    error('attempt to index a ' .. tb .. ' value')
  end
end

local function vmIndexSet(base, key, val)
  if type(base) ~= 'table' then error('attempt to index a ' .. type(base) .. ' value') end
  local mt = getmetatable(base)
  if mt and rawget(base, key) == nil then
    local ni = rawget(mt, '__newindex')
    if type(ni) == 'table' then vmIndexSet(ni, key, val); return end
    if type(ni) == 'function' then ni(base, key, val); return end
  end
  base[key] = val
end

local runProto -- forward decl
local vmCall   -- forward decl

vmCall = function(fn, args)
  local tf = type(fn)
  if tf == 'function' then
    return { fn(tunpack(args)) }
  elseif tf == 'table' and fn.__isVMClosure then
    return runProto(fn.proto, fn.upvals, args)
  elseif tf == 'table' then
    local mt = getmetatable(fn)
    if mt and mt.__call then
      local newArgs = { fn }
      for i = 1, #args do newArgs[#newArgs + 1] = args[i] end
      return vmCall(mt.__call, newArgs)
    end
    error('attempt to call a table value')
  else
    error('attempt to call a ' .. tf .. ' value')
  end
end

--------------------------------------------------------------------------
-- Helper: ambil metamethod dari salah satu operand (prioritas operand kiri,
-- sama seperti aturan resmi Lua).
--------------------------------------------------------------------------
local function getMetamethod(a, b, name)
  local mtA = type(a) == 'table' and getmetatable(a) or nil
  if mtA then
    local h = rawget(mtA, name)
    if h ~= nil then return h end
  end
  local mtB = type(b) == 'table' and getmetatable(b) or nil
  if mtB then
    local h = rawget(mtB, name)
    if h ~= nil then return h end
  end
  return nil
end

local ARITH_META = { ['+']='__add', ['-']='__sub', ['*']='__mul', ['/']='__div',
                      ['%']='__mod', ['^']='__pow', ['//']='__idiv' }

--------------------------------------------------------------------------
-- vmArith: operasi aritmatika dgn dukungan metamethod (__add, __sub, dst).
-- Jika salah satu operand table/userdata dgn metamethod terkait, panggil itu
-- dulu; kalau tidak ada, baru fallback ke tonumber() spt Lua bawaan.
--------------------------------------------------------------------------
local function vmArith(op, a, b)
  if type(a) == 'table' or type(b) == 'table' then
    local h = getMetamethod(a, b, ARITH_META[op])
    if h ~= nil then
      local r = vmCall(h, { a, b })
      return r[1]
    end
  end
  local na, nb = tonumber(a), tonumber(b)
  if na == nil then error('attempt to perform arithmetic on a ' .. type(a) .. ' value') end
  if nb == nil then error('attempt to perform arithmetic on a ' .. type(b) .. ' value') end
  if op == '+' then return na + nb
  elseif op == '-' then return na - nb
  elseif op == '*' then return na * nb
  elseif op == '/' then return na / nb
  elseif op == '%' then return na % nb
  elseif op == '^' then return na ^ nb
  elseif op == '//' then return math.floor(na / nb)
  end
end

--------------------------------------------------------------------------
-- vmUnm: unary minus dgn dukungan __unm
--------------------------------------------------------------------------
local function vmUnm(v)
  if type(v) == 'table' then
    local mt = getmetatable(v)
    local h = mt and rawget(mt, '__unm')
    if h ~= nil then
      local r = vmCall(h, { v, v })
      return r[1]
    end
  end
  if type(v) ~= 'number' then error('attempt to perform arithmetic on a ' .. type(v) .. ' value') end
  return -v
end

--------------------------------------------------------------------------
-- vmLen: operator # dgn dukungan __len
--------------------------------------------------------------------------
local function vmLen(v)
  if type(v) == 'table' then
    local mt = getmetatable(v)
    local h = mt and rawget(mt, '__len')
    if h ~= nil then
      local r = vmCall(h, { v })
      return r[1]
    end
  end
  return #v
end

--------------------------------------------------------------------------
-- vmConcat: operator .. dgn dukungan __concat
--------------------------------------------------------------------------
local function vmConcat(a, b)
  local ta, tb = type(a), type(b)
  if (ta == 'string' or ta == 'number') and (tb == 'string' or tb == 'number') then
    return tostring(a) .. tostring(b)
  end
  local h = getMetamethod(a, b, '__concat')
  if h ~= nil then
    local r = vmCall(h, { a, b })
    return r[1]
  end
  local bad = (ta == 'string' or ta == 'number') and b or a
  error('attempt to concatenate a ' .. type(bad) .. ' value')
end

--------------------------------------------------------------------------
-- vmEq: operator == dgn dukungan __eq (Lua asli: __eq hanya dipanggil jika
-- kedua operand table/userdata dan bukan reference yang sama)
--------------------------------------------------------------------------
local function vmEq(a, b)
  if a == b then return true end
  if type(a) == 'table' and type(b) == 'table' then
    local h = getMetamethod(a, b, '__eq')
    if h ~= nil then
      local r = vmCall(h, { a, b })
      return r[1] and true or false
    end
  end
  return false
end

--------------------------------------------------------------------------
-- vmLt / vmLe: operator < <= dgn dukungan __lt / __le
--------------------------------------------------------------------------
local function vmLt(a, b)
  if type(a) == 'number' and type(b) == 'number' then return a < b end
  if type(a) == 'string' and type(b) == 'string' then return a < b end
  local h = getMetamethod(a, b, '__lt')
  if h ~= nil then
    local r = vmCall(h, { a, b })
    return r[1] and true or false
  end
  error('attempt to compare two ' .. type(a) .. ' values')
end

local function vmLe(a, b)
  if type(a) == 'number' and type(b) == 'number' then return a <= b end
  if type(a) == 'string' and type(b) == 'string' then return a <= b end
  local h = getMetamethod(a, b, '__le')
  if h ~= nil then
    local r = vmCall(h, { a, b })
    return r[1] and true or false
  end
  error('attempt to compare two ' .. type(a) .. ' values')
end

--------------------------------------------------------------------------
-- vmToString: dipakai internal VM sendiri (mis. utk error message); kode
-- hasil kompilasi yg memanggil `tostring()` scr eksplisit sudah tertangani
-- lewat GLOBAL_ENV override di bagian bawah file, supaya __tostring jalan.
--------------------------------------------------------------------------
local function vmToString(v)
  if type(v) == 'table' then
    local mt = getmetatable(v)
    local h = mt and rawget(mt, '__tostring')
    if h ~= nil then
      local r = vmCall(h, { v })
      return tostring(r[1])
    end
  end
  return tostring(v)
end

--------------------------------------------------------------------------
-- runProto: eksekusi 1 Proto. args = array 1-based hasil Lua call biasa.
-- Return: array 1-based hasil (utk dikembalikan ke pemanggil).
--------------------------------------------------------------------------
runProto = function(proto, upvalCells, args)
  local regs = {}   -- regs[i+1] = nilai register logis ke-i
  local cells = {}  -- cells[i]  = cell table bila register ke-i sudah di-capture jadi upvalue
  local top = -1    -- index register (0-based) terakhir dari hasil ekspansi multi-value terbaru

  local function setReg(i, v)
    regs[i + 1] = v
    local c = cells[i]
    if c then c[1] = v end
  end
  local function getReg(i)
    return regs[i + 1]
  end
  local function getOrMakeCell(i)
    local c = cells[i]
    if not c then
      c = newCell(regs[i + 1])
      cells[i] = c
    end
    return c
  end
  -- RK: decode operand register-or-constant. idx>=0 => register; idx<0 => constant.
  -- Encoding dari compiler: constIdx -> -(constIdx)-1
  local function RK(idx, consts)
    if idx < 0 then
      return consts[(-idx - 1) + 1]
    else
      return getReg(idx)
    end
  end

  local nparams = proto.numParams
  for i = 0, nparams - 1 do setReg(i, args[i + 1]) end

  local varargs = nil
  if proto.isVararg then
    varargs = {}
    for i = nparams + 1, #args do varargs[#varargs + 1] = args[i] end
  end

  local code = proto.code
  local consts = proto.consts
  local protos = proto.protos
  local pc = 1
  local codeLen = #code

  while pc <= codeLen do
    local ins = code[pc]
    local op = ins.op

    if op == OP.LOADK then
      setReg(ins.a, consts[ins.b + 1])

    elseif op == OP.LOADNIL then
      setReg(ins.a, nil)

    elseif op == OP.LOADBOOL then
      setReg(ins.a, ins.b == 1)

    elseif op == OP.MOVE then
      setReg(ins.a, getReg(ins.b))

    elseif op == OP.GETGLOBAL then
      setReg(ins.a, GLOBAL_ENV[consts[ins.b + 1]])

    elseif op == OP.SETGLOBAL then
      GLOBAL_ENV[consts[ins.b + 1]] = getReg(ins.a)

    elseif op == OP.GETUPVAL then
      setReg(ins.a, upvalCells[ins.b + 1][1])

    elseif op == OP.SETUPVAL then
      upvalCells[ins.b + 1][1] = getReg(ins.a)

    elseif op == OP.NEWTABLE then
      setReg(ins.a, {})

    elseif op == OP.GETTABLE then
      setReg(ins.a, vmIndexGet(getReg(ins.b), getReg(ins.c)))

    elseif op == OP.SETTABLE then
      vmIndexSet(getReg(ins.a), getReg(ins.b), getReg(ins.c))

    elseif op == OP.GETTABLEK then
      setReg(ins.a, vmIndexGet(getReg(ins.b), consts[ins.c + 1]))

    elseif op == OP.SETTABLEK then
      vmIndexSet(getReg(ins.a), consts[ins.b + 1], getReg(ins.c))

    elseif op == OP.ADD then setReg(ins.a, vmArith('+', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.SUB then setReg(ins.a, vmArith('-', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.MUL then setReg(ins.a, vmArith('*', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.DIV then setReg(ins.a, vmArith('/', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.MOD then setReg(ins.a, vmArith('%', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.POW then setReg(ins.a, vmArith('^', getReg(ins.b), getReg(ins.c)))
    elseif op == OP.IDIV then setReg(ins.a, vmArith('//', getReg(ins.b), getReg(ins.c)))

    elseif op == OP.CONCAT then
      setReg(ins.a, vmConcat(getReg(ins.b), getReg(ins.c)))

    elseif op == OP.UNM then
      setReg(ins.a, vmUnm(getReg(ins.b)))

    elseif op == OP.NOT then
      local v = getReg(ins.b)
      setReg(ins.a, not (v and true or false))

    elseif op == OP.LEN then
      setReg(ins.a, vmLen(getReg(ins.b)))

    elseif op == OP.EQ then
      setReg(ins.a, vmEq(getReg(ins.b), getReg(ins.c)))

    elseif op == OP.LT then
      setReg(ins.a, vmLt(getReg(ins.b), getReg(ins.c)))

    elseif op == OP.LE then
      setReg(ins.a, vmLe(getReg(ins.b), getReg(ins.c)))

    elseif op == OP.JMP then
      pc = pc + ins.a

    elseif op == OP.JMPIF then
      if getReg(ins.a) then pc = pc + ins.b end

    elseif op == OP.JMPIFNOT then
      if not getReg(ins.a) then pc = pc + ins.b end

    elseif op == OP.CALL then
      local fnReg = ins.a
      local fn = getReg(fnReg)
      local callArgs = {}
      if ins.argsDynamic then
        for i = fnReg + 1, top do callArgs[#callArgs + 1] = getReg(i) end
      else
        local nargs = ins.b - 1
        for i = 1, nargs do callArgs[i] = getReg(fnReg + i) end
      end
      local results = vmCall(fn, callArgs)
      local nres = ins.c
      if nres == 0 then
        for i = 1, #results do setReg(fnReg + i - 1, results[i]) end
        top = fnReg + #results - 1
      else
        for i = 1, nres - 1 do setReg(fnReg + i - 1, results[i]) end
      end

    elseif op == OP.RETURN then
      local startA = ins.a
      local out = {}
      if ins.argsDynamic or ins.b == 0 then
        for i = startA, top do out[#out + 1] = getReg(i) end
      else
        for i = 1, ins.b - 1 do out[i] = getReg(startA + i - 1) end
      end
      return out

    elseif op == OP.VARARG then
      local startA = ins.a
      local va = varargs or {}
      if ins.b == 0 then
        for i = 1, #va do setReg(startA + i - 1, va[i]) end
        top = startA + #va - 1
      else
        for i = 1, ins.b - 1 do setReg(startA + i - 1, va[i]) end
      end

    elseif op == OP.CLOSURE then
      local subProto = protos[ins.b + 1]
      local nups = ins.c
      local ups = {}
      for i = 1, nups do
        local upIns = code[pc + i]
        if upIns.op == OP.CLOSE_UPVAL_MOVE then
          ups[i] = getOrMakeCell(upIns.b)
        else -- CLOSE_UPVAL_UP: ambil cell dari upvalue induk (diteruskan apa adanya)
          ups[i] = upvalCells[upIns.b + 1]
        end
      end
      setReg(ins.a, { __isVMClosure = true, proto = subProto, upvals = ups })
      pc = pc + nups

    elseif op == OP.SETLIST then
      local baseReg = ins.a
      local t = getReg(baseReg)
      if ins.dynamicList then
        local startIdx = ins.c
        local n = top - (baseReg + 1) + 1
        for i = 1, n do t[startIdx + i] = getReg(baseReg + i) end
      else
        local count = ins.b
        local startIdx = ins.c
        for i = 1, count do t[startIdx + i] = getReg(baseReg + i) end
      end

    elseif op == OP.FORPREP then
      local baseReg = ins.a
      local startv = getReg(baseReg)
      local stopv = getReg(baseReg + 1)
      local stepv = getReg(baseReg + 2)
      if type(startv) ~= 'number' then error("'for' initial value must be a number") end
      if type(stopv) ~= 'number' then error("'for' limit must be a number") end
      if type(stepv) ~= 'number' then error("'for' step must be a number") end
      if stepv == 0 then error("'for' step is zero") end
      local willRun
      if stepv > 0 then willRun = startv <= stopv else willRun = startv >= stopv end
      if willRun then
        setReg(baseReg + 3, startv)
        pc = pc + ins.b
      else
        pc = pc + ins.skip
      end

    elseif op == OP.FORLOOP then
      local baseReg = ins.a
      local stepv = getReg(baseReg + 2)
      local newv = getReg(baseReg) + stepv
      local stopv = getReg(baseReg + 1)
      local cont
      if stepv > 0 then cont = newv <= stopv else cont = newv >= stopv end
      if cont then
        setReg(baseReg, newv)
        setReg(baseReg + 3, newv)
        pc = pc + ins.b
      end

    elseif op == OP.TFORCALL then
      local baseReg = ins.a
      local f = getReg(baseReg)
      local s = getReg(baseReg + 1)
      local ctrl = getReg(baseReg + 2)
      local results = vmCall(f, { s, ctrl })
      for i = 1, ins.b do setReg(baseReg + 2 + i, results[i]) end

    elseif op == OP.TFORLOOP then
      local baseReg = ins.a
      if getReg(baseReg + 3) ~= nil then
        setReg(baseReg + 2, getReg(baseReg + 3))
        pc = pc + ins.b
      end

    elseif op == OP.SELF then
      local base = getReg(ins.b)
      local key = RK(ins.c, consts)
      setReg(ins.a + 1, base)
      setReg(ins.a, vmIndexGet(base, key))

    elseif op == OP.HALT then
      return {}
    end

    pc = pc + 1
  end

  return {}
end

--------------------------------------------------------------------------
-- Public entry point
--------------------------------------------------------------------------
GLOBAL_ENV = setmetatable({}, { __index = _G })

--------------------------------------------------------------------------
-- Override fungsi standar yang menerima "function" sbg parameter (pcall,
-- xpcall, setmetatable dgn __call/__index function, table.sort dgn
-- comparator, dst). Closure hasil kompilasi VM berbentuk TABLE
-- ({__isVMClosure=true,...}), bukan `function` asli Lua host, jadi fungsi
-- bawaan Lua yang langsung memanggil argumennya sbg `fn(...)` akan gagal.
-- Override ini menjembatani lewat vmCall supaya closure VM & fungsi native
-- host sama-sama bisa dipanggil transparan dari kode hasil kompilasi.
--------------------------------------------------------------------------
GLOBAL_ENV.pcall = function(fn, ...)
  local args = { ... }
  local ok, resultOrErr = pcall(function() return vmCall(fn, args) end)
  if ok then
    return true, tunpack(resultOrErr)
  else
    -- resultOrErr adalah string error dari Lua host (mis. dari `error()` internal
    -- vmArith dll) ATAU nilai Value yg dilempar oleh error() versi VM (lihat bawah)
    if type(resultOrErr) == 'table' and resultOrErr.__isVMError then
      return false, resultOrErr.value
    end
    return false, resultOrErr
  end
end

GLOBAL_ENV.xpcall = function(fn, handler, ...)
  local args = { ... }
  local ok, resultOrErr = pcall(function() return vmCall(fn, args) end)
  if ok then
    return true, tunpack(resultOrErr)
  else
    local errVal = resultOrErr
    if type(resultOrErr) == 'table' and resultOrErr.__isVMError then errVal = resultOrErr.value end
    local hres = vmCall(handler, { errVal })
    return false, tunpack(hres)
  end
end

GLOBAL_ENV.error = function(msg, level)
  -- bungkus supaya nilai non-string (table/number sbg error object ala Lua)
  -- tetap bisa diteruskan utuh melalui pcall Lua host yg cuma bawa 1 nilai error.
  if type(msg) == 'string' then
    error(msg, 0) -- level=0: jangan tambahkan info posisi dari sisi host, biar bersih
  else
    error({ __isVMError = true, value = msg }, 0)
  end
end

GLOBAL_ENV.assert = function(v, msg, ...)
  if v then return v, msg, ... end
  GLOBAL_ENV.error(msg or 'assertion failed!')
end

GLOBAL_ENV.setmetatable = function(t, mt)
  return setmetatable(t, mt)
end

-- table.sort dgn comparator closure VM
do
  local origTable = {}
  for k, v in pairs(table) do origTable[k] = v end
  GLOBAL_ENV.table = setmetatable({}, { __index = origTable })
  GLOBAL_ENV.table.sort = function(t, cmp)
    if cmp == nil then
      table.sort(t)
    else
      table.sort(t, function(a, b)
        local r = vmCall(cmp, { a, b })
        return r[1] and true or false
      end)
    end
  end
end

-- tostring/print versi VM: hormati __tostring milik table hasil kompilasi
GLOBAL_ENV.tostring = function(v)
  return vmToString(v)
end

GLOBAL_ENV.print = function(...)
  local args = { ... }
  local n = select('#', ...)
  local parts = {}
  for i = 1, n do parts[i] = vmToString(args[i]) end
  print(table.concat(parts, "\t"))
end

local function runMain(mainProto)
  local ok, err = pcall(function()
    runProto(mainProto, {}, {})
  end)
  if not ok then
    if type(err) == 'table' and err.__isVMError then
      print('Error: ' .. tostring(err.value))
    else
      print('Error: ' .. tostring(err))
    end
  end
end

return {
  runProto = runProto,
  runMain = runMain,
  GLOBAL_ENV = GLOBAL_ENV,
}
