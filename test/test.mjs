// dsh-octopus-launch 本地测试：
// 用 /bin/sleep 复制成的假二进制模拟常驻服务，验证：
//   1. Config 校验与默认值
//   2. 首次 apply 后台拉起目标进程（detached）
//   3. 二次 apply 幂等（检测到已运行则跳过）
//   4. 清理完成
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, unlinkSync } from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const FAKE = "/tmp/dsh-octopus-test/fakeoctopus";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用 /bin/sleep 造一个进程名精确为 fakeoctopus 的假服务二进制。 */
function setupFakeBinary() {
	execFileSync("mkdir", ["-p", "/tmp/dsh-octopus-test"]);
	copyFileSync("/bin/sleep", FAKE);
}

function isFakeRunning() {
	try {
		execFileSync("pgrep", ["-x", "fakeoctopus"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function killFake() {
	try {
		execFileSync("pkill", ["-x", "fakeoctopus"], { stdio: "ignore" });
	} catch {
		/* already dead */
	}
}

async function main() {
	// 1. Config 校验：binaryPath 必填
	let threw = false;
	try {
		plugin.Config({});
	} catch {
		threw = true;
	}
	assert.equal(threw, true, "binaryPath 缺失应报错");
	console.log("✓ 场景1 binaryPath 必填校验");

	const config = plugin.Config({ binaryPath: "/some/bin" });
	assert.equal(config.binaryPath, "/some/bin", "binaryPath 透传");
	assert.deepEqual(config.args, ["start"], "默认 args");
	assert.equal(config.autoStart, true, "默认 autoStart");
	console.log("✓ 场景1b 默认值校验");

	const bad = plugin.Config({ binaryPath: "/some/bin", args: ["start", "--port", "8080"] });
	assert.deepEqual(bad.args, ["start", "--port", "8080"], "args 可覆盖");
	console.log("✓ 场景1b args 覆盖");

	// 2. 假二进制准备
	setupFakeBinary();
	killFake();
	await sleep(100);
	assert.equal(isFakeRunning(), false, "测试前 fakeoctopus 未运行");

	// 3. 首次 apply → 后台拉起
	const config2 = plugin.Config({
		binaryPath: FAKE,
		args: ["300"],
		confirmDelayMs: 500,
		recheckDelayMs: 50
	});
	const ctx1 = new Context();
	await ctx1.plugin(plugin, config2);
	// 等待异步拉起 + 确认
	for (let i = 0; i < 40; i++) {
		if (isFakeRunning()) break;
		await sleep(100);
	}
	assert.equal(isFakeRunning(), true, "首次 apply 后 fakeoctopus 应已运行");
	console.log("✓ 场景2 首次 apply 后台拉起成功");

	// 4. 二次 apply → 幂等跳过（不应再拉起新进程）
	const ctx2 = new Context();
	await ctx2.plugin(plugin, config2);
	await sleep(700);
	// 统计 fakeoctopus 进程数量：应仍是 1 个
	const count = execFileSync("pgrep", ["-x", "fakeoctopus"], { encoding: "utf8" })
		.trim().split("\n").filter(Boolean).length;
	assert.equal(count, 1, `二次 apply 不应重复拉起（当前 ${count} 个）`);
	console.log("✓ 场景3 幂等：二次 apply 不重复拉起");

	// 5. 清理
	killFake();
	await sleep(100);
	assert.equal(isFakeRunning(), false, "清理后 fakeoctopus 应停止");
	unlinkSync(FAKE);
	console.log("✓ 场景4 清理完成");

	console.log("\n全部测试通过 ✅");
}

main().catch((error) => {
	console.error("测试失败:", error);
	process.exit(1);
});
