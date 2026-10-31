/**
 * dsh-tools-manager —— 按 Agent 预设（模式）隐藏工具，带设置页。
 *
 * ── 机制（官方唯一认可的做法）─────────────────────────────────
 * 隐藏工具只能用 ctx.tools.restrict()，而且必须调在**那个 agent 自己的 ctx** 上。
 *
 * 官方文档原话：
 *   "Hiding tools from one agent is `ctx.tools.restrict()` on that agent's context;
 *    it keeps schema presentation, lookup, and execution aligned.
 *    Do not listen to `system-prompt/assemble` to add or remove tools or text."
 *
 * 官方自己应用 subagent toolFilter 的写法（applyChildOverrides）：
 *   childCtx.tools.restrict(composition.toolFilter)
 *   —— 直接用属性访问，**没有经过 inject**。
 *
 * ⚠ 踩过的两个坑，别再犯：
 *   1) agent.ctx.inject(['tools'], scope => scope.tools.restrict(...)) 不生效。
 *      inject 会派生出一个新的子 scope，scopeOf(this.ctx) 认到的是那个子 scope，
 *      限制落在了子 scope 上，跟真正的 agent 不是一回事。必须用 agent.ctx.tools。
 *   2) 用 system-prompt/assemble 改 result.tools 不生效，而且官方明确禁止。
 *      工具 schema 不是从那条路送达模型的。
 *
 * restrict 的返回值就是撤销句柄，绑在 agent 的 fiber 上，agent 销毁自动解除。
 *
 * ── 规则来源（后者覆盖前者）──────────────────────────────────
 *   1. config.rules  —— cordis.patch.yml 里的初始值
 *   2. rules.json    —— 设置页保存的结果（~/.dsh/plugin-data/tools-manager/rules.json）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'tools-manager'

/**
 * inject 声明：cordis 严格模式下，没声明就访问属性会直接抛错，而且它还会等你声明的服务就绪。
 *   webServer    —— 设置页接口（不 inject 会 404）
 *   agentPresets —— 读「这个 agent 实际挂载的 preset」，核心依赖
 * tools / dshHomePath 走 ctx.get()，按可选处理（拿不到就降级，不让插件起不来）。
 */
export const inject = ['webServer', 'agentPresets']


/**
 * 当前 profile 名（没有就是空串）。判定顺序照 @gw/dsh-media-studio 的 profile-dir.js：
 * DSH_PROFILE 环境变量 → CLI argv（--profile x / --profile=x / dsh x）→ 空。
 * 只有 <home>/profiles/<name> 真实存在才算数，避免写到一个不存在的目录。
 */
