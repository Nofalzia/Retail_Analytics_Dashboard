/* oxlint-disable react/only-export-components */

import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

/**
 * Derives the design tokens a component is allowed to read.
 * The result is built once per theme at module scope (see LIGHT_TOKENS /
 * DARK_TOKENS below) so object identity stays stable between renders —
 * unstable tokens used to force every Chart.js canvas to re-instantiate
 * on each parent render.
 * @param {object} theme One of LIGHT_THEME / DARK_THEME.
 * @returns {object} Token groups consumed through useDesignTokens().
 */
const createDesignTokens = (theme) => ({
  PALETTE: {
    cream: theme.cream,
    sand: theme.sand,
    sandBorder: theme.sandBorder,
    charcoal: theme.charcoal,
    charcoalMuted: theme.charcoalMuted,
    bottleGreen: theme.bottleGreen,
    bottleGreenHover: theme.bottleGreenHover,
    bottleGreenSoft: theme.bottleGreenSoft,
    bottleGreenSoftStrong: theme.bottleGreenSoftStrong,
    accent: theme.accent,
    accentSoft: theme.accentSoft,
    controlHover: theme.controlHover,
    rim: theme.rim,
  },
  CARD_SURFACE: {
    backgroundColor: theme.cardBg,
    border: `1px solid ${theme.cardBorder}`,
    boxShadow: theme.cardShadow,
  },
  PANEL_SURFACE: {
    backgroundColor: theme.panelBg,
    border: `1px solid ${theme.panelBorder}`,
    boxShadow: theme.panelShadow,
  },
  EARTH: {
    sage: theme.sage,
    sageSoft: theme.sageSoft,
    tan: theme.sand_accent,
    sandSoft: theme.sandSoft,
    terracotta: theme.terracotta,
    terracottaSoft: theme.terracottaSoft,
    ochre: theme.ochre,
    ochreSoft: theme.ochreSoft,
  },
  CHART_AXIS: {
    grid: theme.chartGrid,
    border: theme.chartBorder,
  },
  /** Ordered categorical palette — every chart series indexes into this list. */
  SERIES: theme.series,
  /**
   * Semantic accents. `*Ink` variants are the darker text-on-tint tones and are
   * the only ones safe for small label text; the base values are fills/series.
   */
  ACCENTS: {
    primary: theme.bottleGreen,
    primaryHover: theme.bottleGreenHover,
    primarySoft: theme.bottleGreenSoft,
    primarySoftStrong: theme.bottleGreenSoftStrong,
    onPrimary: theme.cream,
    accent: theme.accent,
    accentSoft: theme.accentSoft,
    positive: theme.sage,
    positiveSoft: theme.sageSoft,
    positiveInk: theme.success,
    warning: theme.ochre,
    warningSoft: theme.ochreSoft,
    warningInk: theme.warning,
    danger: theme.terracotta,
    dangerSoft: theme.terracottaSoft,
    dangerInk: theme.error,
    violet: theme.sand_accent,
    violetSoft: theme.sandSoft,
    rim: theme.rim,
  },
  /** Shared geometry scale — keeps every card on the same radius rhythm. */
  RADII: { sm: 10, md: 14, lg: 18, xl: 22, pill: 999 },
  INSET_SURFACE: {
    backgroundColor: theme.panelBg,
    border: `1px solid ${theme.panelBorder}`,
    boxShadow: `0 2px 8px rgba(0,0,0,${theme === DARK_THEME ? '0.1' : '0.03'})`,
  },
  ALERT_SURFACE: {
    critical: {
      backgroundColor: theme.terracottaSoft,
      borderColor: theme.terracotta,
    },
    info: {
      backgroundColor: theme.sandSoft,
      borderColor: theme.sand_accent,
    },
    warning: {
      backgroundColor: theme.warningSoft,
      borderColor: theme.ochre,
    },
  },
});

