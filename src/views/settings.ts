import { applyAccent, applyMode, applyReducedMotion, isHexColor, type Mode } from "../theme";
import { h, toast } from "../dom";
import { errText } from "../api";
import { language, systemLanguage, t } from "../i18n";
import { getSetting, setSetting } from "../settings";
import type { View } from "./types";

export async function settingsView(): Promise<View> {
  const save = async (k: string, v: string, after?: () => void) => { try { await setSetting(k, v); after?.(); } catch (e) { toast(errText(e), "error"); } };
  const field = (labelKey: string, control: HTMLElement, hint?: string) => h("label", { class: "field" }, h("span", {}, t(labelKey)), control, hint ? h("span", { class: "dim small" }, hint) : null);
  const select = (key: string, fallback: string, options: [string, string][], after?: () => void) =>
    h("select", { onChange: (e: Event) => void save(key, (e.target as HTMLSelectElement).value, after) }, ...options.map(([v, l]) => h("option", { value: v, selected: getSetting(key, fallback) === v }, l)));

  const mode = select("theme_mode", "system", [["system", t("settings.modeSystem")], ["light", t("settings.modeLight")], ["dark", t("settings.modeDark")]], () => applyMode(getSetting("theme_mode", "system") as Mode));
  const accent = h("input", { type: "color", value: getSetting("accent", "#d9a441"), "aria-label": t("settings.accent"), onInput: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (isHexColor(v)) applyAccent(v); }, onChange: (e: Event) => void save("accent", (e.target as HTMLInputElement).value) });
  const reduce = h("input", { type: "checkbox", checked: getSetting("reduce_motion", "0") === "1", onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; void save("reduce_motion", on ? "1" : "0", () => applyReducedMotion(on)); } });
  const undo = h("input", { type: "checkbox", checked: getSetting("allow_undo", "1") === "1", onChange: (e: Event) => void save("allow_undo", (e.target as HTMLInputElement).checked ? "1" : "0") });
  const quality = select("quality", "auto", [["auto", t("settings.qualityAuto")], ["high", t("settings.qualityHigh")], ["low", t("settings.qualityLow")]]);
  const tc = select("default_time_control", "5+0", [["1+0", t("play.tc.bullet")], ["5+0", t("play.tc.blitz")], ["10+0", t("play.tc.rapid")], ["30+0", t("play.tc.classical")], ["unlimited", t("play.tc.unlimited")]]);
  const lang = h("select", { disabled: true }, h("option", { value: "en" }, "English"));

  const el = h("div", { class: "view" },
    h("div", { class: "page-head" }, h("h1", {}, t("nav.settings"))),
    h("div", { class: "col", style: "max-width:640px" },
      h("section", { class: "card col" }, h("h2", {}, t("settings.appearance")), field("settings.colorMode", mode), h("div", { class: "row" }, field("settings.accent", accent)), h("label", { class: "row" }, reduce, h("span", {}, t("settings.reduceMotion"))), field("settings.qualityLabel", quality, t("settings.qualityHint"))),
      h("section", { class: "card col" }, h("h2", {}, t("settings.language")), field("settings.language", lang, t("settings.languageHint", { current: language, system: systemLanguage() }))),
      h("section", { class: "card col" }, h("h2", {}, t("settings.game")), field("settings.defaultTc", tc), h("label", { class: "row" }, undo, h("span", {}, t("settings.allowUndo")))),
      h("section", { class: "card col" }, h("h2", {}, t("settings.about")), h("p", { class: "dim" }, t("settings.aboutText")))));
  return { el };
}
