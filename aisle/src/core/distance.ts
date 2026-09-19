/** Size-based estimates, not metric depth. `near` is deliberately not an input:
 * Depth Anything normalizes each frame independently and cannot measure reach.
 * Portrait frames are 3:4; focal length comes from the horizontal field of view.
 * Dimensions are object-size priors and require device/target calibration.
 */
export const REACH_DISTANCE_M = 0.7;
export function distanceFromBox(
  box: readonly number[], heightM: number, hfovDeg: number, widthM?: number,
): number | null {
  const [x, y, w, h] = box;
  if (box.length !== 4 || !box.every(Number.isFinite) || x < 0 || y < 0 ||
      w <= 0 || h <= 0 || x + w > 1.01 || y + h > 1.01 ||
      !Number.isFinite(heightM) || heightM <= 0 || !Number.isFinite(hfovDeg) || hfovDeg <= 0 || hfovDeg >= 180) return null;
  const focalX = 1 / (2 * Math.tan(hfovDeg * Math.PI / 360));
  const byHeight = heightM * focalX * 0.75 / h;
  if (widthM === undefined) return byHeight;
  if (!Number.isFinite(widthM) || widthM <= 0) return null;
  const byWidth = widthM * focalX / w;
  // A fridge's top/bottom frequently leave the view on approach. Its visible
  // width still supplies a conservative size estimate; cropped width makes
  // that estimate longer, not shorter. With a full height, require both cues.
  const heightClipped = y <= 0.02 || y + h >= 0.98;
  return heightClipped ? byWidth : Math.max(byHeight, byWidth);
}
