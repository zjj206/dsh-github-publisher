module.exports = {
  inject: ['slots'],
  apply(ctx) {
    const React = require('react')
    const { useState, useEffect } = React
    const ROUTE = '/_dsh/github-publisher'
    let setOpenGlobal = null
    async function call(payload) {
      const response = await fetch(ROUTE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || '请求失败')
      return data
    }
    function Button(props) {
      return React.createElement('button', { className: 'ghp-footer', onClick: () => setOpenGlobal && setOpenGlobal(true), title: '发布到 GitHub' }, props.wide ? '🚀 GitHub 发布' : '🚀')
    }
    function Panel() {
      const [open, setOpen] = useState(false)
      const [account, setAccount] = useState('')
      const [projectPath, setProjectPath] = useState('')
      const [repository, setRepository] = useState('')
      const [visibility, setVisibility] = useState('public')
      const [tag, setTag] = useState('v0.1.0')
      const [title, setTitle] = useState('')
      const [notes, setNotes] = useState('Initial release.')
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState('')
      useEffect(() => { setOpenGlobal = setOpen; return () => { setOpenGlobal = null } }, [])
      useEffect(() => { if (!open) return; call({ action: 'status' }).then(x => { setAccount(x.account); if (!projectPath) setProjectPath(x.defaultProjectPath) }).catch(e => setMessage(e.message)) }, [open])
      if (!open) return null
      const previewNow = async () => { setBusy(true); setMessage(''); try { setPreview(await call({ action: 'preview', projectPath, repository, visibility, tag, title, notes })) } catch (e) { setMessage(e.message) } finally { setBusy(false) } }
      const confirm = async () => { setBusy(true); setMessage(''); try { const result = await call({ action: 'confirm', token: preview.token, confirmation: preview.confirmation }); setMessage('发布成功：' + result.releaseUrl); setPreview(null) } catch (e) { setMessage(e.message) } finally { setBusy(false) } }
      const field = (label, node) => React.createElement('label', { className: 'ghp-field' }, React.createElement('span', null, label), node)
      return React.createElement('div', { className: 'ghp-backdrop', onMouseDown: e => { if (e.target === e.currentTarget) setOpen(false) } },
        React.createElement('div', { className: 'ghp-panel' },
          React.createElement('div', { className: 'ghp-head' }, React.createElement('div', null, React.createElement('b', null, '🚀 发布到 GitHub'), React.createElement('small', null, account ? '账号：' + account : '正在检查登录…')), React.createElement('button', { onClick: () => setOpen(false) }, '×')),
          field('项目目录', React.createElement('input', { value: projectPath, onChange: e => { setProjectPath(e.target.value); setPreview(null) } })),
          field('仓库名（留空自动取文件夹名）', React.createElement('input', { value: repository, onChange: e => { setRepository(e.target.value); setPreview(null) }, placeholder: '自动' })),
          React.createElement('div', { className: 'ghp-row' }, field('可见性', React.createElement('select', { value: visibility, onChange: e => { setVisibility(e.target.value); setPreview(null) } }, React.createElement('option', { value: 'public' }, '公开'), React.createElement('option', { value: 'private' }, '私有'))), field('版本', React.createElement('input', { value: tag, onChange: e => { setTag(e.target.value); setPreview(null) } }))),
          field('Release 标题', React.createElement('input', { value: title, onChange: e => { setTitle(e.target.value); setPreview(null) }, placeholder: tag })),
          field('发布说明', React.createElement('textarea', { value: notes, onChange: e => { setNotes(e.target.value); setPreview(null) } })),
          preview && React.createElement('div', { className: 'ghp-preview' }, React.createElement('b', null, '发布确认单'), React.createElement('div', null, '仓库：' + preview.plan.slug), React.createElement('div', null, '文件：' + preview.plan.fileCount + ' 个'), React.createElement('div', null, '可见性：' + preview.plan.visibility + '　版本：' + preview.plan.tag), React.createElement('code', null, preview.confirmation)),
          message && React.createElement('div', { className: 'ghp-message' }, message),
          React.createElement('div', { className: 'ghp-actions' }, React.createElement('button', { onClick: () => setOpen(false), disabled: busy }, '取消'), preview ? React.createElement('button', { className: 'primary danger', onClick: confirm, disabled: busy }, busy ? '发布中…' : '确认并发布') : React.createElement('button', { className: 'primary', onClick: previewNow, disabled: busy }, busy ? '检查中…' : '预检发布'))
        ))
    }
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'github-publisher', order: -50, label: 'GitHub 发布' }, Button))
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'github-publisher' }, Panel))
  }
}
