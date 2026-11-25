import { api, errText } from "../api";
import { Board } from "../board/Board";
import { bindAppearance, turnOf } from "../board/appearance";
import { clear, h, toast } from "../dom";
import { t } from "../i18n";
import { getSetting, setSetting } from "../settings";
import data from "../academy/lessons.json";
import type { View } from "./types";

interface Step { type: "text" | "position" | "exercise"; key: string; fen?: string; goal?: "mate" | "move"; solutions?: string[] }
interface Lesson { id: string; steps: Step[] }
const LESSONS = (data as { lessons: Lesson[] }).lessons;

const progress = (): Set<string> => { try { return new Set(JSON.parse(getSetting("academy_progress", "[]")) as string[]); } catch { return new Set(); } };

export async function academyView(): Promise<View> {
  const root = h("div", { class: "view" });
  let board: Board | null = null; let unbind: (() => void) | null = null;
  const dispose = () => { unbind?.(); board?.destroy(); board = null; unbind = null; };
  const list = () => {
    dispose(); clear(root);
    const done = progress();
    root.append(h("div", { class: "page-head" }, h("h1", {}, t("nav.academy")), h("p", { class: "dim" }, t("academy.subtitle", { done: done.size, total: LESSONS.length }))),
      h("div", { class: "grid-cards" }, ...LESSONS.map((l) => h("button", { class: "choice", type: "button", onClick: () => void open(l) }, h("h3", {}, t(`academy.lessons.${l.id}.title`)), h("p", { class: "dim small" }, t(`academy.lessons.${l.id}.summary`)), h("span", { class: "badge" }, done.has(l.id) ? t("academy.completed") : t("academy.steps", { n: l.steps.length }))))));
  };

  const open = async (lesson: Lesson) => {
    dispose(); clear(root);
    let i = 0;
    const stage = h("div", { class: "card col" });
    root.append(h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onClick: list }, `← ${t("academy.back")}`), h("h2", {}, t(`academy.lessons.${lesson.id}.title`))), h("div", { style: "height:14px" }), stage);
    const render = () => {
      dispose(); clear(stage);
      const s = lesson.steps[i]!;
      const bar = h("div", { class: "progress" }, h("i", { style: `width:${(i / lesson.steps.length) * 100}%` }));
      const msg = h("p", { role: "status", "aria-live": "polite" });
      const next = h("button", { class: "btn primary", type: "button", onClick: () => advance() }, i === lesson.steps.length - 1 ? t("academy.finish") : t("academy.next"));
      stage.append(bar, h("p", {}, t(s.key)));
      if (s.type === "text") { stage.append(h("div", { class: "row" }, next)); return; }
      const host = h("div", { class: "board-host compact" });
      stage.append(host, msg);
      let fen = s.fen!;
      const b = new Board(host, { legalMoves: () => api.legalMoves(fen), askPromotion: async () => "q", onMove: (uci) => void attempt(uci) });
      board = b; unbind = bindAppearance(b); b.setPosition(fen, turnOf(fen));
      if (s.type === "position") { b.setInteractive(false); stage.append(h("div", { class: "row" }, next)); return; }
      b.setFlipped(turnOf(fen) === "b"); void b.reloadLegal();
      const attempt = async (uci: string) => {
        b.setInteractive(false);
        try {
          const r = await api.play(fen, uci);
          const ok = s.goal === "mate" ? r.status === "checkmate" : (s.solutions ?? []).includes(uci);
          await b.animateMove(uci, r.fen, turnOf(r.fen)); b.setLastMove(uci); b.setCheck(r.check_square);
          if (ok) { msg.textContent = t("academy.correct"); stage.append(h("div", { class: "row" }, next)); return; }
          msg.textContent = t("academy.tryAgain");
          setTimeout(() => { fen = s.fen!; b.setPosition(fen, turnOf(fen)); b.setLastMove(null); b.setCheck(null); b.setInteractive(true); void b.reloadLegal(); }, 900);
        } catch (e) { msg.textContent = errText(e); b.setInteractive(true); }
      };
    };
    const advance = () => {
      if (i < lesson.steps.length - 1) { i++; render(); return; }
      const done = progress(); done.add(lesson.id);
      setSetting("academy_progress", JSON.stringify([...done])).then(list).catch((e) => { toast(errText(e), "error"); list(); });
    };
    render();
  };
  list();
  return { el: root, destroy: dispose };
}
