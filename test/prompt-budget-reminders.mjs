import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

function utf8Bytes(text) {
  return Buffer.byteLength(text, "utf8")
}

async function captureFirstPrompt(body, env = {}) {
  const kit = await createBridgeKit({ env })
  let sent = ""
  try {
    kit.defaultPrompt = async (agent) => {
      sent = (agent.prompt || []).map((p) => p.text || "").join("")
      await agent.text("ok")
      return { stopReason: "end_turn" }
    }
    const parsed = await readSse(await kit.request(body))
    assert.equal(parsed.stopReason, "end_turn")
    return sent
  } finally {
    await kit.dispose()
  }
}

test("first turn slightly over 112 KiB preserves user prompt sandwiched between large system-reminders", async () => {
  const userAsk = "我之前在个人wiki中调研过paseo和t3 code等的差异，现在我想看看，t3 code的优点哪些是我可以在paseo上借鉴实现的"
  const claudeMd = "<system-reminder>\nCLAUDE_HEAD\n" + "a".repeat(52 * 1024) + "\nCLAUDE_TAIL\n</system-reminder>"
  const gitStatus = "<system-reminder>\ngitStatus: clean\n</system-reminder>"
  const skills = "<system-reminder>\nSKILLS_HEAD\n" + "b".repeat(55 * 1024) + "\nSKILLS_TAIL\n</system-reminder>"
  const system = "SYSTEM_HEAD\n" + "s".repeat(6 * 1024) + "\nSYSTEM_TAIL"

  const prompt = await captureFirstPrompt(baseBody({
    system,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: claudeMd },
          { type: "text", text: gitStatus },
          { type: "text", text: userAsk },
        ],
      },
      { role: "system", content: skills },
    ],
  }))

  const size = utf8Bytes(prompt)
  assert.ok(size <= 112 * 1024, `prompt exceeded 112 KiB: ${size}`)
  assert.ok(size > 110 * 1024, `clipMiddle over-trimmed prompt to ${size} bytes`)
  assert.ok(prompt.includes(userAsk), "user prompt must survive clipping intact")
  assert.ok(prompt.includes("CLAUDE_HEAD") && prompt.includes("CLAUDE_TAIL"), "smaller reminder stays intact")
  assert.ok(prompt.includes("SKILLS_HEAD") && prompt.includes("SKILLS_TAIL"), "clipped reminder keeps head and tail")
  assert.ok(prompt.includes("gitStatus: clean"))
  assert.equal((prompt.match(/<system-reminder>/g) || []).length, 3)
  assert.equal((prompt.match(/<\/system-reminder>/g) || []).length, 3)
})

test("both surrounding system-reminders far over budget water-fill evenly while keeping user prompt", async () => {
  const userAsk = "EXACT_USER_TASK: compare architecture and list top 3 improvements"
  const before = "<system-reminder>\nBEFORE_HEAD\n" + "x".repeat(75 * 1024) + "\nBEFORE_TAIL\n</system-reminder>"
  const after = "<system-reminder>\nAFTER_HEAD\n" + "y".repeat(75 * 1024) + "\nAFTER_TAIL\n</system-reminder>"

  const prompt = await captureFirstPrompt(baseBody({
    system: "You are a helpful coding assistant.",
    messages: [
      { role: "user", content: [{ type: "text", text: before }, { type: "text", text: userAsk }] },
      { role: "system", content: after },
    ],
  }))

  assert.ok(utf8Bytes(prompt) <= 112 * 1024)
  assert.ok(prompt.includes(userAsk), "user prompt must survive heavy reminder trimming")
  assert.ok(prompt.includes("BEFORE_HEAD") && prompt.includes("BEFORE_TAIL"))
  assert.ok(prompt.includes("AFTER_HEAD") && prompt.includes("AFTER_TAIL"))
  assert.equal((prompt.match(/<system-reminder>/g) || []).length, 2)
  assert.equal((prompt.match(/<\/system-reminder>/g) || []).length, 2)
})

test("oversized user prompt alongside large reminder shrinks reminder first to at most 25% of turn budget", async () => {
  const bigReminder = "<system-reminder>\nREM_HEAD\n" + "r".repeat(20 * 1024) + "\nREM_TAIL\n</system-reminder>"
  const bigUser = "USER_HEAD\n" + "u".repeat(30 * 1024) + "\nUSER_TAIL"

  const prompt = await captureFirstPrompt(
    baseBody({
      system: "Brief system.",
      messages: [{ role: "user", content: [{ type: "text", text: bigReminder }, { type: "text", text: bigUser }] }],
    }),
    { AGY_BRIDGE_MAX_PROMPT_BYTES: String(24 * 1024) },
  )

  assert.ok(utf8Bytes(prompt) <= 24 * 1024)
  assert.ok(prompt.includes("USER_HEAD") && prompt.includes("USER_TAIL"))
  assert.ok(prompt.includes("REM_HEAD") && prompt.includes("REM_TAIL"))
  const remMatch = /<system-reminder>[\s\S]*?<\/system-reminder>/.exec(prompt)
  assert.ok(remMatch, "reminder wrapper preserved")
  assert.ok(utf8Bytes(remMatch[0]) <= 6 * 1024, `reminder took ${utf8Bytes(remMatch[0])}B, expected <= 6 KiB`)
})

test("clipMiddle with multi-byte Chinese and emoji stays near budget without dropping 25% or splitting chars", async () => {
  const budget = 16 * 1024
  const body = baseBody({
    system: "System.",
    messages: [{ role: "user", content: "开头🚀" + "测试汉字😀".repeat(1200) + "结尾🎯" }],
  })

  const prompt = await captureFirstPrompt(body, { AGY_BRIDGE_MAX_PROMPT_BYTES: String(budget) })
  const size = utf8Bytes(prompt)
  assert.ok(size <= budget, `prompt exceeded budget: ${size}`)
  assert.ok(size > budget - 512, `clipMiddle wasted budget: ${size} / ${budget}`)
  assert.ok(prompt.includes("开头🚀") && prompt.includes("结尾🎯"))
  assert.ok(!prompt.includes("�"), "must not contain broken UTF-8 replacement chars")
})

test("small system-reminder stays intact when a huge tool_result is clipped", async () => {
  const budget = 16 * 1024
  const prompt = await captureFirstPrompt(
    baseBody({
      system: "System.",
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Read", input: { path: "/f" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "RES_HEAD " + "z".repeat(40 * 1024) + " RES_TAIL" }] },
        { role: "system", content: "<total_tokens>15000000 tokens left</total_tokens>" },
      ],
    }),
    { AGY_BRIDGE_MAX_PROMPT_BYTES: String(budget) },
  )

  assert.ok(utf8Bytes(prompt) <= budget)
  assert.ok(prompt.includes("RES_HEAD") && prompt.includes("RES_TAIL"))
  assert.ok(prompt.includes("<total_tokens>15000000 tokens left</total_tokens>"))
})
