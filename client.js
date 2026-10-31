/**
 * @gw/dsh-tools-manager 浏览器端：设置页。
 *
 * 布局（就是你要的样子）：左栏「已启用」、右栏「已禁用」，点条目即可在两栏之间来回搬。
 *   · 顶部：模式选择（下拉）+ 刷新 + 保存；保存前有改动才亮。
 *   · 每栏：标题 + 计数 + 搜索框；整行可点，悬停高亮。
 *   · 由 denyPrefixes（前缀规则）命中的工具也显示在右栏，带「前缀」徽章 —— 那种不能在
 *     这儿放开，得改 cordis.patch.yml 里的前缀（否则会给你一个"点了没反应"的假象）。
 *
 * 为什么全用原生控件：宿主原语（Button / Switch…）在不同版本里名字和 props 都可能变，
 * 拿不到就白屏。这里只用 React + 令牌样式，稳。
 *
 * 数据通道：同源 fetch 到 Host 的 /api/plugins/tools-manager（index.js 里注册）。
 */

window.__ModuleLoader__.load({
  id: '@gw/dsh-tools-manager',
  factory: (require) => {
    const inject = ['slots']
    const API = '/api/plugins/tools-manager'
    const NS = 'tools-manager'

    let React = null
    try {
      React = require('react') || null
    } catch (error) {
      React = null
    }

    // 拿不到 React 就静默退出，绝不把前端 bundle 搞挂
    if (React === null || typeof React.createElement !== 'function') {
      return { inject: [], apply() {} }
    }

    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    // ── 请求 ────────────────────────────────────────────────────
    async function request(path, init) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...init
      })
      const text = await response.text()
      let data = null
      try {
        data = text === '' ? null : JSON.parse(text)
      } catch {
        data = null
      }
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      if (data !== null && data.ok === false) throw new Error(data.error ?? '请求失败')
      return data
    }

    // ── 样式（一次性注入，全吃官方令牌，令牌缺失时退回硬编码浅色） ──
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(`${NS}-styles`) !== null) return
      const style = document.createElement('style')
      style.id = `${NS}-styles`
      style.textContent = `
.tm-page{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,#15171a);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.6}
.tm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.tm-title{font-size:15px;font-weight:600;margin:0}
.tm-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}
.tm-spacer{flex:1}
.tm-select{height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit}
.tm-btn{height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;cursor:pointer;transition:background .12s ease}
.tm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-btn.primary{background:var(--dsw-alias-brand-primary,#15171a);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.tm-btn.danger:hover:not(:disabled){color:var(--dsw-alias-label-error,#bb0000);border-color:currentColor}
.tm-btn:disabled{opacity:.42;cursor:not-allowed}
.tm-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}
@media (max-width:760px){.tm-cols{grid-template-columns:1fr}}
.tm-col{display:flex;flex-direction:column;min-height:340px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}
.tm-col-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-col-title{font-weight:600}
.tm-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.tm-search{margin-left:auto;width:110px;height:26px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.tm-list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:2px}
.tm-item{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;cursor:pointer;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;border:none;background:transparent;color:inherit;text-align:left;width:100%}
.tm-item:hover{background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-item.on:hover{background:var(--dsw-alias-bg-layer-3,#eef0f3)}
.tm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-tag{flex:none;font-size:11px;padding:0 6px;border-radius:999px;border:.5px solid currentColor;line-height:16px}
.tm-tag.prefix{color:var(--dsw-alias-state-warn-primary,#c98a00)}
.tm-empty{padding:28px 12px;text-align:center;color:var(--dsw-alias-label-dimmed,#adb3bc);font-size:12px}
.tm-toast{align-self:flex-start;padding:5px 12px;border-radius:999px;background:var(--dsw-alias-label-primary,#15171a);color:var(--dsw-alias-bg-layer-1,#fff);font-size:12px}
.tm-err{color:var(--dsw-alias-label-error,#bb0000);font-size:12px}
.tm-note{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;word-break:break-all}
`
      document.head.appendChild(style)
    }

    const EMPTY_RULE = { denyNames: [], denyPrefixes: [] }

    function normalizeRule(raw) {
      return {
        denyNames: Array.isArray(raw?.denyNames) ? [...raw.denyNames] : [],
        denyPrefixes: Array.isArray(raw?.denyPrefixes) ? [...raw.denyPrefixes] : []
      }
    }

    // ── 设置页 ──────────────────────────────────────────────────
    function SettingsPage() {
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [data, setData] = useState(null)
      const [presetId, setPresetId] = useState('')
      const [draft, setDraft] = useState({})
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [toast, setToast] = useState('')
      const [queryOn, setQueryOn] = useState('')
      const [queryOff, setQueryOff] = useState('')

      const load = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const state = await request('/state')
          setData(state)
          const next = {}
          for (const [id, raw] of Object.entries(state?.rules ?? {})) next[id] = normalizeRule(raw)
          setDraft(next)
          setPresetId((previous) => {
            if (typeof previous === 'string' && previous !== '' && (state?.presets ?? []).some((p) => p.id === previous)) {
              return previous
            }
            return state?.presets?.[0]?.id ?? ''
          })
          setDirty(false)
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (toast === '') return undefined
        const timer = setTimeout(() => setToast(''), 3200)
        return () => clearTimeout(timer)
      }, [toast])

      const current = draft[presetId] ?? EMPTY_RULE
      const tools = data?.tools ?? []
      const presets = data?.presets ?? []

      const prefixHit = useCallback(
        (name) => (current.denyPrefixes ?? []).some((prefix) => name.startsWith(prefix)),
        [current.denyPrefixes]
      )

      const isDenied = useCallback(
        (name) => (current.denyNames ?? []).includes(name) || prefixHit(name),
        [current.denyNames, prefixHit]
      )

      const onList = useMemo(() => tools.filter((name) => !isDenied(name)), [tools, isDenied])
      const offList = useMemo(() => tools.filter((name) => isDenied(name)), [tools, isDenied])

      const filterByName = (list, query) => {
        const keyword = query.trim().toLowerCase()
        if (keyword === '') return list
        return list.filter((name) => name.toLowerCase().includes(keyword))
      }

      const onShown = filterByName(onList, queryOn)
      const offShown = filterByName(offList, queryOff)

      const mutate = (updater) => {
        setDraft((previous) => {
          const rule = previous[presetId] ?? EMPTY_RULE
          return { ...previous, [presetId]: updater(normalizeRule(rule)) }
        })
        setDirty(true)
      }

      const disable = (name) => {
        if (prefixHit(name)) {
          setToast(`「${name}」由前缀规则控制，要放开请改 cordis.patch.yml 里的 denyPrefixes`)
          return
        }
        mutate((rule) => ({
          ...rule,
          denyNames: rule.denyNames.includes(name) ? rule.denyNames : [...rule.denyNames, name]
        }))
      }

      const enable = (name) => {
        if (prefixHit(name)) {
          setToast(`「${name}」命中前缀规则，删掉对应前缀才能真正启用`)
          return
        }
        mutate((rule) => ({ ...rule, denyNames: rule.denyNames.filter((item) => item !== name) }))
      }

      const disableAll = () => {
        mutate((rule) => {
          const next = new Set(rule.denyNames)
          for (const name of onList) {
            if (!prefixHit(name)) next.add(name)
          }
          return { ...rule, denyNames: [...next] }
        })
      }

      const enableAll = () => {
        mutate((rule) => ({ ...rule, denyNames: [] }))
      }

      // 自动保存：点一下就写盘，不需要按按钮
      const save = useCallback(async () => {
        setBusy(true)
        try {
          const payload = {}
          for (const [id, rule] of Object.entries(draft)) {
            const clean = normalizeRule(rule)
            if (clean.denyNames.length === 0 && clean.denyPrefixes.length === 0) continue
            payload[id] = clean
          }
          await request('/rules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rules: payload })
          })
          setDirty(false)
        } catch (failure) {
          setToast(`保存失败：${failure?.message ?? failure}`)
        } finally {
          setBusy(false)
        }
      }, [draft])

      // 改动后 700ms 无操作就落盘（连点几下只写一次）
      useEffect(() => {
        if (!dirty) return undefined
        const timer = setTimeout(() => {
          void save()
        }, 700)
        return () => clearTimeout(timer)
      }, [dirty, draft, save])

      const renderColumn = (options) => {
        const { title, list, shown, total, query, setQuery, onPick, itemClass, tagOf, emptyText, action } = options
        return h(
          'div',
          { className: 'tm-col' },
          h(
            'div',
            { className: 'tm-col-head' },
            h('span', { className: 'tm-col-title' }, title),
            h('span', { className: 'tm-count' }, `${list.length} / ${total}`),
            h('input', {
              className: 'tm-search',
              value: query,
              placeholder: '筛选',
              onChange: (event) => setQuery(event.target.value)
            })
          ),
          action === undefined ? null : h('div', { style: { padding: '6px 12px 0' } }, action),
          shown.length === 0
            ? h('div', { className: 'tm-empty' }, emptyText)
            : h(
                'div',
                { className: 'tm-list' },
                shown.map((name) =>
                  h(
                    'button',
                    {
                      key: name,
                      type: 'button',
                      className: `tm-item${itemClass === true ? ' on' : ''}`,
                      onClick: () => onPick(name),
                      title: name
                    },
                    h('span', { className: 'tm-name' }, name),
                    tagOf(name)
                  )
                )
              )
        )
      }

      const tagForOff = (name) => {
        if (!prefixHit(name)) return null
        return h('span', { className: 'tm-tag prefix' }, '前缀')
      }

      const body =
        data === null
          ? null
          : h(
              'div',
              { className: 'tm-cols' },
              renderColumn({
                title: '已启用',
                list: onList,
                shown: onShown,
                total: tools.length,
                query: queryOn,
                setQuery: setQueryOn,
                onPick: disable,
                itemClass: false,
                tagOf: () => null,
                emptyText: queryOn === '' ? '全部工具都禁用了' : '没有匹配的工具',
                action:
                  onList.length === 0
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'tm-btn danger', onClick: disableAll },
                        '全部禁用 →'
                      )
              }),
              renderColumn({
                title: '已禁用',
                list: offList,
                shown: offShown,
                total: tools.length,
                query: queryOff,
                setQuery: setQueryOff,
                onPick: enable,
                itemClass: true,
                tagOf: tagForOff,
                emptyText: queryOff === '' ? '这个模式没有禁用任何工具' : '没有匹配的工具',
                action:
                  offList.length === 0
                    ? null
                    : h(
                        'button',
                        { type: 'button', className: 'tm-btn', onClick: enableAll },
                        '← 全部启用'
                      )
              })
            )

      return h(
        'div',
        { className: 'tm-page' },
        h(
          'div',
          { className: 'tm-head' },
          h('h2', { className: 'tm-title' }, '工具管理'),
          h(
            'select',
            {
              className: 'tm-select',
              value: presetId,
              onChange: (event) => setPresetId(event.target.value),
              disabled: presets.length === 0
            },
            presets.map((preset) =>
              h('option', { key: preset.id, value: preset.id }, preset.name === preset.id ? preset.id : `${preset.name}（${preset.id}）`)
            )
          ),
          h('span', { className: 'tm-hint' }, '左边是模型能用的，点一下挪到右边就禁掉，改完自动保存'),
          h('span', { className: 'tm-spacer' }),
          h('span', { className: 'tm-hint' }, busy ? '保存中…' : dirty ? '待保存…' : '已保存'),
          h('button', { type: 'button', className: 'tm-btn', onClick: load, disabled: loading || busy }, '刷新')
        ),
        error === '' ? null : h('div', { className: 'tm-err' }, error),
        loading ? h('div', { className: 'tm-empty' }, '读取中…') : body,
        toast === '' ? null : h('div', { className: 'tm-toast' }, toast),
        h(
          'div',
          { className: 'tm-note' },
          '本插件只判断「要不要禁用」，不设白名单、不管启用 —— 没被禁用的工具一概不碰，交给其它插件。改动落在插件自己的 rules.json，不动 profile 配置。'
        )
      )
    }

    return {
      inject,
      apply(ctx) {
        ctx.effect(() => {
          ensureStyles()
          const stop = ctx.slots?.inject?.('settings.section', () =>
            ctx.slots?.register?.(
              {
                name: 'settings.section',
                id: 'tools-manager',
                order: 55,
                label: () => '工具管理'
              },
              () => h(SettingsPage)
            )
          )
          return () => {
            if (typeof stop === 'function') stop()
          }
        }, `${NS}: settings section`)
      }
    }
  }
})
