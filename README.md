# @gw/dsh-tools-manager

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4b8bbe?logo=github)](https://github.com/topics/dsh-plugin)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

按 **Agent 预设（模式）** 禁用工具。装完什么都不禁，哪个模式要禁什么，去设置页点。

**只有黑名单，没有白名单。** 没被点名禁用的工具一概不碰 —— 它能不能用、该不该出现，
由 dsh 自己、preset 挂载了哪些插件、别的插件有没有 restrict 决定，本插件一概不管也不猜。
所以设置页里没有「已启用」这一栏。

## 功能

| 能力 | 说明 |
|---|---|
| 按模式禁用 | 规则按 preset id 索引（`standard` / `qq` / 任意自定义），各管各的 |
| 两层拦截 | `restrict` 让模型看不见 schema；`guard` 让调用被拒。看不见的调不了，中途才注册的也拦得住 |
| 兜底规则 | `'*'` 一条覆盖所有没有单独配置的模式 |
| 设置页 | 一行一个工具，右边一个开关。开关打开 = 禁用 |

## 安装

1. 把本包放进对应 profile 的 node_modules（scope 目录 `@gw`），或用 link：

   ```bash
   # web profile（桌面客户端换成 profiles/desktop）
   ln -s /path/to/dsh-tools-manager ~/.dsh/profiles/web/node_modules/@gw/
   ```

   ⚠ 必须挂**裸包名**且包要真在 profile 的 `node_modules` 里（link 也算）。
   用 `file://` 会连坐搞挂整个前端 bundle。

2. 在 profile 的 `cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: tools-manager
         name: '@gw/dsh-tools-manager'
   ```

3. 重启 dsh，设置页 → 左侧栏出现「**工具管理**」。

## 设置页

顶部选模式，下面一张表：

| 看到的样子 | 意思 |
|---|---|
| 开关关闭、无标签 | 本插件没禁它，且这个模式当前能用到 |
| 开关变红 + 「已禁用」 | 本插件禁了。模型看不到 schema，硬调会被拒 |
| 灰标签「不可见」 | 本插件没动它，但它在选中的模式里现在不出现 —— 可能属于别的模式，或被别的插件挡了 |

每行右侧的「说明」点开显示这个工具的 `description`，直接从 schema 上取；已禁用的也能看
（描述是在装限制之前缓存下来的）。列表固定按名字排，禁用不会置顶。

该模式没有活动会话时，顶部会明说清单来自全局注册表、仅供参考 —— 没有 agent 实例就
查不到这个 preset 的真实工具集，这一点不装懂。

## 规则文件

`~/.dsh/plugin-data/tools-manager/rules.json`（`DSH_HOME` 可改根目录）：

```json
{
  "version": 2,
  "rules": {
    "qq": { "deny": ["bash", "subagent_fork"] },
    "*": { "deny": [] }
  }
}
```

- 按 **preset id** 索引，不按 profile 分目录 —— preset 名跨 profile 唯一。
- 首次启动会把旧版的 `denyNames` 合并迁移成 v2 的 `deny`（旧文件原地保留，不再读取）。
- 规则里点了名、但当前不存在的工具会被原样保留：`restrict` 自动跳过它，
  `guard` 留着当防线，下次它出现时立刻生效。

## 实现要点

两个 API 都必须注册在 **agent 自己的 ctx** 上，而且必须**全撤全装**：

- `ctx.tools.restrict({ deny })` —— 只过滤「继承来的」工具，永远不过滤本层注册的；
  dsh 的 restriction 是 intersect 语义，每调一次就 append 一条新层，旧的不撤会一直
  deny 到进程退出（0.2.0 就是栽在这）。
- `ctx.tools.guard(fn)` —— monotonic，返回字符串即拒绝，任何 guard 都不能反向开绿灯。

## 许可

MIT
