/**
 * @gw/dsh-tools-manager 浏览器端：设置页。
 *
 * 只有一张表：一个工具一行，右边一个「禁用」开关。
 *
 * 这里刻意没有「已启用」这一栏。dsh 里工具能不能用取决于 preset 挂载了哪些
 * 插件、group 有没有 disabled、有没有被别的插件 restrict —— 本插件一概不知，
 * 也管不着。硬把「不在我的黑名单里」说成「已启用」就是在编。
 *
 * 所以每行只有两个事实：
 *   denied    本插件禁了它没有（开关状态）
 *   visible   这个模式现在看不看得见（只读，来自存活 agent 的 schemas）
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

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(`${NS}-styles`) !== null) return
      const style = document.createElement('style')
      style.id = `${NS}-styles`
      style.textContent = `
.tm-page{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary,#15171a);font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.6}
.tm-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-title{font-size:15px;font-weight:600;margin:0}
.tm-spacer{flex:1}
.tm-select{height:30px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.tm-btn{height:28px;padding:0 11px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:background .12s ease}
.tm-btn:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-btn:disabled{opacity:.42;cursor:not-allowed}
.tm-hint{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}
.tm-warn{color:var(--dsw-alias-state-warn-primary,#c98a00);font-size:12px}
.tm-err{color:var(--dsw-alias-label-error,#bb0000);font-size:12px}
.tm-box{display:flex;flex-direction:column;overflow:hidden;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);min-height:300px}
.tm-box-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.tm-search{margin-left:auto;width:150px;height:26px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font:inherit;font-size:12px}
.tm-list{flex:1;overflow:auto;padding:6px;display:flex;flex-direction:column;gap:1px;max-height:440px}
.tm-item{display:grid;grid-template-columns:1fr auto;align-items:start;border-radius:8px}
.tm-item:hover{background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.tm-row{display:flex;align-items:center;gap:10px;padding:6px 4px 6px 10px;color:inherit;text-align:left;cursor:pointer;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;grid-column:1;border-radius:8px}
.tm-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#15171a);outline-offset:-2px}
.tm-more{grid-column:2;align-self:center;margin-right:6px;height:22px;padding:0 8px;border-radius:6px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-tertiary,#6b7280);font:inherit;font-size:11px;cursor:pointer;transition:all .12s ease}
.tm-more:hover{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}
.tm-more[aria-expanded="true"]{border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}
.tm-switch{flex:none;position:relative;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#e0e3e8);transition:background .15s ease}
.tm-switch::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s ease}
.tm-item[data-off="true"] .tm-switch{background:var(--dsw-alias-label-error,#d92d20)}
.tm-item[data-off="true"] .tm-switch::after{transform:translateX(12px)}
.tm-desc{grid-column:1 / -1;padding:2px 12px 9px 48px;font-family:var(--dsw-font-family,inherit);font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary,#4b5563);white-space:pre-wrap;word-break:break-word}
.tm-desc-none{color:var(--dsw-alias-label-dimmed,#a8aeb8)}
.tm-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-tag{flex:none;font-size:11px;padding:0 6px;border-radius:999px;border:.5px solid currentColor;line-height:16px;font-family:var(--dsw-font-family,inherit)}
.tm-tag.off{color:var(--dsw-alias-label-error,#d92d20)}
.tm-tag.dim{color:var(--dsw-alias-label-dimmed,#a8aeb8)}
.tm-empty{padding:32px 12px;text-align:center;color:var(--dsw-alias-label-dimmed,#adb3bc);font-size:12px}
.tm-toast{align-self:flex-start;padding:4px 12px;border-radius:999px;background:var(--dsw-alias-label-primary,#15171a);color:var(--dsw-alias-bg-layer-1,#fff);font-size:12px}
.tm-note{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:1.7}
`
      document.head.appendChild(style)
    }

    function SettingsPage() {
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [toast, setToast] = useState('')
      const [presets, setPresets] = useState([])
      const [presetId, setPresetId] = useState('')
      const [tools, setTools] = useState([])
      const [meta, setMeta] = useState({ sessions: 0, unverified: false, rulesFile: '' })
      const [query, setQuery] = useState('')
      const [opened, setOpened] = useState(() => new Set())

      const load = useCallback(async (wanted) => {
        setLoading(true)
        setError('')
        try {
          const search = wanted ? `?preset=${encodeURIComponent(wanted)}` : ''
          const state = await request(`/state${search}`)
          setPresets(Array.isArray(state?.presets) ? state.presets : [])
          setPresetId(typeof state?.presetId === 'string' ? state.presetId : '')
          setTools(Array.isArray(state?.tools) ? state.tools : [])
          setMeta({
            sessions: typeof state?.sessions === 'number' ? state.sessions : 0,
            unverified: state?.unverified === true,
            rulesFile: typeof state?.rulesFile === 'string' ? state.rulesFile : ''
          })
          // 换了模式就收起所有详情，免得看到别的模式留下的展开项
          setOpened(new Set())
        } catch (failure) {
          setError(failure?.message ?? String(failure))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load('')
      }, [load])

      useEffect(() => {
        if (toast === '') return undefined
        const timer = setTimeout(() => setToast(''), 2600)
        return () => clearTimeout(timer)
      }, [toast])

      const deniedCount = useMemo(() => tools.filter((item) => item.denied).length, [tools])

      const shown = useMemo(() => {
        const keyword = query.trim().toLowerCase()
        const list = keyword === '' ? tools : tools.filter((item) => item.name.toLowerCase().includes(keyword))
        // 固定按名字排，不因为禁用就往前挪 —— 位置稳定才好找
        return [...list].sort((a, b) => a.name.localeCompare(b.name))
      }, [tools, query])

      const toggle = useCallback(
        async (name) => {
          const snapshot = tools
          const next = tools.map((item) => (item.name === name ? { ...item, denied: !item.denied } : item))
          const deny = next.filter((item) => item.denied).map((item) => item.name)
          const turnedOff = next.some((item) => item.name === name && item.denied)

          setTools(next)
          setBusy(true)
          try {
            await request('/rules', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ presetId, deny })
            })
            setToast(`${turnedOff ? '已禁用' : '已放开'} ${name}`)
          } catch (failure) {
            setTools(snapshot)
            setToast(`保存失败：${failure?.message ?? failure}`)
          } finally {
            setBusy(false)
          }
        },
        [tools, presetId]
      )

      const toggleDetail = useCallback((name) => {
        setOpened((previous) => {
          const next = new Set(previous)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }, [])

      const tagOf = (item) => {
        if (item.denied) return h('span', { className: 'tm-tag off' }, '已禁用')
        if (!item.visible) {
          return h(
            'span',
            {
              className: 'tm-tag dim',
              title: '这个工具在选中的模式里现在看不到 —— 可能本来就属于别的模式，或者被别的插件挡了。本插件没动它。'
            },
            '不可见'
          )
        }
        return null
      }

      const body =
        loading && tools.length === 0
          ? h('div', { className: 'tm-empty' }, '读取中…')
          : h(
              'div',
              { className: 'tm-box' },
              h(
                'div',
                { className: 'tm-box-head' },
                h('span', { className: 'tm-count' }, `${tools.length} 个工具，禁用 ${deniedCount} 个`),
                h('input', {
                  className: 'tm-search',
                  value: query,
                  placeholder: '筛选工具名',
                  onChange: (event) => setQuery(event.target.value)
                })
              ),
              shown.length === 0
                ? h('div', { className: 'tm-empty' }, query === '' ? '这个模式没有可管理的工具' : '没有匹配的工具')
                : h(
                    'div',
                    { className: 'tm-list' },
                    shown.map((item) => {
                      const open = opened.has(item.name)
                      return h(
                        'div',
                        { key: item.name, className: 'tm-item', 'data-off': item.denied ? 'true' : 'false' },
                        // 左侧：开关 + 名字 + 状态，点这里切换禁用
                        h(
                          'div',
                          {
                            className: 'tm-row',
                            role: 'switch',
                            tabIndex: 0,
                            'aria-checked': item.denied,
                            title: `${item.denied ? '放开' : '禁用'} ${item.name}`,
                            onClick: () => {
                              if (!busy) void toggle(item.name)
                            },
                            onKeyDown: (event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              if (!busy) void toggle(item.name)
                            }
                          },
                          h('span', { className: 'tm-switch' }),
                          h('span', { className: 'tm-name' }, item.name),
                          tagOf(item)
                        ),
                        // 右侧：展开这个工具的说明
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tm-more',
                            'aria-expanded': open,
                            title: open ? '收起说明' : '展开说明',
                            onClick: () => toggleDetail(item.name)
                          },
                          open ? '收起' : '说明'
                        ),
                        open
                          ? h(
                              'div',
                              { className: 'tm-desc' },
                              item.description === '' || item.description === undefined
                                ? h(
                                    'span',
                                    { className: 'tm-desc-none' },
                                    item.visible
                                      ? '这个工具没有写描述。'
                                      : '取不到描述 —— 它现在不在这个模式的工具表里。'
                                  )
                                : item.description
                            )
                          : null
                      )
                    })
                  )
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
              disabled: presets.length === 0 || busy,
              onChange: (event) => void load(event.target.value)
            },
            presets.map((preset) =>
              h('option', { key: preset.id, value: preset.id }, preset.name === preset.id ? preset.id : `${preset.name}（${preset.id}）`)
            )
          ),
          h('span', { className: 'tm-spacer' }),
          h('span', { className: 'tm-hint' }, busy ? '写入中…' : ''),
          h('button', { type: 'button', className: 'tm-btn', onClick: () => void load(presetId), disabled: loading || busy }, '刷新')
        ),
        meta.sessions > 0
          ? h('span', { className: 'tm-hint' }, `本模式 ${meta.sessions} 个活动会话，下面这张表是实时的`)
          : h('span', { className: 'tm-warn' }, '本模式当前没有活动会话，工具清单取自全局注册表，标「不可见」的仅供参考'),
        error === '' ? null : h('div', { className: 'tm-err' }, error),
        body,
        toast === '' ? null : h('div', { className: 'tm-toast' }, toast),
        h(
          'div',
          { className: 'tm-note' },
          '这里只管禁用。开关打开 = 禁用（模型看不到、也调不动）；关掉 = 本插件不管这个工具，能不能用由 dsh 和别的插件决定。'
        ),
        meta.rulesFile === '' ? null : h('div', { className: 'tm-note' }, `规则文件：${meta.rulesFile}`)
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
