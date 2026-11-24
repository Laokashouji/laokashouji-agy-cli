// Regression tests for session retention improvements in laokashouji-agy-cli:
// 1. ToolSearch growing the tool catalog mid-turn keeps the live agy session
//    via steerInSession + updateTools instead of killing it for a 112 KiB replay.
// 2. One-shot stateless / ephemeral requests (e.g. Persona, memory distill) do
//    not evict stateful conversations from sessions.json or the live pool.
// 3. Claude Code /btw side questions run in an isolated ephemeral session so
//    they never mutate expectedMessages or block the main conversation.
// 4. Client abort (499) mid-generation after tool_result delivery continues on
//    the live session instead of triggering forceNew on the next turn.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  READ_TOOL, baseBody, continueWithToolResults, createBridgeKit, readSse, sleep,
} from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }
const SEARCH_TOOL = {
  name: "ToolSearch",
  description: "Search deferred tools",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
}
const LOADED_TOOL = {
  name: "magic_echo",
  description: "Loaded deferred tool",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}
const BTW_REMINDER = `<system-reminder>This is a side question from the user. You must answer this question directly in a single response.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this one question
- The main agent is NOT interrupted - it continues working independently in the background
</system-reminder>`

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

async function withKit(options, fn) {
  const stderr = captureStderr()
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-retention-state-"))
  const stateFile = path.join(stateDir, "sessions.json")
  const kit = await createBridgeKit({ ...options, env: { AGY_BRIDGE_STATE_FILE: stateFile, ...(options.env || {}) } })
  kit.stateFile = stateFile
  try {
    return await fn(kit, stderr)
  } finally {
    await kit.dispose()
    stderr.restore()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
}

function prompts(kit) {
  return kit.acpLog
    .filter((entry) => entry.method === "session/prompt")
    .map((entry) => (entry.params?.prompt || []).map((part) => (part.type === "text" ? part.text : "")).join(""))
}

test("tools_grew: ToolSearch keeps live session, commits MCP result, re-lists grown tools, and continues", async () => {
  await withKit({}, async (kit, stderr) => {
    let deliveredSearch = null
    let deliveredLoaded = null
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "ts1", status: "in_progress" })
      deliveredSearch = await agent.tool("ToolSearch", { query: "select:magic_echo" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "ts1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.prompts.push(async (agent) => {
      const listed = kit.listings.at(-1)?.tools || []
      assert.ok(listed.includes("magic_echo"), `expected magic_echo listed before next prompt, got ${JSON.stringify(listed)}`)
      agent.update({ sessionUpdate: "tool_call", toolCallId: "le1", status: "in_progress" })
      deliveredLoaded = await agent.tool("magic_echo", { text: "hi" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "le1", status: "completed" })
      await agent.text("done-with-loaded")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("next-turn-ok")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body1 = baseBody({ tools: [SEARCH_TOOL], messages: [{ role: "user", content: "load magic_echo" }] })
    const res1 = await readSse(await kit.request(body1))
    assert.equal(res1.stopReason, "tool_use")

    // ToolSearch return with only tool_result + meta <system-reminder> and grown catalog
    const body2 = continueWithToolResults(body1, res1, () => [{ type: "tool_reference", tool_name: "magic_echo" }])
    body2.messages.at(-1).content.push({ type: "text", text: "<system-reminder>\n<total_tokens>14900000 tokens left</total_tokens>\n</system-reminder>" })
    body2.tools = [SEARCH_TOOL, LOADED_TOOL]
    const res2 = await readSse(await kit.request(body2))
    assert.equal(res2.stopReason, "tool_use")
    assert.equal(res2.content.find((b) => b.type === "tool_use")?.name, "magic_echo")
    assert.equal(kit.acpSpawns.length, 1, "must keep the single live agy process")
    assert.match(deliveredSearch?.result?.content?.[0]?.text || "", /Loaded tool: magic_echo/)
    assert.match(prompts(kit)[1], /newly loaded tools are now available/)
    assert.ok(stderr.lines.some((r) => r.action === "kept" && r.reason === "tools_grew"))

    const body3 = continueWithToolResults(body2, res2, () => "MAGIC_OK:hi")
    const res3 = await readSse(await kit.request(body3))
    assert.equal(res3.stopReason, "end_turn")
    assert.equal(deliveredLoaded?.result?.content?.[0]?.text, "MAGIC_OK:hi")
    assert.equal(kit.acpSpawns.length, 1)

    const body4 = {
      ...body3,
      messages: [...body3.messages, { role: "assistant", content: res3.content }, { role: "user", content: "follow up" }],
    }
    const res4 = await readSse(await kit.request(body4))
    assert.equal(res4.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
  })
})

test("tools_grew: falls back cleanly to a fresh session when agy cannot re-list tools", async () => {
  await withKit({ watchTools: false, env: { AGY_BRIDGE_TOOL_LIST_WAIT_MS: "150" } }, async (kit) => {
    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "ts1", status: "in_progress" })
      await agent.tool("ToolSearch", { query: "select:magic_echo" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "ts1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("replayed-ok")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body1 = baseBody({ tools: [SEARCH_TOOL], messages: [{ role: "user", content: "load magic_echo" }] })
    const res1 = await readSse(await kit.request(body1))
    const body2 = continueWithToolResults(body1, res1, () => [{ type: "tool_reference", tool_name: "magic_echo" }])
    body2.tools = [SEARCH_TOOL, LOADED_TOOL]
    const res2 = await readSse(await kit.request(body2))
    assert.equal(res2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "must fall back to a fresh agy when relist times out")
    assert.match(prompts(kit).at(-1), /Loaded tool: magic_echo/, "fallback replay must include ToolSearch result")
  })
})

test("parked and pool priority: one-shot ephemeral bursts never evict stateful chats from sessions.json or pool", async () => {
  await withKit({
    sessionResume: true,
    env: { AGY_BRIDGE_MAX_PROCS: "3", AGY_BRIDGE_MAX_PARKED: "4", AGY_BRIDGE_EPHEMERAL_IDLE_MS: "5000", AGY_BRIDGE_IDLE_MS: "600000" },
  }, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: USAGE }
    }
    const workDir = path.join(kit.tmp, "project-a")
    fs.mkdirSync(workDir, { recursive: true })
    const statefulHeaders = { headers: { "x-magpie-session": "claude-main-1", "x-magpie-work-dir": encodeURIComponent(workDir) } }

    // 1. Start a real stateful conversation (with tools + sessionScope + workDir)
    const main1 = baseBody({ tools: [READ_TOOL], messages: [{ role: "user", content: "stateful turn 1" }] })
    const mainRes1 = await readSse(await kit.request(main1, statefulHeaders))
    assert.equal(mainRes1.stopReason, "end_turn")
    const mainSpawnCount = kit.acpSpawns.length

    // 2. Burst of 8 streaming one-shot requests (simulating Persona: no tools, no session, no workDir)
    //    plus 4 non-streaming stateless requests (simulating memory distill).
    for (let i = 0; i < 8; i++) {
      const r = await readSse(await kit.request(baseBody({ tools: undefined, messages: [{ role: "user", content: `persona ${i}` }] })))
      assert.equal(r.stopReason, "end_turn")
    }
    for (let i = 0; i < 4; i++) {
      const res = await kit.request(baseBody({ stream: false, tools: undefined, messages: [{ role: "user", content: `memory ${i}` }] }))
      assert.equal(res.status, 200)
      await res.text()
    }

    // 3. The stateful conversation must STILL be live in pool (evictLRU evicted ephemeral procs first)
    //    AND must still be present in sessions.json (never pushed out by ephemeral bursts).
    const state = JSON.parse(fs.readFileSync(kit.stateFile, "utf8"))
    assert.ok(state.entries.length <= 4)
    assert.ok(state.entries.some((e) => e.workDir === workDir), "stateful entry must survive in sessions.json")
    assert.ok(state.entries.filter((e) => e.ephemeral).length <= 1, "ephemeral entries must be bounded")

    const main2 = {
      ...main1,
      messages: [...main1.messages, { role: "assistant", content: mainRes1.content }, { role: "user", content: "stateful turn 2" }],
    }
    const spawnsBeforeMain2 = kit.acpSpawns.length
    const mainRes2 = await readSse(await kit.request(main2, statefulHeaders))
    assert.equal(mainRes2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, spawnsBeforeMain2, "stateful chat must still be live in pool, not evicted by ephemeral burst")
    assert.equal(mainSpawnCount, 1)
  })
})

