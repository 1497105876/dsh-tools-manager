/**
 * dsh-tools-manager —— 按 Agent 预设（模式）禁用工具。
 *
 * ── 只做一件事 ────────────────────────────────────────────────
 * 把某个模式下你不想要的那几个工具禁掉。**不负责启用** —— 没被禁的一概不碰，
 * 谁能让它出现、谁让它消失，全归 dsh 自己和别的插件。所以这里没有白名单，
 * 也没有任何「已启用」的概念。
 *
 * ── 两个 API，各管一头 ─────────────────────────────────────────
 *   tools.restrict({ deny })  让模型看不见（schema 层）
 *   tools.guard(fn)           让它调不动（执行层，monotonic，谁也翻不了案）
 *
 * 两个都必须注册在 **agent 自己的 ctx** 上：
 *   restrict 只过滤「继承来的」工具（global + 祖先层），永远不过滤本层注册的；
 *   guard 按 scope 链匹配，注册在派生出来的子 scope 上就谁也拦不住。
 * 官方 subagent 也是这么写的：childCtx.tools.restrict(composition.toolFilter)。
 *
 * ── 装法：全撤全装，绝不叠加 ───────────────────────────────────
 * dsh 的 restriction 是 intersect 语义（dsh-tools README: "Restrictions
 * intersect"），每调一次 restrict 就往层里 append 一条新的，append 返回的
 * undo 只管这一次。旧版本每次都叠一层新的、只撤最后一个 —— 泄漏的层继续
 * deny，于是界面上「放开了」而工具照样不能用。
 *
 * 所以这里维护 handles 数组：重装前先全部撤干净，再一次性装回去。
 *
 * ── 规则文件 ───────────────────────────────────────────────────
 * <DSH_HOME>/plugin-data/tools-manager/rules.json
 *   { "version": 2, "rules": { "qq": { "deny": ["bash"] }, "*": { "deny": [] } } }
 *
 * 不按 profile 分文件 —— 规则是按 preset 索引的，而 preset 名跨 profile 唯一。
 * 旧版本按 profile 分目录，结果 profile 探测失败时静默退回全局目录，同一个
 * 「设置」被写进两个文件、内容还不一样。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'tools-manager'
// agentPresets 是必需依赖（读「这个 agent 实际挂载的 preset」）。
// webServer 不 inject —— 没有它只是没设置页，禁用逻辑照样跑，不该整个插件起不来。
export const inject = ['agentPresets']

/** 设置页接口前缀 —— 浏览器半的 fetch 必须跟这里一致。 */
const API_PREFIX = '/api/plugins/tools-manager'

/** 规则文件格式版本。v1 是 { denyNames, denyPrefixes }，v2 只有 deny。 */
const RULES_VERSION = 2

/** 名册拿不到时的兜底提示（不是白名单）。 */
const BUILTIN_PRESETS = ['standard', 'ptc', 'minimal', 'cordis']

/** 兜底规则的 key：没单独配置的模式都落到它。 */
const WILDCARD = '*'

const homeDir = () => String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

const pluginDataDir = () => join(homeDir(), 'plugin-data', 'tools-manager')

const rulesPath = () => join(pluginDataDir(), 'rules.json')

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''

//#region 规则读写

/** 把任意来源的一条规则拆成工具名数组（v2 的 deny + v1 的 denyNames）。 */
function namesOf(rule) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return []
    const raw = [
        ...(Array.isArray(rule.deny) ? rule.deny : []),
        ...(Array.isArray(rule.denyNames) ? rule.denyNames : [])
    ]
    return [...new Set(raw.filter(isNonEmptyString).map((item) => item.trim()))]
}

/** 收集一个 v1 文件里的全部规则，灌进 target（Map<presetId, Set<name>>）。 */
function absorbLegacy(target, file) {
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed?.version === RULES_VERSION) return
        const raw = parsed?.rules
        if (raw === null || typeof raw !== 'object') return
        for (const [presetId, rule] of Object.entries(raw)) {
            const names = namesOf(rule)
            if (!isNonEmptyString(presetId) || names.length === 0) continue
            const set = target.get(presetId) ?? new Set()
            for (const item of names) set.add(item)
            target.set(presetId, set)
        }
    } catch {
        /* 读不了或不是 JSON，跳过 */
    }
}

