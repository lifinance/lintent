import { type ReactElement, useId } from "react";
import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";

/**
 * Official Solana brand mark — three forward-leaning rounded bars with the
 * green→purple gradient. Uses the canonical 397.7×311.7 path data, padded
 * vertically (43 units top + 43 bottom) into a square 397.7×397.7 viewBox so
 * the icon sits flush with other MUI icons inside their 1em×1em container.
 * `useId` gives each instance a unique gradient id so multiple icons on a
 * page don't collide.
 */
export function SolanaIcon(props: SvgIconProps): ReactElement {
  const gradientId = useId();
  return (
    <SvgIcon viewBox="0 -43 397.7 397.7" {...props}>
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1="360.879"
          y1="351.455"
          x2="141.213"
          y2="-69.294"
          gradientTransform="matrix(1 0 0 -1 0 314)"
        >
          <stop offset="0" stopColor="#00FFA3" />
          <stop offset="1" stopColor="#DC1FFF" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradientId})`}
        d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"
      />
      <path
        fill={`url(#${gradientId})`}
        d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"
      />
      <path
        fill={`url(#${gradientId})`}
        d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.6z"
      />
    </SvgIcon>
  );
}
