# dsh-octopus-launch

DSH（DeepSeek Harness）插件：**dsh 启动时自动在后台拉起外部程序**，默认配置用于拉起 Linux 版 octopus LLM 网关（`/mnt/d/Programs/octopus/octopus start`）。

## 特性

| 特性 | 说明 |
|---|---|
| 幂等 | 先 `pgrep` 检测目标进程，已在运行则跳过，绝不重复拉起 |
| 防并发 | 启动前二次检测，两个 dsh 同时启动时基本只会拉起一次 |
| 后台运行 | `detached` + setsid，dsh 进程退出后目标进程继续存活 |
| 工作目录 | 自动设为二进制所在目录（octopus 用相对路径 `./data/config.json`） |
| 启动日志 | 输出到 `<二进制目录>/<二进制名>.dsh.log`，便于排障 |
| 失败隔离 | 任何失败只记日志，绝不影响 dsh 主流程 |

## 安装

```sh
dsh plugin --profile web add github:ljnljn2005/dsh-octopus-launch
dsh plugin --profile headless add github:ljnljn2005/dsh-octopus-launch   # 可选
```

profile 的 `cordis.patch.yml` 中启用（**`binaryPath` 必填，按你的环境填写**）：

```yaml
- insert:
    - id: octopus-launch
      name: 'dsh-octopus-launch'
      config:
        binaryPath: '/mnt/d/Programs/octopus/octopus'
        args:
          - start
```

## 配置项

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `binaryPath` | string | **必填** | 要拉起的可执行文件绝对路径（按自己环境填） |
| `args` | string[] | `["start"]` | 启动参数 |
| `detectCommand` | string | `pgrep -x <二进制名>` | 检测进程是否已运行的命令 |
| `logFile` | string | `<二进制目录>/<名>.dsh.log` | 启动日志输出文件 |
| `autoStart` | boolean | `true` | 是否在 dsh 启动时自动拉起 |
| `confirmDelayMs` | number | `1500` | 启动后等待确认的毫秒数；0 = 不确认 |
| `recheckDelayMs` | number | `300` | 启动前二次检测间隔（毫秒） |

## 本地测试

```sh
node test/test.mjs
```

用 `/bin/sleep` 复制成的假二进制模拟常驻服务，验证后台拉起、幂等去重、进程确认。
