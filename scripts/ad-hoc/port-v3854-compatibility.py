"""Apply only the reviewed fork compatibility delta to the pinned release.

Run in an isolated task checkout. This script neither commits nor publishes.
It retains v3.8.54's default relevance ranking and UI-kit keyboard components.
"""
from pathlib import Path
import subprocess

OLD_BASE = "191dce8d534ceb56c28a08e71381284a9a87838f"
OLD_HEAD = "ce57802a69b8f2669f7ce946847c5bb406b7d79e"
NEW_BASE = "1c880c5c95b3f0240d5e4c6c8f0947ec46b5d25e"
PALETTE = "src/shared/components/CommandPalette.tsx"
PATCH_PATHS = [
    "open-sse/translator/helpers/openaiHelper.ts",
    "open-sse/translator/index.ts",
    "src/shared/utils/commandPalettePreferences.ts",
    "src/i18n/messages/en.json",
    "src/i18n/messages/pt-BR.json",
    "src/i18n/messages/tr.json",
    "src/i18n/messages/vi.json",
    "src/lib/db/encryption.ts",
    "src/lib/db/providers/migrations.ts",
    "src/lib/db/providers/providerSpecificDataSecrets.ts",
    "src/lib/providers/requestDefaults.ts",
]
TEST_PATHS = [
    "tests/unit/openai-canonical-effort-18912.test.ts",
    "tests/unit/openai-reporting-retirement.test.ts",
    "tests/unit/ui/command-palette-frequency.test.tsx",
]


def git(*args):
    return subprocess.check_output(["git", *args])


def adapt_palette(text):
    def replace(old, new):
        nonlocal text
        if text.count(old) != 1:
            raise ValueError("Palette anchor missing or ambiguous: " + old[:90])
        text = text.replace(old, new, 1)

    replace("useEffect, useMemo, useRef", "useEffect, useId, useMemo, useRef")
    replace("  resolveRuntimeSidebarSections,\n", "  resolveRuntimeSidebarSections,\n  getSectionItems,\n")
    replace('import Button from "./Button";', '''import {
  orderCommandPaletteItems,
  readCommandPalettePreferences,
  recordCommandPaletteExecution,
  saveCommandPalettePreferences,
} from "@/shared/utils/commandPalettePreferences";
import Button from "./Button";''')
    replace('import Icon from "./Icon";', '''import Icon from "./Icon";
import Toggle from "./Toggle";

// Keep hidden commands' history, but never resurrect removed stored command IDs.
const KNOWN_COMMAND_IDS = new Set([
  ...SIDEBAR_SECTIONS.flatMap(getSectionItems).map((item) => item.id),
  "radar-admin",
]);''')
    replace('''function PaletteOption({
  item,
  onNavigate,
}: {
  item: PaletteItem;
  onNavigate: (href: string, external: boolean) => void;
})''', '''function PaletteOption({
  item,
  paletteId,
  showContext = false,
  onNavigate,
}: {
  item: PaletteItem;
  paletteId: string;
  showContext?: boolean;
  onNavigate: (item: PaletteItem) => void;
})''')
    replace('''    <CommandItem
      value={item.label}''', '''    <CommandItem
      id={`${paletteId}-${item.id}`}
      value={item.label}''')
    replace('''      description={item.subtitle || undefined}''', '''      description={
        showContext
          ? [item.sectionLabel, item.subgroupLabel, item.subtitle].filter(Boolean).join(" · ")
          : item.subtitle || undefined
      }''')
    replace("onSelect={() => onNavigate(item.href, item.external)}", "onSelect={() => onNavigate(item)}")
    replace('  const t = useTranslations("sidebar");', '  const t = useTranslations("sidebar");\n  const paletteId = useId();')
    replace('''  const [radarAdminUrl, setRadarAdminUrl] = useState<unknown>(null);''', '''  const [radarAdminUrl, setRadarAdminUrl] = useState<unknown>(null);
  const [preferences, setPreferences] = useState(() =>
    readCommandPalettePreferences(KNOWN_COMMAND_IDS)
  );''')
    replace('''  const handleNavigate = useCallback(
    (href: string, external: boolean) => {
      onClose();
      if (external) {
        window.open(href, "_blank", "noopener,noreferrer");
      } else {
        router.push(href);
      }
    },
    [onClose, router]
  );''', '''  const frequencyOrder =
    preferences.mostUsedFirst && allItems.some((item) => preferences.counts[item.id] > 0);
  // Frequency ordering starts from sidebar order, not the query-ranked array:
  // equal count and match quality must retain their original deterministic order.
  const orderedItems = useMemo(
    () => orderCommandPaletteItems(allItems, query, preferences.counts),
    [allItems, query, preferences.counts]
  );

  const handleNavigate = useCallback(
    (item: PaletteItem) => {
      if (item.external) {
        window.open(item.href, "_blank", "noopener,noreferrer");
      } else {
        router.push(item.href);
      }
      // Enter and mouse share CommandItem.onSelect: only execution counts once.
      const next = recordCommandPaletteExecution(preferences, item.id, KNOWN_COMMAND_IDS);
      if (next !== preferences) {
        setPreferences(next);
        saveCommandPalettePreferences(next);
      }
      onClose();
    },
    [onClose, router, preferences]
  );''')
    replace('''        <Command
          query={query}''', '''        <Command
          key={preferences.mostUsedFirst ? "most-used" : "original"}
          query={query}''')
    replace('''            {grouped.map((group) => (''', '''            {frequencyOrder ? orderedItems.map((item) => (
              <PaletteOption
                key={item.id}
                item={item}
                paletteId={paletteId}
                showContext
                onNavigate={handleNavigate}
              />
            )) : grouped.map((group) => (''')
    replace('''<PaletteOption key={item.id} item={item} onNavigate={handleNavigate} />''', '''<PaletteOption key={item.id} item={item} paletteId={paletteId} onNavigate={handleNavigate} />''')
    replace('''        <div className="flex items-center gap-4 border-t border-border px-5 py-2 text-[11px] text-text-muted">
          <span''', '''        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border px-5 py-2 text-[11px] text-text-muted">
          <div className="flex items-center gap-4">
          <span''')
    replace('''            {t("commandPalette.close")}
          </span>
        </div>''', '''            {t("commandPalette.close")}
          </span>
          </div>
          <Toggle
            size="sm"
            label={safeTranslate("commandPalette.mostUsedFirst", "Most used first")}
            checked={preferences.mostUsedFirst}
            onChange={(mostUsedFirst) => {
              const next = { ...preferences, mostUsedFirst };
              setPreferences(next);
              saveCommandPalettePreferences(next);
            }}
          />
        </div>''')
    return text


