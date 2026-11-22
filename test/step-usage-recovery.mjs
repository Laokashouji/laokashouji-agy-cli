// 复现与回归：SQLite 步级用量（gen_metadata）在真实长会话中被误杀永久熔断与压缩后锚点卡死问题。
//
// 1. 同一生成拆分为带 thinking/text 的后续 tool_use 响应时，无新行不应把 proc.stepUsageTrusted 永久置死；
// 2. agy 内部压缩等辅助调用使 ACP expected > sum(gen_metadata) 时，end_turn 已落盘的末步真实行仍应采信；
// 3. 已验证可用的 SQLite 库在正常回合遇到瞬态故障回退后，下一回合应自动恢复读取（连续空库仍熔断）；
// 4. 已进入回退估算的会话若在 end_turn 实测到窗口显著缩水（内部压缩），contextAnchor 应同步下调。

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import {
  baseBody, continueWithToolResults, createBridgeKit, padBodyToTokens, readSse, sleep, usageTotal,
} from "./testkit.mjs"

const localRequire = createRequire(import.meta.url)
let openSqlite = null
try {
  const { Database } = localRequire("bun:sqlite")
  openSqlite = (file) => {
    const db = new Database(file)
    return {
      exec: (sql) => db.exec(sql),
      run: (sql, ...args) => {
        const stmt = db.prepare(sql)
        try {
          return stmt.run(...args)
        } finally {
          stmt.finalize()
        }
      },
      close: () => db.close(),
    }
  }
} catch {
  try {
    const { DatabaseSync } = localRequire("node:sqlite")
    openSqlite = (file) => {
      const db = new DatabaseSync(file)
      return {
        exec: (sql) => db.exec(sql),
        run: (sql, ...args) => db.prepare(sql).run(...args),
        close: () => db.close(),
      }
    }
  } catch {}
}

const varint = (n) => {
  const out = []
  while (n > 127) {
    out.push((n & 127) | 128)
    n = Math.floor(n / 128)
  }
  out.push(n)
  return out
}
const field = (n, bytes) => [n * 8 + 2, ...varint(bytes.length), ...bytes]
const genBlob = ({ input, output, write = 0, read = 0, thinking = 0 }) => new Uint8Array(field(1, field(4, [
  0x10, ...varint(input), 0x18, ...varint(output),
  ...(write ? [0x20, ...varint(write)] : []),
  ...(read ? [0x28, ...varint(read)] : []),
  ...(thinking ? [0x48, ...varint(thinking)] : []),
])))

const plain = (value) => JSON.parse(JSON.stringify(value))

function writeGen(convDir, sessionId, idx, stats) {
  const db = openSqlite(path.join(convDir, `${sessionId}.db`))
  try {
    db.exec("PRAGMA journal_mode = WAL")
    db.run("CREATE TABLE IF NOT EXISTS gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)")
    db.run("INSERT OR REPLACE INTO gen_metadata VALUES (?, ?)", idx, genBlob(stats))
  } finally {
    db.close()
  }
}

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

async function runTurn(kit, body) {
  const responses = []
  const bodies = []
  let current = body
  for (let guard = 0; guard < 32; guard++) {
    bodies.push(current)
    const parsed = await readSse(await kit.request(current))
    assert.equal(parsed.error, null, JSON.stringify(parsed.error))
    responses.push(parsed)
    if (parsed.stopReason !== "tool_use") return { responses, bodies }
    current = continueWithToolResults(current, parsed)
  }
  throw new Error("工具回合超过 32 次仍未收尾")
}

function nextTurnBody(prev, text) {
  const lastBody = prev.bodies.at(-1)
  return {
    ...lastBody,
    messages: [
      ...lastBody.messages,
      { role: "assistant", content: plain(prev.responses.at(-1).content) },
      { role: "user", content: text },
    ],
  }
}

