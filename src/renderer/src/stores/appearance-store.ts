/**
 * Appearance management store
 * Handles theme and UI preferences
 * 持久化到 config.json（而非 localStorage）
 * @module stores/appearance-store
 */

import { create } from 'zustand';
import { loadConfig, updateConfig, type AppConfig } from '@/utils/config';

export type Theme = 'light' | 'dark' | 'system';

interface AppearanceState {
  theme: Theme;
  effectiveTheme: 'light' | 'dark';
  setTheme: (theme: Theme) => void;
  initialize: () => Promise<void>;
}

/**
 * Get the effective theme based on system preference
 */
const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/**
 * Apply theme to document
 */
const applyTheme = (effectiveTheme: 'light' | 'dark'): void => {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  if (effectiveTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // 更新 meta theme-color（移动端浏览器地址栏颜色）
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    metaThemeColor.setAttribute('content', effectiveTheme === 'dark' ? '#1f2937' : '#ffffff');
  }
};

export const useAppearanceStore = create<AppearanceState>((set, get) => ({
  theme: 'system',
  effectiveTheme: 'light',

  setTheme: (theme: Theme) => {
    const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;

    applyTheme(effectiveTheme);

    // ★ 持久化到 config.json
    updateConfig({ theme }).catch(err => {
      console.error('[AppearanceStore] Failed to save theme:', err);
    });

    // 兼容：同时写入 localStorage 作为 fallback
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('theme', theme);
    }

    set({ theme, effectiveTheme });
  },

  initialize: async () => {
    // ★ 从 config.json 读取主题配置
    let theme: Theme = 'system';

    try {
      const config = await loadConfig();
      if (config.theme) {
        theme = config.theme;
      }
    } catch (err) {
      console.warn('[AppearanceStore] Failed to load config, trying localStorage fallback:', err);

      // Fallback: 从 localStorage 读取
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('theme');
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          theme = stored;
        }
      }
    }

    const effectiveTheme = theme === 'system' ? getSystemTheme() : theme;

    applyTheme(effectiveTheme);

    set({ theme, effectiveTheme });

    // 监听系统主题变化
    if (typeof window !== 'undefined') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (): void => {
        const { theme } = get();
        if (theme === 'system') {
          const newEffectiveTheme = getSystemTheme();
          applyTheme(newEffectiveTheme);
          set({ effectiveTheme: newEffectiveTheme });
        }
      };

      mediaQuery.addEventListener('change', handleChange);
    }

    console.log('[AppearanceStore] Initialized with theme:', theme);
  },
}));
