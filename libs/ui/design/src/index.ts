// Public API of ui-design. tokens.css and tailwind-preset.css are style entry points, imported
// by path from the application's stylesheet, not from here.
export {
  EnvChrome,
  normalizeEnv,
  ENV_CLASSES,
  type EnvLabels,
} from './components/env-chrome/env-chrome';
export { Gated, type GatedLabels } from './components/gated/gated';
export {
  parseSourceLink,
  type SourceLink,
} from './components/gated/source-link';
export {
  normalizeVerification,
  VERIFICATION_STATES,
  VerificationBanner,
  type VerificationLabels,
} from './components/verification-banner/verification-banner';
export { provideDesignSystem } from './provide-design';
export {
  DENSITIES,
  isDensity,
  isThemePreference,
  MATCH_MEDIA,
  THEME_PREFERENCES,
  THEME_STORAGE,
  THEME_STORAGE_KEYS,
  ThemeService,
  type Density,
  type MatchMedia,
  type MediaQueryLike,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeStorage,
} from './theme.service';
