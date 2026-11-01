/**
 * DSH Client 插件：AI 长期记忆 · 设置页一级入口。
 *
 * 挂载点：设置页左侧导航的独立一项（slot `settings.section`，kind=list）。
 * 该槽位只接受 `id` / `order` / `label` 三个注册选项（官方 slot 契约），
 * 没有图标字段；所以导航行用 emoji 充当图标，矢量图标画在页面标题区。
 *
 * 接口：
 *   GET  /stats        统计 + 设置
 *   POST /settings     开关 / 写入模式 / 人设 / 敏感度
 *   POST /memorize     让它记住一件事
 *   POST /clear        清空（必须带 { confirm: 'YES' }）
 *
 * 容错原则：任何一步失败都只在页面上显示行内错误或 Toast，
 * 绝不让异常冒泡成白屏。
 */
window.__ModuleLoader__.load({
  id: 'ai-persistent-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const STATS_URL = '/api/ai-persistent-memory/stats';
    const SETTINGS_URL = '/api/ai-persistent-memory/settings';
    const MEMORIZE_URL = '/api/ai-persistent-memory/memorize';
    const CLEAR_URL = '/api/ai-persistent-memory/clear';
    const NUKE_URL = '/api/ai-persistent-memory/nuke';
    const SECTION_ID = 'ai-persistent-memory';

    const FALLBACK_SETTINGS = {
      autoInject: true,
      autoExtract: true,
      hardBudget: false,
      slidingWindow: false,
      writeMode: 'auto',
      persona: '',
      sensitivity: 50,
      compat: false,
    };

    const TOGGLES = [
      {
        key: 'autoInject',
        label: '聊天时自动带上记忆',
        hint: '关闭后就是一次普通聊天：不读取、不参考以往的事。适合隐私场景，也更省用量。',
      },
      {
        key: 'autoExtract',
        label: '自动记住新的内容',
        hint: '关闭后只查不记：聊天不会写入新记忆，已有记忆仍然可以查到。',
      },
      {
        key: 'hardBudget',
        label: '限制记忆占用长度',
        hint: '开启后每次最多带上约 800 字的记忆，避免对话被拉得过长。',
      },
      {
        key: 'slidingWindow',
        label: '减少历史消息（防卡顿）',
        hint: '只保留最近约 5 轮对话，更早的内容交给记忆补回，防止会话过长。',
      },
      {
        key: 'compat',
        label: '启用记忆保护（Beta 版可能存在 Bug，请谨慎使用）',
        hint: '遇到模型记不住你的偏好时再打开；Beta 阶段请谨慎使用。',
      },
    ];

    const WRITE_MODES = [
      { value: 'auto', label: '自动（推荐）：边聊边记' },
      { value: 'manual', label: '只查不记：不写入新内容' },
      { value: 'off', label: '完全关闭写入' },
    ];

    const UI = {
      nav: '🧠 长期记忆',
      title: '长期记忆',
      subtitle: '本地存储 · 越用越懂你 · 数据不出本机',
      loading: '读取中…',
      refresh: '刷新',
      clear: '一键清空',
      clearing: '清空中…',
      offline: '记忆库未连接',
      offlineHint: '后端接口没有响应。检查插件是否已挂载，或路径权限是否正常。',
      totalLabel: '记忆总条数',
      empty: '还没有记忆。聊几句，值得记住的事会自己沉淀下来。',
      none: '—',
      togglesTitle: '使用开关',
      togglesHint: '立即生效，保存在本机，重启后仍然有效。',
      modeTitle: '记忆写入方式',
      modeHint: '选择「只查不记」或「完全关闭」后，不再后台记录新内容。',
      sensitivityTitle: '记忆敏感度',
      sensitivityHint: '调高会更容易把相关但不那么重要的事也带进对话。',
      addTitle: '让它记住一件事',
      addHint: '写下一件必须记住的事，之后聊天会自然用到。',
      addPlaceholder: '例如：我对花生过敏，点餐时记得提醒我.',
      addButton: '添加',
      adding: '添加中…',
      personaTitle: 'AI 人设',
      personaHint: '选填。留空则使用默认的「智能助手」。',
      personaPlaceholder: '例如：你是一位资深架构师 / 你是一位温柔的倾听者...',
      personaSave: '保存人设',
      personaSaving: '保存中…',
      storageTitle: '存储位置',
      storageHint:
        '记忆存在哪个盘由你决定。系统盘（C 盘）不允许，因为重装系统会丢。改完需重启 DSH 生效；换位置后新位置是空的，旧数据仍在原路径。',
      storageCurrent: '当前使用',
      storageSave: '保存位置',
      storageSaving: '保存中…',
      storageSaved: '已保存，重启 DSH 后生效',
      storagePlaceholder: '例如：E:\\AI_Memory',
      savedToast: '已保存',
      addedToast: '已记住',
      failedToast: '操作失败',
      modalTitle: '确认清空全部记忆',
      modalBody:
        '会先自动备份一份，然后清空所有记忆与文字档案；只保留最近 3 份备份，其余自动清理。',
      modalPrompt: '请输入 YES 确认（不区分大小写）：',
      modalCancel: '取消操作',
      modalConfirm: '清空',
      modalPlaceholder: 'YES',
      wrongCode: '取消操作',
      nuke: '💀 彻底重置插件（含所有备份）',
      nuking: '重置中…',
      nukeTitle: '⚠️ 彻底重置插件',
      nukeBody: '⚠️ 极其危险：这会永久删除所有记忆与历史备份，且无法恢复！',
      nukePrompt: '倒计时结束后，输入大写 YES 以确认：',
      nukeWait: '请等待 5 秒',
      nukeConfirm: '确认彻底删除',
      nukeCountdown: function (seconds) { return '请等待 ' + seconds + ' 秒 (' + seconds + 's...)'; },
      nukeDone: '已彻底重置',
      nukeCancel: '取消操作',
      // ── B：官方插件管理器入口 ──
      manageTitle: '插件管理',
      manageOpen: '打开官方插件管理器 →',
      manageFallback: '当前界面没有插件管理入口，请到 设置 → 插件 中操作。',
      manageCopied: '命令已复制',
      // ── A：底部折叠「危险区域」（数据侧） ──
      dangerToggle: '危险操作（卸载本插件）',
      dangerHint: '卸载由 DSH 官方插件管理器执行；这里只负责命令与数据清理。',
      uninstallKeep: '卸载并保留记忆数据',
      uninstallWipe: '卸载并删除全部数据',
      uninstallTitle: '卸载本插件',
      uninstallBodyKeep: '复制下面的命令，在终端执行或在官方插件管理器中卸载；执行后需要重启 DSH 才会真正生效。',
      uninstallBodyWipe:
        '先清空记忆与全部备份，再复制下面的命令完成卸载。两步都需要你确认，代码不会被这里直接删除。',
      uninstallCmdHint: '在终端执行（或在官方插件管理器中卸载）：',
      uninstallNote: '提示：卸载命令只是把包从 profile 移除；重启 DSH 后侧边栏入口才会消失。',
      copyCmd: '复制命令',
      wipeNow: '立即清空并删除所有备份',
      close: '关闭',
    };

    async function requestJson(url, init) {
      const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, init));
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const message = data && data.error ? String(data.error) : 'HTTP ' + response.status;
        throw new Error(message);
      }
      if (!data || data.ok !== true) throw new Error('接口返回异常');
      return data;
    }

    function formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value <= 0) return '0 B';
      if (value < 1024) return value + ' B';
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
      return (value / 1024 / 1024).toFixed(2) + ' MB';
    }

    function errorMessage(error) {
      return error && error.message ? error.message : '未知错误';
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '720px' },
      header: { display: 'flex', alignItems: 'center', gap: '12px' },
      headerIcon: {
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: '40px', height: '40px', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-3)',
        border: '1px solid var(--dsw-alias-border-l2)', flex: '0 0 auto',
      },
      headerText: { display: 'flex', flexDirection: 'column', gap: '2px' },
      title: { fontSize: '16px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { fontSize: '12px', lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-2)', padding: '16px 18px',
      },
      totalRow: { display: 'flex', alignItems: 'baseline', gap: '10px' },
      totalValue: {
        fontSize: '32px', lineHeight: 1.1, fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
      },
      totalLabel: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' },
      meta: {
        marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: '12px', lineHeight: 1.8,
        color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all',
      },
      sectionTitle: {
        fontSize: '13px', fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)', marginBottom: '2px',
      },
      sectionHint: {
        fontSize: '12px', lineHeight: 1.6,
        color: 'var(--dsw-alias-label-tertiary)', marginBottom: '10px',
      },
      toggleRow: {
        display: 'flex', alignItems: 'flex-start', gap: '12px',
        padding: '10px 0', borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      toggleBody: { display: 'flex', flexDirection: 'column', gap: '3px', flex: '1 1 auto' },
      toggleLabel: { fontSize: '13px', color: 'var(--dsw-alias-label-primary)' },
      toggleHint: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' },
      switchBase: {
        appearance: 'none', border: 'none', borderRadius: '999px',
        width: '38px', height: '22px', padding: '0', position: 'relative',
        cursor: 'pointer', flex: '0 0 auto', marginTop: '2px',
        transition: 'background 0.2s ease',
      },
      switchOn: { background: 'var(--dsw-alias-brand-primary)' },
      switchOff: { background: 'var(--dsw-alias-bg-skeleton)' },
      knob: {
        position: 'absolute', top: '3px', width: '16px', height: '16px',
        borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground)',
        transition: 'left 0.2s ease',
      },
      actions: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
      button: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px', padding: '7px 16px', fontSize: '13px', cursor: 'pointer',
      },
      buttonBusy: { opacity: 0.6, cursor: 'default' },
      offline: {
        border: '1px solid var(--dsw-alias-state-warn-tertiary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-warn-label)',
        borderRadius: '10px', padding: '14px 16px', fontSize: '13px', lineHeight: 1.7,
      },
      errorLine: {
        fontSize: '12px', lineHeight: 1.7, marginTop: '8px',
        color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-all',
      },
      textarea: {
        width: '100%', boxSizing: 'border-box', minHeight: '78px', maxHeight: '190px',
        resize: 'vertical', overflowY: 'auto',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        padding: '9px 11px', fontSize: '13px', lineHeight: 1.65, outline: 'none',
        fontFamily: 'inherit',
      },
      select: {
        width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        padding: '8px 11px', fontSize: '13px', cursor: 'pointer', outline: 'none',
        fontFamily: 'inherit',
      },
      input: {
        width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        padding: '9px 11px', fontSize: '13px', outline: 'none', fontFamily: 'inherit',
      },
      rowBetween: { display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px' },
      sliderRow: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: '12px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)',
      },
      sliderValue: {
        fontSize: '12px', fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
      },
      overlay: {
        position: 'fixed', inset: '0', zIndex: 2147483000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)', padding: '24px',
      },
      dialog: {
        width: '100%', maxWidth: '420px', borderRadius: '12px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
        padding: '20px', display: 'flex', flexDirection: 'column', gap: '12px',
      },
      dialogTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      dialogBody: { fontSize: '13px', lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' },
      modalInput: {
        width: '100%', boxSizing: 'border-box',
        border: '1px solid var(--dsw-alias-border-l3)', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        padding: '8px 10px', fontSize: '14px', letterSpacing: '0.12em', outline: 'none',
      },
      dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' },
      dialogCancel: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l3)',
        background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)',
        borderRadius: '8px', padding: '7px 16px', fontSize: '13px', cursor: 'pointer',
      },
      dangerSolid: {
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-label-primary-foreground)',
        borderRadius: '8px', padding: '7px 16px', fontSize: '13px',
        fontWeight: 600, cursor: 'pointer',
      },
      dangerSoft: { opacity: 0.55, cursor: 'default' },
      manageRow: {
        display: 'flex', alignItems: 'baseline', gap: '8px',
        fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)',
      },
      dangerZone: {
        display: 'flex', flexDirection: 'column', gap: '8px',
        paddingTop: '12px', borderTop: '1px dashed var(--dsw-alias-border-l2)',
      },
      dangerBody: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        padding: '12px 14px', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      cmdBlock: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '12px', lineHeight: 1.7,
        padding: '10px 12px', borderRadius: '8px',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        wordBreak: 'break-all', userSelect: 'all',
      },
      toastWrap: {
        position: 'fixed', right: '24px', bottom: '24px', zIndex: 2147483000,
        display: 'flex', flexDirection: 'column', gap: '8px', pointerEvents: 'none',
      },
      toast: {
        padding: '10px 14px', borderRadius: '8px', fontSize: '13px', lineHeight: 1.5,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
        maxWidth: '320px', wordBreak: 'break-word',
      },
      toastOk: { borderColor: 'var(--dsw-alias-state-success-primary)' },
      toastErr: { borderColor: 'var(--dsw-alias-state-error-primary)' },
    };

    /** 细滚动条 + 按钮光影（:hover 只能用 CSS）。 */
    const SCROLL_CSS = [
      '.apm-panel *::-webkit-scrollbar { width: 8px; height: 8px; }',
      '.apm-panel *::-webkit-scrollbar-track { background: transparent; }',
      '.apm-panel *::-webkit-scrollbar-thumb {',
      '  background: var(--dsw-alias-scrollbar-bg-l2); border-radius: 8px;',
      '}',
      '.apm-panel *::-webkit-scrollbar-thumb:hover {',
      '  background: var(--dsw-alias-scrollbar-hover-l2);',
      '}',
      '.apm-btn-primary {',
      '  appearance: none; border: none; border-radius: 8px; padding: 8px 18px;',
      '  font-size: 13px; font-weight: 600; color: #fff; cursor: pointer;',
      '  background-image: linear-gradient(135deg, #4f8cff 0%, #7c5cff 100%);',
      '  box-shadow: 0 4px 14px rgba(79, 140, 255, 0.32);',
      '  transition: box-shadow .2s ease, filter .2s ease, transform .2s ease;',
      '}',
      '.apm-btn-primary:hover:not(:disabled) {',
      '  filter: brightness(1.08); box-shadow: 0 6px 20px rgba(79, 140, 255, 0.45);',
      '  transform: translateY(-1px);',
      '}',
      '.apm-btn-primary:active:not(:disabled) { transform: translateY(0); }',
      '.apm-btn-primary:disabled { opacity: .55; cursor: default; }',
      '.apm-btn-danger {',
      '  appearance: none; border-radius: 8px; padding: 8px 18px; font-size: 13px;',
      '  font-weight: 500; cursor: pointer;',
      '  border: 1px solid var(--dsw-alias-state-error-primary);',
      '  background-color: rgba(220, 68, 68, 0.12);',
      '  color: var(--dsw-alias-state-error-primary);',
      '  transition: background-color .2s ease, box-shadow .2s ease;',
      '}',
      '.apm-btn-danger:hover:not(:disabled) {',
      '  background-color: rgba(220, 68, 68, 0.24);',
      '  box-shadow: 0 4px 14px rgba(220, 68, 68, 0.20);',
      '}',
      '.apm-btn-danger:disabled { opacity: .45; cursor: default; }',
      /* 彻底重置：比「一键清空」更深、更沉的红，视觉上明确"更危险" */
      '.apm-btn-nuke {',
      '  appearance: none; border-radius: 8px; padding: 8px 18px; font-size: 13px;',
      '  font-weight: 600; cursor: pointer;',
      '  border: 1px solid #7f1d1d;',
      '  background-color: rgba(127, 29, 29, 0.55);',
      '  color: #fecaca;',
      '  transition: background-color .2s ease, box-shadow .2s ease, color .2s ease;',
      '}',
      '.apm-btn-nuke:hover:not(:disabled) {',
      '  background-color: rgba(153, 27, 27, 0.85);',
      '  color: #ffffff;',
      '  box-shadow: 0 4px 16px rgba(153, 27, 27, 0.45);',
      '}',
      '.apm-btn-nuke:disabled { opacity: .45; cursor: default; }',
      '.apm-range { width: 100%; accent-color: var(--dsw-alias-brand-primary); }',
      /* B：顶部「插件管理 →」文字链接 */
      '.apm-link {',
      '  appearance: none; border: none; background: transparent; padding: 0;',
      '  font-size: 12px; cursor: pointer;',
      '  color: var(--dsw-alias-brand-primary);',
      '  transition: opacity .2s ease;',
      '}',
      '.apm-link:hover { opacity: .75; text-decoration: underline; }',
      /* A：底部危险区折叠 */
      '.apm-disclosure {',
      '  appearance: none; border: none; background: transparent; padding: 0;',
      '  font-size: 12px; cursor: pointer; text-align: left;',
      '  color: var(--dsw-alias-label-tertiary);',
      '  transition: color .2s ease;',
      '}',
      '.apm-disclosure:hover { color: var(--dsw-alias-state-error-primary); }',
    ].join('\n');

    function MemoryIcon() {
      return h('svg', { viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M12 4v16M6 8.5v7M18 8.5v7M3 11v2M21 11v2',
          stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 1.8, strokeLinecap: 'round',
        }),
        h('circle', { cx: 12, cy: 12, r: 2.4, fill: 'var(--dsw-alias-brand-primary)' }),
      );
    }

    function Toggle(props) {
      const enabled = props.enabled === true;
      const busy = props.busy === true;

      return h('div', { style: styles.toggleRow },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          'aria-label': props.label,
          'aria-busy': busy ? 'true' : 'false',
          disabled: busy || props.disabled === true,
          style: Object.assign(
            {},
            styles.switchBase,
            enabled ? styles.switchOn : styles.switchOff,
            busy ? { opacity: 0.6, cursor: 'default' } : {},
          ),
          onClick: props.onToggle,
        }, h('span', { style: Object.assign({}, styles.knob, { left: enabled ? '19px' : '3px' }) })),
        h('div', { style: styles.toggleBody },
          h('div', { style: styles.toggleLabel }, props.label),
          h('div', { style: styles.toggleHint }, props.hint),
        ),
      );
    }

    function ConfirmClearDialog(props) {
      const [typed, setTyped] = React.useState('');
      const [error, setError] = React.useState('');
      const ok = /^yes$/i.test(String(typed).trim());

      const submit = function () {
        if (!/^yes$/i.test(String(typed).trim())) {
          setError(UI.wrongCode);
          return;
        }
        props.onConfirm();
      };

      const onKeyDown = function (event) {
        if (event.key === 'Escape') { props.onCancel(); return; }
        if (event.key === 'Enter') { event.preventDefault(); submit(); }
      };

      return h('div', {
        style: styles.overlay,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': UI.modalTitle,
        onKeyDown,
        onClick: function (event) { if (event.target === event.currentTarget) props.onCancel(); },
      },
        h('div', { style: styles.dialog },
          h('div', { style: styles.dialogTitle }, UI.modalTitle),
          h('div', { style: styles.dialogBody }, UI.modalBody),
          h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, UI.modalPrompt),
          h('input', {
            style: styles.modalInput,
            value: typed,
            autoFocus: true,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: UI.modalPlaceholder,
            disabled: props.busy === true,
            onChange: function (event) {
              setTyped(event.target.value);
              if (error) setError('');
            },
          }),
          error ? h('div', { style: styles.errorLine }, error) : null,
          h('div', { style: styles.dialogActions },
            h('button', {
              type: 'button', style: styles.dialogCancel,
              disabled: props.busy === true, onClick: props.onCancel,
            }, UI.modalCancel),
            h('button', {
              type: 'button',
              style: ok && !props.busy ? styles.dangerSolid : Object.assign({}, styles.dangerSolid, styles.dangerSoft),
              disabled: !ok || props.busy === true,
              onClick: submit,
            }, props.busy ? UI.clearing : UI.modalConfirm),
          ),
        ),
      );
    }

    /**
     * 彻底重置弹窗：不可关闭 + 5 秒倒计时 + 大写 YES。
     *
     * 防呆设计：
     *   - 没有 ×，点遮罩无效，Esc 无效（只能点「取消操作」）；
     *   - 倒计时期间确认按钮灰色不可点；
     *   - 倒计时结束后也必须手打大写 YES 才能点。
     */
    function NukeDialog(props) {
      const [seconds, setSeconds] = React.useState(5);
      const [typed, setTyped] = React.useState('');
      const ready = seconds <= 0;
      const canConfirm = ready && String(typed).trim() === 'YES' && props.busy !== true;

      React.useEffect(function () {
        if (seconds <= 0) return undefined;
        const timer = window.setTimeout(function () {
          setSeconds(function (value) { return value - 1; });
        }, 1000);
        return function () { window.clearTimeout(timer); };
      }, [seconds]);

      return h('div', {
        style: styles.overlay,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': UI.nukeTitle,
        // 不响应 Esc、不响应遮罩点击：只能显式点「取消操作」
        onKeyDown: function (event) { if (event.key === 'Escape') event.preventDefault(); },
        onClick: function (event) { event.stopPropagation(); },
      },
        h('div', { style: styles.dialog },
          h('div', { style: { fontSize: '15px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } }, UI.nukeTitle),
          h('div', { style: styles.dialogBody }, UI.nukeBody),
          h('div', { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' } }, UI.nukePrompt),
          h('input', {
            style: styles.modalInput,
            value: typed,
            autoFocus: true,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: 'YES',
            disabled: !ready || props.busy === true,
            onChange: function (event) { setTyped(event.target.value); },
          }),
          h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } },
            ready ? '输入大写 YES 后按钮才会亮起' : UI.nukeCountdown(seconds)),
          h('div', { style: styles.dialogActions },
            h('button', {
              type: 'button', style: styles.dialogCancel,
              disabled: props.busy === true,
              onClick: props.onCancel,
            }, UI.nukeCancel),
            h('button', {
              type: 'button',
              style: canConfirm ? styles.dangerSolid : Object.assign({}, styles.dangerSolid, styles.dangerSoft),
              disabled: !canConfirm,
              onClick: function () { if (canConfirm) props.onConfirm(); },
            }, props.busy ? UI.nuking : (ready ? UI.nukeConfirm : UI.nukeCountdown(seconds))),
          ),
        ),
      );
    }

    /**
     * 卸载引导弹窗（B + A）。
     *
     * 刻意不执行任何"代码卸载"——只给出官方命令 + 说明，
     * 因为真正卸载必须改 profile 依赖并重启，那是官方插件管理器的职责。
     * mode = 'keep'：保留数据；mode = 'wipe'：先清数据（复用彻底重置弹窗）再卸载。
     */
    function UninstallDialog(props) {
      const wipe = props.mode === 'wipe';
      const [copied, setCopied] = React.useState(false);

      const copy = function () {
        const text = props.command;
        const done = function () {
          setCopied(true);
          props.onCopied();
        };

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(done).catch(function () { done(); });
          return;
        }

        // 老浏览器兜底
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
        } catch {
          // 复制失败也不阻塞：用户仍可手动选中
        }
        done();
      };

      return h('div', {
        style: styles.overlay,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': UI.uninstallTitle,
        onKeyDown: function (event) { if (event.key === 'Escape') props.onCancel(); },
        onClick: function (event) { if (event.target === event.currentTarget) props.onCancel(); },
      },
        h('div', { style: styles.dialog },
          h('div', { style: styles.dialogTitle }, UI.uninstallTitle),
          h('div', { style: styles.dialogBody }, wipe ? UI.uninstallBodyWipe : UI.uninstallBodyKeep),
          h('div', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, UI.uninstallCmdHint),
          h('div', { style: styles.cmdBlock }, props.command),
          h('div', { style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } }, UI.uninstallNote),
          h('div', { style: styles.dialogActions },
            wipe
              ? h('button', {
                  type: 'button',
                  className: 'apm-btn-nuke',
                  onClick: props.onWipe,
                }, UI.wipeNow)
              : null,
            h('button', {
              type: 'button',
              className: 'apm-btn-primary',
              onClick: copy,
            }, copied ? UI.manageCopied : UI.copyCmd),
            h('button', {
              type: 'button', style: styles.dialogCancel,
              onClick: props.onCancel,
            }, UI.close),
          ),
        ),
      );
    }

    function MemorySection(props) {
      const onOpenManager = props && typeof props.onOpenManager === 'function' ? props.onOpenManager : null;
      const uninstallCommand = (props && props.uninstallCommand) || '';
      const [state, setState] = React.useState({ status: 'loading', data: null, error: null });
      const [savingKey, setSavingKey] = React.useState(null);
      const [settingsError, setSettingsError] = React.useState('');
      const [personaDraft, setPersonaDraft] = React.useState(null);
      const [personaSaving, setPersonaSaving] = React.useState(false);
      const [sensitivityDraft, setSensitivityDraft] = React.useState(null);
      const [rootDraft, setRootDraft] = React.useState(null);
      const [memoryDraft, setMemoryDraft] = React.useState('');
      const [memorizing, setMemorizing] = React.useState(false);
      const [modalOpen, setModalOpen] = React.useState(false);
      const [clearing, setClearing] = React.useState(false);
      const [nukeOpen, setNukeOpen] = React.useState(false);
      const [nuking, setNuking] = React.useState(false);
      const [dangerOpen, setDangerOpen] = React.useState(false);
      const [uninstallMode, setUninstallMode] = React.useState(null);
      const [toasts, setToasts] = React.useState([]);

      const pushToast = React.useCallback(function (type, text) {
        const id = Date.now() + Math.random();
        setToasts(function (prev) { return prev.concat([{ id, type, text }]); });
        window.setTimeout(function () {
          setToasts(function (prev) { return prev.filter(function (item) { return item.id !== id; }); });
        }, 3200);
      }, []);

      const load = React.useCallback(function () {
        setState({ status: 'loading', data: null, error: null });
        return requestJson(STATS_URL, { method: 'GET' })
          .then(function (data) {
            setState({ status: 'ready', data, error: null });
            setPersonaDraft(null);
            setSensitivityDraft(null);
          })
          .catch(function (error) {
            setState({ status: 'offline', data: null, error: errorMessage(error) });
          });
      }, []);

      React.useEffect(function () {
        let alive = true;
        requestJson(STATS_URL, { method: 'GET' })
          .then(function (data) { if (alive) setState({ status: 'ready', data, error: null }); })
          .catch(function (error) {
            if (!alive) return;
            setState({ status: 'offline', data: null, error: errorMessage(error) });
          });
        return function () { alive = false; };
      }, []);

      const settings = Object.assign(
        {},
        FALLBACK_SETTINGS,
        state.data && state.data.settings ? state.data.settings : {},
      );

      const patchSettings = async function (patch, key) {
        setSettingsError('');
        setSavingKey(key);

        setState(function (prev) {
          if (!prev || !prev.data) return prev;
          return Object.assign({}, prev, {
            data: Object.assign({}, prev.data, {
              settings: Object.assign({}, prev.data.settings || FALLBACK_SETTINGS, patch),
            }),
          });
        });

        try {
          const result = await requestJson(SETTINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          });
          if (result.settings) {
            setState(function (prev) {
              if (!prev || !prev.data) return prev;
              return Object.assign({}, prev, {
                data: Object.assign({}, prev.data, { settings: result.settings }),
              });
            });
          }
          pushToast('ok', UI.savedToast);
          return true;
        } catch (error) {
          void load();
          setSettingsError(UI.failedToast + '：' + errorMessage(error));
          pushToast('err', UI.failedToast + '：' + errorMessage(error));
          return false;
        } finally {
          setSavingKey(null);
        }
      };

      const onToggle = function (key) {
        if (savingKey !== null) return;
        const patch = {};
        patch[key] = !settings[key];
        void patchSettings(patch, key);
      };

      const onModeChange = function (event) {
        if (savingKey !== null) return;
        void patchSettings({ writeMode: event.target.value }, 'writeMode');
      };

      // 敏感度：拖动时只更新本地，停手 500ms 再落库，避免每像素一次请求。
      const sensitivityValue = sensitivityDraft === null ? settings.sensitivity : sensitivityDraft;
      React.useEffect(function () {
        if (sensitivityDraft === null) return undefined;
        if (sensitivityDraft === settings.sensitivity) return undefined;
        const timer = window.setTimeout(function () {
          void patchSettings({ sensitivity: sensitivityDraft }, 'sensitivity');
        }, 500);
        return function () { window.clearTimeout(timer); };
      }, [sensitivityDraft, settings.sensitivity]);

      const personaValue = personaDraft === null ? settings.persona : personaDraft;
      const personaDirty = personaDraft !== null && personaDraft !== settings.persona;

      // 存储位置：默认显示当前实际路径；用户可点盘符或手填，保存后重启生效。
      const currentRoot = state.data ? String(state.data.memoryRoot || state.data.dbPath || '') : '';
      const rootValue = rootDraft === null ? (settings.memoryRoot || currentRoot) : rootDraft;
      const rootDirty = rootDraft !== null && rootDraft.trim() !== settings.memoryRoot;
      const drives =
        state.data && Array.isArray(state.data.availableDrives) ? state.data.availableDrives : [];

      const saveRoot = function () {
        if (savingKey !== null || !rootDirty) return;
        void patchSettings({ memoryRoot: rootDraft.trim() }, 'memoryRoot');
      };

      const savePersona = async function () {
        if (personaSaving || !personaDirty) return;
        setPersonaSaving(true);
        const ok = await patchSettings({ persona: personaDraft }, 'persona');
        setPersonaSaving(false);
        if (ok) setPersonaDraft(null);
      };

      const addMemory = async function () {
        const text = memoryDraft.trim();
        if (memorizing || text.length === 0) return;
        setMemorizing(true);
        try {
          await requestJson(MEMORIZE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
          });
          setMemoryDraft('');
          pushToast('ok', UI.addedToast);
          await load();
        } catch (error) {
          pushToast('err', UI.failedToast + '：' + errorMessage(error));
        } finally {
          setMemorizing(false);
        }
      };

      const doClear = async function () {
        setClearing(true);
        try {
          const result = await requestJson(CLEAR_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: 'YES' }),
          });
          setModalOpen(false);
          pushToast(
            'ok',
            '已清空 ' + Number(result.deletedRows || 0) + ' 条；备份在 ' + String(result.backupPath || ''),
          );
          await load();
        } catch (error) {
          setState({ status: 'offline', data: null, error: errorMessage(error) });
          pushToast('err', '清空失败：' + errorMessage(error));
          setModalOpen(false);
        } finally {
          setClearing(false);
        }
      };

      const doNuke = async function () {
        setNuking(true);
        try {
          const result = await requestJson(NUKE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: 'YES' }),
          });
          setNukeOpen(false);
          pushToast(
            'ok',
            UI.nukeDone + '：清空 ' + Number(result.deletedRows || 0) + ' 条，删除备份 ' +
              Number((result.removedBackups || []).length) + ' 份',
          );
          await load();
        } catch (error) {
          pushToast('err', '彻底重置失败：' + errorMessage(error));
          setNukeOpen(false);
        } finally {
          setNuking(false);
        }
      };

      const total =
        state.data && Number.isFinite(Number(state.data.total)) ? Number(state.data.total) : null;

      const openManager = function () {
        // B：优先跳到官方插件管理器的本插件页；没有该服务就退化成命令引导。
        const ok = onOpenManager === null ? false : onOpenManager();
        if (!ok) {
          pushToast('err', UI.manageFallback);
          setUninstallMode('keep');
        }
      };

      const children = [
        h('style', { key: 'css' }, SCROLL_CSS),
        h('div', { key: 'header', style: styles.header },
          h('span', { style: styles.headerIcon }, h(MemoryIcon)),
          h('div', { style: styles.headerText },
            h('div', { style: styles.title }, UI.title),
            h('div', { style: styles.subtitle }, UI.subtitle),
          ),
        ),
        h('div', { key: 'manage', style: styles.manageRow },
          h('span', null, UI.manageTitle),
          h('button', {
            type: 'button',
            className: 'apm-link',
            onClick: openManager,
          }, UI.manageOpen),
        ),
      ];

      if (state.status === 'offline') {
        children.push(
          h('div', { key: 'offline', style: styles.offline, role: 'status' },
            h('div', { style: { fontWeight: 600, marginBottom: '4px' } }, UI.offline),
            h('div', null, UI.offlineHint),
            state.error ? h('div', { style: { marginTop: '6px', opacity: 0.8 } }, String(state.error)) : null,
          ),
        );
      } else {
        children.push(
          h('div', { key: 'card', style: styles.card },
            h('div', { style: styles.totalRow },
              h('span', { style: styles.totalValue },
                state.status === 'ready' && total !== null ? String(total) : UI.none),
              h('span', { style: styles.totalLabel }, UI.totalLabel),
            ),
            state.status === 'ready' && total === 0
              ? h('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, UI.empty)
              : null,
            state.data
              ? h('div', { style: styles.meta },
                  h('div', null, '数据库：' + String(state.data.dbPath || '')),
                  h('div', null, '档案：' + String(state.data.archiveRoot || '')),
                  h('div', null, '快照：' + String(state.data.backupsDir || 'D:\\AI_Memory\\backups') +
                    '（保留最近 ' + String(settings.backupRetention) + ' 份）'),
                  h('div', null, '占用：' + formatBytes(state.data.dbBytes)),
                )
              : h('div', { style: styles.meta }, UI.loading),
          ),
        );

        children.push(
          h('div', { key: 'toggles', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.togglesTitle),
            h('div', { style: styles.sectionHint }, UI.togglesHint),
            TOGGLES.map(function (def) {
              return h(Toggle, {
                key: def.key,
                label: (settings[def.key] ? '✅ ' : '⬜ ') + def.label,
                hint: def.hint,
                enabled: settings[def.key] === true,
                busy: savingKey === def.key,
                disabled: savingKey !== null,
                onToggle: function () { onToggle(def.key); },
              });
            }),
          ),
        );

        children.push(
          h('div', { key: 'mode', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.modeTitle),
            h('div', { style: styles.sectionHint }, UI.modeHint),
            h('select', {
              style: styles.select,
              value: settings.writeMode,
              disabled: savingKey !== null,
              onChange: onModeChange,
              'aria-label': UI.modeTitle,
            }, WRITE_MODES.map(function (mode) {
              return h('option', { key: mode.value, value: mode.value }, mode.label);
            })),
          ),
        );

        children.push(
          h('div', { key: 'sensitivity', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.sensitivityTitle),
            h('div', { style: styles.sectionHint }, UI.sensitivityHint),
            h('input', {
              type: 'range',
              className: 'apm-range',
              min: 0,
              max: 100,
              step: 5,
              value: sensitivityValue,
              disabled: savingKey === 'sensitivity',
              'aria-label': UI.sensitivityTitle,
              onChange: function (event) { setSensitivityDraft(Number(event.target.value)); },
            }),
            h('div', { style: styles.sliderRow },
              h('span', null, '只带强相关'),
              h('span', { style: styles.sliderValue }, String(sensitivityValue) + '%'),
              h('span', null, '更容易带入'),
            ),
          ),
        );

        children.push(
          h('div', { key: 'storage', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.storageTitle),
            h('div', { style: styles.sectionHint }, UI.storageHint),
            h('div', { style: styles.meta }, UI.storageCurrent + '：' + currentRoot),
            drives.length > 0
              ? h('div', { style: Object.assign({}, styles.actions, { marginTop: '10px' }) },
                  drives.map(function (letter) {
                    const selected = String(rootValue).toUpperCase().indexOf(letter + ':') === 0;
                    return h('button', {
                      key: letter,
                      type: 'button',
                      style: selected
                        ? Object.assign({}, styles.button, {
                            borderColor: 'var(--dsw-alias-brand-primary)',
                            color: 'var(--dsw-alias-brand-primary)',
                          })
                        : styles.button,
                      disabled: savingKey === 'memoryRoot',
                      onClick: function () { setRootDraft(letter + ':\\AI_Memory'); },
                    }, letter + ': 盘');
                  }),
                )
              : null,
            h('input', {
              style: Object.assign({}, styles.input, { marginTop: '10px' }),
              value: rootValue,
              placeholder: UI.storagePlaceholder,
              disabled: savingKey === 'memoryRoot',
              onChange: function (event) { setRootDraft(event.target.value); },
              'aria-label': UI.storageTitle,
            }),
            h('div', { style: styles.rowBetween },
              h('button', {
                type: 'button',
                className: 'apm-btn-primary',
                disabled: !rootDirty || savingKey === 'memoryRoot',
                onClick: saveRoot,
              }, savingKey === 'memoryRoot' ? UI.storageSaving : UI.storageSave),
              rootDirty
                ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, '重启 DSH 后生效')
                : null,
            ),
          ),
        );

        children.push(
          h('div', { key: 'add', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.addTitle),
            h('div', { style: styles.sectionHint }, UI.addHint),
            h('input', {
              style: styles.input,
              value: memoryDraft,
              placeholder: UI.addPlaceholder,
              maxLength: 500,
              disabled: memorizing,
              onChange: function (event) { setMemoryDraft(event.target.value); },
              onKeyDown: function (event) {
                if (event.key === 'Enter') { event.preventDefault(); void addMemory(); }
              },
              'aria-label': UI.addTitle,
            }),
            h('div', { style: styles.rowBetween },
              h('button', {
                type: 'button',
                className: 'apm-btn-primary',
                disabled: memorizing || memoryDraft.trim().length === 0,
                onClick: function () { void addMemory(); },
              }, memorizing ? UI.adding : UI.addButton),
            ),
          ),
        );

        children.push(
          h('div', { key: 'persona', style: styles.card },
            h('div', { style: styles.sectionTitle }, UI.personaTitle),
            h('div', { style: styles.sectionHint }, UI.personaHint),
            h('textarea', {
              style: styles.textarea,
              value: personaValue,
              placeholder: UI.personaPlaceholder,
              spellCheck: false,
              disabled: personaSaving,
              onChange: function (event) { setPersonaDraft(event.target.value); },
              'aria-label': UI.personaTitle,
            }),
            h('div', { style: styles.rowBetween },
              h('button', {
                type: 'button',
                className: 'apm-btn-primary',
                disabled: !personaDirty || personaSaving,
                onClick: function () { void savePersona(); },
              }, personaSaving ? UI.personaSaving : UI.personaSave),
              personaDirty
                ? h('span', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, '未保存')
                : null,
            ),
          ),
        );

        if (settingsError) {
          children.push(h('div', { key: 'settings-error', style: styles.errorLine }, settingsError));
        }
      }

      children.push(
        h('div', { key: 'actions', style: styles.actions },
          h('button', {
            type: 'button',
            style: state.status === 'loading' ? Object.assign({}, styles.button, styles.buttonBusy) : styles.button,
            disabled: state.status === 'loading',
            onClick: function () { void load(); },
          }, state.status === 'loading' ? UI.loading : UI.refresh),
          h('button', {
            type: 'button',
            className: 'apm-btn-danger',
            disabled: state.status !== 'ready' || clearing,
            onClick: function () { setModalOpen(true); },
          }, clearing ? UI.clearing : UI.clear),
          h('button', {
            type: 'button',
            className: 'apm-btn-nuke',
            disabled: state.status !== 'ready' || nuking,
            onClick: function () { setNukeOpen(true); },
            title: '清空记忆并删除所有历史备份，不可恢复',
          }, nuking ? UI.nuking : UI.nuke),
        ),
      );

      // A：底部折叠「危险操作（卸载）」——数据侧操作，不直接卸载代码。
      children.push(
        h('div', { key: 'danger', style: styles.dangerZone },
          h('button', {
            type: 'button',
            className: 'apm-disclosure',
            'aria-expanded': dangerOpen ? 'true' : 'false',
            onClick: function () { setDangerOpen(!dangerOpen); },
          }, (dangerOpen ? '▾ ' : '▸ ') + UI.dangerToggle),
          dangerOpen
            ? h('div', { key: 'danger-body', style: styles.dangerBody },
                h('div', { style: { fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-tertiary)' } }, UI.dangerHint),
                h('div', { style: styles.actions },
                  h('button', {
                    type: 'button',
                    className: 'apm-btn-danger',
                    onClick: function () { setUninstallMode('keep'); },
                  }, UI.uninstallKeep),
                  h('button', {
                    type: 'button',
                    className: 'apm-btn-nuke',
                    onClick: function () { setUninstallMode('wipe'); },
                  }, UI.uninstallWipe),
                ),
              )
            : null,
        ),
      );

      if (modalOpen) {
        children.push(h(ConfirmClearDialog, {
          key: 'dialog',
          busy: clearing,
          onCancel: function () { if (!clearing) setModalOpen(false); },
          onConfirm: function () { void doClear(); },
        }));
      }

      if (uninstallMode !== null) {
        children.push(h(UninstallDialog, {
          key: 'uninstall-dialog',
          mode: uninstallMode,
          command: uninstallCommand,
          onCancel: function () { setUninstallMode(null); },
          onCopied: function () { pushToast('ok', UI.manageCopied); },
          onWipe: function () {
            // 先走「彻底重置」的 5 秒 + YES 流程，数据清完再回来拿命令。
            setUninstallMode(null);
            setNukeOpen(true);
          },
        }));
      }

      if (nukeOpen) {
        children.push(h(NukeDialog, {
          key: 'nuke-dialog',
          busy: nuking,
          onCancel: function () { if (!nuking) setNukeOpen(false); },
          onConfirm: function () { void doNuke(); },
        }));
      }

      if (toasts.length > 0) {
        children.push(
          h('div', { key: 'toasts', style: styles.toastWrap },
            toasts.map(function (toast) {
              return h('div', {
                key: String(toast.id),
                role: 'status',
                style: Object.assign(
                  {},
                  styles.toast,
                  toast.type === 'ok' ? styles.toastOk : styles.toastErr,
                ),
              }, toast.text);
            }),
          ),
        );
      }

      return h('div', { className: 'apm-panel', style: styles.page }, children);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // B：官方插件管理器提供的跳转服务（可选；没有就退化成命令引导）。
        let navigation = null;
        ctx.inject(['pluginNavigation'], function (nctx) {
          const service = nctx && nctx.pluginNavigation;
          navigation = service && typeof service.openBundle === 'function' ? service : null;
          return function () { navigation = null; };
        });

        const openManager = function () {
          if (navigation === null) return false;
          try {
            navigation.openBundle('ai-persistent-memory');
            return true;
          } catch {
            return false;
          }
        };

        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 30, label: UI.nav },
            function () {
              return h(MemorySection, {
                onOpenManager: openManager,
                uninstallCommand: 'dsh plugin --profile desktop remove ai-persistent-memory',
              });
            },
          );
        });
      },
    };
  },
});