test("/btw side question runs in isolated ephemeral session without poisoning or blocking main chat", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.text("main reply 1")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("btw side answer")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("main reply 2")
      return { stopReason: "end_turn", usage: USAGE }
    })

    const headers = { headers: { "x-magpie-session": "claude-btw-1" } }
    const m1 = baseBody({ tools: [READ_TOOL], messages: [{ role: "user", content: "start main task" }] })
    const r1 = await readSse(await kit.request(m1, headers))
    assert.equal(r1.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)

    // Send /btw with exact same session header, system, and history prefix
    const btw = {
      ...m1,
      messages: [
        ...m1.messages,
        { role: "assistant", content: r1.content },
        { role: "user", content: `${BTW_REMINDER}\nWhat does foo do?` },
      ],
    }
    const btwRes = await readSse(await kit.request(btw, headers))
    assert.equal(btwRes.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "/btw must use its own isolated agy process")

    // Verify /btw was NOT parked in sessions.json
    const state = JSON.parse(fs.readFileSync(kit.stateFile, "utf8"))
    assert.equal(state.entries.length, 1, "only main conversation should be parked")

    // Next real main turn (without /btw in history) MUST reuse main live session #1
    const m2 = {
      ...m1,
      messages: [
        ...m1.messages,
        { role: "assistant", content: r1.content },
        { role: "user", content: "continue main task" },
      ],
    }
    const r2 = await readSse(await kit.request(m2, headers))
    assert.equal(r2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "main conversation must reuse its original live agy without reset")
    const mainPrompts = kit.acpLog.filter((e) => e.method === "session/prompt" && e.spawn === 0)
    assert.equal(mainPrompts.length, 2, "original live agy must receive turn 1 and turn 2 directly")
  })
})

