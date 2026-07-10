import React, { createContext, useContext, useState, useEffect } from 'react';

const ThemeContext = createContext();

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
};

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
    sand: theme.sand_accent,
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
  INSET_SURFACE: {
    backgroundColor: theme.panelBg,
    border: `1px solid ${theme.panelBorder}`,
    boxShadow: `0 2px 8px rgba(0,0,0,${theme === DARK_THEME ? '0.1' : '0.03'})`,
  },
  ALERT_SURFACE: {
    critical: {
      backgroundColor: theme.errorSoft,
      borderColor: theme.error,
    },
    warning: {
      backgroundColor: theme.warningSoft,
      borderColor: theme.ochre,
    },
  },
});

export const useDesignTokens = () => {
  const { theme } = useTheme();
  return createDesignTokens(theme);
};

const LIGHT_THEME = {
  // Primary surfaces
  cream: '#FAF7F1',
  sand: '#F3EDE4',
  sandBorder: 'rgba(36, 31, 26, 0.07)',
  charcoal: '#241F1A',
  charcoalMuted: '#57534E',
  
  // Brand
  bottleGreen: '#1E362D',
  bottleGreenHover: '#294A3D',
  bottleGreenSoft: 'rgba(30, 54, 45, 0.08)',
  bottleGreenSoftStrong: 'rgba(30, 54, 45, 0.14)',
  
  // Earth accents
  sage: '#7C9473',
  sageSoft: 'rgba(124, 148, 115, 0.14)',
  sand_accent: '#C9A87C',
  sandSoft: 'rgba(201, 168, 124, 0.16)',
  terracotta: '#BE6A4B',
  terracottaSoft: 'rgba(190, 106, 75, 0.10)',
  ochre: '#B8863B',
  ochreSoft: 'rgba(184, 134, 59, 0.10)',
  
  // Chart
  chartGrid: 'rgba(87, 83, 78, 0.08)',
  chartBorder: 'rgba(87, 83, 78, 0.08)',
  
  // Card surfaces
  cardBg: '#FFFFFF',
  cardBorder: 'rgba(120, 113, 104, 0.24)',
  cardShadow: '0 2px 8px -3px rgba(0,0,0,0.05), 0 8px 24px -4px rgba(0,0,0,0.03)',
  panelBg: '#F3EDE4',
  panelBorder: 'rgba(120, 113, 104, 0.18)',
  panelShadow: '0 4px 20px rgba(36, 31, 26, 0.04)',
  
  // Backgrounds
  background: '#FAF7F1',
  surface: '#FFFFFF',
  
  // Status colors
  success: '#3F6B4A',
  successSoft: 'rgba(63, 107, 74, 0.10)',
  warning: '#8A6A2B',
  warningSoft: 'rgba(138, 106, 43, 0.10)',
  error: '#B91C1C',
  errorSoft: 'rgba(185, 28, 28, 0.12)',
  errorRing: '#DC2626',
};

const DARK_THEME = {
  // Primary surfaces
  cream: '#1A1815',
  sand: '#2D2825',
  sandBorder: 'rgba(250, 247, 241, 0.12)',
  charcoal: '#F5F3F0',
  charcoalMuted: '#C9C5BF',
  
  // Brand
  bottleGreen: '#4A7C6B',
  bottleGreenHover: '#5A8C7B',
  bottleGreenSoft: 'rgba(74, 124, 107, 0.15)',
  bottleGreenSoftStrong: 'rgba(74, 124, 107, 0.25)',
  
  // Earth accents
  sage: '#9EBE8F',
  sageSoft: 'rgba(158, 190, 143, 0.15)',
  sand_accent: '#D4B896',
  sandSoft: 'rgba(212, 184, 150, 0.15)',
  terracotta: '#D97E63',
  terracottaSoft: 'rgba(217, 126, 99, 0.15)',
  ochre: '#D4A052',
  ochreSoft: 'rgba(212, 160, 82, 0.15)',
  
  // Chart
  chartGrid: 'rgba(250, 247, 241, 0.10)',
  chartBorder: 'rgba(250, 247, 241, 0.10)',
  
  // Card surfaces
  cardBg: '#242220',
  cardBorder: 'rgba(250, 247, 241, 0.12)',
  cardShadow: '0 8px 32px -8px rgba(0,0,0,0.4), 0 2px 8px -2px rgba(0,0,0,0.3)',
  panelBg: '#2D2825',
  panelBorder: 'rgba(250, 247, 241, 0.10)',
  panelShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
  
  // Backgrounds
  background: '#1A1815',
  surface: '#242220',
  
  // Status colors
  success: '#7CBF75',
  successSoft: 'rgba(124, 191, 117, 0.15)',
  warning: '#D4A052',
  warningSoft: 'rgba(212, 160, 82, 0.15)',
  error: '#EF5350',
  errorSoft: 'rgba(239, 83, 80, 0.15)',
  errorRing: '#FF6B6B',
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
  }, [isDark]);

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
