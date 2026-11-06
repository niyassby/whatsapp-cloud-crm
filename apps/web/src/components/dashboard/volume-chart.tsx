'use client';

import type { VolumePoint } from '@wacrm/shared';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Validated with the dataviz palette script, in both modes. Text never wears these colors. */
const SERIES = [
  { key: 'inbound', label: 'Received', stroke: 'var(--series-1)' },
  { key: 'outbound', label: 'Sent', stroke: 'var(--series-2)' },
] as const;

const HEIGHT = 260;
const PAD = { top: 12, right: 68, bottom: 26, left: 44 };

/** A round top for the axis, so ticks read as 0, 50, 100 rather than 0, 47, 94. */
function niceMax(value: number) {
  if (value <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * step >= value) return m * step;
  }
  return 10 * step;
}

const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

export function VolumeChart({ points }: { points: VolumePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [asTable]);

  const peak = Math.max(0, ...points.flatMap((p) => [p.inbound, p.outbound]));
  const top = niceMax(peak);
  const innerW = Math.max(1, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length > 1 ? (i / (points.length - 1)) * innerW : 0);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  // About one date per 110 pixels, always including the first.
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(innerW / 110))));

  const onMove = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || points.length === 0) return;
    const at = ((clientX - box.left - PAD.left) / innerW) * (points.length - 1);
    setHover(Math.min(points.length - 1, Math.max(0, Math.round(at))));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' ? -1 : 1;
    setHover((h) =>
      Math.min(points.length - 1, Math.max(0, (h ?? (step > 0 ? -1 : points.length)) + step)),
    );
  };

  const point = hover === null ? null : points[hover];
  const last = points.length - 1;
  const lastPoint = points[last];
  // Keep the two end labels apart when the lines finish close together.
  const labelY = (index: 0 | 1) => {
    if (!lastPoint) return 0;
    const a = y(lastPoint.inbound);
    const b = y(lastPoint.outbound);
    if (Math.abs(a - b) >= 14) return index === 0 ? a : b;
    const mid = (a + b) / 2;
    const inboundAbove = a <= b;
    return (index === 0) === inboundAbove ? mid - 7 : mid + 7;
  };

  return (
    <div className="flex flex-col gap-3 [--series-1:#2a78d6] [--series-2:#eb6834] dark:[--series-1:#3987e5] dark:[--series-2:#d95926]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ul className="flex gap-4 text-sm" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-0.5 w-4 rounded-full"
                style={{ background: s.stroke }}
              />
              {s.label}
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'View as chart' : 'View as table'}
        </Button>
      </div>

      {asTable ? (
        <div className="max-h-72 overflow-y-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead className="text-right">Received</TableHead>
                <TableHead className="text-right">Sent</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((p) => (
                <TableRow key={p.day}>
                  <TableCell>{dayLabel(p.day)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.inbound.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.outbound.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div
          ref={ref}
          className="relative outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          role="img"
          aria-label={`Messages per day. ${points.reduce((n, p) => n + p.inbound, 0)} received and ${points.reduce((n, p) => n + p.outbound, 0)} sent. Use the arrow keys to read each day, or view as a table.`}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
          onPointerMove={(e) => onMove(e.clientX)}
          onPointerLeave={() => setHover(null)}
        >
          <svg width={width} height={HEIGHT} className="block touch-none select-none" aria-hidden>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={PAD.left}
                  x2={PAD.left + innerW}
                  y1={y(t)}
                  y2={y(t)}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={PAD.left - 8}
                  y={y(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-xs tabular-nums"
                >
                  {t.toLocaleString()}
                </text>
              </g>
            ))}
            {points.map((p, i) =>
              i % every === 0 ? (
                <text
                  key={p.day}
                  x={x(i)}
                  y={HEIGHT - 6}
                  textAnchor={i === 0 ? 'start' : 'middle'}
                  className="fill-muted-foreground text-xs"
                >
                  {dayLabel(p.day)}
                </text>
              ) : null,
            )}
            {SERIES.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                points={points.map((p, i) => `${x(i)},${y(p[s.key])}`).join(' ')}
              />
            ))}
            {lastPoint &&
              SERIES.map((s, index) => (
                <text
                  key={s.key}
                  x={x(last) + 8}
                  y={labelY(index as 0 | 1)}
                  dy="0.32em"
                  className="fill-foreground text-xs"
                >
                  {s.label}
                </text>
              ))}
            {point && hover !== null && (
              <>
                <line
                  x1={x(hover)}
                  x2={x(hover)}
                  y1={PAD.top}
                  y2={PAD.top + innerH}
                  className="stroke-muted-foreground"
                  strokeWidth={1}
                />
                {SERIES.map((s) => (
                  <circle
                    key={s.key}
                    cx={x(hover)}
                    cy={y(point[s.key])}
                    r={4}
                    fill={s.stroke}
                    strokeWidth={2}
                    className="stroke-card"
                  />
                ))}
              </>
            )}
          </svg>
          {point && hover !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-32 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
              style={
                x(hover) > width / 2 ? { right: width - x(hover) + 12 } : { left: x(hover) + 12 }
              }
            >
              <p className="mb-1 font-medium">{dayLabel(point.day)}</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      aria-hidden
                      className="inline-block size-2 rounded-full"
                      style={{ background: s.stroke }}
                    />
                    {s.label}
                  </span>
                  <span className="tabular-nums">{point[s.key].toLocaleString()}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
