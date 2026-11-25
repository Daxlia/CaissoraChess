// Piccolo helper per costruire DOM senza framework. Il testo passa sempre da textContent (mai innerHTML).
type Child = Node | string | null | false | undefined;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (k === "value" && "value" in el) (el as unknown as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

export interface Modal { close: () => void }

/** Finestra di dialogo nativa (<dialog>): focus trap e tasto Esc gestiti dal browser. */
export function modal(title: string, body: Node, actions: { label: string; primary?: boolean; onClick: () => void | Promise<void> }[], closable = true): Modal {
  const dlg = h("dialog", { class: "modal" });
  const close = () => { dlg.close(); dlg.remove(); };
  const btns = actions.map((a) => h("button", { class: a.primary ? "btn primary" : "btn", type: "button", onClick: async () => { await a.onClick(); } }, a.label));
  dlg.append(h("h2", { class: "modal-title" }, title), body, h("div", { class: "modal-actions" }, ...btns));
  if (!closable) dlg.addEventListener("cancel", (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  return { close };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function toast(message: string, kind: "info" | "error" = "info"): void {
  let host = document.getElementById("toasts");
  if (!host) { host = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.append(host); }
  const el = h("div", { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3000);
}
