import { supportsScale, type ImageFormat } from '../../core/figma/figma-api.js';

/**
 * Cache key for one rendered image URL.
 *
 * Shared by the bulk export and the inline SVG reader on purpose: exporting a frame as SVG and
 * then asking for its SVG source must not spend the Figma budget twice for the same render.
 */
export function imageUrlKey(
  fileKey: string,
  nodeId: string,
  format: ImageFormat,
  scale: number,
  absolute: boolean,
): string {
  return `imgurl:${fileKey}:${nodeId}:${format}:${supportsScale(format) ? scale : 1}:${absolute ? 'abs' : 'crop'}`;
}
