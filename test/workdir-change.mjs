// Claude Code's Bash tool persists working directory changes across calls, so a
// bare `cd <other-dir>` emits a new `Primary working directory: <other-dir>`
// reminder and causes Magpie to send an updated `x-magpie-work-dir` header.
// Because `agy` runs with `tools: []` in its own temporary workspace and every
// tool executes on the caller side, changing `x-magpie-work-dir` mid-session
// must keep the live (or parked) `agy` session instead of killing it and
// truncating history to the 112 KiB ACP replay budget.

import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  baseBody, continueWithToolResults, createBridgeKit, readSse,
} from "./testkit.mjs"

const USAGE = { inputTokens: 100, cachedReadTokens: 0, cachedWriteTokens: 0, outputTokens: 5, totalTokens: 105 }
const COMPACT = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n" +
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests."
const SUMMARY = "1. Primary Request and Intent: inspect repo A and run tests in repo B.\n\n" +
  "2. Key Technical Concepts: bare cd changed cwd mid-session.\n\n" +
  "3. Pending Tasks: finish verification."
const COMPACT_OPENING = "This session is being continued from a previous conversation that ran out of context. " +
  "The summary below covers the earlier portion of the conversation."

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

function makeDir(kit, name) {
  const dir = path.join(kit.tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function dirHeaders(dir) {
  return { headers: { "x-magpie-work-dir": encodeURIComponent(dir) } }
}

function addDirOf(spawn) {
  const idx = spawn.args.indexOf("--add-dir")
  return idx >= 0 ? spawn.args[idx + 1] : null
}

async function withKit(options, fn) {
  const stderr = captureStderr()
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit, stderr)
  } finally {
    await kit.dispose()
    stderr.restore()
  }
}

test("mid-turn tool result with changed x-magpie-work-dir keeps the live session and delivers the reminder", async () => {
  await withKit({}, async (kit, stderr) => {
    const dirA = makeDir(kit, "dir-a")
    const dirB = makeDir(kit, "dir-b")
    let receivedToolText = ""

    kit.prompts.push(async (agent) => {
      const reply = await agent.tool("Read", { path: "check" })
      receivedToolText = (reply?.result?.content || []).map((p) => p.text || "").join("\n")
      await agent.text("done in same session")
      return { stopReason: "end_turn", usage: USAGE }
    })

    const body = baseBody({
      system: "You are a helpful coding assistant.",
      messages: [{ role: "user", content: "run tests in repo B" }],
    })
    const first = await readSse(await kit.request(body, dirHeaders(dirA)))
    assert.equal(first.stopReason, "tool_use")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(addDirOf(kit.acpSpawns[0]), path.resolve(dirA))

    const next = continueWithToolResults(body, first, () => "tests passed")
    next.messages.at(-1).content.push({
      type: "text",
      text: `<system-reminder>\nPrimary working directory: ${dirB} (was ${dirA})\n</system-reminder>`,
    })
    const second = await readSse(await kit.request(next, dirHeaders(dirB)))

    assert.equal(second.stopReason, "end_turn")
    assert.equal(second.content.find((b) => b.type === "text")?.text, "done in same session")
    assert.equal(kit.acpSpawns.length, 1, "must not respawn agy when workDir changes mid-turn")
    assert.equal(stderr.lines.filter((row) => row.action === "drop_live").length, 0, JSON.stringify(stderr.lines))
    assert.equal(stderr.lines.filter((row) => row.action === "session_new").length, 1, JSON.stringify(stderr.lines))
    assert.ok(receivedToolText.includes(`Primary working directory: ${dirB}`), receivedToolText)
  })
})

test("follow-up user turn after x-magpie-work-dir change reuses the live session without replaying history", async () => {
  await withKit({}, async (kit, stderr) => {
    const dirA = makeDir(kit, "follow-a")
    const dirB = makeDir(kit, "follow-b")
    const prompts = []

    kit.defaultPrompt = async (agent) => {
      prompts.push({ session: agent.sessionId, text: (agent.prompt || []).map((p) => p.text || "").join("") })
      await agent.text(`reply ${prompts.length}`)
      return { stopReason: "end_turn", usage: USAGE }
    }

    const system = "You are a helpful coding assistant."
    let messages = [{ role: "user", content: "turn one secret alpha" }]
    const first = await readSse(await kit.request(baseBody({ system, messages }), dirHeaders(dirA)))
    messages = [
      ...messages,
      { role: "assistant", content: first.content.filter((b) => b.type === "text") },
      { role: "user", content: "turn two after cd" },
    ]
    const second = await readSse(await kit.request(baseBody({ system, messages }), dirHeaders(dirB)))

    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1].session, prompts[0].session)
    assert.ok(!prompts[1].text.includes("<conversation_history>"), prompts[1].text)
    assert.ok(!prompts[1].text.includes("turn one secret alpha"), prompts[1].text)
    assert.equal(stderr.lines.filter((row) => row.action === "session_new").length, 1)
  })
})