/** v1 的旧文件位置：全局一份 + 每个 profile 一份。 */
function legacyFiles() {
    const files = [join(pluginDataDir(), 'rules.json')]
    try {
        const profilesDir = join(homeDir(), 'profiles')
        for (const entry of readdirSync(profilesDir)) {
            const candidate = join(profilesDir, entry, 'tools-manager', 'rules.json')
            if (existsSync(candidate)) files.push(candidate)
        }
    } catch {
        /* 没有 profiles 目录就算了 */
    }
    return files
}

/**
 * 载入规则。返回 Map<presetId, Set<toolName>>。
 *
 * 已经是 v2 就只读主文件；还是 v1 就把所有旧位置并成一份（取并集 —— 多禁一个
 * 只会挡功能，少禁一个会漏），写回 v2。旧文件原地不动，也不再被读取。
 */
function loadRules() {
    const file = rulesPath()
    const target = new Map()

    let current
    try {
        current = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
        current = undefined
    }

    if (current?.version !== RULES_VERSION) {
        for (const legacy of legacyFiles()) absorbLegacy(target, legacy)
        writeRules(target)
        return target
    }

    const raw = current?.rules
    if (raw === null || typeof raw !== 'object') return target
    for (const [presetId, rule] of Object.entries(raw)) {
        const names = namesOf(rule)
        if (!isNonEmptyString(presetId) || names.length === 0) continue
        target.set(presetId, new Set(names))
    }
    return target
}

/** 全量写盘。返回是否成功。 */
function writeRules(rules) {
    const payload = { version: RULES_VERSION, rules: {} }
    for (const [presetId, names] of rules) {
        const list = [...names].filter(isNonEmptyString).sort()
        if (list.length === 0) continue
        payload.rules[presetId] = { deny: list }
    }
    try {
        mkdirSync(dirname(rulesPath()), { recursive: true })
        writeFileSync(rulesPath(), JSON.stringify(payload, null, 2), 'utf8')
        return true
    } catch {
        return false
    }
}

//#endregion

