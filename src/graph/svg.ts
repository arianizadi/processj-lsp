/** Small helpers shared by the SVG, sequence-chart and HTML renderers. */
import type { Point } from './layout';

/** Escape text for XML element content and attribute values. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
    // Characters XML 1.0 does not allow at all.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
}

export function num(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** An orthogonal polyline with rounded corners. */
export function roundedPath(points: readonly Point[], radius = 7): string {
  if (points.length === 0) return '';
  const parts = [`M${num(points[0].x)},${num(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inLength = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outLength = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);
    if (r < 0.5 || inLength === 0 || outLength === 0) {
      parts.push(`L${num(corner.x)},${num(corner.y)}`);
      continue;
    }
    const before = { x: corner.x - ((corner.x - previous.x) / inLength) * r, y: corner.y - ((corner.y - previous.y) / inLength) * r };
    const after = { x: corner.x + ((next.x - corner.x) / outLength) * r, y: corner.y + ((next.y - corner.y) / outLength) * r };
    parts.push(`L${num(before.x)},${num(before.y)}`, `Q${num(corner.x)},${num(corner.y)} ${num(after.x)},${num(after.y)}`);
  }
  const last = points[points.length - 1];
  if (points.length > 1) parts.push(`L${num(last.x)},${num(last.y)}`);
  return parts.join(' ');
}

/** Total length of a polyline. */
export function polylineLength(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return length;
}

/** The point at `distance` along a polyline (clamped), with the direction of travel there. */
export function pointAlong(points: readonly Point[], distance: number): { point: Point; dx: number; dy: number } {
  if (points.length === 0) return { point: { x: 0, y: 0 }, dx: 1, dy: 0 };
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length === 0) continue;
    if (remaining <= length || i === points.length - 1) {
      const t = Math.min(1, remaining / length);
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, dx: (b.x - a.x) / length, dy: (b.y - a.y) / length };
    }
    remaining -= length;
  }
  return { point: points[points.length - 1], dx: 1, dy: 0 };
}
