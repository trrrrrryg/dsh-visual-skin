import { DEFAULT_THEME, parseThemeSpec } from "./index.js";

const parsed = parseThemeSpec(DEFAULT_THEME);
if (parsed.schemaVersion !== 2 || !parsed.appearance.regions.linked || JSON.stringify(parsed.appearance.backdrop) !== JSON.stringify(parsed.appearance.regions.main)) throw new Error("v2 region normalization failed");
if (Object.keys(parsed.appearance.tokens).length >= 23) throw new Error("Token overrides unexpectedly require every whitelisted token");
parseThemeSpec({
  ...DEFAULT_THEME,
  id: "image-selfcheck",
  appearance: {
    ...DEFAULT_THEME.appearance,
    backdrop: {
      kind: "image",
      assetId: `sha256-${"a".repeat(64)}`,
      fit: "cover",
      position: { xPercent: 50, yPercent: 50 },
      opacity: 0.9,
      blurPx: 2,
      overlay: { color: "#08111f", opacity: 0.25 }
    }
  }
});
const { regions: _regions, ...legacyAppearance } = DEFAULT_THEME.appearance;
const upgraded = parseThemeSpec({
  schemaVersion: 1, id: "legacy-selfcheck", name: "Legacy selfcheck",
  appearance: { ...legacyAppearance, backdrop: DEFAULT_THEME.appearance.backdrop }
});
if (upgraded.schemaVersion !== 2 || !upgraded.appearance.regions.linked) throw new Error("v1 upgrade failed");
process.stdout.write("Theme schema self-check passed\n");