test("同一生成拆出带 thinking/text 的后续 tool_use 时不误杀 stepUsageTrusted，后续步继续精确读库", { skip: !openSqlite }, async () => {
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })

    kit.prompts.push(async (agent) => {
      // Gen 0 一次生成中先后产出 tool1 -> text -> tool2，HTTP 侧会被拆成两个 tool_use 响应
      writeGen(convDir, agent.sessionId, 0, { input: 496_147, read: 0, output: 846, thinking: 127 })
      const first = agent.tool("Read", { path: "/first.ts" })
      await agent.text("next check")
      const second = agent.tool("Read", { path: "/second.ts" })
      await Promise.all([first, second])

      // Gen 1 真实高缓存命中
      writeGen(convDir, agent.sessionId, 1, { input: 2288, read: 498_947, output: 180, thinking: 60 })
      await agent.tool("Read", { path: "/third.ts" })

      // Gen 2 收尾高缓存命中
      writeGen(convDir, agent.sessionId, 2, { input: 2515, read: 502_236, output: 300, thinking: 90 })
      await agent.text("done")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 496_147 + 2288 + 2515,
          cachedReadTokens: 498_947 + 502_236,
          cachedWriteTokens: 0,
          outputTokens: 846 + 180 + 300,
          thoughtTokens: 127 + 60 + 90,
          totalTokens: 496_147 + 2288 + 2515 + 498_947 + 502_236 + 846 + 180 + 300,
        },
      }
    })

    const { responses } = await runTurn(kit, baseBody())
    assert.equal(responses.length, 4)
    const [proc] = [...kit.module.__agyTestAllProcs]
    assert.equal(proc.stepUsageTrusted, true, "同次生成带文本拆包不应关闭 stepUsageTrusted")
    assert.deepEqual(plain(responses.map((r) => r.usage)), [
      { input_tokens: 496_147, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 846, output_tokens_details: { thinking_tokens: 127 } },
      { input_tokens: 0, cache_read_input_tokens: 496_147, cache_creation_input_tokens: 0, output_tokens: 0 },
      { input_tokens: 2288, cache_read_input_tokens: 498_947, cache_creation_input_tokens: 0, output_tokens: 180, output_tokens_details: { thinking_tokens: 60 } },
      { input_tokens: 2515, cache_read_input_tokens: 502_236, cache_creation_input_tokens: 0, output_tokens: 300, output_tokens_details: { thinking_tokens: 90 } },
    ])
  })
})

test("回合中途 agy 内部压缩导致 ACP expected 大于 gen_metadata 之和：end_turn 仍采信已落盘末行且不熔断后续回合", { skip: !openSqlite }, async () => {
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })

    kit.prompts.push(async (agent) => {
      // 压缩前一步：500k 窗口
      writeGen(convDir, agent.sessionId, 0, { input: 3590, read: 506_191, output: 2540, thinking: 286 })
      await agent.tool("Read", { path: "/before-compact.ts" })

      // 模拟 agy 内部 step_type=23 压缩（额外消耗 500k 未写入 gen_metadata，但计入 ACP usage）
      // 压缩后窗口降到 ~31k
      writeGen(convDir, agent.sessionId, 1, { input: 30_954, read: 0, output: 137, thinking: 46 })
      await agent.tool("Read", { path: "/after-compact.ts" })

      writeGen(convDir, agent.sessionId, 2, { input: 2915, read: 30_290, output: 2438, thinking: 248 })
      await agent.text("compacted and done")
      return {
        stopReason: "end_turn",
        usage: {
          // 包含未入 gen_metadata 的 500k 压缩摘要调用
          inputTokens: 3590 + 30_954 + 2915 + 500_000,
          cachedReadTokens: 506_191 + 30_290,
          cachedWriteTokens: 0,
          outputTokens: 2540 + 137 + 2438 + 5000,
          thoughtTokens: 286 + 46 + 248,
          totalTokens: 3590 + 30_954 + 2915 + 500_000 + 506_191 + 30_290 + 2540 + 137 + 2438 + 5000,
        },
      }
    })

    kit.prompts.push(async (agent) => {
      writeGen(convDir, agent.sessionId, 3, { input: 2500, read: 33_205, output: 120, thinking: 30 })
      await agent.tool("Read", { path: "/next-turn.ts" })
      writeGen(convDir, agent.sessionId, 4, { input: 2100, read: 35_705, output: 90, thinking: 20 })
      await agent.text("next turn ok")
      return {
        stopReason: "end_turn",
        usage: {
          inputTokens: 2500 + 2100,
          cachedReadTokens: 33_205 + 35_705,
          cachedWriteTokens: 0,
          outputTokens: 120 + 90,
          thoughtTokens: 30 + 20,
          totalTokens: 2500 + 2100 + 33_205 + 35_705 + 120 + 90,
        },
      }
    })

    const turn1 = await runTurn(kit, baseBody())
    assert.equal(turn1.responses.length, 3)
    assert.deepEqual(plain(turn1.responses[2].usage), {
      input_tokens: 2915,
      cache_read_input_tokens: 30_290,
      cache_creation_input_tokens: 0,
      output_tokens: 2438,
      output_tokens_details: { thinking_tokens: 248 },
    })

    const [proc] = [...kit.module.__agyTestAllProcs]
    assert.equal(proc.stepUsageTrusted, true, "内部压缩导致 ACP expected 偏大时不应熔断后续回合")

    const turn2 = await runTurn(kit, nextTurnBody(turn1, "continue after compaction"))
    assert.equal(kit.acpSpawns.length, 1, "应复用同一 agy 进程")
    assert.deepEqual(plain(turn2.responses[0].usage), {
      input_tokens: 2500,
      cache_read_input_tokens: 33_205,
      cache_creation_input_tokens: 0,
      output_tokens: 120,
      output_tokens_details: { thinking_tokens: 30 },
    })
    assert.deepEqual(plain(turn2.responses[1].usage), {
      input_tokens: 2100,
      cache_read_input_tokens: 35_705,
      cache_creation_input_tokens: 0,
      output_tokens: 90,
      output_tokens_details: { thinking_tokens: 20 },
    })
  })
})

