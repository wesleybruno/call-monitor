// Único lugar que conhece o DOM do Meet. Se o Meet mudar, só mexer aqui.
window.MeetAdapter = {
  isMeetingUrl() {
    return /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(location.pathname);
  },
  meetingCode() {
    return location.pathname.replace(/\//g, "");
  },
  // Em chamada = existe botão de sair da chamada.
  inCall() {
    return [...document.querySelectorAll("button[aria-label]")].some((b) =>
      /leave call|sair da chamada|salir de la llamada/i.test(b.getAttribute("aria-label"))
    );
  },
  title() {
    return document.title.replace(/\s*-\s*Google Meet.*/i, "").trim() || this.meetingCode();
  },
  // Nomes dos participantes (painel "Pessoas" se aberto, senão os tiles de vídeo). null se não achar.
  // Seletores são palpites razoáveis e precisam ser validados no Meet real.
  participantNames() {
    const firstLine = (t) =>
      (t || "")
        .split("\n")
        .map((x) => x.trim())
        .filter((x) => x && !/^[a-z]+(_[a-z]+)+$/.test(x)) // ignora ligaduras de ícone (mic_off, more_vert)
        [0] || "";
    const clean = (t) => firstLine(t).replace(/\s*\((você|voce|you|tú|tu)\)\s*$/i, "");
    let els = [...document.querySelectorAll('[role="list"][aria-label] [role="listitem"]')].filter((el) =>
      /particip|pessoa|people|everyone|todos/i.test(el.closest('[role="list"]').getAttribute("aria-label") || "")
    );
    if (!els.length) els = [...document.querySelectorAll("[data-participant-id]")];
    const seen = {};
    const names = [];
    for (const el of els) {
      let n = clean(el.querySelector("[data-self-name]")?.textContent || el.innerText);
      if (!n || n.length > 80) continue;
      seen[n] = (seen[n] || 0) + 1;
      names.push(seen[n] > 1 ? `${n} (${seen[n]})` : n);
    }
    return names.length ? names : null;
  },
  // Contagem automática de participantes. Retorna null se não conseguir.
  participantCount() {
    // 1) Badge numérico no botão "Pessoas"/"Show everyone"
    const btn = [...document.querySelectorAll("button[aria-label]")].find((b) =>
      /show everyone|mostrar todos|people|pessoas/i.test(b.getAttribute("aria-label"))
    );
    if (btn) {
      const m = btn.textContent.match(/\d+/);
      if (m) return parseInt(m[0], 10);
    }
    // 2) Tiles de vídeo
    const tiles = document.querySelectorAll("[data-participant-id]");
    if (tiles.length) return tiles.length;
    return null;
  },
};
