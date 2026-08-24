export function installModelSelection(ctx, preset, provider, otherProvider) {
  const connection = ctx.get("connection");
  const selecting = new Set();
  const pending = new Set();

  const sync = () => {
    const list = ctx.sessions.list.getSnapshot();
    const id = list.current;
    if (id === undefined || list.byId[id]?.blank !== true) return;
    if (selecting.has(id)) {
      pending.add(id);
      return;
    }

    const selectedPreset = list.byId[id]?.agentPreset;
    if (selectedPreset !== preset && selectedPreset === otherProvider) return;
    selecting.add(id);
    void connection.api.sessions.models({ sessionId: id }).then(async (response) => {
      const { result } = response;
      if (!result.ok) return;
      const latest = ctx.sessions.list.getSnapshot().byId[id];
      if (latest?.blank !== true || latest.agentPreset !== selectedPreset) {
        pending.add(id);
        return;
      }
      const target = selectedPreset === preset
        ? result.value.groups.find((group) => group.id === provider)
        : result.value.current.provider === provider
          ? result.value.groups.find((group) => group.id !== provider && group.id !== otherProvider)
          : undefined;
      const model = target?.models[0];
      if (!target || !model) return;
      await connection.api.sessions.selectModel({
        sessionId: id,
        provider: target.id,
        model: model.id,
        ...(model.reasoning?.defaultEffort
          ? { reasoningEffort: model.reasoning.defaultEffort }
          : {}),
      });
    }).catch(() => {}).finally(() => {
      selecting.delete(id);
      if (pending.delete(id)) sync();
    });
  };

  const off = ctx.sessions.list.subscribe(sync);
  sync();
  return off;
}