export function apply(ctx, config) {
    const source = config !== null && typeof config === 'object' ? config : {}

    const log = (level, line) => {
        try {
            ctx.logger?.[level]?.(`[tools-manager] ${line}`)
        } catch {
            /* 日志写不了不能变成启动失败 */
        }
    }

    /** Map<presetId, Set<toolName>> */
    let rules = loadRules()

    /** 规则版本号：每次保存 +1，让滞后安装的 agent 在下一轮 pre-step 重装。 */
    let rulesVersion = 0

    /**
     * agent → { presetId, rule, handles }
     *
     * handles 里是本插件在这个 agent 上装的全部撤销句柄（restrict + guard）。
     * 重装/卸下时逐个调用，绝不遗留 —— 一旦漏一个，那一层 restriction 会
     * 一直 deny 到进程退出。
     */
    const agents = new Map()

    /** agent → 上次自愈的时间戳，防止 restrict 抖动时每轮都重装。 */
    const healedAt = new WeakMap()

    /** sessionId → 上次确认过的 presetId，用于 agent 重建后沿用模式。 */
    const presetBySession = new Map()

    /** 某个模式的禁用集合；没有专属规则时用兜底。 */
    const ruleFor = (presetId) => {
        const own = rules.get(presetId)
        if (own !== undefined) return own
        const fallback = rules.get(WILDCARD)
        if (fallback !== undefined) return fallback
        const fromConfig = namesOf(source.defaultRule)
        return fromConfig.length > 0 ? new Set(fromConfig) : new Set()
    }

    const toolsOf = (agent) => {
        // ① preset 组自己挂的那份（切模式会重建 scope，agent.ctx 上那份可能作废）
        try {
            const presets = ctx.get?.('agentPresets')
            if (typeof presets?.serviceFor === 'function') {
                const scoped = presets.serviceFor(agent, 'tools')
                if (scoped !== null && typeof scoped === 'object' && typeof scoped.restrict === 'function') {
                    return scoped
                }
            }
        } catch {
            /* 换下一个来源 */
        }
        // ② agent 自己的 ctx —— 官方 subagent 走的就是这条
        try {
            const direct = agent?.ctx?.tools
            if (direct !== null && typeof direct === 'object' && typeof direct.restrict === 'function') {
                return direct
            }
        } catch {
            /* 属性访问可能抛错 */
        }
        return undefined
    }

    /**
     * 一个 agent 当前真正看得见的工具：名字 → 描述。
     * restrict 生效后，被禁的那些不在这里。
     * 描述取 schema 上的 description，给设置页展开详情用。
     */
    const visibleNames = (agent, tools) => {
        try {
            const schemas = tools.schemas(agent)
            if (!Array.isArray(schemas)) return undefined
            const names = new Map()
            for (const schema of schemas) {
                if (!isNonEmptyString(schema?.name)) continue
                const text = typeof schema.description === 'string' ? schema.description.trim() : ''
                // 同一个工具可能被多个 agent 看到，描述取第一个非空的
                if (!names.has(schema.name) || (names.get(schema.name) === '' && text !== '')) {
                    names.set(schema.name, text)
                }
            }
            return names
        } catch {
            return undefined
        }
    }

    const resolvePreset = (agent, fallback) => {
        try {
            const presets = ctx.get?.('agentPresets')
            if (typeof presets?.composedPreset === 'function') {
                const id = presets.composedPreset(agent.ctx)
                if (isNonEmptyString(id)) return id
            }
        } catch {
            /* 查不到就往后退 */
        }
        if (isNonEmptyString(fallback)) return fallback
        const header = agent?.session?.header
        if (isNonEmptyString(header?.agentPreset)) return header.agentPreset
        return 'standard'
    }

    /** 卸掉本插件在这个 agent 上装的一切。幂等。 */
    const unmount = (agent) => {
        const state = agents.get(agent)
        if (state === undefined) return
        agents.delete(agent)
        for (const dispose of state.handles) {
            try {
                dispose()
            } catch {
                /* 撤销失败也要继续撤后面的 */
            }
        }
        state.handles.length = 0
    }

    /**
     * 装一次。顺序永远是：先全撤，再全装。
     *
     * restrict 只拿「当前可见 ∩ 规则」—— restrict 会校验名字，规则里那些
     * 这一刻还不存在的工具传进去会直接抛错。guard 则用完整规则：工具可能在
     * 一轮对话中途才注册，那会儿模型已经能看见它了，得靠 guard 兜住。
     */
    const mount = (agent) => {
        if (agent === null || typeof agent !== 'object') return
        const header = agent?.session?.header
        if (header === undefined || header === null) return

        const sessionId = isNonEmptyString(header.id) ? header.id : ''
        const previous = agents.get(agent)
        const presetId = resolvePreset(agent, previous?.presetId ?? (sessionId === '' ? undefined : presetBySession.get(sessionId)))
        if (sessionId !== '') presetBySession.set(sessionId, presetId)

        unmount(agent)

        const rule = ruleFor(presetId)
        const handles = []
        const tools = toolsOf(agent)

        // 拿不到 tools 就不记状态 —— 下一轮 pre-step 会再试一次。
        // 记成"已装"的话这个会话就永远失联了。
        if (tools === undefined) {
            log('warn', `[${presetId}] 拿不到 tools 服务，这个会话暂时不做限制`)
            return
        }

        // 这一读必须在装 restrict 之前 —— 装完被禁的工具就不在 schemas 里了，
        // 设置页的「展开说明」也就拿不到描述。存一份当缓存。
        const visible = visibleNames(agent, tools)
        const deny = visible === undefined ? [] : [...rule].filter((item) => visible.has(item))

        if (deny.length > 0) {
            try {
                const dispose = tools.restrict({ deny })
                if (typeof dispose === 'function') handles.push(dispose)
            } catch (error) {
                log('warn', `[${presetId}] restrict 没装上（${error?.message}），改由 guard 拦截`)
            }
        }

        if (rule.size > 0) {
            try {
                const dispose = tools.guard((exec) => {
                    const called = isNonEmptyString(exec?.name) ? exec.name : ''
                    if (called === '' || !rule.has(called)) return undefined
                    return `工具「${called}」在「${presetId}」模式下已被禁用（dsh-tools-manager）`
                })
                if (typeof dispose === 'function') handles.push(dispose)
            } catch (error) {
                log('warn', `[${presetId}] guard 没装上：${error?.message}`)
            }
        }

        if (deny.length > 0) log('info', `[${presetId}] 已禁 ${deny.length} 个：${deny.join(' ')}`)

        agents.set(agent, {
            presetId,
            rule,
            handles,
            version: rulesVersion,
            // 工具名 → 描述。含此刻被禁的那些，给设置页展开详情用
            known: visible ?? new Map()
        })
    }

    /**
     * 每轮检查一次：没装的补上、模式变了的重装、规则变了的重装、
     * restriction 被重建掉的重新贴回去。
     */
    const ensure = (agent) => {
        const state = agents.get(agent)
        const presetId = resolvePreset(agent, state?.presetId)
        if (state === undefined || state.presetId !== presetId) {
            if (state !== undefined) log('info', `[${state.presetId}] → [${presetId}]，重装`)
            mount(agent)
            return
        }
        if (state.version !== rulesVersion) {
            mount(agent)
            return
        }
        if (state.rule.size === 0) return

        // 自愈：被禁的名字又出现在可见集里，说明切 preset 重建 scope 时
        // restriction 整条丢了。节流 5 秒，避免和 tools/change 打架。
        const now = Date.now()
        if (now - (healedAt.get(agent) ?? 0) < 5000) return
        const tools = toolsOf(agent)
        if (tools === undefined) return
        const visible = visibleNames(agent, tools)
        if (visible === undefined || visible.size === 0) return
        for (const denied of state.rule) {
            if (!visible.has(denied)) continue
            healedAt.set(agent, now)
            log('info', `[${presetId}] 「${denied}」又露出来了，重新贴限制`)
            mount(agent)
            return
        }
    }

    /** 规则变了：所有 agent 重装。 */
    const remountAll = () => {
        rulesVersion += 1
        for (const agent of [...agents.keys()]) {
            try {
                mount(agent)
            } catch (error) {
                log('warn', `重装失败：${error?.message}`)
            }
        }
    }

    ctx.on('agent/created', ({ agent }) => {
        try {
            mount(agent)
        } catch (error) {
            log('warn', `agent/created 处理失败：${error?.message}`)
        }
    })

    // 插件可能比会话起得晚（agent/created 早过去了），每轮补一次。
    ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        const agent = payload?.agent
        if (agent === undefined || agent === null) return decision
        try {
            ensure(agent)
        } catch (error) {
            log('warn', `pre-step 检查失败：${error?.message}`)
        }
        return decision
    })

    ctx.on('agent/disposed', ({ agent }) => {
        unmount(agent)
    })

    //#region 设置页接口

    const json = (res, status, payload) => {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(JSON.stringify(payload))
    }

    const listPresets = async () => {
        const out = []
        try {
            const service = ctx.get?.('agentPresets')
            if (typeof service?.remoteExportList === 'function') {
                const listed = await service.remoteExportList()
                for (const item of Array.isArray(listed?.presets) ? listed.presets : []) {
                    if (!isNonEmptyString(item?.id)) continue
                    out.push({
                        id: item.id,
                        name: isNonEmptyString(item.name) ? item.name : item.id,
                        description: typeof item.description === 'string' ? item.description : ''
                    })
                }
            }
        } catch (error) {
            log('warn', `读取模式名册失败：${error?.message}`)
        }
        if (out.length === 0) {
            for (const id of new Set([...BUILTIN_PRESETS, ...rules.keys()])) {
                if (id === WILDCARD) continue
                out.push({ id, name: id, description: '' })
            }
        }
        if (!out.some((item) => item.id === WILDCARD)) {
            out.push({ id: WILDCARD, name: '兜底（所有模式）', description: '没有单独配置的模式都落到这条' })
        }
        return out
    }

    /**
     * 该 preset 下所有存活 agent 的工具：名字 → 描述。
     *
     * visible 是「此刻真看得见的」（restrict 之后），known 是「见过的」——
     * 被禁的工具不在 visible 里，但它的描述在 mount 那一刻就缓存进 known 了，
     * 所以设置页展开已禁用的工具照样能看到它是什么。
     */
    const liveTools = (presetId) => {
        const visible = new Map()
        const known = new Map()
        let sessions = 0
        for (const [agent, state] of agents) {
            if (state.presetId !== presetId) continue
            sessions += 1
            const tools = toolsOf(agent)
            if (tools !== undefined) {
                const now = visibleNames(agent, tools)
                if (now !== undefined) {
                    for (const [name, text] of now) {
                        visible.set(name, text)
                        if (!known.has(name) || (known.get(name) === '' && text !== '')) known.set(name, text)
                    }
                }
            }
            for (const [name, text] of state.known ?? []) {
                if (!known.has(name) || (known.get(name) === '' && text !== '')) known.set(name, text)
            }
        }
        return { visible, known, sessions }
    }

    /**
     * 一个模式没有存活会话时，只能退到「全局注册了什么」——
     * 那是「注册过」不是「这个模式有」，所以单独标出来，让界面说清楚。
     */
    const globalTools = () => {
        const visible = new Map()
        try {
            const service = ctx.get?.('tools')
            if (typeof service?.schemas === 'function') {
                const schemas = service.schemas()
                if (Array.isArray(schemas)) {
                    for (const schema of schemas) {
                        if (!isNonEmptyString(schema?.name)) continue
                        const text = typeof schema.description === 'string' ? schema.description.trim() : ''
                        if (!visible.has(schema.name) || (visible.get(schema.name) === '' && text !== '')) {
                            visible.set(schema.name, text)
                        }
                    }
                }
            }
        } catch {
            /* 拿不到就空着 */
        }
        return visible
    }

    const handleState = async (res, wanted) => {
        const presets = await listPresets()
        const presetId = presets.some((item) => item.id === wanted) ? wanted : presets[0]?.id ?? ''

        const { visible, known, sessions } = liveTools(presetId)
        let unverified = false
        if (sessions === 0) {
            unverified = true
            for (const [name, text] of globalTools()) {
                if (!visible.has(name)) visible.set(name, text)
                if (!known.has(name)) known.set(name, text)
            }
        }

        const rule = rules.get(presetId) ?? new Set()
        // 清单 = 见过的（含已被禁的）∪ 规则里点名要禁的。
        // 不再有「以前见过但现在没了」那种历史目录 —— 那才是脏数据的来源。
        const names = new Set([...known.keys(), ...rule])

        // 描述优先用当前 schema 上的，被禁的退到 mount 时的缓存
        const descOf = (name) => {
            const now = visible.get(name)
            if (typeof now === 'string' && now !== '') return now
            const cached = known.get(name)
            if (typeof cached === 'string' && cached !== '') return cached
            return ''
        }

        const tools = [...names].sort().map((item) => ({
            name: item,
            visible: visible.has(item),
            denied: rule.has(item),
            description: descOf(item)
        }))

        json(res, 200, {
            ok: true,
            presets,
            presetId,
            sessions,
            unverified,
            tools,
            rulesFile: rulesPath()
        })
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
        const presetId = body?.presetId
        if (!isNonEmptyString(presetId)) {
            json(res, 400, { ok: false, error: '缺少 presetId' })
            return
        }
        if (!Array.isArray(body?.deny)) {
            json(res, 400, { ok: false, error: '缺少 deny 数组' })
            return
        }

        // 单模式粒度写入：只碰这一个 preset，不拿整份 draft 覆盖别人。
        const next = new Set(body.deny.filter(isNonEmptyString).map((item) => item.trim()))
        if (next.size === 0) rules.delete(presetId)
        else rules.set(presetId, next)

        if (!writeRules(rules)) {
            json(res, 500, { ok: false, error: `写不进 ${rulesPath()}，看 Host 日志` })
            return
        }
        remountAll()
        log('info', `[${presetId}] 规则已保存：${next.size === 0 ? '(空)' : [...next].join(' ')}`)
        json(res, 200, { ok: true })
    }

    let disposeApi
    try {
        const webServer = ctx.get?.('webServer')
        if (webServer === undefined || typeof webServer.register !== 'function') {
            log('warn', 'Host 没有 webServer 服务，设置页接口不注册（禁用逻辑照常工作）')
        } else {
            disposeApi = webServer.register({
                kind: 'prefix',
                path: API_PREFIX,
                handler: async (req, res) => {
                    const url = new URL(req.url ?? '/', 'http://localhost')
                    const route = url.pathname.slice(API_PREFIX.length) || '/'
                    try {
                        if (route === '/state' && (req.method ?? 'GET') === 'GET') {
                            return await handleState(res, url.searchParams.get('preset') ?? '')
                        }
                        if (route === '/rules' && req.method === 'POST') return await handleSave(req, res)
                        json(res, 404, { ok: false, error: `未知接口 ${req.method} ${route}` })
                    } catch (error) {
                        json(res, 500, { ok: false, error: error?.message ?? String(error) })
                    }
                }
            })
            log('info', `设置页接口已注册：${API_PREFIX}`)
        }
    } catch (error) {
        log('warn', `设置页接口注册失败：${error?.message}`)
    }

    //#endregion

    ctx.effect?.(() => () => {
        for (const agent of [...agents.keys()]) unmount(agent)
        if (typeof disposeApi === 'function') {
            try {
                disposeApi()
            } catch {
                /* 关不掉也无所谓 */
            }
        }
    }, 'tools-manager cleanup')
}
