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

## 数据库手动清理（可选）

octopus 会把每次转发的完整请求体存入 `data/data.db` 的 `relay_logs` 表，长期运行可能涨到十几 GB。仓库内附带安全清理脚本 `cleanup.sh`（**重建策略**，非 DELETE+VACUUM——后者在大库上中断会导致 SQLite 文件损坏），放在 octopus 目录下执行即可：

```sh
cd /mnt/d/Programs/octopus
./cleanup.sh              # 默认：清空 relay_logs，保留 1 个备份
./cleanup.sh --keep=3     # 保留最近 3 个备份
RESTART=0 ./cleanup.sh    # 清理后不重启 octopus
```

执行流程：停止 octopus → 原库 mv 备份为 `data/data.db.bak.<时间戳>`（零风险回退点）→ 复制完整 schema + 全部配置/统计表数据（`relay_logs` 建空表）→ `PRAGMA integrity_check` 验证 → 失败自动回滚 → 新库就位 → 重启。配置数据（渠道/API Key/价格）永远保留，只有转发日志被清空。

## 本地测试

```sh
node test/test.mjs
```

用 `/bin/sleep` 复制成的假二进制模拟常驻服务，验证后台拉起、幂等去重、进程确认。
