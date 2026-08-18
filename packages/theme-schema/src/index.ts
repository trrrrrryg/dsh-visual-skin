import { z } from "zod";

export const DSH_THEME_TOKENS = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-brand-primary",
  "--dsw-alias-brand-text",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-button-primary-hover",
  "--dsw-alias-interactive-bg-active",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-label-caption",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-tooltip-bg"
] as const;

const cssColor = z.string().trim().min(1).max(64).refine((value) =>
  /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|transparent|currentColor)$/.test(value),
  "Only literal CSS colors are allowed"
);

const tokenModeSchema = z.object({ light: cssColor, dark: cssColor }).strict();
// z.record(z.enum(...)) requires every enum key in Zod 4. Themes intentionally
// override only the tokens they need, so partialRecord is the contract here.
const tokenSchema = z.partialRecord(z.enum(DSH_THEME_TOKENS), tokenModeSchema);

const commonBackdrop = {
  opacity: z.number().finite().min(0).max(1).default(1),
  blurPx: z.number().int().min(0).max(40).default(0)
};
const colorStops = z.array(cssColor).min(1).max(4);
const backdropSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("solid"), colors: colorStops.length(1), angle: z.number().finite().min(0).max(360).default(0), ...commonBackdrop }).strict(),
  z.object({ kind: z.literal("linear-gradient"), colors: colorStops.min(2), angle: z.number().finite().min(0).max(360).default(135), ...commonBackdrop }).strict(),
  z.object({ kind: z.literal("radial-gradient"), colors: colorStops.min(2), angle: z.number().finite().min(0).max(360).default(0), ...commonBackdrop }).strict(),
  z.object({
    kind: z.literal("image"),
    assetId: z.string().regex(/^sha256-[0-9a-f]{64}$/),
    fit: z.enum(["cover", "contain", "fill"]),
    position: z.object({ xPercent: z.number().finite().min(0).max(100), yPercent: z.number().finite().min(0).max(100) }).strict(),
    opacity: z.number().finite().min(0).max(1),
    blurPx: z.number().int().min(0).max(40),
    overlay: z.object({ color: cssColor, opacity: z.number().finite().min(0).max(1) }).strict()
  }).strict()
]);

const appearanceCommon = {
  base: z.enum(["light", "dark"]),
  glass: z.object({
    opacity: z.number().finite().min(0.2).max(1),
    blurPx: z.number().int().min(0).max(40),
    radiusPx: z.number().int().min(0).max(32)
  }).strict(),
  tokens: tokenSchema
};

const legacyThemeSpecSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,47}$/),
  name: z.string().trim().min(1).max(80),
  appearance: z.object({
    backdrop: backdropSchema,
    ...appearanceCommon
  }).strict()
}).strict();

export const themeSpecSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^[a-z][a-z0-9-]{2,47}$/),
  name: z.string().trim().min(1).max(80),
  appearance: z.object({
    // Kept as a canonical v1-compatible mirror of main. It is never an
    // independently editable third surface.
    backdrop: backdropSchema,
    regions: z.object({
      linked: z.boolean(),
      /** False keeps a linked canvas seamless and blends split color edges. */
      divider: z.boolean().default(false),
      sidebar: backdropSchema,
      main: backdropSchema
    }).strict(),
    ...appearanceCommon
  }).strict()
}).strict();

export type ThemeSpec = z.infer<typeof themeSpecSchema>;
type LegacyThemeSpec = z.infer<typeof legacyThemeSpecSchema>;

export const DEFAULT_THEME: ThemeSpec = {
  schemaVersion: 2,
  id: "kiln-garden",
  name: "Kiln Garden",
  appearance: {
    base: "dark",
    backdrop: {
      kind: "radial-gradient",
      colors: ["#1b201e", "#31574e", "#a9553d"],
      angle: 135,
      opacity: 1,
      blurPx: 0
    },
    regions: {
      linked: true,
      divider: false,
      sidebar: {
        kind: "radial-gradient",
        colors: ["#1b201e", "#31574e", "#a9553d"],
        angle: 135,
        opacity: 1,
        blurPx: 0
      },
      main: {
        kind: "radial-gradient",
        colors: ["#1b201e", "#31574e", "#a9553d"],
        angle: 135,
        opacity: 1,
        blurPx: 0
      }
    },
    glass: { opacity: 0.78, blurPx: 18, radiusPx: 18 },
    tokens: {
      "--dsw-alias-bg-base": { light: "#eeeae2", dark: "#1b201e" },
      "--dsw-alias-bg-layer-1": { light: "#f8f4ec", dark: "#262d2a" },
      "--dsw-alias-brand-primary": { light: "#a44732", dark: "#e07a5f" },
      "--dsw-alias-label-primary": { light: "#272b29", dark: "#f2ede4" },
      "--dsw-alias-label-secondary": { light: "#626a65", dark: "#b9c2bc" }
    }
  }
};

export function parseThemeSpec(input: unknown): ThemeSpec {
  const v2 = themeSpecSchema.safeParse(input);
  if (v2.success) return normalizeTheme(v2.data);
  const v1 = legacyThemeSpecSchema.safeParse(input);
  if (!v1.success) return themeSpecSchema.parse(input);
  return upgradeLegacy(v1.data);
}

export function mergeThemeSpec(current: ThemeSpec, patch: Partial<ThemeSpec>): ThemeSpec {
  const base = normalizeTheme(current);
  const requested = patch.appearance;
  if (!requested) return parseThemeSpec({ ...base, ...patch, schemaVersion: 2 });
  const regionsPatch = requested.regions;
  const nextLinked = regionsPatch?.linked ?? base.appearance.regions.linked;
  const nextDivider = regionsPatch?.divider ?? base.appearance.regions.divider;
  const main = mergeBackdrop(base.appearance.regions.main, regionsPatch?.main ?? requested.backdrop);
  const sidebar = nextLinked
    ? main
    : mergeBackdrop(base.appearance.regions.sidebar, regionsPatch?.sidebar ?? (base.appearance.regions.linked ? requested.backdrop : undefined));
  const appearance = {
    ...base.appearance,
    ...requested,
    backdrop: main,
    regions: { linked: nextLinked, divider: nextDivider, main, sidebar },
    glass: { ...base.appearance.glass, ...requested.glass },
    tokens: { ...base.appearance.tokens, ...requested.tokens }
  };
  return parseThemeSpec({ ...base, ...patch, schemaVersion: 2, appearance });
}

function upgradeLegacy(legacy: LegacyThemeSpec): ThemeSpec {
  return normalizeTheme({ ...legacy, schemaVersion: 2, appearance: { ...legacy.appearance, regions: { linked: true, divider: false, sidebar: legacy.appearance.backdrop, main: legacy.appearance.backdrop } } });
}

function normalizeTheme(theme: ThemeSpec): ThemeSpec {
  const regions = theme.appearance.regions;
  const main = regions.main;
  const sidebar = regions.linked ? main : regions.sidebar;
  return { ...theme, schemaVersion: 2, appearance: { ...theme.appearance, backdrop: main, regions: { linked: regions.linked, divider: regions.divider, main, sidebar } } };
}

function mergeBackdrop(current: z.infer<typeof backdropSchema>, patch: unknown): z.infer<typeof backdropSchema> {
  if (patch === undefined) return current;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch as z.infer<typeof backdropSchema>;
  const candidate = patch as { kind?: unknown };
  return candidate.kind !== current.kind ? patch as z.infer<typeof backdropSchema> : { ...current, ...candidate } as z.infer<typeof backdropSchema>;
}
