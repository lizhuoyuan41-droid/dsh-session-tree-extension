# 聊天轮次末尾分支按钮接入会话树

用户要求：会话中的“在新建会话中分支”按钮，功能替换为会话树中的分叉功能。

验收契约：

- C1：从原生聊天轮次末尾按钮触发时，使用其所属 Session 和轮次，调用插件现有 remoteActions.fork + completeFork；成功后父子谱系、草稿初始化、打开子会话均与树面板一致。
- C2：不得把历史按钮映射到最新提示词。保留 host forkSession 的 latest-user 限制；历史轮次不允许时显示失败，不回退到原生 fork。
- C3：保留原生权限与 aria-disabled 行为；复制按钮、用户消息区以及其他 Session 操作不受影响。
- C4：按源 Session 防止并行重复创建；异步失败必须可见；卸载插件移除监听和错误提示，恢复原生按钮。
- C5：不改 DSH 内核、全局 sessions.fork、原生历史日志、host 分叉限制；不 push、不升版本、不封四包。
- C6：类型检查、全量测试、构建通过；新增验证包含历史 Session/turn 定位、不可用按钮、重复点击、失败可见、卸载、真实插件 apply 至 remote/谱系/打开链路。

兼容边界：DSH 0.2.2-rc.1 的 footer 没有 action override 槽。采用语义 DOM 适配：data-conversation-session / data-turn-tail / data-clock=end 与 chat 本地化 message.branch 名称。若宿主改变这些标记，适配不匹配时保留原生行为。本轮不扩大宿主支持范围。