const LIGHT_THEME = {
  // Primary surfaces — cool canvas, floating white cards (mockup 2 / 3)
  cream: '#F4F6F9',
  sand: '#F2F5FA',
  sandBorder: 'rgba(16, 24, 40, 0.07)',
  charcoal: '#0F172A',
  charcoalMuted: '#667085',

  // Brand — one bottle-green family: 900-level for CTA/ink, 700-level for
  // accents. `cream` stays the ink on top of it (12:1), so every button, nav
  // pill and logo mark keeps working without per-component text changes.
  bottleGreen: '#1E362D',
  bottleGreenHover: '#294A3D',
  bottleGreenSoft: 'rgba(30, 54, 45, 0.08)',
  bottleGreenSoftStrong: 'rgba(30, 54, 45, 0.14)',
  accent: '#2E5A49',
  accentSoft: 'rgba(46, 90, 73, 0.10)',

  // Semantic accents — teal / violet / amber / rose, never the brand hue
  sage: '#12A594',
  sageSoft: 'rgba(18, 165, 148, 0.12)',
  sand_accent: '#7C5CFA',
  sandSoft: 'rgba(124, 92, 250, 0.12)',
  terracotta: '#E5484D',
  terracottaSoft: 'rgba(229, 72, 77, 0.10)',
  ochre: '#E0A106',
  ochreSoft: 'rgba(224, 161, 6, 0.12)',

  // Categorical series — bottle-green-led
  series: ['#2E5A49', '#7C5CFA', '#12A594', '#E0A106', '#E5484D'],

  // Chart furniture
  chartGrid: 'rgba(16, 24, 40, 0.06)',
  chartBorder: 'rgba(16, 24, 40, 0.06)',

  // Card surfaces
  cardBg: '#FFFFFF',
  cardBorder: 'rgba(16, 24, 40, 0.06)',
  cardShadow:
    '0 1px 2px rgba(16, 24, 40, 0.04), 0 18px 36px -20px rgba(16, 24, 40, 0.16)',
  panelBg: '#F2F5FA',
  panelBorder: 'rgba(16, 24, 40, 0.07)',
  panelShadow: '0 1px 2px rgba(16, 24, 40, 0.03)',

  // Backgrounds & page chrome
  background: '#F4F6F9',
  surface: '#FFFFFF',
  headerShadow:
    '0 1px 0 rgba(16, 24, 40, 0.04), 0 8px 24px -20px rgba(16, 24, 40, 0.20)',
  sidebarShadow: '1px 0 0 rgba(16, 24, 40, 0.04)',
  dockBg: 'rgba(255, 255, 255, 0.94)',
  controlHover: '#E8EEF7',
  rim: 'rgba(30, 54, 45, 0.22)',

  // Status ink — text-on-tint tones, all >= 4.5:1 on white
  success: '#0B7F70',
  successSoft: 'rgba(18, 165, 148, 0.12)',
  warning: '#8A5B00',
  warningSoft: 'rgba(224, 161, 6, 0.14)',
  error: '#C4383F',
  errorSoft: 'rgba(229, 72, 77, 0.10)',
  errorRing: '#E5484D',
};

