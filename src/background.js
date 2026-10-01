// Abre (ou foca) a janela do painel. Chrome fecha popups de action ao perder foco,
// então o painel é uma janela do tipo "popup" que fica aberta durante a reunião.
async function openMonitor(focused) {
  const { monitorWin } = await chrome.storage.session.get("monitorWin");
  if (monitorWin) {
    try {
      await chrome.windows.update(monitorWin, { focused });
      return;
    } catch {}
  }
  const w = await chrome.windows.create({
    url: chrome.runtime.getURL("src/monitor.html"),
    type: "popup",
    width: 400,
    height: 640,
    focused,
  });
  await chrome.storage.session.set({ monitorWin: w.id });
}

chrome.action.onClicked.addListener(() => openMonitor(true));

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "call-started") openMonitor(false);
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { monitorWin } = await chrome.storage.session.get("monitorWin");
  if (monitorWin === id) chrome.storage.session.remove("monitorWin");
});
