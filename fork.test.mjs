// laokashouji-agy-cli 自有的测试，单独放一个文件，同步上游时 agy-cli.test.mjs 不会因此冲突。
// 跑法与 agy-cli.test.mjs 相同：每个套件在独立的 bun 进程里运行。
import { expect, test } from "bun:test"
import path from "node:path"

const dir = path.join(import.meta.dir, "test")

for (const name of ["compaction-fork.mjs"]) {
  test(`test/${name}`, () => {
    const result = Bun.spawnSync({ cmd: [process.execPath, "test", "--timeout", "120000", `./${name}`], cwd: dir, env: { ...process.env, AGY_BRIDGE_STORED_SIGNIN: "skip" }, stdout: "pipe", stderr: "pipe", timeout: 240_000 })
    const output = result.stdout.toString() + result.stderr.toString()
    if (result.exitCode !== 0) console.error(output)
    expect(output).toMatch(/\b[1-9]\d* pass\b/)
    expect(result.exitCode).toBe(0)
  }, 250_000)
}