const DARK_THEME = {
  // Primary surfaces — near-black canvas, cards a clear step above it (mockup 1 / 4)
  cream: '#0E0F13',
  sand: '#1F2029',
  sandBorder: 'rgba(255, 255, 255, 0.09)',
  charcoal: '#F4F5F8',
  charcoalMuted: '#9AA1B2',

  // Brand — light violet ink on a deeper violet fill (white text would fail contrast)
  bottleGreen: '#8B7BFF',
  bottleGreenHover: '#A08FFF',
  bottleGreenSoft: 'rgba(139, 123, 255, 0.16)',
  bottleGreenSoftStrong: 'rgba(139, 123, 255, 0.26)',
  accent: '#8B7BFF',
  accentSoft: 'rgba(139, 123, 255, 0.16)',

  // Semantic accents
  sage: '#4CC9A6',
  sageSoft: 'rgba(76, 201, 166, 0.15)',
  sand_accent: '#A78BFA',
  sandSoft: 'rgba(167, 139, 250, 0.16)',
  terracotta: '#FF6B6B',
  terracottaSoft: 'rgba(255, 107, 107, 0.14)',
  ochre: '#F2B01E',
  ochreSoft: 'rgba(242, 176, 30, 0.15)',

  // Categorical series — violet-led to match the dark mockups
  series: ['#8B7BFF', '#5C9DFF', '#4CC9A6', '#F2B01E', '#FF6B6B'],

  // Chart furniture
  chartGrid: 'rgba(255, 255, 255, 0.08)',
  chartBorder: 'rgba(255, 255, 255, 0.08)',

  // Card surfaces
  cardBg: '#17181F',
  cardBorder: 'rgba(255, 255, 255, 0.07)',
  cardShadow:
    '0 1px 2px rgba(0, 0, 0, 0.45), 0 24px 48px -28px rgba(0, 0, 0, 0.75)',
  panelBg: '#1F2029',
  panelBorder: 'rgba(255, 255, 255, 0.09)',
  panelShadow: '0 1px 2px rgba(0, 0, 0, 0.35)',

  // Backgrounds & page chrome
  background: '#0E0F13',
  surface: '#14151A',
  headerShadow:
    '0 1px 0 rgba(255, 255, 255, 0.05), 0 16px 32px -24px rgba(0, 0, 0, 0.90)',
  sidebarShadow: '1px 0 0 rgba(255, 255, 255, 0.05)',
  dockBg: 'rgba(20, 21, 26, 0.94)',
  controlHover: '#262833',
  rim: 'rgba(139, 123, 255, 0.38)',

  // Status colors — bright enough to read on #17181F
  success: '#4CC9A6',
  successSoft: 'rgba(76, 201, 166, 0.15)',
  warning: '#F2B01E',
  warningSoft: 'rgba(242, 176, 30, 0.15)',
  error: '#FF6B6B',
  errorSoft: 'rgba(255, 107, 107, 0.14)',
  errorRing: '#FF8787',
};

/**
 * Built once per theme so `useDesignTokens()` returns a stable reference —
 * an unstable token object re-registered every Chart.js instance per render.
 */
const LIGHT_TOKENS = createDesignTokens(LIGHT_THEME);
const DARK_TOKENS = createDesignTokens(DARK_THEME);

/**
 * Reads the active design tokens. The returned object is a module-level
 * constant, so `PALETTE` / `CARD_SURFACE` / … keep the same identity between
 * renders and only change when the theme itself flips.
 * @returns {object} Token groups for the active theme.
 */
export const useDesignTokens = () => {
  const { isDark } = useTheme();
  return isDark ? DARK_TOKENS : LIGHT_TOKENS;
};

export const ThemeProvider = ({ children }) => {
  const [isDark, setIsDark] = useState(() => {
    // Check localStorage or system preference
    const stored = localStorage.getItem('theme-mode');
    if (stored) return stored === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  const theme = isDark ? DARK_THEME : LIGHT_THEME;

  useEffect(() => {
    localStorage.setItem('theme-mode', isDark ? 'dark' : 'light');
    // Update document class for CSS if needed
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    // Publish the one colour index.css needs (the focus ring) from the same
    // token object the components read, so the stylesheet never carries a
    // duplicate hex value that can drift from the palette.
    document.documentElement.style.setProperty('--focus-ring', theme.bottleGreen);
    document.documentElement.style.setProperty('--brand', theme.bottleGreen);
  }, [isDark, theme]);

  const toggleTheme = () => {
    setIsDark((prev) => !prev);
  };

  return (
    <ThemeContext.Provider value={{ isDark, theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export default ThemeContext;