def main():
    if git("branch", "--show-current").decode().strip() != "feat/v3.8.54-terra-cmdk":
        raise RuntimeError("Refusing to modify a different branch")
    # Require an untouched current-release production tree, not an old file overlay.
    for name in [PALETTE, *PATCH_PATHS]:
        current = Path(name)
        exists = subprocess.run(["git", "cat-file", "-e", NEW_BASE + ":" + name], capture_output=True).returncode == 0
        if exists:
            if not current.exists() or current.read_bytes() != git("show", NEW_BASE + ":" + name):
                raise RuntimeError("Production file drift: " + name)
        elif current.exists():
            raise RuntimeError("Unexpected existing production file: " + name)
    original = Path(PALETTE).read_text()
    updated = adapt_palette(original)
    patch = git("diff", "--binary", OLD_BASE, OLD_HEAD, "--", *PATCH_PATHS)
    subprocess.run(["git", "apply", "--3way"], input=patch, check=True)
    if git("ls-files", "-u"):
        raise RuntimeError("Unresolved patch conflicts")
    Path(PALETTE).write_text(updated)
    for name in TEST_PATHS:
        Path(name).write_bytes(git("show", OLD_HEAD + ":" + name))
    for marker in ['const ranked = useMemo', 'const SCORE_EXACT_LABEL = 4;', '<KbdGroup>', '<Kbd>Esc</Kbd>']:
        if marker not in updated:
            raise RuntimeError("Upstream palette behavior lost: " + marker)
    print("SELECTIVE_PORT_APPLIED: Terra, opt-in frequency ordering, retired metadata filter; upstream ranking and keyboard UI retained")


if __name__ == "__main__":
    main()