test("已验证可用的 SQLite 库遇单轮瞬态锁库回退后，下一正常回合自动恢复；连续两轮彻底无行才熔断", { skip: !openSqlite }, async () => {
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })
    let locker = null

    // Turn 1：正常读取，证明 SQLite 可用
    kit.prompts.push(async (agent) => {
      writeGen(convDir, agent.sessionId, 1, { input: 2000, read: 18_000, output: 40, thinking: 10 })
      await agent.tool("Read", { path: "/t1.ts" })
      writeGen(convDir, agent.sessionId, 2, { input: 1500, read: 20_000, output: 30, thinking: 5 })
      await agent.text("t1 done")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 3500, cachedReadTokens: 38_000, outputTokens: 70, thoughtTokens: 15, totalTokens: 41_570 },
      }
    })

    // Turn 2：遇到瞬态 EXCLUSIVE 锁导致当轮回退，随后解锁并正常结束
    kit.prompts.push(async (agent) => {
      const dbFile = path.join(convDir, `${agent.sessionId}.db`)
      locker = openSqlite(dbFile)
      locker.exec("BEGIN EXCLUSIVE")
      await agent.tool("Read", { path: "/t2-locked.ts" })
      locker.exec("ROLLBACK")
      locker.close()
      locker = null
      writeGen(convDir, agent.sessionId, 3, { input: 1800, read: 21_500, output: 25 })
      await agent.text("t2 unlocked done")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 1800, cachedReadTokens: 21_500, outputTokens: 25, totalTokens: 23_325 },
      }
    })

    // Turn 3：自动恢复读取真实 SQLite
    kit.prompts.push(async (agent) => {
      writeGen(convDir, agent.sessionId, 4, { input: 1111, read: 23_300, output: 55, thinking: 12 })
      await agent.tool("Read", { path: "/t3.ts" })
      writeGen(convDir, agent.sessionId, 5, { input: 999, read: 24_411, output: 33, thinking: 7 })
      await agent.text("t3 recovered")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 2110, cachedReadTokens: 47_711, outputTokens: 88, thoughtTokens: 19, totalTokens: 49_909 },
      }
    })

    // Turn 4 & Turn 5：模拟存储彻底停止写入（连续两轮 0 新行）-> 触发熔断
    for (const label of ["t4 no-write", "t5 no-write"]) {
      kit.prompts.push(async (agent) => {
        await agent.text(label)
        return { stopReason: "end_turn", usage: { inputTokens: 1000, cachedReadTokens: 25_000, outputTokens: 10, totalTokens: 26_010 } }
      })
    }

    try {
      const turn1 = await runTurn(kit, baseBody())
      const [proc] = [...kit.module.__agyTestAllProcs]
      assert.equal(proc.stepUsageTrusted, true)

      const turn2 = await runTurn(kit, nextTurnBody(turn1, "turn 2"))
      assert.equal(proc.stepUsageTrusted, true, "已验证可用的库在单轮瞬态回退后应保持可恢复")

      const turn3 = await runTurn(kit, nextTurnBody(turn2, "turn 3"))
      assert.equal(kit.acpSpawns.length, 1)
      assert.deepEqual(plain(turn3.responses[0].usage), {
        input_tokens: 1111,
        cache_read_input_tokens: 23_300,
        cache_creation_input_tokens: 0,
        output_tokens: 55,
        output_tokens_details: { thinking_tokens: 12 },
      })
      assert.deepEqual(plain(turn3.responses[1].usage), {
        input_tokens: 999,
        cache_read_input_tokens: 24_411,
        cache_creation_input_tokens: 0,
        output_tokens: 33,
        output_tokens_details: { thinking_tokens: 7 },
      })

      const turn4 = await runTurn(kit, nextTurnBody(turn3, "turn 4"))
      assert.equal(proc.stepUsageTrusted, true, "单次无新行尚不立即永久熔断")
      await runTurn(kit, nextTurnBody(turn4, "turn 5"))
      assert.equal(proc.stepUsageTrusted, false, "连续两轮无新行后应熔断以避免每轮空等 1s")
    } finally {
      try { locker?.exec("ROLLBACK") } catch {}
      try { locker?.close() } catch {}
    }
  })
})

