import { CompassRose } from '../assets/CompassRose.js';

/**
 * OpenDrive's mark: the compass rose, at brand size.
 *
 * The drawing lives in `assets/CompassRose.tsx` so the rail, the sign-in hero, the page headers and
 * any future surface all use one piece of artwork at whatever level of detail they need.
 */
export function Mark({ size = 28 }: { size?: number }) {
  return <CompassRose size={size} variant="mark" title="OpenDrive" />;
}