test("steered tool turn with changed x-magpie-work-dir steers in the live session", async () => {
  await withKit({}, async (kit, stderr) => {
    const dirA = makeDir(kit, "steer-a")
    const dirB = makeDir(kit, "steer-b")

    kit.prompts.push(async (agent) => {
      agent.update({ sessionUpdate: "tool_call", toolCallId: "c1", status: "in_progress" })
      await agent.tool("Read", { path: "/a" })
      agent.update({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" })
      await agent.waitCancel()
      return { stopReason: "cancelled", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text(`steered:${agent.sessionId}`)
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody({ system: "Stay focused.", messages: [{ role: "user", content: "start tool" }] })
    const first = await readSse(await kit.request(body, dirHeaders(dirA)))
    assert.equal(first.stopReason, "tool_use")

    const steered = continueWithToolResults(body, first, () => "tool output")
    steered.messages.at(-1).content.push({ type: "text", text: "now check the new folder instead" })
    const second = await readSse(await kit.request(steered, dirHeaders(dirB)))

    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(stderr.lines.filter((row) => row.action === "drop_live").length, 0, JSON.stringify(stderr.lines))
  })
})

test("compaction fork and compacted continuation stay in the live session after x-magpie-work-dir change", async () => {
  await withKit({}, async (kit, stderr) => {
    const dirA = makeDir(kit, "compact-a")
    const dirB = makeDir(kit, "compact-b")
    const prompts = []

    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((p) => p.text || "").join("")
      prompts.push({ session: agent.sessionId, text })
      await agent.text(text.includes("Your task is to create") ? `<summary>\n${SUMMARY}\n</summary>` : "noted")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const system = "You are a helpful coding assistant."
    let messages = []
    for (const [part, dir] of [["part 1", dirA], ["part 2", dirB]]) {
      messages = [...messages, { role: "user", content: part }]
      const res = await readSse(await kit.request(baseBody({ system, messages }), dirHeaders(dir)))
      messages = [...messages, { role: "assistant", content: res.content.filter((b) => b.type === "text") }]
    }

    const forked = [
      ...messages.slice(0, -2),
      { role: "user", content: [{ type: "text", text: "part 2\n" }, { type: "text", text: COMPACT }] },
    ]
    await readSse(await kit.request(baseBody({ system, messages: forked }), dirHeaders(dirB)))

    const opening = `${COMPACT_OPENING}\n\nSummary:\n${SUMMARY.replace(/\n\n+/g, "\n")}`
    const continued = await readSse(await kit.request(baseBody({
      system,
      messages: [{ role: "user", content: [{ type: "text", text: opening }, { type: "text", text: "part 3" }] }],
    }), dirHeaders(dirB)))

    assert.equal(continued.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 1)
    assert.ok(prompts.every((p) => p.session === prompts[0].session))
    assert.ok(stderr.lines.some((row) => row.action === "kept" && row.reason === "compaction_fork"))
    assert.ok(stderr.lines.some((row) => row.action === "kept" && row.reason === "compacted_opening"))
  })
})

test("parked session resumes in its original workspace and --add-dir even when x-magpie-work-dir changed", async () => {
  await withKit({ env: { AGY_BRIDGE_MAX_PROCS: "1" }, sessionResume: true }, async (kit) => {
    const dirA = makeDir(kit, "park-a")
    const dirB = makeDir(kit, "park-b")
    let sessionA = null

    kit.prompts.push(async (agent) => {
      sessionA = agent.sessionId
      await agent.text("reply A1")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("reply B1")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.prompts.push(async (agent) => {
      await agent.text("reply A2")
      return { stopReason: "end_turn", usage: USAGE }
    })

    const system = "You are a helpful coding assistant."
    const msgA1 = [{ role: "user", content: "conversation A start" }]
    await readSse(await kit.request(baseBody({ system, messages: msgA1 }), dirHeaders(dirA)))
    assert.ok(sessionA)
    const workspaceA = kit.acpSpawns[0].cwd
    assert.equal(addDirOf(kit.acpSpawns[0]), path.resolve(dirA))

    // Evict conversation A so it gets parked in sessions.json
    await readSse(await kit.request(baseBody({ system, messages: [{ role: "user", content: "conversation B filler" }] }), dirHeaders(dirB)))
    assert.equal(kit.acpSpawns.length, 2)

    // Continue conversation A with changed x-magpie-work-dir (dirB)
    const msgA2 = [
      ...msgA1,
      { role: "assistant", content: [{ type: "text", text: "reply A1" }] },
      { role: "user", content: "continue A in dirB" },
    ]
    const resumedRes = await readSse(await kit.request(baseBody({ system, messages: msgA2 }), dirHeaders(dirB)))
    assert.equal(resumedRes.stopReason, "end_turn")

    const resumes = kit.acpLog.filter((item) => item.method === "session/resume")
    assert.equal(resumes.length, 1, "must resume parked session instead of opening a fresh one")
    assert.equal(resumes[0].params.sessionId, sessionA)
    assert.equal(kit.acpSpawns[2].cwd, workspaceA, "resumed agy must stay in original workspace")
    assert.equal(addDirOf(kit.acpSpawns[2]), path.resolve(dirA), "resumed agy must keep original --add-dir for prompt cache")
  })
})

test("genuine system prompt change still drops the live session with reason instructions", async () => {
  await withKit({}, async (kit, stderr) => {
    const dirA = makeDir(kit, "sys-a")
    const dirB = makeDir(kit, "sys-b")

    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "a" })
      await agent.text("old")
      return { stopReason: "end_turn", usage: USAGE }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("new")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody({ system: "Rule version 1.", messages: [{ role: "user", content: "hi" }] })
    const first = await readSse(await kit.request(body, dirHeaders(dirA)))
    assert.equal(first.stopReason, "tool_use")

    const next = continueWithToolResults(body, first, () => "ok")
    next.system = "Rule version 2."
    const second = await readSse(await kit.request(next, dirHeaders(dirB)))

    assert.equal(second.stopReason, "end_turn")
    assert.equal(kit.acpSpawns.length, 2, "real system instruction change must still open a new session")
    assert.ok(stderr.lines.some((row) => row.action === "drop_live" && row.reason === "instructions"), JSON.stringify(stderr.lines))
  })
})

test("two separate fresh conversations with different x-magpie-work-dir still get separate sessions", async () => {
  await withKit({}, async (kit) => {
    const dirA = makeDir(kit, "fresh-a")
    const dirB = makeDir(kit, "fresh-b")

    kit.defaultPrompt = async (agent) => {
      await agent.text("ok")
      return { stopReason: "end_turn", usage: USAGE }
    }

    const body = baseBody({ system: "Same system.", messages: [{ role: "user", content: "same opener" }] })
    await readSse(await kit.request(body, dirHeaders(dirA)))
    await readSse(await kit.request(body, dirHeaders(dirB)))

    assert.equal(kit.acpSpawns.length, 2)
    assert.equal(addDirOf(kit.acpSpawns[0]), path.resolve(dirA))
    assert.equal(addDirOf(kit.acpSpawns[1]), path.resolve(dirB))
  })
})

function legacyInstructionsHash(system, workDir) {
  const note = `The caller's working directory is ${JSON.stringify(workDir)}. The environment the caller describes (working directory, platform, OS, shell, git status) is where every tool runs. The bridge's temporary workspace only holds its agent configuration; use the caller's environment for tool paths and commands.`
  const combined = system.trim() ? `${system}\n\n${note}` : note
  return crypto.createHash("sha256").update(combined.replace(/\s+/g, "")).digest("hex")
}

test("legacy parked session hashed with workDirNote still resumes after upgrade", async () => {
  await withKit({ sessionResume: true }, async (kit1) => {
    const dirA = makeDir(kit1, "legacy-a")
    const dirB = makeDir(kit1, "legacy-b")
    const stateFile = path.join(kit1.tmp, "legacy-sessions.json")
    const system = "You are a helpful coding assistant."
    const msgA1 = [{ role: "user", content: "legacy conversation start" }]
    let sessionA = null
    let workspaceA = null

    await withKit({ env: { AGY_BRIDGE_STATE_FILE: stateFile }, sessionResume: true }, async (oldHost) => {
      oldHost.prompts.push(async (agent) => {
        sessionA = agent.sessionId
        await agent.text("reply A1")
        return { stopReason: "end_turn", usage: USAGE }
      })
      await readSse(await oldHost.request(baseBody({ system, messages: msgA1 }), dirHeaders(dirA)))
      assert.ok(sessionA)
      workspaceA = oldHost.acpSpawns[0].cwd
    })

    // Start a fresh host instance reading the legacy sessions.json from disk
    await withKit({ env: { AGY_BRIDGE_STATE_FILE: stateFile }, sessionResume: true }, async (newHost) => {
      // Rewrite parked entry's instructionsHash to the pre-stripWorkDirNote hash
      // (and place its workspace under newHost.tmp since testkit isolates os.tmpdir() per kit)
      const expectedWorkspace = path.join(newHost.tmp, path.basename(workspaceA))
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
      const entryA = state.entries.find((e) => e.sessionId === sessionA)
      assert.ok(entryA)
      const newHash = entryA.instructionsHash
      entryA.instructionsHash = legacyInstructionsHash(system, path.resolve(dirA))
      entryA.workspace = expectedWorkspace
      assert.notEqual(entryA.instructionsHash, newHash, "legacy hash must differ from stripped hash")
      fs.writeFileSync(stateFile, JSON.stringify(state))

      newHost.prompts.push(async (agent) => {
        await agent.text("reply A2")
        return { stopReason: "end_turn", usage: USAGE }
      })

      const msgA2 = [
        ...msgA1,
        { role: "assistant", content: [{ type: "text", text: "reply A1" }] },
        { role: "user", content: "continue after plugin upgrade" },
      ]
      const resumedRes = await readSse(await newHost.request(baseBody({ system, messages: msgA2 }), dirHeaders(dirB)))
      assert.equal(resumedRes.stopReason, "end_turn")

      const resumes = newHost.acpLog.filter((item) => item.method === "session/resume")
      assert.equal(resumes.length, 1, "must resume legacy parked session instead of rebuilding")
      assert.equal(resumes[0].params.sessionId, sessionA)
      assert.equal(newHost.acpSpawns[0].cwd, expectedWorkspace)
      assert.equal(addDirOf(newHost.acpSpawns[0]), path.resolve(dirA))
    })
  })
})

test("legacy parked session still rejects resume when real system prompt changed", async () => {
  await withKit({ sessionResume: true }, async (kit1) => {
    const dirA = makeDir(kit1, "legacy-sys-a")
    const stateFile = path.join(kit1.tmp, "legacy-sys-sessions.json")
    const msgA1 = [{ role: "user", content: "legacy sys start" }]
    let sessionA = null

    await withKit({ env: { AGY_BRIDGE_STATE_FILE: stateFile }, sessionResume: true }, async (oldHost) => {
      oldHost.prompts.push(async (agent) => {
        sessionA = agent.sessionId
        await agent.text("reply A1")
        return { stopReason: "end_turn", usage: USAGE }
      })
      await readSse(await oldHost.request(baseBody({ system: "Rule v1.", messages: msgA1 }), dirHeaders(dirA)))
      assert.ok(sessionA)
    })

    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    const entryA = state.entries.find((e) => e.sessionId === sessionA)
    assert.ok(entryA)
    entryA.instructionsHash = legacyInstructionsHash("Rule v1.", path.resolve(dirA))
    fs.writeFileSync(stateFile, JSON.stringify(state))

    await withKit({ env: { AGY_BRIDGE_STATE_FILE: stateFile }, sessionResume: true }, async (newHost) => {
      newHost.prompts.push(async (agent) => {
        await agent.text("reply A2 fresh")
        return { stopReason: "end_turn", usage: USAGE }
      })
      const msgA2 = [
        ...msgA1,
        { role: "assistant", content: [{ type: "text", text: "reply A1" }] },
        { role: "user", content: "continue with different system prompt" },
      ]
      const res = await readSse(await newHost.request(baseBody({ system: "Rule v2.", messages: msgA2 }), dirHeaders(dirA)))
      assert.equal(res.stopReason, "end_turn")

      const resumes = newHost.acpLog.filter((item) => item.method === "session/resume")
      assert.equal(resumes.length, 0, "genuine system prompt change must not resume legacy parked session")
    })
  })
})