test("/btw side question succeeds concurrently while main chat is busy in a pending tool turn", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a" })
      await agent.text("main done")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("concurrent btw ok")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const headers = { headers: { "x-magpie-session": "claude-btw-busy" } }
    const m1 = baseBody({ tools: [READ_TOOL], messages: [{ role: "user", content: "read a file" }] })
    const r1 = await readSse(await kit.request(m1, headers))
    assert.equal(r1.stopReason, "tool_use")

    // While main turn is waiting on Read tool_result, /btw must NOT 503 and must NOT break main turn
    const btw = {
      ...m1,
      messages: [
        ...m1.messages,
        { role: "user", content: `${BTW_REMINDER}\nQuick question while you work?` },
      ],
    }
    const btwHttp = await kit.request(btw, headers)
    assert.equal(btwHttp.status, 200)
    const btwParsed = await readSse(btwHttp)
    assert.equal(btwParsed.stopReason, "end_turn")

    // Now deliver the real Read tool_result to the main turn: it still completes in live session #0
    const m2 = continueWithToolResults(m1, r1, () => "file contents")
    const r2 = await readSse(await kit.request(m2, headers))
    assert.equal(r2.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2)
  })
})

test("499 abort mid-generation after tool_result keeps live session (separate and merged user messages)", async () => {
  for (const merged of [false, true]) {
    await withKit({}, async (kit, stderr) => {
      kit.prompts.push(async (agent) => {
        agent.update({ sessionUpdate: "tool_call", toolCallId: "r1", status: "in_progress" })
        await agent.tool("Read", { path: "/file.ts" })
        agent.update({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" })
        // Emit partial text, then stall until aborted by client (499)
        await agent.text("partial uncommitted reply")
        await agent.waitCancel()
        return { stopReason: "cancelled", usage: USAGE }
      })
      kit.defaultPrompt = async (agent) => {
        await agent.text("continued after abort")
        return { stopReason: "end_turn", usage: USAGE }
      }

      const body1 = baseBody({ tools: [READ_TOOL], messages: [{ role: "user", content: "inspect file" }] })
      const res1 = await readSse(await kit.request(body1))
      assert.equal(res1.stopReason, "tool_use")

      const body2 = continueWithToolResults(body1, res1, () => "line 1: hello")
      const ac = new AbortController()
      const res2 = await kit.request(body2, { signal: ac.signal })
      const reader = res2.body.getReader()
      // Wait for at least one chunk so partial text is emitted, then abort like HTTP 499
      let sawText = false
      const dec = new TextDecoder()
      while (!sawText) {
        const { value, done } = await reader.read()
        if (done) break
        if (dec.decode(value).includes("partial uncommitted reply")) sawText = true
      }
      ac.abort(new Error("client disconnected"))
      try { await reader.cancel() } catch {}
      await sleep(30)

      // Next request: Claude Code drops the aborted assistant reply and sends
      // tool_result + "[Request interrupted by user]" + follow-up instruction.
      const followUp = merged
        ? {
            ...body2,
            messages: [
              ...body2.messages.slice(0, -1),
              {
                role: "user",
                content: [
                  ...body2.messages.at(-1).content,
                  { type: "text", text: "[Request interrupted by user]" },
                  { type: "text", text: "Stop and report status now" },
                ],
              },
            ],
          }
        : {
            ...body2,
            messages: [
              ...body2.messages,
              { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
              { role: "user", content: [{ type: "text", text: "Stop and report status now" }] },
            ],
          }

      const res3 = await readSse(await kit.request(followUp))
      assert.equal(res3.stopReason, "end_turn")
      assert.equal(kit.acpSpawns.length, 1, `must keep live session after 499 abort (merged=${merged})`)
      assert.ok(stderr.lines.some((r) => r.action === "kept" && r.reason === "cancelled_turn_continuation"))
      const sent = prompts(kit).at(-1)
      assert.match(sent, /Stop and report status now/)
      assert.ok(!sent.includes("line 1: hello"), "already-delivered tool_result must not be re-sent")
    })
  }
})
