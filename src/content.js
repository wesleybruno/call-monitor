// Só observa o Meet e publica o estado em chrome.storage.local.meet.
// Check-in, cálculo e UI ficam na janela do painel (monitor.js).
(() => {
  if (window.__meetCostLoaded) return; // evita injeção dupla
  window.__meetCostLoaded = true;
  const SRC = Math.random().toString(36).slice(2);
  let announced = null;

  function publish() {
    if (!MeetAdapter.isMeetingUrl()) return clear();
    const inCall = MeetAdapter.inCall();
    if (!inCall) return clear();
    const code = MeetAdapter.meetingCode();
    chrome.storage.local.set({
      meet: { inCall: true, code, title: MeetAdapter.title(), count: MeetAdapter.participantCount(), names: MeetAdapter.participantNames(), ts: Date.now(), src: SRC },
    });
    if (announced !== code) {
      announced = code;
      chrome.runtime.sendMessage({ type: "call-started" });
    }
  }

  // Só limpa se o estado publicado for desta aba (evita outra aba do Meet apagar a chamada ativa).
  async function clear() {
    const { meet } = await chrome.storage.local.get("meet");
    if (meet && meet.src === SRC && meet.inCall) chrome.storage.local.set({ meet: { ...meet, inCall: false, ts: Date.now() } });
    announced = null;
  }

  chrome.runtime.onMessage.addListener((m) => { if (m && m.type === "scan") publish(); });
  setInterval(publish, 2000);
  addEventListener("pagehide", clear);
  publish();
})();