function detectProfileName(ctx) {
    const base = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
    const profilesDir = join(base, 'profiles')
    const valid = (raw) => {
        const value = String(raw ?? '').trim()
        if (value === '' || value.startsWith('.') || value.includes('..')) return ''
        if (/[\\/:*?"<>|]/.test(value)) return ''
        return existsSync(join(profilesDir, value)) ? value : ''
    }
    const fromEnv = valid(process.env.DSH_PROFILE)
    if (fromEnv !== '') return fromEnv
    const argv = process.argv.slice(2)
    for (let i = 0; i < argv.length; i += 1) {
        const arg = String(argv[i] ?? '')
        if (arg === '--profile') return valid(argv[i + 1])
        if (arg.startsWith('--profile=')) return valid(arg.slice('--profile='.length))
        if (i === 0 && arg !== '' && !arg.startsWith('-') && arg !== 'plugin') return valid(arg)
    }
    // ③ 从 cordis 的 ctx 推断：profile 启动时 baseDir/baseUrl 指向 <home>/profiles/<name>。
    //    ⚠ 严格模式下访问未 inject 的属性会直接抛错（cannot get property "x" without inject），
    //    所以每一次访问都必须单独包在 try 里 —— 写成数组字面量再 for 就晚了，求值那一步就炸。
    const probes = []
    const probe = (getter) => {
        try {
            const value = getter()
            if (typeof value === 'string' && value !== '') probes.push(value)
        } catch {
            /* 这个属性需要 inject 或有副作用，跳过 */
        }
    }
    probe(() => ctx?.baseUrl)
    probe(() => ctx?.baseDir)
    probe(() => ctx?.get?.('loader')?.baseDir)
    probe(() => ctx?.get?.('loader')?.baseUrl)

    for (const raw of probes) {
        try {
            const dir = raw.startsWith('file:') ? fileURLToPath(raw) : raw
            const matched = /[\\/]profiles[\\/]([^\\/]+)/.exec(dir)
            if (matched !== null) {
                const name = valid(matched[1])
                if (name !== '') return name
            }
        } catch {
            /* 换下一个来源 */
        }
    }
    return ''
}

/** 设置页接口前缀 —— 浏览器半的 fetch 必须跟这里一致。 */
const API_PREFIX = '/api/plugins/tools-manager'

/** 内置模式，拿不到名册时兜底用（不是白名单，只是提示）。 */
const BUILTIN_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

function stringsOf(value) {
    if (!Array.isArray(value)) return []
    return value.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

/** 把一条规则归一化；空规则返回 undefined（视为没配）。只有「要禁什么」，没有「要启用什么」。 */
function normalizeRule(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const rule = {
        denyNames: stringsOf(raw.denyNames),
        denyPrefixes: stringsOf(raw.denyPrefixes)
    }
    if (rule.denyNames.length === 0 && rule.denyPrefixes.length === 0) return undefined
    return rule
}

/** 从 restrict 的报错里把 known global tools 列表抠出来，用于自动纠错。 */
function parseKnownTools(message) {
    const matched = /known global tools: ([\s\S]*)$/.exec(String(message ?? ''))
    if (matched === null) return undefined
    const listed = matched[1].trim()
    if (listed === '' || listed === '(none)') return new Set()
    return new Set(
        listed
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item !== '')
    )
}

function ruleMatches(toolName, rule) {
    if (rule.denyNames.includes(toolName)) return true
    return rule.denyPrefixes.some((prefix) => toolName.startsWith(prefix))
}

export function apply(ctx, config) {
    const source = config ?? {}
    // 严格模式下访问未 inject 的属性会抛错；日志本身绝不能成为插件启动失败的原因
    const warn = (line) => {
        try {
            ctx.logger?.warn?.(`[tools-manager] ${line}`)
        } catch {
            /* 日志写不了就算了 */
        }
    }
    const info = (line) => {
        try {
            ctx.logger?.info?.(`[tools-manager] ${line}`)
        } catch {
            /* 同上 */
        }
    }

    // ── 规则存储（按 profile 分开）──────────────────────────────
    // <home>/profiles/<profile>/tools-manager/ —— 不同 profile 的规则互不干扰，
    // QQ 模式禁了什么不会连累桌面端标准模式。没有 profile 时才退回 home 级目录。
    const home = (() => {
        const base = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
        const profile = detectProfileName(ctx)
        if (profile !== '') return join(base, 'profiles', profile, 'tools-manager')
        try {
            const provided = ctx.get?.('dshHomePath')
            if (typeof provided === 'function') {
                const resolved = provided('plugin-data', 'tools-manager')
                if (typeof resolved === 'string' && resolved !== '') return resolved
            }
        } catch {
            /* 拿不到就用下面这个 */
        }
        return join(base, 'plugin-data', 'tools-manager')
    })()
    const rulesFile = join(home, 'rules.json')

    // 从旧的全局目录迁移一次（只在按 profile 的新位置还没有规则时做，避免覆盖）
    try {
        const legacyBase = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
        const legacyRules = join(legacyBase, 'plugin-data', 'tools-manager', 'rules.json')
        if (!existsSync(rulesFile) && existsSync(legacyRules) && legacyRules !== rulesFile) {
            mkdirSync(home, { recursive: true })
            writeFileSync(rulesFile, readFileSync(legacyRules), 'utf8')
        }
    } catch {
        /* 迁移失败就当没有，用户重配即可 */
    }

    const readDiskRules = () => {
        try {
            const parsed = JSON.parse(readFileSync(rulesFile, 'utf8'))
            const raw = parsed?.rules
            if (raw === null || typeof raw !== 'object') return {}
            return raw
        } catch {
            return {}
        }
    }

    const writeDiskRules = (rawRules) => {
        try {
            mkdirSync(dirname(rulesFile), { recursive: true })
            writeFileSync(rulesFile, JSON.stringify({ version: 1, rules: rawRules }, null, 2), 'utf8')
            return true
        } catch (error) {
            warn(`规则写入失败：${error?.message}`)
            return false
        }
    }

    const loadRules = () => {
        const merged = {}
        const fromConfig = source.rules !== null && typeof source.rules === 'object' ? source.rules : {}
        for (const [presetId, raw] of Object.entries(fromConfig)) merged[presetId] = raw
        for (const [presetId, raw] of Object.entries(readDiskRules())) merged[presetId] = raw
        const compiled = new Map()
        for (const [presetId, raw] of Object.entries(merged)) {
            const rule = normalizeRule(raw)
            if (rule !== undefined) compiled.set(presetId, rule)
        }
        return compiled
    }

    const fallbackRule = normalizeRule(source.defaultRule)
    let rules = loadRules()

    /** 规则版本号：每次保存 +1。agent 版本落后就在下一次 pre-step 重装。 */
    let rulesVersion = 0

    /** 见过的工具名，给设置页列清单（按 agent 视角收集）。 */
    const catalog = new Set()
    const catalogFile = join(home, 'catalog.json')
    let lastCatalogWrite = 0

    // 目录落盘：重启后设置页立刻能列出完整清单，不用先聊一句等现场采集
    try {
        const stored = JSON.parse(readFileSync(catalogFile, 'utf8'))
        if (Array.isArray(stored)) {
            for (const item of stored) if (typeof item === 'string' && item !== '') catalog.add(item)
        }
    } catch {
        // 新位置还没有：把旧的全局清单搬过来（只搬工具名，不涉及规则）
        try {
            const legacyBase = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
            const legacyCatalog = join(legacyBase, 'plugin-data', 'tools-manager', 'catalog.json')
            if (existsSync(legacyCatalog)) {
                const stored = JSON.parse(readFileSync(legacyCatalog, 'utf8'))
                if (Array.isArray(stored)) {
                    for (const item of stored) if (typeof item === 'string' && item !== '') catalog.add(item)
                }
            }
        } catch {
            /* 搬不动就重新采集 */
        }
    }

    const saveCatalog = (force) => {
        const now = Date.now()
        if (force !== true && now - lastCatalogWrite < 3000) return
        lastCatalogWrite = now
        try {
            mkdirSync(home, { recursive: true })
            writeFileSync(catalogFile, JSON.stringify([...catalog].sort(), null, 2), 'utf8')
        } catch {
            /* 写不了不影响主流程 */
        }
    }

    /** agent → 自愈重试次数（防止限制一直丢失时无限重装） */
    const healAttempts = new Map()

    /** agent → { presetId, version, fiber, sync, reset, collect, needsHeal } */
    const agents = new Map()

    /**
     * fiber.dispose() 可能同步返回、也可能返回 Promise。
     * 同步 try 接不住 Promise 的 reject，而返回值是 undefined 时 `.catch?.()` 又会抛 TypeError，
     * 所以统一走这里，两种情况都吞掉 —— 销毁失败不该连累插件。
     */
    const safeDispose = (fiber) => {
        try {
            const result = fiber?.dispose?.()
            if (result !== null && result !== undefined && typeof result.catch === 'function') {
                result.catch(() => {})
            }
        } catch {
            /* 忽略 */
        }
    }

    /**
     * sessionId → 上次确认过的 presetId。
     * agent 实例可能被重建（重建后 composedPreset 有一段查不到的窗口），靠它跨实例沿用，
     * 否则每次重建都会先退回 standard、把限制全撤掉，看起来就是工具忽然又全回来了。
     */
    const lastPresetBySession = new Map()

    const ruleFor = (presetId) => rules.get(presetId) ?? rules.get('*') ?? fallbackRule

    /**
     * 读一个 agent 真正在用的 preset id。
     *
     * 权威来源是 agentPresets.composedPreset(agent.ctx) —— 直接查这个 agent 挂载的组合
     * （官方原话：Read the preset a live Agent uses）。header.agentPreset 只是创建时的
     * 初值，像 QQ 机器人这种自己 mount preset 的，header 里留的还是 standard，靠它会认错模式。
     *
     * ⚠ 判定要「粘」：composedPreset 在某些时刻会查不到（generation 没就绪），这时**必须沿用
     *   上一次确认过的 id**，不能退回 header 猜的值。否则会 一会有规则→撤销→再有规则 地来回抖，
     *   表现就是「重启后工具变少，聊一句又全回来了」。
     */
    const resolvePresetId = (agent, previous) => {
        try {
            const presets = ctx.get?.('agentPresets')
            if (typeof presets?.composedPreset === 'function') {
                const composed = presets.composedPreset(agent.ctx)
                if (typeof composed === 'string' && composed !== '') return { id: composed, source: 'composedPreset' }
            }
        } catch (error) {
        }
        if (previous !== undefined && previous !== '') return { id: previous, source: 'cached' }
        const header = agent?.session?.header
        const fromHeader = typeof header?.agentPreset === 'string' && header.agentPreset !== '' ? header.agentPreset : ''
        if (fromHeader !== '') return { id: fromHeader, source: 'header' }
        return { id: 'standard', source: 'default' }
    }

    const install = (agent) => {
        if (agent === null || typeof agent !== 'object') return
        if (agents.has(agent)) return
        const header = agent?.session?.header
        if (header === undefined || header === null) return

        const sessionId = typeof header.id === 'string' ? header.id : ''
        const resolved = resolvePresetId(agent, sessionId === '' ? undefined : lastPresetBySession.get(sessionId))
        const presetId = resolved.id
        if (sessionId !== '') lastPresetBySession.set(sessionId, presetId)

        const state = {
            presetId,
            version: rulesVersion,
            fiber: undefined,
            sync: () => {},
            reset: () => {},
            collect: () => [],
            needsHeal: () => false
        }
        let currentRule = ruleFor(presetId)

        // 两个候选作用域：inject 回调的 scope（官方 installPrompt 的用法）与 agent.ctx
        // 本身（官方 applyChildOverrides 的用法）。哪个能让 restrict 通过就用哪个 ——
        // 这决定了限制落在 agent 上还是落在派生 scope 上，不能想当然。
        state.fiber = agent.ctx.inject(['tools'], (injected) => {
            const candidates = []
            const pushCandidate = (label, tools) => {
                try {
                    if (tools !== undefined && tools !== null && typeof tools.restrict === 'function') {
                        candidates.push({ label, tools })
                    }
                } catch {
                    /* 属性访问可能抛错 */
                }
            }
            // ① preset 组内的 tools 服务 —— 官方 serviceFor 就是为「取 Agent preset 组里的服务」设计的。
            //    运行时切 preset 会重建 scope 链，agent.ctx 上那个多半已经作废，这个是当前 mount 的。
            try {
                const presets = ctx.get?.('agentPresets')
                if (typeof presets?.serviceFor === 'function') {
                    pushCandidate('preset-service', presets.serviceFor(agent, 'tools'))
                }
            } catch (error) {
            }
            // ② agent 自己的 ctx
            try {
                pushCandidate('agent.ctx', agent.ctx?.tools)
            } catch {
                /* 属性访问可能抛错 */
            }
            // ③ inject 回调派生的 scope
            try {
                pushCandidate('inject-scope', injected?.tools)
            } catch {
                /* 同上 */
            }
            if (candidates.length === 0) {
                warn(`[${presetId}] 拿不到 tools 服务，跳过`)
                return
            }

            let denied = new Set()
            const unrestrictable = new Set()
            let dispose

            const readSchemas = (tools) => {
                try {
                    const direct = tools.schemas(agent)
                    if (Array.isArray(direct)) return direct
                } catch {
                    /* 换下一个形式 */
                }
                try {
                    const plain = tools.schemas()
                    if (Array.isArray(plain)) return plain
                } catch {
                    /* 两个形式都不行就当没有 */
                }
                return undefined
            }

            const visibleNames = () => {
                let schemas
                for (const candidate of candidates) {
                    schemas = readSchemas(candidate.tools)
                    if (schemas !== undefined) break
                }
                if (!Array.isArray(schemas)) return []
                const names = []
                for (const schema of schemas) {
                    const name = schema?.name
                    if (typeof name === 'string' && name !== '') names.push(name)
                }
                let fresh = 0
                for (const name of names) {
                    if (!catalog.has(name)) {
                        catalog.add(name)
                        fresh += 1
                    }
                }
                if (fresh > 0) saveCatalog()
                return names
            }
            state.collect = visibleNames

            /**
             * 按候选顺序试 restrict。两条判据缺一不可：
             *   a) 不抛错（作用域被认）；
             *   b) 限制后重读 schemas，被 deny 的名字真的消失了。
             * 只满足 a 不满足 b 就是「静默无效」—— 派生的子 scope 会照单全收，
             * 但限制根本不落在 agent 上，这是我们反复踩的那个坑。
             */
            const tryRestrict = (filter) => {
                const errors = []
                for (const candidate of candidates) {
                    let handle
                    try {
                        handle = candidate.tools.restrict(filter)
                    } catch (error) {
                        errors.push(`${candidate.label}: ${error?.message}`)
                        continue
                    }
                    const schemas = readSchemas(candidate.tools)
                    if (Array.isArray(schemas)) {
                        const stillThere = schemas
                            .map((schema) => schema?.name)
                            .filter((name) => typeof name === 'string' && filter.deny.includes(name))
                        if (stillThere.length > 0) {
                            errors.push(`${candidate.label}: 未生效（${stillThere.length} 个仍在）`)
                            try {
                                if (typeof handle === 'function') handle()
                            } catch {
                                /* 撤销失败就留着 */
                            }
                            continue
                        }
                    }
                    info(`[${presetId}] 已遮蔽 ${filter.deny.length} 个（via ${candidate.label}）：${filter.deny.join(' ')}`)
                    // 关键：限制是在 recompose 之后才加上的，而 recompose 的 tools/change 早就发完了。
                    // 补发一次，逼会话按新的（受限的）工具集重算，否则它还用切换时算好的那份 40 个。
                    try {
                        ctx.emit?.('tools/change')
                    } catch {
                        /* 拿不到事件总线就算了 */
                    }
                    return { handle, label: candidate.label }
                }
                return { handle: undefined, errors }
            }

            const applyRestriction = () => {
                const previous = dispose
                // 只有 deny：不传 allow，别去掺和「哪些该保留」——那是别的插件的事
                const filter = { deny: [...denied] }
                dispose = undefined
                const outcome = tryRestrict(filter)
                if (outcome.handle !== undefined) {
                    dispose = outcome.handle
                    return
                }
                // 报错里带 known global tools 时，说明名单里有不可限制的名字，剔除后重试一次
                const known =
                    outcome.errors === undefined ? undefined : parseKnownTools(outcome.errors.join(' '))
                if (known === undefined) {
                    warn(`[${presetId}] restrict 失败：${(outcome.errors ?? []).join(' | ')}`)
                    dispose = previous
                    return
                }
                for (const name of [...denied]) {
                    if (!known.has(name)) {
                        unrestrictable.add(name)
                        denied.delete(name)
                    }
                }
                if (denied.size === 0) {
                    warn(`[${presetId}] 名单里没有可限制的工具，这次不遮蔽（known 共 ${known.size} 个）`)
                    dispose = previous
                    return
                }
                const retry = tryRestrict({ deny: [...denied] })
                if (retry.handle !== undefined) {
                    dispose = retry.handle
                } else {
                    warn(`[${presetId}] restrict 重试仍失败：${(retry.errors ?? []).join(' | ')}`)
                    dispose = previous
                }
            }

            // 自愈探针：切换 preset 会重建 layer，restriction 可能整条丢掉，
            // 症状就是「本该遮蔽的工具又出现在 schemas 里」。
            state.needsHeal = () => {
                if (denied.size === 0) return false
                const names = visibleNames()
                if (names.length === 0) return false
                return [...denied].some((name) => names.includes(name))
            }

            // 只增不减，避免 schemas() 反映 restriction 后造成震荡
            state.sync = () => {
                const names = visibleNames()
                if (currentRule === undefined || names.length === 0) return
                let added = 0
                for (const toolName of names) {
                    if (unrestrictable.has(toolName)) continue
                    if (denied.has(toolName)) continue
                    if (!ruleMatches(toolName, currentRule)) continue
                    denied.add(toolName)
                    added += 1
                }
                if (added === 0 && dispose !== undefined) return
                if (denied.size === 0) return
                applyRestriction()
            }

            // 全量重算：唯一允许减少的路径（设置页保存后走这里）
            state.reset = (nextRule) => {
                currentRule = nextRule
                if (dispose !== undefined) {
                    try {
                        dispose()
                    } catch {
                        /* 撤销失败不影响重装 */
                    }
                }
                dispose = undefined
                denied = new Set()
                unrestrictable.clear()
                if (currentRule === undefined) {
                    info(`[${presetId}] 规则已清空，工具全部恢复可见`)
                    return
                }
                for (const toolName of visibleNames()) {
                    if (ruleMatches(toolName, currentRule)) denied.add(toolName)
                }
                if (denied.size === 0) {
                    info(`[${presetId}] 无匹配项，不遮蔽`)
                    return
                }
                applyRestriction()
            }

            const initial = visibleNames()
            info(
                `[${presetId}] 接管 agent，可见 ${initial.length} 个工具` +
                    (currentRule === undefined ? '（该模式无规则，全放行）' : '')
            )
            if (currentRule !== undefined) state.sync()
        })

        agents.set(agent, state)
    }

    /** 规则变了：版本号 +1 并立刻重装已知 agent；漏网的会在下一次 pre-step 补上。 */
    const reapplyAll = () => {
        rulesVersion += 1
        for (const [agent, state] of agents) {
            try {
                state.version = rulesVersion
                state.reset(ruleFor(state.presetId))
            } catch (error) {
                warn(`重装 ${state.presetId} 失败：${error?.message}`)
            }
        }
    }

    ctx.on('agent/created', ({ agent }) => {
        try {
            install(agent)
        } catch (error) {
            warn(`agent/created 处理失败：${error?.message}`)
        }
    })

    // 主通道：插件可能比会话起得晚（agent/created 早过去了），每轮都补装/补同步。
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        const agent = payload?.agent
        if (agent === undefined || agent === null) return decision
        try {
            install(agent)
            const state = agents.get(agent)
            if (state === undefined) return decision
            // agent 创建之后才 mount preset 的情况（QQ 机器人就是这样），这里补正模式。
            // 传 state.presetId 作为 previous：查不到 composedPreset 时沿用上次，不抖。
            const resolved = resolvePresetId(agent, state.presetId)
            if (resolved.id !== state.presetId) {
                const sessionId = typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : ''
                if (sessionId !== '') lastPresetBySession.set(sessionId, resolved.id)
                // 切 preset 会重建 scope：旧 fiber 里的候选 ctx 全部作废，复用等于把限制打在
                // 一个没人用的 scope 上（表现就是「切换后禁用不生效」，默认就是该模式则正常）。
                // 所以这里不复用，直接销毁重装，让 install 重新取一遍 agent.ctx。
                agents.delete(agent)
                safeDispose(state.fiber)
                install(agent)
                return decision
            }
            if (state.version !== rulesVersion) {
                state.version = rulesVersion
                state.reset(ruleFor(state.presetId))
            } else {
                state.sync()
                // 自愈：切换 preset 重建 layer 后，已加上的 restriction 会整条丢失，
                // 表现为本该被遮蔽的工具又回到 schemas 里。这里重新接管一次（限量，防死循环）。
                try {
                    // 用时间窗节流而不是次数上限：切换导致的丢失可能反复发生，
                    // 次数用光就再也不修了；改成「5 秒内不重复重装」，既能持续自愈也不会狂刷。
                    const lastHeal = healAttempts.get(agent) ?? 0
                    const now = Date.now()
                    if (
                        now - lastHeal > 5000 &&
                        typeof state.needsHeal === 'function' &&
                        state.needsHeal()
                    ) {
                        healAttempts.set(agent, now)
                        agents.delete(agent)
                        safeDispose(state.fiber)
                        install(agent)
                    }
                } catch (error) {
                }
            }
        } catch (error) {
            warn(`pre-step 同步失败：${error?.message}`)
        }
        return decision
    })

    ctx.on('agent/disposed', ({ agent }) => {
        const state = agents.get(agent)
        healAttempts.delete(agent)
        if (state === undefined) return
        agents.delete(agent)
        safeDispose(state.fiber)
    })

    /**
     * 真正的拦截层。
     *
     * 实测结论：restrict() 在真机上只改了「agent 视角的 schemas」，模型对话请求里
     * 仍然是全量 40 个工具（会话日志可以作证）。所以光靠 restrict 藏不住。
     *
     * tools/pre-execute 是全局 waterfall，不看 scope，`exec.agent` 直接给出调用方 ——
     * 用它保证「禁了就用不了」。官方文档也是这么分工的：
     *   Hiding tools from one agent is ctx.tools.restrict() ...
     *   a denial that must hold regardless of order / must await → tools/pre-execute
     */
    ctx.on('tools/pre-execute', async (exec, next) => {
        try {
            const toolName = typeof exec?.name === 'string' ? exec.name : ''
            const agent = exec?.agent
            if (toolName !== '' && agent !== undefined && agent !== null) {
                const sessionId = typeof agent?.session?.header?.id === 'string' ? agent.session.header.id : ''
                const resolved = resolvePresetId(
                    agent,
                    sessionId !== '' ? lastPresetBySession.get(sessionId) : undefined
                )
                const rule = ruleFor(resolved.id)
                if (rule !== undefined && ruleMatches(toolName, rule)) {
                    return {
                        kind: 'deny',
                        reason: `工具「${toolName}」在「${resolved.id}」模式下已被禁用（dsh-tools-manager）`,
                        info: { name: 'TOOL_DISABLED_BY_MANAGER', code: 'TOOL_DISABLED' }
                    }
                }
            }
        } catch (error) {
        }
        return next()
    }, { prepend: true })

    // ── 设置页接口 ──────────────────────────────────────────────
    const listPresets = async () => {
        try {
            const service = ctx.get?.('agentPresets')
            if (typeof service?.remoteExportList === 'function') {
                const listed = await service.remoteExportList()
                const presets = Array.isArray(listed?.presets) ? listed.presets : []
                if (presets.length > 0) {
                    return presets
                        .filter((item) => typeof item?.id === 'string' && item.id !== '')
                        .map((item) => ({
                            id: item.id,
                            name: typeof item.name === 'string' && item.name !== '' ? item.name : item.id,
                            description: typeof item.description === 'string' ? item.description : ''
                        }))
                }
            }
        } catch (error) {
            warn(`读取模式名册失败：${error?.message}`)
        }
        const ids = new Set([...BUILTIN_PRESETS, ...rules.keys()].filter((id) => id !== '*'))
        return [...ids].map((id) => ({ id, name: id, description: '' }))
    }

    const listAllTools = () => {
        for (const state of agents.values()) {
            try {
                state.collect?.()
            } catch {
                /* 单个 agent 采不到不影响其它 */
            }
        }
        if (catalog.size === 0) {
            try {
                const service = ctx.get?.('tools')
                if (typeof service?.schemas === 'function') {
                    const schemas = service.schemas()
                    if (Array.isArray(schemas)) {
                        for (const schema of schemas) {
                            if (typeof schema?.name === 'string' && schema.name !== '') catalog.add(schema.name)
                        }
                    }
                }
            } catch {
                /* 兜底失败就空着，等第一条消息自己采 */
            }
        }
        return [...catalog].sort()
    }

    const ruleToWire = (rule) => ({
        denyNames: rule?.denyNames ?? [],
        denyPrefixes: rule?.denyPrefixes ?? []
    })

    const json = (res, status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
    }

    const handleState = async (res) => {
        const presets = await listPresets()
        const tools = listAllTools()
        saveCatalog(true)
        const wireRules = {}
        for (const [presetId, rule] of rules) wireRules[presetId] = ruleToWire(rule)
        json(res, 200, { ok: true, presets, tools, rules: wireRules, rulesFile })
    }

    const handleSave = async (req, res) => {
        let body
        try {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch (error) {
            json(res, 400, { ok: false, error: `请求体不是 JSON：${error?.message}` })
            return
        }
        const incoming = body?.rules
        if (incoming === null || typeof incoming !== 'object') {
            json(res, 400, { ok: false, error: '缺少 rules' })
            return
        }
        const stored = {}
        for (const [presetId, raw] of Object.entries(incoming)) {
            if (raw === null || typeof raw !== 'object') continue
            const clean = {
                denyNames: stringsOf(raw.denyNames),
                denyPrefixes: stringsOf(raw.denyPrefixes)
            }
            if (clean.denyNames.length === 0 && clean.denyPrefixes.length === 0) continue
            stored[presetId] = clean
        }
        if (!writeDiskRules(stored)) {
            json(res, 500, { ok: false, error: '规则写入失败，看 Host 日志' })
            return
        }
        rules = loadRules()
        reapplyAll()
        info(`规则已更新：${Object.keys(stored).join(', ') || '(全部清空)'}`)
        json(res, 200, { ok: true })
    }

    const disposeApi = (() => {
        try {
            const webServer = ctx.get?.('webServer')
            if (webServer === undefined || typeof webServer.register !== 'function') {
                warn('Host 没有 webServer 服务，设置页接口不注册（过滤逻辑照常工作）')
                return undefined
            }
            const dispose = webServer.register({
                kind: 'prefix',
                path: API_PREFIX,
                handler: async (req, res) => {
                    const url = new URL(req.url ?? '/', 'http://localhost')
                    const route = url.pathname.slice(API_PREFIX.length) || '/'
                    try {
                        if (route === '/state' && (req.method ?? 'GET') === 'GET') return await handleState(res)
                        if (route === '/rules' && req.method === 'POST') return await handleSave(req, res)
                        json(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` })
                    } catch (error) {
                        json(res, 500, { ok: false, error: error?.message ?? String(error) })
                    }
                }
            })
            info(`设置页接口已注册：${API_PREFIX}`)
            return dispose
        } catch (error) {
            warn(`设置页接口注册失败：${error?.message}`)
            return undefined
        }
    })()

    ctx.effect?.(() => () => {
        for (const state of agents.values()) safeDispose(state.fiber)
        agents.clear()
        if (typeof disposeApi === 'function') disposeApi()
    }, 'tools-manager cleanup')
}
