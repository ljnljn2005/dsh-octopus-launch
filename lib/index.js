// dsh-octopus-launch
// DSH 插件：dsh 启动时自动在后台拉起一个外部程序（默认用于拉起
// Linux 版 octopus LLM 网关：/mnt/d/Programs/octopus/octopus start）。
//
// 特性：
//   - 幂等：先检测目标进程是否已在运行，在跑则跳过，绝不重复拉起
//   - 防并发：启动前二次检测，两个 dsh 同时启动时基本只会拉起一次
//   - 后台运行：detached + setsid，dsh 进程退出后目标进程继续存活
//   - 工作目录：自动设为二进制所在目录（octopus 用相对路径 ./data/config.json）
//   - 启动日志：输出到二进制目录旁的 <binary>.dsh.log，便于排障
//   - 失败仅记日志，绝不影响 dsh 主流程
import z from "@deepseek-ai/schemastery";
import { execFile, spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { openSync } from "node:fs";

const name = "octopus-launch";
/** 本插件不依赖任何注入服务（ctx.logger 为 cordis 内置）。 */
const inject = [];

const Config = z.object({
	/** 要拉起的可执行文件绝对路径（Linux/ELF 或任意脚本），必填，由用户自行配置 */
	binaryPath: z.string().required().description("要拉起的可执行文件绝对路径（必填），如 /mnt/d/Programs/octopus/octopus"),
	/** 启动参数，默认 ['start']（octopus 子命令） */
	args: z.array(z.string()).default(["start"]).description("启动参数，默认 ['start']"),
	/** 检测进程是否已运行的命令；留空则用 pgrep -x <二进制名> */
	detectCommand: z.string().default("").description("检测进程是否已运行的命令，留空则用 pgrep -x <binary 名>"),
	/** 启动日志输出文件；留空则写到 <binary 目录>/<binary 名>.dsh.log */
	logFile: z.string().default("").description("启动日志输出文件，留空则写到二进制同目录 <名>.dsh.log"),
	/** 是否在 dsh 启动时自动拉起 */
	autoStart: z.boolean().default(true).description("是否在 dsh 启动时自动拉起"),
	/** 启动后等待确认的毫秒数；0 表示不确认 */
	confirmDelayMs: z.number().default(1500).description("启动后等待确认的毫秒数，0 表示不确认"),
	/** 启动前二次检测的间隔（毫秒） */
	recheckDelayMs: z.number().default(300).description("启动前二次检测间隔（毫秒）")
});

/** 从 binaryPath 解析工作目录、进程名、检测命令与日志路径。 */
function resolveTarget(config) {
	const binaryPath = config.binaryPath;
	const binaryName = basename(binaryPath);
	const cwd = dirname(binaryPath);
	const detectCommand = config.detectCommand || `pgrep -x ${quote(binaryName)}`;
	const logFile = config.logFile || join(cwd, `${binaryName}.dsh.log`);
	return { binaryPath, binaryName, cwd, detectCommand, logFile };
}

/** shell 单引号转义，用于拼接检测命令。 */
function quote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 执行一条命令并返回 { exitCode, error }（不抛异常）。 */
function runCommand(command) {
	return new Promise((resolve) => {
		execFile("sh", ["-c", command], (error) => {
			if (!error) return resolve({ exitCode: 0, error: null });
			resolve({ exitCode: typeof error.code === "number" ? error.code : 1, error });
		});
	});
}

/** 检测目标进程是否已在运行。pgrep 不存在（127）时宁可尝试启动。 */
async function isRunning(detectCommand) {
	const result = await runCommand(detectCommand);
	if (result.error && result.exitCode === 127) return false;
	return result.exitCode === 0;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 后台拉起目标进程（detached + setsid），输出到日志文件。 */
function launchProcess(logger, config, target) {
	const logFd = openSync(target.logFile, "a");
	const child = spawn(target.binaryPath, config.args, {
		cwd: target.cwd,
		detached: true,
		stdio: ["ignore", logFd, logFd]
	});
	child.on("error", (error) => {
		logger.warn(`octopus-launch: 启动失败 ${target.binaryPath}: ${error.message}`);
	});
	child.unref();
	return child;
}

function apply(ctx, config) {
	if (!config.autoStart) return;
	/** 捕获 logger 引用，避免裸定时器回调时 fiber 已销毁。 */
	const logger = ctx.logger;
	const target = resolveTarget(config);
	void (async () => {
		try {
			if (await isRunning(target.detectCommand)) {
				logger.info(`octopus-launch: ${target.binaryName} 已在运行，跳过启动`);
				return;
			}
			// 启动前二次检测：缩小两个 dsh 同时启动的竞态窗口
			await sleep(config.recheckDelayMs);
			if (await isRunning(target.detectCommand)) {
				logger.info(`octopus-launch: ${target.binaryName} 已被其他实例拉起，跳过`);
				return;
			}
			const child = launchProcess(logger, config, target);
			logger.info(`octopus-launch: 已后台拉起 ${target.binaryPath} ${config.args.join(" ")} (pid ${child.pid ?? "?"})，日志: ${target.logFile}`);
			if (config.confirmDelayMs > 0) {
				setTimeout(async () => {
					try {
						if (!(await isRunning(target.detectCommand))) {
							logger.warn(`octopus-launch: ${target.binaryName} 启动后未检测到运行，请检查日志 ${target.logFile}`);
						} else {
							logger.info(`octopus-launch: ${target.binaryName} 确认运行中 ✓`);
						}
					} catch (error) {
						logger.warn(`octopus-launch: 启动确认失败: ${String(error)}`);
					}
				}, config.confirmDelayMs);
			}
		} catch (error) {
			logger.warn(`octopus-launch: 拉起 ${target.binaryPath} 出错: ${String(error)}`);
		}
	})();
}

export { Config, apply, inject, name };

