/**
 * App Icon Component
 * SVG icon that adapts to current theme
 * @module components/common/AppIcon
 */

import { useAppearanceStore } from '@/stores/appearance-store';

interface AppIconProps {
  /** Icon size in pixels */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * OrdoRealm Code App Icon
 * - Letter O (ring) + inner dot (core)
 * - Three horizontal lines (code lines)
 * - Colors adapt to current theme
 */
export function AppIcon({ size = 16, className = '' }: AppIconProps): JSX.Element {
  const effectiveTheme = useAppearanceStore(state => state.effectiveTheme);

  // Theme-adaptive colors
  const primaryColor = effectiveTheme === 'dark' ? '#e6edf3' : '#1a1a2e';
  const secondaryColor = effectiveTheme === 'dark' ? '#a78bfa' : '#6366f1';
  const tertiaryColor = effectiveTheme === 'dark' ? '#60a5fa' : '#3b82f6';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-label="OrdoRealm Code"
    >
      {/* Letter O - ring */}
      <circle
        cx="512"
        cy="460"
        r="180"
        fill="none"
        stroke={primaryColor}
        strokeWidth="40"
      />

      {/* O inner dot - core */}
      <circle
        cx="512"
        cy="460"
        r="60"
        fill={tertiaryColor}
      />

      {/* Bottom three lines - code lines */}
      <rect x="280" y="700" width="464" height="24" rx="12" fill={primaryColor} />
      <rect x="340" y="760" width="344" height="24" rx="12" fill={secondaryColor} />
      <rect x="400" y="820" width="224" height="24" rx="12" fill={tertiaryColor} />
    </svg>
  );
}
