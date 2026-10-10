// File: src/lib/theme.ts
// The page and CodeMirror share the root's saved theme choice (issue 17).

export const LS_THEME_KEY = "agda-web-ide-beta:theme";
export type ThemePreference = "system" | "light" | "dark";

export function prefersDarkTheme(root: HTMLElement, win: Window): boolean {
  return root.dataset.theme === "dark" ||
    (root.dataset.theme !== "light" &&
      win.matchMedia("(prefers-color-scheme: dark)").matches);
}

function updateBrowserChrome() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue("--browser-chrome-surface").trim();
  }
}

export function setThemePreference(preference: ThemePreference): void {
  if (preference === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
  try {
    if (preference === "system") localStorage.removeItem(LS_THEME_KEY);
    else localStorage.setItem(LS_THEME_KEY, preference);
  } catch {
    // A refused store still permits a theme choice for this visit.
  }
  updateBrowserChrome();
}

export function watchTheme(): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", updateBrowserChrome);
  updateBrowserChrome();
  return () => query.removeEventListener("change", updateBrowserChrome);
}