test("回退估算期间 agy 内部压缩导致 end_turn 窗口骤降时，contextAnchor 同步下调而不滞留在压缩前 500k", { skip: !openSqlite }, async () => {
  await withKit({}, async (kit) => {
    const convDir = path.join(kit.home, ".gemini", "antigravity-cli", "conversations")
    fs.mkdirSync(convDir, { recursive: true })

    // Turn 1：SQLite 实测锚定在 500k，然后被带脏尾行的 steer 取消，合法进入回退估算（stepUsageTrusted = false）
    kit.prompts.push(async (agent) => {
      writeGen(convDir, agent.sessionId, 0, { input: 10_000, read: 490_000, output: 50 })
      agent.update({ sessionUpdate: "tool_call", toolCallId: "call_big", name: "mcp_ide-tools_Read", status: "in_progress" })
      await agent.tool("Read", { path: "/big.ts" })
      writeGen(convDir, agent.sessionId, 1, { input: 500_000, read: 0, output: 10 })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "call_big", name: "mcp_ide-tools_Read", status: "completed" })
      await agent.waitCancel()
      return {
        stopReason: "cancelled",
        usage: { inputTokens: 10_000, cachedReadTokens: 490_000, outputTokens: 50, totalTokens: 500_050 },
      }
    })

    // Turn 2（回退估算）：模拟 agy 内部压缩后只剩 ~40k（3 步合计 120k）
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/small-1.ts" })
      await agent.tool("Read", { path: "/small-2.ts" })
      await agent.text("small now")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 30_000, cachedReadTokens: 90_000, outputTokens: 40, totalTokens: 120_040 },
      }
    })

    // Turn 3（仍在回退估算）：工具步窗口必须锚定在 ~40k 量级，而不能停留在 500k
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/small-3.ts" })
      await agent.text("still small")
      return {
        stopReason: "end_turn",
        usage: { inputTokens: 10_000, cachedReadTokens: 70_000, outputTokens: 30, totalTokens: 80_030 },
      }
    })

    const body1 = await padBodyToTokens(kit, baseBody(), 480_000)
    const first = await readSse(await kit.request(body1))
    assert.equal(usageTotal(first.usage), 500_000)
    const [proc] = [...kit.module.__agyTestAllProcs]

    const steeredBody = continueWithToolResults(body1, first, () => "ok")
    steeredBody.messages.at(-1).content.push({ type: "text", text: "steer after compaction" })
    const turn2 = await runTurn(kit, steeredBody)
    assert.equal(proc.stepUsageTrusted, false)
    assert.ok(usageTotal(turn2.responses.at(-1).usage) < 100_000,
      `Turn 2 end_turn 窗口 ${usageTotal(turn2.responses.at(-1).usage)} 应反映压缩后量级`)

    const turn3 = await runTurn(kit, nextTurnBody(turn2, "continue small"))
    const turn3ToolWindow = usageTotal(turn3.responses[0].usage)
    assert.ok(turn3ToolWindow < 100_000,
      `Turn 3 工具步估算窗口 ${turn3ToolWindow} 仍卡死在压缩前的 500k 锚点`)
  })
})
