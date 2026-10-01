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
    // O Meet usa fontes de ícone (Material/Google Symbols): o texto do ícone ("keep", "mic_off"...) aparece
    // no innerText como se fosse nome. Ignora elementos com fonte de ícone e, por garantia, nomes de ícones conhecidos.
    const ICON_NAMES = new Set([
      "keep", "keep_off", "push_pin", "pinned", "mic", "mic_off", "videocam", "videocam_off", "more_vert", "more_horiz",
      "present_to_all", "back_hand", "frame_person", "devices", "visibility", "visibility_off", "close", "add", "remove",
      "person", "people", "call_end", "chat", "info", "apps", "lock", "volume_up", "volume_off", "pan_tool", "front_hand",
      "hearing", "closed_caption", "star", "check", "done", "expand_more", "expand_less", "arrow_back", "arrow_forward",
    ]);
    const isIconEl = (el) =>
      el.getAttribute("aria-hidden") === "true" ||
      /material|google-symbols|symbols/i.test(typeof el.className === "string" ? el.className : "") ||
      /material|symbols|icons/i.test(getComputedStyle(el).fontFamily || "");
    const isIconText = (t) => ICON_NAMES.has(t.toLowerCase()) || /^[a-z]+(_[a-z]+)+$/.test(t);
    // Textos do elemento, sem botões e sem ícones.
    const texts = (root) => {
      const out = [];
      const walk = (n) => {
        if (n.nodeType === 3) { const t = n.textContent.trim(); if (t) out.push(t); return; }
        if (n.nodeType !== 1 || /^(BUTTON|SCRIPT|STYLE)$/.test(n.tagName) || isIconEl(n)) return;
        n.childNodes.forEach(walk);
      };
      root.childNodes.forEach(walk);
      return out;
    };
    const nameOf = (el) => {
      const own = el.querySelector("[data-self-name]")?.textContent?.trim();
      const t = own || texts(el).find((x) => !isIconText(x) && !/^\d+$/.test(x)) || "";
      return t.replace(/\s*\((você|voce|you|tú|tu)\)\s*$/i, "").trim();
    };
    // Tile/linha de apresentação de tela não é uma pessoa ("Apresentação de X", "X's presentation").
    const isPresentation = (n) => /apresenta[çc][aã]o|presentation|presenting/i.test(n);

    let els = [...document.querySelectorAll('[role="list"][aria-label] [role="listitem"]')].filter((el) =>
      /particip|pessoa|people|everyone|todos/i.test(el.closest('[role="list"]').getAttribute("aria-label") || "")
    );
    if (!els.length) els = [...document.querySelectorAll("[data-participant-id]")];
    const seen = {};
    const names = [];
    for (const el of els) {
      const n = nameOf(el);
      if (!n || n.length > 80 || isIconText(n) || isPresentation(n)) continue;
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
