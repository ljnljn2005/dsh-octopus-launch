// dsh-octopus-launch 本地测试：
// 用 /bin/sleep 复制成的假二进制模拟常驻服务，验证：
//   1. Config 校验与默认值
//   2. 首次 apply：先清理数据库（relay_logs 裁剪 + VACUUM + 删迁移备份）再后台拉起
//   3. 二次 apply 幂等（检测到已运行则跳过清理与启动）
//   4. 进程确认检测（启动后确认运行中）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

const FAKE = "/tmp/dsh-octopus-test/fakeoctopus";
const DB_DIR = "/tmp/dsh-octopus-test/data";
const DB = join(DB_DIR, "data.db");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 用 /bin/sleep 造一个进程名精确为 fakeoctopus 的假服务二进制。 */
function setupFakeBinary() {
	execFileSync("mkdir", ["-p", DB_DIR]);
	copyFileSync("/bin/sleep", FAKE);
}

/** 造一个带 relay_logs 表的假 octopus 数据库 + 迁移备份文件。 */
async function setupFakeDb() {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(DB);
	db.exec("CREATE TABLE relay_logs (id INTEGER PRIMARY KEY, request_content TEXT, response_content TEXT);");
	for (let i = 1; i <= 5; i++) {
		db.prepare("INSERT INTO relay_logs (request_content, response_content) VALUES (?, ?)").run("x".repeat(10000), "y".repeat(1000));
	}
	db.close();
	writeFileSync(`${DB}.old.20260816181708`, "fake backup");
}

async function relayLogCount() {
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(DB, { readOnly: true });
	try {
		return db.prepare("SELECT count(*) AS c FROM relay_logs").get().c;
	} finally {
		db.close();
	}
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
	assert.equal(config.clearDb, true, "默认 clearDb");
	assert.equal(config.retainRelayLogs, 1000, "默认 retainRelayLogs");
	assert.equal(config.vacuumDb, true, "默认 vacuumDb");
	assert.equal(config.deleteOldDbBackup, true, "默认 deleteOldDbBackup");
	console.log("✓ 场景1b 默认值校验");

	// 2. 准备假二进制 + 假数据库（5 条 relay_logs + 1 个迁移备份）
	setupFakeBinary();
	await setupFakeDb();
	killFake();
	await sleep(100);
	assert.equal(isFakeRunning(), false, "测试前 fakeoctopus 未运行");
	assert.equal(await relayLogCount(), 5, "测试前 relay_logs 有 5 条");
	assert.ok(existsSync(`${DB}.old.20260816181708`), "测试前迁移备份存在");

	// 3. 首次 apply → 先清理数据库（保留 2 条）再后台拉起
	const config2 = plugin.Config({
		binaryPath: FAKE,
		args: ["300"],
		confirmDelayMs: 500,
		recheckDelayMs: 50,
		retainRelayLogs: 2
	});
	const ctx1 = new Context();
	await ctx1.plugin(plugin, config2);
	for (let i = 0; i < 40; i++) {
		if (isFakeRunning()) break;
		await sleep(100);
	}
	assert.equal(isFakeRunning(), true, "首次 apply 后 fakeoctopus 应已运行");
	console.log("✓ 场景2 首次 apply 后台拉起成功");

	// 清理应已生效：relay_logs 剩 2 条、迁移备份被删
	assert.equal(await relayLogCount(), 2, "relay_logs 应裁剪到 2 条");
	console.log("✓ 场景2b relay_logs 已裁剪到 2 条");
	assert.ok(!existsSync(`${DB}.old.20260816181708`), "迁移备份应已删除");
	console.log("✓ 场景2c 迁移备份已删除");

	// 4. 二次 apply → 幂等跳过（不应再拉起，也不该清理已运行的库）
	const ctx2 = new Context();
	await ctx2.plugin(plugin, config2);
	await sleep(700);
	const count = execFileSync("pgrep", ["-x", "fakeoctopus"], { encoding: "utf8" })
		.trim().split("\n").filter(Boolean).length;
	assert.equal(count, 1, `二次 apply 不应重复拉起（当前 ${count} 个）`);
	assert.equal(await relayLogCount(), 2, "二次 apply 不应再改动 relay_logs");
	console.log("✓ 场景3 幂等：二次 apply 不重复拉起、不清理运行中的库");

	// 5. 清理
	killFake();
	await sleep(100);
	assert.equal(isFakeRunning(), false, "清理后 fakeoctopus 应停止");
	unlinkSync(FAKE);
	unlinkSync(DB);
	console.log("✓ 场景4 清理完成");

	console.log("\n全部测试通过 ✅");
}

main().catch((error) => {
	console.error("测试失败:", error);
	process.exit(1);
});
